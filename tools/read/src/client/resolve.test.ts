import { beforeEach, describe, expect, it } from 'vitest';
import { Budget } from '@hq/budget';
import { createRemnaClient } from '@hq/remna';
import { ShmError } from '@hq/shm';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ACCOUNTS_PATH, num, resetIdentitySchemaCache } from '../kit.js';
import { clientResolve } from './resolve.js';

/**
 * Вердикт «таблицы accounts нет» живёт в МОДУЛЬНОМ кэше — он и должен, иначе
 * каждый резолв на установке до 3.0 платил бы лишним 404. В тестах время
 * заморожено, то есть кэш внутри прогона не истекает никогда, и вердикт одного
 * теста доехал бы до всех следующих.
 */
beforeEach(() => {
  resetIdentitySchemaCache();
});

interface ResolveOut {
  query: string;
  shm: {
    matches: Array<{
      user_id: number;
      blocked: boolean;
      matchedBy: 'shm_user_id' | 'telegram_id' | 'login' | 'email' | null;
      exact: boolean;
    }>;
    count: number;
  };
  remna: {
    matches: Array<{
      id: number;
      username: string | null;
      via: string;
      user_service_id: number | null;
    }>;
    count: number;
    ambiguous: boolean;
    paths: Array<{ path: string; tried: boolean; found: number; note: string | null }>;
  };
  warnings: Array<{ code: string }>;
  degraded: Array<{ system: string }>;
}

const shmRow = {
  user_id: 3073,
  login: 'tg900001',
  login2: 'client@example.com',
  full_name: 'Ivan',
  balance: '120.50',
  block: 0,
  settings: '{"telegram":{"chat_id":900001,"login":"ivan"}}',
};

