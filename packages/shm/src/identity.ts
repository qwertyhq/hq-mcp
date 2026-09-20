import type { ShmClient, ToolContext } from '@hq/types';

/**
 * ГДЕ У ЭТОЙ SHM ЛЕЖАТ ЛОГИН, ПОЧТА, ТЕЛЕФОН И ПРИВЯЗКА TELEGRAM.
 *
 * До 3.0 ответ был «в строке клиента»: `users.login`, `users.login2` (туда же
 * писалась почта, а на телеграм-регистрации — строка вида `@<id>`),
 * `users.phone`, `users.settings.email`, `users.settings.telegram`. С 3.0
 * ответ другой: всё это переехало в отдельную таблицу `accounts`
 * (PK `login,type`, типы `login`/`email`/`phone`/`telegram`,
 * app/bin/migrations/3.0.0.sql и 3.0.38.sql), у строки клиента больше нет ни
 * `login2`, ни `phone` в `structure` (app/lib/Core/User.pm), а
 * `settings.email`/`settings.email_verified` миграция ВЫЧИЩАЕТ.
 *
 * ПОЧЕМУ ЗДЕСЬ ДВЕ СХЕМЫ, А НЕ ОДНА НОВАЯ. Сервер не перезапускается ровно в
 * момент миграции: один и тот же процесс обслуживает запросы и до неё, и
 * после. Инструмент, зашитый под любую из двух схем, в этот момент молча
 * отвечает «почты нет» — не отказом, а пустым полем, которое читается как
 * факт о клиенте. Поэтому схема определяется у самой SHM, а не задаётся
 * конфигом.
 *
 * ЧЕМ ОПРЕДЕЛЯЕТСЯ. Маршрутом `/admin/user/accounts` (v1.cgi 3.0.43,
 * controller `Core::User::Logins`): до 3.0 его в роутере нет вовсе, и SHM
 * отвечает собственным 404 `{"error":"Method not found","status":404}` — тем
 * же, которым она отвечает на любой несуществующий путь. 404 → схема старая;
 * 200 → новая; что угодно ещё (403, таймаут, 500) → НЕИЗВЕСТНО, и это третий
 * исход, а не «старая»: молчаливое «старая» на отвалившемся бэкенде вернуло бы
 * ровно ту тихую поломку, ради которой всё это написано.
 */
export const ACCOUNTS_PATH = '/admin/user/accounts';

export type IdentitySchema = 'accounts' | 'legacy' | 'unknown';

/** Типы строк `accounts`; всё незнакомое — `other`, а не выброшено. */
export type AccountKind = 'login' | 'email' | 'phone' | 'telegram' | 'other';

const KNOWN_KINDS: readonly AccountKind[] = ['login', 'email', 'phone', 'telegram'];

/**
 * Строка `accounts`, разложенная ПО ИМЕНАМ ПОЛЕЙ, КОТОРЫЕ ПОНИМАЕТ @hq/redact.
 *
 * Это не косметика, а единственное место, где чинится реальная утечка. В базе
 * 3.0 почта и телефон клиента лежат в колонке, которая называется `login`, —
 * а маскирование PII в @hq/redact идёт ПО ИМЕНИ ПОЛЯ (`email`, `phone`,
 * `login2`, `full_name`; packages/redact/src/index.ts). Отдай мы строку как
 * есть, профиль `bot` получил бы почту и телефон клиента открытым текстом:
 * имя `login` под правило не попадает и попасть не должно — под ним же ездит
 * безобидный `users.login`, который печатают все клиентские инструменты.
 *
 * Поэтому значение раскладывается по трём полям, из которых заполнено ровно
 * одно: `email` для type='email', `phone` для type='phone', `login` для
 * остальных. Маскирование после этого работает само собой, а не по списку
 * исключений, который однажды забудут дополнить.
 *
 * `settings` наружу не отдаётся вовсе: у строки типа `login` там лежит
 * `password.hash` (app/lib/Core/User/Logins.pm, `set_password`). Из него
 * берётся ровно один флаг — `email.verified`.
 */
