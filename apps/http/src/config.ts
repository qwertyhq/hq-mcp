import { ConfigError, readFileBackedSecret } from '@hq/env';

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
  /** Build-time commit evidence, mandatory only for the production bot profile. */
  imageRevision: string | null;
  /** Shared non-secret deployment revision, mandatory only for the bot profile. */
  deploymentConfigRevision: string | null;
}

const IMAGE_REVISION_RE = /^[a-f0-9]{40}$/;
const DEPLOYMENT_CONFIG_REVISION_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
  const rawTokens = readFileBackedSecret(env, 'HQ_MCP_HTTP_TOKENS');
  if (rawTokens === undefined) {
    throw new ConfigError(
      'HQ_MCP_HTTP_TOKENS',
      'HQ_MCP_HTTP_TOKENS (or HQ_MCP_HTTP_TOKENS_FILE) is empty: refusing to start an unauthenticated server. ' +
        'Expected "<label>:<token>[,<label>:<token>]".',
    );
  }

  const profile = env.HQ_MCP_PROFILE?.trim() ?? 'human';
  let imageRevision: string | null = null;
  let deploymentConfigRevision: string | null = null;
  if (profile === 'bot') {
    imageRevision = env.HQ_MCP_IMAGE_REVISION?.trim() ?? '';
    if (!IMAGE_REVISION_RE.test(imageRevision)) {
      throw new ConfigError(
        'HQ_MCP_IMAGE_REVISION',
        'HQ_MCP_IMAGE_REVISION must be the exact 40-character lowercase commit SHA baked into the image.',
      );
    }

    deploymentConfigRevision = env.HQ_MCP_DEPLOYMENT_CONFIG_REVISION?.trim() ?? '';
    if (!DEPLOYMENT_CONFIG_REVISION_RE.test(deploymentConfigRevision)) {
      throw new ConfigError(
        'HQ_MCP_DEPLOYMENT_CONFIG_REVISION',
        'HQ_MCP_DEPLOYMENT_CONFIG_REVISION must be a canonical lowercase UUID.',
      );
    }
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
    imageRevision,
    deploymentConfigRevision,
  };
}