describe('client_resolve', () => {
  it('never sends user_id to the search route', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: () => [shmRow],
      remnaGet: () => [],
    });
    await clientResolve.handler({ query: '900001' }, ctx);
    const search = calls.find((c) => c.path === '/admin/user/search');
    expect(search).toBeDefined();
    expect(search?.params).toEqual({ text: '900001', limit: 25 });
    expect(Object.keys(search?.params ?? {})).not.toContain('user_id');
  });

  it('publishes server-derived exact match evidence without relying on redacted login', async () => {
    const ctx = makeCtx({ shmList: () => [shmRow], remnaGet: () => [] });
    const result = (await clientResolve.handler({ query: '900001' }, ctx)) as ResolveOut;
    expect(result.shm.matches[0]).toMatchObject({
      user_id: 3073,
      exact: true,
      matchedBy: 'telegram_id',
    });
  });

  it('marks substring-only SHM rows as non-exact', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? [{ ...shmRow, user_id: 88, login: 'ivan-archive', settings: '{}' }]
          : [],
      remnaGet: () => [],
    });
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(result.shm.matches[0]).toMatchObject({ exact: false, matchedBy: null });
  });

  it('flags several Remnawave users behind one telegram id as ambiguous', async () => {
    const ctx = makeCtx({
      shmList: () => [shmRow],
      remnaGet: () => ({
        users: [
          { id: 5101, shortUuid: 'sU1', username: 'tg900001', telegramId: 900001, status: 'ACTIVE' },
          { id: 5100, shortUuid: 'sU2', username: 'tg900001_old', telegramId: 900001, status: 'DISABLED' },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    });
    const result = (await clientResolve.handler({ query: '900001' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(2);
    expect(result.remna.ambiguous).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('remna_ambiguous_identifier');
    expect(result.shm.matches[0]?.user_id).toBe(3073);
  });

  it('wraps the object answer of by-username into a list', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: () => [],
      remnaGet: () => ({ id: 909, shortUuid: 'sU9', username: 'ivan', telegramId: null, status: 'ACTIVE' }),
    });
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(calls.some((c) => c.path === '/api/users/by-username/ivan')).toBe(true);
    expect(result.remna.count).toBe(1);
    expect(result.remna.ambiguous).toBe(false);
  });

  it('filters the user stream by email instead of the removed by-email route', async () => {
    // by-email is GONE on 3.2.3 (checked against a running panel, not read off
    // the spec): it answers the router's own 404. The replacement is the exact
    // `email` filter of /api/users/stream.
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: () => [],
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    await clientResolve.handler({ query: 'client@example.com' }, ctx);
    const stream = calls.find((c) => c.path === '/api/users/stream');
    expect(stream).toBeDefined();
    expect(stream?.params).toMatchObject({ email: 'client@example.com' });
    expect(calls.some((c) => c.path.startsWith('/api/users/by-email'))).toBe(false);
  });

  it('filters the user stream by telegram id instead of the removed by-telegram-id route', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: () => [shmRow],
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    await clientResolve.handler({ query: '900001' }, ctx);
    const stream = calls.find((c) => c.path === '/api/users/stream');
    expect(stream?.params).toMatchObject({ telegramId: '900001' });
    expect(calls.some((c) => c.path.startsWith('/api/users/by-telegram-id'))).toBe(false);
  });

  it('identifies a panel match by numeric id, the only identifier 3.x still has', async () => {
    // The 3.x user object carries no `uuid` at all. The previous match step
    // filtered on `uuid !== ''`, so EVERY row was discarded and a live client
    // read as absent even on the routes that still answer 200.
    const ctx = makeCtx({
      shmList: () => [],
      remnaGet: () => ({ id: 5001, shortUuid: 'sHoRt', username: 'HQVPN_5001', telegramId: null, status: 'ACTIVE' }),
    });
    const result = (await clientResolve.handler({ query: 'HQVPN_5001' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(1);
    expect(result.remna.matches[0]?.id).toBe(5001);
    // shortUuid is deliberately absent: §7.2 masks it to asterisks anyway.
    expect(result.remna.matches[0]).not.toHaveProperty('shortUuid');
  });

  it('warns when the stream has more matches than one page returned', async () => {
    const ctx = makeCtx({
      shmList: () => [],
      remnaGet: () => ({
        users: [{ id: 1, shortUuid: 's1', username: 'a', telegramId: 900001, status: 'ACTIVE' }],
        nextCursor: 'c2',
        hasMore: true,
      }),
    });
    const result = (await clientResolve.handler({ query: '900001' }, ctx)) as ResolveOut;
    expect(result.warnings.map((w) => w.code)).toContain('remna_more_matches');
  });

  it('retries a numeric query by direct user_id because search hides blocked clients', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => (path === '/admin/user/search' ? [] : [{ ...shmRow, block: 1 }]),
      remnaGet: () => [],
    });
    const result = (await clientResolve.handler({ query: '3073' }, ctx)) as ResolveOut;
    expect(calls.filter((c) => c.path === '/admin/user')).toHaveLength(1);
    expect(result.shm.matches[0]?.blocked).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('shm_found_via_user_id');
  });

  /**
   * `client_resolve("1")` возвращает окно посторонних клиентов и ни одного
   * user_id 1 — при том, что клиент существует и не заблокирован.
   * `/admin/user/search` ищет ПОДСТРОКОЙ и сортирует по ключу таблицы вниз,
   * поэтому короткий числовой запрос вымывается из окна чужими совпадениями.
   */
  it('adds the exact user_id the substring search never returned, and puts it first', async () => {
    const others = Array.from({ length: 25 }, (_, index) => ({
      ...shmRow,
      user_id: 9100 + index,
      login: `@${String(100000000 + index)}1`,
      settings: '{}',
    }));
    const ctx = makeCtx({
      shmList: (path, params) => {
        if (path === '/admin/user/search') return others;
        // Точечный добор — только через filter: `?user_id=` на несуществующем
        // клиенте у SHM бросает исключение вместо пустого ответа.
        if (path === '/admin/user') {
          expect(params?.filter).toBe(JSON.stringify({ user_id: 1 }));
          return [{ ...shmRow, user_id: 1, login: 'orion', settings: '{}' }];
        }
        return [];
      },
      remnaGet: () => [],
    });
    const result = (await clientResolve.handler({ query: '1' }, ctx)) as ResolveOut;
    expect(result.shm.matches[0]?.user_id).toBe(1);
    expect(result.shm.count).toBe(26);
    expect(result.warnings.map((w) => w.code)).toContain('shm_found_via_user_id');
  });

  it('ranks an exact login above the substring hits the search returned first', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? [
              { ...shmRow, user_id: 6890, login: '@100000777', settings: '{}' },
              { ...shmRow, user_id: 16, login: 'j.orion@example.test', settings: '{}' },
              { ...shmRow, user_id: 1, login: 'orion', settings: '{}' },
            ]
          : [],
      remnaGet: () => [],
    });
    const result = (await clientResolve.handler({ query: 'orion' }, ctx)) as ResolveOut;
    // Панельная половина обходит услуги ПЕРВЫХ клиентов списка, поэтому порядок
    // здесь решает, про кого будет ответ про панель, а не только как он выглядит.
    expect(result.shm.matches.map((one) => one.user_id)).toEqual([1, 6890, 16]);
  });

  it('says whose panel account each service-walk hit belongs to', async () => {
    const ctx = makeCtx({
      shmList: (path, params) => {
        if (path === '/admin/user/search') {
          return [
            { ...shmRow, user_id: 9101, login: '@100000101', settings: '{}' },
            { ...shmRow, user_id: 9102, login: '@100000102', settings: '{}' },
          ];
        }
        // У каждого клиента своя услуга — иначе один и тот же аккаунт панели
        // нашёлся бы от обоих, а вопрос теста именно в принадлежности.
        if (path === '/admin/user/service') {
          return num(params?.user_id, 0) === 9101
            ? [{ user_service_id: 3101 }]
            : [{ user_service_id: 3102 }];
        }
        if (path === '/admin/user') return [];
        return [];
      },
      // Отсутствующий ключ хранилища — это 200 и ПУСТОЕ тело, а не 404.
      shmGet: () => undefined,
      // Прикладной «нет такого пользователя» клиент панели отдаёт как null —
      // именно так, а не исключением, иначе это читалось бы как сбой панели.
      remnaGet: (path) =>
        path === '/api/users/by-username/HQVPN_3101'
          ? { id: 4101, username: 'HQVPN_3101', telegramId: null, status: 'ACTIVE' }
          : null,
    });
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    const found = result.remna.matches.find((one) => one.id === 4101);
    expect(found).toBeDefined();
    // Без этого поля список читается как «аккаунты того, кого искали», а на
    // текстовом запросе это аккаунты нескольких РАЗНЫХ людей.
    expect((found as unknown as { shm_user_id: number | null }).shm_user_id).toBe(9101);
    const notice = result.warnings.find((w) => w.code === 'remna_found_via_services');
    expect((notice as unknown as { message: string } | undefined)?.message).toContain(
      'SHM client 9101',
    );
  });

  it('degrades softly when Remnawave is down', async () => {
    const ctx = makeCtx({
      shmList: () => [shmRow],
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await clientResolve.handler({ query: '900001' }, ctx)) as ResolveOut;
    expect(result.shm.count).toBe(1);
    expect(result.remna.count).toBe(0);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'panel 502' }]);
  });
});

