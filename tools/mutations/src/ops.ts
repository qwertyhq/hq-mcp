import { z } from 'zod';
import { unclosedAttempts } from '@hq/audit';
import { scrubSecretShapesDeep } from '@hq/redact';
import { defineTool } from '@hq/registry';
import { applyPlan } from './kit.js';
import type { AuditQuery, AuditRecord } from '@hq/audit';
import type { MutationPlan } from '@hq/confirm';
import type { MutationDeps, MutationTool } from './kit.js';
import type { ToolContext, ToolDef, ToolWarning } from '@hq/types';

/**
 * Два служебных инструмента мутационной поверхности: чтение журнала и применение
 * плана. Оба только `human` и оба `access: 'rw'` — обоснования по одному ниже.
 */

const SYSTEMS = ['shm', 'remna'] as const;

/**
 * Сколько записей вычитывается для поиска НЕЗАКРЫТЫХ попыток.
 *
 * Не `limit` пользователя и не «побольше»: `unclosedAttempts` ищет пару
 * `applying` → терминальная запись В ТОМ ОКНЕ, которое ей дали, и на срезе из
 * пятидесяти строк закрытая пара распадается — терминальная запись остаётся
 * внутри окна, а её `applying` уезжает за край. Тогда инструмент показывает
 * ЛОЖНУЮ незакрытую попытку, то есть худший из возможных ответов: тревога, за
 * которой ничего нет, обесценивает ту, за которой что-то есть. `search` в любом
 * случае читает файл целиком (limit только режет результат), поэтому полное
 * окно не стоит ни одного лишнего чтения.
 */
const FULL_SCAN = Number.MAX_SAFE_INTEGER;

const auditInput = z.object({
  tool: z
    .string()
    .min(1)
    .optional()
    .describe('Фильтр по имени инструмента, например billing_adjust или server_edit'),
  plan_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Идентификатор плана. Единственное, что связывает запись `applied` с её `planned`: снимок ' +
        '«до», адресат и сумма лежат в записи планирования, а результат — в записи применения.',
    ),
  target_system: z
    .enum(SYSTEMS)
    .optional()
    .describe('Система, к которой относится правленый объект: shm или remna'),
  target_id: z
    .union([z.string().min(1), z.number()])
    .optional()
    .describe('Идентификатор объекта: user_id клиента SHM или uuid объекта панели'),
  since: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Вернуть записи не старше этого момента. Принимается ISO-8601 (2026-08-13, ' +
        '2026-08-13T09:00:00Z, со смещением тоже); значение нормализуется в UTC перед сравнением.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Сколько записей вернуть. На поиск незакрытых попыток не влияет — он идёт по всему журналу.'),
});

type AuditInput = z.infer<typeof auditInput>;

const confirmInput = z.object({
  /**
   * Имя поля — `plan_id`, и это не вкусовщина: `SECRET_KEY_RE` в @hq/redact —
   * это /token|secret|key|password|auth/i по ИМЕНИ ключа, а `executeTool`
   * прогоняет через `redact` весь ответ хендлера. Поле, названное
   * `confirm_token`, доехало бы до модели как '<redacted>' — подтвердить план
   * стало бы нечем. То же имя закреплено в `planIdField` (см. kit.ts).
   */
  plan_id: z
    .string()
    .min(1)
    .describe('Идентификатор плана, выданный мутатором в ответе со статусом plan'),
});

type ConfirmInput = z.infer<typeof confirmInput>;

/** Компактный вид незакрытой попытки: адрес записи и куда она собиралась писать. */
interface UnclosedAttempt {
  id: string;
  at: string;
  ageMinutes: number | null;
  tool: string;
  profile: string;
  mode: string;
  plan_id: string | null;
  target: { system: string; id: string | number } | null;
  calls: string[];
}

/**
 * ПОЛЕ `token` ПЕРЕИМЕНОВЫВАЕТСЯ В `plan_id` НА ВЫХОДЕ, И ЭТО НЕ КОСМЕТИКА.
 *
 * `executeTool` прогоняет весь ответ через `redact`, а тот маскирует по ИМЕНИ
 * ключа регуляркой /token|secret|key|password|auth/i. Запись журнала несёт
 * идентификатор плана в поле `token` — то есть каждая строка приезжала бы к
 * модели с '<redacted>' на месте единственного, что связывает `planned` с
 * `applied`. Это ровно тот же дефект, из-за которого поле подтверждения зовут
 * `plan_id`, а не `confirm_token`: предохранитель, работающий по имени, режет
 * не секрет, а идентификатор. Секретом токен не является — это одноразовый
 * идентификатор снимка, привязанный к профилю, инструменту и хешу аргументов, и
 * к моменту чтения журнала он уже сгорел.
 */
