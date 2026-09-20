import type { ClientParams, ToolContext } from '@hq/types';

/**
 * ОБЩАЯ ЧАСТЬ ДЕНЕЖНЫХ МУТАТОРОВ: снимок клиента, водяные знаки истории и
 * поиск СОБСТВЕННОЙ уже записанной строки.
 *
 * Здесь же живут два факта о SHM, каждый из которых по отдельности превращает
 * денежный инструмент в генератор тихих ошибок.
 *
 * 1. СПРАШИВАТЬ КЛИЕНТА НАДО ФИЛЬТРОМ, А НЕ `?user_id=`. Диспетчер зовёт
 *    `switch_user($args{user_id})` для любого админского запроса с этим
 *    параметром (app/public_html/shm/v1.cgi:1686-1690), и переключение на
 *    несуществующего клиента не даёт пустого списка — оно ломает обработчик.
 *    Снято с работающей SHM 2.19.4, а не выведено из спецификации:
 *      GET /admin/user?user_id=99999999           → {"error":"Недоступно в данной версии"}
 *      GET /admin/user?filter={"user_id":99999999} → 200, items: 0
 *    То есть «такого клиента нет» приезжает в форме «источник отказал», и
 *    инструмент, спросивший первой формой, доложит поломку бэкенда вместо
 *    правды. Тот же вывод сделан соседями для читающих инструментов
 *    (tools/read/src/kit.ts, shmUserExistsParams).
 *
 * 2. ФИЛЬТР МОЖЕТ НЕ СУЗИТЬ ВЫБОРКУ. Ровно поэтому в @hq/types есть
 *    возможность `shm.filter`, а `client_search` проверяет сужение по самому
 *    ответу. Для чтения незамеченный отказ фильтра — кривой список; для денег
 *    это платёж, посчитанный по чужому балансу. Поэтому каждая строка здесь
 *    сверяется с запрошенным `user_id`, и расхождение — отказ, а не догадка.
 */

/**
 * Сколько последних строк истории читаем.
 *
 * Окно намеренно измеряется СТРОКАМИ, а не временем: `pays_history.date` и
 * `bonus_history.date` — это `strftime` локального времени СЕРВЕРА без офсета
 * (Core::Utils::now, Utils.pm:133-141). Сравнивать такой штамп с часами агента
 * — классическая молчаливая ошибка ровно в размер расхождения зон, и в
 * денежной проверке она даёт то ложный пропуск, то ложный отказ. Строк хватает:
 * своя строка, если она есть, лежит в самом верху (сортировка по ключу
 * таблицы DESC — умолчание `query_for_order`, Sql/Data.pm:280-298).
 */
export const HISTORY_SCAN = 25;

/** Поле комментария, в котором едет маркер плана (@hq/idempotency, stampComment). */
const MARKER_FIELD = 'hq_plan';

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Число из ответа SHM. Decimal-колонки приезжают то числом, то строкой
 * («0.00»), и `Number(undefined)` — это `NaN`, который дальше молча становится
 * суммой платежа. Поэтому либо число, либо отказ с именем поля.
 */
export function toNumber(value: unknown, what?: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (what === undefined) return 0;
  throw new Error(
    `не разобрать ${what} из ответа SHM: ${JSON.stringify(value)}. Денежная операция на ` +
      'неразобранном числе — это операция на выдуманном числе',
  );
}

