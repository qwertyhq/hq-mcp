import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from '@hq/env';
import { isAccess } from '@hq/types';
import { connectionInstructions } from './clients.js';
import { SetupAbortedError } from './errors.js';
import { backupEnvFile, readEnvFile, renderEnvFile, writeEnvFile } from './envfile.js';
import { maskAuth, maskSecret } from './mask.js';
import { describeNaming } from './naming.js';
import { confirm } from './prompts.js';
import { askAdvanced, askBackends, askMode, askRemna, askShm } from './steps.js';
import { countTools } from './tools.js';
import type { BackendPresence } from '@hq/types';
import type { CheckDeps } from './checks.js';
import type { EnvSection } from './envfile.js';
import type { SetupIo } from './io.js';
import type { AdvancedDefaults, StepContext } from './steps.js';
import type { ToolCounts } from './tools.js';

/**
 * Заглушки ОБЯЗАТЕЛЬНЫХ переменных. Нужны затем, чтобы спрашивать у настоящего
 * загрузчика два вопроса, на которые иначе пришлось бы отвечать копией его
 * правил: «допустимо ли вот это значение вот этой переменной» и «а какой у неё
 * дефолт». `loadConfig` без обязательных переменных бросает на первой из них и
 * до остальных не доходит — поэтому они здесь, заведомо ненастоящие.
 */
const REQUIRED_PLACEHOLDERS: Record<string, string> = {
  SHM_BASE_URL: 'https://billing.example.com/shm/v1',
  SHM_ADMIN_AUTH: 'login:password',
  REMNA_BASE_URL: 'https://panel.example.com',
  REMNA_API_TOKEN: 'placeholder-token',
};

/**
 * Проверка формы — ТЕМ ЖЕ загрузчиком, который потом запустит сервер.
 *
 * Своя проверка «это же просто положительное число» разошлась бы с ним на
 * первом же потолке (`HQ_MCP_MAX_OP_AMOUNT` имеет ещё и жёсткий максимум, а
 * `HQ_MCP_SHM_TZ` обязана быть зоной IANA) — и мастер бодро записал бы
 * значение, на котором сервер не поднимется. Ошибка о ЧУЖОЙ переменной
 * игнорируется: чужая переменная здесь — наша же заглушка.
 */
function validateWithLoader(key: string, value: string): string | null {
  try {
    loadConfig({ ...REQUIRED_PLACEHOLDERS, [key]: value });
    return null;
  } catch (error: unknown) {
    if (error instanceof ConfigError && error.variable === key) return error.message;
    return null;
  }
}

/** Дефолты необязательных переменных — оттуда же, откуда их берёт сервер. */
function advancedDefaults(): AdvancedDefaults {
  const cfg = loadConfig({ ...REQUIRED_PLACEHOLDERS });
  // Потолки читаются через тип с НЕОБЯЗАТЕЛЬНЫМ maxBulkUsers: @hq/env правится
  // параллельно, и мастер обязан собираться и с той версией, где этой
  // переменной ещё нет. Спрашивать её он тогда просто не станет.
  const limits: { maxOpAmount: number; maxBulkUsers?: number } = cfg.mutations;
  return {
    profile: cfg.profile,
    shmTz: cfg.shmTz,
    budgetLimit: cfg.budget.limit,
    budgetWindowMs: cfg.budget.windowMs,
    maxOpAmount: limits.maxOpAmount,
    ...(limits.maxBulkUsers === undefined ? {} : { maxBulkUsers: limits.maxBulkUsers }),
    tunnelHost: cfg.tunnel.postgres.host,
    tunnelAbuseUrl: cfg.tunnel.abuseUrl,
    tunnelPgPort: cfg.tunnel.postgres.port,
    tunnelSsh: cfg.tunnel.sshCommand,
  };
}

/**
 * Переменные бэкендов — те, о которых мастер спрашивает ЯВНО и которые поэтому
 * обязан УМЕТЬ УБРАТЬ. Всё остальное из прежнего файла переживает перезапись
 * (см. buildSections), а эти четыре — нет: человек, ответивший «панель только»,
 * сказал, что SHM здесь нет, и оставленные от прошлого раза `SHM_*` вернули бы
 * тринадцать инструментов, которых он не просил, молча.
 */
const BACKEND_KEYS: readonly string[] = [
  'SHM_BASE_URL',
  'SHM_ADMIN_AUTH',
  'REMNA_BASE_URL',
  'REMNA_API_TOKEN',
];

