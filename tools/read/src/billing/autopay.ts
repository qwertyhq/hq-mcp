import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asRecord,
  capLimit,
  listOut,
  num,
  parseShmDate,
  settle,
  shmUserExistsParams,
  str,
  take,
  warn,
} from '../kit.js';

const MAX_LIMIT = 500;

/**
 * ГДЕ ЛЕЖИТ СОСТОЯНИЕ АВТОПЛАТЕЖА. Не в `user.settings`: сплошная
 * инвентаризация клиентских настроек не нашла там ни одного поля про автоплатёж
 * (ключи там ip, password_set_by_user, cancel, telegram.*, interface, lang,
 * rules_accepted, trial, forecast.*, email_verified*). Всё состояние —
 * в JSON-КОММЕНТАРИИ к строке платежа, `GET /admin/user/pay`, поле `comment`.
 *
 * Комментарии пишут ТРИ РАЗНЫХ ПРОИЗВОДИТЕЛЯ, и это единственная причина, по
 * которой одно и то же поле встречается в двух написаниях (проверено сплошным
 * проходом по всей таблице pays_history работающей установки):
 *
 *  - вебхук подписки Платеги — `subscriptionid`, `paymentmethod` (без
 *    подчёркиваний), плюс status/nextchargeat/amount/currency/id;
 *  - патч SHM, удерживающий комиссию, — `subscription_id` (с подчёркиванием),
 *    плюс charges_count/fee_rate/kind/reason/charge_*;
 *  - вебхук РАЗОВОГО платежа Платеги — `paymentMethod` (camelCase, и это самое
 *    массовое написание из трёх) и `payload` вида
 *    "<user_id>:platega_ru_card:<сумма>", и НИ ОДНОГО поля подписки.
 *
 * Отсюда два вывода, которые определяют весь этот файл:
 *
 *  1. Ни одна строка не несёт оба написания сразу (проверено сплошным проходом
 *     по таблице: ни одного совпадения).
 *     Инструмент, читающий одно написание, теряет не «половину клиентов»
 *     вообще, а КОНКРЕТНУЮ половину доказательств: только `subscription_id` —
 *     видны одни удержания, только `subscriptionid` — видны подписки, но не
 *     видно, что клиент отключился.
 *  2. `paymentMethod` в camelCase РАЗЛИЧАЮЩИМ ПРИЗНАКОМ НЕ ЯВЛЯЕТСЯ: под ним
 *     лежит основная масса обычных разовых платежей — их на порядки больше,
 *     чем автоплатёжных. Признак автоплатежа — id подписки
 *     (в любом написании) или `kind`, начинающийся с autopay.
 *
 * Поэтому написания сопоставляются НЕ списком литералов, а нормализованным
 * ключом (нижний регистр без `_`/`-`) — тем же приёмом, что и @hq/redact.
 * Список из двух литералов защищает ровно от двух известных написаний и молча
 * пропускает третье (`subscriptionId`), а третье написание — это ровно то, чем
 * первые два уже оказались.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * `pay_system_id` строки платежа у автоплатежа всегда начинается с этого
 * префикса: `platega_sub` (списание), `platega_sub-fee` (удержание),
 * `platega_sub-canceled` (отключение). На работающей установке проверено, что
 * по этому префиксу находятся РОВНО ТЕ ЖЕ строки, что и по комментарию:
 * признаки не расходятся. Это ВТОРОЙ, независимый признак, и нужен
 * он не для красоты: комментарий может не разобраться (см. `unreadable`), и
 * тогда строка обязана всё равно попасть в выборку и быть посчитанной —
 * иначе «автоплатежа нет» вернулось бы вместо «мы не смогли прочитать».
 */
export const AUTOPAY_PAY_SYSTEM_PREFIX = 'platega_sub';

/** Что SHM пишет в `status` комментария подписки. Больше значений там не бывает. */
const STATUS_CONFIRMED = 'CONFIRMED';
const STATUS_CANCELED = 'CANCELED';

