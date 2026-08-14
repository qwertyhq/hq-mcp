import { SHM_VARIABLES } from '@hq/env';
import { redact } from '@hq/redact';
import { MUTATING_GET_PATHS, assertNotForbidden } from '@hq/registry';
import { BackendNotConfiguredError } from '@hq/types';
import type { Budget } from '@hq/budget';
import type { HqMcpConfig } from '@hq/env';
import type { Profile, ShmClient, ShmListResult } from '@hq/types';
import {
  ShmError,
  buildBasicAuth,
  dataTruthyGuard,
  isHtmlBody,
  isRetryableStatus,
  renameSafeShmKeys,
  toShmListResult,
  unwrapShm,
} from './parse.js';

export const SHM_MAX_LIMIT = 500;
const DEFAULT_LIMIT = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ShmClientDeps {
  budget: Budget;
  /** ОБЯЗАТЕЛЕН: без него §7.2 отключается забытым параметром. */
  profile: Profile;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxLimit?: number;
}

type Params = Record<string, string | number | undefined>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Схлопывает id внутри ОДНОГО сегмента пути в плейсхолдер (Budget копится
 * pull-based без таймера, см. carry-forward Task 4 — ключ per-user/per-request
 * растит Map без границ на долгоживущем сервере):
 * - сегмент целиком из цифр → ':id' ('/admin/user/123' → '/admin/user/:id');
 * - сегмент — UUID → ':uuid';
 * - иначе цифровые куски ВНУТРИ буквенно-цифрового сегмента схлопываются в
 *   '*' ('vpn_mrzb_1' и 'vpn_mrzb_999999' → 'vpn_mrzb_*'), а не только целиком
 *   цифровые сегменты — иначе id, приклеенный к статичному префиксу
 *   ('/admin/storage/manage/vpn_mrzb_{id}'), ускользает от схлопывания.
 * Сегменты без единой цифры (например 'service' и 'search') не трогаются —
 * разные ручки обязаны остаться разными ключами.
 */
function normalizeSegment(segment: string): string {
  if (segment === '') return segment;
  if (UUID_SEGMENT_RE.test(segment)) return ':uuid';
  if (/^\d+$/.test(segment)) return ':id';
  return segment.replace(/\d+/g, '*');
}

/** Ключ ведра: конкретные id схлопываются, иначе на каждый вызов рождается новый счётчик. */
function budgetKey(method: string, path: string): string {
  const template = path.split('/').map(normalizeSegment).join('/');
  return `shm:${method}:${template}`;
}

function errorMessage(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) {
      const message = parsed.error ?? parsed.message;
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    /* тело не JSON — покажем его усечённым */
  }
  return text === '' ? `HTTP ${status}` : `HTTP ${status}: ${text.slice(0, 200)}`;
}

/**
 * Клиент SHM для развёртывания, в котором SHM НЕТ.
 *
 * Не «пустой» и не «всегда возвращает []»: инструмент, дотянувшийся сюда, обязан
 * упасть с внятным отказом, а не отчитаться «ничего не найдено». В штатном
 * порядке сюда не приходит никто — инструменты, объявившие `backends: ['shm']`,
 * в реестр не попадают вовсе, — и это вторая линия ровно на случай, когда
 * объявление разошлось с кодом.
 */
export function createUnconfiguredShmClient(): ShmClient {
  /**
   * ОТКЛОНЁННОЕ ОБЕЩАНИЕ, А НЕ СИНХРОННЫЙ БРОСОК. Инструменты оборачивают вызовы
   * в `settle(ctx.shm.get(...))` — там ловится ОТКАЗ ПРОМИСА, а бросок из самого
   * `get` случился бы ДО settle и вынес бы весь Promise.all наружу, положив
   * инструмент целиком вместо мягкой деградации одной половины ответа.
   */
  const refuse = (): Promise<never> =>
    Promise.reject(new BackendNotConfiguredError('shm', SHM_VARIABLES));
  return {
    get: refuse,
    list: refuse,
    action: refuse,
    getRaw: refuse,
    sendRaw: refuse,
  };
}

