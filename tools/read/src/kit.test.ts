import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHM_MAX_LIMIT } from '@hq/shm';
import type {
  Degraded,
  RemnaClient,
  ShmClient,
  ShmListResult,
  ToolContext,
  ToolWarning,
} from '@hq/types';
import {
  asArray,
  asRecord,
  capLimit,
  REMNA_PAGE_SIZE,
  REMNA_PROBE_PAGE_SIZE,
  SHM_PAGE_SIZE,
  readRemnaUserWindow,
  readShmRows,
  listOut,
  matchesKnownPrefix,
  MIN_REMNA_VERSION,
  MIN_SHM_VERSION,
  minutesSince,
  num,
  parseSettings,
  parseShmDate,
  parseVersion,
  resetPanelNamingCache,
  resolvePanelNaming,
  settle,
  sleep,
  str,
  take,
  telegramIdOf,
  versionBelow,
  ymd,
} from './kit.js';

describe('page sizes', () => {
  it('takes the SHM page size from the client cap instead of copying the number', () => {
    // Копия расходится молча и в худшую сторону: опустив потолок в клиенте,
    // readShmRows продолжил бы просить прежние 500, получал бы меньше, упирался
    // в `data.length < limit` и обрывал пагинацию на первой странице — sync_audit
    // отвечал бы частичным покрытием вместо отказа.
    expect(SHM_PAGE_SIZE).toBe(SHM_MAX_LIMIT);
  });
});

describe('settle / take', () => {
  it('captures a rejection as a degraded entry and returns the fallback', async () => {
    const degraded: Degraded[] = [];
    const failed = await settle(Promise.reject(new Error('SHM down')));
    expect(take(failed, 'shm', degraded, ['fallback'])).toEqual(['fallback']);
    expect(degraded).toEqual([{ system: 'shm', error: 'SHM down' }]);

    const ok = await settle(Promise.resolve(['real']));
    expect(take(ok, 'shm', degraded, ['fallback'])).toEqual(['real']);
    expect(degraded).toHaveLength(1);
  });
});

describe('coercion helpers', () => {
  it('caps and defaults limits', () => {
    expect(capLimit(undefined, 25, 200)).toBe(25);
    expect(capLimit(1000, 25, 200)).toBe(200);
    expect(capLimit(0, 25, 200)).toBe(25);
    expect(capLimit(-5, 25, 200)).toBe(25);
    expect(capLimit(50, 25, 200)).toBe(50);
  });

  it('normalises records, arrays, numbers and strings', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toEqual({});
    expect(asRecord(null)).toEqual({});
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray(null)).toEqual([]);
    // Байты в /api/system/* приезжают строками, а в /api/users числами (§6.17).
    expect(num('1073741824')).toBe(1073741824);
    expect(num(42)).toBe(42);
    expect(num('nope')).toBe(0);
    expect(str('  x ')).toBe('x');
    expect(str('')).toBeNull();
    expect(str(undefined)).toBeNull();
  });

  it('reads telegram chat_id out of settings in both shapes', () => {
    expect(telegramIdOf({ settings: { telegram: { chat_id: 900001 } } })).toBe(900001);
    expect(telegramIdOf({ settings: '{"telegram":{"chat_id":900002}}' })).toBe(900002);
    expect(telegramIdOf({ settings: 'not json' })).toBeNull();
    expect(telegramIdOf({})).toBeNull();
    expect(parseSettings('{"a":1}')).toEqual({ a: 1 });
  });

  it('formats a date as YYYY-MM-DD for bandwidth-stats', () => {
    expect(ymd(new Date('2026-08-08T21:13:00.000Z'))).toBe('2026-08-08');
  });
});

