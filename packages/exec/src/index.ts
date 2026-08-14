import { REDACTED, redact } from '@hq/redact';
import { explainRefusal } from '@hq/registry';
import type { Registry } from '@hq/registry';
import type { Capability, ToolContext, ToolDef, ToolWarning } from '@hq/types';

/**
 * Единственный словарь исходов вызова инструмента. Живёт здесь, потому что здесь
 * же живёт единственный исполнитель: у плана 3 (HTTP-транспорт) не должно быть
 * своей копии этих строк — разъехавшийся код исхода тихо ломает метрики и
 * маппинг в HTTP-статус.
 */
export type ToolOutcome = 'ok' | 'not_found' | 'invalid_input' | 'handler_failed';

export type ExecResult =
  /**
   * `warnings` — предупреждения САМОГО исполнителя (сегодня одно:
   * capability_unverified). Они дублируются внутрь `value`, когда значение —
   * объект, потому что оба транспорта пересылают модели именно его; в конверте
   * они лежат всегда, потому что ответ инструмента бывает массивом или числом,
   * и тогда вложить их некуда, а терять нельзя.
   */
  | { ok: true; value: unknown; warnings?: ToolWarning[] }
  | { ok: false; code: Exclude<ToolOutcome, 'ok'>; message: string };

/** Видимость считается ровно в одном месте: mode + profile + backends + probe. */
export function listVisibleTools(opts: { registry: Registry; ctx: ToolContext }): ToolDef[] {
  const probe = opts.ctx.probe.get();
  return opts.registry.list({
    mode: opts.ctx.mode,
    profile: opts.ctx.profile,
    backends: opts.ctx.backends,
    ...(probe === null ? {} : { probe }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Глубина разворачивания `cause`: цепочка длиннее диагностике уже не помогает. */
const MAX_CAUSE_DEPTH = 2;

/**
 * Текст ошибки вместе с корневой причиной. Без `cause` оператор видит
 * «fetch failed» и не видит ECONNREFUSED или просроченный сертификат — а
 * именно они говорят, что чинить. Всё, что отсюда выходит, проходит
 * `stripEmbeddedBodies`: в причине точно так же может лежать тело бэкенда.
 */
function errMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return error.message;
  return `${error.message} (cause: ${errMessage(cause, depth + 1)})`;
}

/**
 * Маркеры, после которых в сообщении идёт ДОСЛОВНОЕ тело ответа бэкенда: оба
 * HTTP-клиента (`packages/shm/src/client.ts`, `packages/remna/src/index.ts`)
 * вклеивают `text.slice(0, 200)` в сообщение об ошибке статуса и о неразборном
 * теле, а `tools/read/src/abuse/report.ts` — `body.slice(0, 300)` из хука,
 * который отдаёт логины, gmail-адреса и IP живых клиентов. У stdio такой текст
 * уезжает прямо в контекст модели (`apps/stdio`, Task 22), то есть §7.2
 * обходится через канал ошибок.
 *
 * ПОЧЕМУ ПО МАРКЕРУ, А НЕ ПО ФОРМЕ ТЕЛА. Часть этих мест срабатывает в
 * `catch` у `JSON.parse` — их тело по построению НЕ JSON (HTML-страница SHM,
 * perl-traceback, строка ошибки MySQL), и разбор по скобкам до них не
 * дотягивался в принципе. Маркер же одинаково режет HTML, traceback, голую
 * JSON-строку и прозу. Обратная сторона — ложные срабатывания исчезают
 * совсем: `(see [1] below)` и `[0-9]+_[a-z]+` в тексте отказа остаются как
 * есть, потому что маркера в них нет.
 *
 * Режется до КОНЦА строки, и это накладывает обязательство на ТОГО, КТО ПИШЕТ
 * СООБЩЕНИЕ: тело обязано стоять последним. Всё, что дописано после него,
 * стрижка уносит вместе с ним — отделить подсказку оператору от тела бэкенда
 * можно только угадыванием, а угадывать здесь нечем, и потерянная подсказка
 * всё равно дешевле выданной записи клиента. Оба места, где тело стояло в
 * середине, исправлены на стороне инструмента и клиента (`abuse/report.ts`,
 * `packages/remna/src/index.ts`), и у каждого на это есть свой тест.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ. Тело, попавшее в текст БЕЗ маркера, проходит насквозь.
 * Известный такой источник был один — сообщение `JSON.parse`, куда V8 кладёт
 * первые ~10 символов тела (`Unexpected token '<', "<!DOCTYPE "... is not
 * valid JSON`); теперь оно не интерполируется никем, потому что оператору не
 * добавляет ничего. Строгую чистку свободного текста для бот-контура (URL, IP,
 * ссылки подписки) делает `redactMessage` плана 3 поверх этого.
 */
const BODY_MARKER = /(HTTP \d{3}: |returned a non-JSON body: )[\s\S]*$/;

function stripEmbeddedBodies(text: string): string {
  return text.replace(BODY_MARKER, `$1${REDACTED}`);
}

/**
 * То же самое, но по всему значению успешного ответа. Тело бэкенда попадает в
 * него тем же путём: `settle`/`take` (`tools/read/src/kit.ts:26-29`, `:49-57`)
 * кладут сообщение клиента в `degraded[].error`, а инструменты возвращают
 * `degraded` наружу (`spool/inspect.ts:214`, `catalog/read.ts:138`,
 * `provisioning/diagnose.ts:242`, `infra/map.ts:345`); `platform_probe` кладёт
 * то же в `shm.error`/`remna.error` (`platform/probe.ts:150`, `:160`).
 * Страховочная редакция их не видит — она маскирует по ИМЕНИ ключа, а `error`
 * не входит ни в один её список. Без этого прохода исполнитель отрезал бы
 * фрагмент у `handler_failed` и отдавал тот же фрагмент тому же профилю через
 * `ok: true`: три из четырёх инструментов видны боту.
 *
 * Идёт по ключам вслепую, а не по `degraded[].error`: правило, знающее имена
 * полей, пришлось бы дописывать на каждый новый способ сообщить об отказе.
 * Циклов здесь уже нет — `redact` заменяет их на '<circular>' до этого прохода.
 */
function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripEmbeddedBodies(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(stripDeep);
  // Object.create(null) по той же причине, что и в @hq/redact: буквальный ключ
  // "__proto__" во входном payload не должен подменять прототип результата.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = stripDeep(item);
  }
  return out;
}

/** Возможности, которые нужны инструменту, но которые probe не подтвердил. */
function unverified(def: ToolDef, ctx: ToolContext): Capability[] {
  const probe = ctx.probe.get();
  return (def.requires ?? []).filter(
    (capability) => probe === null || probe.capabilities[capability] === 'unknown',
  );
}

function withWarning(value: unknown, warning: ToolWarning): unknown {
  if (!isPlainObject(value)) return value;
  const existing = Array.isArray(value.warnings) ? (value.warnings as ToolWarning[]) : [];
  return { ...value, warnings: [...existing, warning] };
}

/**
 * Имя приходит от вызывающего и уезжает обратно в текст отказа. `TOOL_NAME_RE`
 * ограничивает длину 64 символами только при РЕГИСТРАЦИИ, а сюда попадает что
 * угодно — мегабайтная строка отразилась бы наружу целиком.
 */
const MAX_NAME_IN_MESSAGE = 64;

function shown(name: string): string {
  return name.length <= MAX_NAME_IN_MESSAGE ? name : `${name.slice(0, MAX_NAME_IN_MESSAGE)}…`;
}

/**
 * ЕДИНСТВЕННЫЙ путь выполнения инструмента. Оба транспорта зовут только его:
 * копия этого цикла в транспорте немедленно расходится с оригиналом, и разницу
 * между stdio и HTTP не ловит ни один тест.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  opts: { registry: Registry; ctx: ToolContext },
): Promise<ExecResult> {
  try {
    return await run(name, rawInput, opts);
  } catch (error: unknown) {
    // Исполнитель обязан ВЕРНУТЬ исход, а не бросить: транспорт различает
    // только ExecResult, и отклонённый промис прошёл бы мимо его обработки
    // ошибок. Сюда попадает лишь то, что упало ВНЕ хендлера (реестр, probe) —
    // в словаре из четырёх кодов handler_failed единственный, означающий «ответа
    // не получилось»; not_found и invalid_input были бы враньём.
    return {
      ok: false,
      code: 'handler_failed',
      message: stripEmbeddedBodies(`executing "${shown(name)}" failed: ${errMessage(error)}`),
    };
  }
}

async function run(
  name: string,
  rawInput: unknown,
  opts: { registry: Registry; ctx: ToolContext },
): Promise<ExecResult> {
  const visible = listVisibleTools(opts);
  const def = visible.find((candidate) => candidate.name === name);

  if (def === undefined) {
    // ОДНА ветка, ДВА текста — по аудитории, а не по вкусу читающего.
    //
    // bot — это HTTP-транспорт (план 3), доступный по каналу, который мы не
    // контролируем. Registry.list уже прячет от него всё, что вне его среза, и
    // единственный оставшийся способ перебрать реестр — заставить нас отличить
    // «есть, но не для тебя» от «нет такого». Поэтому боту все четыре случая
    // (нет имени / чужой профиль / чужой режим / возможность не подтверждена)
    // отвечают ОДНОЙ строкой: `Tool <name> not found`. Её дословно проверяет
    // Task 7 плана 3 — совпадение не случайное, разделение по профилю и есть
    // принятое решение по этому требованию.
    if (opts.ctx.profile === 'bot') {
      return { ok: false, code: 'not_found', message: `Tool ${shown(name)} not found` };
    }
    // human — доверенный оператор за терминалом (Claude Code через stdio). Ему
    // нужен текст, по которому понятно, что чинить: «инструмент есть, туннель
    // закрыт, вот команда» — ровно то, ради чего задача 18 сняла с abuse_report
    // и sql_query гейт по requires. Схлопнуть это в «not found» значило бы
    // научить модель, что возможности не существует вовсе (§9).
    const known = opts.registry.get(name);
    if (known === undefined) {
      // §8: у операций, которых в реестре нет И НЕ БУДЕТ, есть причина, и
      // модель должна получить именно её. «Нет такого инструмента» учит
      // пробовать дальше — другое имя, тот же смысл; причина закрывает вопрос
      // («шаблоны — живая логика биллинга без git и отката») и подсказывает
      // легитимного соседа. Имя приходит от вызывающего, поэтому объяснение
      // ищется по словам в нём: просьба про template/keygen/bulk узнаётся, а
      // обычная опечатка в имени существующего инструмента — нет, и получает
      // прежний короткий ответ.
      const reason = explainRefusal(name);
      return {
        ok: false,
        code: 'not_found',
        message:
          reason === undefined
            ? `unknown tool "${shown(name)}"`
            : `unknown tool "${shown(name)}", and it is absent on purpose: ${reason}`,
      };
    }
    // Первым — самое постоянное из объяснений. Ненастроенный бэкенд не
    // «сейчас недоступен»: этот сервер поднят против другой системы, и внутри
    // процесса это не изменится ничем. Сказать вместо этого «не доступен для
    // профиля human в режиме ro» значило бы послать оператора менять режим,
    // который тут ни при чём.
    const missing = opts.registry.missingBackends(known, opts.ctx.backends);
    if (missing.length > 0) {
      const names = missing.map((one) => (one === 'shm' ? 'SHM' : 'Remnawave')).join(' and ');
      return {
        ok: false,
        code: 'not_found',
        message:
          `"${shown(name)}" needs ${names}, which this deployment does not have: the server was ` +
          'started without those credentials, so the tool is not published at all. This is a ' +
          'property of the installation, not an outage — nothing to retry and no other tool ' +
          'name to try. platform_probe lists which backends are configured here.',
      };
    }
    const blocked = (known.requires ?? []).filter(
      (capability) => opts.ctx.probe.get()?.capabilities[capability] === false,
    );
    if (blocked.length > 0) {
      return {
        ok: false,
        code: 'not_found',
        message:
          `"${shown(name)}" is unavailable right now: platform_probe found ${blocked.join(', ')} ` +
          'missing on this deployment. Fix the prerequisite (usually the ssh tunnel) and ' +
          're-run platform_probe with refresh=true.',
      };
    }
    return {
      ok: false,
      code: 'not_found',
      message:
        `"${shown(name)}" is not available for profile "${opts.ctx.profile}" in mode ` +
        `"${opts.ctx.mode}"`,
    };
  }

  let parsed: unknown;
  try {
    parsed = def.input.parse(rawInput);
  } catch (error: unknown) {
    // Текст ZodError называет поле и НЕ печатает его значение (проверено на
    // zod 4.4.3), поэтому он уходит как есть: вход инструмента может содержать
    // PII, а имя поля — единственное, что нужно вызывающему для исправления.
    // Стрижка по маркеру сюда не применяется намеренно — тела бэкенда здесь
    // нет по построению, зато есть JSON-массив issues, который она бы не
    // тронула, а прежняя стрижка по форме уничтожила бы целиком.
    return { ok: false, code: 'invalid_input', message: errMessage(error) };
  }

  try {
    return await answer(def, parsed, opts.ctx);
  } catch (error: unknown) {
    return { ok: false, code: 'handler_failed', message: stripEmbeddedBodies(errMessage(error)) };
  }
}

/**
 * Вызов хендлера и сборка успешного ответа. Отдельной функцией — чтобы `try`
 * вокруг него ловил и синхронный бросок из не-async хендлера, и отказ уже
 * внутри редакции, но не превращал в handler_failed отказы, посчитанные выше.
 */
async function answer(def: ToolDef, parsed: unknown, ctx: ToolContext): Promise<ExecResult> {
  const result = await def.handler(parsed, ctx);

  // Страховочная редакция. Гарантия у неё ровно одна: маскирование полей ПО
  // ИМЕНИ КЛЮЧА (креды, секреты, ссылка подписки, для профиля bot — PII).
  // Забытое значение, вклеенное инструментом внутрь строки, она не видит и
  // видеть не может — обещать здесь «наружу ничего не уедет» значило бы
  // научить следующего не проверять. Тело бэкенда внутри строки снимает
  // следующий проход, и только по маркеру.
  const safe: unknown = stripDeep(redact(result, ctx.profile));
  const pending = unverified(def, ctx);
  if (pending.length === 0) return { ok: true, value: safe };
  const warning: ToolWarning = {
    code: 'capability_unverified',
    message:
      `This tool depends on ${pending.join(', ')}, and platform_probe has not confirmed ` +
      'them on this deployment. The answer may be based on a feature that silently does not ' +
      'work here — run platform_probe with refresh=true before trusting it.',
  };
  return { ok: true, value: withWarning(safe, warning), warnings: [warning] };
}