function toRecordView(rec: AuditRecord): Record<string, unknown> {
  const { token, ...rest } = rec;
  return { ...rest, plan_id: token ?? null };
}

function warn(code: string, message: string): ToolWarning {
  return { code, message };
}

/**
 * Вторая линия к фильтру реестра. Реестр не показывает `human`-инструмент боту,
 * но резолв по имени в обход `listVisibleTools` однажды появится, а к тому дню
 * причина, по которой журнал не отдаётся боту, будет помнить только этот текст.
 */
function assertHuman(ctx: ToolContext, tool: string, why: string): void {
  if (ctx.profile !== 'human') throw new Error(`${tool}: ${why}`);
}

/**
 * `since` СРАВНИВАЕТСЯ КАК СТРОКА (`rec.at < query.since` в @hq/audit), и это
 * ловушка ровно в размер часового пояса: `at` записан через `toISOString()`,
 * то есть UTC с `Z`, а человек естественно пишет «2026-08-13T12:00:00+03:00».
 * Лексикографически такая строка БОЛЬШЕ своего же UTC-эквивалента, и окно
 * молча уезжает на три часа. Поэтому значение прогоняется через `Date` и
 * возвращается в той же форме, в какой лежит в журнале; неразбираемое
 * значение — ошибка, а не «фильтр, который ничего не отфильтровал».
 */
