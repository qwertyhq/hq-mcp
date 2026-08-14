import { describe, expect, it } from 'vitest';
import { Budget } from '@hq/budget';
import { RemnaError, createRemnaClient, unwrapRemna } from './index.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stubFetch(
  reply: (recorded: Recorded) => { status: number; body: string },
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(recorded);
    const { status, body } = reply(recorded);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const cfg = { baseUrl: 'https://panel.example.com', token: 'jwt-token' };
const budget = (): Budget => new Budget({ limit: 100, windowMs: 60_000 });
const deps = (fetchImpl: typeof fetch, profile: 'human' | 'bot' = 'human') => ({
  budget: budget(),
  fetchImpl,
  profile,
});

describe('unwrapRemna', () => {
  it('peels the response envelope', () => {
    expect(unwrapRemna({ response: [{ uuid: 'a' }] })).toEqual([{ uuid: 'a' }]);
    expect(unwrapRemna({ uuid: 'a' })).toEqual({ uuid: 'a' });
  });
});

describe('createRemnaClient', () => {
  it('sends the bearer token and unwraps the response envelope', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ response: { uuid: 'u-1', username: 'tg900001' } }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const user = await client.get<{ uuid: string }>('/api/users/u-1');
    expect(user.uuid).toBe('u-1');
    expect(calls[0]?.headers.Authorization).toBe('Bearer jwt-token');
    expect(calls[0]?.url).toBe('https://panel.example.com/api/users/u-1');
  });

  it('refuses to read a router 404 as absence — a removed route is our defect', async () => {
    // Verified against a running Remnawave 3.2.3: by-telegram-id, by-email
    // and by-tag are GONE. The panel answers them with the Nest router 404
    // captured verbatim below — no errorCode, message "Cannot GET <path>".
    // On 2.8 this client mapped that status to "no such user", which was
    // correct then and is a LIE now: calling a route that no longer exists is
    // a defect in us, and it must be loud. Silence here is precisely how
    // client_resolve came to report a confident, empty `remna` block against a
    // panel that had the client all along.
    for (const path of [
      '/api/users/by-telegram-id/900001',
      '/api/users/by-email/someone@example.com',
      '/api/users/by-tag/HQ',
    ]) {
      const { fetchImpl } = stubFetch(() => ({
        status: 404,
        body: JSON.stringify({
          message: `Cannot GET ${path}`,
          error: 'Not Found',
          statusCode: 404,
        }),
      }));
      const client = createRemnaClient(cfg, deps(fetchImpl));
      await expect(client.get(path)).rejects.toMatchObject({ name: 'RemnaError', status: 404 });
    }
  });

  it('names the panel version contract in the router-404 message', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 404,
      body: JSON.stringify({
        message: 'Cannot GET /api/users/by-telegram-id/900001',
        error: 'Not Found',
        statusCode: 404,
      }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/users/by-telegram-id/900001')).rejects.toThrow(
      /route does not exist on this panel/i,
    );
  });

  it('puts the panel body last so a safety strip cannot eat the sentence that matters', async () => {
    // Тело, не похожее на JSON (страница прокси, например), уезжает в
    // сообщение под маркером `HTTP 404: `, а страховочная стрижка исполнителя
    // (packages/exec/src/index.ts) режет от этого маркера и до конца строки.
    // Стоя в середине, тело уносило с собой самое важное предложение — то, что
    // это роутерный 404, а не отсутствующий клиент.
    const { fetchImpl } = stubFetch(() => ({
      status: 404,
      body: '<!DOCTYPE html><title>nginx</title>',
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const message = await client
      .get('/api/users/by-telegram-id/900001')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)));
    const beforeTheBody = message.split('HTTP 404: ')[0] ?? '';
    expect(beforeTheBody).toContain('Do not read this as an absent client');
    expect(beforeTheBody).toContain('router 404');
    expect(message).toMatch(/HTTP 404: <!DOCTYPE html>/);
  });

  it('resolves to null (not a throw) on an application 404 for the single-user lookups', async () => {
    // The surviving object-shaped half of §6.16 on 3.2.3: by-username,
    // by-short-uuid and the bare /api/users/{numericId} answer an OBJECT when
    // found and an APPLICATION 404 when not. That body carries an errorCode
    // (A063) and is the panel speaking — reading it as a transport failure is
    // the support-bot mistake from the brief. Body captured from a running panel.
    for (const path of [
      '/api/users/by-username/someone',
      '/api/users/by-short-uuid/aBcDeF',
      '/api/users/12345',
    ]) {
      const { fetchImpl } = stubFetch(() => ({
        status: 404,
        body: JSON.stringify({
          timestamp: '2024-01-01T00:00:00.000Z',
          path,
          message: 'User with specified params not found',
          errorCode: 'A063',
        }),
      }));
      const client = createRemnaClient(cfg, deps(fetchImpl));
      await expect(client.get(path)).resolves.toBeNull();
    }
  });

  it('does not read a uuid-shaped user path as a single-user lookup any more', async () => {
    // 3.x dropped `uuid` from the user object entirely; the path parameter is
    // `userId` and it is a NUMBER. A uuid handed to this route is rejected at
    // validation (live: 400 "Validation failed", path ["userId"]), so there is
    // no 404 to soften — and a stale uuid must never look like a clean absence.
    const { fetchImpl } = stubFetch(() => ({
      status: 400,
      body: JSON.stringify({ statusCode: 400, message: 'Validation failed' }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(
      client.get('/api/users/11111111-1111-1111-1111-111111111111'),
    ).rejects.toMatchObject({ name: 'RemnaError', status: 400 });
  });

  it('still throws on a 5xx for the same object-shaped lookups — 404 is the only "absent" signal', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 500, body: '{"message":"boom"}' }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/users/by-username/ivan')).rejects.toMatchObject({
      name: 'RemnaError',
      status: 500,
    });
    expect(calls).toHaveLength(1);
  });

  it('does not swallow a 404 as "not found" for a non-GET on the same path shape', async () => {
    // The numeric-id path also carries mutations (PATCH/DELETE by id in plan
    // 2) — a 404 there is a real failure ("nothing to delete/update"), not a
    // silent success, so the null-on-404 rule is GET-only.
    const { fetchImpl } = stubFetch(() => ({
      status: 404,
      body: JSON.stringify({ message: 'User with specified params not found', errorCode: 'A063' }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.send('DELETE', '/api/users/11221')).rejects.toMatchObject({
      name: 'RemnaError',
      status: 404,
    });
  });

  it('still throws on a 404 of a regular route', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: '{"message":"no such node"}' }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/nodes/zzz')).rejects.toMatchObject({
      name: 'RemnaError',
      status: 404,
    });
  });

  it('does not treat a 5xx on a user lookup as not-found', async () => {
    // §"HTTP error must never be interpreted as absence": only an application
    // 404 on a surviving single-user route means "no such user". A 500 is a
    // real backend failure and must propagate as an error, not silently
    // become an absence — that is exactly the support-bot mistake from the brief.
    const { fetchImpl, calls } = stubFetch(() => ({ status: 500, body: '{"message":"boom"}' }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/users/by-telegram-id/900001')).rejects.toMatchObject({
      name: 'RemnaError',
      status: 500,
    });
    expect(calls).toHaveLength(1);
  });

  it('locks the budget on 429 and does not repeat the call', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 429, body: 'slow down' }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/users')).rejects.toMatchObject({
      name: 'RemnaError',
      status: 429,
    });
    // The SECOND call never reaches the network: Budget.note429 locked the
    // bucket, so client.get('/api/users') now throws the budget gate's own
    // BudgetExceededError (@hq/budget), not RemnaError — same pattern as
    // packages/shm/src/client.test.ts, asserted by message rather than by
    // class for exactly that reason.
    await expect(client.get('/api/users')).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it('collapses a uuid embedded in the path into the same budget key', async () => {
    // §5 carry-forward: budget keys must stay low-cardinality. A uuid per
    // user in the path must not mint a fresh bucket per user.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ response: { uuid: 'x' } }),
    }));
    const client = createRemnaClient(cfg, {
      budget: new Budget({ limit: 1, windowMs: 60_000 }),
      fetchImpl,
      profile: 'human',
    });
    await client.get('/api/users/11111111-1111-1111-1111-111111111111');
    await expect(
      client.get('/api/users/22222222-2222-2222-2222-222222222222'),
    ).rejects.toMatchObject({ name: 'BudgetExceededError' });
    expect(calls).toHaveLength(1);
  });

  it('redacts connection credentials on the transport layer', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        response: { uuid: 'u-1', trojanPassword: 'plain', vlessUuid: 'plain-uuid' },
      }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const user = await client.get<Record<string, unknown>>('/api/users/u-1');
    expect(user.trojanPassword).toBe('<redacted>');
    expect(user.vlessUuid).toBe('<redacted>');
    expect(user.uuid).toBe('u-1');
  });

  it('masks links/ssConfLinks by key name — a working vless:// URL never survives redaction', async () => {
    // §7.2 carry-forward (Task 3): redaction is field-NAME driven. links and
    // ssConfLinks are arrays of live vless:// URLs; they are masked only
    // because unwrapRemna hands redact() an OBJECT with those keys, not a
    // bare top-level array that would slip past CREDENTIAL_KEYS.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        response: {
          uuid: 'u-1',
          links: ['vless://secret-a'],
          ssConfLinks: ['vless://secret-b'],
        },
      }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const user = await client.get<Record<string, unknown>>('/api/users/u-1');
    expect(user.links).toBe('<redacted>');
    expect(user.ssConfLinks).toBe('<redacted>');
    expect(JSON.stringify(user)).not.toContain('vless://secret');
  });

  it('gives read-merge-write an unredacted channel that never reaches a tool answer', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        response: {
          uuid: 'h-1',
          isDisabled: false,
          subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP',
        },
      }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const masked = await client.get<Record<string, unknown>>('/api/hosts/h-1');
    expect(String(masked.subscriptionUrl)).toContain('*');
    // Именно это значение уходит в тело PATCH и в rollback.body плана 2:
    // записать в панель маскированную строку — это авария, а не редакция.
    const raw = await client.getRaw<Record<string, unknown>>('/api/hosts/h-1');
    expect(raw.subscriptionUrl).toBe('https://sub.example.com/aBcDeFgHiJkLmNoP');
    expect(raw.isDisabled).toBe(false);
  });

  it('refuses a forbidden path on both channels', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"response":{}}' }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await expect(client.get('/api/tokens')).rejects.toThrow(/forbidden/i);
    await expect(client.getRaw('/api/subscriptions/abc')).rejects.toThrow(/forbidden/i);
    await expect(client.sendRaw('POST', '/api/nodes/actions/restart-all')).rejects.toThrow(
      /forbidden/i,
    );
    expect(calls).toHaveLength(0);
  });

  it('sends a JSON body on PATCH', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(JSON.stringify({ response: { uuid: 'h-1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRemnaClient(cfg, deps(fetchImpl));
    await client.send('PATCH', '/api/hosts', { uuid: 'h-1', isDisabled: false });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ uuid: 'h-1', isDisabled: false });
  });

  /**
   * `showConnectionKeys` — булев переключатель страницы подписки, а не ключ.
   * Его имя матчит /key/i в @hq/redact, и без переименования ДО редакции
   * вызывающий получал '<redacted>' вместо true/false: единственный ответ на
   * «раздаёт ли страница готовые конфиги» был нечитаем. Найдено прогоном по
   * работающей панели 3.2.3, тот же класс, что `uniq_key` в @hq/shm.
   */
  it('renames the page flag whose name collides with the mask, keeping its value', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        response: { config: { baseSettings: { showConnectionKeys: false, metaTitle: 'HQ' } } },
      }),
    }));
    const client = createRemnaClient(cfg, deps(fetchImpl));
    const body = (await client.get('/api/subscription-page-configs/x')) as {
      config: { baseSettings: Record<string, unknown> };
    };
    expect(body.config.baseSettings.showConnectionCreds).toBe(false);
    expect(body.config.baseSettings).not.toHaveProperty('showConnectionKeys');
    // Соседнее поле не тронуто: карта закрытая, а не эвристика.
    expect(body.config.baseSettings.metaTitle).toBe('HQ');
  });
});
