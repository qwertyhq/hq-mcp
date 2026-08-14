import { z } from 'zod';
import { redactDiff } from '@hq/confirm';
import { scrubSecretShapes } from '@hq/redact';
import { assertSafeTemplateName, templateKind } from '@hq/registry';
import { defaultBackupDir, readBackup, sha256Of, writeBackup } from '../backups.js';
import { defineMutation, planIdField } from '../kit.js';
import type { DiffEntry, MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import type { MutationDeps, MutationTool, PlanDraft } from '../kit.js';

/**
 * ОДИН МАРШРУТ И НА ЧТЕНИЕ, И НА ЗАПИСЬ, И ЭТО ИЗМЕРЕНО, А НЕ ВЫБРАНО.
 *
 * `GET /admin/template/{id}` отдаёт `text/plain` с голым телом файла, и
 * `ShmClient` на таком ответе бросает «returned a non-JSON body» — то есть
 * формой пути с именем внутри штатный клиент воспользоваться не может вовсе
 * (см. `tools/read/src/template/read.ts`). Плюс имя шаблона законно содержит
 * `/` (`.DAV/hwid_blocker`), и подставленное в путь оно даёт другой МАРШРУТ, а
 * не другой шаблон. Поэтому и чтение (`?id=`), и запись (`id` в теле) идут
 * через голый `/admin/template`.
 *
 * Литерал стоит открыто: правило §8 сужено до PUT/DELETE, поэтому скан
 * запрещённых литералов его не считает нарушением, а рантайм-гейт по-прежнему
 * ловит создание и удаление.
 */
const TEMPLATE_PATH = '/admin/template';

/**
 * `format` уезжает в теле ПУСТОЙ строкой, и это не заглушка.
 *
 * Маршрут объявлен с `args => { format => 'plain' }`, а диспетчер собирает
 * `%args = ( %{$p->{args}}, %in, ... )` — параметры запроса идут ВТОРЫМИ и
 * побеждают (app/public_html/shm/v1.cgi). При `format=plain` печать идёт
 * ветвью `print_header(type => "text/plain")`, и хотя ответ `api_set` — хеш, то
 * есть печатается он всё равно `encode_json`, конверта `{data:[…], status}`
 * там нет: наружу уходит голый объект `{id, data, settings}`, у которого
 * `unwrapShm` заберёт поле `data`, приняв его за конверт, и вернёт ТЕЛО
 * ШАБЛОНА как результат записи. Пустая строка не совпадает ни с одной ветвью
 * печати, поэтому ответ уходит штатным конвертом, `dataTruthyGuard` видит
 * `data: []` при неудаче и честно ловит ложный успех (§6.1).
 */
const JSON_ENVELOPE = '';

/** Маркеры чистки по форме (`@hq/redact`) и страховочной редакции (`<redacted>`). */
const REDACTION_MARKER_RE = /<redacted[:>]/;

/** Сколько строк «убрано»/«добавлено» показывать в diff и по сколько символов каждая. */
const DIFF_LINES = 25;
const DIFF_LINE_CHARS = 160;

interface TemplateBody {
  exists: boolean;
  body: string;
  bytes: number;
  sha256: string;
}

interface TemplateBefore {
  id: string;
  exists: boolean;
  bytes: number | null;
  sha256: string | null;
  lines: number | null;
  /** Сколько литеральных секретов чистка по форме нашла в ПРЕДЫДУЩЕМ теле. */
  scrubbed: number;
}

interface TemplateAfter {
  id: string;
  bytes: number;
  lines: number;
  sha256: string;
  source: 'body' | 'restore';
  /**
   * Новое тело — ТОЛЬКО когда его прислал вызывающий. На пути восстановления
   * его здесь нет и быть не может: `after` уезжает в ответ модели как есть, а
   * содержимое снимка — это старое тело шаблона со всеми литеральными кредами,
   * которые `template_read` вырезает при чтении. Применение читает его с диска
   * заново и сверяет по `sha256`.
   */
  body?: string;
  restore_from?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function linesOf(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * Тело шаблона НЕредактированным каналом.
 *
 * `getRaw`, а не `list`, по той же причине, по которой это делает `host_edit`:
 * из прочитанного строится снимок отката, и маска в снимке — это маска,
 * записанная обратно в исполняемый файл. Сегодня `redact` тело шаблона не
 * трогает (оно лежит под именем `data`, а правило смотрит на имя), но «правило
 * СЕЙЧАС не совпадает» — не гарантия, а совпадение.
 */
async function readBody(ctx: ToolContext, id: string): Promise<TemplateBody> {
  const rows = await ctx.shm.getRaw<unknown>(TEMPLATE_PATH, { id, limit: 1 });
  const row = asRecord(Array.isArray(rows) ? rows[0] : rows);
  /**
   * `typeof === 'string'` вместо проверки на непустоту — СОЗНАТЕЛЬНО. В проде
   * есть шаблоны ровно на 0 байт (`public_price_list`, `remna_my`), и «файла
   * нет» против «файл есть и пуст» здесь два разных ответа: первый запрещает
   * запись вовсе (создание закрыто), второй её разрешает.
   */
  const body = typeof row.data === 'string' ? row.data : null;
  if (body === null) return { exists: false, body: '', bytes: 0, sha256: '' };
  return { exists: true, body, bytes: bytesOf(body), sha256: sha256Of(body) };
}

/**
 * Отказы на СОДЕРЖИМОМ, которое инструмент отправлять не станет.
 *
 * Каждый — про свой способ тихо сломать живую логику биллинга, и ни один не
 * заменяется предупреждением: результат всех трёх виден только тогда, когда
 * шаблон в следующий раз исполнится и не сделает ничего.
 */
function assertWritableBody(body: string, id: string, allowEmpty: boolean): void {
  const marker = REDACTION_MARKER_RE.exec(body);
  if (marker !== null) {
    throw new Error(
      `template_edit: тело содержит маркер редакции (${marker[0]}…) и записано не будет. ` +
        'Так выглядит тело, прочитанное через template_read: он вырезает литеральные креды по ' +
        'ФОРМЕ и ставит на их место <redacted:…>. Записать такое тело обратно значит заменить ' +
        `живой креденшл строкой "<redacted:…>" — в проде это 22 файла из 197, среди них ` +
        'hwid_blocker с API-токеном панели. Возьмите настоящее значение из конфигурации ' +
        '(config_read) или из панели и подставьте его сами; чинить это на стороне инструмента ' +
        'нельзя — он не знает, какой именно секрет там был.',
    );
  }
  if (body === '0') {
    throw new Error(
      'template_edit: тело "0" записать нельзя — на диске окажется ПУСТОЙ файл. ' +
        '`Core::Template::set` пишет `$args{data} || $args{PUTDATA} || $args{POSTDATA}`, а строка ' +
        '"0" в Perl ложна: значение проваливается на подстановки, которых после разбора JSON уже ' +
        'нет (`parse_args` удаляет POSTDATA), и в файл уходит undef. Шаблон из одного нуля ' +
        'выглядит бессмысленно, но отказ здесь — не про смысл, а про то, что записалось бы ДРУГОЕ.',
    );
  }
  if (body.trim() === '' && !allowEmpty) {
    throw new Error(
      `template_edit: пустое тело для "${id}" отклонено. Пустой шаблон рендерится в ничто: ` +
        'функции отправки нечего отправлять, задача спула всё равно завершается SUCCESS, и ' +
        'единственный след — строка доставки SKIPPED/EMPTY_RENDER. В проде такие файлы уже есть — ' +
        '`public_price_list` и `remna_my`, оба ровно 0 байт, и всё, что их дёргает, не уведомляет ' +
        'никого. Если пустота нужна намеренно — allow_empty: true, и она попадёт в план строкой ' +
        'побочного эффекта.',
    );
  }
}

/**
 * Мультимножественная разница строк, а не позиционная.
 *
 * Позиционное сравнение (общий префикс, общий суффикс, «всё между ними
 * изменилось») на вставке ОДНОЙ строки в начало объявляет изменённым весь файл
 * — то есть ровно там, где diff нужнее всего, он перестаёт что-либо
 * показывать. Разница по мультимножеству к сдвигам нечувствительна и отвечает
 * на настоящий вопрос: какие строки исчезли и какие появились.
 *
 * Чем платим, вслух: перемещение строки внутри файла в diff не видно вовсе
 * (строка есть с обеих сторон), а `sha256` и `lines` рядом всё равно
 * показывают, что файл изменился.
 */
function lineDelta(before: string, after: string): { removed: string[]; added: string[] } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const left = count(before);
  const right = count(after);
  const pick = (from: Map<string, number>, other: Map<string, number>, text: string): string[] => {
    const seen = new Map(from);
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const have = seen.get(line) ?? 0;
      const rival = other.get(line) ?? 0;
      if (have <= rival) continue;
      seen.set(line, have - 1);
      out.push(line);
    }
    return out;
  };
  return { removed: pick(left, right, before), added: pick(right, left, after) };
}

function sample(lines: string[], prefix: string, side: 'from' | 'to'): DiffEntry[] {
  return lines.slice(0, DIFF_LINES).map((line, index) => {
    // Чистка по ФОРМЕ — та же, что у template_read, и ровно здесь она
    // обязательна: часть шаблонов несёт литеральный кред строкой, и наивный
    // read-modify-write вынес бы его в diff открытым текстом.
    const text = scrubSecretShapes(line.slice(0, DIFF_LINE_CHARS)).text;
    const path = `${prefix}.${String(index + 1)}`;
    return side === 'from' ? { path, from: text, to: null } : { path, from: null, to: text };
  });
}

function buildBodyDiff(before: string, after: string, profile: 'human' | 'bot'): DiffEntry[] {
  const delta = lineDelta(before, after);
  const head: DiffEntry[] = [
    { path: 'bytes', from: bytesOf(before), to: bytesOf(after) },
    { path: 'lines', from: linesOf(before), to: linesOf(after) },
    { path: 'sha256', from: sha256Of(before), to: sha256Of(after) },
  ];
  const body = [
    ...sample(delta.removed, 'removed_line', 'from'),
    ...sample(delta.added, 'added_line', 'to'),
  ];
  const truncated: DiffEntry[] = [];
  if (delta.removed.length > DIFF_LINES || delta.added.length > DIFF_LINES) {
    truncated.push({
      path: 'diff_truncated',
      from: null,
      to:
        `показаны первые ${String(DIFF_LINES)} строк каждой стороны из ` +
        `${String(delta.removed.length)} убранных и ${String(delta.added.length)} добавленных`,
    });
  }
  // `redactDiff` поверх чистки по форме: каркас позовёт её ещё раз, но собранный
  // руками diff обязан уходить из мутатора уже замаскированным — иначе дыра
  // открывается ровно в том виде, в каком её однажды нашли (находка 2.1).
  return redactDiff([...head, ...body, ...truncated], profile);
}

function beforeOf(plan: MutationPlan): TemplateBefore {
  const raw = asRecord(plan.before);
  return {
    id: String(raw.id ?? ''),
    exists: raw.exists === true,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : null,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
    lines: typeof raw.lines === 'number' ? raw.lines : null,
    scrubbed: typeof raw.scrubbed === 'number' ? raw.scrubbed : 0,
  };
}

function afterOf(plan: MutationPlan): TemplateAfter {
  const raw = asRecord(plan.after);
  return {
    id: String(raw.id ?? ''),
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    lines: typeof raw.lines === 'number' ? raw.lines : 0,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
    source: raw.source === 'restore' ? 'restore' : 'body',
    ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
    ...(typeof raw.restore_from === 'string' ? { restore_from: raw.restore_from } : {}),
  };
}

const input = z.object({
  id: z
    .string()
    .describe(
      'Точное имя шаблона, которое уже существует. Создать новый этим инструментом нельзя: ' +
        'PUT /admin/template закрыт §8, и закрыт по делу — у появившегося шаблона нет ' +
        'предыдущего состояния, которое можно снять до записи.',
    ),
  body: z
    .string()
    .optional()
    .describe(
      'Новое тело ЦЕЛИКОМ. Частичной правки не бывает: SHM перезаписывает файл, merge нет. ' +
        'Тело с маркерами <redacted:…> отвергается — так выглядит вывод template_read.',
    ),
  restore_from: z
    .string()
    .optional()
    .describe(
      'Путь к снимку, снятому этим же инструментом перед предыдущей записью (его отдаёт ответ ' +
        'применения). Взаимоисключающ с body и существует затем, чтобы вернуть прежнее тело, ' +
        'НЕ протаскивая его через контекст модели: содержимое снимка читается с диска.',
    ),
  allow_empty: z
    .boolean()
    .default(false)
    .describe(
      'Разрешить запись пустого тела. Без него пустое тело — отказ: пустой шаблон рендерится в ' +
        'ничто, а задача спула всё равно рапортует SUCCESS.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/**
 * `deps` — общие зависимости каркаса; `backupDir` — каталог снимков «до».
 * Второй параметр НЕОБЯЗАТЕЛЕН намеренно: реестр мутаторов вызывает фабрики
 * единообразно (`(deps) => MutationTool`), и инструмент, который нельзя
 * собрать этим вызовом, выпал бы из `MUTATION_FACTORIES` молча.
 */
export function templateEdit(deps: MutationDeps, backupDir = defaultBackupDir()): MutationTool {
  return defineMutation<Input>(
    {
      name: 'template_edit',
      description:
        'Перезаписать тело СУЩЕСТВУЮЩЕГО шаблона SHM. Шаблон — это исполняемая логика биллинга ' +
        '(разбор платежей, скрипты провижининга, тексты уведомлений), она хранится файлами без ' +
        'гита. Поэтому инструмент делает откат сам: перед записью предыдущие байты уходят в ' +
        'локальный снимок, путь к нему возвращается в ответе, и тот же инструмент кладёт их ' +
        'обратно по restore_from. Пустое тело отклоняется без allow_empty (пустой шаблон ' +
        'рендерится в ничто, а задача всё равно рапортует SUCCESS), тело с маркерами ' +
        '<redacted:…> — всегда: это вывод template_read, и запись такого тела заменит живой ' +
        'креденшл строкой-маркером. Создать и удалить шаблон нельзя вовсе. Без plan_id ' +
        'возвращает план (diff по строкам, уже вычищенный от литеральных секретов) и не меняет ' +
        'ничего.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [`GET ${TEMPLATE_PATH}`, `POST ${TEMPLATE_PATH}`],
      target: (i) => ({ system: 'shm', id: i.id }),
      guard: {
        // `sha256` ловит чужую правку того же шаблона, `bytes` — усечение файла
        // до нуля, `exists` — удаление между планом и применением (шаблон могли
        // снести через панель, и POST на несуществующий отвечает 404).
        keys: ['exists', 'sha256', 'bytes'],
        read: async (plan, ctx) => {
          const before = beforeOf(plan);
          const now = await readBody(ctx, before.id);
          return {
            exists: now.exists,
            sha256: now.exists ? now.sha256 : null,
            bytes: now.exists ? now.bytes : null,
          };
        },
      },

      plan: async (i, ctx): Promise<PlanDraft> => {
        const id = i.id.trim();
        if (id === '') {
          throw new Error(
            'template_edit: пустое имя шаблона. SHM прочитал бы его как «имя не задано» и ответил ' +
              'списком, а не отказом.',
          );
        }
        assertSafeTemplateName(id);
        if (templateKind(id) === 'backup') {
          throw new Error(
            `template_edit: "${id}" лежит под префиксом копии (.DAV/ или bak-*/). SHM такие файлы ` +
              'НЕ исполняет — воркер разрешает имя без префикса. Правка здесь выглядит успешной и ' +
              'не меняет поведение ничем; живой шаблон называется без префикса.',
          );
        }

        const sources = (i.body === undefined ? 0 : 1) + (i.restore_from === undefined ? 0 : 1);
        if (sources !== 1) {
          throw new Error(
            'template_edit: нужно ровно одно из body или restore_from. Два источника нового тела ' +
              'в одном вызове — это вопрос «какой из них победил», на который ответ виден только ' +
              'после записи.',
          );
        }

        const current = await readBody(ctx, id);
        if (!current.exists) {
          throw new Error(
            `template_edit: шаблона "${id}" не существует. Этот инструмент только перезаписывает: ` +
              'POST на несуществующее имя SHM отвечает 404 «Object not found», а создание (PUT) ' +
              'закрыто §8 — у нового шаблона нет предыдущих байт, которые можно снять до записи. ' +
              'Проверьте имя через template_read: имена регистрозависимы и законно содержат «/».',
          );
        }

        let body: string;
        let after: TemplateAfter;
        if (i.restore_from !== undefined) {
          const snapshot = await readBackup(backupDir, i.restore_from, {
            kind: 'template',
            target: id,
          });
          if (typeof snapshot.payload !== 'string') {
            throw new Error(
              `template_edit: снимок ${i.restore_from} не содержит текста шаблона ` +
                `(payload: ${typeof snapshot.payload}).`,
            );
          }
          body = snapshot.payload;
          after = {
            id,
            bytes: bytesOf(body),
            lines: linesOf(body),
            sha256: sha256Of(body),
            source: 'restore',
            restore_from: i.restore_from,
          };
        } else {
          body = i.body as string;
          after = {
            id,
            bytes: bytesOf(body),
            lines: linesOf(body),
            sha256: sha256Of(body),
            source: 'body',
            body,
          };
        }

        assertWritableBody(body, id, i.allow_empty);

        if (after.sha256 === current.sha256) {
          throw new Error(
            `template_edit: новое тело "${id}" побайтово совпадает с текущим — записывать нечего. ` +
              'Пустая запись всё равно тронула бы файл и его mtime, а diff показал бы, что ничего ' +
              'не изменилось.',
          );
        }

        const wasScrubbed = scrubSecretShapes(current.body).hits.length;
        const nowScrubbed = scrubSecretShapes(body).hits.length;

        const before: TemplateBefore = {
          id,
          exists: true,
          bytes: current.bytes,
          sha256: current.sha256,
          lines: linesOf(current.body),
          scrubbed: wasScrubbed,
        };

        return {
          before,
          after,
          diff: buildBodyDiff(current.body, body, ctx.profile),
          sideEffects: sideEffects({
            id,
            backupDir,
            after,
            emptyNow: body.trim() === '',
            wasScrubbed,
            nowScrubbed,
          }),
        };
      },

      apply: async (plan, ctx) => {
        const before = beforeOf(plan);
        const after = afterOf(plan);

        let body: string;
        if (after.source === 'restore') {
          // Снимок читается ЗАНОВО, а не берётся из плана: старое тело шаблона
          // не имеет права лежать в `after`, потому что `after` уезжает модели.
          const snapshot = await readBackup(backupDir, after.restore_from ?? '', {
            kind: 'template',
            target: after.id,
          });
          body = typeof snapshot.payload === 'string' ? snapshot.payload : '';
        } else {
          body = after.body ?? '';
        }
        if (sha256Of(body) !== after.sha256) {
          throw new Error(
            `template_edit: тело, которое собираемся записать, не совпадает с планом ` +
              '(sha256 разошлись). Для restore_from это означает, что файл снимка изменили после ' +
              'построения плана. Постройте план заново.',
          );
        }

        // Свежее чтение ДО записи: снимок обязан содержать ровно те байты,
        // которые сейчас будут перезаписаны, а не те, что читались минуту назад
        // при построении плана. Сверка мира каркасом это уже проверила — здесь
        // проверяется ещё раз, потому что цена расхождения тут необратима.
        const current = await readBody(ctx, after.id);
        if (!current.exists) {
          throw new Error(
            `template_edit: шаблон "${after.id}" исчез между планом и применением — записывать ` +
              'поверх нечего, а создание закрыто.',
          );
        }
        if (current.sha256 !== before.sha256) {
          throw new Error(
            `template_edit: тело "${after.id}" изменилось между планом и применением. Запись ` +
              'поверх чужой правки стёрла бы её молча (§7.4).',
          );
        }

        const backup = await writeBackup(backupDir, {
          kind: 'template',
          target: after.id,
          savedAt: ctx.now().toISOString(),
          bytes: current.bytes,
          sha256: current.sha256,
          payload: current.body,
        });

        // Собственного retryOn408 здесь нет: applyPlan уже оборачивает
        // применение. Повтор перечитает и переснимет — лишний файл снимка с тем
        // же содержимым, что дешевле любой попытки сделать шаг «умнее».
        await ctx.shm.action<unknown>('POST', TEMPLATE_PATH, {
          id: after.id,
          data: body,
          format: JSON_ENVELOPE,
        });

        // Сверка ПОСЛЕ записи: 200 от SHM означает «файл записан», а не «записан
        // ровно этот текст». Расхождение — предупреждение, а не ошибка: запись
        // уже случилась, и объявить её неудачной значит спровоцировать повтор.
        let observed: TemplateBody | null = null;
        let verifyError: string | undefined;
        try {
          observed = await readBody(ctx, after.id);
        } catch (error: unknown) {
          verifyError = error instanceof Error ? error.message : String(error);
        }
        const drift =
          observed === null || observed.sha256 === after.sha256
            ? null
            : {
                expected_sha256: after.sha256,
                observed_sha256: observed.sha256,
                observed_bytes: observed.bytes,
                note:
                  'SHM ответил успехом, но перечитанное тело отличается от того, что планировали ' +
                  'записать. Не повторяйте вслепую: сравните с снимком по пути backup — он снят ' +
                  'ДО этой записи.',
              };

        return {
          id: after.id,
          bytes: after.bytes,
          sha256: after.sha256,
          backup,
          previous: { bytes: before.bytes, sha256: before.sha256 },
          restore_hint:
            `Вернуть прежнее тело: template_edit { "id": ${JSON.stringify(after.id)}, ` +
            `"restore_from": ${JSON.stringify(backup)} }`,
          ...(drift === null ? {} : { drift }),
          ...(verifyError === undefined ? {} : { verify_error: verifyError }),
        };
      },
    },
    deps,
  );
}

function sideEffects(opts: {
  id: string;
  backupDir: string;
  after: TemplateAfter;
  emptyNow: boolean;
  wasScrubbed: number;
  nowScrubbed: number;
}): string[] {
  const out: string[] = [
    `Файл перезаписывается ЦЕЛИКОМ: SHM не мержит, «правка одной строки» здесь означает новое ` +
      'тело на месте старого.',
    'Перед записью предыдущие байты уходят снимком в ' +
      `${opts.backupDir} (0700/0600), путь вернётся в ответе, вернуть их — этим же инструментом ` +
      'с restore_from. Записи без снимка не бывает: не удалось снять — не пишем.',
    'На этом развёртывании шаблоны — ФАЙЛЫ, а не строки таблицы: `Core::Template::init` включает ' +
      'file_mode при наличии каталога data/templates, и тогда ни чтение, ни запись таблицу ' +
      '`templates` не трогают вовсе (проверено на работающей SHM: копия `.DAV/hwid_blocker` читается тем же ' +
      'маршрутом как файл на 12286 байт, а строки в БД у неё нет и быть не может). Значит запись ' +
      'ложится в data/templates/<id>.tpl; если API и воркеры разнесены по контейнерам, правку ' +
      'увидит только тот, у кого этот каталог общий.',
    'Настройки шаблона (<id>.tpls) НЕ трогаются: `write_template_to_file` пишет второй файл ' +
      'только когда ему передали settings, а инструмент их не передаёт вовсе.',
    'Синтаксис шаблона НЕ проверяется ни здесь, ни SHM при записи. Ошибка рендера обнаружится ' +
      'при исполнении: `Core::Template::parse` вернёт текст ошибки и пометит задачу спула FAIL, ' +
      'а адресат не получит ничего.',
    'Диспетчер SHM берёт лок на объект на 3 секунды и отвечает 408, если не взял; это ' +
      'единственный статус, на который каркас повторяет запрос.',
  ];
  if (opts.after.source === 'restore') {
    out.unshift(
      `Восстановление из снимка ${String(opts.after.restore_from)}: тело берётся с диска и в ` +
        'контекст модели не попадает — ни в плане, ни в ответе применения его нет намеренно.',
    );
  }
  if (opts.emptyNow) {
    out.push(
      'ТЕЛО ПУСТОЕ (allow_empty). После записи шаблон отрендерится в ничто: отправлять будет ' +
        'нечего, задача спула всё равно завершится SUCCESS, и единственным следом останется ' +
        'строка доставки SKIPPED/EMPTY_RENDER. Всё, что дёргает этот шаблон, перестанет ' +
        'уведомлять кого-либо.',
    );
  }
  if (opts.wasScrubbed > 0) {
    out.push(
      `В предыдущем теле чистка по форме нашла ${String(opts.wasScrubbed)} литеральных секрет(ов), ` +
        `в новом — ${String(opts.nowScrubbed)}. В diff они вырезаны, в ФАЙЛЕ они настоящие. Если ` +
        'новое тело писалось поверх вывода template_read, проверьте, что значения не потерялись: ' +
        'шаблон без своего токена не падает, он просто перестаёт делать то, ради чего написан.',
    );
  }
  return out;
}