describe('listOut', () => {
  it('carries items/limit/offset outward and stays silent on a short page', () => {
    const warnings: ToolWarning[] = [];
    const out = listOut(
      { items: 3, limit: 25, offset: 0, data: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      warnings,
      'payments',
    );
    expect(out).toEqual({
      items: 3,
      limit: 25,
      offset: 0,
      data: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    expect(warnings).toEqual([]);
  });

  it('warns with the real total when the window was filled', () => {
    const warnings: ToolWarning[] = [];
    const out = listOut(
      { items: 8123, limit: 2, offset: 0, data: [{ id: 1 }, { id: 2 }] },
      warnings,
      'payments',
    );
    expect(out.items).toBe(8123);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('truncated');
    expect(warnings[0]?.message).toContain('8123');
    expect(warnings[0]?.message).toContain('payments');
  });
});

describe('readRemnaUserWindow', () => {
  const panel = (
    get: (path: string, params?: Record<string, string | number | undefined>) => unknown,
  ): RemnaClient =>
    ({
      get: async <T,>(path: string, params?: Record<string, string | number | undefined>) =>
        get(path, params) as T,
      send: async <T,>() => ({}) as T,
    }) as unknown as RemnaClient;

  it('reads the {users, total} envelope and reports the page size it asked for', async () => {
    const seen: Array<Record<string, string | number | undefined>> = [];
    const window = await readRemnaUserWindow(
      panel((_path, params) => {
        seen.push(params ?? {});
        return { users: [{ uuid: 'u-1' }, { uuid: 'u-2' }], total: 2 };
      }),
      5_000,
    );

    expect(window.rows).toEqual([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    expect(window.items).toBe(2);
    expect(window.complete).toBe(true);
    expect(window.error).toBeNull();
    expect(seen).toEqual([{ size: REMNA_PROBE_PAGE_SIZE, start: 0 }]);
  });

  it('measures the panel page cap instead of assuming it', async () => {
    // Панель молча отдаёт по 50 строк, сколько бы ни просили, и говорит, что
    // всего их 120. Предположить размер страницы нельзя — его надо измерить.
    const seen: number[] = [];
    const window = await readRemnaUserWindow(
      panel((_path, params) => {
        const start = Number(params?.start ?? 0);
        seen.push(Number(params?.size ?? 0));
        const users = Array.from({ length: Math.max(0, Math.min(50, 120 - start)) }, (_, i) => ({
          uuid: `u-${String(start + i)}`,
        }));
        return { users, total: 120 };
      }),
      5_000,
    );

    expect(window.pageSize).toBe(50);
    expect(window.rows).toHaveLength(120);
    expect(window.complete).toBe(true);
    // Первый запрос — пробный на полный размер, дальше уже по измеренному.
    expect(seen).toEqual([REMNA_PROBE_PAGE_SIZE, 50, 50]);
  });

  it('falls back to the conservative page size when the panel refuses a large one', async () => {
    const seen: number[] = [];
    const window = await readRemnaUserWindow(
      panel((_path, params) => {
        const size = Number(params?.size ?? 0);
        seen.push(size);
        if (size > REMNA_PAGE_SIZE) {
          throw Object.assign(new Error('HTTP 400: size must not be greater than 50'), {
            status: 400,
          });
        }
        return { users: [{ uuid: 'u-1' }], total: 1 };
      }),
      5_000,
    );

    expect(seen).toEqual([REMNA_PROBE_PAGE_SIZE, REMNA_PAGE_SIZE]);
    expect(window.pageSize).toBe(REMNA_PAGE_SIZE);
    expect(window.rows).toHaveLength(1);
    expect(window.complete).toBe(true);
  });

  it('does not retry a budget refusal at a smaller size', async () => {
    const seen: number[] = [];
    const window = await readRemnaUserWindow(
      panel((_path, params) => {
        seen.push(Number(params?.size ?? 0));
        const error = new Error('Local request budget is spent');
        error.name = 'BudgetExceededError';
        throw error;
      }),
      5_000,
    );

    expect(seen).toEqual([REMNA_PROBE_PAGE_SIZE]);
    expect(window.error).toContain('budget');
    expect(window.complete).toBe(false);
  });

  it('does not retry a transport failure at a smaller size', async () => {
    // 502 и таймаут — это не «панель не приняла размер»: вторая попытка стоит
    // ещё один запрос и заведомо упирается в то же самое.
    const seen: number[] = [];
    const window = await readRemnaUserWindow(
      panel((_path, params) => {
        seen.push(Number(params?.size ?? 0));
        throw Object.assign(new Error('Remnawave GET /api/users: HTTP 502'), { status: 502 });
      }),
      5_000,
    );

    expect(seen).toEqual([REMNA_PROBE_PAGE_SIZE]);
    expect(window.complete).toBe(false);
  });

  it('never claims a complete read when the panel omits total', async () => {
    // Голый массив без `total` (форма, которую kit сам объявляет возможной):
    // короткая страница неотличима от «панель молча обрезала», поэтому
    // полнотой это назвать нельзя.
    const window = await readRemnaUserWindow(
      panel(() => [{ uuid: 'u-1' }, { uuid: 'u-2' }, { uuid: 'u-3' }]),
      5_000,
    );

    expect(window.rows).toHaveLength(3);
    expect(window.items).toBeNull();
    expect(window.complete).toBe(false);
  });

  it('keeps the pages it already read when pagination breaks', async () => {
    let call = 0;
    const window = await readRemnaUserWindow(
      panel(() => {
        call += 1;
        if (call > 1) throw new Error('budget spent');
        return {
          users: Array.from({ length: REMNA_PROBE_PAGE_SIZE }, (_, i) => ({ uuid: `u-${String(i)}` })),
          total: 4_000,
        };
      }),
      5_000,
    );

    expect(window.rows).toHaveLength(REMNA_PROBE_PAGE_SIZE);
    expect(window.items).toBe(4_000);
    expect(window.complete).toBe(false);
    expect(window.error).toBe('budget spent');
  });

  it('respects the cap and says the read is not complete', async () => {
    const window = await readRemnaUserWindow(
      panel(() => ({ users: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }], total: 3 })),
      2,
    );
    expect(window.rows).toHaveLength(2);
    expect(window.complete).toBe(false);
  });
});

describe('readShmRows', () => {
  const shm = (
    list: (path: string, params?: Record<string, string | number | undefined>) => unknown,
  ): ShmClient =>
    ({
      list: async <T,>(path: string, params?: Record<string, string | number | undefined>) =>
        list(path, params) as ShmListResult<T>,
      get: async <T,>() => ({}) as T,
      action: async <T,>() => ({}) as T,
      getRaw: async <T,>() => ({}) as T,
      sendRaw: async <T,>() => ({}) as T,
    }) as unknown as ShmClient;

  it('pages by offset until it has covered the rows the server reported', async () => {
    const seen: Array<{ limit: unknown; offset: unknown }> = [];
    const result = await readShmRows(
      shm((_path, params) => {
        seen.push({ limit: params?.limit, offset: params?.offset });
        const offset = Number(params?.offset ?? 0);
        return {
          items: 1_100,
          limit: SHM_PAGE_SIZE,
          offset,
          data: Array.from({ length: Math.max(0, Math.min(SHM_PAGE_SIZE, 1_100 - offset)) }, (_, i) => ({
            id: offset + i,
          })),
        };
      }),
      '/admin/user/service',
      {},
      5_000,
    );

    expect(result.rows).toHaveLength(1_100);
    expect(result.items).toBe(1_100);
    expect(result.complete).toBe(true);
    expect(seen).toEqual([
      { limit: SHM_PAGE_SIZE, offset: 0 },
      { limit: SHM_PAGE_SIZE, offset: SHM_PAGE_SIZE },
      { limit: SHM_PAGE_SIZE, offset: SHM_PAGE_SIZE * 2 },
    ]);
  });

  it('keeps the rows it already read when a later page fails', async () => {
    let call = 0;
    const result = await readShmRows(
      shm(() => {
        call += 1;
        if (call > 1) throw new Error('shm 500');
        return {
          items: 1_100,
          limit: SHM_PAGE_SIZE,
          offset: 0,
          data: Array.from({ length: SHM_PAGE_SIZE }, (_, i) => ({ id: i })),
        };
      }),
      '/admin/user',
      {},
      5_000,
    );

    expect(result.rows).toHaveLength(SHM_PAGE_SIZE);
    expect(result.items).toBe(1_100);
    expect(result.complete).toBe(false);
    expect(result.error).toBe('shm 500');
  });

  it('stops at the cap and reports the read as incomplete', async () => {
    const result = await readShmRows(
      shm((_path, params) => {
        const offset = Number(params?.offset ?? 0);
        return {
          items: 9_382,
          limit: Number(params?.limit ?? 0),
          offset,
          data: Array.from({ length: Number(params?.limit ?? 0) }, (_, i) => ({ id: offset + i })),
        };
      }),
      '/admin/user/service',
      {},
      600,
    );

    expect(result.rows).toHaveLength(600);
    expect(result.items).toBe(9_382);
    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
  });

  it('does not loop forever when the server ignores offset and returns nothing', async () => {
    const result = await readShmRows(
      shm(() => ({ items: 9_382, limit: SHM_PAGE_SIZE, offset: 0, data: [] })),
      '/admin/user',
      {},
      5_000,
    );
    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(false);
  });
});

describe('sleep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unrefs its timer so it cannot keep a long-lived process alive', async () => {
    let unrefCalled = false;
    const fakeTimer = {
      unref: () => {
        unrefCalled = true;
        return fakeTimer;
      },
      ref: () => fakeTimer,
      hasRef: () => false,
      refresh: () => fakeTimer,
      [Symbol.toPrimitive]: () => 0,
    } as unknown as NodeJS.Timeout;

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb();
      return fakeTimer;
    }) as unknown as typeof setTimeout);

    await sleep(1_000);
    expect(unrefCalled).toBe(true);
  });
});

