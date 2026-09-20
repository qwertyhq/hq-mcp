import { SHM_MAX_LIMIT } from '@hq/shm';
import type {
  ClientParams,
  Degraded,
  RemnaClient,
  ShmClient,
  ShmListResult,
  ToolContext,
  ToolWarning,
} from '@hq/types';

/** Чтения Remnawave батчатся страницами по 50 с паузой 200 мс (§7.6). */
export const REMNA_PAGE_SIZE = 50;
export const REMNA_PAGE_PAUSE_MS = 200;

/** topNodesLimit/topUsersLimit — обязательные параметры §6.17, дефолт 5. */
export const REMNA_TOP_LIMIT = 5;

export const EMPTY_LIST: ShmListResult<never> = { items: 0, limit: 0, offset: 0, data: [] };

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error: errMessage(error) };
  }
}

/**
 * КАК ЭТА ИНСТАЛЛЯЦИЯ ИМЕНУЕТ СВОИ ОБЪЕКТЫ — ре-экспорт, а не вторая копия.
 *
 * Реализация переехала в `@hq/shm` (packages/shm/src/naming.ts) и там же
 * подробно объяснена. Переехала по одной причине: потребителей стало два, и
 * они в разных пакетах. Читающие инструменты этими префиксами имена СОБИРАЮТ
 * (provisioning_diagnose) и РАЗБИРАЮТ (sync_audit), а `storage_edit` из пакета
 * мутаций держит на том же префиксе разрешительный список ключей, по которым
 * вообще готов писать. `@hq/tools-mutations` не зависит и не должен зависеть
 * от `@hq/tools-read`, поэтому «одно место» перестало быть местом внутри
 * читающего кита; новый дом выбран по источнику истины — значение читается из
 * таблицы config САМОЙ SHM.
 *
 * Имена здесь остаются, потому что для читающих инструментов это по-прежнему
 * часть кита: они зовут `resolvePanelNaming` из `../kit.js` и знать про
 * переезд не обязаны. Экземпляр реализации при этом ровно один — а вместе с
 * ним один процессный кэш, который и есть смысл всей конструкции.
 */
export {
  DEFAULT_PANEL_USERNAME_PREFIX,
  DEFAULT_PANEL_USERNAME_PREFIXES,
  DEFAULT_STORAGE_PREFIX,
  LEGACY_PANEL_USERNAME_PREFIXES,
  PANEL_PREFIXES_VAR,
  STORAGE_PREFIX_VAR,
  matchesKnownPrefix,
  parsePrefixList,
  prefixSourcePhrase,
  resetPanelNamingCache,
  resolvePanelNaming,
} from '@hq/shm';
export type { PanelNaming, PrefixSource } from '@hq/shm';

/**
 * ГДЕ У ЭТОЙ SHM ЛЕЖИТ ИДЕНТИЧНОСТЬ КЛИЕНТА — ре-экспорт по той же причине,
 * что и именование выше: реализация живёт в `@hq/shm` (identity.ts), потому
 * что источник истины — сама SHM, а читающим инструментам это часть кита.
 */
export {
  ACCOUNTS_PATH,
  emailOfAccounts,
  identitySchemaOfRow,
  lookupAccounts,
  lookupAccountsFor,
  normalizeAccount,
  phonesOfAccounts,
  resetIdentitySchemaCache,
  telegramIdOfAccounts,
} from '@hq/shm';
export type { AccountKind, AccountsLookup, AccountsQuery, IdentitySchema, ShmAccount } from '@hq/shm';

/** Мягкая деградация: неудача одной системы не роняет весь ответ, а помечается. */
export function take<T>(
  result: Settled<T>,
  system: Degraded['system'],
  into: Degraded[],
  fallback: T,
): T {
  if (result.ok) return result.value;
  into.push({ system, error: result.error });
  return fallback;
}

export function warn(code: string, message: string): ToolWarning {
  return { code, message };
}

/**
 * Отказ инструмента, объявленного `profiles: ['human']`, обслужить бота.
 *
 * ЧЕГО ЭТА ПРОВЕРКА НЕ ДЕЛАЕТ СЕГОДНЯ: она не срабатывает. Единственный
 * исполнитель выбирает инструмент ТОЛЬКО из `listVisibleTools`
 * (packages/exec/src/index.ts), и вызов бота по имени человеческого
 * инструмента заканчивается `not found` ещё до хендлера — `Registry.get`,
 * который действительно отдаёт определение кому угодно, на этом пути не
 * участвует.
 *
 * Зачем тогда: это защита второго слоя для плана 3, где HTTP-вызывающего
 * пишем не мы, и единственная страховка на случай, если гейт видимости
 * когда-нибудь начнут обходить резолвом по имени. И именно поэтому она живёт
 * в одном месте и стоит у ВСЕХ человеческих инструментов, а не у части:
 * выборочная защита читается как «этим она не нужна» — утверждение, которого
 * никто не делал.
 *
 * Причина у каждого инструмента своя и остаётся при нём: «почему это не для
 * бота» — самое полезное, что можно сказать в таком отказе.
 */
