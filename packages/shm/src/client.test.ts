import { describe, expect, it } from 'vitest';
import { Budget, BudgetExceededError } from '@hq/budget';
import { createShmClient } from './client.js';
import { ShmError } from './parse.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
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
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(recorded);
    const { status, body } = reply(recorded);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const cfg = { baseUrl: 'https://billing.example.com/shm/v1', auth: 'mcp:secret' };
const budget = (): Budget => new Budget({ limit: 100, windowMs: 60_000 });
const deps = (fetchImpl: typeof fetch, profile: 'human' | 'bot' = 'human') => ({
  budget: budget(),
  fetchImpl,
  profile,
});

describe('createShmClient.get', () => {
  it('builds the query, sends Basic auth and unwraps the data envelope', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ user_id: 3073 }] }),
    }));
    const client = createShmClient(cfg, { budget: budget(), fetchImpl, profile: 'human' });
    const result = await client.get<Array<{ user_id: number }>>('/admin/user', { user_id: 3073 });
    expect(result).toEqual([{ user_id: 3073 }]);
    expect(calls[0]?.url).toBe('https://billing.example.com/shm/v1/admin/user?user_id=3073');
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from('mcp:secret').toString('base64')}`,
    );
  });

  it('turns an HTML body into a 403 instead of a JSON parse error', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: '<!DOCTYPE html><html></html>' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.get('/admin/user')).rejects.toMatchObject({
      name: 'ShmError',
      status: 403,
      retryable: false,
    });
  });

  it('marks 408 retryable and 404 terminal', async () => {
    const locked = stubFetch(() => ({ status: 408, body: '{"error":"lock timeout"}' }));
    const lockedClient = createShmClient(cfg, deps(locked.fetchImpl));
    await expect(lockedClient.get('/admin/user')).rejects.toMatchObject({
      status: 408,
      retryable: true,
    });

    const missing = stubFetch(() => ({ status: 404, body: '{"error":"not found"}' }));
    const missingClient = createShmClient(cfg, deps(missing.fetchImpl));
    await expect(missingClient.get('/admin/user')).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
  });

  it('locks the budget on 429 so the next call fails without touching the network', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 429, body: 'Too many requests' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.get('/admin/user')).rejects.toMatchObject({
      status: 429,
      retryable: false,
    });
    await expect(client.get('/admin/user')).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it('classifies a 429 served as an HTML page as a rate limit, not as "no rights"', async () => {
    // SHM отдаёт HTML охотно (§6.20). Если проверять HTML раньше статуса, этот
    // ответ станет 403, budget.note429 не вызовется, и следующий вызов уйдёт
    // в сеть добивать общее ведро — ровно механизм инцидента 2026-07-29.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 429,
      body: '<!DOCTYPE html><html><body>429 Too Many Requests</body></html>',
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.get('/admin/user')).rejects.toMatchObject({ status: 429 });
    await expect(client.get('/admin/user')).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it('refuses the GETs that actually mutate', async () => {
    // §6.15: риск классифицируется по имени ручки, никогда по HTTP-методу.
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.get('/promo/apply/SUMMER')).rejects.toMatchObject({ status: 400 });
    await expect(client.get('/template/smena')).rejects.toThrow(/mutates/i);
    await expect(client.get('/template/roulette')).rejects.toThrow(/mutates/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a forbidden path outright', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.get('/admin/server/identity/generate')).rejects.toThrow(/forbidden/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a method-scoped forbidden rule for the method it guards, but not for GET', async () => {
    // /admin/spool — GET стоит за spool_inspect (Task 14) и обязан остаться
    // открыт; запрещён только PUT (создание рассылочной задачи с job_users).
    // Проверка обязана классифицировать по methodу, который реально уходит в
    // запрос, а не игнорировать его: assertNotForbidden(path) без метода
    // никогда не совпадёт ни с одним method-scoped правилом (см. matchForbidden
    // в @hq/registry), и PUT прошёл бы насквозь.
    const ok = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const readClient = createShmClient(cfg, deps(ok.fetchImpl));
    await expect(readClient.get('/admin/spool')).resolves.toEqual([1]);

    const blocked = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const writeClient = createShmClient(cfg, deps(blocked.fetchImpl));
    await expect(writeClient.sendRaw('PUT', '/admin/spool', { job_users: [1, 2] })).rejects.toThrow(
      /forbidden/i,
    );
    expect(blocked.calls).toHaveLength(0);
  });

  it('redacts credentials on the transport layer', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ login: 'tg1', settings: { telegram: { token: 'abc' } } }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const result = await client.get<Array<Record<string, unknown>>>('/admin/user');
    expect(JSON.stringify(result)).not.toContain('abc');
    expect(JSON.stringify(result)).toContain('<redacted>');
  });

  it('keeps the payment transaction id readable instead of masking it by name collision', async () => {
    // `pays_history.uniq_key` — идентификатор транзакции у платёжной системы
    // (по нему стоит UNIQUE(user_id,uniq_key), которым SHM режет дубли
    // зачислений), то есть ровно то поле, по которому разбирают двойное
    // списание. Секретом оно не является — но имя матчит SECRET_KEY_RE
    // (`key`), а редакция здесь идёт по ИМЕНИ поля и ДО того, как ответ
    // увидит инструмент: переименовать его на выходе billing_ledger нельзя,
    // там оно уже маркер. Проверено на работающей SHM: uniq_key приезжал
    // '<redacted>' в каждой строке.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [{ id: 10, money: 100, uniq_key: 'platega-7f3a', pay_system_id: 'platega' }],
      }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const rows = await client.get<Array<Record<string, unknown>>>('/admin/user/pay');
    expect(rows[0]?.uniq_id).toBe('platega-7f3a');
    expect(rows[0]?.uniq_key).toBeUndefined();
  });

  it('keeps the two sign-in flags readable, and leaves the third one alone on purpose', async () => {
    // `GET /user/password-auth` отдаёт четыре булевых флага, и три из них
    // матчили SECRET_KEY_RE по словам `password` и `key`. Проверено на работающей
    // SHM 2.19.4 2026-08-13: маршрут, существующий ровно затем, чтобы сказать
    // «может ли этот клиент войти по паролю», отвечал тремя маркерами из
    // четырёх полей.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          {
            password_auth_disabled: 0,
            password_set_by_user: 1,
            passkey_enabled: 1,
            otp_enabled: 0,
          },
        ],
      }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const rows = await client.get<Array<Record<string, unknown>>>('/user/password-auth');
    expect(rows[0]?.pwd_login_disabled).toBe(0);
    expect(rows[0]?.pwd_set_by_user).toBe(1);
    expect(rows[0]?.otp_enabled).toBe(0);
    // `passkey_enabled` НЕ переименован и остаётся маркером: любое имя без
    // слова `key` перестаёт называть вещь своим именем, а тот же факт лежит
    // целым в `enabled` ответа `GET /user/passkey`.
    expect(rows[0]?.passkey_enabled).toBe('<redacted>');
    expect(rows[0]?.password_auth_disabled).toBeUndefined();
    expect(rows[0]?.password_set_by_user).toBeUndefined();
  });

  it('still masks a field that IS a secret, next to the renamed one', async () => {
    // Переименование — точечное исключение, а не ослабление правила:
    // `users.password` рядом обязан остаться маркером.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ user_id: 1, password: 'hash', uniq_key: 'k-1' }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const rows = await client.get<Array<Record<string, unknown>>>('/admin/user');
    expect(rows[0]?.password).toBe('<redacted>');
    expect(rows[0]?.uniq_id).toBe('k-1');
  });

  it('leaves the raw channel byte-faithful: a write body is built from it', async () => {
    // getRaw кормит read-merge-write плана 2. Переименованное там поле уехало
    // бы в PATCH под именем, которого бэкенд не знает.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 10, uniq_key: 'platega-7f3a' }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const rows = await client.getRaw<Array<Record<string, unknown>>>('/admin/user/pay');
    expect(rows[0]?.uniq_key).toBe('platega-7f3a');
    expect(rows[0]?.uniq_id).toBeUndefined();
  });

  it('hands redact only an object or an array of objects, never a bare array of strings', async () => {
    // §7.2 (carry-forward de Task 3): redact маскирует по ИМЕНИ поля. Голый
    // массив строк или голая строка на верхнем уровне проезжает мимо любой
    // маски. Конверты SHM — всегда объекты ({data: ...}), и unwrapShm снимает
    // ровно один уровень, так что до redact доходит объект или массив
    // объектов, а не голый список кред-строк.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const result = await client.get<Array<Record<string, unknown>>>('/admin/user');
    expect(Array.isArray(result)).toBe(true);
    for (const item of result) {
      expect(typeof item).toBe('object');
      expect(item).not.toBeNull();
      expect(Array.isArray(item)).toBe(false);
    }
  });
});

describe('createShmClient budget key normalization', () => {
  // Budget evicts pull-based with no timer (Task 4's carry-forward requirement):
  // a per-request-shaped key never gets cleaned up and grows the Map without
  // bound in a long-lived server. These prove the key collapses ids embedded
  // INSIDE a path segment, not just whole numeric segments, while still
  // keeping genuinely different route names apart.
  it('collapses a numeric id embedded in an alphanumeric path segment into the same budget key', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, {
      budget: new Budget({ limit: 1, windowMs: 60_000 }),
      fetchImpl,
      profile: 'human',
    });
    await client.get('/admin/storage/manage/vpn_mrzb_1');
    await expect(client.get('/admin/storage/manage/vpn_mrzb_999999')).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(calls).toHaveLength(1);
  });

  it('collapses a whole-numeric path segment into the same budget key', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, {
      budget: new Budget({ limit: 1, windowMs: 60_000 }),
      fetchImpl,
      profile: 'human',
    });
    await client.get('/admin/user/123');
    await expect(client.get('/admin/user/456')).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(1);
  });

  it('keeps genuinely different route names as different budget keys', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, {
      budget: new Budget({ limit: 1, windowMs: 60_000 }),
      fetchImpl,
      profile: 'human',
    });
    await client.get('/admin/user/service');
    await expect(client.get('/admin/user/search')).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });
});

describe('createShmClient.getRaw / sendRaw', () => {
  it('returns the unredacted value for read-merge-write and rollback snapshots', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ name: 'vpn_mrzb_3073', value: { subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP' } }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const safe = await client.get<Array<Record<string, unknown>>>('/admin/storage/manage/vpn_mrzb_3073');
    expect(JSON.stringify(safe)).toContain('*');
    const raw = await client.getRaw<Array<Record<string, unknown>>>(
      '/admin/storage/manage/vpn_mrzb_3073',
    );
    expect(JSON.stringify(raw)).toContain('aBcDeFgHiJkLmNoP');
  });

  it('still obeys the budget and the forbidden list', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[1]}' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.getRaw('/promo/apply/SUMMER')).rejects.toThrow(/mutates/i);
    // PUT (создать шаблон) закрыт, POST (перезаписать существующий) — открыт
    // под template_edit: гейт различает методы, а не пути.
    await expect(client.sendRaw('PUT', '/admin/template')).rejects.toThrow(/forbidden/i);
    expect(calls).toHaveLength(0);
  });
});

describe('createShmClient.list', () => {
  it('preserves items and caps the limit', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 1 }], items: 8123, limit: 500, offset: 0 }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    const result = await client.list<{ id: number }>('/admin/user', { limit: 10_000 });
    expect(result.items).toBe(8123);
    expect(result.data).toEqual([{ id: 1 }]);
    expect(calls[0]?.url).toContain('limit=500');
  });

  it('refuses limit=0 because for an admin it means a full table dump', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"data":[]}' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.list('/admin/user', { limit: 0 })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('createShmClient.action', () => {
  it('merges query params into the JSON body and always sends Content-Type', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 99 }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await client.action('POST', '/admin/user/service/change', { finish_active: 0 }, { user_id: 3073 });
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.url).toContain('user_id=3073');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ user_id: 3073, finish_active: 0 });
  });

  it('lets a query-string parameter win over a same-named body field on collision', async () => {
    // Core/Utils.pm:262 — parse_args ends with `return %in, get_uri_args()`,
    // so the query string is merged in LAST and wins on a key collision.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 99 }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await client.action(
      'POST',
      '/admin/user/service/change',
      { finish_active: 1 },
      { finish_active: 0 },
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ finish_active: 0 });
  });

  it('merges non-colliding query params and body fields together', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 99 }] }),
    }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await client.sendRaw('POST', '/admin/user/service/touch', { user_service_id: 1 }, { reason: 'test' });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ reason: 'test', user_service_id: 1 });
  });

  it('applies the false-success guard', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: '{"data":[null]}' }));
    const client = createShmClient(cfg, deps(fetchImpl));
    await expect(client.action('POST', '/admin/user/service/touch', { user_service_id: 1 })).rejects.toThrow(
      ShmError,
    );
  });
});
