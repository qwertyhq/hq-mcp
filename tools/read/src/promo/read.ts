import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asRecord, capLimit, num, parseSettings, readShmRows, str, warn } from '../kit.js';

const PROMO_PATH = '/admin/promo';

const MAX_LIMIT = 2000;

/**
 * Невидимые символы в идентификаторе промокода.
 *
 * `\s` в JavaScript уже покрывает пробел, табуляцию, переводы строк, NBSP
 * (U+00A0), узкий неразрывный (U+202F) и BOM (U+FEFF). Чего в нём НЕТ — это
 * символы нулевой ширины U+200B..U+200D, которые прилетают копипастом из
 * мессенджера ничуть не реже пробела и точно так же ломают сравнение в базе.
 * Поэтому класс задан явно и шире, чем `\s`.
 */
const INVISIBLE = '[\\s\\u200B\\u200C\\u200D]';
const INVISIBLE_RE = new RegExp(INVISIBLE, 'u');

export type WhitespacePosition = 'leading' | 'trailing' | 'embedded';

interface PromoCode {
  id: string;
  /**
   * Идентификатор в квадратных скобках. Ровно тот приём, которым эти коды
   * ловят руками в базе (`SELECT CONCAT('[',id,']'), LENGTH(id)`): в JSON
   * ведущий пробел глазами не виден ни у человека, ни у модели, а в скобках —
   * виден. Присутствует только у кодов с находкой.
   */
  idQuoted?: string;
  idLength?: number;
  whitespace?: WhitespacePosition[];
  templateId: string | null;
  /** Строка-определение (`used` пуст). Её `settings.quantity` — остаток СЕЙЧАС. */
  hasDefinitionRow: boolean;
  createdAt: string | null;
  expire: string | null;
  amount: number | null;
  reusable: boolean | null;
  status: number | null;
  /**
   * Остаток по версии самой базы — из строки-определения. `null`, когда такой
   * строки в прочитанном нет: у строк применения в `settings.quantity` лежит
   * СНИМОК остатка на момент применения, и подставить его сюда значило бы
   * выдать историческое число за сегодняшний остаток.
   */
  remaining: number | null;
  rows: number;
  redemptions: number;
  lastUsedAt: string | null;
  usedBy: number[];
  /**
   * ПОЧЕМУ ЭТОТ КОД ПОПАЛ В ОТВЕТ ПРО КЛИЕНТА. Присутствует только при запросе
   * с `user_id`.
   *
   * Сопоставление идёт по ДВУМ колонкам — владельца и применившего, — и это
   * правильно (одноразовые коды, выданные админом, остаются за админом после
   * применения). Но без этого поля два очень разных факта выглядят одинаково:
   * у клиента, который сам выдавал одноразовые коды, в ответ попадают десятки
   * строк, где его собственных применений единицы, а остальное принадлежит ему
   * как выдавшему и погашено посторонними. Оператор, спросивший «какие
   * промокоды применял клиент», читал весь список как ответ на свой вопрос.
   */
  matchedBy?: ('owner' | 'redeemer')[];
}

function whitespaceOf(id: string): WhitespacePosition[] {
  const found: WhitespacePosition[] = [];
  if (INVISIBLE_RE.test(id.slice(0, 1))) found.push('leading');
  if (id.length > 1 && INVISIBLE_RE.test(id.slice(-1))) found.push('trailing');
  if (INVISIBLE_RE.test(id.slice(1, -1))) found.push('embedded');
  return found;
}

/**
 * Идентификатор БЕЗ обрезки краёв.
 *
 * Общий помощник `str()` из kit делает `String(value).trim()`, и здесь это
 * стёрло бы ровно ту улику, ради которой инструмент написан: ` FREEWORM`
 * приехал бы как `FREEWORM`, находка никогда бы не сработала, а ответ выглядел
 * бы здоровым. Поэтому идентификатор — и только он — читается сырым; пустая
 * строка по-прежнему считается отсутствующим значением, а строка из одних
 * пробелов — нет, это тоже находка.
 */
function rawId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

/** Сравнение «тот же код, если бы его почистили»: и невидимые символы, и регистр. */
function normalizeId(id: string): string {
  return id.replace(new RegExp(INVISIBLE, 'gu'), '').toUpperCase();
}

