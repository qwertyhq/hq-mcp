import { buildBasicAuth } from '@hq/shm';
import { safeUrlLabel } from './mask.js';

/**
 * ЗАЧЕМ ПРОВЕРЯТЬ ПРЯМО ПРИ ВВОДЕ.
 *
 * Неверный пароль, записанный в `.env`, не мешает серверу подняться: MCP-клиент
 * стартует его молча, инструменты появляются в списке, и узнаёт человек об
 * ошибке при первом вопросе про клиента — в виде «инструмент вернул ошибку»,
 * посреди чужой задачи, без единого намёка, что чинить надо конфиг. Поэтому
 * каждый креденшл проверяется живым запросом до перехода к следующему вопросу.
 */

export type CheckStatus =
  /** Ответил, авторизовал, форма ответа та, которую ждёт клиент. */
  | 'ok'
  /** До сервера не доехали вовсе: DNS, TCP, TLS, таймаут. */
  | 'unreachable'
  /** Сервер ответил и отказал в доступе: 401/403. */
  | 'rejected'
  /** Сервер ответил, но по этому адресу не тот API: 404, редирект, HTML. */
  | 'wrong_endpoint'
  /**
   * Ответ есть, но он не доказывает НИ ОДНОГО из трёх выводов выше: 5xx, 429,
   * незнакомая форма тела. Отдельный статус, а не «ошибка»: сказать «пароль не
   * подходит», увидев 502, — это отправить человека менять исправный пароль.
   */
  | 'unverified';

export interface CheckOutcome {
  readonly status: CheckStatus;
  /** Одна строка человеку: что произошло и что чинить. Секретов не несёт. */
  readonly message: string;
}

export interface ShmCheckOutcome extends CheckOutcome {
  /**
   * Зона, которой SHM подписывает КАЖДЫЙ свой ответ (`TZ` в конверте). Мастер
   * подставляет её дефолтом в HQ_MCP_SHM_TZ: SHM пишет даты локальным временем
   * сервера без офсета, и зона, угаданная по умолчанию вместо прочитанной у
   * самого сервера, сдвигает каждый возраст задачи ровно на разницу — молча.
   */
  readonly serverTz: string | null;
}

export interface CheckDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Что означает код транспорта на человеческом языке — и что с ним делать. */
const TRANSPORT_HINTS: Record<string, string> = {
  ENOTFOUND: 'DNS does not resolve that hostname — check the spelling of the host',
  EAI_AGAIN: 'DNS lookup failed temporarily — check your resolver or VPN',
  ECONNREFUSED: 'the host answered but nothing listens on that port — check the scheme and port',
  ECONNRESET: 'the connection was reset — a proxy or firewall between you and the host',
  EHOSTUNREACH: 'no route to that host — check the network or the tunnel',
  ETIMEDOUT: 'the connection timed out — the host is filtered or down',
  CERT_HAS_EXPIRED: "the TLS certificate has expired — fix it on the server, don't disable checks",
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed and not trusted here',
  SELF_SIGNED_CERT_IN_CHAIN: 'the TLS chain ends in an untrusted self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'the TLS chain is incomplete — the server is not sending its intermediate certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the TLS certificate is issued for a different hostname',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Из брошенного fetch достаёт ТОЛЬКО код причины, а не текст.
 *
 * Текст исключения — свободная строка от рантайма, и в неё, в отличие от кода,
 * может попасть что угодно, включая адрес запроса целиком. Адрес мастер
 * печатает сам и в безопасном виде (safeUrlLabel), а вторую, неконтролируемую
 * копию впускать в вывод незачем.
 */
function transportHint(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'the request timed out — the host is unreachable, filtered, or very slow';
  }
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : null;
  if (code === null) return 'the connection failed before any response came back';
  return TRANSPORT_HINTS[code] ?? `the connection failed (${code})`;
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 32).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

interface Answer {
  readonly status: number;
  readonly location: string | null;
  readonly text: string;
}

