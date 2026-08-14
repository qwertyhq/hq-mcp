import { REMNA_VARIABLES } from '@hq/env';
import { redact } from '@hq/redact';
import { assertNotForbidden } from '@hq/registry';
import { BackendNotConfiguredError } from '@hq/types';
import type { Budget } from '@hq/budget';
import type { HqMcpConfig } from '@hq/env';
import type { Profile, RemnaClient } from '@hq/types';

export {
  buildTopology,
  forecastOrphans,
  hostsWithUnknownInbound,
  inboundsActiveWithoutHost,
  inboundsPublishedOnlyByDisabledHosts,
} from './topology.js';
export type {
  DarkInbound,
  HostGap,
  InboundGap,
  OrphanForecast,
  Topology,
  TopologyHost,
  TopologyInbound,
  TopologyNode,
  TopologyProfile,
  TopologyRows,
} from './topology.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Ручки, отвечающие ОБЪЕКТОМ на найденного и 404 на отсутствующего. Только на
 * них 404 — это ответ панели «нет такого пользователя», а не сбой: трактовать
 * его как ошибку значило бы повторить ошибку support-бота из дизайна — пять
 * минут отрицать живого клиента, потому что 404 читался как «панель
 * недоступна».
 *
 * Список выверен на работающей панели 3.2.3, а не по спецификации. Того, что
 * было здесь на 2.8, больше нет: by-telegram-id, by-email и by-tag УДАЛЕНЫ из
 * API целиком, и их 404 теперь означает «такого маршрута нет», а не «такого
 * юзера нет». Их замена — GET /api/users/stream с точными фильтрами
 * (telegramId/email/tag), который отвечает 200 и пустым `users`.
 *
 * Ограничено GET: те же пути используют мутации плана 2 (PATCH/DELETE по id),
 * и там 404 обязан остаться ошибкой, а не тихим «успехом».
 */
const NOT_FOUND_ON_404 = /^\/api\/users\/(by-username|by-short-uuid)\//;

/**
 * Идентификатор пользователя в 3.x — ЧИСЛО (`id`), а не uuid: поля `uuid` у
 * объекта пользователя больше нет вовсе, а параметр пути объявлен как
 * `userId: number`. uuid, поданный сюда, панель отвергает на валидации (400
 * «Validation failed», path ["userId"]) — то есть смягчать здесь нечего, и
 * протухший uuid обязан быть громкой ошибкой, а не чистым «отсутствует».
 */
const USER_ID_PATH_RE = /^\/api\/users\/\d+$/;

function isSingleUserObjectPath(path: string): boolean {
  return NOT_FOUND_ON_404.test(path) || USER_ID_PATH_RE.test(path);
}

/**
 * Отличает 404 МАРШРУТИЗАТОРА от 404 ПРИЛОЖЕНИЯ — единственное, что позволяет
 * не соврать про удалённую ручку. Тела сняты с работающей панели 3.2.3:
 *
 *   маршрута нет: {"message":"Cannot GET /api/users/by-telegram-id/…",
 *                  "error":"Not Found","statusCode":404}
 *   юзера нет:    {"timestamp":…,"path":…,
 *                  "message":"User with specified params not found",
 *                  "errorCode":"A063"}
 *
 * Приложение всегда подписывается `errorCode`, роутер Nest — никогда. Правило
 * поэтому такое: 404 читается как ответ «нет такого пользователя», только если
 * тело несёт `errorCode`. Всё остальное — включая молчаливый роутерный 404 —
 * это НАШ дефект: мы позвали маршрут, которого на этой версии панели нет, и
 * узнать об этом надо от исключения, а не из пустого списка совпадений.
 * Направление ошибки выбрано осознанно: незнакомая форма тела делает ответ
 * громким, а не тихим.
 */
function isApplicationNotFound(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) && typeof parsed.errorCode === 'string';
  } catch {
    return false;
  }
}

export class RemnaError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RemnaError';
    this.status = status;
  }
}