function buildCode(
  id: string,
  rows: Record<string, unknown>[],
  forUser: number | null = null,
): PromoCode {
  const definition = rows.find((row) => str(row.used) === null);
  const redemptions = rows.filter((row) => str(row.used) !== null);
  const newest = redemptions
    .map((row) => str(row.used))
    .filter((one): one is string => one !== null)
    .sort()
    .at(-1);
  const settings = parseSettings((definition ?? rows[0] ?? {}).settings);
  const amount = num(settings.amount, Number.NaN);
  const status = num(settings.status, Number.NaN);
  const quantity = definition === undefined ? Number.NaN : num(parseSettings(definition.settings).quantity, Number.NaN);
  const marks = whitespaceOf(id);
  const matchedBy: ('owner' | 'redeemer')[] = [];
  if (forUser !== null) {
    if (rows.some((row) => num(row.user_id, Number.NaN) === forUser)) matchedBy.push('owner');
    if (redemptions.some((row) => num(row.used_by, Number.NaN) === forUser)) {
      matchedBy.push('redeemer');
    }
  }
  return {
    id,
    ...(forUser === null ? {} : { matchedBy }),
    ...(marks.length === 0
      ? {}
      : { idQuoted: `[${id}]`, idLength: id.length, whitespace: marks }),
    templateId: str((definition ?? rows[0] ?? {}).template_id),
    hasDefinitionRow: definition !== undefined,
    createdAt: str((definition ?? rows[0] ?? {}).created),
    expire: str((definition ?? rows[0] ?? {}).expire),
    amount: Number.isFinite(amount) ? amount : null,
    reusable: settings.reusable === undefined ? null : Boolean(num(settings.reusable, 0)),
    status: Number.isFinite(status) ? status : null,
    remaining: Number.isFinite(quantity) ? quantity : null,
    rows: rows.length,
    redemptions: redemptions.length,
    lastUsedAt: newest ?? null,
    usedBy: [
      ...new Set(
        redemptions.map((row) => num(row.used_by, Number.NaN)).filter((one) => Number.isFinite(one)),
      ),
    ],
  };
}