export function assertHumanOnly(ctx: ToolContext, reason: string): void {
  if (ctx.profile === 'human') return;
  throw new Error(reason);
}

/**
 * Одна и та же недоступность, встреченная на каждой из десяти услуг, — это
 * один факт, а не десять строк в degraded. `take` пишет безусловно, поэтому
 * источники, читаемые в цикле, отмечаются через это.
 */
export function noteOnce(into: Degraded[], system: Degraded['system'], error: string): void {
  if (!into.some((one) => one.system === system && one.error === error)) {
    into.push({ system, error });
  }
}

export function capLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Math.trunc(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * `redact` строит выходные объекты через `Object.create(null)` (нет
 * `Object.prototype` в цепочке), поэтому здесь и во всём остальном kit.ts
 * никаких `.hasOwnProperty(...)` / `instanceof Object` / `instanceof Array` —
 * они либо бросают, либо молчаливо врут на таком объекте. Безопасны только
 * `typeof`, `Array.isArray`, спред и `Object.keys`.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/** Байты у Remnawave приезжают то строкой, то числом — приводим всегда (§6.17). */
export function num(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** settings у SHM приходит то объектом, то JSON-строкой. */
export function parseSettings(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') return asRecord(value);
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

export function telegramIdOf(row: Record<string, unknown>): number | null {
  const telegram = asRecord(parseSettings(row.settings).telegram);
  const id = num(telegram.chat_id, Number.NaN);
  return Number.isFinite(id) ? id : null;
}

/** `YYYY-MM-DD[ |T]HH:MM[:SS]` без офсета — ровно то, что печатает strftime SHM. */
const NAIVE_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (ZONE_FORMATTERS.has(zone)) return ZONE_FORMATTERS.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // Невалидная зона отсекается в loadConfig; если она всё же доехала сюда,
    // ответ инструмента не должен превращаться в исключение. Откат к UTC не
    // молчаливый: расхождение поймает clock_skew, который назовёт зону вслух.
    formatter = null;
  }
  ZONE_FORMATTERS.set(zone, formatter);
  return formatter;
}

/** Смещение зоны в миллисекундах к востоку от UTC — в КОНКРЕТНЫЙ момент, не «сейчас». */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const formatter = formatterFor(zone);
  if (formatter === null) return 0;
  const parts = formatter.formatToParts(new Date(utcMs));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // Некоторые ICU в h23 всё ещё печатают полночь как 24.
    field('hour') % 24,
    field('minute'),
    field('second'),
  );
  return asUtc - utcMs;
}

/**
 * Дата SHM → момент времени. Core::Utils::now — это strftime("%Y-%m-%d
 * %H:%M:%S", localtime) (app/lib/Core/Utils.pm:133-141): локальное время
 * СЕРВЕРА, без офсета и без `Z`. Стенды живут в Europe/Moscow (TZ в
 * docker-compose.staging.yml:27, docker-compose.test.yml:24,
 * contributing/docker-compose.yml:25, helm/k8s-shm/values.yaml), то есть
 * прочитанный как UTC штамп уезжает на три часа В БУДУЩЕЕ, и любая проверка
 * «старше N минут» молча перестаёт срабатывать на всём, что моложе 180+N минут.
 * Поэтому «голый» штамп разбирается ИМЕННО в `zone`, а штамп со своим офсетом
 * или `Z` — как написан. Живёт в kit, а не рядом с одним инструментом: те же
 * даты читает provisioning_diagnose, и приватная копия — это то, как сломанная
 * версия возвращается.
 */
export function parseShmDate(value: unknown, zone: string): Date | null {
  const text = str(value);
  if (text === null) return null;

  const naive = NAIVE_STAMP_RE.exec(text);
  if (naive === null) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const y = Number(naive[1]);
  const mo = Number(naive[2]);
  const d = Number(naive[3]);
  const h = Number(naive[4] ?? '0');
  const mi = Number(naive[5] ?? '0');
  const s = Number(naive[6] ?? '0');
  // '0000-00-00 00:00:00' — легальное значение MySQL и не момент времени.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;

  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(asIfUtc)) return null;
  const offset = zoneOffsetMs(asIfUtc, zone);
  const utc = asIfUtc - offset;
  // Один уточняющий проход: на границе перехода на летнее время офсет в точке
  // догадки и в точке ответа различаются.
  const refined = zoneOffsetMs(utc, zone);
  return new Date(refined === offset ? utc : asIfUtc - refined);
}

/** Возраст даты SHM в минутах; null, если разобрать не удалось. Отрицательное значение = дата в будущем. */
export function minutesSince(now: Date, value: unknown, zone: string): number | null {
  const at = parseShmDate(value, zone);
  return at === null ? null : Math.floor((now.getTime() - at.getTime()) / 60_000);
}

/**
 * Имя статуса из строки ответа `GET /admin/spool/statuses`. Ручка — это
 * `SELECT status, COUNT(status) AS cnt ... GROUP BY status`
 * (app/lib/Core/Spool.pm:426-435): ключ называется `status`, поля `name` в
 * ответе нет. Объект без `status` осознанно отбрасывается: `str` делает
 * `String(value)`, то есть вернул бы '[object Object]' и тихо засорил список
 * статусов правдоподобным мусором. Живёт в kit, потому что ту же ручку читают
 * и platform_probe, и spool_inspect.
 */
