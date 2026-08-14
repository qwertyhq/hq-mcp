import type { ToolContext } from '@hq/types';

/**
 * ЧТЕНИЕ ПАНЕЛИ РАДИ ОДНОГО ЧИСЛА — СКОЛЬКО КЛИЕНТОВ ЗАДЕНЕТ ОПЕРАЦИЯ.
 *
 * Почему это не длина списка, который назвал оператор. Панель молча выбрасывает
 * незнакомые id: `bulkDeleteUsersByUserId` сначала делает
 * `getUsersByUserIds(userIds)` и удаляет уже `users.map(u => u.id)`,
 * `bulkUpdateUsersInternalSquads` начинает с `validateUserIds`
 * (src/modules/users/users.service.ts, тег 3.2.3). То есть список из ста имён
 * — это от нуля до ста учёток, и разницу знает только панель.
 *
 * Почему это не «все». У `bulk/all/*` списка нет вовсе, и число берётся из
 * `total` постраничной выдачи. Без него план сообщал бы «применить ко всем», а
 * подтверждать «всех» вслепую — это ровно то, ради чего массовые операции
 * сначала и не были сделаны.
 *
 * ПОЧЕМУ ОБХОД СТРАНИЦАМИ, А НЕ ЗАПРОС НА КАЖДЫЙ id. Гейт запросов (§6.14)
 * держит 30 обращений в минуту на всех: сотня точечных `GET /api/users/{id}`
 * съела бы бюджет целиком и упала бы на середине списка, оставив план
 * недостроенным. Флот в 1125 учёток читается тремя страницами по 500.
 */

/** Потолок `size` у `/api/users` — 1000 по схеме запроса; 500 проверено на работающей панели. */
export const FLEET_PAGE_SIZE = 500;

/**
 * Предохранитель от бесконечного обхода: панель, вернувшая пустую страницу при
 * растущем `total`, крутила бы цикл вечно. 40 страниц по 500 — это 20 000
 * учёток, вдесятеро больше нынешнего флота.
 */
export const FLEET_MAX_PAGES = 40;

export const USERS_PATH = '/api/users';

/** Статусы клиента в 3.2.3 — закрытый список (USERS_STATUS контракта). */
export const USER_STATUSES = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Строка клиента в том виде, в каком её показывает план. Ссылки подписки,
 * `trojanPassword`, `ssPassword` и `vlessUuid` панель отдаёт в этой же строке —
 * здесь их нет и быть не должно: снимок плана уезжает на диск и в журнал
 * мутаций, и любое из этих полей поехало бы туда открытым текстом.
 */
export interface FleetUser {
  id: number;
  username: string | null;
  status: string | null;
  expireAt: string | null;
  trafficLimitBytes: number | null;
  trafficLimitStrategy: string | null;
  hwidDeviceLimit: number | null;
  tag: string | null;
  squadUuids: string[];
  /**
   * Счётчик израсходованного трафика. В сверке мира НЕ участвует и участвовать
   * не может: у подключённого клиента он растёт сам, и план отвергался бы как
   * «мир уехал» каждый раз. Нужен ровно для одного — показать, сколько именно
   * обнулит `reset_traffic`.
   */
  usedTrafficBytes: number | null;
}