export const promoRead = defineTool({
  name: 'promo_read',
  description:
    'Promo codes from SHM: the codes themselves and every redemption of them, grouped by code. ' +
    'One database row is either the code (its `used` is empty and its `settings.quantity` is ' +
    'the live remaining count) or one redemption of it (stamped with `used`, `used_by`, and a ' +
    'snapshot of the quantity at that moment) — so "the code" and "how many times it was used" ' +
    'come from different rows and must not be read off one. Flags codes whose identifier ' +
    'carries invisible characters, which is a real production failure mode here: the native SHM ' +
    'admin does not trim the code on create, the column collation counts a leading space, and ' +
    'the resulting code can never be applied. ' +
    '/admin/promo also declares POST (edit a code), PUT (generate codes) and DELETE (remove ' +
    'one). None is implemented here, deliberately: generating codes mints bonus money ' +
    '(amount x quantity) with no review, editing changes the value of a code already in ' +
    "circulation, deleting erases the redemption ledger — and the create path is the very " +
    'mechanism that produces the untrimmed identifiers this tool exists to find.',
  input: z.object({
    code: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'Exact promo code id. If the exact match finds nothing, the whole table is scanned for ' +
          'a code that differs only by invisible characters before answering "no such code".',
      ),
    user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe(
        'A client, matched against BOTH the owner column and the redeemer column, which is how ' +
          '"which promo codes did this client use" is actually answered — see `matched`.',
      ),
    limit: z
      .number()
      .int()
      .default(500)
      .describe('Rows to read, paged; capped at 2000. The table is small — 446 rows in production.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ code, user_id, limit }, ctx) => {
    const cap = capLimit(limit, 500, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const wanted = code === null ? null : code.trim();

    // Фильтр по id здесь ТОЧНЫЙ, а не -like: проверено на работающей SHM 2.19.4,
    // а не по спецификации — filter={"id":"IC%"} и id=IC% вернули ноль строк,
    // тогда как filter={"id":"ICE"} вернул одну. Подстановочные знаки в значение
    // не пролезают, и код с пробелом точным фильтром НЕ НАЙДЁТСЯ — ради этого
    // ниже и существует повторное чтение.
    // СЕРВЕРНЫЙ ФИЛЬТР ПО user_id НЕ ИСПОЛЬЗУЕТСЯ, И ЭТО РЕШЕНИЕ, А НЕ ПРОПУСК.
    // Ручка его принимает и честно отрабатывает (в отличие от /admin/user, где
    // ?user_id= на несуществующем клиенте бросает исключение, здесь на
    // ?user_id=99999999 приходит 200 и items: 0), но фильтрует по колонке
    // ВЛАДЕЛЬЦА строки, а владелец строки применения — не всегда применивший:
    // на работающей таблице у подавляющего большинства строк применения
    // user_id == used_by, но у заметного меньшинства (одноразовые коды, которые
    // админ завёл и выдал вручную) user_id = 1 при used_by = клиенту. Для такого
    // клиента ?user_id=<его id> отдаёт items: 0, хотя его применения в таблице
    // лежат. То есть быстрый путь молча теряет часть истории и отвечает
    // «этот клиент промокодов не применял» на клиенте, который применял.
    // Таблица применений маленькая и укладывается в один запрос, поэтому
    // сопоставление идёт по обеим колонкам здесь.
    const params = wanted !== null ? { filter: JSON.stringify({ id: wanted }) } : {};

    let read = await readShmRows(ctx.shm, PROMO_PATH, params, cap);
    // `read` — то, что ПРОЧИТАНО (по нему считается полнота и усечение),
    // `working` — то, что относится к вопросу. После поиска по очищенной форме
    // это разные множества, и мерить полноту по второму значило бы сказать
    // «прочитано 1 из 446» на исчерпывающем чтении.
    let working = read.rows;
    let scannedWholeTable = wanted === null;
    let foundByNormalizing = false;

    // Точный фильтр не нашёл ничего — и это ЕЩЁ НЕ «такого кода нет». Ровно так
    // выглядит код, у которого в идентификаторе живёт пробел: сравнение в базе
    // (utf8mb4_0900_ai_ci, NO PAD) считает ведущий пробел значимым, WHERE id=
    // промахивается, и клиент видит «промокод не найден» на существующей
    // записи. Поэтому промах превращается в полное чтение таблицы и поиск по
    // очищенной форме.
    if (wanted !== null && read.rows.length === 0 && read.error === null) {
      read = await readShmRows(ctx.shm, PROMO_PATH, {}, cap);
      scannedWholeTable = true;
      const target = normalizeId(wanted);
      working = read.rows.filter((row) => normalizeId(rawId(row.id) ?? '') === target);
      foundByNormalizing = working.length > 0;
    }
    if (wanted === null && user_id !== null) {
      working = read.rows.filter(
        (row) => num(row.user_id, Number.NaN) === user_id || num(row.used_by, Number.NaN) === user_id,
      );
    }
    if (read.error !== null) degraded.push({ system: 'shm', error: read.error });

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of working) {
      const id = rawId(row.id);
      if (id === null) continue;
      const bucket = grouped.get(id);
      if (bucket === undefined) grouped.set(id, [row]);
      else bucket.push(row);
    }
    const codes = [...grouped.entries()].map(([id, rows]) => buildCode(id, rows, user_id));
    const flagged = codes.filter((one) => one.whitespace !== undefined);
    const ownerOnly = codes.filter(
      (one) => one.matchedBy?.includes('owner') === true && !one.matchedBy.includes('redeemer'),
    );
    if (user_id !== null && ownerOnly.length > 0) {
      warnings.push(
        warn(
          'promo_owner_rows_included',
          `${String(ownerOnly.length)} of ${String(codes.length)} code(s) here matched this ` +
            'client as the OWNER of the row, not as the person who redeemed it — someone else ' +
            'used them, or nobody did. Both columns are matched on purpose (an admin-issued ' +
            'one-time code stays owned by the admin after a client redeems it, so matching only ' +
            'the redeemer loses real history), but the two answer different questions. For ' +
            '"which codes did this client use", keep the entries whose `matchedBy` contains ' +
            '`redeemer`; the rest are codes this client handed out.',
        ),
      );
    }

    if (flagged.length > 0) {
      warnings.push(
        warn(
          'promo_id_has_whitespace',
          `${String(flagged.length)} promo code id(s) carry invisible characters: ` +
            `${flagged.map((one) => `${one.idQuoted ?? ''} (${(one.whitespace ?? []).join('+')}, ` + `length ${String(one.idLength ?? 0)})`).join('; ')}. ` +
            'Such a code cannot be applied: the native SHM admin does not trim the value on ' +
            'create, the column compares with no padding, so the id the client types never ' +
            'matches the id in the table — and the admin API cannot delete it either, because ' +
            'the delete route resolves the same untrimmed value and answers 404. Correcting it ' +
            'is a direct database UPDATE that trims the column; this server does not perform it. ' +
            'Report the code, do not tell anyone it is missing or already used.',
        ),
      );
    }
    if (wanted !== null && foundByNormalizing) {
      warnings.push(
        warn(
          'promo_code_matched_after_normalizing',
          `"${wanted}" does not exist under that exact id, but a code differing only by ` +
            'invisible characters does. That is the same finding as above from the caller\'s ' +
            'side: the client typing this code gets "promo code not found" while the row is ' +
            'sitting in the table.',
        ),
      );
    }
    if (wanted !== null && codes.length === 0 && degraded.length === 0) {
      warnings.push(
        warn(
          'promo_code_not_found',
          `No row matches "${wanted}", exactly or after stripping invisible characters, in the ` +
            `${String(read.rows.length)} row(s) read` +
            (read.complete ? ' — and that is the whole table' : ', which is NOT the whole table') +
            '. This is an answer about the promo table only: an application can also be refused ' +
            'for reasons that live elsewhere, including the platform licence gate, which fails ' +
            'every promo code at once with a different message.',
        ),
      );
    }
    const exhausted = codes.filter((one) => one.remaining === 0);
    if (wanted !== null && exhausted.length > 0) {
      warnings.push(
        warn(
          'promo_code_exhausted',
          `"${wanted}" exists, but the database's own remaining counter is 0, so it is used up ` +
            'rather than missing. A client trying it gets a refusal that reads the same as a ' +
            'wrong code.',
        ),
      );
    }
    // Усечение объявляется только на УДАВШЕМСЯ чтении: на упавшем «прочитано 0
    // строк из неизвестного числа» — это тот же факт, что partial_result, и
    // второе предупреждение о нём лишь размывает первое.
    if (!read.complete && read.error === null) {
      warnings.push(
        warn(
          'truncated',
          `"promo" read ${String(read.rows.length)} rows of ` +
            `${read.items === null ? 'an unknown total' : String(read.items)} (limit ` +
            `${String(cap)}). Every per-code count below — redemptions, distinct redeemers, the ` +
            'invisible-character sweep — is about this slice, not about the table. Raise the ' +
            'limit before concluding that a code was never used or that no id is malformed.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'The promo table did not read fully (see `degraded`). The findings that need the whole ' +
            'table are the NEGATIVE ones — "there is no such code", "no identifier carries ' +
            'invisible characters" — and they are not made here: `promo_code_not_found` is ' +
            'suppressed and `whitespaceSweepCoversWholeTable` is false. What was found is still ' +
            'reported. An empty list is not evidence that the code does not exist.',
        ),
      );
    }

    return {
      items: read.items,
      limit: cap,
      rowsRead: read.rows.length,
      /** Строк, относящихся к вопросу, из прочитанных. */
      matched: working.length,
      complete: read.complete,
      scannedWholeTable,
      codes: codes.sort((a, b) => b.rows - a.rows),
      /**
       * Найденные коды с невидимыми символами перечисляются ВСЕГДА: находка
       * положительная, и частичное чтение её не отменяет. А вот «ни одного
       * такого кода нет» — утверждение о ВСЕЙ таблице, и оно верно только при
       * полном чтении; ровно это и говорит второе поле.
       */
      whitespaceIds: flagged.map((one) => one.id),
      whitespaceSweepCoversWholeTable: read.complete && degraded.length === 0,
      warnings,
      degraded,
    };
  },
});
