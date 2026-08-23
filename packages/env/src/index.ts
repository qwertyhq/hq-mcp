import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAccess, isProfile } from '@hq/types';
import type { Access, Backend, BackendPresence, Profile, TunnelConfig } from '@hq/types';

/**
 * Переменные, которыми настраивается КАЖДЫЙ из двух бэкендов. Живут одним
 * списком, потому что их читают трое: загрузчик (обязательны обе или ни одной),
 * клиент-заглушка ненастроенного бэкенда (называет их в отказе) и мастер
 * установки (спрашивает ровно их). Три копии этого списка разъехались бы на
 * первой же переименованной переменной.
 */
export const SHM_VARIABLES: readonly string[] = ['SHM_BASE_URL', 'SHM_ADMIN_AUTH'];
export const REMNA_VARIABLES: readonly string[] = ['REMNA_BASE_URL', 'REMNA_API_TOKEN'];

export const BACKEND_VARIABLES: Readonly<Record<Backend, readonly string[]>> = {
  shm: SHM_VARIABLES,
  remna: REMNA_VARIABLES,
};

export type FileBackedSecretName =
  | 'SHM_ADMIN_AUTH'
  | 'REMNA_API_TOKEN'
  | 'HQ_MCP_HTTP_TOKENS';

const BACKEND_FILE_SOURCE: Readonly<Record<Backend, FileBackedSecretName>> = {
  shm: 'SHM_ADMIN_AUTH',
  remna: 'REMNA_API_TOKEN',
};

export interface HqMcpConfig {
  /**
   * `null` — эта система в развёртывании НЕ НАСТРОЕНА. Обязательна хотя бы
   * одна из двух; обе — по-прежнему нормальный случай. Тип нарочно nullable, а
   * не «пустой объект с пустыми строками»: пустая строка в baseUrl доехала бы
   * до fetch и превратила решение развёртывания в сетевую ошибку.
   */
  shm: { baseUrl: string; auth: string; publicSecret?: string } | null;
  remna: { baseUrl: string; token: string } | null;
  mode: Access;
  profile: Profile;
  auditPath: string;
  snapshotDir: string;
  /**
   * Зона, в которой SHM пишет даты. Core::Utils::now — strftime + localtime
   * (app/lib/Core/Utils.pm:133-141): локальное время сервера, без офсета и без
   * `Z`. Значение по умолчанию — Europe/Moscow: именно этот TZ прибит в
   * docker-compose.staging.yml:27, docker-compose.test.yml:24,
   * contributing/docker-compose.yml:25 и helm/k8s-shm/values.yaml самой SHM,
   * а в компоузах развёртывания приходит через ${TZ}.
   */
  shmTz: string;
  /** Сверх общего контракта: адреса ssh-туннеля для abuse_report и sql_query (§4.3). */
  tunnel: TunnelConfig;
  /** Сверх общего контракта: лимиты локального гейта запросов (§6.14, §7.6). */
  budget: { limit: number; windowMs: number };
  /**
   * Сверх общего контракта: потолки, за которые мутатору выходить нельзя.
   *
   * `maxOpAmount` — потолок одной денежной операции (§5.2). `maxBulkUsers` —
   * потолок числа клиентов, затронутых ОДНОЙ массовой операцией панели.
   *
   * Оба живут здесь, а не в `tools/mutations`: значение, прочитанное вторым
   * местом со своим дефолтом, — это второй потолок, который однажды разъедется
   * с первым.
   */
  mutations: { maxOpAmount: number; maxBulkUsers: number };
}

export class ConfigError extends Error {
  readonly variable: string;
  /**
   * Что человеку сделать. Заполняется, только когда общая подсказка точки
   * входа («задайте <variable>=…») ведёт не туда: у отказа «не настроена ни
   * одна из двух систем» правильных ответов два, и один из них — не трогать
   * `variable` вовсе.
   */
  readonly hint: string | undefined;

