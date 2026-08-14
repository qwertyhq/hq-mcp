import { beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult, ToolContext, TunnelConfig } from '@hq/types';

type Params = Record<string, string | number | undefined>;
import { makeCtx, makeTcpProbe } from '../testkit.js';
import { createPlatformProbeTool, resetProbeCache } from './probe.js';

const tunnel: TunnelConfig = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: null,
  sshCommand: 'ssh -L 18099:192.0.2.10:8099 -L 16767:192.0.2.20:6767 jump-host',
};

const probeTool = (open: boolean | ((port: number) => boolean) = false) =>
  createPlatformProbeTool(tunnel, { probeTcp: makeTcpProbe(open) });

const call = async (
  ctx: ToolContext,
  opts: { refresh?: boolean; open?: boolean | ((port: number) => boolean) } = {},
): Promise<ProbeResult> =>
  (await probeTool(opts.open ?? false).handler(
    { refresh: opts.refresh ?? false },
    ctx,
  )) as ProbeResult;

const shmRoutes = (path: string): unknown => {
  // Настоящая форма ручки: SELECT status, COUNT(status) AS cnt ... GROUP BY
  // status (Core/Spool.pm:426-435). Ключа `name` в ответе нет вовсе, а
  // PROCESSING не существует в словаре статусов (Core/Const.pm:78-83) — прежняя
  // фикстура защищала выдуманную форму, и на живом стенде spoolStatuses
  // получался списком '[object Object]'.
  if (path === '/admin/spool/statuses') {
    return [
      { status: 'NEW', cnt: 3 },
      { status: 'DELAYED', cnt: 12 },
      { status: 'SUCCESS', cnt: 8410 },
    ];
  }
  if (path === '/admin/user') return { items: 1, limit: 1, offset: 0, data: [{ user_id: 1, block: 1 }] };
  // Live shape, taken from a running SHM: it stamps its own version into the
  // `_shm` config row, which is where Core/Swagger.pm reads info.version from.
  if (path === '/admin/config/_shm') {
    return [{ version: '2.19.4-61815d246e4cdc8849e20d3d0197329826fab31d', cache: {} }];
  }
  // Live shape, taken from a running SHM: the envelope carries TZ/date/items
  // too, but the client strips it down to `data`, so a tool only ever sees
  // this array.
  if (path === '/healthcheck') return [{ result: 'SUCCESS' }];
  throw new Error(`unexpected shm path ${path}`);
};

const remnaRoutes = (path: string, params?: Params): unknown => {
  // 3.x puts the version at the top level, not under `app`.
  if (path === '/api/system/metadata') {
    return { version: '3.2.3', build: { number: '215', time: '2026-08-10T21:00:25Z' } };
  }
  if (path === '/api/system/health') {
    return {
      runtimeMetrics: [
        { uptime: 33098.5, eventLoopDelayMs: 0.111, instanceId: '0', instanceType: 'api' },
        { uptime: 33099.7, eventLoopDelayMs: 0.108, instanceId: '1', instanceType: 'api' },
      ],
    };
  }
  if (path === '/api/system/configuration') {
    // Live shape, taken from a running panel where SRH recording is ON.
    return {
      notifications: { webhook: true },
      service: { disableSrhRecords: false, disableUserUsageRecords: false },
      misc: { shortUuidLength: 16 },
    };
  }
  if (path === '/api/users') {
    // The panel honours `filters`: a username that cannot exist narrows to zero.
    return params?.filters === undefined
      ? { users: [{ id: 11221 }], total: 137 }
      : { users: [], total: 0 };
  }
  if (path === '/api/bandwidth-stats/nodes/realtime') return [{ nodeUuid: 'n-1' }];
  throw new Error(`unexpected remna path ${path}`);
};