export function spoolStatusName(item: unknown): string | null {
  const own = str(asRecord(item).status);
  if (own !== null) return own;
  return typeof item === 'string' ? str(item) : null;
}

/**
 * Полный словарь статусов спула — app/lib/Core/Const.pm:78-83, объявлен на
 * колонке в app/lib/Core/Spool.pm:41-45. Ничего другого спул не выдаёт, и
 * выдать не может: колонка `status` это char(8) (shm_structure.sql:181), в
 * который, например, 'CANCELLED' просто не влезает.
 *
 * Живёт в kit, а не рядом с одним инструментом, по той же причине, что и
 * parseShmDate: этот словарь читают spool_inspect и provisioning_diagnose, и
 * приватная копия — это то, как выдуманный статус возвращается.
 */
export const SPOOL_NEW_STATUS = 'NEW';
export const SPOOL_SUCCESS_STATUS = 'SUCCESS';
/** Провал с повтором: retry_task оставляет задачу в очереди. */
export const SPOOL_FAILED_STATUS = 'FAIL';
export const SPOOL_DELAYED_STATUS = 'DELAYED';
/**
 * Два статуса, которые воркер исключает из выборки на исполнение НАВСЕГДА:
 * `status => { -not_in => [TASK_STUCK, TASK_PAUSED] }` (Spool.pm:130-133).
 * Задача с таким статусом существует, но сама уже никогда не поедет — разница
 * между ними только в том, кто её остановил: STUCK ставит воркер на
 * терминальном провале (Spool.pm:169-171, 202-206, 212-216, 229-233, 253-257),
 * PAUSED — оператор руками. Ни один инструмент не должен читать эти строки как
 * «ожидание», и ни один не должен писать их литералом.
 */
export const SPOOL_STUCK_STATUS = 'STUCK';
export const SPOOL_PAUSED_STATUS = 'PAUSED';

export const SPOOL_STATUSES = [
  SPOOL_NEW_STATUS,
  SPOOL_SUCCESS_STATUS,
  SPOOL_FAILED_STATUS,
  SPOOL_DELAYED_STATUS,
  SPOOL_STUCK_STATUS,
  SPOOL_PAUSED_STATUS,
] as const;

/**
 * «Должна была выполниться и не выполнилась»: NEW, давно ждущая своей очереди,
 * и STUCK, которую воркер уже пометил сам. STUCK возрастного порога не требует
 * (см. выше), NEW — требует.
 */
export const SPOOL_STUCK_STATUSES: readonly string[] = [SPOOL_NEW_STATUS, SPOOL_STUCK_STATUS];

/**
 * Ожидание по замыслу. DELAYED — штатное состояние: Spool.pm:93-97 превращает
 * NEW+delayed>0 в DELAYED, а Spool.pm:277-283 переводит УСПЕШНУЮ периодическую
 * задачу обратно в DELAYED вместо удаления, то есть это постоянное состояние
 * покоя любой повторяющейся работы. PAUSED сюда не входит — это ручная
 * остановка оператором, а не ожидание.
 */
export const SPOOL_PENDING_STATUSES: readonly string[] = [SPOOL_NEW_STATUS, SPOOL_DELAYED_STATUS];

/**
 * user_service_id задачи спула. Колонка `spool.user_service_id` в схеме есть
 * (app/sql/shm/shm_structure.sql:176), но провижининг её не заполняет:
 * USObject::make_commands_by_event кладёт id услуги в settings
 * (app/lib/Core/USObject.pm:463 `$args{settings}{user_service_id} = $self->id + 0`),
 * а Core::Base::_add_or_set (app/lib/Core/Base.pm:332-374) ключи settings в
 * колонки не переносит. Ровно поэтому /admin/user/service/spool ищет задачи
 * через list_by_settings, то есть по `settings.user_service_id`
 * (USObject.pm:558 → Base.pm:497). Читаем settings первым, колонку — как
 * запасной вариант для задач, поставленных другим кодом.
 */
export function spoolUserServiceId(row: Record<string, unknown>): number | null {
  const fromSettings = num(parseSettings(row.settings).user_service_id, Number.NaN);
  if (Number.isFinite(fromSettings)) return fromSettings;
  const fromColumn = num(row.user_service_id, Number.NaN);
  return Number.isFinite(fromColumn) ? fromColumn : null;
}

/**
 * Список из КОНВЕРТА Remnawave. После снятия `{response: ...}` клиентом
 * остаётся `{total, devices}` у GET /api/hwid/devices/{id} и `{total, records}`
 * у GET /api/users/{id}/subscription-request-history
 * (GetUserSubscriptionRequestHistoryResponseDto; та же форма разбирается в бою
 * — ai-bot/src/ai/tools.ts:87-92, ai-bot/src/operator/tickets.ts:250-257).
 * `asArray` по такому объекту дал бы ОДНУ мусорную строку, а настоящий список
 * исчез бы целиком, поэтому список берётся по имени ключа, а `total` — из
 * конверта, а не из длины отданного куска: это разные числа, и подмена первого
 * вторым превращает «показано 2 из 5 устройств» в «у клиента два устройства».
 *
 * Живёт в kit, а не рядом с одним инструментом: ту же ручку читают
 * subscription_inspect и client_overview, и приватная копия — это то, как два
 * инструмента начинают отвечать на «сколько у клиента устройств» по разным
 * правилам.
 */
