import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShmListResult } from '@hq/types';
import { makeCtx } from '../testkit.js';
import type { StubCall } from '../testkit.js';
import { REMNA_PROBE_PAGE_SIZE, SHM_PAGE_SIZE, resetPanelNamingCache } from '../kit.js';
import { syncAudit } from './audit.js';

interface Bucket {
  [key: string]: unknown;
}

interface Cover {
  items: number | null;
  read: number;
  complete: boolean;
}

interface AuditOut {
  coverage: {
    services: Cover;
    unblockedClients: Cover;
    blockedClients: Cover;
    panelUsers: Cover & { pageSize: number; usable: number };
  };
  complete: { shm: boolean; panel: boolean };
  findings: {
    missingPanelUser?: Bucket[];
    orphanPanelUser?: Bucket[];
    unlinkable?: Bucket[];
    unlistedService?: Bucket[];
    statusMismatch?: Bucket[];
    quotaExhausted?: Bucket[];
    blockedButActiveInPanel?: Bucket[];
  };
  counts: Record<string, number>;
  suppressed: Array<{ bucket: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

type Row = Record<string, unknown>;
type Params = Record<string, string | number | undefined> | undefined;

/** Списочная ручка SHM, честно отдающая запрошенную страницу. */
function pager(rows: Row[], items = rows.length) {
  return (params?: Params): ShmListResult<Row> => {
    const offset = Number(params?.offset ?? 0);
    const limit = Number(params?.limit ?? SHM_PAGE_SIZE);
    return { items, limit, offset, data: rows.slice(offset, offset + limit) };
  };
}

const isBlockedCall = (params: Params): boolean => typeof params?.filter === 'string';

const services: Row[] = [
  { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
  { user_service_id: 52, user_id: 2, status: 'ACTIVE' },
  { user_service_id: 53, user_id: 3, status: 'BLOCK' },
];

const clients: Row[] = [
  { user_id: 1, login: '@111', settings: { telegram: { chat_id: 111 } } },
  { user_id: 2, login: '@222', settings: { telegram: { chat_id: 222 } } },
  { user_id: 3, login: 'c', settings: {} },
];

/**
 * Самая частая форма в работающей установке: telegramId в панели ПУСТ (шаблон
 * пишет его только на CREATE и только если chat_id уже был), а связь несут
 * username и описание.
 */
const panelForService51: Row = {
  id: 9051,
  username: 'HQVPN_51',
  telegramId: null,
  status: 'ACTIVE',
  description: 'SHM_info- @111, Alpha Client, https://t.me/alpha, US_ID: 1',
};

interface StubOverrides {
  services?: ReturnType<typeof pager>;
  clients?: ReturnType<typeof pager>;
  blocked?: ReturnType<typeof pager>;
}

function shmStub(overrides: StubOverrides = {}) {
  const svc = overrides.services ?? pager(services);
  const cli = overrides.clients ?? pager(clients);
  const blk = overrides.blocked ?? pager([]);
  return (path: string, params?: Params): unknown => {
    if (path === '/admin/user/service') return svc(params);
    if (path === '/admin/user') return isBlockedCall(params) ? blk(params) : cli(params);
    throw new Error(`unexpected shm path ${path}`);
  };
}

function panelStub(users: Row[], total = users.length) {
  return (path: string, params?: Params): unknown => {
    if (path !== '/api/users') throw new Error(`unexpected remna path ${path}`);
    const start = Number(params?.start ?? 0);
    const size = Number(params?.size ?? REMNA_PROBE_PAGE_SIZE);
    return { users: users.slice(start, start + size), total };
  };
}

const codes = (result: AuditOut): string[] => result.warnings.map((w) => w.code);
const buckets = (result: AuditOut): string[] => result.suppressed.map((s) => s.bucket);

describe('sync_audit', () => {
  // Именование резолвится один раз на процесс и кэшируется на пять минут, как
  // результат platform_probe. Без сброса первый же тест решал бы, чем ищут все
  // остальные, и порядок файлов становился бы частью условия.
  beforeEach(() => {
    resetPanelNamingCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reconciles per service and finds both directions when both sides are complete', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        panelForService51,
        { id: 9009, username: 'manual_ghost', telegramId: 999, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.complete).toEqual({ shm: true, panel: true });
    expect(result.coverage.services).toEqual({ items: 3, read: 3, complete: true });
    expect(result.coverage.panelUsers.items).toBe(2);
    // BLOCK-услуга 53 пользователя панели не ждёт вовсе.
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
    expect(result.findings.orphanPanelUser?.map((r) => r.id)).toEqual([9009]);
    // Поле называется matchedBy, а не key: под именем `key` страховочная
    // редакция маскирует значение по регулярке имён, и в корзине «удалить
    // этот аккаунт» единственное объяснение находки приезжало бы маркером.
    expect(result.findings.orphanPanelUser?.map((r) => r.matchedBy)).toEqual(['telegram_id']);
    expect(result.findings.orphanPanelUser?.[0]?.key).toBeUndefined();
    expect(result.findings.statusMismatch).toEqual([]);
    expect(result.suppressed).toEqual([]);
  });

  it('pages both sides to completeness instead of auditing the first window', async () => {
    // 1 100 услуг — три страницы SHM; 120 пользователей панели при потолке
    // страницы в 50 — три страницы панели.
    const many = Array.from({ length: 1_100 }, (_, i) => ({
      user_service_id: 1_000 + i,
      user_id: 1,
      status: 'ACTIVE',
    }));
    const panelUsers = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      username: `HQVPN_${String(1_000 + i)}`,
      status: 'ACTIVE',
      description: '',
    }));
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: shmStub({ services: pager(many) }),
      remnaGet: (path: string, params?: Params): unknown => {
        if (path !== '/api/users') throw new Error(`unexpected remna path ${path}`);
        const start = Number(params?.start ?? 0);
        // Панель молча режет страницу до 50, сколько бы ни просили.
        return { users: panelUsers.slice(start, start + 50), total: panelUsers.length };
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.services).toEqual({ items: 1_100, read: 1_100, complete: true });
    expect(result.coverage.panelUsers).toEqual({
      items: 120,
      read: 120,
      // Every row parsed, so `usable` matches `read` and the set difference
      // below is authoritative.
      usable: 120,
      complete: true,
      // Измерено, а не задано: панель отдала 50 на запрос в 500.
      pageSize: 50,
    });
    expect(result.complete).toEqual({ shm: true, panel: true });
    expect(calls.filter((c) => c.path === '/admin/user/service')).toHaveLength(3);
    expect(calls.filter((c) => c.path === '/api/users')).toHaveLength(3);
    // 1 100 активных услуг против 120 пользователей панели — находка настоящая,
    // но в ответ уезжает выборка, а не дамп таблицы.
    expect(result.counts.missingPanelUser).toBe(980);
    expect(result.findings.missingPanelUser).toHaveLength(20);
    expect(codes(result)).toContain('findings_sampled');
  });

  it('does not call a panel user with an empty telegramId an orphan', async () => {
    const ctx = makeCtx({ shmList: shmStub(), remnaGet: panelStub([panelForService51]) });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.findings.unlinkable).toEqual([]);
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
  });

