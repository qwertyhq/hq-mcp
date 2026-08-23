import { afterAll, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigError } from '@hq/env';
import { DEFAULT_HTTP_PORT } from './config.js';
import {
  bootstrap,
  exposureWarning,
  isEntrypoint,
  listenUrl,
  loadDotEnv,
  readVersion,
  startupErrorMessage,
} from './index.js';
import { AUTH_HEADERS, TEST_TOKEN } from './testing.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Апстримы — те же плейсхолдеры, что в тестах @hq/runtime: `.test` не
 * резолвится, а `mcp:secret`/`jwt-token` перечислены в PLACEHOLDER_RE
 * (@hq/redact/shapes), поэтому `scripts/no-secrets.test.ts` не читает их как
 * присвоенный секрет. Ни один тест ниже в сеть не ходит.
 */
const UPSTREAMS: Record<string, string> = {
  SHM_BASE_URL: 'https://billing.example.test/shm/v1',
  SHM_ADMIN_AUTH: 'mcp:secret',
  REMNA_BASE_URL: 'https://panel.example.test',
  REMNA_API_TOKEN: 'jwt-token',
};

/**
 * Полное рабочее окружение. Значение HQ_MCP_HTTP_TOKENS стоит здесь ЛИТЕРАЛОМ,
 * а не собранным из TEST_TOKEN: тот же страж краснеет на присваивании
 * секретоподобному ИМЕНИ значения, не похожего на плейсхолдер, а шаблонная
 * строка `bot:${…}` на плейсхолдер не похожа. Литерал начинается с `example` —
 * ровно по той же причине, что и сам TEST_TOKEN в testing.ts. То, что эти два
 * места не разъехались, проверяется первым же тестом ниже.
 */
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    ...UPSTREAMS,
    HQ_MCP_HTTP_TOKENS: 'example:example-token-0123456789abcdef',
    HQ_MCP_IMAGE_REVISION: '0000000000000000000000000000000000000000',
    HQ_MCP_DEPLOYMENT_CONFIG_REVISION: '11111111-1111-4111-8111-111111111111',
    ...over,
  }) as NodeJS.ProcessEnv;

/** Окружение с токенами, но без единой настроенной системы. */
const withoutUpstreams = (): NodeJS.ProcessEnv => {
  const only = env();
  for (const name of Object.keys(UPSTREAMS)) delete only[name];
  return only;
};

/**
 * СЕРВЕР, КОТОРЫЙ ПОДНЯЛСЯ БЕЗ ТОКЕНА, ПУСКАЕТ ВСЕХ. Проверка транспортных
 * настроек идёт ПЕРВОЙ, до кредов апстримов, именно поэтому: отказать надо
 * раньше, чем процесс вообще соберёт клиентов к биллингу.
 */
describe('bootstrap: без токена сервер не собирается', () => {
  it('фикстура окружения несёт тот же токен, что AUTH_HEADERS', () => {
    expect(env().HQ_MCP_HTTP_TOKENS).toBe(`example:${TEST_TOKEN}`);
  });

  it('пустой HQ_MCP_HTTP_TOKENS — отказ с именем переменной', () => {
    const broken = { ...UPSTREAMS } as NodeJS.ProcessEnv;
    expect(() => bootstrap(broken, MODULE_DIR)).toThrow(ConfigError);
    try {
      bootstrap(broken, MODULE_DIR);
      throw new Error('expected bootstrap to refuse');
    } catch (error: unknown) {
      expect((error as ConfigError).variable).toBe('HQ_MCP_HTTP_TOKENS');
    }
  });

  it('короткий токен — тоже отказ, а не «ну ладно»', () => {
    expect(() => bootstrap(env({ HQ_MCP_HTTP_TOKENS: 'bot:short' }), MODULE_DIR)).toThrow(
      /shorter than/,
    );
  });

  /**
   * Токены проверяются РАНЬШЕ кредов апстримов. Видно это так: конфигурация без
   * единого бэкенда И без токенов обязана назвать токены, а не бэкенды — иначе
   * порядок молча перевернулся, и клиенты к биллингу собираются до
   * того, как решено, будет ли у ручки аутентификация вообще.
   */
  it('о токенах узнаём раньше, чем о ненастроенных системах', () => {
    try {
      bootstrap({} as NodeJS.ProcessEnv, MODULE_DIR);
      throw new Error('expected bootstrap to refuse');
    } catch (error: unknown) {
      expect((error as ConfigError).variable).toBe('HQ_MCP_HTTP_TOKENS');
    }
  });

  it('ненастроенные системы — отказ @hq/env с обеими подсказками', () => {
    try {
      bootstrap(withoutUpstreams(), MODULE_DIR);
      throw new Error('expected bootstrap to refuse');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(startupErrorMessage(error)).toContain('REMNA_BASE_URL + REMNA_API_TOKEN');
    }
  });
});

