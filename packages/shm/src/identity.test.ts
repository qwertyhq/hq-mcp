import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientParams, ShmClient, ShmListResult } from '@hq/types';
import { ShmError } from './parse.js';
import {
  ACCOUNTS_PATH,
  emailOfAccounts,
  identitySchemaOfRow,
  lookupAccounts,
  normalizeAccount,
  phonesOfAccounts,
  resetIdentitySchemaCache,
  telegramIdOfAccounts,
} from './identity.js';

interface Call {
  path: string;
  params: ClientParams | undefined;
}

function stubShm(
  rows: (path: string, params?: ClientParams) => unknown[],
  calls: Call[] = [],
): ShmClient {
  const refuse = (): Promise<never> => Promise.reject(new Error('not used here'));
  return {
    get: refuse,
    action: refuse,
    getRaw: refuse,
    sendRaw: refuse,
    list: async <T>(path: string, params?: ClientParams): Promise<ShmListResult<T>> => {
      calls.push({ path, params });
      const data = rows(path, params);
      return { items: data.length, limit: 25, offset: 0, data: data as T[] };
    },
  };
}

const NOW = (): Date => new Date('2026-09-20T10:00:00.000Z');

beforeEach(() => {
  resetIdentitySchemaCache();
});

describe('normalizeAccount', () => {
  it('re-keys the value so @hq/redact can mask it by field name', () => {
    // В базе 3.0 почта и телефон лежат в колонке `login`, а маскирование PII в
    // @hq/redact идёт ПО ИМЕНИ ПОЛЯ. Раскладка по kind — это и есть починка.
    const email = normalizeAccount({
      login: 'a@b.test',
      type: 'email',
      user_id: 7,
      settings: { email: { verified: 1 } },
    });
    expect(email).toMatchObject({ kind: 'email', email: 'a@b.test', login: null, phone: null });
    expect(email.verified).toBe(true);

    const phone = normalizeAccount({ login: '79990000000', type: 'phone', user_id: 7 });
    expect(phone).toMatchObject({ kind: 'phone', phone: '79990000000', login: null, email: null });
  });

  it('reads settings that arrived as a JSON string, like users.settings does', () => {
    const row = normalizeAccount({
      login: 'a@b.test',
      type: 'email',
      user_id: 7,
      settings: '{"email":{"verified":0}}',
    });
    expect(row.verified).toBe(false);
  });

  it('keeps an unknown type visible instead of dropping the row', () => {
    const row = normalizeAccount({ login: 'x', type: 'oauth2', user_id: 7 });
    expect(row.kind).toBe('other');
    expect(row.type).toBe('oauth2');
    expect(row.login).toBe('x');
  });

  it('turns a telegram row into a number as well as a string', () => {
    const row = normalizeAccount({ login: '900002', type: 'telegram', user_id: 7 });
    expect(row.telegram_id).toBe(900002);
    expect(row.login).toBe('900002');
  });
});