  constructor(variable: string, message: string, hint?: string) {
    super(message);
    this.name = 'ConfigError';
    this.variable = variable;
    this.hint = hint;
  }
}

/**
 * Примеры в подсказках намеренно указывают в example.com, а не в конкретное
 * развёртывание: подсказка учит ФОРМЕ значения (схема, наличие сегмента версии
 * у SHM, отсутствие пути у панели), а не адресу — свой оператор знает и так, а
 * чужой по чужому адресу всё равно не пойдёт. Формулировки совпадают с
 * `.env.example` в корне: два места, расходящиеся в примерах, учат разному.
 */
const HINTS: Record<string, string> = {
  SHM_BASE_URL: 'Base URL of the SHM API, e.g. https://billing.example.com/shm/v1',
  SHM_ADMIN_AUTH:
    'SHM admin credentials as "login:password" (encoded to Basic automatically) or a ready "Basic xxx" value',
  REMNA_BASE_URL: 'Base URL of the Remnawave panel, e.g. https://panel.example.com',
  REMNA_API_TOKEN: 'Remnawave API token (JWT, role API) — sent as the Bearer authorization header',
  HQ_MCP_GUARD_HOOK_TOKEN:
    'Shared secret of the shm-abuse-guard hook, sent as X-Guard-Token; the value the hook ' +
    'reads from its secret file on the SHM host',
};

/**
 * Печатается дословно в отказе закрытого туннеля, чтобы оператор мог скопировать
 * команду. Хосты здесь — плейсхолдеры: конкретные адреса внутренней сети в
 * публичном репозитории жить не могут, а форму команды (какой локальный порт
 * куда ведёт) плейсхолдеры передают полностью. Своё значение ставится через
 * HQ_MCP_TUNNEL_SSH — ровно то, что говорит `.env.example`.
 */
const DEFAULT_SSH_COMMAND =
  'ssh -L 18099:hook-host:8099 -L 16767:db-host:6767 your-jump-host';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new ConfigError(
      name,
      `Missing required environment variable ${name}. ${HINTS[name] ?? ''}`.trim(),
    );
  }
  return value;
}

function protectedSecretFileError(name: FileBackedSecretName): ConfigError {
  return new ConfigError(
    name,
    `Protected secret file required for ${name}: use a regular, non-symlink file with mode 0600.`,
  );
}

/**
 * Reads one of the deliberately small, fixed set of deploy-time secrets.
 *
 * The path and secret never appear in an error. The descriptor is opened with
 * O_NOFOLLOW and then checked again so a path swap between lstat and open
 * cannot turn a checked file into a symlink or a different regular file.
 */