describe('bootstrap: собранное приложение', () => {
  it('поднимает живой /healthz с настоящей версией пакета', async () => {
    const { app } = bootstrap(env(), MODULE_DIR);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('hq-mcp-http');
    expect(body.mode).toBe('ro');
    expect(body.profile).toBe('human');
    expect(body.version).toBe(readVersion(MODULE_DIR));
    expect(body.version).not.toBe('0.0.0');
    expect(body.imageRevision).toBeNull();
    expect(body.deploymentConfigRevision).toBeNull();
    // Реестр настоящий: пустой список означал бы, что рантайм собрался мимо.
    expect(body.tools).toBeGreaterThan(10);
  });

  it('токен из окружения — тот самый, который пускает', async () => {
    const { app } = bootstrap(env(), MODULE_DIR);
    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', { headers: AUTH_HEADERS })).status).toBe(200);
  });

  it('метрики, которые считает приложение, — те, что вернул bootstrap', async () => {
    const { app, deps } = bootstrap(env(), MODULE_DIR);
    await app.request('/metrics');
    expect(deps.metrics.snapshot().auth).toEqual({ ok: 0, rejected: 1 });
  });

  /**
   * ВЕДРО ОДНО НА ПРОЦЕСС, И ЕГО ПОТОЛОК ПРИХОДИТ ИЗ ОКРУЖЕНИЯ.
   *
   * Свежий `new Budget(...)` вместо рантаймового выглядел бы точно так же и
   * работал бы — ровно до настоящего прогона, где апстримы получили бы вдвое
   * больше запросов, чем считает §6.14. Проверяется поэтому наблюдаемо: при
   * потолке в 1 второй вызов обязан упереться. Имя инструмента заведомо
   * несуществующее — слот берётся предполётно, до обращения к реестру, и в
   * апстрим при этом не ходит никто.
   */
  it('бюджет — единственный на процесс, с потолком из HQ_MCP_BUDGET_LIMIT', async () => {
    const { app } = bootstrap(env({ HQ_MCP_BUDGET_LIMIT: '1' }), MODULE_DIR);
    const call = async (): Promise<Response> =>
      app.request('/v1/tools/__no_such_tool__', { method: 'POST', headers: AUTH_HEADERS });
    expect((await call()).status).toBe(404);
    expect((await call()).status).toBe(429);
  });

  it('режим и профиль доезжают из окружения до контекста', () => {
    const { deps } = bootstrap(env({ HQ_MCP_MODE: 'rw', HQ_MCP_PROFILE: 'bot' }), MODULE_DIR);
    expect(deps.ctx.mode).toBe('rw');
    expect(deps.ctx.profile).toBe('bot');
    expect(deps.imageRevision).toBe('0000000000000000000000000000000000000000');
    expect(deps.deploymentConfigRevision).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('bootstrap: адрес и порт', () => {
  it('по умолчанию — только петля', () => {
    expect(bootstrap(env(), MODULE_DIR).http).toMatchObject({
      host: '127.0.0.1',
      port: DEFAULT_HTTP_PORT,
    });
  });

  it('переопределяются окружением', () => {
    const { http } = bootstrap(
      env({ HQ_MCP_HTTP_HOST: '0.0.0.0', HQ_MCP_HTTP_PORT: '42999' }),
      MODULE_DIR,
    );
    expect(http).toMatchObject({ host: '0.0.0.0', port: 42999 });
  });

  it('мусор в порту — отказ на старте, а не случайный порт', () => {
    expect(() => bootstrap(env({ HQ_MCP_HTTP_PORT: 'abc' }), MODULE_DIR)).toThrow(
      /HQ_MCP_HTTP_PORT/,
    );
  });
});

describe('listenUrl', () => {
  it('печатает адрес, который можно скопировать в curl', () => {
    expect(listenUrl('127.0.0.1', 42480)).toBe('http://127.0.0.1:42480');
  });

  it('берёт IPv6 в скобки — без них строка не адрес, а мусор', () => {
    expect(listenUrl('::1', 42480)).toBe('http://[::1]:42480');
  });
});

describe('exposureWarning', () => {
  it('молчит на петле', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(exposureWarning(host)).toBe(null);
    }
  });

  it('кричит на всём остальном: снаружи между сетью и кредами один Bearer', () => {
    const warning = exposureWarning('0.0.0.0');
    expect(warning).toContain('0.0.0.0');
    expect(warning).toContain('HQ_MCP_HTTP_HOST');
  });
});

/**
 * Единственное, что видит человек, у которого сервер не поднялся. Стек трассы
 * не чинит ни одного из этих отказов, а имя переменной — чинит все.
 */
describe('startupErrorMessage', () => {
  it('называет переменную и место, куда её писать', () => {
    const message = startupErrorMessage(new ConfigError('HQ_MCP_HTTP_PORT', 'boom'));
    expect(message).toContain('fatal: boom');
    expect(message).toContain('hint: set HQ_MCP_HTTP_PORT=');
    expect(message).toContain('.env');
  });

  it('своя подсказка ConfigError бьёт общую', () => {
    const message = startupErrorMessage(new ConfigError('SHM_BASE_URL', 'boom', 'do this instead'));
    expect(message).toBe('fatal: boom\nhint: do this instead');
  });

  it('занятый порт объясняется портом, а не трассой', () => {
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    const message = startupErrorMessage(busy);
    expect(message).toContain('HQ_MCP_HTTP_PORT');
    expect(message).not.toContain('at ');
  });

  it('чужой адрес объясняется хостом', () => {
    const message = startupErrorMessage(
      Object.assign(new Error('nope'), { code: 'EADDRNOTAVAIL' }),
    );
    expect(message).toContain('HQ_MCP_HTTP_HOST');
  });

  it('всё прочее — одной строкой, без стека', () => {
    expect(startupErrorMessage(new Error('boom'))).toBe('fatal: boom');
    expect(startupErrorMessage('not an error')).toBe('fatal: not an error');
  });
});

describe('readVersion', () => {
  it('читает версию собственного пакета', () => {
    const declared = JSON.parse(
      readFileSync(join(MODULE_DIR, '..', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(readVersion(MODULE_DIR)).toBe(declared.version);
  });

  it('не роняет сервер, когда package.json недостижим', () => {
    expect(readVersion(join(tmpdir(), 'no-such-dir-for-hq-mcp'))).toBe('0.0.0');
  });
});

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'hq-http-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Отказ этой проверки не выглядит как отказ: main() просто не зовётся, процесс
 * выходит с кодом 0, не написав ни строки. Симлинк здесь не экзотика — это
 * ровно то, что делает объявленный в package.json `bin`.
 */
describe('isEntrypoint', () => {
  const target = join(dir, 'index.js');
  writeFileSync(target, '');
  const link = join(dir, 'hq-mcp-http');
  symlinkSync(target, link);
  const moduleUrl = pathToFileURL(target).href;

  it('узнаёт прямой запуск', () => {
    expect(isEntrypoint(moduleUrl, target)).toBe(true);
  });

  it('узнаёт запуск через симлинк bin', () => {
    expect(isEntrypoint(moduleUrl, link)).toBe(true);
  });

  it('молчит, когда модуль просто импортировали', () => {
    expect(isEntrypoint(moduleUrl, join(dir, 'vitest.js'))).toBe(false);
    expect(isEntrypoint(moduleUrl, undefined)).toBe(false);
  });
});

/**
 * Контракт тот же, что у копии в apps/stdio: пока функция живёт в двух файлах,
 * оба обязаны вести себя одинаково. Проверка стоит здесь ровно затем, чтобы
 * расхождение было слышно до переезда в общий пакет.
 */
describe('loadDotEnv', () => {
  it('находит .env вверх по дереву и не затирает уже заданное', () => {
    const root = mkdtempSync(join(tmpdir(), 'hq-http-dotenv-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.env'), 'FROM_FILE=file\nALREADY=fromfile\n# комментарий\nBAD\n');
    const seen: NodeJS.ProcessEnv = { ALREADY: 'fromenv' };

    expect(loadDotEnv(nested, seen)).toBe(join(root, '.env'));
    expect(seen.FROM_FILE).toBe('file');
    expect(seen.ALREADY).toBe('fromenv');
    expect('BAD' in seen).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('возвращает null, когда .env нигде нет', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hq-http-dotenv-none-'));
    expect(loadDotEnv(empty, {})).toBe(null);
    rmSync(empty, { recursive: true, force: true });
  });
});