/** Порядок и группировка записей в файле. Незнакомые ключи не теряются — см. buildSections. */
const GROUPS: readonly { readonly title: string; readonly keys: readonly string[] }[] = [
  {
    title: 'Backends — at least one pair, both only if you run both',
    keys: BACKEND_KEYS,
  },
  { title: 'Behaviour', keys: ['HQ_MCP_MODE', 'HQ_MCP_PROFILE', 'HQ_MCP_SHM_TZ'] },
  {
    title: 'Limits',
    keys: [
      'HQ_MCP_BUDGET_LIMIT',
      'HQ_MCP_BUDGET_WINDOW_MS',
      'HQ_MCP_MAX_OP_AMOUNT',
      'HQ_MCP_MAX_BULK_USERS',
    ],
  },
  {
    title: 'Private-network tools',
    keys: [
      'HQ_MCP_TUNNEL_HOST',
      'HQ_MCP_TUNNEL_ABUSE_URL',
      'HQ_MCP_GUARD_HOOK_TOKEN',
      'HQ_MCP_TUNNEL_PG_PORT',
      'HQ_MCP_TUNNEL_MYSQL_PORT',
      'HQ_MCP_TUNNEL_SSH',
    ],
  },
];

/**
 * Имя, которое обещает секрет. Та же договорённость, по которой `@hq/redact`
 * маскирует поля ответов; здесь она решает только одно — в каком виде значение
 * покажут в итоговой сводке.
 */
const SECRET_KEY_RE = /token|secret|password|auth/i;

function shownValue(key: string, value: string): string {
  if (key === 'SHM_ADMIN_AUTH') return maskAuth(value);
  return SECRET_KEY_RE.test(key) ? maskSecret(value) : value;
}

/**
 * Ключи, которых мастер не знает, ПЕРЕЖИВАЮТ перезапись.
 *
 * `.env` этого репозитория содержит не только то, о чём спрашивают:
 * `SHM_PUBLIC_SECRET`, `HQ_STAND_FORBIDDEN_HOSTS` (без которого харнесс
 * фикстур отказывается стартовать), плюс всё, что появится в переменных
 * завтра. Мастер, переписывающий файл своим набором, тихо стёр бы их — и
 * сломанным оказался бы не он, а что-то соседнее, через неделю.
 */
export function buildSections(
  collected: Record<string, string>,
  previous: Record<string, string>,
): EnvSection[] {
  const sections: EnvSection[] = [];
  const claimed = new Set<string>();
  for (const group of GROUPS) {
    const entries = group.keys
      .filter((key) => collected[key] !== undefined)
      .map((key) => {
        claimed.add(key);
        return { key, value: collected[key] ?? '' };
      });
    if (entries.length > 0) sections.push({ title: group.title, entries });
  }

  const strays = Object.keys(collected)
    .filter((key) => !claimed.has(key))
    .sort();
  if (strays.length > 0) {
    sections.push({
      title: 'Other',
      entries: strays.map((key) => ({ key, value: collected[key] ?? '' })),
    });
  }

  const kept = Object.keys(previous)
    .filter((key) => collected[key] === undefined)
    // Креды бэкенда, о котором СПРАШИВАЛИ и который не выбрали, не переживают
    // перезапись — см. BACKEND_KEYS.
    .filter((key) => !BACKEND_KEYS.includes(key))
    .sort();
  if (kept.length > 0) {
    sections.push({
      title: 'Kept from the previous file — the wizard does not ask about these',
      entries: kept.map((key) => ({ key, value: previous[key] ?? '' })),
    });
  }
  return sections;
}

export interface WizardDeps {
  readonly io: SetupIo;
  /** Абсолютный путь до `.env`, который мастер пишет. */
  readonly envPath: string;
  /** Абсолютный путь до собранного `apps/stdio/dist/index.js`. */
  readonly serverPath: string;
  readonly now: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly countToolsImpl?: (env: Record<string, string>) => Promise<ToolCounts | null>;
  readonly fileExists?: (path: string) => boolean;
}

export interface WizardOutcome {
  readonly envPath: string;
  readonly backupPath: string | null;
  /** Что уехало в файл. Печатать это целиком нельзя — см. shownValue. */
  readonly values: Record<string, string>;
}

