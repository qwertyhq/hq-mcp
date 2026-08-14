import type { ShmListResult } from '@hq/types';

export class ShmError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = 'ShmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Retryable только лок услуги на запись — 3 секунды FOR UPDATE SKIP LOCKED (§6.19). */
export function isRetryableStatus(status: number): boolean {
  return status === 408;
}

/**
 * При недостаточных правах SHM отдаёт HTML-страницу с кодом 200 (§6.20).
 * Проверять надо ДО JSON.parse, иначе получаем невнятный SyntaxError.
 */
export function isHtmlBody(text: string): boolean {
  const head = text.trimStart().slice(0, 32).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * Поля SHM, чьи ИМЕНА сталкиваются с правилом маскирования @hq/redact, хотя
 * секретами не являются. Ключ — имя из базы, значение — имя, под которым поле
 * уезжает наружу.
 *
 * `SECRET_KEY_RE` (/token|secret|key|password|auth/i) проверяется по имени
 * поля, и слово `key` матчится буквально. `pays_history.uniq_key` — это
 * идентификатор транзакции у платёжной системы; на нём стоит
 * UNIQUE(user_id, uniq_key), которым SHM режет дубли зачислений, то есть это
 * ровно то поле, по которому разбирают двойное списание. Приезжало оно
 * '<redacted>' в КАЖДОЙ строке (проверено на работающей установке), и починить это
 * на выходе инструмента нельзя: клиент редактирует тело раньше, чем его
 * увидит billing_ledger, — там уже лежит маркер, а не значение.
 *
 * Список закрытый и расширяется по одному имени с разбором: каждая строка
 * здесь — поле, которое ПЕРЕСТАЁТ маскироваться. Соседний `users.password` не
 * переименован и не будет — он маскируется по делу; правило редакции остаётся
 * ровно таким же тупым, каким было.
 */
export const SHM_SAFE_RENAMES: Readonly<Record<string, string>> = {
  uniq_key: 'uniq_id',
  /**
   * Два ФЛАГА со страницы входа клиента, оба булевы 0/1 и оба съедались по
   * слову `password` в имени. Проверено на работающей SHM 2.19.4:
   * `GET /user/password-auth` (Core::User::api_password_auth_status,
   * app/lib/Core/User.pm:1514-1527) отдаёт четыре поля, и три из четырёх
   * приезжали '<redacted>' — `password_auth_disabled`, `password_set_by_user`
   * и `passkey_enabled` (последнее по слову `key`). То есть маршрут, который
   * существует ровно затем, чтобы ответить «может ли этот клиент войти по
   * паролю», не отвечал ни на что, а `otp_enabled` рядом проезжал целым.
   *
   * Новые имена подобраны так, чтобы в них не было НИ ОДНОГО слова из
   * `SECRET_KEY_RE` (/token|secret|key|password|auth/i). Именно поэтому не
   * «pass_auth» и не «webauthn»: в первом остаётся `auth`, во втором — тоже.
   *
   * `passkey_enabled` СОЗНАТЕЛЬНО НЕ ПЕРЕИМЕНОВАН. Любое его имя обязано
   * потерять слово `key`, то есть перестать называть вещь своим именем, — а
   * ответ на «есть ли у клиента passkey» и так лежит рядом, в поле `enabled`
   * ответа `GET /user/passkey`, которое ни под одно правило не попадает.
   * Инструмент берёт его оттуда, а не из переименованного поля.
   */
  password_auth_disabled: 'pwd_login_disabled',
  password_set_by_user: 'pwd_set_by_user',
};

/**
 * Применяет SHM_SAFE_RENAMES ко всему телу ответа. Идёт ДО redact и только на
 * редактируемом канале: `getRaw`/`sendRaw` кормят read-merge-write плана 2, и
 * переименованное поле уехало бы в PATCH под именем, которого бэкенд не знает.
 *
 * Object.create(null) — по той же причине, что и в @hq/redact: буквальный
 * ключ "__proto__" из JSON.parse не должен подменить прототип результата.
 */
export function renameSafeShmKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(renameSafeShmKeys);
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[SHM_SAFE_RENAMES[key] ?? key] = renameSafeShmKeys(item);
  }
  return out;
}

/** Снимает конверт `{data: ...}`; массивы и голые объекты отдаёт как есть. */
export function unwrapShm(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    return (body as Record<string, unknown>).data;
  }
  return body;
}

/**
 * Гард против ложного успеха action-эндпоинтов (§6.1).
 * Так ведут себя change при неподходящем статусе, activate при нехватке денег,
 * удаление несуществующего платежа: HTTP 200 и тело `{data:[null]}`.
 */
export function dataTruthyGuard(body: unknown): unknown {
  const data = unwrapShm(body);
  if (data === undefined) return undefined;
  const scalar = Array.isArray(data) ? data[0] : data;
  if (scalar === null || scalar === undefined || scalar === false || scalar === 0 || scalar === '') {
    throw new ShmError(
      'SHM answered 200 with falsy data — the action was a no-op and nothing changed',
      200,
      false,
    );
  }
  return data;
}

/** Значение заголовка Authorization: 'login:password' → Basic base64, готовое 'Basic xxx' → как есть. */
export function buildBasicAuth(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  if (/^basic\s+/i.test(value)) return value;
  return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Приводит ответ списочной ручки к ShmListResult, СОХРАНЯЯ `items` (§6.4).
 * Оба уже написанных клиента его выбрасывают и вместе с ним теряют пагинацию.
 */
export function toShmListResult<T>(
  body: unknown,
  limit: number,
  offset: number,
): ShmListResult<T> {
  const envelope =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const payload = unwrapShm(body);
  const data: T[] = Array.isArray(payload)
    ? (payload as T[])
    : payload === undefined || payload === null
      ? []
      : [payload as T];
  return {
    items: numberOr(envelope.items, data.length),
    limit: numberOr(envelope.limit, limit),
    offset: numberOr(envelope.offset, offset),
    data,
  };
}