/**
 * SHM пишет даты через Core::Utils::now — strftime("%Y-%m-%d %H:%M:%S",
 * localtime) (app/lib/Core/Utils.pm:133-141): локальное время СЕРВЕРА, без
 * офсета и без `Z`. Сервер живёт в Europe/Moscow (TZ в
 * docker-compose.staging.yml:27, docker-compose.test.yml:24,
 * contributing/docker-compose.yml:25, helm/k8s-shm/values.yaml), поэтому
 * прочитать такой штамп как UTC — это ошибка ровно в размер офсета, и она
 * молчаливая: возраст уходит в минус и ни одна свежая задача не проходит порог.
 */
describe('parseShmDate / minutesSince', () => {
  const now = new Date('2026-08-08T12:00:00.000Z'); // 15:00 в Москве

  it('reads a naive stamp in the configured zone', () => {
    expect(parseShmDate('2026-08-08 14:30:00', 'Europe/Moscow')?.toISOString()).toBe(
      '2026-08-08T11:30:00.000Z',
    );
    expect(minutesSince(now, '2026-08-08 14:30:00', 'Europe/Moscow')).toBe(30);
  });

  it('honours a stamp that carries its own offset', () => {
    expect(minutesSince(now, '2026-08-08T11:30:00Z', 'Europe/Moscow')).toBe(30);
    expect(minutesSince(now, '2026-08-08T14:30:00+03:00', 'Asia/Tokyo')).toBe(30);
  });

  it('reads the same naive stamp differently in a different zone', () => {
    // Ровно тот случай, который делает инструмент немым: московский штамп,
    // прочитанный как UTC, оказывается на три часа в будущем.
    expect(minutesSince(now, '2026-08-08 14:30:00', 'UTC')).toBe(-150);
  });

  it('takes the offset at the stamp instant, not at "now"', () => {
    // Нью-Йорк зимой UTC-5, летом UTC-4: офсет обязан считаться на момент самой
    // метки, иначе на границе перехода возраст уедет на час.
    expect(minutesSince(new Date('2026-01-15T17:00:00Z'), '2026-01-15 11:30:00', 'America/New_York'))
      .toBe(30);
    expect(minutesSince(new Date('2026-07-15T16:00:00Z'), '2026-07-15 11:30:00', 'America/New_York'))
      .toBe(30);
  });

  it('returns null for junk instead of a number computed from NaN', () => {
    expect(parseShmDate(null, 'Europe/Moscow')).toBeNull();
    expect(parseShmDate('', 'Europe/Moscow')).toBeNull();
    expect(parseShmDate('0000-00-00 00:00:00', 'Europe/Moscow')).toBeNull();
    expect(minutesSince(now, 'not a date', 'Europe/Moscow')).toBeNull();
    expect(minutesSince(now, undefined, 'Europe/Moscow')).toBeNull();
  });

  it('falls back to UTC on an unknown zone rather than throwing mid-answer', () => {
    // Невалидная зона отсекается в loadConfig; если она всё же доехала сюда,
    // ответ не должен превращаться в исключение — расхождение поймает
    // clock_skew, который назовёт зону вслух.
    expect(minutesSince(now, '2026-08-08 12:30:00', 'Mars/Olympus')).toBe(-30);
  });
});