export function readFileBackedSecret(
  env: NodeJS.ProcessEnv,
  name: FileBackedSecretName,
): string | undefined {
  const direct = env[name]?.trim();
  const fileVariable = `${name}_FILE`;
  const path = env[fileVariable]?.trim();

  if (direct !== undefined && direct !== '' && path !== undefined && path !== '') {
    throw new ConfigError(
      name,
      `Set exactly one of ${name} or ${fileVariable}; both are present.`,
    );
  }
  if (direct !== undefined && direct !== '') return direct;
  if (path === undefined || path === '') return undefined;

  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      (pathStat.mode & 0o777) !== 0o600
    ) {
      throw protectedSecretFileError(name);
    }

    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptorStat = fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      (descriptorStat.mode & 0o777) !== 0o600 ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      throw protectedSecretFileError(name);
    }

    const value = readFileSync(descriptor, 'utf8').trim();
    if (value === '') {
      throw new ConfigError(name, `Secret file is empty for ${name}.`);
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(name, `Cannot read protected secret file for ${name}.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requiredFileBackedSecret(env: NodeJS.ProcessEnv, name: FileBackedSecretName): string {
  const value = readFileBackedSecret(env, name);
  if (value === undefined) {
    throw new ConfigError(
      name,
      `Missing required environment variable ${name} (or ${name}_FILE). ${HINTS[name] ?? ''}`.trim(),
    );
  }
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name).replace(/\/+$/, '');
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
  } catch {
    throw new ConfigError(
      name,
      `Environment variable ${name} must be an absolute http(s) URL, got "${value}". ${HINTS[name] ?? ''}`.trim(),
    );
  }
  return value;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new ConfigError(name, `Environment variable ${name} must be a TCP port, got "${raw}"`);
  }
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      name,
      `Environment variable ${name} must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}

const DEFAULT_MAX_OP_AMOUNT = 5000;
/**
 * Жёсткий максимум: сумма выше него делается руками в админке, а не
 * инструментом. Отказ, а не тихое обрезание до потолка: оператор, поставивший
 * 999999, обязан узнать, что его значение не приняли, — иначе он уверен, что
 * поднял границу, а она осталась прежней.
 */
const HARD_MAX_OP_AMOUNT = 100_000;

function maxOpAmount(env: NodeJS.ProcessEnv): number {
  const value = positiveInt(env, 'HQ_MCP_MAX_OP_AMOUNT', DEFAULT_MAX_OP_AMOUNT);
  if (value > HARD_MAX_OP_AMOUNT) {
    throw new ConfigError(
      'HQ_MCP_MAX_OP_AMOUNT',
      `Environment variable HQ_MCP_MAX_OP_AMOUNT must not exceed the hard maximum ${String(HARD_MAX_OP_AMOUNT)}, got "${String(value)}". A larger operation is done by hand in the admin panel.`,
    );
  }
  return value;
}

/**
 * СКОЛЬКО КЛИЕНТОВ РАЗРЕШЕНО ЗАДЕТЬ ОДНОЙ МАССОВОЙ ОПЕРАЦИЕЙ.
 *
 * 100 — не круглое число ради круглости, а граница между двумя разными
 * действиями. Учёток в панели тысячи, а `sync_audit` находит единицы услуг с
 * настоящей поломкой. То есть настоящий масштаб починки — единицы и первые
 * десятки; операция, задевающая больше сотни, это уже не
 * починка, а смена политики, и она обязана быть отдельным осознанным решением
 * оператора, а не побочным следствием слишком широкого списка id. Сотня — ещё
 * и предел читаемости: список из ста строк человек глазами проверит, список из
 * тысячи он пролистает.
 *
 * Что этот дефолт означает на практике: `bulk/all/*` (операции по ВСЕМУ флоту)
 * при нём НЕ ПРОХОДЯТ: флот заведомо больше сотни, и план отвергается. Это не
 * побочный эффект, а и есть смысл потолка: чтобы задеть весь флот, оператор обязан
 * поднять границу руками и знать, какое число он ей называет.
 */
const DEFAULT_MAX_BULK_USERS = 100;
/**
 * Жёсткий максимум. Он ВЫШЕ размера флота намеренно: значение обязано остаться
 * поднимаемым до «весь флот и запас на рост», иначе `bulk/all/*` не проходил бы
 * никогда ни при какой настройке, и инструмент был бы предохранителем, который
 * не даёт сделать вообще ничего. Ловит эта граница другое — слипшийся лишний
 * ноль в числе, списанном с размера флота, и `999999` от оператора, который
 * решил, что потолок ему мешает.
 *
 * ВНИМАНИЕ: он НЕ отменяет потолка самой панели. Ручки `bulk/*` со списком id
 * объявляют `userIds: z.array(z.number()).min(1).max(500)` — 500 остаются
 * пределом одного вызова независимо от того, что стоит здесь.
 */
const HARD_MAX_BULK_USERS = 10_000;

function maxBulkUsers(env: NodeJS.ProcessEnv): number {
  const value = positiveInt(env, 'HQ_MCP_MAX_BULK_USERS', DEFAULT_MAX_BULK_USERS);
  if (value > HARD_MAX_BULK_USERS) {
    throw new ConfigError(
      'HQ_MCP_MAX_BULK_USERS',
      `Environment variable HQ_MCP_MAX_BULK_USERS must not exceed the hard maximum ${String(HARD_MAX_BULK_USERS)}, got "${String(value)}". A bulk operation touching more clients than that is done by hand in the admin panel, where every step is visible.`,
    );
  }
  return value;
}

/**
 * Зона проверяется здесь, а не по месту использования: с невалидной зоной
 * `Intl` бросает RangeError посреди ответа инструмента, а тихий откат к UTC
 * увёл бы каждый возраст задачи на офсет молча. Оба варианта хуже отказа
 * при старте.
 */
function timezone(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : raw;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new ConfigError(
      name,
      `Environment variable ${name} must be an IANA timezone such as "Europe/Moscow", got "${value}"`,
    );
  }
  return value;
}