/** Копейки: сравнивать суммы битами float нельзя, 640.5 приезжает и строкой. */
export function cents(value: unknown): number {
  return Math.round(toNumber(value) * 100);
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Запрос «про этого клиента» — фильтром (см. факт 1 в шапке файла). */
export function byUser(userId: number, limit: number): ClientParams {
  return {
    filter: JSON.stringify({ user_id: userId }),
    limit,
    // Умолчание `query_for_order` и так desc по ключу таблицы, но водяной знак
    // — это то, ради чего вызов существует: порядок называется явно, чтобы
    // смена умолчания в SHM не превратила «последний платёж» в «первый».
    sort_field: 'id',
    sort_direction: 'desc',
  };
}

export interface MoneyRow {
  id?: unknown;
  user_id?: unknown;
  money?: unknown;
  bonus?: unknown;
  date?: unknown;
  comment?: unknown;
}

/** Плоский снимок клиента: он же `before` плана, он же то, что перечитывает guard. */
export interface ClientMoney {
  user_id: number;
  balance: number;
  bonus: number;
  block: number;
  /** 0 — партнёра нет. Нужен, чтобы предупредить о бонусе рефереру. */
  partner_id: number;
  /** Наибольший `id` платежа на момент чтения (0 — платежей не было). */
  lastPayId: number;
  /** То же для бонусов: у bonus_history своей идемпотентности нет вовсе. */
  lastBonusId: number;
}

export interface ClientMoneyRead {
  snapshot: ClientMoney;
  pays: MoneyRow[];
  bonuses: MoneyRow[];
}

const USER_PATH = '/admin/user';
const PAY_PATH = '/admin/user/pay';
const BONUS_PATH = '/admin/user/bonus';

function assertNarrowed(tool: string, path: string, rows: MoneyRow[], userId: number): void {
  const foreign = rows.find((row) => row.user_id !== undefined && toNumber(row.user_id) !== userId);
  if (foreign === undefined) return;
  throw new Error(
    `${tool}: server-side filter на ${path} не сузил выборку — в ответе строка клиента ` +
      `${String(foreign.user_id)}, а спрашивали про ${userId}. На такой сборке SHM ни баланс, ни ` +
      'водяной знак истории прочитать нельзя, а денежная операция по чужой строке — это операция ' +
      'не тому клиенту. Проверьте фильтр инструментом platform_probe (возможность shm.filter).',
  );
}

function watermark(rows: MoneyRow[]): number {
  return rows.length === 0 ? 0 : Math.max(...rows.map((row) => toNumber(row.id)));
}

/**
 * Снимок клиента для денежной операции: три чтения, все фильтром.
 *
 * Историю читаем страницей, а не одной строкой: из неё берётся и водяной знак
 * (`classifyPaymentResult`, §4.3), и ответ на вопрос «не мы ли эту строку уже
 * записали». Второй вызов ради тех же данных стоил бы столько же и мог бы
 * прийтись на другое состояние базы.
 */
export async function readClientMoney(
  ctx: ToolContext,
  userId: number,
  tool: string,
): Promise<ClientMoneyRead> {
  const users = await ctx.shm.list<Record<string, unknown>>(USER_PATH, byUser(userId, 1));
  const row = users.data[0];
  if (row === undefined) {
    throw new Error(
      `${tool}: клиент user_id=${userId} не найден в SHM. Спрошено фильтром ` +
        '(filter={"user_id":…}), потому что ?user_id= на несуществующем клиенте ломает роутер SHM ' +
        'и отвечает «Недоступно в данной версии» вместо пустого списка — то есть «клиента нет» ' +
        'выглядит как «бэкенд отказал».',
    );
  }
  assertNarrowed(tool, USER_PATH, [row as MoneyRow], userId);

  const pays = await ctx.shm.list<MoneyRow>(PAY_PATH, byUser(userId, HISTORY_SCAN));
  assertNarrowed(tool, PAY_PATH, pays.data, userId);
  const bonuses = await ctx.shm.list<MoneyRow>(BONUS_PATH, byUser(userId, HISTORY_SCAN));
  assertNarrowed(tool, BONUS_PATH, bonuses.data, userId);

  return {
    snapshot: {
      user_id: userId,
      balance: toNumber(row.balance, `баланс клиента ${userId}`),
      bonus: toNumber(row.bonus, `бонусы клиента ${userId}`),
      block: toNumber(row.block),
      partner_id: toNumber(row.partner_id),
      lastPayId: watermark(pays.data),
      lastBonusId: watermark(bonuses.data),
    },
    pays: pays.data,
    bonuses: bonuses.data,
  };
}

/** Только страница истории — для проверки прямо перед записью. */
export async function readHistory(
  ctx: ToolContext,
  kind: 'balance' | 'bonus',
  userId: number,
  tool: string,
): Promise<MoneyRow[]> {
  const path = kind === 'balance' ? PAY_PATH : BONUS_PATH;
  const rows = await ctx.shm.list<MoneyRow>(path, byUser(userId, HISTORY_SCAN));
  assertNarrowed(tool, path, rows.data, userId);
  return rows.data;
}

/**
 * Маркер плана из строки истории, если он там есть.
 *
 * Комментарий — json-колонка, и SHM отдаёт её то разобранным объектом
 * (`convert_sql_structure_data`, Sql/Data.pm:265-268), то сырой строкой в
 * зависимости от обёртки. Смотрим оба вида: пропущенный маркер здесь означает
 * «свою строку не узнали», а это ровно та цена, ради которой маркер и есть.
 */
export function hqPlanOf(row: unknown): string | null {
  const comment = asRecord(row).comment;
  if (typeof comment === 'string') {
    const found = /"hq_plan"\s*:\s*"([^"]+)"/.exec(comment);
    return found?.[1] ?? null;
  }
  const marker = asRecord(comment)[MARKER_FIELD];
  return typeof marker === 'string' && marker !== '' ? marker : null;
}

/** Строка, записанная ИМЕННО этим планом. Точное совпадение, а не догадка. */
export function findPlanRow<T>(rows: readonly T[], token: string): T | undefined {
  const marker = `hq-plan:${token}`;
  return rows.find((row) => hqPlanOf(row) === marker);
}