export interface ShmAccount {
  kind: AccountKind;
  /** `accounts.type` как есть — чтобы незнакомый тип было видно, а не только «other». */
  type: string;
  user_id: number;
  /** Заполнено для kind !== 'email' | 'phone'. Для 'telegram' — id телеграма строкой. */
  login: string | null;
  email: string | null;
  phone: string | null;
  /** Для 'telegram' — тот же login числом; иначе null. */
  telegram_id: number | null;
  /** Только для kind='email': `settings.email.verified`. */
  verified: boolean | null;
  /** `primary` из ответа SHM: совпадает ли логин с `users.login`. */
  primary: boolean | null;
}

export interface AccountsLookup {
  schema: IdentitySchema;
  accounts: ShmAccount[];
  /** Текст отказа, когда схему установить не удалось; иначе null. */
  error: string | null;
}

/**
 * TTL вердикта «маршрута нет». Пять минут, как у naming, здесь были бы ошибкой:
 * это факт не о деплое, а о СХЕМЕ БАЗЫ, и меняется он посреди жизни процесса —
 * ровно в момент, когда накатывают миграцию. Минута — это верхняя граница
 * окна, в котором инструменты ещё отвечают по старой схеме после перехода.
 */
const SCHEMA_TTL_MS = 60 * 1000;

let schemaCache: { at: number; value: IdentitySchema } | null = null;

/** Только для тестов и для ручного сброса после миграции. */
export function resetIdentitySchemaCache(): void {
  schemaCache = null;
}

function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function flag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0' && value !== 'false';
  return null;
}

/**
 * `settings` строки accounts приезжает то объектом, то JSON-строкой — та же
 * разнородность, что у `users.settings`.
 */
function settingsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

export function normalizeAccount(row: Record<string, unknown>): ShmAccount {
  const rawType = text(row.type) ?? 'login';
  const kind: AccountKind = (KNOWN_KINDS as readonly string[]).includes(rawType)
    ? (rawType as AccountKind)
    : 'other';
  const login = text(row.login);
  const userId = Number(row.user_id);
  const settings = settingsOf(row.settings);
  const telegramId = kind === 'telegram' && login !== null ? Number(login) : Number.NaN;
  return {
    kind,
    type: rawType,
    user_id: Number.isFinite(userId) ? userId : 0,
    login: kind === 'email' || kind === 'phone' ? null : login,
    email: kind === 'email' ? login : null,
    phone: kind === 'phone' ? login : null,
    telegram_id: Number.isFinite(telegramId) ? telegramId : null,
    verified: kind === 'email' ? (flag(asRecord(settings.email).verified) ?? false) : null,
    primary: flag(row.primary),
  };
}

/**
 * ЗАПРОС К `accounts` ВСЕГДА СУЖЕН, И ЭТО ПРОВЕРЯЕТСЯ ЗДЕСЬ, А НЕ В ГОЛОВЕ
 * ВЫЗЫВАЮЩЕГО. Голый `GET /admin/user/accounts` — это выгрузка логинов, почт и
 * телефонов ВСЕЙ базы одной страницей; ни один сценарий поддержки такого не
 * требует, а стоимость ошибки здесь — вся PII установки разом.
 */
export type AccountsQuery = { login: string } | { user_id: number };

function narrow(query: AccountsQuery): Record<string, string | number> {
  if ('login' in query) {
    const login = query.login.trim();
    if (login === '') throw new Error('accounts lookup: empty login');
    // `login` — ключ таблицы `accounts` (structure, key => 1), а
    // Sql::Data::list_for_api кладёт ключ таблицы прямо в WHERE
    // (Data.pm: `$args{where}->{$table_key} = $args{$table_key}`), то есть это
    // ТОЧНОЕ совпадение, а не подстрока. `?user_id=` здесь не годится по общей
    // для всей SHM причине: диспетчер зовёт switch_user на любом админском
    // запросе с этим параметром, и на несуществующем клиенте ломает обработчик.
    return { login: login.toLowerCase(), limit: 25 };
  }
  if (!Number.isFinite(query.user_id) || query.user_id <= 0) {
    throw new Error('accounts lookup: user_id must be a positive number');
  }
  return { filter: JSON.stringify({ user_id: query.user_id }), limit: 25 };
}