export interface FleetPage {
  users: FleetUser[];
  total: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `activeInternalSquads` приезжает списком объектов `{uuid, name}` (проверено
 * на работающей панели 3.2.3), а `bulk/update-squads` принимает список ГОЛЫХ uuid.
 * Разница в форме — ровно то место, где снимок «до» перестал бы годиться в
 * тело запроса, поэтому нормализуется он здесь, один раз.
 */
function squadUuidsOf(value: unknown): string[] {
  return asArray(value)
    .map((entry) => strOrNull(asRecord(entry).uuid) ?? strOrNull(entry))
    .filter((uuid): uuid is string => uuid !== null)
    .sort((left, right) => left.localeCompare(right));
}

export function toFleetUser(row: unknown): FleetUser | null {
  const user = asRecord(row);
  const id = numOrNull(user.id);
  if (id === null) return null;
  return {
    id,
    username: strOrNull(user.username),
    status: strOrNull(user.status),
    expireAt: strOrNull(user.expireAt),
    trafficLimitBytes: numOrNull(user.trafficLimitBytes),
    trafficLimitStrategy: strOrNull(user.trafficLimitStrategy),
    hwidDeviceLimit: numOrNull(user.hwidDeviceLimit),
    tag: strOrNull(user.tag),
    squadUuids: squadUuidsOf(user.activeInternalSquads),
    usedTrafficBytes: numOrNull(asRecord(user.userTraffic).usedTrafficBytes),
  };
}

/**
 * Одна страница `/api/users`. `total` отдаётся отдельно от строк намеренно:
 * длина страницы и размер флота — разные числа, и подмена первого вторым
 * превращает «мы посмотрели 500 из нескольких тысяч» в «в панели 500 клиентов».
 */
export async function readFleetPage(
  ctx: ToolContext,
  start: number,
  size: number,
  filters?: readonly { id: string; value: string }[],
): Promise<FleetPage> {
  const params: Record<string, string | number> = { size, start };
  if (filters !== undefined && filters.length > 0) {
    // `/api/users` принимает `filters` СТРОКОЙ JSON — схема запроса гонит
    // значение через `z.preprocess(JSON.parse)`. Массив, отданный как есть,
    // уехал бы повторяющимся query-параметром и был бы молча отброшен:
    // `z.object` нестрогий, незнакомая форма выбрасывается без ошибки, и
    // фильтр «работал» бы, не сузив ничего.
    params.filters = JSON.stringify(filters);
  }
  const body = asRecord(await ctx.remna.get<unknown>(USERS_PATH, params));
  const rows = asArray(body.users);
  const users = rows.map(toFleetUser).filter((user): user is FleetUser => user !== null);
  return { users, total: numOrNull(body.total) };
}

export interface FleetRead {
  users: FleetUser[];
  /** Сколько строк панель насчитала под этот запрос. */
  total: number;
}

function refuseCount(what: string): never {
  throw new Error(
    `bulk_ops: панель не сообщила, сколько клиентов подпадает под ${what} (в ответе ` +
      '/api/users нет поля total). Число затронутых установить нечем, а массовая операция без ' +
      'него не планируется: подтверждать «применить ко всем» вслепую нельзя.',
  );
}

/**
 * Вычитывает ВСЕ строки под запрос, а не первое окно, и отдаёт `total` панели
 * рядом с ними.
 *
 * `cap` — не потолок операции (тот живёт в каркасе и в `HQ_MCP_MAX_BULK_USERS`),
 * а предел ЧТЕНИЯ: перечислять поимённо флот, который заведомо не пройдёт
 * потолок, незачем — трафик потрачен, а план всё равно будет отвергнут.
 * Поэтому обход прекращается, как только прочитанного стало больше `cap`:
 * `total` к этому моменту уже известен, и отказ по потолку строится по нему.
 */
export async function readFleet(
  ctx: ToolContext,
  what: string,
  opts: { cap: number; filters?: readonly { id: string; value: string }[] },
): Promise<FleetRead> {
  const users: FleetUser[] = [];
  let total: number | null = null;

  for (let page = 0; page < FLEET_MAX_PAGES; page += 1) {
    const chunk = await readFleetPage(ctx, users.length, FLEET_PAGE_SIZE, opts.filters);
    if (chunk.total === null) refuseCount(what);
    total = chunk.total;
    users.push(...chunk.users);

    if (users.length >= chunk.total) return { users, total: chunk.total };
    // Панель насчитала больше, чем отдала, а страница пришла пустая — дальше
    // цикл крутился бы вечно на том же `start`. Это ответ, которого мы не
    // понимаем, и он обязан быть громким.
    if (chunk.users.length === 0) {
      throw new Error(
        `bulk_ops: панель насчитала ${String(chunk.total)} строк под ${what}, но отдала пустую ` +
          `страницу на смещении ${String(users.length)}. Обход прерван: продолжать значит ` +
          'крутиться на месте, а строить план по неполному списку нельзя.',
      );
    }
    // Читать дальше нечего: потолок всё равно отвергнет план, а `total` для
    // отказа уже есть.
    if (users.length > opts.cap) return { users, total: chunk.total };
  }

  if (total === null) refuseCount(what);
  throw new Error(
    `bulk_ops: обход /api/users не сошёлся за ${String(FLEET_MAX_PAGES)} страниц (насчитано ` +
      `${String(total)}). План не строится по частично прочитанному списку.`,
  );
}

/** Сколько всего учёток в панели. Одна страница размером 1 — нужен только `total`. */
export async function readFleetTotal(ctx: ToolContext): Promise<number> {
  const page = await readFleetPage(ctx, 0, 1);
  if (page.total === null) refuseCount('весь флот');
  return page.total;
}

export interface ResolvedSet {
  /** Найденные в панели, в том же порядке, что и в списке оператора. */
  found: FleetUser[];
  /** Названные оператором, но в панели отсутствующие. */
  missing: number[];
}

/**
 * Сверяет НАЗВАННЫЙ список id с тем, что есть в панели.
 *
 * Отсутствующие возвращаются отдельно, а не выбрасываются: панель их проглотит
 * молча, и оператор, попросивший сто и задевший девяносто пять, об этом никогда
 * не узнает. Что делать с расхождением, решает вызывающий — но узнать о нём он
 * обязан.
 */
export async function resolveUserIds(ctx: ToolContext, ids: readonly number[]): Promise<ResolvedSet> {
  const wanted = new Set(ids);
  // Читается ВЕСЬ флот, а не `ids.length` точечных запросов: см. докстринг
  // модуля про бюджет. `cap` — размер флота с запасом, потому что интересующие
  // строки лежат где угодно среди него, и оборвать обход раньше значит объявить
  // ненайденными тех, до кого не дошли.
  const fleet = await readFleet(ctx, 'названный список клиентов', {
    cap: Number.MAX_SAFE_INTEGER,
  });
  const byId = new Map(fleet.users.map((user) => [user.id, user]));
  const found: FleetUser[] = [];
  const missing: number[] = [];
  for (const id of wanted) {
    const user = byId.get(id);
    if (user === undefined) missing.push(id);
    else found.push(user);
  }
  return { found, missing };
}