/**
 * Реальные `ShmError`/`RemnaError` несут `status`; стаб конструирует то же самое
 * без зависимости от @hq/shm или @hq/remna, чтобы проверить классификацию по
 * статусу, а не по тексту сообщения.
 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

describe('platform_probe', () => {
  beforeEach(() => {
    resetProbeCache();
  });

  it('is declared as a read-only tool for both profiles and gates on nothing itself', () => {
    const tool = probeTool();
    expect(tool.name).toBe('platform_probe');
    expect(tool.access).toBe('ro');
    expect(tool.profiles).toEqual(['human', 'bot']);
    // Probe не может требовать возможностей: он их и выясняет.
    expect(tool.requires).toBeUndefined();
  });

  it('reports reachability, versions and the stale-specs warning', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
      now: new Date('2026-08-08T12:00:00.000Z'),
    });
    const result = await call(ctx);
    expect(result.shm.reachable).toBe(true);
    expect(result.shm.spoolStatuses).toEqual(['NEW', 'DELAYED', 'SUCCESS']);
    expect(result.shm.live).toBe(true);
    expect(result.remna).toEqual({
      configured: true,
      reachable: true,
      error: null,
      version: '3.2.3',
      credentialsRejected: false,
      // Health is per PROCESS, and the panel runs several: the count is part of
      // the answer, and uptime is taken from the youngest of them.
      runtime: { instances: 2, youngestUptimeSeconds: 33098, worstEventLoopDelayMs: 0.111 },
    });
    // Read, not hardcoded: the probe reports what the deployment says it runs.
    expect(result.shm.version).toBe('2.19.4-61815d246e4cdc8849e20d3d0197329826fab31d');
    expect(result.checkedAt).toBe('2026-08-08T12:00:00.000Z');
    const stale = result.warnings.find((w) => w.code === 'specs_are_stale');
    expect(stale).toBeDefined();
    // The old text asserted "SHM 2.11.3 vs 2.18.2+, Remnawave 2.7.4 vs 2.8.0".
    // Both halves were false; nothing may be claimed that was not measured.
    expect(stale?.message).not.toMatch(/2\.11\.3|2\.18\.2|2\.7\.4|2\.8\.0/);
    expect(stale?.message).toContain('3.2.3');
    expect(stale?.message).toContain('2.19.4');
  });

  it('still warns about the specs when neither version could be read', async () => {
    const ctx = makeCtx({
      shmGet: () => {
        throw new Error('SHM 500');
      },
      shmList: shmRoutes,
      remnaGet: () => {
        throw new Error('panel 502');
      },
      now: new Date('2026-08-08T12:00:00.000Z'),
    });
    const result = await call(ctx);
    expect(result.shm.version).toBeNull();
    expect(result.remna.version).toBeNull();
    const stale = result.warnings.find((w) => w.code === 'specs_are_stale');
    // No version to name is not a licence to invent one.
    expect(stale?.message).toContain('could not be read');
  });

  it('resolves the open questions of §9 into a capability map', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
      now: new Date('2026-08-08T12:00:00.000Z'),
    });
    // postgres-конец туннеля открыт, mysql не опубликован вовсе (cfg.mysql === null)
    const result = await call(ctx, { open: (port) => port === 16767 });
    // Q1: server-side filter реально отсеял незаблокированных.
    expect(result.capabilities['shm.filter']).toBe(true);
    // Панель сама сказала, что журнал обращений за подпиской она ведёт.
    expect(result.capabilities['remna.subscriptionRequestHistory']).toBe(true);
    // Q17: маршрут realtime существует.
    expect(result.capabilities['remna.realtimeBandwidth']).toBe(true);
    expect(result.capabilities['tunnel.postgres']).toBe(true);
    expect(result.capabilities['tunnel.mysql']).toBe(false);
    // dry_run в работающей установке не проверяется чтением: остаётся
    // неизвестным честно.
    expect(result.capabilities['shm.dry_run']).toBe('unknown');
  });

  it('marks a capability false when the backend rejects the parameter (4xx)', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: (path, params) => {
        if (params?.filter !== undefined) throw new HttpError(400, 'unknown parameter filter');
        return shmRoutes(path);
      },
      remnaGet: (path, params) => {
        if (path === '/api/bandwidth-stats/nodes/realtime') throw new HttpError(404, 'Not Found');
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx, { open: false });
    // Бэкенд ОТВЕТИЛ и отверг именно этот параметр/маршрут — это и есть ответ
    // на вопрос «есть ли возможность», поэтому 400 и 404 остаются false.
    expect(result.capabilities['shm.filter']).toBe(false);
    expect(result.capabilities['remna.realtimeBandwidth']).toBe(false);
    expect(result.capabilities['tunnel.postgres']).toBe(false);
  });

  /**
   * Ровно та ошибка, ради которой заведена отдельная ветка: у ОСТАЛЬНЫХ
   * возможностей 4xx означает «бэкенд отверг этот параметр», то есть ответ по
   * существу. У конфигурации 4xx означает «маршрута нет» — он появился только в
   * 3.2.0, — и прочитать это как «панель историю не пишет» значило бы объявлять
   * ложь на каждой панели постарше.
   */
  it('never reads a missing configuration route as "the panel does not record history"', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        if (path === '/api/system/configuration') throw new HttpError(404, 'Cannot GET');
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    expect(result.capabilities['remna.subscriptionRequestHistory']).toBe('unknown');
  });

  it('reports the panel setting when subscription-request recording is switched off', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        if (path === '/api/system/configuration') {
          return { service: { disableSrhRecords: true } };
        }
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    expect(result.capabilities['remna.subscriptionRequestHistory']).toBe(false);
  });

  /**
   * Прежняя проба Q11 звала `searchValue` и рапортовала true ВСЕГДА: схема
   * запроса нестрогая, незнакомый ключ выбрасывается молча, ответ 200. Проверка
   * должна уметь провалиться — здесь панель отвечает 200 и на фильтрованный
   * запрос, но НЕ СУЖАЕТ выборку, и это ловится сравнением total.
   */
  it('catches a panel that answers 200 and ignores the user filter', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        if (path === '/api/users') return { users: [{ id: 11221 }], total: 137 };
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    expect(result.warnings.map((w) => w.code)).toContain('user_filter_not_applied');
  });

  it('stays silent about the user filter on an empty panel instead of claiming it works', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        // Ноль строк и в опорном, и в фильтрованном ответе: сужения не доказано
        // ни в одну сторону, и «фильтр работает» отсюда не следует.
        if (path === '/api/users') return { users: [], total: 0 };
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    expect(result.warnings.map((w) => w.code)).not.toContain('user_filter_not_applied');
  });

  /**
   * Главная причина существования этой пары полей: до неё живость SHM
   * доказывалась АДМИНСКИМ вызовом, и протухший пароль читался как отказ
   * системы. Неавторизованный healthcheck отвечает 200 и при заведомо неверном
   * Basic — проверено на работающей 2.19.4, а не взято из спецификации.
   */
  it('separates "the backend is down" from "our credentials are wrong"', async () => {
    const ctx = makeCtx({
      shmGet: (path) => {
        if (path === '/healthcheck') return [{ result: 'SUCCESS' }];
        throw new HttpError(401, 'Incorrect login or password');
      },
      shmList: () => {
        throw new HttpError(401, 'Incorrect login or password');
      },
      remnaGet: () => {
        throw new HttpError(401, 'Unauthorized');
      },
    });
    const result = await call(ctx);
    expect(result.shm.reachable).toBe(false);
    expect(result.shm.live).toBe(true);
    expect(result.shm.credentialsRejected).toBe(true);
    expect(result.remna.credentialsRejected).toBe(true);
    const rejected = result.warnings.find((w) => w.code === 'credentials_rejected');
    expect(rejected?.message).toContain('not an outage');
    // Ключевое отличие от отказа системы: инструменты не прячутся молча.
    expect(result.capabilities['shm.filter']).toBe('unknown');
  });

  it('does not claim SHM is alive when even the unauthenticated healthcheck fails', async () => {
    const ctx = makeCtx({
      shmGet: () => {
        throw new Error('socket hang up');
      },
      shmList: () => {
        throw new Error('socket hang up');
      },
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    // null, не false: сетевой обрыв ничего не доказал, а false здесь читалось бы
    // как «сервер лёг».
    expect(result.shm.live).toBeNull();
    expect(result.shm.credentialsRejected).toBe(false);
  });

  /**
   * СТАРАЯ SHM — НЕ МЁРТВАЯ SHM. Неавторизованный `/healthcheck` появился в
   * 2.18.0; ниже неё роутер отвечает `{"error":"Method not found","status":404}`
   * (форма снята с настоящего 404 работающей SHM). Прежняя ветка
   * `status < 500 → false` объявляла такую SHM мёртвой при полностью рабочем
   * админском вызове рядом.
   */
  it('reads a 404 on /healthcheck as a missing route, not as a dead billing', async () => {
    const ctx = makeCtx({
      shmGet: (path) => {
        if (path === '/healthcheck') throw new HttpError(404, 'Method not found');
        return shmRoutes(path);
      },
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    expect(result.shm.reachable).toBe(true);
    expect(result.shm.live).toBeNull();
    const absent = result.warnings.find((w) => w.code === 'shm_healthcheck_route_absent');
    expect(absent?.message).toContain('2.18.0');
    expect(absent?.message).toContain('not an outage');
  });

  it('still calls SHM dead when it answers a 4xx that is not a missing route', async () => {
    const ctx = makeCtx({
      shmGet: (path) => {
        if (path === '/healthcheck') throw new HttpError(400, 'Bad Request');
        return shmRoutes(path);
      },
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    expect(result.shm.live).toBe(false);
    expect(result.warnings.map((w) => w.code)).not.toContain('shm_healthcheck_route_absent');
  });

  it('names the version gap when a backend is older than this server was built against', async () => {
    const ctx = makeCtx({
      shmGet: (path) => {
        if (path === '/admin/config/_shm') return [{ version: '2.16.4-abc1234' }];
        if (path === '/healthcheck') throw new HttpError(404, 'Method not found');
        return shmRoutes(path);
      },
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        if (path === '/api/system/metadata') return { version: '2.8.1' };
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    const gap = result.warnings.find((w) => w.code === 'backend_version_below_minimum');
    expect(gap).toBeDefined();
    // Обе половины названы поимённо: версия, минимум и что именно отвалится.
    expect(gap?.message).toContain('2.16.4');
    expect(gap?.message).toContain('2.18.0');
    expect(gap?.message).toContain('2.8.1');
    expect(gap?.message).toContain('3.0.0');
    expect(gap?.message).toContain('/api/connections');
    // Инструменты при этом на месте: старость версии не прячет ни одного.
    expect(result.shm.reachable).toBe(true);
    expect(result.remna.reachable).toBe(true);
  });

  it('says nothing about versions when both backends are new enough', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    expect(result.warnings.map((w) => w.code)).not.toContain('backend_version_below_minimum');
  });

  /**
   * Непрочитанная версия — это НЕ «версия подходит». Молчание здесь означало бы
   * «проверено, всё в порядке» на установке, где не проверено ничего.
   */
  it('does not claim a version is high enough when it could not be read', async () => {
    const ctx = makeCtx({
      shmGet: (path) => {
        if (path === '/admin/config/_shm') throw new HttpError(500, 'boom');
        return shmRoutes(path);
      },
      shmList: shmRoutes,
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    expect(result.shm.version).toBeNull();
    expect(result.warnings.map((w) => w.code)).not.toContain('backend_version_below_minimum');
    // Единственное, что вправе быть сказано: версию назвать не удалось.
    const stale = result.warnings.find((w) => w.code === 'specs_are_stale');
    expect(stale?.message).toContain('could not be read');
  });

  it('warns when the panel restarted inside its own cache window', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: shmRoutes,
      remnaGet: (path, params) => {
        if (path === '/api/system/health') {
          return { runtimeMetrics: [{ uptime: 41.2, eventLoopDelayMs: 0.2 }] };
        }
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    expect(result.remna.runtime?.youngestUptimeSeconds).toBe(41);
    expect(result.warnings.map((w) => w.code)).toContain('panel_recently_restarted');
  });

  it('treats an unproven rejection (no status, or 5xx) as unknown, never false', async () => {
    const ctx = makeCtx({
      shmGet: shmRoutes,
      shmList: (path, params) => {
        // Сетевой сбой/таймаут: ошибка без статуса вообще — бэкенд ничего не
        // доказал, ни в одну, ни в другую сторону.
        if (params?.filter !== undefined) throw new Error('socket hang up');
        return shmRoutes(path);
      },
      remnaGet: (path, params) => {
        if (path === '/api/system/configuration') throw new HttpError(500, 'Internal Server Error');
        if (path === '/api/bandwidth-stats/nodes/realtime') {
          throw new HttpError(503, 'Service Unavailable');
        }
        return remnaRoutes(path, params);
      },
    });
    const result = await call(ctx);
    // Обе системы в остальном живы — деградация локальна к одному вызову, а не
    // ко всей системе, поэтому reachable не должен пострадать.
    expect(result.shm.reachable).toBe(true);
    expect(result.remna.reachable).toBe(true);
    // Битый деплой (5xx) или обрыв сети НЕ имеют права молча урезать набор
    // инструментов: сервер сломан, а не «возможности нет».
    expect(result.capabilities['shm.filter']).toBe('unknown');
    expect(result.capabilities['remna.subscriptionRequestHistory']).toBe('unknown');
    expect(result.capabilities['remna.realtimeBandwidth']).toBe('unknown');
  });

  it('publishes the result into ctx.probe so the registry can gate on it', async () => {
    const ctx = makeCtx({ shmGet: shmRoutes, shmList: shmRoutes, remnaGet: remnaRoutes });
    expect(ctx.probe.get()).toBeNull();
    await call(ctx);
    expect(ctx.probe.get()?.remna.version).toBe('3.2.3');
  });

  it('degrades softly when one system is down and keeps capabilities unknown', async () => {
    const ctx = makeCtx({
      shmGet: () => {
        throw new Error('SHM 403');
      },
      shmList: () => {
        throw new Error('SHM 403');
      },
      remnaGet: remnaRoutes,
    });
    const result = await call(ctx);
    expect(result.shm.reachable).toBe(false);
    expect(result.shm.error).toBe('SHM 403');
    expect(result.remna.reachable).toBe(true);
    // Система не ответила — это НЕ «возможности нет», это «не проверили».
    expect(result.capabilities['shm.filter']).toBe('unknown');
  });

  it('caches for five minutes and refreshes on demand', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      shmGet: (path) => {
        calls.push(path);
        return [];
      },
      shmList: () => ({ items: 0, limit: 1, offset: 0, data: [] }),
      remnaGet: () => ({}),
      now: new Date('2026-08-08T12:00:00.000Z'),
    });
    // Three SHM GETs per uncached run: the spool statuses, the `_shm` config
    // row the SHM version is read from, and the unauthenticated healthcheck.
    // What matters is that a cached run adds none of them.
    expect((await call(ctx)).cached).toBe(false);
    expect(calls).toHaveLength(3);
    expect((await call(ctx)).cached).toBe(true);
    expect(calls).toHaveLength(3);
    expect((await call(ctx, { refresh: true })).cached).toBe(false);
    expect(calls).toHaveLength(6);
  });
});