export function envelope(
  value: unknown,
  key: string,
): { rows: Record<string, unknown>[]; total: number } {
  const body = asRecord(value);
  const list = Array.isArray(value) ? value : body[key];
  const rows = asArray(list).map(asRecord);
  const declared = num(body.total, Number.NaN);
  return { rows, total: Number.isFinite(declared) ? declared : rows.length };
}

/**
 * Ветки `response` строки спула, которые НЕ ДОЛЖНЫ покидать инструмент.
 * Проверено настоящим прогоном /admin/spool/history, а не по спецификации:
 *   response.request.url      https://api.telegram.org/bot<id>:<ТОКЕН>/sendMessage
 *                             — токен бота лежит В ПУТИ, то есть в ЗНАЧЕНИИ
 *                             строки, а @hq/redact маскирует по ИМЕНИ поля и
 *                             внутрь значений не смотрит вовсе;
 *   response.request.content  тело сообщения: chat_id и полный текст письма
 *                             клиенту;
 *   response.request.headers  заголовки запроса к принимающей стороне;
 *   response.response         эхо принимающей стороны: id и название чата,
 *                             имя бота, метаданные доставленного сообщения;
 *   response.server           внутренний адрес ноды (host/port).
 * Ответ spool_inspect содержал и `api.telegram.org`, и путь `/bot<цифры>:`,
 * и `chat_id`, и внутренний хост — то есть настоящий токен бота уезжал в
 * контекст модели на каждом вызове.
 *
 * Живёт в kit, а не рядом с одним инструментом, ровно по причине из этого же
 * файла: строки спула отдают наружу ДВА инструмента — spool_inspect (история)
 * и service_inspect (очередь), — и приватная копия списка означает, что второй
 * продолжит течь после того, как первый починили. Вырезается ровно это:
 * вердикт доставки, статус, длительность и сообщение остаются на месте.
 */
export const SPOOL_SECRET_BRANCHES: readonly string[] = ['request', 'response', 'server'];

export function withoutSpoolSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const response = asRecord(row.response);
  if (Object.keys(response).length === 0) return row;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(response)) {
    if (!SPOOL_SECRET_BRANCHES.includes(key)) safe[key] = value;
  }
  return { ...row, response: safe };
}

/**
 * Проверка «клиент вообще существует» — ЧЕРЕЗ filter, а не через `?user_id=`.
 *
 * Разница не косметическая, она проверена на работающей SHM 2.19.4:
 *   GET /admin/user?user_id=99999999          → ИСКЛЮЧЕНИЕ «Недоступно в данной
 *                                               версии» (сообщение по-русски,
 *                                               кода в нём нет);
 *   GET /admin/user?filter={"user_id":99999999} → 200, items: 0.
 * На существующем клиенте обе формы отдают одну и ту же строку.
 *
 * Инструмент, спрашивающий про несуществующего клиента первой формой, получает
 * не «такого клиента нет», а ОТКАЗ ИСТОЧНИКА: запись уезжает в `degraded`, а
 * наружу выходит partial_result — то есть «SHM не ответил» вместо «клиента нет».
 * Различать их по тексту ошибки нельзя: он локализован и версионен, и разбор
 * русской строки — это то, что молча перестанет работать на следующем релизе.
 *
 * ВНИМАНИЕ, ЭТО ЖЕ КАСАЕТСЯ УЖЕ НАПИСАННОГО: client_overview и
 * subscription_inspect строят свой `user_not_found` на пустом ответе
 * `?user_id=`, который в работающей установке не наступает никогда — вместо
 * него приезжает исключение. Их предупреждение сегодня не срабатывает вовсе.
 */
export function shmUserExistsParams(userId: number): ClientParams {
  return { filter: JSON.stringify({ user_id: userId }), limit: 1 };
}

/** Ответ на «есть ли такой клиент»; `exists: null` — спросить не удалось. */
export interface ClientPresence {
  exists: boolean | null;
  error: string | null;
  /**
   * Сама строка клиента, когда он нашёлся. Отдаётся потому, что запрос за ней
   * уже сделан: инструмент, которому нужна пара полей из админской карточки
   * (например, чтобы сверить её с тем, что отдаёт клиентский маршрут), иначе
   * спрашивал бы SHM второй раз о том же.
   */
  row: Record<string, unknown> | null;
}