export interface RemnaClientDeps {
  budget: Budget;
  /** ОБЯЗАТЕЛЕН: §7.2 не должна отключаться забытым параметром. */
  profile: Profile;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Params = Record<string, string | number | undefined>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Снимает конверт `{response: ...}` ровно один раз. */
export function unwrapRemna(body: unknown): unknown {
  if (isPlainObject(body) && 'response' in body) return body.response;
  return body;
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Тот же подход, что и normalizeSegment в @hq/shm (Task 7): схлопывает id
 * внутри ОДНОГО сегмента пути в плейсхолдер, чтобы бюджет копился по низко-
 * кардинальному ключу «метод + шаблон пути», а не заводил новое ведро на
 * каждый конкретный uuid/id — Budget (Task 4) чистит ведро только pull-based,
 * без таймера, и per-request-ключ рос бы Map-ом без границ на долгоживущем
 * сервере. Оба клиента (SHM и Remnawave) обязаны схлопывать одинаково.
 */
function normalizeSegment(segment: string): string {
  if (segment === '') return segment;
  if (UUID_SEGMENT_RE.test(segment)) return ':uuid';
  if (/^\d+$/.test(segment)) return ':id';
  return segment.replace(/\d+/g, '*');
}

function budgetKey(method: string, path: string): string {
  const template = path.split('/').map(normalizeSegment).join('/');
  return `remna:${method}:${template}`;
}

function errorMessage(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) {
      const message = parsed.message ?? parsed.error;
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    /* тело не JSON */
  }
  return text === '' ? `HTTP ${status}` : `HTTP ${status}: ${text.slice(0, 200)}`;
}

/**
 * Поля Remnawave, чьи ИМЕНА сталкиваются с правилом маскирования @hq/redact,
 * хотя секретами не являются. Ключ — имя из ответа панели, значение — имя, под
 * которым поле уезжает наружу. Прямой аналог `SHM_SAFE_RENAMES` в @hq/shm и
 * существует по той же причине.
 *
 * `SECRET_KEY_RE` (/token|secret|key|password|auth/i) проверяется по ИМЕНИ
 * поля, и слово `key` матчится буквально. `showConnectionKeys` в конфиге
 * страницы подписки — БУЛЕВ ПЕРЕКЛЮЧАТЕЛЬ «показывать ли клиенту готовые
 * ключи подключения», а не ключ. Приезжал он '<redacted>' (проверено прогоном
 * на работающей панели 3.2.3, а не по спецификации), то есть единственный ответ
 * на вопрос «раздаёт ли страница подписки готовые конфиги» был нечитаем.
 *
 * ПОЧЕМУ ЭТО НЕЛЬЗЯ ПОЧИНИТЬ В ИНСТРУМЕНТЕ: клиент редактирует тело раньше,
 * чем его увидит хендлер, — переименование на выходе меняет имя у уже
 * потерянного значения. Ровно тот же вывод, что был сделан по `uniq_key`.
 *
 * Список закрытый и расширяется по одному имени с разбором: каждая строка
 * здесь — поле, которое ПЕРЕСТАЁТ маскироваться. Соседние `privateKey`,
 * `trojanPassword` и `vlessUuid` не переименованы и не будут — они
 * маскируются по делу, и правило редакции остаётся ровно таким же тупым.
 */
export const REMNA_SAFE_RENAMES: Readonly<Record<string, string>> = {
  showConnectionKeys: 'showConnectionCreds',
};

/**
 * Обход написан на `typeof` / `Array.isArray` / `Object.entries`: результат
 * может прийти из `JSON.parse`, где буквальный ключ `__proto__` — обычные
 * данные, поэтому выходной объект строится через `Object.create(null)`, как и
 * в @hq/redact.
 */
export function renameSafeRemnaKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(renameSafeRemnaKeys);
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[REMNA_SAFE_RENAMES[key] ?? key] = renameSafeRemnaKeys(item);
  }
  return out;
}

/**
 * Клиент панели для развёртывания, в котором панели НЕТ. Тот же довод, что у
 * `createUnconfiguredShmClient`: отказ, а не пустой ответ.
 */
export function createUnconfiguredRemnaClient(): RemnaClient {
  /** Отклонённое обещание, а не бросок — см. createUnconfiguredShmClient. */
  const refuse = (): Promise<never> =>
    Promise.reject(new BackendNotConfiguredError('remna', REMNA_VARIABLES));
  return { get: refuse, send: refuse, getRaw: refuse, sendRaw: refuse };
}