/**
 * ДЕФЕКТ, ВОСПРОИЗВЕДЁННЫЙ НА РАБОТАЮЩЕЙ СВЯЗКЕ SHM + панели, а не выдуманный:
 * client_resolve отвечал `remna: {matches: [], count: 0}` без единого
 * предупреждения, тогда как provisioning_diagnose на том же клиенте видел
 * `panel: {username: "remnawave_3938", id: 196, found: true}`.
 *
 * Причина ровно одна: резолв спрашивал панель ТОЛЬКО про `telegramId`, а у
 * этого аккаунта он null — панель пишет поле при создании и только если
 * Telegram уже был привязан, поэтому пустое оно у заметной доли уже заведённых
 * аккаунтов. Имя при этом наследное (`remnawave_`, не текущий `HQVPN_`), то
 * есть первый префикс из PANEL_USERNAME_PREFIXES по нему отвечает 404 — и
 * инструмент, проверяющий один префикс, объявил бы аккаунт отсутствующим тоже.
 *
 * Оба условия воспроизведены здесь вместе, потому что поодиночке каждое из
 * них ловится случайно.
 */
describe('client_resolve — panel account with a legacy prefix and no telegram id', () => {
  const SERVICE_ROW = { user_service_id: 3938, service_id: 12, status: 'ACTIVE' };
  const PANEL_USER = {
    id: 196,
    username: 'remnawave_3938',
    telegramId: null,
    status: 'ACTIVE',
  };

  /** Рабочая установка в миниатюре: услуга есть, снапшота нет, имя наследное. */
  function productionShaped(opts: { snapshot?: unknown; services?: unknown[] } = {}) {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) =>
        path === '/admin/user/service' ? (opts.services ?? [SERVICE_ROW]) : [shmRow],
      // Отсутствующий ключ хранилища — это 200 и ПУСТОЕ тело, а не 404.
      shmGet: () => opts.snapshot ?? undefined,
      remnaGet: (path) => {
        if (path === '/api/users/stream') return { users: [], nextCursor: null, hasMore: false };
        if (path === '/api/users/by-username/remnawave_3938') return PANEL_USER;
        if (path === '/api/users/196') return PANEL_USER;
        // Прикладной 404 объектной ручки клиент @hq/remna отдаёт как null.
        return null;
      },
    });
    return { calls, ctx };
  }

  it('finds the account the telegram lookup cannot see', async () => {
    const { ctx } = productionShaped();
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(1);
    expect(result.remna.matches[0]).toMatchObject({
      id: 196,
      username: 'remnawave_3938',
      via: 'service',
      user_service_id: 3938,
    });
  });

  it('says out loud that the identifier path missed a live account', async () => {
    const { ctx } = productionShaped();
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('remna_found_via_services');
    // Найденный аккаунт — это не «отсутствие не доказано»: доказывать нечего.
    expect(codes).not.toContain('remna_absence_unproven');
  });

  it('walks the shared prefix list in order instead of trusting one prefix', async () => {
    const { calls, ctx } = productionShaped();
    await clientResolve.handler({ query: '700100200' }, ctx);
    const byUsername = calls
      .filter((c) => c.path.startsWith('/api/users/by-username/'))
      .map((c) => c.path);
    // HQVPN_ (текущий префикс) спрашивается первым и отвечает 404 — ровно то,
    // на чём инструмент с одним зашитым префиксом и остановился бы.
    expect(byUsername).toEqual([
      '/api/users/by-username/HQVPN_3938',
      '/api/users/by-username/remnawave_3938',
    ]);
  });

  it('reads the storage snapshot first and skips guessing when it carries the id', async () => {
    // Тот же путь, которым ходит provisioning_diagnose: снапшот отдаёт числовой
    // id, и перебирать имена не приходится вовсе.
    const { calls, ctx } = productionShaped({
      snapshot: { response: { id: 196, username: 'remnawave_3938' } },
    });
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.remna.matches[0]?.id).toBe(196);
    expect(calls.some((c) => c.path.startsWith('/api/users/by-username/'))).toBe(false);
    expect(calls.some((c) => c.path === '/api/users/196')).toBe(true);
    // Ключ снапшота именуется по user_service_id, а не по user_id.
    const read = calls.find((c) => c.path.startsWith('/admin/storage/manage/'));
    expect(read?.path).toBe('/admin/storage/manage/vpn_mrzb_3938');
    expect(read?.params).toMatchObject({ user_id: 3073 });
  });

  it('reports every path it tried, so count:0 can never read as "no account"', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => (path === '/admin/user/service' ? [] : [shmRow]),
      shmGet: () => undefined,
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(0);
    expect(result.remna.paths.map((p) => p.path)).toEqual(['telegram_id', 'service']);
    expect(result.remna.paths.every((p) => p.tried)).toBe(true);
    const absence = result.warnings.find((w) => w.code === 'remna_absence_unproven');
    expect(absence).toBeDefined();
    // Слепое пятно названо в тексте, а не оставлено читателю на догадку.
    expect((absence as unknown as { message: string }).message).toContain('status=REMOVED');
  });

  it('does not let a guessed-and-missed username read as a proven absence', async () => {
    // Ни одного префикса не подошло и снапшота не было: панель с собственным
    // config.remnawave.name_prefix выглядит отсюда ровно как пустая.
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? [SERVICE_ROW] : [shmRow]),
      shmGet: () => undefined,
      remnaGet: (path) =>
        path === '/api/users/stream' ? { users: [], nextCursor: null, hasMore: false } : null,
    });
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(0);
    const services = result.remna.paths.find((p) => p.path === 'service');
    expect(services?.note).toContain('name_prefix');
    expect(services?.note).toContain('HQVPN_');
    expect(result.warnings.map((w) => w.code)).toContain('remna_absence_unproven');
  });

  it('counts one account, not two, when both paths return the same panel id', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => (path === '/admin/user/service' ? [SERVICE_ROW] : [shmRow]),
      shmGet: () => undefined,
      remnaGet: (path) => {
        if (path === '/api/users/stream') {
          return {
            users: [{ id: 196, username: 'remnawave_3938', telegramId: 700100200, status: 'ACTIVE' }],
            nextCursor: null,
            hasMore: false,
          };
        }
        return path === '/api/users/by-username/remnawave_3938' ? PANEL_USER : null;
      },
    });
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(1);
    expect(result.remna.ambiguous).toBe(false);
    // Побеждает запись с привязкой к услуге — она несёт строго больше.
    expect(result.remna.matches[0]).toMatchObject({
      id: 196,
      via: 'service',
      user_service_id: 3938,
      telegramId: 700100200,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('remna_found_via_services');
  });

  it('stops at its own ceiling and says so rather than resolving forever', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ user_service_id: 4000 + i }));
    const { calls, ctx } = productionShaped({ services: many });
    const result = (await clientResolve.handler({ query: '700100200' }, ctx)) as ResolveOut;
    expect(result.warnings.map((w) => w.code)).toContain('panel_lookup_capped');
    // Восемь проверок, не двенадцать: потолок стоимости соблюдён.
    expect(calls.filter((c) => c.path.startsWith('/admin/storage/manage/'))).toHaveLength(8);
    const services = result.remna.paths.find((p) => p.path === 'service');
    expect(services?.note).toContain('only the first 8 services');
  });

  it('does not walk services for a wide text query that matched many clients', async () => {
    const crowd = Array.from({ length: 9 }, (_, i) => ({ ...shmRow, user_id: 5000 + i }));
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => (path === '/admin/user/service' ? [] : crowd),
      shmGet: () => undefined,
      remnaGet: () => null,
    });
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(calls.filter((c) => c.path === '/admin/user/service')).toHaveLength(3);
    expect(result.warnings.map((w) => w.code)).toContain('panel_lookup_capped');
  });
});