/**
 * ПРОВЕРКА СУЩЕСТВОВАНИЯ КЛИЕНТА ПЕРЕД ЛЮБЫМ КЛИЕНТСКИМ МАРШРУТОМ.
 *
 * Клиентская часть API (`/user/*`, `/service/*`, `/promo`) переключает контекст
 * на чужого клиента параметром `?user_id=`: диспетчер зовёт `switch_user`, если
 * вызывающий админ (app/public_html/shm/v1.cgi:1686-1690). Переключение на
 * НЕСУЩЕСТВУЮЩЕГО клиента не даёт пустого ответа — оно ломает обработчик.
 * Снято с работающей SHM 2.19.4 на двух заведомо отсутствующих id (id
 * удалённого клиента, чьи применения промокодов в таблице остались, и
 * никогда не существовавший 99999999):
 *   GET /service/order?user_id=…      → HTTP 500 Internal Server Error
 *   GET /user/pay/forecast?user_id=…  → HTTP 500 Internal Server Error
 *   GET /promo?user_id=…              → HTTP 500 Internal Server Error
 *   GET /user/email?user_id=…         → «Недоступно в данной версии»
 * То есть один и тот же факт приходит то пятисоткой, то русской строкой про
 * версию, и ни один из двух не отличим от настоящей поломки бэкенда. Инструмент,
 * который этого не проверил, отвечает «SHM не ответил» там, где правда — «такого
 * клиента нет», и отправляет оператора чинить исправное.
 *
 * Спрашивается через `filter`, а не через `?user_id=` (см. shmUserExistsParams
 * выше): на админском списке вторая форма ведёт себя ровно так же плохо.
 */
export async function clientExists(shm: ShmClient, userId: number): Promise<ClientPresence> {
  const probe = await settle(
    shm.list<Record<string, unknown>>('/admin/user', shmUserExistsParams(userId)),
  );
  if (!probe.ok) return { exists: null, error: probe.error, row: null };
  const first = probe.value.data[0];
  return {
    exists: probe.value.data.length > 0,
    error: null,
    row: first === undefined ? null : asRecord(first),
  };
}

/**
 * Первая строка ответа клиентского маршрута. Такие ручки отдают ОДИН объект
 * (прогноз, статус OTP, почта), а конверт SHM всё равно кладёт его в `data`
 * массивом — `shm.get` снимает конверт и возвращает `[{...}]`.
 */
export function firstRow(value: unknown): Record<string, unknown> {
  const rows = asArray(value);
  return asRecord(rows[0]);
}

/**
 * `items` конверта на клиентских маршрутах — НЕ размер выборки.
 *
 * v1.cgi:1760 кладёт в `items` результат `found_rows()` ПОСЛЕДНЕГО выполненного
 * SELECT, а обработчик успевает сделать после своего запроса ещё несколько
 * (прогноз считает списания по каждой услуге, прайс-лист зовёт
 * was_ever_provided на каждой позиции). Замеры на работающей системе: у
 * `/user/pay/forecast` приезжало `items: 1` на клиенте с одной услугой и
 * `items: 0` на клиенте без услуг, у `/user/email` — `items: 0` при одной
 * строке в `data`, у `/service/order` — `items: 1` на семи позициях.
 * Единственные клиентские ручки, где счётчику можно верить, — списочные
 * (`/user/pay`, `/user/withdraw`, `/promo`): там последний SELECT и есть сам
 * список.
 */
export const CLIENT_ITEMS_UNRELIABLE =
  'The `items` counter of this route is the row count of the LAST SQL statement the handler ran, ' +
  'not the size of what it returned, so it is not reported here. Count the rows instead.';

/** bandwidth-stats ждёт YYYY-MM-DD, а не полный ISO (§6.17). */
export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // unref: в долгоживущем MCP-процессе висящий таймер держит event loop (§6.22).
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Единственный способ отдать список SHM наружу. `items` — это полный total из
 * FOUND_ROWS(), и терять его нельзя: §6.4 прямо говорит, что оба уже написанных
 * клиента его выбрасывают и вместе с ним теряют пагинацию. Если окно заполнено,
 * ответ несёт предупреждение с настоящим числом строк, а не молча врёт длиной
 * массива.
 */
export function listOut<T>(
  list: ShmListResult<T>,
  into: ToolWarning[],
  label: string,
): { items: number; limit: number; offset: number; data: Record<string, unknown>[] } {
  const data = list.data.map(asRecord);
  if (list.items > data.length + list.offset) {
    into.push(
      warn(
        'truncated',
        `"${label}" returned ${String(data.length)} of ${String(list.items)} rows (limit ` +
          `${String(list.limit)}, offset ${String(list.offset)}). Anything computed from this ` +
          'slice — totals, "the client has no such service", reconciliation — is about the slice, ' +
          'not about the client. Raise the limit or page before concluding.',
      ),
    );
  }
  return { items: list.items, limit: list.limit, offset: list.offset, data };
}

/**
 * Результат постраничного чтения: и строки, и то, чего в них НЕ хватает.
 * `complete: false` вместе с непустыми `rows` — законный и полезный ответ:
 * «прочитано 4 000 строк из заведомо большей выборки, начиная с самых новых»
 * лучше, чем пустота с предупреждением.
 */