describe('lookupAccounts', () => {
  it('refuses to ask for the whole table', async () => {
    const shm = stubShm(() => []);
    // @ts-expect-error — ровно этот вызов и запрещён: без сужения маршрут
    // отдаёт логины, почты и телефоны ВСЕЙ базы одной страницей.
    await expect(lookupAccounts(shm, {}, NOW)).rejects.toThrow();
    await expect(lookupAccounts(shm, { user_id: 0 }, NOW)).rejects.toThrow(/positive/);
    await expect(lookupAccounts(shm, { login: '   ' }, NOW)).rejects.toThrow(/empty/);
  });

  it('asks by the table key, lower-cased, so the match is exact and not a substring', async () => {
    const calls: Call[] = [];
    const shm = stubShm(() => [], calls);
    await lookupAccounts(shm, { login: 'Petr@Example.COM' }, NOW);
    expect(calls[0]?.path).toBe(ACCOUNTS_PATH);
    expect(calls[0]?.params).toMatchObject({ login: 'petr@example.com' });
  });

  it('asks about one client through filter, never through ?user_id=', async () => {
    // `?user_id=` заставляет диспетчер SHM звать switch_user, и на
    // несуществующем клиенте это ломает обработчик вместо пустого ответа.
    const calls: Call[] = [];
    const shm = stubShm(() => [], calls);
    await lookupAccounts(shm, { user_id: 42 }, NOW);
    expect(calls[0]?.params).toMatchObject({ filter: JSON.stringify({ user_id: 42 }) });
    expect(calls[0]?.params).not.toHaveProperty('user_id');
  });

  it('reads the router 404 as "older than 3.0" and caches that verdict', async () => {
    const calls: Call[] = [];
    const shm = stubShm(() => {
      throw new ShmError('Method not found', 404);
    }, calls);
    const first = await lookupAccounts(shm, { login: 'a@b.test' }, NOW);
    expect(first).toEqual({ schema: 'legacy', accounts: [], error: null });
    const second = await lookupAccounts(shm, { login: 'c@d.test' }, NOW);
    expect(second.schema).toBe('legacy');
    // Второй вызов до SHM не дошёл вовсе — иначе каждый резолв на установке
    // до 3.0 платил бы лишним 404.
    expect(calls).toHaveLength(1);
  });

  it('re-probes once the verdict is older than the migration window', async () => {
    const calls: Call[] = [];
    let alive = false;
    const shm = stubShm(() => {
      if (!alive) throw new ShmError('Method not found', 404);
      return [{ login: 'a@b.test', type: 'email', user_id: 7 }];
    }, calls);
    let clock = new Date('2026-09-20T10:00:00.000Z');
    const now = (): Date => clock;

    expect((await lookupAccounts(shm, { login: 'a@b.test' }, now)).schema).toBe('legacy');
    alive = true;
    // Внутри окна вердикт держится — миграцию ещё не накатили.
    expect((await lookupAccounts(shm, { login: 'a@b.test' }, now)).schema).toBe('legacy');
    clock = new Date('2026-09-20T10:02:00.000Z');
    const after = await lookupAccounts(shm, { login: 'a@b.test' }, now);
    expect(after.schema).toBe('accounts');
    expect(after.accounts[0]?.email).toBe('a@b.test');
  });

  it('does NOT read any other failure as "older than 3.0"', async () => {
    const shm = stubShm(() => {
      throw new ShmError('Permission denied', 403);
    });
    const result = await lookupAccounts(shm, { login: 'a@b.test' }, NOW);
    expect(result.schema).toBe('unknown');
    expect(result.error).toContain('Permission denied');
    expect(result.accounts).toEqual([]);
  });
});

describe('picking one value out of the accounts of a client', () => {
  const accounts = [
    normalizeAccount({ login: 'tg1', type: 'login', user_id: 7, primary: 1 }),
    normalizeAccount({ login: 'old@b.test', type: 'email', user_id: 7, settings: { email: { verified: 0 } } }),
    normalizeAccount({ login: 'new@b.test', type: 'email', user_id: 7, settings: { email: { verified: 1 } } }),
    normalizeAccount({ login: '79990000000', type: 'phone', user_id: 7 }),
    normalizeAccount({ login: '900002', type: 'telegram', user_id: 7 }),
  ];

  it('prefers the verified address over the one the client merely typed', () => {
    expect(emailOfAccounts(accounts)).toBe('new@b.test');
  });

  it('returns every phone, because 3.0 lets a client carry several', () => {
    expect(phonesOfAccounts(accounts)).toEqual(['79990000000']);
  });

  it('reads the telegram binding out of its own row', () => {
    expect(telegramIdOfAccounts(accounts)).toBe(900002);
  });

  it('says nothing rather than guessing when the client has no email row', () => {
    expect(emailOfAccounts([accounts[0] as never])).toBeNull();
  });
});

describe('identitySchemaOfRow', () => {
  it('recognises the pre-3.0 client row by the column 3.0 dropped from the structure', () => {
    expect(identitySchemaOfRow({ user_id: 1, login: 'a', login2: null })).toBe('legacy');
  });

  it('refuses to call a row without login2 "the new schema" — it only knows it is not the old one', () => {
    expect(identitySchemaOfRow({ user_id: 1, login: 'a' })).toBe('unknown');
  });
});
