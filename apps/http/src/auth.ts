import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '@hq/env';

export const MIN_TOKEN_LENGTH = 24;

const VARIABLE = 'HQ_MCP_HTTP_TOKENS';

export interface HttpToken {
  label: string;
  token: string;
}

export type AuthResult =
  | { ok: true; label: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown' };

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Разбирает HQ_MCP_HTTP_TOKENS в формате "<label>:<token>[,<label>:<token>]".
 * Метка нужна, чтобы в метриках и логах было видно, кто ходит (бот или операторская панель),
 * не светя сам токен. Пустой список — исключение: сервер без аутентификации не поднимается.
 *
 * Ни одно сообщение об ошибке не содержит значения токена: этот текст уезжает в stderr,
 * а оттуда — в журнал супервизора, который читается не только тем, кто токен и так знает.
 */
export function parseTokens(raw: string | undefined): HttpToken[] {
  const tokens: HttpToken[] = [];
  const labels = new Set<string>();
  const values = new Set<string>();
  for (const chunk of (raw ?? '').split(',')) {
    const entry = chunk.trim();
    if (entry === '') continue;
    const sep = entry.indexOf(':');
    const label = sep > 0 ? entry.slice(0, sep).trim() : '';
    const token = sep > 0 ? entry.slice(sep + 1).trim() : '';
    if (label === '' || token === '') {
      throw new ConfigError(VARIABLE, `${VARIABLE}: bad entry, expected "<label>:<token>"`);
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(
        VARIABLE,
        `${VARIABLE}: token for "${label}" is shorter than ${String(MIN_TOKEN_LENGTH)} characters`,
      );
    }
    // Две метки на один токен — это одна запись под двумя именами: authenticate вернёт
    // последнюю совпавшую, разрез byClient начнёт врать, а отзыв одной строки не отзовёт
    // ничего. Повторная метка ломает то же самое с другой стороны — два клиента слипаются
    // в один бакет. И то, и другое — опечатка оператора, и узнать о ней надо на старте.
    if (labels.has(label)) {
      throw new ConfigError(VARIABLE, `${VARIABLE}: duplicate label "${label}"`);
    }
    if (values.has(token)) {
      throw new ConfigError(
        VARIABLE,
        `${VARIABLE}: duplicate token shared by "${label}" and an earlier label; give each client its own`,
      );
    }
    labels.add(label);
    values.add(token);
    tokens.push({ label, token });
  }
  if (tokens.length === 0) {
    throw new ConfigError(
      VARIABLE,
      `${VARIABLE} is empty: refusing to start an unauthenticated server`,
    );
  }
  return tokens;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Сравнение идёт по sha256-дайджестам фиксированной длины, поэтому timingSafeEqual не бросает
 * на разной длине входа. Цикл намеренно НЕ прерывается на совпадении: число сравнений постоянно
 * и не зависит от позиции найденного токена.
 */
export function authenticate(
  header: string | undefined,
  tokens: readonly HttpToken[],
): AuthResult {
  if (header === undefined || header.trim() === '') return { ok: false, reason: 'missing' };
  const match = BEARER.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return { ok: false, reason: 'malformed' };

  const presentedDigest = digest(presented);
  let label: string | undefined;
  for (const candidate of tokens) {
    if (timingSafeEqual(presentedDigest, digest(candidate.token))) {
      label = candidate.label;
    }
  }
  return label === undefined ? { ok: false, reason: 'unknown' } : { ok: true, label };
}