export interface PagedRows {
  rows: Record<string, unknown>[];
  /** Полный размер выборки по версии сервера; null — сервер его не назвал. */
  items: number | null;
  /** Покрыт ли весь `items`. */
  complete: boolean;
  /** Ошибка, оборвавшая пагинацию; `rows` — то, что успели прочитать ДО неё. */
  error: string | null;
}

export interface RemnaUserWindow extends PagedRows {
  /** Размер страницы, который панель РЕАЛЬНО отдаёт — измеренный, не заданный. */
  pageSize: number;
}

/**
 * Максимум одного запроса SHM: клиент режет `limit` до SHM_MAX_LIMIT, поэтому
 * больше за раз не приедет никогда, и всё, что сверх — это страницы.
 *
 * Именно ИМПОРТ, а не своя копия числа. Скопированное значение расходится
 * молча и в худшую сторону: опустив потолок в клиенте, `readShmRows` продолжил
 * бы просить 500, получал бы меньше, упирался в `if (data.length < limit)
 * break` и останавливал пагинацию на первой же странице — sync_audit отвечал бы
 * частичным покрытием вместо отказа, то есть сверка врала бы, не сообщая об этом.
 */
export const SHM_PAGE_SIZE = SHM_MAX_LIMIT;

/**
 * С чего начинается измерение страницы панели. Потолок `size` у `/api/users`
 * эмпирически неизвестен: в схеме он объявлен как `{"type":"number"}` без
 * максимума, а единственное фактическое использование во всей экосистеме —
 * `size=10` в поиске (ai-bot/src/services/remnaApi.ts:198). Поэтому размер не
 * предполагается, а ПРОВЕРЯЕТСЯ: спрашиваем много, смотрим, сколько дали, и
 * дальше идём измеренным шагом. 500 — то же число, что и предел страницы SHM:
 * запрос заведомо не безумный, а если панель режет ниже, это станет видно на
 * первой же странице.
 */
export const REMNA_PROBE_PAGE_SIZE = 500;

/**
 * «Панель не приняла такой `size`» — и только это. 4xx (кроме 429) означает,
 * что запрос отвергнут по своему содержимому, то есть меньший размер имеет
 * шанс проехать. Всё остальное повторять нельзя: 5xx и таймаут (RemnaError
 * ставит на них status 0) сломаются точно так же и второй раз, 429 запрещено
 * повторять по §6.14, а BudgetExceededError вообще не несёт status — вторая
 * попытка только доела бы ведро.
 */