export async function runWizard(deps: WizardDeps): Promise<WizardOutcome> {
  const { io } = deps;
  const exists = deps.fileExists ?? existsSync;
  const previous = readEnvFile(deps.envPath);

  io.say('hq-mcp setup');
  io.say('');
  io.say('Asks which of the two systems you run — either one alone is enough — checks');
  io.say('every credential against the live system before moving on, writes .env with');
  io.say('mode 0600, and prints the commands that connect an MCP client to the result.');
  io.say('Ctrl-C anywhere writes nothing.');
  if (previous.exists) {
    io.say('');
    io.say(`Found an existing ${deps.envPath}: its values are offered as defaults, so`);
    io.say('Enter keeps one. It is backed up before anything is overwritten, and');
    io.say('overwriting is the last question, not the first.');
  }

  const check: CheckDeps = {
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };
  const ctx: StepContext = {
    io,
    existing: previous.values,
    validate: validateWithLoader,
    check,
  };

  /**
   * Что было настроено в прошлый раз — ПРОЧИТАНО, а не угадано: пара считается
   * настроенной, когда в файле есть хотя бы одна её переменная. То же правило,
   * по которому решает `loadConfig`; второго правила на этот вопрос быть не
   * должно. Ни одной пары в прежнем файле (или файла нет) — дефолта нет вовсе,
   * и ответить придётся явно.
   */
  const had = (keys: readonly string[]): boolean =>
    keys.some((key) => (previous.values[key] ?? '').trim() !== '');
  const previousBackends: BackendPresence | null =
    had(['SHM_BASE_URL', 'SHM_ADMIN_AUTH']) || had(['REMNA_BASE_URL', 'REMNA_API_TOKEN'])
      ? {
          shm: had(['SHM_BASE_URL', 'SHM_ADMIN_AUTH']),
          remna: had(['REMNA_BASE_URL', 'REMNA_API_TOKEN']),
        }
      : null;
  const backends = await askBackends(ctx, previousBackends);

  const collected: Record<string, string> = {};
  let shmServerTz: string | null = null;
  if (backends.shm) {
    const shm = await askShm(ctx);
    shmServerTz = shm.serverTz;
    collected.SHM_BASE_URL = shm.baseUrl;
    collected.SHM_ADMIN_AUTH = shm.auth;
  }
  if (backends.remna) {
    // Токен разбирается в отдельное короткое имя намеренно: страж секретов
    // (scripts/no-secrets.test.ts) читает `REMNA_API_TOKEN: <длинное выражение>`
    // как присваивание настоящего значения и краснеет на исходнике, в котором
    // никакого значения нет. Правильный ответ на это — не исключение из стража,
    // а код, который на утечку не похож.
    const { baseUrl: panelUrl, token } = await askRemna(ctx);
    collected.REMNA_BASE_URL = panelUrl;
    collected.REMNA_API_TOKEN = token;
  }

  /**
   * Именование этой инсталляции — читается у неё самой, не спрашивается.
   *
   * Спросить префиксы у человека было бы худшим из возможных решений: он их не
   * знает, а угаданный им префикс — это тот же уверенный обман, только
   * подписанный его именем. Переменные окружения `HQ_MCP_PANEL_PREFIXES` и
   * `HQ_MCP_STORAGE_PREFIX` из прошлого `.env` при этом не теряются: они
   * приезжают в `previous.values`, переживают перезапись (buildSections) и
   * старше живого чтения — поэтому и передаются сюда.
   */
  // Именование читается У SHM. Без неё спрашивать некого, а печатать
  // «умолчание шаблона» было бы разговором про связь двух систем в установке,
  // где их не две.
  const naming = backends.shm
    ? await describeNaming({ ...previous.values, ...collected }, deps.fetchImpl)
    : [];
  if (naming.length > 0) {
    io.say('');
    for (const line of naming) io.say(line);
  }

  const previousMode = previous.values.HQ_MCP_MODE?.trim() ?? '';
  const mode = await askMode(
    ctx,
    await (deps.countToolsImpl ?? countTools)(collected),
    isAccess(previousMode) ? previousMode : 'ro',
  );
  collected.HQ_MCP_MODE = mode;
  Object.assign(
    collected,
    await askAdvanced(ctx, advancedDefaults(), mode, shmServerTz, backends),
  );

  // Последняя проверка перед записью: собранное читается настоящим загрузчиком
  // целиком. Каждое значение уже проверено по одному, но по одному не видно
  // взаимодействий, а `.env`, на котором сервер не стартует, — это худший из
  // возможных исходов мастера: человек уйдёт с ощущением, что всё настроено.
  try {
    loadConfig({ ...collected });
  } catch (error: unknown) {
    const detail = error instanceof ConfigError ? error.message : String(error);
    throw new SetupAbortedError(`the answers do not load as a valid configuration: ${detail}`);
  }

  if (previous.exists) {
    io.say('');
    io.say(`${deps.envPath} already exists and is about to be replaced.`);
    if (!(await confirm(io, 'Overwrite it?', false))) {
      throw new SetupAbortedError(`nothing was written; ${deps.envPath} is untouched`);
    }
  }

  const backupPath = backupEnvFile(deps.envPath, deps.now());
  writeEnvFile(deps.envPath, renderEnvFile(buildSections(collected, previous.values), deps.now()));

  io.say('');
  if (backupPath !== null) io.say(`Backed the old file up to ${backupPath}`);
  io.say(`Wrote ${deps.envPath} with mode 0600. It is gitignored — keep it that way.`);
  io.say('');
  for (const [key, value] of Object.entries(collected)) io.say(`  ${key}=${shownValue(key, value)}`);
  io.say('');
  for (const line of connectionInstructions({
    serverPath: deps.serverPath,
    built: exists(deps.serverPath),
  })) {
    io.say(line);
  }

  return { envPath: deps.envPath, backupPath, values: collected };
}