/**
 * Строка ЭТОГО сервера на ту же сумму среди последних {@link HISTORY_SCAN}.
 *
 * Это не идемпотентность и не доказательство повтора — это улика. Сценарий, на
 * который она рассчитана: применение прошло, ответ до оператора не доехал
 * (таймаут, разрыв, смерть процесса), оператор строит план заново. Новый план
 * — новый токен, значит и `uniq_key` другой: дедуп SHM тут не срабатывает
 * ВООБЩЕ, и клиент получает вторую сумму. Единственный, кто может это заметить,
 * — сам инструмент, и только по своей же метке в истории.
 */
export function findHqTwin<T extends MoneyRow>(
  rows: readonly T[],
  field: 'money' | 'bonus',
  amount: number,
): T | undefined {
  const target = cents(amount);
  return rows.find((row) => hqPlanOf(row) !== null && cents(row[field]) === target);
}

export function assertNoHqTwin(
  tool: string,
  rows: readonly MoneyRow[],
  field: 'money' | 'bonus',
  amount: number,
  what: string,
  userId: number,
): void {
  const twin = findHqTwin(rows, field, amount);
  if (twin === undefined) return;
  throw new Error(
    `${tool}: у клиента ${userId} уже есть ${what} на ту же сумму ${amount}, записанный этим ` +
      `сервером (id=${String(twin.id)}, дата ${String(twin.date)}, ${String(hqPlanOf(twin))}). ` +
      'Чаще всего это повтор после потерянного ответа: операция прошла, ответ не доехал. ' +
      'Проверьте историю клиента (billing_ledger) и, если повтор действительно нужен, ' +
      'передайте allow_duplicate: true — тогда план строится с полным пониманием, что сумм ' +
      'будет две.',
  );
}

/**
 * ДОЕХАЛ ЛИ `uniq_key` ДО БАЗЫ — ВОПРОС, КОТОРЫЙ ПОЯВИЛСЯ ВМЕСТЕ С SHM 3.0.
 *
 * `Core::User::payment` по-прежнему умеет дедуп по (user_id, uniq_key): при
 * совпадении он возвращает СУЩЕСТВУЮЩИЙ платёж и баланс не трогает. Но с 3.0
 * маршрут `PUT /admin/user/payment` объявил закрытый список аргументов
 * (`user_id`, `money`, `pay_system_id`, `comment`), а всё незадекларированное
 * v1.cgi выбрасывает МОЛЧА и отвечает 200. `uniq_key` в этом списке нет — то
 * есть ключ идемпотентности уезжает в никуда, отказа не происходит, и
 * единственная защита от повторного зачисления перестаёт существовать, ничем
 * себя не выдав.
 *
 * Проверяется по ЗАПИСАННОЙ строке, а не по версии: SHM возвращает созданный
 * платёж целиком, и `uniq_key` в нём либо наш, либо пустой. (Поле приезжает
 * под именем `uniq_id` — переименование SHM_SAFE_RENAMES, без которого
 * редакция съела бы его по слову `key`.)
 *
 * `null` — сказать нечего: поля в ответе нет вовсе, и утверждать по его
 * отсутствию ни «доехал», ни «не доехал» нельзя.
 */
export function uniqKeyLanded(payment: Record<string, unknown>, sent: string): boolean | null {
  const got = payment.uniq_id ?? payment.uniq_key;
  if (got === undefined || got === null) return null;
  return String(got) === sent;
}

/**
 * Текст для ответа применения, когда ключ до базы НЕ доехал. Живёт рядом с
 * проверкой, потому что нужен обоим денежным мутаторам слово в слово: две
 * формулировки одного факта разъехались бы на первой же правке.
 */
export const UNIQ_KEY_DROPPED_NOTE =
  'ИДЕМПОТЕНТНОСТИ У ЭТОГО ЗАЧИСЛЕНИЯ НЕ БЫЛО. Платёж записан, но uniq_key до pays_history не ' +
  'доехал: с SHM 3.0 маршрут PUT /admin/user/payment принимает только user_id, money, ' +
  'pay_system_id и comment, а всё остальное выбрасывает молча и отвечает 200. Дедуп ' +
  'Core::User::payment на такой строке не сработает НИКОГДА, то есть повтор этого вызова ' +
  'зачислит деньги второй раз. Повторять нельзя. Единственное, что сейчас защищает от дубля, — ' +
  'маркер плана в комментарии, по которому повтор находит свою строку ДО записи; это защита ' +
  'нашей стороны, а не базы. Починка — добавить uniq_key в список params этого маршрута в ' +
  'v1.cgi.';