export function createRemnaClient(
  cfg: NonNullable<HqMcpConfig['remna']>,
  deps: RemnaClientDeps,
): RemnaClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  const clean = (value: unknown): unknown => redact(renameSafeRemnaKeys(value), deps.profile);

  async function raw(
    method: string,
    path: string,
    opts: { params?: Params; body?: unknown } = {},
  ): Promise<unknown> {
    // §8: запрещённые маршруты панели не выполняются ни одним методом и ни
    // одним каналом (включая getRaw/sendRaw) — метод передаём явно, иначе
    // method-scoped правила реестра (напр. restart-all) молча выключаются.
    assertNotForbidden(path, method);
    const key = budgetKey(method, path);
    deps.budget.take(key);

    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(opts.params ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemnaError(`Remnawave request ${method} ${path} failed: ${message}`, 0);
    }

    const text = await response.text();

    // ПОРЯДОК ВАЖЕН: 429 проверяется до любой эвристики по форме тела —
    // иначе на by-telegram-id/email/tag 429 без тела совпал бы с
    // «пустой ответ = не найден» и budget.note429 никогда бы не вызвался.
    if (response.status === 429) {
      deps.budget.note429(key);
      throw new RemnaError(
        `Remnawave rate limit (429) on ${method} ${path} — the request is refused, not repeated.`,
        429,
      );
    }

    if (response.status === 404 && !isApplicationNotFound(text)) {
      // Маршрута НЕТ. На 2.8 этот же статус на by-telegram-id означал «нет
      // такого юзера», и клиент отдавал пустой список — после сноса ручек в
      // 3.x то же самое стало уверенной ложью: client_resolve на существующем
      // telegram id возвращал `matches: []` без единого предупреждения.
      // Отсутствующий маршрут — дефект В НАС, а не ответ панели, и ошибка
      // здесь обязана быть громкой.
      // Ответ панели — ПОСЛЕДНИМ. Страховочная стрижка исполнителя режет от
      // маркера `HTTP <код>: ` и до конца строки (packages/exec/src/index.ts),
      // а errorMessage на нераспознанном теле (HTML-страница прокси, например)
      // отдаёт ровно такой маркер. Стоя в середине, он уносил с собой всё
      // написанное после — включая единственное предложение, ради которого это
      // сообщение существует: «это роутерный 404, не читайте его как
      // отсутствующего клиента».
      throw new RemnaError(
        `Remnawave ${method} ${path}: this route does not exist on this panel. The panel ` +
          'answered its router 404, not "no such user" — hq-mcp is calling a route this ' +
          'Remnawave version removed. Do not read this as an absent client: check the live API ' +
          `before changing the caller. The panel said: ${errorMessage(text, response.status)}`,
        404,
      );
    }

    if (response.status === 404 && method === 'GET' && isSingleUserObjectPath(path)) {
      // Приложение ответило «нет такого пользователя» (errorCode A063). Это
      // сам ответ панели, а не признак сбоя.
      return null;
    }

    if (!response.ok) {
      throw new RemnaError(
        `Remnawave ${method} ${path}: ${errorMessage(text, response.status)}`,
        response.status,
      );
    }

    if (text.trim() === '') return undefined;

    try {
      return unwrapRemna(JSON.parse(text) as unknown);
    } catch {
      throw new RemnaError(
        `Remnawave ${method} ${path} returned a non-JSON body: ${text.slice(0, 200)}`,
        response.status,
      );
    }
  }

  return {
    async get<T>(path: string, params?: Params): Promise<T> {
      const body = await raw('GET', path, params === undefined ? {} : { params });
      return clean(body) as T;
    },

    async send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
      const response = await raw(method, path, body === undefined ? {} : { body });
      return clean(response) as T;
    },

    /**
     * НЕредактированное чтение — только для read-merge-write (host_edit плана 2
     * строит тело PATCH из этого значения, не из get()) и снапшота отката.
     * Все остальные защиты (forbidden, budget, 429, envelope) те же — здесь
     * меняется только редакция. Результат никогда не должен попасть в ответ
     * инструмента MCP: он несёт живые креды (trojanPassword/ssPassword/
     * vlessUuid) и рабочие ссылки (subscriptionUrl/links/ssConfLinks).
     */
    async getRaw<T>(path: string, params?: Params): Promise<T> {
      return (await raw('GET', path, params === undefined ? {} : { params })) as T;
    },

    /**
     * НЕредактированная запись — тем же правилом, что и getRaw. rollback.body
     * плана 2 обязан строиться отсюда: маскированная строка, уехавшая в
     * PATCH панели, стала бы живой аварией, а не редакцией.
     */
    async sendRaw<T>(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<T> {
      return (await raw(method, path, body === undefined ? {} : { body })) as T;
    },
  };
}
