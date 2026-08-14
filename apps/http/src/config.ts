import { ConfigError } from '@hq/env';

export const DEFAULT_HTTP_PORT = 42480;

/**
 * Конфигурация ТОЛЬКО транспортного слоя. Режим, профиль, креды апстримов, бюджет и пути
 * журнала/снапшотов читает loadConfig() из @hq/env — один источник на оба приложения.
 * Своего HQ_MCP_HTTP_BUDGET_* здесь нет: у SHM одно ведро rate-limit на весь сервис по IP
 * (§6.14 спеки), второй счётчик означал бы вдвое больше запросов в то же ведро.
 *
 * Отказы — тем же ConfigError, что и у @hq/env, а не голым Error. Точка входа печатает по
 * `error.variable` подсказку «где эту переменную задать» (см. startupErrorMessage в
 * apps/stdio); с голым Error имя переменной пришлось бы выковыривать из текста регуляркой,
 * а с двумя классами ошибок на один старт — писать два обработчика.
 */
export interface HttpServerConfig {
  host: string;
  port: number;
  /** Сырое значение HQ_MCP_HTTP_TOKENS; разбирается в auth.parseTokens. */
  rawTokens: string;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(
      name,
      `Environment variable ${name} must be an integer in [${String(min)}, ${String(max)}], got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpServerConfig {
  const rawTokens = (env.HQ_MCP_HTTP_TOKENS ?? '').trim();
  if (rawTokens === '') {
    throw new ConfigError(
      'HQ_MCP_HTTP_TOKENS',
      'HQ_MCP_HTTP_TOKENS is empty: refusing to start an unauthenticated server. ' +
        'Expected "<label>:<token>[,<label>:<token>]".',
    );
  }
  // Дефолт — loopback, и это не вкус: снаружи HTTP-контур ходит через reverse proxy
  // того же хоста. Значение 0.0.0.0 оператор обязан написать руками и увидеть, что
  // написал, — умолчание, слушающее все интерфейсы, однажды уедет в рабочую
  // установку молча.
  const host = (env.HQ_MCP_HTTP_HOST ?? '').trim() || '127.0.0.1';
  return {
    host,
    port: readInt(env, 'HQ_MCP_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65_535),
    rawTokens,
  };
}