describe('client_resolve — real Remnawave 404 vs 500 on the by-username lookup', () => {
  // Fix round 1, Finding 2 (⚠️ real, flagged outside the diff): by-username is
  // an OBJECT-shaped lookup (§6.16) — Remnawave answers 200+object when found
  // and a plain 404 when it is not, unlike by-telegram-id/by-email/by-tag
  // (array-shaped, 200+[] on absence). `makeCtx`'s stub sits at the
  // `RemnaClient` interface, past where HTTP status is translated, so it
  // cannot exercise this — these two tests wire the REAL @hq/remna client to
  // a stub `fetch` to prove the translation itself, then run it through
  // `client_resolve` to prove the caller-visible effect the finding named.
  function fetchReturning(status: number, body: string): typeof fetch {
    return (async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  function ctxWithRealRemna(status: number, body: string) {
    const base = makeCtx({ shmList: () => [] });
    const remna = createRemnaClient(
      { baseUrl: 'https://panel.example.com', token: 'jwt' },
      {
        budget: new Budget({ limit: 100, windowMs: 60_000 }),
        profile: 'human',
        fetchImpl: fetchReturning(status, body),
      },
    );
    return { ...base, remna };
  }

  it('treats an application 404 as a clean "no match", not a degraded Remnawave', async () => {
    const ctx = ctxWithRealRemna(
      404,
      '{"message":"User with specified params not found","errorCode":"A063"}',
    );
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(0);
    expect(result.degraded).toEqual([]);
  });

  it('reports a router 404 as degraded — a removed route is never a clean "no match"', async () => {
    // The regression this whole task exists for: on 3.2.3 a call to a route
    // that no longer exists must surface, not read as "the client is absent".
    const ctx = ctxWithRealRemna(
      404,
      '{"message":"Cannot GET /api/users/by-username/ivan","error":"Not Found","statusCode":404}',
    );
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(0);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]?.system).toBe('remna');
  });

  it('still reports a 500 as degraded — it must not read as "no match"', async () => {
    const ctx = ctxWithRealRemna(500, '{"message":"boom"}');
    const result = (await clientResolve.handler({ query: 'ivan' }, ctx)) as ResolveOut;
    expect(result.remna.count).toBe(0);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]?.system).toBe('remna');
  });
});