describe('resolvePanelNaming', () => {
  const at = new Date('2026-08-08T12:00:00.000Z');

  /**
   * Ответ SHM на `GET /admin/config/<key>`: `api_data_by_name` отдаёт САМО
   * значение ключа, а v1.cgi заворачивает его в `{data:[<value>]}`, поэтому
   * клиент после снятия конверта возвращает массив из одной строки. Ключа нет
   * — приезжает `[{}]`, ровно как на работающей SHM.
   */
  const shmWith = (value: unknown, calls?: string[]): ShmClient =>
    ({
      get: async (path: string): Promise<unknown> => {
        calls?.push(path);
        return path === '/admin/config/remnawave' ? [value] : undefined;
      },
    }) as unknown as ShmClient;

  const ctxWith = (shm: ShmClient): ToolContext =>
    ({ shm, now: () => at }) as unknown as ToolContext;

  beforeEach(() => {
    resetPanelNamingCache();
  });

  it('falls back to the template defaults when SHM carries no remnawave config', async () => {
    // Состояние, снятое с работающей установки: ключа `remnawave` в таблице
    // config нет, поэтому шаблон работает на своих умолчаниях — и они обязаны
    // совпадать с тем, чем инструмент ищет.
    const naming = await resolvePanelNaming(ctxWith(shmWith({})), {});

    expect(naming.storagePrefix).toBe('vpn_mrzb_');
    expect(naming.usernamePrefixes).toEqual(['HQVPN_', 'remnawave_', 'us_']);
    expect(naming.storagePrefixFrom).toBe('default');
    expect(naming.usernamePrefixesFrom).toBe('default');
    expect(naming.configError).toBeNull();
  });

  it('reads both prefixes from the live SHM config instead of asking anyone', async () => {
    const naming = await resolvePanelNaming(
      ctxWith(shmWith({ storage_prefix: 'acme_cfg_', name_prefix: 'ACME_' })),
      {},
    );

    expect(naming.storagePrefix).toBe('acme_cfg_');
    expect(naming.storagePrefixFrom).toBe('shm_config');
    expect(naming.usernamePrefixes).toEqual(['ACME_']);
    expect(naming.usernamePrefixesFrom).toBe('shm_config');
  });

  it('does not lend our legacy prefixes to an install that named itself', async () => {
    // `us_2024` в чужой панели — почти наверняка заведённый руками аккаунт;
    // разобранный по НАШЕМУ списку он превращается в «услугу 2024» и уезжает
    // в корзину с рекомендацией удалить. Своя история задаётся переменной.
    const naming = await resolvePanelNaming(ctxWith(shmWith({ name_prefix: 'ACME_' })), {});

    expect(naming.usernamePrefixes).not.toContain('us_');
    expect(naming.usernamePrefixes).not.toContain('remnawave_');
  });

  it('lets the environment override both the live value and the default', async () => {
    const naming = await resolvePanelNaming(
      ctxWith(shmWith({ storage_prefix: 'from_shm_', name_prefix: 'FROM_SHM_' })),
      {
        HQ_MCP_STORAGE_PREFIX: 'from_env_',
        HQ_MCP_PANEL_PREFIXES: 'FROM_ENV_, LEGACY_ ,, FROM_ENV_',
      },
    );

    expect(naming.storagePrefix).toBe('from_env_');
    expect(naming.storagePrefixFrom).toBe('env');
    // Пустые записи и повторы выброшены: порядок — это ранг каноничности, и
    // дубль в нём сдвинул бы наследные имена.
    expect(naming.usernamePrefixes).toEqual(['FROM_ENV_', 'LEGACY_']);
    expect(naming.usernamePrefixesFrom).toBe('env');
  });

  it('treats an empty variable as unset rather than as an empty prefix', async () => {
    const naming = await resolvePanelNaming(ctxWith(shmWith({})), {
      HQ_MCP_STORAGE_PREFIX: '   ',
      HQ_MCP_PANEL_PREFIXES: ' , ',
    });

    expect(naming.storagePrefix).toBe('vpn_mrzb_');
    expect(naming.usernamePrefixes).toEqual(['HQVPN_', 'remnawave_', 'us_']);
  });

  it('keeps the previous behaviour when the config read fails, and says it did', async () => {
    // Провал этого чтения возвращает ровно прежнее поведение — умолчания
    // шаблона, — поэтому он не degraded и не partial_result. Но и молчать
    // нельзя: `configError` отличает «спросили, ключа нет» от «спросить не
    // удалось».
    const shm = {
      get: async (): Promise<unknown> => {
        throw new Error('SHM down');
      },
    } as unknown as ShmClient;
    const naming = await resolvePanelNaming(ctxWith(shm), {});

    expect(naming.storagePrefix).toBe('vpn_mrzb_');
    expect(naming.usernamePrefixes).toEqual(['HQVPN_', 'remnawave_', 'us_']);
    expect(naming.configError).toBe('SHM down');
  });

  it('asks SHM once per process, not once per service in the loop', async () => {
    const calls: string[] = [];
    const ctx = ctxWith(shmWith({ name_prefix: 'ACME_' }, calls));
    await resolvePanelNaming(ctx, {});
    await resolvePanelNaming(ctx, {});
    await resolvePanelNaming(ctx, {});

    expect(calls).toEqual(['/admin/config/remnawave']);
  });

  it('matchesKnownPrefix answers about the PREFIX, not about the digits after it', () => {
    // sync_audit разбирает имя целиком (префикс + число), но вопрос «тем ли
    // ключом мы вообще ищем» решается префиксом: `HQVPN_TEST001` — стенд
    // провижининга, и он доказывает, что префикс верный, хотя услуги за ним нет.
    expect(matchesKnownPrefix('HQVPN_TEST001', ['HQVPN_'])).toBe(true);
    expect(matchesKnownPrefix('legacy-account', ['HQVPN_', 'us_'])).toBe(false);
    expect(matchesKnownPrefix(null, ['HQVPN_'])).toBe(false);
  });
});