  it('checks every service of a client that shares one telegram id, in either page order', async () => {
    const pair: Row[] = [
      { id: 9051, username: 'HQVPN_51', telegramId: 111, status: 'ACTIVE', description: '' },
      { id: 9052, username: 'HQVPN_52', telegramId: 111, status: 'DISABLED', description: '' },
    ];
    for (const users of [pair, [...pair].reverse()]) {
      const ctx = makeCtx({ shmList: shmStub(), remnaGet: panelStub(users) });
      const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

      expect(result.findings.statusMismatch).toEqual([
        {
          user_service_id: 52,
          id: 9052,
          username: 'HQVPN_52',
          shmStatus: 'ACTIVE',
          panelStatus: 'DISABLED',
        },
      ]);
      expect(result.findings.missingPanelUser).toEqual([]);
      expect(result.findings.orphanPanelUser).toEqual([]);
    }
  });

  it('reports partial coverage honestly and suppresses orphans rather than inventing them', async () => {
    // Сервер говорит «услуг 4 000», но отдаёт только 500: дочитать не вышло.
    const many = Array.from({ length: 500 }, (_, i) => ({
      user_service_id: 1_000 + i,
      user_id: 1_000 + i,
      status: 'ACTIVE',
    }));
    const ctx = makeCtx({
      shmList: shmStub({ services: pager(many, 4_000) }),
      remnaGet: panelStub([panelForService51], 1),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.services).toEqual({ items: 4_000, read: 500, complete: false });
    expect(result.complete.shm).toBe(false);
    expect(result.findings.orphanPanelUser).toBeUndefined();
    expect(buckets(result)).toContain('orphanPanelUser');
    expect(codes(result)).toContain('shm_not_fully_read');
  });

  it('stops at the row ceiling and says the coverage is partial', async () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({
      user_service_id: 1_000 + i,
      user_id: 1,
      status: 'ACTIVE',
    }));
    const ctx = makeCtx({
      shmList: shmStub({ services: pager(many) }),
      remnaGet: panelStub([panelForService51]),
    });
    const result = (await syncAudit.handler({ limit: 600 }, ctx)) as AuditOut;

    expect(result.coverage.services).toEqual({ items: 2_000, read: 600, complete: false });
    expect(result.complete.shm).toBe(false);
    expect(result.findings.orphanPanelUser).toBeUndefined();
  });

  it('does not treat a NOT PAID service as one that should have a panel user', async () => {
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([
          { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
          { user_service_id: 60, user_id: 1, status: 'NOT PAID' },
        ]),
      }),
      remnaGet: panelStub([panelForService51]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.missingPanelUser).toEqual([]);
  });

  it('reads settings that arrive as a JSON string and flags a blocked client still active in the panel', async () => {
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]),
        clients: pager([]),
        blocked: pager([
          { user_id: 1, login: '@111', block: 1, settings: '{"telegram":{"chat_id":111}}' },
        ]),
      }),
      // Ни имени с разбираемым id услуги, ни US_ID в описании: связать эту
      // строку можно ТОЛЬКО через chat_id, а он лежит в settings JSON-строкой.
      remnaGet: panelStub([
        { id: 9051, username: 'legacy-account', telegramId: 111, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.blockedButActiveInPanel).toEqual([
      { user_id: 1, user_service_id: null, id: 9051, username: 'legacy-account' },
    ]);
    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.coverage.blockedClients.items).toBe(1);
  });

  it('suppresses the orphan bucket when SHM does not answer', async () => {
    const ctx = makeCtx({
      shmList: () => {
        throw new Error('shm 500');
      },
      remnaGet: panelStub([panelForService51, { id: 9009, username: 'x', status: 'ACTIVE' }]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.orphanPanelUser).toBeUndefined();
    expect(buckets(result)).toContain('orphanPanelUser');
    expect(result.degraded.map((d) => d.system)).toContain('shm');
    expect(codes(result)).toContain('partial_result');
    // Не ноль: «услуг нет» и «спросить не удалось» — разные ответы.
    expect(result.coverage.services).toEqual({ items: null, read: 0, complete: false });
  });

  it('refuses to count blocked clients when the server-side filter did not narrow the list', async () => {
    const ctx = makeCtx({
      shmList: shmStub({
        blocked: pager([
          { user_id: 1, login: 'a', block: 0, settings: {} },
          { user_id: 3, login: 'c', block: 1, settings: {} },
        ]),
      }),
      remnaGet: panelStub([panelForService51]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.blockedClients.items).toBeNull();
    expect(codes(result)).toContain('blocked_filter_not_applied');
  });

  it('suppresses the missing-panel-user bucket when the panel does not answer', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.services.items).toBe(3);
    expect(result.coverage.panelUsers.items).toBeNull();
    expect(result.coverage.panelUsers.read).toBe(0);
    expect(result.findings.missingPanelUser).toBeUndefined();
    expect(result.findings.orphanPanelUser).toBeUndefined();
    expect(buckets(result)).toEqual(
      expect.arrayContaining(['missingPanelUser', 'orphanPanelUser', 'statusMismatch']),
    );
    expect(result.degraded).toEqual([{ system: 'remna', error: 'panel 502' }]);
    expect(codes(result)).toContain('partial_result');
  });

  it('separates quota exhaustion from a real status desync', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        { id: 9051, username: 'HQVPN_51', status: 'LIMITED', description: '' },
        { id: 9052, username: 'HQVPN_52', status: 'EXPIRED', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.quotaExhausted).toEqual([
      { user_service_id: 51, id: 9051, username: 'HQVPN_51' },
    ]);
    expect(result.findings.statusMismatch?.map((r) => r.user_service_id)).toEqual([52]);
    expect(codes(result)).toContain('quota_exhausted_is_not_desync');
  });

  it('keeps the pages already read when the panel budget runs out mid-pagination', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      username: `HQVPN_${String(i)}`,
      status: 'ACTIVE',
    }));
    let call = 0;
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: shmStub(),
      remnaGet: (path: string) => {
        if (path !== '/api/users') throw new Error(`unexpected remna path ${path}`);
        call += 1;
        if (call > 1) throw new Error('budget spent');
        return { users: page, total: 4_000 };
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.panelUsers.read).toBe(50);
    expect(result.coverage.panelUsers.items).toBe(4_000);
    expect(result.complete.panel).toBe(false);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'budget spent' }]);
    expect(result.findings.orphanPanelUser).toBeUndefined();
    // Подтверждать кандидатов точечными чтениями по той же панели, которая
    // только что отказала, — значит добить бюджет ради ответа «не знаю».
    expect(result.findings.missingPanelUser).toBeUndefined();
    expect(calls.filter((c) => c.path.startsWith('/api/users/by-username/'))).toEqual([]);
  });

  it('puts a panel user carrying no identity at all in its own bucket, not among orphans', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        panelForService51,
        { id: 9007, username: 'hysteria-test', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.unlinkable?.map((r) => r.id)).toEqual([9007]);
    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(codes(result)).toContain('unlinkable_is_not_orphan');
  });

  it('drops rows with no usable id instead of collapsing them onto zero', async () => {
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([
          { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
          { status: 'ACTIVE' },
          { user_service_id: 0, user_id: 0, status: 'ACTIVE' },
        ]),
      }),
      remnaGet: panelStub([panelForService51]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.missingPanelUser).toEqual([]);
    expect(result.counts.missingPanelUser).toBe(0);
  });

  it('confirms missing panel users one by one when the panel window is incomplete', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: shmStub({
        services: pager([
          { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
          { user_service_id: 52, user_id: 2, status: 'ACTIVE' },
        ]),
      }),
      remnaGet: (path: string) => {
        if (path === '/api/users') return { users: [], total: 4_000 };
        // 51 в панели есть — просто не приехал; 52 нет ни под одним префиксом.
        if (path === '/api/users/by-username/HQVPN_51') {
          return { id: 9051, username: 'HQVPN_51', status: 'ACTIVE' };
        }
        return null;
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.complete.panel).toBe(false);
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
    expect(calls.some((c) => c.path === '/api/users/by-username/HQVPN_51')).toBe(true);
  });

  it('joins the historical username prefixes and refuses to guess at a non-numeric suffix', async () => {
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([
          { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
          { user_service_id: 52, user_id: 2, status: 'ACTIVE' },
        ]),
      }),
      remnaGet: panelStub([
        { id: 9051, username: 'remnawave_51', telegramId: null, status: 'ACTIVE', description: '' },
        { id: 9052, username: 'us_52', telegramId: null, status: 'DISABLED', description: '' },
        // Стенд провижининга: суффикс не число, услуги за ним нет.
        { id: 9008, username: 'HQVPN_TEST001', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.missingPanelUser).toEqual([]);
    expect(result.findings.statusMismatch?.map((r) => r.user_service_id)).toEqual([52]);
    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.findings.unlinkable?.map((r) => r.id)).toEqual([9008]);
  });

  it('tries both chat ids before calling a hand-made panel user an orphan', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        // telegramId устарел (клиент сменил аккаунт), но описание помнит прежний.
        {
          id: 9003,
          username: 'legacy-hand-made',
          telegramId: 777,
          status: 'ACTIVE',
          description: 'SHM_info- @222, Beta Client, https://t.me/beta',
        },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.findings.unlinkable).toEqual([]);
  });

  it('does not call a panel user an orphan when the listing simply cannot see its service', async () => {
    // Услуга 51 — ребёнок составного тарифа или REMOVED: UserService::list_for_api
    // её не показывает, и в items она тоже не считается. Пользователь панели за
    // ней существует и принадлежит живому клиенту.
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([{ user_service_id: 52, user_id: 1, status: 'ACTIVE' }]),
      }),
      remnaGet: panelStub([
        { id: 9051, username: 'HQVPN_51', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    // Ключевое: тот же человек НЕ оказывается одновременно в «удалить аккаунт»
    // и в «перепровижинить клиента».
    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.findings.unlistedService?.map((r) => r.user_service_id)).toEqual([51]);
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
    expect(codes(result)).toContain('excludes_children_and_removed');
  });

  it('counts one service once and picks the same duplicate whatever the page order', async () => {
    const canonical = { id: 9001, username: 'HQVPN_51', status: 'DISABLED', description: '' };
    const legacy = { id: 9002, username: 'us_51', status: 'EXPIRED', description: '' };
    for (const users of [
      [canonical, legacy],
      [legacy, canonical],
    ]) {
      const ctx = makeCtx({
        shmList: shmStub({
          services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]),
        }),
        remnaGet: panelStub(users),
      });
      const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

      expect(result.counts.statusMismatch).toBe(1);
      // Каноничный префикс, а не «кто приехал первым»: иначе статус в находке
      // меняется от прогона к прогону.
      expect(result.findings.statusMismatch?.[0]?.id).toBe(9001);
      expect(codes(result)).toContain('duplicate_panel_users');
    }
  });

  it('deduplicates repeated panel rows and accounts for rows with no id', async () => {
    const row = { id: 9051, username: 'HQVPN_51', status: 'DISABLED', description: '' };
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]) }),
      remnaGet: panelStub([row, { ...row }, { username: 'no-id', status: 'ACTIVE' }]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.counts.statusMismatch).toBe(1);
    expect(result.coverage.panelUsers.read).toBe(3);
    expect(codes(result)).toContain('panel_rows_unusable');
    expect(codes(result)).toContain('panel_rows_repeated');
  });

  it('says the panel did not answer, not that it was read in part, when nothing arrived', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    const orphan = result.suppressed.find((s) => s.bucket === 'orphanPanelUser');
    expect(orphan?.reason).toContain('did not answer');
    expect(orphan?.reason).not.toContain('in part');
  });

  it('still reports a blocked client whose hidden service is live in the panel', async () => {
    // Услуга 51 листингу не видна (ребёнок составного тарифа или REMOVED), но
    // описание называет владельца, и владелец заблокирован. Самая острая
    // находка инструмента не должна теряться из-за того, что услуги не видно.
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([{ user_service_id: 52, user_id: 1, status: 'ACTIVE' }]),
        clients: pager([]),
        blocked: pager([{ user_id: 1, login: '@111', block: 1, settings: {} }]),
      }),
      remnaGet: panelStub([
        {
          id: 9051,
          username: 'HQVPN_51',
          telegramId: null,
          status: 'ACTIVE',
          description: 'SHM_info- @111, Alpha Client, https://t.me/alpha, US_ID: 1',
        },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.findings.blockedButActiveInPanel).toEqual([
      // user_service_id — null, а не 51: услуги за этим именем в листинге нет,
      // и утверждать связь, которую предупреждение тут же отрицает, нельзя.
      // Действовать всё равно по id.
      { user_id: 1, user_service_id: null, id: 9051, username: 'HQVPN_51' },
    ]);
    // Строка несёт и владельца (иначе проверить её нечем), и статус в панели —
    // им отличают живой остаток от REMOVED-услуги от инертного.
    expect(result.findings.unlistedService).toEqual([
      {
        user_service_id: 51,
        user_id: 1,
        id: 9051,
        username: 'HQVPN_51',
        telegramId: null,
        status: 'ACTIVE',
      },
    ]);
  });

  it('names the check that can actually see a hidden service', async () => {
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 52, user_id: 1, status: 'ACTIVE' }]) }),
      remnaGet: panelStub([
        { id: 9051, username: 'HQVPN_51', status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    const hint = result.warnings.find((w) => w.code === 'panel_users_for_unlisted_services');
    // Проверка, которая ВИДИТ такую строку: имя ключа таблицы во filter
    // заставляет SHM пропустить свои умолчания parent/status.
    expect(hint?.message).toContain('filter={"user_service_id"');
    // service_inspect читает обычный листинг с теми же умолчаниями и ответит
    // пустотой — то есть «услуги нет», ровно тем выводом, который эта корзина и
    // существует чтобы предотвратить. Назвать его можно только как
    // предостережение, а не как средство.
    expect(hint?.message).toMatch(/answers with silence/);
    // Третья причина, которую исключить нельзя: имя просто разобралось под
    // наследным префиксом.
    expect(hint?.message).toMatch(/hand-made|renamed/);
  });

  it('does not call an unmeasurable panel read a partial one', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      // Голый массив: счётчика нет вовсе.
      remnaGet: () => [panelForService51],
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(result.coverage.panelUsers.items).toBeNull();
    expect(result.complete.panel).toBe(false);
    const note = result.warnings.find((w) => w.code === 'panel_not_fully_read');
    expect(note?.message).toContain('did not report');
    expect(note?.message).not.toContain('read only in part');
  });

  it('names which of two duplicate accounts the reported status came from', async () => {
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]) }),
      remnaGet: panelStub([
        { id: 9002, username: 'us_51', status: 'EXPIRED', description: '' },
        { id: 9001, username: 'HQVPN_51', status: 'DISABLED', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    const note = result.warnings.find((w) => w.code === 'duplicate_panel_users');
    // Правило выбора — каноничное имя, а не порядок страниц; корзина именно для
    // того и есть, чтобы сказать, ЧЬЙ статус попал в находку.
    expect(note?.message).toMatch(/canonically-named/);
    expect(note?.message).not.toMatch(/the first of them/);
  });

  it('says a SHM source did not answer rather than that it was read in part', async () => {
    const svc = pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]);
    const ctx = makeCtx({
      shmList: (path: string, params?: Params): unknown => {
        if (path === '/admin/user/service') return svc(params);
        throw new Error('shm 500');
      },
      remnaGet: panelStub([panelForService51]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    const note = result.warnings.find((w) => w.code === 'shm_not_fully_read');
    expect(note?.message).toMatch(/clients: did not answer/);
    expect(note?.message).not.toMatch(/an unknown number of/);
    expect(note?.message).toMatch(/services: 1 of 1/);
  });

  it('always says what the service listing cannot see', async () => {
    const ctx = makeCtx({ shmList: shmStub(), remnaGet: panelStub([panelForService51]) });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).toContain('excludes_children_and_removed');
    // blocked_read_separately, а не blocked_hidden: этим кодом сосед
    // client_search сообщает обратное — что заблокированных в ответе нет.
    expect(codes(result)).toContain('blocked_read_separately');
    expect(codes(result)).not.toContain('blocked_hidden');
  });
  it('uses the 3.x panel row shape instead of discarding every row for having no uuid', async () => {
    // THE defect this shape exists to prevent, found against a running
    // Remnawave 3.2.3 rather than read off a spec: no user object carries
    // `uuid` any more, so `uuid: str(row.uuid) ?? ''` made EVERY row unusable,
    // `panelRows` empty, and every ACTIVE service fell into
    // `missingPanelUser` — whose remedy is "re-provision this client".
    // Sampled candidates all answered 200 when asked for directly. The row
    // below is the real shape, field for field.
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        {
          id: 9051,
          shortUuid: 'aBcDeFgHiJkLmNoP',
          username: 'HQVPN_51',
          telegramId: null,
          status: 'ACTIVE',
          description: 'SHM_info- @111, Alpha Client, https://t.me/alpha, US_ID: 1',
        },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).not.toContain('panel_rows_unusable');
    expect(result.coverage.panelUsers.usable).toBe(1);
    // Service 51 is paired, so only 52 is genuinely missing — not both.
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
    expect(result.findings.missingPanelUser?.length).toBe(1);
  });

  it('refuses to report the destructive buckets when the panel rows were all discarded', async () => {
    // The safeguard that should have caught the whole-fleet miss above:
    // confirmation was skipped *because* the panel read succeeded. A complete
    // read makes a set difference authoritative only if the rows in it
    // survived parsing.
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([
        { username: 'HQVPN_51', telegramId: null, status: 'ACTIVE', description: '' },
        { username: 'HQVPN_52', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(buckets(result)).toContain('missingPanelUser');
    expect(buckets(result)).toContain('orphanPanelUser');
    expect(result.findings.missingPanelUser).toBeUndefined();
    expect(result.findings.orphanPanelUser).toBeUndefined();
    expect(result.counts.missingPanelUser).toBeUndefined();
    expect(codes(result)).toContain('panel_rows_unusable');
  });

  it('says nothing usable survived in the coverage block, not just in a warning', async () => {
    const ctx = makeCtx({
      shmList: shmStub(),
      remnaGet: panelStub([{ username: 'HQVPN_51', telegramId: null, status: 'ACTIVE' }]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    // `read` stays the honest raw count; `usable` is what the audit could act on.
    expect(result.coverage.panelUsers.read).toBe(1);
    expect(result.coverage.panelUsers.usable).toBe(0);
    // A set difference over zero usable rows is not a complete panel.
    expect(result.complete.panel).toBe(false);
  });

  it('drops a single junk row out of authority instead of trusting the set difference', async () => {
    // One unusable row among many is not a schema mismatch, so the bucket is
    // not suppressed — but the set difference is no longer authoritative
    // either, so candidates get the per-candidate confirmation path.
    // 1 junk row in 22 is 4.5%, just under the suspect ratio.
    const filler: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: 500 + i,
      username: `HQVPN_${String(700 + i)}`,
      status: 'ACTIVE',
      description: '',
    }));
    const panel: Row[] = [
      { id: 11221, username: 'HQVPN_51', telegramId: null, status: 'ACTIVE', description: '' },
      ...filler,
      { username: 'HQVPN_52', telegramId: null, status: 'ACTIVE', description: '' },
    ];
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: shmStub(),
      remnaGet: (path, params) => {
        if (path.startsWith('/api/users/by-username/')) return null;
        return panelStub(panel)(path, params);
      },
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).toContain('panel_rows_unusable');
    // 52 was confirmed absent one by one, not assumed absent from the window.
    expect(calls.some((c) => c.path.startsWith('/api/users/by-username/'))).toBe(true);
    expect(result.findings.missingPanelUser?.map((r) => r.user_service_id)).toEqual([52]);
  });
});