/**
 * SHM 3.0 УНЕСЛА ИДЕНТИЧНОСТЬ КЛИЕНТА ИЗ ЕГО СТРОКИ В ТАБЛИЦУ `accounts`.
 *
 * Строка клиента на 3.0 больше не несёт ни `login2` (колонка снята из
 * `Core::User::structure`), ни `settings.email` (вычищено миграцией 3.0.0), а
 * `users.phone` дропнута миграцией 3.0.38. Резолвер, читающий только строку,
 * на такой установке отвечает `email: null` КАЖДОМУ клиенту — не отказом, а
 * пустым полем, которое читается как факт о человеке.
 *
 * Обе схемы проверяются здесь одним набором тестов намеренно: сервер не
 * перезапускается в момент миграции, и «работает на 3.0» без «по-прежнему
 * работает на 2.19» — это не готовность к переезду, а перенос поломки.
 */
describe('client_resolve × identity schema (SHM 2.19 vs 3.0)', () => {
  /**
   * Строка клиента, какой её отдаёт БОЕВАЯ 3.1.0.
   *
   * `login2` здесь НЕ случайно: миграция колонку не дропает (снимок схемы
   * прода), а `/admin/user` выбирает физические колонки целиком
   * (`fields => '*'`, Sql/Data.pm:906) — то есть довоенное значение приезжает
   * в каждом ответе. Живой случай: там лежит телеграм-хендл, а не почта.
   * Прежняя фикстура его не несла, и весь блок проверял установку, которой
   * не существует.
   */
  const row30 = {
    user_id: 4100,
    login: 'tg900002',
    login2: '@900002',
    full_name: 'Petr',
    balance: '10.00',
    block: 0,
    settings: '{"telegram":{"chat_id":900002}}',
  };

  /** Строка `accounts`: почта клиента лежит в колонке, которая зовётся `login`. */
  const accountRows = [
    { login: 'tg900002', type: 'login', user_id: 4100, settings: null, primary: 1 },
    {
      login: 'petr@example.com',
      type: 'email',
      user_id: 4100,
      settings: { email: { verified: 1 } },
      primary: 0,
    },
    { login: '79990000000', type: 'phone', user_id: 4100, settings: null, primary: 0 },
    { login: '900002', type: 'telegram', user_id: 4100, settings: null, primary: 0 },
  ];

  function ctx30(calls: StubCall[] = []) {
    return makeCtx({
      calls,
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) return accountRows;
        if (path === '/admin/user/search') return [row30];
        if (path === '/admin/user') return [row30];
        return [];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
  }

  it('fills email, phone and telegram from accounts when the 3.0 table is there', async () => {
    const result = (await clientResolve.handler({ query: 'petr@example.com' }, ctx30())) as {
      identity: { schema: string; enriched: number; exact_match_types: string[] };
      shm: {
        matches: Array<{
          email: string | null;
          email_from: string | null;
          phones: string[];
          telegram_id: number | null;
        }>;
      };
    };
    expect(result.identity.schema).toBe('accounts');
    const first = result.shm.matches[0];
    expect(first?.email).toBe('petr@example.com');
    expect(first?.email_from).toBe('accounts');
    expect(first?.phones).toEqual(['79990000000']);
    // Привязка телеграма берётся из живой строки клиента, а не из accounts:
    // миграция копирует туда settings.telegram.user_id, а вся остальная
    // связка этой установки идёт по chat_id, и это РАЗНЫЕ поля.
    expect(first?.telegram_id).toBe(900002);
  });

  it('puts the email under a field name @hq/redact masks, not under `login`', async () => {
    // Настоящая утечка, а не косметика: в базе 3.0 почта и телефон лежат в
    // колонке `login`, а маскирование PII идёт ПО ИМЕНИ ПОЛЯ. Отдай мы строку
    // как есть — профиль `bot` получил бы почту клиента открытым текстом.
    const result = (await clientResolve.handler({ query: 'petr@example.com' }, ctx30())) as {
      shm: { matches: Array<{ accounts: Array<Record<string, unknown>> | null }> };
    };
    const accounts = result.shm.matches[0]?.accounts ?? [];
    const email = accounts.find((one) => one.kind === 'email');
    const phone = accounts.find((one) => one.kind === 'phone');
    expect(email?.email).toBe('petr@example.com');
    expect(email?.login).toBeNull();
    expect(phone?.phone).toBe('79990000000');
    expect(phone?.login).toBeNull();
    // settings строки accounts наружу не едет вовсе: у типа `login` там лежит
    // password.hash (Core::User::Logins::set_password).
    expect(accounts.every((one) => !('settings' in one))).toBe(true);
  });

  it('asks accounts by the exact table key, never by a substring', async () => {
    const calls: StubCall[] = [];
    await clientResolve.handler({ query: 'Petr@Example.com' }, ctx30(calls));
    const exact = calls.find((c) => c.path === ACCOUNTS_PATH);
    expect(exact?.params).toMatchObject({ login: 'petr@example.com' });
  });

  it('pulls in a client the substring search missed and says so', async () => {
    // Окно /admin/user/search на 3.0 стало теснее: маршрут объявил
    // params => {text} без common_params, то есть наш limit туда не доезжает.
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path, params) => {
        if (path === ACCOUNTS_PATH) {
          // Точное совпадение указывает на клиента, которого поиск не вернул.
          if (params?.login === 'petr@example.com') {
            return [
              {
                login: 'petr@example.com',
                type: 'email',
                user_id: 4100,
                settings: { email: { verified: 1 } },
              },
            ];
          }
          return accountRows;
        }
        if (path === '/admin/user/search') return [{ user_id: 77, login: 'someone-else' }];
        if (path === '/admin/user') return [row30];
        return [];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: 'petr@example.com' }, ctx)) as {
      identity: { exact_match_types: string[] };
      shm: { matches: Array<{ user_id: number }>; count: number };
      warnings: Array<{ code: string }>;
    };
    expect(result.warnings.map((w) => w.code)).toContain('shm_found_via_accounts');
    expect(result.identity.exact_match_types).toEqual(['email']);
    // Владелец точного совпадения — первым, посторонний из подстрочного окна — за ним.
    expect(result.shm.matches[0]?.user_id).toBe(4100);
    expect(result.shm.count).toBe(2);
  });

  it('reads a router 404 as "older than 3.0" and keeps working off login2', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => {
        // Так отвечает SHM до 3.0: маршрута нет в роутере вовсе.
        if (path === ACCOUNTS_PATH) throw new ShmError('Method not found', 404);
        return [
          {
            user_id: 3073,
            login: 'tg900001',
            login2: 'client@example.com',
            phone: '79990000001',
            block: 0,
            settings: '{"telegram":{"chat_id":900001}}',
          },
        ];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: 'client@example.com' }, ctx)) as {
      identity: { schema: string; enriched: number };
      shm: { matches: Array<{ email: string | null; email_from: string | null; phones: string[] }> };
      warnings: Array<{ code: string }>;
      degraded: Array<{ system: string }>;
    };
    expect(result.identity.schema).toBe('legacy');
    expect(result.identity.enriched).toBe(0);
    expect(result.shm.matches[0]?.email).toBe('client@example.com');
    expect(result.shm.matches[0]?.email_from).toBe('login2');
    expect(result.shm.matches[0]?.phones).toEqual(['79990000001']);
    // Отсутствие маршрута — факт о ВЕРСИИ, а не отказ источника.
    expect(result.degraded).toEqual([]);
    expect(result.warnings.map((w) => w.code)).not.toContain('identity_partial');
    // И больше в accounts не ходим: вердикт закэширован.
    expect(result.warnings.map((w) => w.code)).not.toContain('identity_schema_unknown');
  });

  it('does not read a 500 from the accounts route as "older than 3.0"', async () => {
    // Молчаливое «схема старая» на отвалившемся бэкенде вернуло бы ровно ту
    // тихую поломку, ради которой всё это написано.
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) throw new ShmError('boom', 500);
        return [row30];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: 'petr@example.com' }, ctx)) as {
      identity: { schema: string };
      warnings: Array<{ code: string }>;
      degraded: Array<{ system: string }>;
    };
    expect(result.identity.schema).toBe('unknown');
    expect(result.warnings.map((w) => w.code)).toContain('identity_schema_unknown');
    expect(result.degraded.some((one) => one.system === 'shm')).toBe(true);
  });

  /**
   * РЕГРЕССИЯ НА ГЛАВНУЮ ПОЛОМКУ ВЫДАЧИ: мёртвая колонка уезжала оператору
   * под именем `email`. На проде это выглядело как
   * `{"login":"client@example.com","email":"@123456"}` — «почта» клиента
   * оказывалась чужим по смыслу телеграм-хендлом.
   */
  it('never prints the dead login2 column as the email on the new schema', async () => {
    const ctx = makeCtx({
      shmList: (path) => {
        // Ни одной строки accounts: у клиента почты нет вовсе.
        if (path === ACCOUNTS_PATH) return [];
        if (path === '/admin/user/search') return [row30];
        return [row30];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: 'tg900002' }, ctx)) as {
      identity: { schema: string };
      shm: { matches: Array<{ email: string | null; email_from: string | null }> };
    };
    expect(result.identity.schema).toBe('accounts');
    expect(result.shm.matches[0]?.email).toBeNull();
    expect(result.shm.matches[0]?.email_from).toBeNull();
  });

  it('says out loud which matches it did NOT fill in', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      user_id: 5000 + index,
      login: `tg90000${String(index)}`,
      block: 0,
    }));
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) return [];
        if (path === '/admin/user/search') return many;
        return [];
      },
      remnaGet: () => ({ users: [], nextCursor: null, hasMore: false }),
    });
    const result = (await clientResolve.handler({ query: 'tg9' }, ctx)) as {
      identity: { enriched: number };
      shm: { matches: Array<{ accounts: unknown[] | null }> };
      warnings: Array<{ code: string }>;
    };
    expect(result.identity.enriched).toBe(3);
    expect(result.warnings.map((w) => w.code)).toContain('identity_partial');
    // Те, до кого потолок не дошёл, несут null — «не спрашивали», а не «пусто».
    expect(result.shm.matches[5]?.accounts).toBeNull();
  });
});