async function request(
  url: string,
  headers: Record<string, string>,
  deps: CheckDeps,
): Promise<Answer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // redirect: 'manual' — редирект здесь не «по дороге», а сам по себе ответ:
  // адрес, отданный человеком, указывает не туда, и он обязан узнать это, а не
  // получить зелёную галочку на другом хосте. Плюс заголовок с секретом не
  // уезжает вслед за Location, куда бы тот ни вёл.
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    text: await response.text(),
  };
}

/** Общая для обоих бэкендов классификация «ответ есть, но он не про успех». */
function classifyFailure(answer: Answer, what: string, endpoint: string): CheckOutcome | null {
  if (answer.status === 401 || answer.status === 403) {
    return {
      status: 'rejected',
      message: `${what} answered HTTP ${String(answer.status)} — it is up, but it did not accept these credentials.`,
    };
  }
  if (answer.status >= 300 && answer.status < 400) {
    const target = answer.location === null ? 'somewhere else' : safeUrlLabel(answer.location);
    return {
      status: 'wrong_endpoint',
      message: `${what} redirected (HTTP ${String(answer.status)}) to ${target}. Enter that address instead — a base URL that redirects hides which host actually answers.`,
    };
  }
  if (answer.status === 404) {
    return {
      status: 'wrong_endpoint',
      message: `${what} answered HTTP 404 for ${endpoint}. The host is up but this is not the API root you meant.`,
    };
  }
  if (answer.status === 429) {
    return {
      status: 'unverified',
      message: `${what} answered HTTP 429 (rate limited), so the credentials could not be checked. Wait a minute and try again.`,
    };
  }
  if (answer.status >= 500) {
    return {
      status: 'unverified',
      message: `${what} answered HTTP ${String(answer.status)} — it is up but unhealthy, so nothing about the credentials was proven.`,
    };
  }
  if (looksLikeHtml(answer.text)) {
    return {
      status: 'wrong_endpoint',
      message: `${what} answered with an HTML page instead of JSON — this address serves a web UI, not the API.`,
    };
  }
  if (answer.status >= 400) {
    // Всё прочее из 4xx: ответ есть, успехом он не является, но и утверждать по
    // нему, что дело в кредах, не из чего. Молчаливое падение в «ok» ниже было
    // бы худшим исходом из возможных.
    return {
      status: 'unverified',
      message: `${what} answered an unexpected HTTP ${String(answer.status)}, so nothing about the credentials was proven.`,
    };
  }
  return null;
}

/**
 * Ручка выбрана АДМИНСКАЯ намеренно. Публичный `/healthcheck` отвечает 200 и на
 * пустой, и на заведомо неверный Basic (проверено на работающей SHM 2.19.4), то
 * есть доказывает живость сервера и ровно ничего — о кредах. Мастер спрашивает
 * не «жив ли биллинг», а «пустит ли он этот сервер внутрь», и ответ на это
 * даёт только ручка, требующая прав администратора.
 *
 * Отличить «сервер лежит» от «креды не те» при этом ничего не мешает: любой
 * HTTP-статус уже доказывает, что сервер ответил, а недоступность приходит
 * исключением из fetch. Второго запроса для этого не нужно — и это важно:
 * SHM блокирует IP после нескольких неудачных попыток входа, и лишняя проба
 * тратила бы половину этого запаса на каждую опечатку.
 */