describe('sync_audit — the join key belongs to the installation', () => {
  beforeEach(() => {
    resetPanelNamingCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to call every service unprovisioned when no panel name parses', async () => {
    // Чужая инсталляция с собственным name_prefix: сверка НЕ падает, а
    // отвечает уверенно и неправильно — услуга 51 живёт под своим именем в
    // панели, а ключ связи её не находит. Именно этот класс ответа («искали не
    // тем префиксом», неотличимое от «искали и не нашли») и закрывается здесь.
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]) }),
      remnaGet: panelStub([
        { id: 9051, username: 'acme-51', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).toContain('prefix_unverified');
    expect(result.findings.missingPanelUser).toBeUndefined();
    expect(buckets(result)).toContain('missingPanelUser');
    const said = result.suppressed.find((one) => one.bucket === 'missingPanelUser');
    expect(said?.reason).toContain('HQVPN_');
    expect(said?.reason).toContain('HQ_MCP_PANEL_PREFIXES');
    // Сирота определяется вторичными ключами, которых префикс не касается:
    // корзина остаётся посчитанной, а неразобранное имя уезжает в unlinkable,
    // чья рекомендация и без того «выяснить, а не удалять».
    expect(result.findings.orphanPanelUser).toEqual([]);
    expect(result.findings.unlinkable?.map((r) => r.id)).toEqual([9051]);
  });

  it('does not cry wrong-prefix over hand-made accounts standing beside real ones', async () => {
    // Порог — ноль совпадений на всю панель, а не доля: в бою 54 учётки из
    // 1125 заведены руками и ни под один префикс не подходят, и это норма.
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 51, user_id: 1, status: 'ACTIVE' }]) }),
      remnaGet: panelStub([
        panelForService51,
        { id: 9003, username: 'legacy-hand-made', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).not.toContain('prefix_unverified');
    expect(result.findings.missingPanelUser).toEqual([]);
  });

  it('stays silent about the prefix when SHM has no active service to name', async () => {
    // Панель из одних ручных учёток про наши префиксы не говорит ничего: ей
    // просто нечего было именовать.
    const ctx = makeCtx({
      shmList: shmStub({ services: pager([{ user_service_id: 53, user_id: 3, status: 'BLOCK' }]) }),
      remnaGet: panelStub([
        { id: 9003, username: 'legacy-hand-made', telegramId: null, status: 'ACTIVE', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).not.toContain('prefix_unverified');
    expect(result.findings.missingPanelUser).toEqual([]);
  });

  it('joins on the prefix the environment names, and expects that name back', async () => {
    vi.stubEnv('HQ_MCP_PANEL_PREFIXES', 'ACME_');
    const ctx = makeCtx({
      shmList: shmStub({
        services: pager([
          { user_service_id: 51, user_id: 1, status: 'ACTIVE' },
          { user_service_id: 52, user_id: 2, status: 'ACTIVE' },
        ]),
      }),
      remnaGet: panelStub([
        { id: 9051, username: 'ACME_51', telegramId: null, status: 'DISABLED', description: '' },
      ]),
    });
    const result = (await syncAudit.handler({ limit: 20_000 }, ctx)) as AuditOut;

    expect(codes(result)).not.toContain('prefix_unverified');
    // Услуга 51 связана по чужому префиксу — значит и расхождение статусов
    // видно, а зашитый HQVPN_ не увидел бы ни того, ни другого.
    expect(result.findings.statusMismatch?.map((r) => r.user_service_id)).toEqual([51]);
    // А непровижиненная 52 названа тем именем, которое искать И НАДО.
    expect(result.findings.missingPanelUser?.map((r) => r.expectedUsername)).toEqual(['ACME_52']);
  });
});