describe('parseVersion / versionBelow', () => {
  it('drops the commit sha SHM glues onto its own version string', () => {
    // `_shm.version` — это `<тег>-<полный sha>`; сравнивать sha бессмысленно, а
    // отказаться разбирать такую строку значило бы никогда не проверить SHM.
    expect(parseVersion('2.19.4-61815d246e4cdc8849e20d3d0197329826fab31d')).toEqual([2, 19, 4]);
    expect(parseVersion('3.2.3')).toEqual([3, 2, 3]);
    expect(parseVersion('v1.0.0')).toEqual([1, 0, 0]);
  });

  it('refuses to invent numbers out of a string it does not recognise', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
    // Двух чисел мало: '2.19' — это не версия, а её обрезок, и достраивать
    // третье число за бэкенд значит утверждать то, чего он не говорил.
    expect(parseVersion('2.19')).toBeNull();
  });

  it('compares field by field, not lexicographically', () => {
    // Строковое сравнение поставило бы '2.9.0' выше '2.18.0' и объявило бы
    // старую SHM подходящей.
    expect(versionBelow('2.9.0', '2.18.0')).toBe(true);
    expect(versionBelow('2.18.0', '2.18.0')).toBe(false);
    expect(versionBelow('2.19.4-abc', '2.18.0')).toBe(false);
    expect(versionBelow('2.8.1', '3.0.0')).toBe(true);
    expect(versionBelow('3.2.3', '3.0.0')).toBe(false);
  });

  it('answers unknown — never "fine" — when the version could not be read', () => {
    expect(versionBelow(null, MIN_SHM_VERSION)).toBe('unknown');
    expect(versionBelow('n/a', MIN_REMNA_VERSION)).toBe('unknown');
  });

  it('states the floors as versions, not as prose', () => {
    expect(parseVersion(MIN_SHM_VERSION)).toEqual([2, 18, 0]);
    expect(parseVersion(MIN_REMNA_VERSION)).toEqual([3, 0, 0]);
  });
});