/** `kind` строки удержания. Сравнение по префиксу: комиссий может стать больше одной. */
const CANCEL_KIND_PREFIX = 'autopay_cancel';

export type CommentShape = 'object' | 'json_string' | 'plain_string' | 'unreadable' | 'absent';

export interface ParsedComment {
  shape: CommentShape;
  fields: Record<string, unknown>;
}

/**
 * `comment` приезжает то объектом, то JSON-строкой — так же, как `settings`
 * (см. `parseSettings` в kit.ts). Отличие от `parseSettings` принципиальное и
 * ради него функция живёт здесь отдельно: `parseSettings` на неразобранной
 * строке возвращает `{}`, то есть НЕОТЛИЧИМО от «полей не было». Здесь форма
 * возвращается наружу, потому что «комментарий не прочитан» и «в комментарии
 * нет автоплатежа» — разные ответы на вопрос «подключён ли автоплатёж».
 */
export function parsePayComment(value: unknown): ParsedComment {
  if (value === null || value === undefined) return { shape: 'absent', fields: {} };
  if (Array.isArray(value)) return { shape: 'unreadable', fields: {} };
  if (typeof value === 'object') return { shape: 'object', fields: asRecord(value) };
  if (typeof value !== 'string') return { shape: 'unreadable', fields: {} };
  const text = value.trim();
  if (text === '') return { shape: 'absent', fields: {} };
  // Не-JSON комментарий — это обычная человеческая пометка администратора
  // ("возврат", "тест"), а не потерянные данные: такие пометки встречаются в
  // норме. Отдельная форма нужна, чтобы они не попали в счётчик нечитаемых и
  // не подняли ложную тревогу.
  // `[` считается заявкой на JSON наравне с `{`: строка, начатая скобкой, —
  // это структура, которую мы НЕ СМОГЛИ прочитать, а не заметка человека.
  if (!text.startsWith('{') && !text.startsWith('[')) return { shape: 'plain_string', fields: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { shape: 'unreadable', fields: {} };
    }
    return { shape: 'json_string', fields: parsed as Record<string, unknown> };
  } catch {
    return { shape: 'unreadable', fields: {} };
  }
}