export function createShmClient(
  cfg: NonNullable<HqMcpConfig['shm']>,
  deps: ShmClientDeps,
): ShmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLimit = deps.maxLimit ?? SHM_MAX_LIMIT;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const authHeader = buildBasicAuth(cfg.auth);

  // Переименование ИДЁТ ПЕРВЫМ и только здесь: redact маскирует по имени поля,
  // а имена вроде `uniq_key` секретами не являются (см. SHM_SAFE_RENAMES).
  // После redact чинить нечего — там уже маркер.
  const clean = (value: unknown): unknown => redact(renameSafeShmKeys(value), deps.profile);

  async function raw(
    method: string,
    path: string,
    opts: { params?: Params; body?: unknown } = {},
  ): Promise<unknown> {
    // §8: запрещённые операции не выполняются вообще. Метод передаётся
    // явно — часть правил (PUT /admin/spool, DELETE /admin/user/pay, ...)
    // сужена до конкретных методов именно затем, чтобы GET на тот же путь
    // остался открыт; без метода matchForbidden в @hq/registry никогда не
    // совпадёт ни с одним таким правилом, и мутирующий вызов проехал бы.
    assertNotForbidden(path, method);
    // §6.15: часть GET мутирует. Классифицируем по имени ручки, а не по методу;
    // такой вызов должен приходить только через явный мутатор плана 2.
    if (method === 'GET' && MUTATING_GET_PATHS.some((bad) => path.startsWith(bad))) {
      throw new ShmError(
        `GET ${path} actually mutates state. Depending on the route that means granting a promo, ` +
          'executing a template with full write access to billing, minting a session, storing a ' +
          "WebAuthn challenge — or, on the password-reset route, changing the client's password " +
          'outright. It is refused here on purpose: risk is classified by the route name, never ' +
          'by the HTTP method.',
        400,
        false,
      );
    }
    const key = budgetKey(method, path);
    deps.budget.take(key);

    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(opts.params ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authHeader !== '') headers.Authorization = authHeader;

    let payload: string | undefined;
    if (method !== 'GET') {
      // Content-Type обязателен: без него SHM теряет query-параметры у POST.
      // Плюс параметры дублируются в тело — часть роутов читает только его.
      // ПОРЯДОК ВАЖЕН: сперва тело, потом query поверх него. Core/Utils.pm:262
      // (parse_args) заканчивается `return %in, get_uri_args()` — query-строка
      // мержится ПОСЛЕДНЕЙ и на коллизии ключа побеждает именно она, а не тело.
      const merged: Record<string, unknown> = {};
      if (isPlainObject(opts.body)) Object.assign(merged, opts.body);
      for (const [name, value] of Object.entries(opts.params ?? {})) {
        if (value !== undefined) merged[name] = value;
      }
      payload = JSON.stringify(isPlainObject(opts.body) || opts.params !== undefined ? merged : (opts.body ?? {}));
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
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new ShmError(`SHM request ${method} ${path} failed: ${message}`, 0, timedOut);
    }

    const text = await response.text();

    // ПОРЯДОК ВАЖЕН: статус проверяется до формы тела. SHM охотно отдаёт HTML
    // (§6.20), и 429 HTML-страницей при обратном порядке стал бы «403, нет
    // прав» — тогда note429 не вызывается и защита §6.14 не срабатывает.
    if (response.status === 429) {
      deps.budget.note429(key);
      throw new ShmError(
        `SHM rate limit (429) on ${method} ${path}. The bucket is keyed by source IP and shared ` +
          'by the whole service, and it does not decay — the request is refused, not repeated.',
        429,
        false,
      );
    }

    if (isHtmlBody(text)) {
      throw new ShmError(
        `SHM answered ${method} ${path} with an HTML page instead of JSON — the admin ` +
          'credentials do not have rights for this route',
        403,
        false,
      );
    }

    if (!response.ok) {
      throw new ShmError(
        `SHM ${method} ${path}: ${errorMessage(text, response.status)}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    if (text.trim() === '') return undefined;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ShmError(
        `SHM ${method} ${path} returned a non-JSON body: ${text.slice(0, 200)}`,
        response.status,
        false,
      );
    }
  }

  return {
    async get<T>(path: string, params?: Params): Promise<T> {
      const body = await raw('GET', path, params === undefined ? {} : { params });
      return clean(unwrapShm(body)) as T;
    },

    async list<T>(path: string, params?: Params): Promise<ShmListResult<T>> {
      const requested = params?.limit;
      if (requested !== undefined && Number(requested) <= 0) {
        throw new ShmError(
          `limit=${String(requested)} is refused: for an admin SHM treats limit=0 as "no LIMIT" ` +
            'and dumps the whole table. Ask for an explicit positive limit.',
          400,
          false,
        );
      }
      const limit = Math.min(Number(requested ?? DEFAULT_LIMIT), maxLimit);
      const offset = Number(params?.offset ?? 0);
      const body = await raw('GET', path, { params: { ...params, limit, offset } });
      return toShmListResult<T>(clean(body), limit, offset);
    },

    async action<T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: Params,
    ): Promise<T> {
      const response = await raw(method, path, {
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
      });
      return clean(dataTruthyGuard(response)) as T;
    },

    /**
     * НЕредактированное чтение — только для read-merge-write и снапшота отката.
     * Все остальные защиты (форбидден, мутирующие GET, бюджет, HTML, 429) те же:
     * «raw» здесь про редакцию, а не про отсутствие правил.
     *
     * ВАЖНО: результат этого метода никогда не должен попасть в ответ
     * инструмента MCP — он содержит нередактированные креды и PII. Вызывающий
     * обязан либо смержить его с уже отредактированным значением и передать
     * дальше только смердженное поле для записи, либо использовать его только
     * как снапшот для отката (план 2), но не как то, что уходит в ответ модели.
     */
    async getRaw<T>(path: string, params?: Params): Promise<T> {
      const body = await raw('GET', path, params === undefined ? {} : { params });
      return unwrapShm(body) as T;
    },

    /**
     * НЕредактированная запись — тем же правилом, что и getRaw: результат не
     * попадает в ответ инструмента.
     */
    async sendRaw<T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: Params,
    ): Promise<T> {
      const response = await raw(method, path, {
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
      });
      return dataTruthyGuard(response) as T;
    },
  };
}