/** Названа ли переменная вообще — пустая строка считается «не названа». */
function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  return value !== undefined && value !== '';
}

/**
 * КАЖДЫЙ БЭКЕНД НЕОБЯЗАТЕЛЕН, НО ПОЛОВИНЧАТЫМ БЫТЬ НЕ МОЖЕТ.
 *
 * Бэкенд считается ЗАТРЕБОВАННЫМ, если названа хоть одна его переменная. Тогда
 * обязательны все — с обычными отказами по имени переменной. Тихо выбросить
 * бэкенд, у которого забыли пароль, было бы худшим из исходов: сервер поднялся
 * бы, тринадцати инструментов в списке не оказалось, и объяснения этому не было
 * бы нигде. Опечатка в имени переменной — это ошибка, а не выбор развёртывания.
 */
function wants(env: NodeJS.ProcessEnv, backend: Backend): boolean {
  return (
    BACKEND_VARIABLES[backend].some((name) => isSet(env, name)) ||
    isSet(env, `${BACKEND_FILE_SOURCE[backend]}_FILE`)
  );
}

const NO_BACKEND_MESSAGE =
  'Neither of the two backends is configured: none of SHM_BASE_URL, SHM_ADMIN_AUTH, ' +
  'REMNA_BASE_URL or REMNA_API_TOKEN is set, so there is nothing for this server to read. ' +
  'At least ONE pair is required, and either pair alone is a complete configuration: ' +
  'SHM_BASE_URL + SHM_ADMIN_AUTH for the billing, REMNA_BASE_URL + REMNA_API_TOKEN for the ' +
  'Remnawave panel. Configure both only if you run both — the tools that need a system you ' +
  'do not have are simply not registered.';

const NO_BACKEND_HINT =
  'set EITHER SHM_BASE_URL + SHM_ADMIN_AUTH (billing) OR REMNA_BASE_URL + REMNA_API_TOKEN ' +
  '(panel), or both. `pnpm setup` asks which of the two you have and writes .env for you.';

/**
 * Какие бэкенды у этой конфигурации есть. Одно место, где `null` превращается в
 * булево: рантайм, проба и реестр обязаны отвечать на этот вопрос ОДИНАКОВО.
 */