export async function checkShm(
  input: { baseUrl: string; auth: string },
  deps: CheckDeps = {},
): Promise<ShmCheckOutcome> {
  const where = safeUrlLabel(input.baseUrl);
  const endpoint = '/admin/user';
  let answer: Answer;
  try {
    // buildBasicAuth — тот же самый, которым заголовок соберёт рабочий клиент
    // (@hq/shm). Вторая реализация правила «login:password или готовый Basic»
    // означала бы, что мастер проверяет не то значение, которое потом поедет
    // в запрос, и однажды подтвердит неработающее.
    answer = await request(
      `${input.baseUrl.replace(/\/+$/, '')}${endpoint}?limit=1`,
      { Authorization: buildBasicAuth(input.auth) },
      deps,
    );
  } catch (error: unknown) {
    return {
      status: 'unreachable',
      serverTz: null,
      message: `SHM at ${where} did not answer: ${transportHint(error)}.`,
    };
  }

  const failure = classifyFailure(answer, `SHM at ${where}`, endpoint);
  if (failure !== null) {
    const extra =
      failure.status === 'rejected'
        ? ' SHM throttles an IP after a few failed logins, so look the password up rather than guessing it.'
        : failure.status === 'wrong_endpoint' && answer.status === 404
          ? ' SHM_BASE_URL has to include the API version segment, e.g. https://billing.example.com/shm/v1.'
          : '';
    return { status: failure.status, serverTz: null, message: `${failure.message}${extra}` };
  }

  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return {
      status: 'unverified',
      serverTz: null,
      message: `SHM at ${where} answered HTTP ${String(answer.status)} with a body that is not JSON, so nothing was proven.`,
    };
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return {
      status: 'unverified',
      serverTz: null,
      message: `SHM at ${where} answered HTTP ${String(answer.status)} but not in the {data:[…]} envelope every tool here expects. Check that the URL points at the API root and not at a proxy in front of it.`,
    };
  }

  const tz = typeof body.TZ === 'string' && body.TZ.trim() !== '' ? body.TZ.trim() : null;
  return {
    status: 'ok',
    serverTz: tz,
    message: `SHM at ${where} accepted the credentials${tz === null ? '' : ` (server timezone ${tz})`}.`,
  };
}

/**
 * `/api/system/health` ТРЕБУЕТ авторизации: без токена панель отвечает 401
 * (проверено на живой 3.2.3). Ровно поэтому она годится проверкой токена — и
 * ровно поэтому её нельзя читать как проверку доступности: 401 без токена и
 * 401 с протухшим токеном неразличимы.
 *
 * Различает три случая не она, а источник ответа: исключение из fetch — до
 * сервера не доехали; ЛЮБОЙ HTTP-статус — сервер жив и уже ответил, дальше
 * решает сам статус. Неавторизованная проба «жива ли панель» здесь не нужна и
 * не делается: она не добавила бы ни одного различения, зато добавила бы
 * запрос.
 */
export async function checkRemna(
  input: { baseUrl: string; token: string },
  deps: CheckDeps = {},
): Promise<CheckOutcome> {
  const where = safeUrlLabel(input.baseUrl);
  const endpoint = '/api/system/health';
  let answer: Answer;
  try {
    answer = await request(
      `${input.baseUrl.replace(/\/+$/, '')}${endpoint}`,
      { Authorization: `Bearer ${input.token.trim()}` },
      deps,
    );
  } catch (error: unknown) {
    return {
      status: 'unreachable',
      message: `The Remnawave panel at ${where} did not answer: ${transportHint(error)}.`,
    };
  }

  const failure = classifyFailure(answer, `The Remnawave panel at ${where}`, endpoint);
  if (failure !== null) {
    const extra =
      failure.status === 'rejected'
        ? ' Issue a token with the API role in the panel (Settings → API tokens) and paste it whole — a JWT has two dots in it.'
        : failure.status === 'wrong_endpoint' && answer.status === 404
          ? ' REMNA_BASE_URL is the panel root with no path, e.g. https://panel.example.com — not the subscription page and not /api.'
          : '';
    return { status: failure.status, message: `${failure.message}${extra}` };
  }

  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return {
      status: 'unverified',
      message: `The Remnawave panel at ${where} answered HTTP ${String(answer.status)} with a body that is not JSON, so nothing was proven.`,
    };
  }
  if (!isRecord(body) || !isRecord(body.response)) {
    return {
      status: 'unverified',
      message: `The Remnawave panel at ${where} answered HTTP ${String(answer.status)} but not in the {response:{…}} envelope the panel uses. Check that the URL points at the panel itself and not at something in front of it.`,
    };
  }
  return { status: 'ok', message: `The Remnawave panel at ${where} accepted the token.` };
}