/** Значение поля по нормализованному имени плюс ИМЯ, под которым оно нашлось. */
export function pickField(
  fields: Record<string, unknown>,
  normalized: string,
): { value: unknown; field: string } | null {
  for (const [key, value] of Object.entries(fields)) {
    if (normalizeKey(key) !== normalized) continue;
    if (value === null || value === undefined || value === '') continue;
    return { value, field: key };
  }
  return null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface AutopayFacts {
  subscription_id: string | null;
  /** Написание, под которым id подписки лежал в этой строке. */
  subscription_id_field: string | null;
  payment_method: string | number | null;
  payment_method_field: string | null;
  status: string | null;
  next_charge_at: string | null;
  kind: string | null;
  reason: string | null;
  fee_rate: number | null;
  charges_count: number | null;
  charge_amount: number | null;
  charge_date: string | null;
  charge_source: string | null;
  amount: number | null;
  currency: string | null;
}

/**
 * Комментарий → факты об автоплатеже, с нормализацией обоих написаний.
 * Экспортируется отдельно от инструмента, чтобы тест мог предъявить ей строку
 * в каждом написании поодиночке: проверка «оба написания читаются» на выходе
 * целого инструмента доказывает меньше — она зелена и тогда, когда второе
 * написание случайно совпало с первым в фикстуре.
 */
export function autopayFacts(fields: Record<string, unknown>): AutopayFacts {
  const sub = pickField(fields, 'subscriptionid');
  const method = pickField(fields, 'paymentmethod');
  const methodValue = method === null ? null : method.value;
  return {
    subscription_id: sub === null ? null : String(sub.value),
    subscription_id_field: sub === null ? null : sub.field,
    payment_method:
      typeof methodValue === 'number' || typeof methodValue === 'string' ? methodValue : null,
    payment_method_field: method === null ? null : method.field,
    status: str(pickField(fields, 'status')?.value),
    next_charge_at: str(pickField(fields, 'nextchargeat')?.value),
    kind: str(pickField(fields, 'kind')?.value),
    reason: str(pickField(fields, 'reason')?.value),
    fee_rate: numOrNull(pickField(fields, 'feerate')?.value),
    charges_count: numOrNull(pickField(fields, 'chargescount')?.value),
    charge_amount: numOrNull(pickField(fields, 'chargeamount')?.value),
    charge_date: str(pickField(fields, 'chargedate')?.value),
    charge_source: str(pickField(fields, 'chargesource')?.value),
    amount: numOrNull(pickField(fields, 'amount')?.value),
    currency: str(pickField(fields, 'currency')?.value),
  };
}

interface AutopayRow extends AutopayFacts {
  pay_id: number;
  date: string | null;
  money: number;
  pay_system_id: string | null;
  comment_shape: CommentShape;
  /** Момент строки для сортировки; null — дату разобрать не удалось. */
  at: number | null;
}

function isCancelFee(row: AutopayRow): boolean {
  return (row.kind ?? '').startsWith(CANCEL_KIND_PREFIX);
}

/** Строка вообще относится к автоплатежу — по комментарию ИЛИ по платёжной системе. */
function looksAutopay(facts: AutopayFacts, paySystem: string | null): boolean {
  if (facts.subscription_id !== null) return true;
  if ((facts.kind ?? '').startsWith('autopay')) return true;
  if (facts.charges_count !== null) return true;
  return (paySystem ?? '').startsWith(AUTOPAY_PAY_SYSTEM_PREFIX);
}

export type AutopaySignal =
  | 'confirmed_subscription'
  | 'cancelled_subscription'
  | 'cancel_fee_charged'
  | 'unknown_status'
  | 'no_autopay_rows';

/**
 * Из чего собран вердикт. Отдаётся наружу целиком, а не сворачивается в
 * булев `connected`: «подключён» без строки, на которой это основано, —
 * утверждение, которое нечем проверить, а строк-кандидатов у клиента бывает
 * несколько и они противоречат друг другу (см. ниже про строку удержания).
 */
export interface AutopayVerdict {
  signal: AutopaySignal;
  pay_id: number | null;
  date: string | null;
  subscription_id: string | null;
  status: string | null;
}

/**
 * Самая свежая строка-ДОКАЗАТЕЛЬСТВО. Порядок — по дате платежа, а не по
 * порядку выдачи: SHM отдаёт список по ключу таблицы вниз, но id и время
 * расходятся, как только строку заводят задним числом. Тай-брейк по id —
 * для строк одной секунды (такое встречается на практике: два
 * `platega_sub-canceled` с одной и той же секундой в дате).
 */
function newestFirst(rows: AutopayRow[]): AutopayRow[] {
  return [...rows].sort((a, b) => {
    const left = a.at ?? Number.NEGATIVE_INFINITY;
    const right = b.at ?? Number.NEGATIVE_INFINITY;
    return right === left ? b.pay_id - a.pay_id : right - left;
  });
}

/**
 * СТРОКА УДЕРЖАНИЯ — ТОЖЕ ДОКАЗАТЕЛЬСТВО ОТКЛЮЧЕНИЯ, И БЕЗ НЕЁ ВЕРДИКТ ВРЁТ.
 *
 * Контрпример, снятый с работающей установки (id замаскированы):
 *   21:33:05  platega_sub          CONFIRMED  подписка A
 *   21:37:02  platega_sub          CONFIRMED  подписка B
 *   21:38:52  platega_sub-fee      money=-27  kind=autopay_cancel_fee, подписка B,
 *                                             reason=client_cancel, fee_rate=0.09
 * Строки со `status: CANCELED` у этого клиента НЕТ ВООБЩЕ: отключение
 * зафиксировано только удержанием. Вердикт, построенный на «статусе самой
 * свежей строки подписки», ответил бы CONFIRMED, то есть «автоплатёж
 * подключён» через минуту после того, как клиент его отключил и заплатил за
 * это 9%.
 *
 * Поэтому доказательством считается ЛЮБАЯ строка, несущая исход: и статус
 * подписки, и удержание. Побеждает самая свежая из них.
 */
function verdictFrom(rows: AutopayRow[]): AutopayVerdict {
  const evidence = newestFirst(rows).filter(
    (row) => row.status !== null || isCancelFee(row),
  );
  const top = evidence[0];
  if (top === undefined) {
    return { signal: 'no_autopay_rows', pay_id: null, date: null, subscription_id: null, status: null };
  }
  const signal: AutopaySignal = isCancelFee(top)
    ? 'cancel_fee_charged'
    : top.status === STATUS_CONFIRMED
      ? 'confirmed_subscription'
      : top.status === STATUS_CANCELED
        ? 'cancelled_subscription'
        : 'unknown_status';
  return {
    signal,
    pay_id: top.pay_id,
    date: top.date,
    subscription_id: top.subscription_id,
    status: top.status,
  };
}

function connectedFrom(signal: AutopaySignal): boolean | null {
  if (signal === 'confirmed_subscription') return true;
  if (signal === 'cancelled_subscription' || signal === 'cancel_fee_charged') return false;
  // no_autopay_rows: строки прочитаны, автоплатежа среди них нет — это
  // «не подключён», а не «неизвестно». unknown_status — наоборот.
  return signal === 'no_autopay_rows' ? false : null;
}

interface Subscription {
  id: string;
  /** Все написания, под которыми id подписки встретился у этого клиента. */
  id_fields: string[];
  state: 'connected' | 'cancelled' | 'unknown';
  status: string | null;
  next_charge_at: string | null;
  payment_method: string | number | null;
  charges_seen: number;
  charges_recorded: number | null;
  first_seen: string | null;
  last_seen: string | null;
  cancelled_by_fee: boolean;
  rows: number;
}

function summarize(id: string, rows: AutopayRow[]): Subscription {
  const ordered = newestFirst(rows);
  const evidence = ordered.filter((row) => row.status !== null || isCancelFee(row));
  const top = evidence[0];
  const state: Subscription['state'] =
    top === undefined
      ? 'unknown'
      : isCancelFee(top) || top.status === STATUS_CANCELED
        ? 'cancelled'
        : top.status === STATUS_CONFIRMED
          ? 'connected'
          : 'unknown';
  const confirmed = ordered.find((row) => row.status === STATUS_CONFIRMED);
  const oldest = ordered[ordered.length - 1];
  return {
    id,
    id_fields: [...new Set(ordered.map((row) => row.subscription_id_field).filter((x) => x !== null))],
    state,
    status: top?.status ?? null,
    // Дата следующего списания живёт только на строке CONFIRMED и исчезает из
    // комментария, как только подписку отменили: строк с id подписки всегда
    // больше, чем строк с `nextchargeat`. Для отменённой подписки её нет —
    // и подставлять сюда старое значение нельзя: это дата, которая уже не
    // наступит.
    next_charge_at: state === 'connected' ? (confirmed?.next_charge_at ?? null) : null,
    payment_method: ordered.find((row) => row.payment_method !== null)?.payment_method ?? null,
    // Списание — это строка, по которой прошли ДЕНЬГИ. Отмена приезжает
    // строкой money=0, удержание — отрицательной; сложив их вместе, получили
    // бы «три списания» там, где было одно.
    charges_seen: ordered.filter((row) => !isCancelFee(row) && row.money > 0).length,
    charges_recorded: ordered.find((row) => row.charges_count !== null)?.charges_count ?? null,
    first_seen: oldest?.date ?? null,
    last_seen: ordered[0]?.date ?? null,
    cancelled_by_fee: ordered.some(isCancelFee),
    rows: ordered.length,
  };
}

export const autopayInspect = defineTool({
  name: 'autopay_inspect',
  description:
    'Recurring-payment (autopay) state of one client, and every fee withheld from him. ' +
    'The state is NOT in user.settings — a sweep over every client setting found no autopay ' +
    'field there at all. It lives entirely in the JSON `comment` of payment rows (GET ' +
    '/admin/user/pay), written by three different producers that spell the same field two ' +
    'different ways: the Platega subscription webhook writes `subscriptionid`/`paymentmethod`, ' +
    "SHM's own withholding patch writes `subscription_id`, and the ordinary one-off payment " +
    'webhook writes `paymentMethod` in camelCase on a great many rows that are not autopay at ' +
    'all. Both spellings are read here (matched on the normalised key, so a third spelling is ' +
    'covered too) and the literal field name each value came from is reported. `connected` is ' +
    'DERIVED, never asserted: `verdict` names the row and the signal it rests on. A withholding ' +
    'row counts as evidence of disconnection in its own right — this happens in practice: a ' +
    'client cancelled autopay and paid the 9% fee while his newest subscription row still read ' +
    'CONFIRMED, so a verdict ' +
    'taken from subscription status alone would have called him connected. No autopay rows at ' +
    'all is `connected: false` with `checked: true`; a failed read is `connected: null` with ' +
    '`checked: false`. Comments that cannot be parsed are counted and reported, never dropped.',
  input: z.object({
    shm_user_id: z.number().int().positive(),
    limit: z
      .number()
      .int()
      .default(100)
      .describe('Payment rows to scan, newest first, capped at 500'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, limit }, ctx) => {
    const cap = capLimit(limit, 100, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const [user, pays] = await Promise.all([
      // Через filter, а не через ?user_id=: см. shmUserExistsParams. Вторая
      // форма на несуществующем клиенте БРОСАЕТ, и «клиента нет» превратилось бы
      // в «SHM не ответил».
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user', shmUserExistsParams(shm_user_id)),
      ),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/pay', {
          user_id: shm_user_id,
          limit: cap,
        }),
      ),
    ]);

    const payList = listOut(take(pays, 'shm', degraded, EMPTY_LIST), warnings, 'payments');
    const userRow = asRecord(take(user, 'shm', degraded, EMPTY_LIST).data[0]);

    let unreadable = 0;
    const rows: AutopayRow[] = [];
    for (const raw of payList.data) {
      const comment = parsePayComment(raw.comment);
      if (comment.shape === 'unreadable') unreadable += 1;
      const facts = autopayFacts(comment.fields);
      const paySystem = str(raw.pay_system_id);
      if (!looksAutopay(facts, paySystem)) continue;
      const date = str(raw.date);
      rows.push({
        ...facts,
        pay_id: num(raw.id, 0),
        date,
        money: num(raw.money, 0),
        pay_system_id: paySystem,
        comment_shape: comment.shape,
        at: parseShmDate(date, ctx.shmTz)?.getTime() ?? null,
      });
    }

    const grouped = new Map<string, AutopayRow[]>();
    // Строки автоплатежа без id подписки существуют (комментарий не разобрался,
    // а платёжная система выдала строку с головой) — они обязаны остаться в
    // общем вердикте, но собственной подпиской не притворяются.
    for (const row of rows) {
      if (row.subscription_id === null) continue;
      grouped.set(row.subscription_id, [...(grouped.get(row.subscription_id) ?? []), row]);
    }
    const subscriptions = [...grouped.entries()]
      .map(([id, group]) => summarize(id, group))
      .sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''));

    const verdict = verdictFrom(rows);
    const connected = pays.ok ? connectedFrom(verdict.signal) : null;
    const current =
      verdict.subscription_id === null
        ? null
        : (subscriptions.find((one) => one.id === verdict.subscription_id) ?? null);

    const withholdings = newestFirst(rows.filter(isCancelFee)).map((row) => ({
      pay_id: row.pay_id,
      date: row.date,
      /** Отрицательное число: удержание приезжает строкой платежа со знаком минус. */
      money: row.money,
      fee_rate: row.fee_rate,
      kind: row.kind,
      reason: row.reason,
      subscription_id: row.subscription_id,
      subscription_id_field: row.subscription_id_field,
      charge_amount: row.charge_amount,
      charge_date: row.charge_date,
      charge_source: row.charge_source,
      charges_count: row.charges_count,
    }));

    const spellings = [
      ...new Set(
        rows.flatMap((row) =>
          [row.subscription_id_field, row.payment_method_field].filter((x) => x !== null),
        ),
      ),
    ].sort();

    const live = subscriptions.filter((one) => one.state === 'connected');
    if (pays.ok && live.length > 1) {
      warnings.push(
        warn(
          'autopay_multiple_live_subscriptions',
          `${String(live.length)} distinct subscription ids for this client have a CONFIRMED row ` +
            'and no cancellation of their own. Only the newest one backs the `connected` verdict, ' +
            'but the older ones were never observed being cancelled here — if the payment system ' +
            'still honours them, the client is charged once per live subscription on their ' +
            'respective nextChargeAt dates. Nothing in pays_history proves either way; check the ' +
            'payment-system side before telling the client he is charged once.',
        ),
      );
    }
    if (pays.ok && verdict.signal === 'unknown_status') {
      warnings.push(
        warn(
          'autopay_status_unknown',
          `The newest autopay row carries status "${String(verdict.status)}", which is neither ` +
            `${STATUS_CONFIRMED} nor ${STATUS_CANCELED}. \`connected\` is null rather than ` +
            'guessed: a status this tool does not know is a new state of the payment system, and ' +
            'reading it as either answer would be an invention.',
        ),
      );
    }
    if (unreadable > 0) {
      warnings.push(
        warn(
          'autopay_comment_unreadable',
          `${String(unreadable)} of ${String(payList.data.length)} payment comments could not be ` +
            'read as an object (neither a JSON object nor an object body). Autopay state lives ' +
            'nowhere else, so the verdict below rests on incomplete evidence: an unreadable ' +
            'comment can hold exactly the subscription row that would have changed it.',
        ),
      );
    }
    if (user.ok && Object.keys(userRow).length === 0) {
      warnings.push(
        warn(
          'user_not_found',
          `No client with user_id ${String(shm_user_id)} exists in SHM. The empty autopay result ` +
            'below is about a client that is not there, not about a client without autopay.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A system needed for this answer did not respond (see `degraded`). ' +
            (pays.ok
              ? 'The payment rows were read, so the autopay verdict stands; only the check that ' +
                'the client exists at all is missing.'
              : 'The payment rows are the ONLY place autopay state lives, so `connected` is null ' +
                'and every list is empty rather than wrong. This is not evidence that the client ' +
                'has no autopay.'),
        ),
      );
    }

    return {
      connected,
      /** Прочитаны ли доказательства вообще. false ⇒ `connected` ничего не значит. */
      checked: pays.ok,
      verdict,
      next_charge_at: connected === true ? (current?.next_charge_at ?? null) : null,
      charges: {
        /** Списания по подписке, на которой стоит вердикт — посчитаны по строкам. */
        current_subscription: current?.charges_seen ?? null,
        /**
         * `charges_count` в том виде, в каком его записал SHM. Живёт ТОЛЬКО на
         * строке удержания — на фоне всей таблицы платежей таких строк единицы,
         * поэтому у подключённого клиента его нет вовсе: это не ноль, это
         * отсутствие.
         */
        recorded: current?.charges_recorded ?? null,
        /** Все денежные списания автоплатежа этого клиента, по всем подпискам. */
        total_rows: rows.filter((row) => !isCancelFee(row) && row.money > 0).length,
      },
      payment_method: current?.payment_method ?? null,
      /** Написания, реально встреченные у этого клиента: доказательство нормализации. */
      spellings_seen: spellings,
      subscriptions,
      withholdings,
      rows: {
        items: payList.items,
        limit: payList.limit,
        scanned: payList.data.length,
        autopay: rows.length,
        unreadable_comments: unreadable,
      },
      warnings,
      degraded,
    };
  },
});