export function backendPresence(cfg: HqMcpConfig): BackendPresence {
  return { shm: cfg.shm !== null, remna: cfg.remna !== null };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HqMcpConfig {
  const modeRaw = env.HQ_MCP_MODE?.trim() ?? 'ro';
  if (!isAccess(modeRaw)) {
    throw new ConfigError('HQ_MCP_MODE', `HQ_MCP_MODE must be "ro" or "rw", got "${modeRaw}"`);
  }

  const profileRaw = env.HQ_MCP_PROFILE?.trim() ?? 'human';
  if (!isProfile(profileRaw)) {
    throw new ConfigError(
      'HQ_MCP_PROFILE',
      `HQ_MCP_PROFILE must be "human" or "bot", got "${profileRaw}"`,
    );
  }

  const wantsShm = wants(env, 'shm');
  const wantsRemna = wants(env, 'remna');
  if (!wantsShm && !wantsRemna) {
    // `variable` всё-таки заполнен: на нём ключуется мастер установки. Но
    // подсказка идёт своя — «задайте SHM_BASE_URL» здесь неверно ровно
    // наполовину, и половина эта больше: у Remnawave операторов кратно больше,
    // чем у SHM.
    throw new ConfigError('SHM_BASE_URL', NO_BACKEND_MESSAGE, NO_BACKEND_HINT);
  }

  let shm: HqMcpConfig['shm'] = null;
  if (wantsShm) {
    shm = {
      baseUrl: url(env, 'SHM_BASE_URL'),
      auth: requiredFileBackedSecret(env, 'SHM_ADMIN_AUTH'),
    };
    const publicSecret = env.SHM_PUBLIC_SECRET?.trim();
    if (publicSecret !== undefined && publicSecret !== '') {
      // exactOptionalPropertyTypes: поле выставляется только когда значение есть.
      shm.publicSecret = publicSecret;
    }
  }

  const mysqlPort = env.HQ_MCP_TUNNEL_MYSQL_PORT?.trim();
  const tunnel: TunnelConfig = {
    abuseUrl: (env.HQ_MCP_TUNNEL_ABUSE_URL?.trim() ?? 'http://127.0.0.1:18099').replace(
      /\/+$/,
      '',
    ),
    postgres: {
      host: env.HQ_MCP_TUNNEL_HOST?.trim() ?? '127.0.0.1',
      port: port(env, 'HQ_MCP_TUNNEL_PG_PORT', 16767),
    },
    mysql:
      mysqlPort === undefined || mysqlPort === ''
        ? null
        : {
            host: env.HQ_MCP_TUNNEL_HOST?.trim() ?? '127.0.0.1',
            port: port(env, 'HQ_MCP_TUNNEL_MYSQL_PORT', 13306),
          },
    sshCommand: env.HQ_MCP_TUNNEL_SSH?.trim() ?? DEFAULT_SSH_COMMAND,
  };
  // exactOptionalPropertyTypes: поле выставляется только когда значение есть —
  // так же, как shm.publicSecret. Пустой токен и отсутствующий токен для
  // abuse_report одно и то же, и оба обязаны привести к отказу по имени
  // переменной, а не к 403 от хука.
  const abuseToken = env.HQ_MCP_GUARD_HOOK_TOKEN?.trim();
  if (abuseToken !== undefined && abuseToken !== '') {
    tunnel.abuseToken = abuseToken;
  }

  return {
    shm,
    remna: wantsRemna
      ? {
          baseUrl: url(env, 'REMNA_BASE_URL'),
          token: requiredFileBackedSecret(env, 'REMNA_API_TOKEN'),
        }
      : null,
    mode: modeRaw,
    profile: profileRaw,
    auditPath: env.HQ_MCP_AUDIT_PATH?.trim() ?? `${process.cwd()}/.hq-mcp/audit.jsonl`,
    snapshotDir: env.HQ_MCP_SNAPSHOT_DIR?.trim() ?? `${process.cwd()}/.hq-mcp/snapshots`,
    shmTz: timezone(env, 'HQ_MCP_SHM_TZ', 'Europe/Moscow'),
    tunnel,
    // 30/60с — вдвое ниже порога: то же ведро SHM делят apps/http и ai-bot (§6.14).
    budget: {
      limit: positiveInt(env, 'HQ_MCP_BUDGET_LIMIT', 30),
      windowMs: positiveInt(env, 'HQ_MCP_BUDGET_WINDOW_MS', 60_000),
    },
    mutations: { maxOpAmount: maxOpAmount(env), maxBulkUsers: maxBulkUsers(env) },
  };
}