function normalizeSince(raw: string, tool: string): string {
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${tool}: since=${JSON.stringify(raw)} не разбирается как дата. Журнал сравнивает время ` +
        'строками, поэтому непонятное значение не сузило бы выборку, а тихо сделало бы её ' +
        'бессмысленной. Ожидается ISO-8601: 2026-08-13 или 2026-08-13T09:00:00Z.',
    );
  }
  return new Date(parsed).toISOString();
}

function toUnclosed(rec: AuditRecord, now: Date): UnclosedAttempt {
  const at = Date.parse(rec.at);
  return {
    id: rec.id,
    at: rec.at,
    ageMinutes: Number.isFinite(at) ? Math.round((now.getTime() - at) / 60_000) : null,
    tool: rec.tool,
    profile: rec.profile,
    mode: rec.mode,
    plan_id: rec.token ?? null,
    target: rec.target === undefined ? null : { system: rec.target.system, id: rec.target.id },
    calls: rec.calls ?? [],
  };
}

const UNCLOSED_WARNING =
  'НЕЗАКРЫТАЯ ПОПЫТКА В ЖУРНАЛЕ. Запись `applying` пишется ДО обращения к бэкенду и ' +
  'закрывается парной `applied`/`failed` после него. Запись без пары означает, что процесс ' +
  'умер между этими двумя моментами: снимок плана к тому времени уже удалён (`take` сносит ' +
  'его до применения), а запрос мог уйти и выполниться. Если в `calls` стоит денежная ручка ' +
  '(/admin/user/payment, /admin/user/bonus, /admin/user/service/withdraw) — деньги могли ' +
  'двинуться, и повтор операции спишет их второй раз. Проверять по бэкенду, а не по журналу: ' +
  'журнал про этот вызов больше ничего не знает. Одна законная причина того же вида — ' +
  'операция, которая ИДЁТ ПРЯМО СЕЙЧАС: смотрите `ageMinutes`, у живой попытки он около нуля.';

/**
 * Чтение журнала мутаций (§7.5): кто, каким инструментом, с какими аргументами,
 * что было до и после — включая провалы и отказы. Свежие записи первыми.
 *
 * ТОЛЬКО `human` (К9). `AuditRecord` несёт `input`, `before` и `after` ЧУЖИХ
 * операций: логины, user_id, суммы, состояния услуг. Это ровно строка §7.2
 * «PII массивом → боту запрет списков», поэтому журнал не режется по количеству,
 * а не отдаётся боту вовсе.
 *
 * `access: 'rw'` ПРИ ЧИТАЮЩЕМ ХЕНДЛЕРЕ — НЕ ОПИСКА (К21). Журнал мутаций есть
 * часть мутационной поверхности: сервер, поднятый в `ro`, не показывает её ни
 * одной ручкой. Побочный эффект назван вслух: посмотреть журнал постфактум можно
 * только подняв сервер в `rw` — или прочитав `HQ_MCP_AUDIT_PATH` глазами, это
 * обычный JSONL.
 */
export function opsAudit(deps: MutationDeps): ToolDef {
  return defineTool({
    name: 'ops_audit',
    description:
      'The mutation journal: who ran which tool, with which arguments, what the object looked ' +
      'like before and after, and how it ended — planned, applying, applied, failed or rejected. ' +
      'Newest first, filterable by tool, plan token, target and time. Two numbers matter more ' +
      'than the listing itself. `unclosed` are `applying` records with no terminal pair: a ' +
      'process that died between writing "about to call" and writing the outcome — the plan ' +
      'snapshot is already gone by then and the money may already have moved, so those are ' +
      'reported first and separately from the requested window, computed over the whole journal ' +
      'rather than the page you asked for. `counts.corrupt` is how many lines could not be read ' +
      'at all: the journal file is shared by two transports, records carry kilobyte snapshots, ' +
      'and a crash leaves the last line torn — a listing that silently drops those is worse than ' +
      'one that admits it.',
    input: auditInput,
    access: 'rw',
    risk: 'none',
    profiles: ['human'],
    handler: async (input: AuditInput, ctx: ToolContext) => {
      assertHuman(
        ctx,
        'ops_audit',
        'журнал мутаций доступен только профилю human. Записи несут input/before/after чужих ' +
          'операций — логины, user_id, суммы, состояния услуг, — и §7.2 запрещает отдавать боту ' +
          'PII списками. Ограничение не в количестве строк, а в самом доступе.',
      );

      const since = input.since === undefined ? undefined : normalizeSince(input.since, 'ops_audit');
      const target =
        input.target_system === undefined && input.target_id === undefined
          ? undefined
          : {
              ...(input.target_system === undefined ? {} : { system: input.target_system }),
              ...(input.target_id === undefined ? {} : { id: input.target_id }),
            };

      const query: AuditQuery = {
        ...(input.tool === undefined ? {} : { tool: input.tool }),
        ...(input.plan_id === undefined ? {} : { token: input.plan_id }),
        ...(target === undefined ? {} : { target }),
        ...(since === undefined ? {} : { since }),
        limit: input.limit,
      };

      const page = await deps.audit.search(query);
      // Незакрытые ищутся по ВСЕМУ журналу и БЕЗ фильтров вызова: фильтр по
      // инструменту или времени способен обрезать половину пары и превратить
      // закрытую попытку в ложную тревогу. Цена — один проход по уже
      // прочитанному файлу.
      const full = await deps.audit.search({ limit: FULL_SCAN });
      const unclosed = unclosedAttempts(full.records).map((rec) => toUnclosed(rec, ctx.now()));

      const warnings: ToolWarning[] = [];
      if (unclosed.length > 0) {
        warnings.push(
          warn('unclosed_applying', `${String(unclosed.length)}× ${UNCLOSED_WARNING}`),
        );
      }
      if (page.corrupt > 0 || full.corrupt > 0) {
        warnings.push(
          warn(
            'journal_lines_unreadable',
            `${String(full.corrupt)} строк журнала не разобрать. Это не косметика: файл общий у ` +
              'stdio и http, запись несёт снимки в килобайтах, и авария процесса оставляет ' +
              'последнюю строку оборванной. Потерянная строка может быть как раз той, что ' +
              'объясняет расхождение; сам файл (HQ_MCP_AUDIT_PATH) остаётся на диске для разбора.',
          ),
        );
      }

      /**
       * Второй слой поверх редакции по имени поля. `executeTool` маскирует
       * `password`/`token`/`key` по ИМЕНИ ключа, но снимки в журнале несут и
       * секреты, у которых имя безобидное: токен бота лежит ВНУТРИ
       * значения колонки `host` строки сервера SHM. Проход по форме вырезает
       * такие значения и СЧИТАЕТ их — молчаливая утечка превращается в число.
       */
      const scrubbed = scrubSecretShapesDeep({
        records: page.records.map(toRecordView),
        unclosed,
      });
      if (scrubbed.hits.length > 0) {
        warnings.push(
          warn(
            'secret_shapes_scrubbed',
            `${String(scrubbed.hits.length)} значений в выдаче выглядели как секреты (jwt, ` +
              'присвоенный токен, непрозрачный прогон) и вырезаны по форме: снимки в журнале ' +
              'хранятся НЕредактированными — иначе откатом уехал бы маркер вместо значения. ' +
              'Если нужно точное значение, его читают из файла журнала, а не через модель.',
          ),
        );
      }

      return {
        // Порядок полей — часть ответа: незакрытая попытка не должна быть тем,
        // что читатель обязан заметить сам в конце длинного списка.
        unclosed: scrubbed.value.unclosed,
        counts: {
          returned: page.records.length,
          unclosed: unclosed.length,
          corrupt: full.corrupt,
          scannedRecords: full.records.length,
        },
        warnings,
        // Эхо фильтра — тоже с `plan_id`: под именем `token` значение приехало
        // бы маркером, и человек решил бы, что фильтр не сработал.
        filter: {
          tool: input.tool ?? null,
          plan_id: input.plan_id ?? null,
          target: query.target ?? null,
          since: since ?? null,
          limit: input.limit,
        },
        records: scrubbed.value.records,
      };
    },
  });
}

/**
 * Применение сохранённого плана по одноразовому идентификатору (§7.3).
 *
 * ЭТО ЕДИНСТВЕННЫЙ ВЫЗЫВАЮЩИЙ, КОТОРЫЙ НЕ ЗНАЕТ, ЧЕЙ ПЛАН ПРИМЕНЯЕТ. Мутатор
 * подтверждает СВОЙ план и передаёт в `take` и своё имя, и отпечаток аргументов;
 * здесь на входе один идентификатор, а имя инструмента известно только из самого
 * плана — поэтому `take` получает `null` и `null` (хранилище принимает их
 * явно, забыть параметр нельзя).
 *
 * И ровно отсюда растёт вторая проблема, ради которой понадобился `peek`:
 * собственные проверки этого инструмента — виден ли `plan.tool` профилю, есть ли
 * чем его применять — выполненные ПОСЛЕ захвата, сжигают совершенно исправный
 * план. Отказал бы не план, а конфигурация сервера, а платил бы человек:
 * снимок к тому моменту уже удалён, и строить его надо заново. Поэтому порядок
 * такой: `peek` (не забирая) → все проверки → `take` (забрать) → применение.
 * Между `peek` и `take` план может перехватить соседний вызов — тогда `take`
 * ответит `in_flight`/`not_found`, и одноразовость остаётся там, где ей место.
 *
 * ДВЕ ПРОВЕРКИ ДОСТУПА, А НЕ ОДНА (К8). `take` сверяет профиль-СОЗДАТЕЛЯ плана,
 * а `tools` отвечает на другой вопрос: виден ли этот инструмент текущему профилю
 * вообще. Каталог снимков общий у stdio и http, и без второй проверки владелец
 * `ops_confirm` применял бы через общий каталог планы инструментов, которых он
 * не имеет права даже видеть.
 */
export function opsConfirm(deps: MutationDeps, tools: readonly MutationTool[]): ToolDef {
  /**
   * Индекс по `tool.name`, а не карта, переданная снаружи: ключом карты служит
   * то же имя, которое лежит внутри объекта, и разъехаться они могут только у
   * того, кто их составляет. Здесь составлять нечего.
   */
  const byName = new Map<string, MutationTool>(tools.map((tool) => [tool.name, tool]));

  return defineTool({
    name: 'ops_confirm',
    description:
      'Apply a mutation plan by its plan_id. Every mutator answers with a plan first and changes ' +
      'nothing; this is the second call that carries it out. The plan is one-shot and belongs to ' +
      'the profile that built it. A refusal here does NOT destroy the plan: the plan is read ' +
      'without claiming it, every check runs first, and only a confirmation that will actually be ' +
      'carried out takes it. What does consume it is the attempt itself — if the backend fails, ' +
      'the plan is gone and a new one has to be built, deliberately: blind retries are how one ' +
      'charge becomes three. Same-tool alternative: call the mutator again with the SAME ' +
      'arguments plus plan_id.',
    input: confirmInput,
    access: 'rw',
    risk: 'high',
    /**
     * Только `human`. План строит человек, применяет тот же человек: у бота нет
     * ни одного мутатора, чей план ему было бы чем подтверждать, а открытый ему
     * `ops_confirm` — это дверь в общий каталог снимков, за которой лежат планы
     * денежных инструментов. Проверка видимости ниже осталась на месте и без
     * этой строки: два предохранителя здесь дешевле одного.
     */
    profiles: ['human'],
    handler: async (input: ConfirmInput, ctx: ToolContext) => {
      // Вторая линия к фильтру реестра: в режиме ro rw-инструменты не
      // показываются, но резолв по имени в обход listVisibleTools однажды
      // появится.
      if (ctx.mode !== 'rw') {
        throw new Error('ops_confirm: сервер запущен в режиме ro, мутации запрещены');
      }
      assertHuman(
        ctx,
        'ops_confirm',
        'подтверждать план мутации может только профиль human. Каталог снимков общий у stdio и ' +
          'http, и открытый боту ops_confirm — это доступ к планам инструментов, которых он не ' +
          'видит в своём реестре (К8, §4.2).',
      );

      /** Отказ фиксируется в журнале наравне с успехом (§7.5), затем бросается. */
      const reject = async (
        message: string,
        plan?: { tool: string; before: unknown; after: unknown; token: string },
      ): Promise<never> => {
        const error = new Error(message);
        try {
          await deps.audit.write({
            tool: 'ops_confirm',
            profile: ctx.profile,
            mode: ctx.mode,
            outcome: 'rejected',
            input,
            before: plan?.before ?? null,
            after: plan?.after ?? null,
            token: plan?.token,
            calls: plan === undefined ? [] : (byName.get(plan.tool)?.endpoints ?? []),
            error: message,
          });
        } catch {
          /* причина отказа важнее неудачи журнала: наружу уходит она */
        }
        throw error;
      };

      // ЧТЕНИЕ БЕЗ ЗАХВАТА. Ни одна из проверок ниже не имеет права стоить
      // человеку исправного плана.
      let seen: MutationPlan;
      try {
        seen = await deps.confirm.peek(input.plan_id);
      } catch (error: unknown) {
        return reject(
          `ops_confirm: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const tool = byName.get(seen.tool);
      if (tool === undefined) {
        return reject(
          `ops_confirm: план построен инструментом ${seen.tool}, а применить его нечем — такой ` +
            'инструмент не собран в этом процессе. Так выглядит план из сборки с другим набором ' +
            'инструментов (или из другой версии сервера) в общем каталоге снимков. План НЕ ' +
            'сожжён: если сборка изменилась по ошибке, он останется применимым.',
          { tool: seen.tool, before: seen.before, after: seen.after, token: seen.token },
        );
      }
      if (!tool.def.profiles.includes(ctx.profile)) {
        return reject(
          `ops_confirm: инструмент ${seen.tool} недоступен профилю ${ctx.profile} — применить его ` +
            'план нельзя (§4.2). Каталог снимков общий у stdio и http, и это ровно та дверь, ' +
            'через которую профиль применял бы то, чего не видит в своём реестре.',
          { tool: seen.tool, before: seen.before, after: seen.after, token: seen.token },
        );
      }
      const missing = (tool.def.backends ?? []).filter((backend) => !ctx.backends[backend]);
      if (missing.length > 0) {
        return reject(
          `ops_confirm: инструмент ${seen.tool} работает с ${missing.join(' и ')}, а эта установка ` +
            'поднята без неё — применять план нечем. Так выглядит план, построенный сервером с ' +
            'другим набором бэкендов, в общем каталоге снимков. План НЕ сожжён.',
          { tool: seen.tool, before: seen.before, after: seen.after, token: seen.token },
        );
      }
      if (tool.def.access === 'rw' && ctx.mode !== 'rw') {
        return reject(
          `ops_confirm: инструмент ${seen.tool} объявлен как rw, а сервер поднят в режиме ` +
            `${ctx.mode} — применять нечего.`,
          { tool: seen.tool, before: seen.before, after: seen.after, token: seen.token },
        );
      }

      // ЗАХВАТ. Профиль-создатель, срок жизни и целостность файла проверяет
      // хранилище, и на любом своём отказе оно кладёт план обратно.
      let plan: MutationPlan;
      try {
        plan = await deps.confirm.take(input.plan_id, ctx.profile, null, null);
      } catch (error: unknown) {
        return reject(`ops_confirm: ${error instanceof Error ? error.message : String(error)}`);
      }

      /**
       * `target` здесь не вычислить: аргументов мутатора у этого вызова нет, а
       * план их не хранит. Связь с клиентом не теряется — обе записи несут один
       * `token`, и запись `planned`, сделанная мутатором, свой `target` уже
       * содержит: `ops_audit { target_id } → token → ops_audit { token }`.
       */
      return applyPlan({ plan, runner: tool, ctx, deps, input });
    },
  });
}