function isSizeRejection(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

/**
 * Постранично вычитывает пользователей панели ДО КОНЦА, а не первое окно.
 * Ответ приходит как `{users, total}` (после снятия конверта `response`), но
 * иногда — голым массивом.
 *
 * Три вещи, которые здесь нельзя делать иначе:
 *
 *  - `total` отдаётся наружу. Длина прочитанного и размер панели — разные
 *    числа, и подмена первого вторым превращает «мы посмотрели 500 из 4 000» в
 *    «в панели 500 пользователей».
 *  - Размер страницы измеряется. Если панель вернула меньше, чем просили, а
 *    `total` говорит, что строки ещё есть, — это её потолок, и дальше мы идём
 *    именно им.
 *  - Ошибка ловится ВНУТРИ цикла. Исчерпанный на N-й странице бюджет не должен
 *    стирать N-1 честно прочитанную.
 */
export async function readRemnaUserWindow(
  remna: RemnaClient,
  cap: number,
): Promise<RemnaUserWindow> {
  const rows: Record<string, unknown>[] = [];
  let total: number | null = null;
  let pageSize = REMNA_PROBE_PAGE_SIZE;
  let probed = false;
  let reachedEnd = false;

  const done = (error: string | null): RemnaUserWindow => {
    // Полнота считается по ОТДАННЫМ строкам, а не по прочитанным: последняя
    // страница может перевалить за cap, и тогда «дочитали до конца» — про то,
    // что мы выбросили, а не про то, что вернули.
    const out = rows.slice(0, cap);
    const dropped = rows.length > out.length;
    return {
      rows: out,
      items: total,
      pageSize,
      // Без `total` полноту заявить НЕЛЬЗЯ. Короткая страница у панели, которая
      // молча режет выдачу и не присылает счётчик (голый массив — форма,
      // объявленная возможной прямо здесь), выглядит ровно как конец списка, и
      // «прочитано 50 из 4 000» превратилось бы в «в панели 50 пользователей» —
      // а из него в тысячи находок «перепровижинить клиента». `reachedEnd`
      // по-прежнему решает, когда ОСТАНОВИТЬСЯ, но не что мы всё увидели.
      complete: error === null && !dropped && total !== null && out.length >= total,
      error,
    };
  };

  while (rows.length < cap) {
    const want = Math.min(pageSize, cap - rows.length);
    let page: unknown;
    try {
      page = await remna.get<unknown>('/api/users', { size: want, start: rows.length });
    } catch (error: unknown) {
      // Отказ на ПЕРВОЙ странице большого размера может означать, что панель не
      // принимает такой `size` вовсе — тогда одна повторная попытка на
      // консервативном размере §7.6 спасает весь ответ. Отказ бюджета или 429 —
      // не про размер, и повторять его запрещено (§6.14).
      if (!probed && want > REMNA_PAGE_SIZE && isSizeRejection(error)) {
        pageSize = REMNA_PAGE_SIZE;
        probed = true;
        continue;
      }
      return done(errMessage(error));
    }

    const body = asRecord(page);
    const reported = num(body.total, Number.NaN);
    if (Number.isFinite(reported)) total = reported;
    const batch = asArray(body.users ?? page).map(asRecord);
    rows.push(...batch);

    if (batch.length === 0) {
      // Пустая страница при непокрытом total — это не конец списка, а отказ
      // отдавать дальше; бесконечно спрашивать одно и то же нельзя.
      reachedEnd = total === null || rows.length >= total;
      return done(null);
    }
    if (!probed) {
      probed = true;
      const more = total !== null && rows.length < total;
      // Дали меньше, чем просили, но строки ещё есть → это потолок панели.
      if (batch.length < want && more) pageSize = batch.length;
    }
    if (total !== null ? rows.length >= total : batch.length < want) {
      reachedEnd = true;
      return done(null);
    }
    await sleep(REMNA_PAGE_PAUSE_MS);
  }
  return done(null);
}

/**
 * Постранично вычитывает списочную ручку SHM до полного покрытия `items`.
 * Существует потому, что один запрос отдаёт максимум SHM_PAGE_SIZE строк, а
 * сверять надо всю таблицу: на большой установке это десятки страниц подряд.
 *
 * `items` берётся с ПЕРВОЙ страницы и дальше не переспрашивается: это размер
 * выборки на момент начала чтения. Порядок у SHM — по ключу таблицы вниз
 * (Sql/Data.pm:279-300), то есть от самых новых строк, поэтому частичное
 * чтение — это всегда «самые новые N», а вставки во время чтения сдвигают
 * хвост, а не голову.
 *
 * Наружу отдаёт то же, что listOut требует показывать (§6.4) — полный `items`
 * и признак неполноты, — но для многостраничного чтения, где предупреждение на
 * каждой странице было бы шумом.
 */
export async function readShmRows(
  shm: ShmClient,
  path: string,
  params: ClientParams,
  cap: number,
): Promise<PagedRows> {
  const rows: Record<string, unknown>[] = [];
  let items: number | null = null;

  while (rows.length < cap) {
    const limit = Math.min(SHM_PAGE_SIZE, cap - rows.length);
    const page = await settle(
      shm.list<Record<string, unknown>>(path, { ...params, limit, offset: rows.length }),
    );
    if (!page.ok) {
      return { rows, items, complete: false, error: page.error };
    }
    if (items === null) items = page.value.items;
    const data = page.value.data.map(asRecord);
    rows.push(...data);
    // Пустая или короткая страница — конец выборки; иначе на сервере, который
    // игнорирует offset, цикл упёрся бы только в cap.
    if (data.length < limit) break;
    if (items !== null && rows.length >= items) break;
  }

  return {
    rows,
    items,
    complete: items !== null && rows.length >= items,
    error: null,
  };
}

/**
 * Адрес, у которого от значения оставлена ТОЛЬКО авторитетная часть — схема,
 * хост и порт. Всё, что после неё (путь, query, фрагмент) и всё, что до неё
 * (`user:password@`), из значения ВЫРЕЗАЕТСЯ, а не маскируется по имени.
 *
 * Причина — не гигиена, а настоящий инцидент этого проекта: @hq/redact маскирует
 * по ИМЕНИ поля и внутрь значения не смотрит вовсе, поэтому строка спула с
 * `response.request.url` вида `https://api.telegram.org/bot<id>:<ТОКЕН>/…`
 * уехала в контекст модели целиком (commit 2d4d7f3). Ровно та же форма лежит
 * в колонке `host` серверов SHM: в работающей установке заметная доля строк
 * /admin/server — это `https://api.telegram.org/bot<ТОКЕН>/sendMessage`,
 * то есть настоящий токен бота хранится В ЗНАЧЕНИИ обычного поля, у которого
 * нет ни одного «секретного» имени над ним.
 *
 * Эвристики здесь нет намеренно. Соблазн «оставить безопасно выглядящие
 * сегменты пути» (только буквы, без цифр) пропускает секретный слаг
 * (`/webhook/abcdefghij`) и ровно этим отличается от предохранителя: правило,
 * которое иногда пропускает секрет, защищает только от тех секретов, о которых
 * уже знаешь. Поэтому отброшенное считается и объявляется числом, а не
 * восстанавливается по частям.
 */
export interface SafeEndpoint {
  /** `scheme://host[:port]` или голый `host[:port]`; null — значения не было. */
  value: string | null;
  /** Сколько непустых сегментов пути вырезано. */
  droppedPathSegments: number;
  /** Была ли строка запроса/фрагмент. */
  droppedQuery: boolean;
  /** Была ли часть `user:password@` перед хостом. */
  droppedCredentials: boolean;
}

export function safeEndpoint(value: unknown): SafeEndpoint {
  const raw = str(value);
  if (raw === null) {
    return { value: null, droppedPathSegments: 0, droppedQuery: false, droppedCredentials: false };
  }
  // Схема отрезается вручную, а не через `new URL`: у `smtp.mail.ru:587`
  // конструктор URL считает схемой `smtp.mail.ru:`, а хостом — пустую строку,
  // то есть адрес почтового сервера исчез бы целиком.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)?.[0] ?? '';
  const rest = raw.slice(scheme.length);
  const queryAt = rest.search(/[?#]/);
  const beforeQuery = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const segments = beforeQuery.split('/');
  const authority = segments[0] ?? '';
  const at = authority.lastIndexOf('@');
  return {
    value: `${scheme}${at === -1 ? authority : authority.slice(at + 1)}`,
    droppedPathSegments: segments.slice(1).filter((one) => one !== '').length,
    droppedQuery: queryAt !== -1 && rest.slice(queryAt + 1) !== '',
    droppedCredentials: at !== -1,
  };
}

/** HTTP-статус ошибки клиента; null — ошибка его не несёт (таймаут, бюджет). */
export function httpStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * СЕРВЕР НАЗВАЛ ЧИСЛО — ИЛИ НЕ НАЗВАЛ. Третьего не бывает, и `envelope` этой
 * разницы не сохраняет: он подставляет `rows.length`, когда `total` в теле нет,
 * то есть «сервер молчит» становится неотличимо от «мы видим всё». На срезе из
 * одной строки это превращает «показана 1 из многих сотен привязок» в
 * «привязка одна» — ровно та ошибка, из-за которой torrent_reports разбирает
 * свой конверт руками вместо `envelope`.
 *
 * Возвращает `null` именно там, где утверждать нечего. Вызывающий обязан
 * различать: `null` — усечение непроверяемо (код `server_count_absent`), число
 * — сравнимо с `offset + returned` (код `truncated`).
 */
export function declaredTotal(value: unknown): number | null {
  const parsed = num(asRecord(value).total, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * МИНИМАЛЬНЫЕ ВЕРСИИ БЭКЕНДОВ, НА КОТОРЫХ ОБЪЯВЛЕННЫЙ НАБОР РАБОТАЕТ ЦЕЛИКОМ.
 *
 * Числа взяты не из спецификаций, а перебором тегов обоих upstream-репозиториев
 * по маршрутам, которые инструменты зовут поимённо:
 *
 *  - SHM 2.18.0 — версия, в которой в `v1.cgi` появился НЕавторизованный
 *    `/healthcheck`. Ниже неё роутер отвечает 404 «Method not found», и
 *    единственный способ отличить «SHM лежит» от «наши креды не те» пропадает.
 *    Следующая по строгости граница ниже — 2.11.3 (`/admin/user/search`, на нём
 *    стоят `client_search` и `client_resolve`), затем 2.9.0 (`/user/referrals`).
 *    Всё остальное, что зовут инструменты, живёт в SHM с 1.x.
 *  - Remnawave 3.0.0 — версия, в которой пользователь адресуется ЧИСЛОВЫМ `id`
 *    (`/api/users/{id}`), а не `uuid`; тогда же появились `/api/connections/*`,
 *    `/api/users/{id}/actions/extend` и `/api/system/stats/{digest,http}`. На
 *    2.x путь `/api/users/{числовой}` отвергается валидацией с 400, а
 *    остальные три отвечают роутерным 404.
 *
 * ЭТО ГРАНИЦА ПОЛНОТЫ, А НЕ ГРАНИЦА ЗАПУСКА. Ни один инструмент этой проверкой
 * не выключается: на более старом бэкенде вызовы отказывают ГРОМКО (роутерный
 * 404 у панели — отдельная ветка в `@hq/remna`, 404 у SHM — обычная ошибка
 * клиента), и предупреждение пробы существует затем, чтобы такой отказ читался
 * как «версия старее нужной», а не как дефект инструмента.
 */
export const MIN_SHM_VERSION = '2.18.0';
export const MIN_REMNA_VERSION = '3.0.0';

/**
 * `2.19.4-61815d24…` → `[2, 19, 4]`. Суффикс после дефиса отбрасывается: SHM
 * дописывает в строку `_shm.version` полный commit sha, и сравнивать его
 * бессмысленно. Всё, что не начинается с `X.Y.Z`, — `null`, и это НЕ «версия
 * старая»: вызывающий обязан отличать «прочитали и оно ниже» от «прочитать не
 * удалось».
 */
export function parseVersion(raw: string | null): readonly [number, number, number] | null {
  if (raw === null) return null;
  const found = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (found === null) return null;
  const parts = [found[1], found[2], found[3]].map((one) => Number(one));
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return [major, minor, patch] as const;
}

/**
 * Ниже ли прочитанная версия минимальной. `'unknown'` — строку разобрать не
 * удалось (бэкенд не ответил, поле пустое, формат чужой); утверждать про такую
 * установку нечего, и молчаливое `false` здесь означало бы «всё в порядке»,
 * не проверив ничего.
 */
export function versionBelow(detected: string | null, minimum: string): boolean | 'unknown' {
  const left = parseVersion(detected);
  const right = parseVersion(minimum);
  if (left === null || right === null) return 'unknown';
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}