/**
 * Читает `accounts` и ЗАОДНО отвечает, существует ли эта таблица вообще.
 *
 * Два ответа одним запросом — не экономия, а единственный способ не соврать:
 * отдельная «проба схемы» и последующее чтение могли бы прийтись на разные
 * стороны миграции.
 */
export async function lookupAccounts(
  shm: ShmClient,
  query: AccountsQuery,
  now: () => Date,
): Promise<AccountsLookup> {
  // ВНЕ try: незауженный запрос — это дефект вызывающего, и он обязан упасть
  // громко. Внутри try он превратился бы в `schema: 'unknown'`, то есть в
  // мягкую деградацию, неотличимую от отказа SHM.
  const params = narrow(query);

  const cached = schemaCache;
  const nowMs = now().getTime();
  if (cached !== null && cached.value === 'legacy' && nowMs - cached.at < SCHEMA_TTL_MS) {
    return { schema: 'legacy', accounts: [], error: null };
  }

  try {
    const page = await shm.list<Record<string, unknown>>(ACCOUNTS_PATH, params);
    schemaCache = { at: nowMs, value: 'accounts' };
    return {
      schema: 'accounts',
      accounts: page.data.map((row) => normalizeAccount(asRecord(row))),
      error: null,
    };
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    // Роутерный 404 SHM — «такого маршрута нет», то есть версия ниже 3.0.
    // Любой другой отказ схему НЕ устанавливает.
    if (statusOf(caught) === 404) {
      schemaCache = { at: nowMs, value: 'legacy' };
      return { schema: 'legacy', accounts: [], error: null };
    }
    return { schema: 'unknown', accounts: [], error: message };
  }
}

/** То же самое от ToolContext — форма, которой пользуются инструменты. */
export function lookupAccountsFor(ctx: ToolContext, query: AccountsQuery): Promise<AccountsLookup> {
  return lookupAccounts(ctx.shm, query, ctx.now);
}

/**
 * ЕСТЬ ЛИ В ЭТОЙ СТРОКЕ КЛИЕНТА СТАРЫЕ КОЛОНКИ. Дешёвый ответ по данным,
 * которые уже в руках: `login2` объявлен в `Core::User::structure` до 3.0 и
 * снят в 3.0, а `list_for_api` отдаёт ровно поля структуры — значит ключ либо
 * есть (пусть и с null), либо его нет вовсе. Отсутствие ключа само по себе НЕ
 * доказывает новую схему (строка могла приехать урезанной), поэтому
 * возвращается `'legacy' | 'unknown'`, а не `'legacy' | 'accounts'`.
 */
export function identitySchemaOfRow(row: Record<string, unknown>): 'legacy' | 'unknown' {
  return 'login2' in row ? 'legacy' : 'unknown';
}

/** Почта клиента из его accounts: подтверждённая — раньше неподтверждённой. */
export function emailOfAccounts(accounts: readonly ShmAccount[]): string | null {
  const emails = accounts.filter((one) => one.kind === 'email' && one.email !== null);
  const verified = emails.find((one) => one.verified === true);
  const primary = emails.find((one) => one.primary === true);
  return (verified ?? primary ?? emails[0])?.email ?? null;
}

export function telegramIdOfAccounts(accounts: readonly ShmAccount[]): number | null {
  return accounts.find((one) => one.kind === 'telegram' && one.telegram_id !== null)?.telegram_id ?? null;
}

export function phonesOfAccounts(accounts: readonly ShmAccount[]): string[] {
  return accounts
    .filter((one) => one.kind === 'phone' && one.phone !== null)
    .map((one) => one.phone as string);
}
