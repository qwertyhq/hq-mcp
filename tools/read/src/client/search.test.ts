import { beforeEach, describe, expect, it } from 'vitest';
import { createProbeStore } from '@hq/registry';
import { ShmError } from '@hq/shm';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ACCOUNTS_PATH, resetIdentitySchemaCache } from '../kit.js';
import { UNKNOWN_CAPABILITIES } from '../platform/probe.js';
import { clientSearch } from './search.js';

interface SearchOut {
  items: number;
  limit: number;
  matches: Array<{ user_id: number; blocked: boolean }>;
  warnings: Array<{ code: string }>;
}

const active = { user_id: 1, login: 'active', block: 0 };
const blocked = { user_id: 2, login: 'blocked_active', block: 1 };

/** Установка до 3.0: маршрута `accounts` в роутере нет, SHM отвечает 404. */
function legacy(rows: (path: string) => unknown): (path: string) => unknown {
  return (path: string): unknown => {
    if (path === ACCOUNTS_PATH) throw new ShmError('Method not found', 404);
    return rows(path);
  };
}

describe('client_search', () => {
  beforeEach(() => {
    resetIdentitySchemaCache();
  });

  it('hides blocked clients by default and says so out loud', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: legacy(() => ({ items: 1, limit: 25, offset: 0, data: [active] })),
    });
    const result = (await clientSearch.handler(
      { text: 'active', include_blocked: false, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.matches).toHaveLength(1);
    expect(result.items).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain('blocked_hidden');
    // Два запроса, а не один: поиск и ОДНА проба схемы идентичности. Проба
    // сужена по найденному клиенту — голый список `accounts` это выгрузка
    // почт и телефонов всей базы.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toEqual({ text: 'active', limit: 25 });
    expect(calls[1]?.path).toBe(ACCOUNTS_PATH);
    expect(calls[1]?.params).toMatchObject({ filter: JSON.stringify({ user_id: 1 }) });
  });

  /**
   * ПОЧТА КЛИЕНТА С 3.0 В СТРОКЕ НЕ ЖИВЁТ, А КОЛОНКА `login2` — ЖИВЁТ.
   *
   * Миграция её не дропает, `/admin/user` отдаёт физические колонки целиком,
   * и напечатанная как `email` она даёт довоенный адрес, а на
   * телеграм-регистрации — хендл `@<id>`. Поиск ПО ней при этом остаётся: тот,
   * кто ввёл старый адрес, ищет человека.
   */
  it('does not print the dead login2 column as an email on the new schema', async () => {
    const row = { user_id: 5, login: 'tg123456', login2: '@123456', block: 0 };
    const ctx = makeCtx({
      shmList: (path) =>
        path === ACCOUNTS_PATH
          ? [{ login: 'tg123456', type: 'login', user_id: 5 }]
          : { items: 1, limit: 25, offset: 0, data: [row] },
    });
    const result = (await clientSearch.handler(
      { text: '123456', include_blocked: false, limit: 25 },
      ctx,
    )) as SearchOut & { matches: Array<{ email: string | null }> };
    expect(result.matches[0]?.email).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('identity_not_in_row');
  });

  it('still reads login2 as the email on a pre-3.0 install', async () => {
    const row = { user_id: 5, login: 'ivan', login2: 'ivan@example.test', block: 0 };
    const ctx = makeCtx({
      shmList: legacy(() => ({ items: 1, limit: 25, offset: 0, data: [row] })),
    });
    const result = (await clientSearch.handler(
      { text: 'ivan', include_blocked: false, limit: 25 },
      ctx,
    )) as SearchOut & { matches: Array<{ email: string | null }> };
    expect(result.matches[0]?.email).toBe('ivan@example.test');
    expect(result.warnings.map((w) => w.code)).not.toContain('identity_not_in_row');
  });

  it('merges the blocked list, filters it locally and dedups by user_id', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? { items: 1, limit: 25, offset: 0, data: [active] }
          : {
              items: 2,
              limit: 25,
              offset: 0,
              data: [blocked, { user_id: 1, login: 'active', block: 1 }, { user_id: 9, login: 'other', block: 1 }],
            },
    });
    const result = (await clientSearch.handler(
      { text: 'active', include_blocked: true, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.matches.map((m) => m.user_id).sort()).toEqual([1, 2]);
    expect(result.matches.find((m) => m.user_id === 2)?.blocked).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('blocked_filtered_client_side');
  });

  it('caps the limit so an admin cannot dump the whole table', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmList: () => [] });
    const result = (await clientSearch.handler(
      { text: 'a', include_blocked: false, limit: 10_000 },
      ctx,
    )) as SearchOut;
    expect(result.limit).toBe(200);
    expect(calls[0]?.params).toEqual({ text: 'a', limit: 200 });
  });

  it('establishes from the response that the blocked listing really is blocked clients', async () => {
    // Гейт по probe тут не срабатывает НИКОГДА в обычной сессии: ctx.probe —
    // свежее хранилище на рантайм, писать в него умеет только platform_probe,
    // и без его вызова `get()` — null. Значит единственный сигнал должен
    // приходить из самого ответа, как это делает сосед sync_audit:317.
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? { items: 0, limit: 25, offset: 0, data: [] }
          : { items: 2, limit: 25, offset: 0, data: [{ user_id: 7, login: 'a7', block: 0 }] },
    });
    const result = (await clientSearch.handler(
      { text: 'a', include_blocked: true, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.warnings.map((w) => w.code)).toContain('blocked_filter_not_applied');
  });

  it('reports the block flag the row carries instead of stamping every row blocked', async () => {
    // `blocked: true` безусловно — это утверждение о клиенте, сделанное из
    // того, ПО КАКОЙ ручке приехала строка. Когда фильтр не сработал, строка
    // из «списка заблокированных» — обычный незаблокированный клиент, и
    // ответ обязан говорить то же, что говорит его колонка block.
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? { items: 0, limit: 25, offset: 0, data: [] }
          : { items: 2, limit: 25, offset: 0, data: [{ user_id: 7, login: 'a7', block: 0 }] },
    });
    const result = (await clientSearch.handler(
      { text: 'a7', include_blocked: true, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.matches.find((m) => m.user_id === 7)?.blocked).toBe(false);
  });

  it('keeps quiet about the filter when the listing itself looks filtered', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user/search'
          ? { items: 0, limit: 25, offset: 0, data: [] }
          : { items: 1, limit: 25, offset: 0, data: [blocked] },
    });
    const result = (await clientSearch.handler(
      { text: 'blocked', include_blocked: true, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.warnings.map((w) => w.code)).not.toContain('blocked_filter_not_applied');
  });

  it('says out loud that the blocked half is unreliable when probe found filter broken', async () => {
    // Q1 спеки: server-side filter не использует ни один реальный клиент SHM,
    // и вся ветка include_blocked построена на нём. Если probe выяснил, что фильтр не
    // работает, полученный «список заблокированных» — это просто первые строки
    // таблицы, и молчать об этом нельзя.
    const probe = createProbeStore();
    probe.set({
      checkedAt: '2026-08-08T12:00:00.000Z',
      cached: false,
      shm: {
        configured: true,
        reachable: true,
        error: null,
        spoolStatuses: [],
        version: null,
        live: true,
        credentialsRejected: false,
      },
      remna: {
        configured: true,
        reachable: true,
        error: null,
        version: '2.8.0',
        credentialsRejected: false,
        runtime: null,
      },
      capabilities: { ...UNKNOWN_CAPABILITIES, 'shm.filter': false },
      warnings: [],
    });
    const ctx = makeCtx({ probe, shmList: () => ({ items: 0, limit: 25, offset: 0, data: [] }) });
    const result = (await clientSearch.handler(
      { text: 'a', include_blocked: true, limit: 25 },
      ctx,
    )) as SearchOut;
    // Тот же код, что и у эмпирической проверки: факт один — «фильтр не
    // сузил выборку», — а чем он установлен, говорит текст предупреждения.
    expect(result.warnings.map((w) => w.code)).toContain('blocked_filter_not_applied');
  });

  it('is visible to both profiles', () => {
    // Оператору в панели поддержки поиск нужен; PII в строках режет redact
    // по профилю, а не отсутствие инструмента.
    expect(clientSearch.profiles).toEqual(['human', 'bot']);
  });

  describe('the merged union can exceed the cap independently of either call', () => {
    // Fix round 1, Finding 1 (Important, plan-mandated): primaryOut/blockedOut
    // each warn about THEIR OWN truncation via listOut, but the union of two
    // untruncated calls can still overflow `cap` at the merge step — that loss
    // had no warning of its own. §6.4: both real-world clients lose pagination
    // exactly this way.
    function row(id: number, tag: string, block: 0 | 1): Record<string, unknown> {
      return { user_id: id, login: `${tag}${id}`, block };
    }

    it('warns with the real combined total when the merged union exceeds the cap', async () => {
      const primaryRows = Array.from({ length: 30 }, (_, i) => row(i + 1, 'q', 0));
      const blockedRows = Array.from({ length: 20 }, (_, i) => row(1000 + i + 1, 'q', 1));
      const ctx = makeCtx({
        shmList: (path) =>
          path === '/admin/user/search'
            ? { items: 30, limit: 40, offset: 0, data: primaryRows }
            : { items: 20, limit: 40, offset: 0, data: blockedRows },
      });
      const result = (await clientSearch.handler(
        { text: 'q', include_blocked: true, limit: 40 },
        ctx,
      )) as SearchOut;
      expect(result.matches).toHaveLength(40);
      const truncated = result.warnings.find((w) => w.code === 'truncated');
      expect(truncated).toBeDefined();
      // 30 + 20 = 50 distinct clients found in total, not 40.
      expect((truncated as unknown as { message: string }).message).toContain('50');
    });

    it('does not warn when the merged union fits under the cap', async () => {
      const primaryRows = Array.from({ length: 5 }, (_, i) => row(i + 1, 'q', 0));
      const blockedRows = Array.from({ length: 3 }, (_, i) => row(1000 + i + 1, 'q', 1));
      const ctx = makeCtx({
        shmList: (path) =>
          path === '/admin/user/search'
            ? { items: 5, limit: 40, offset: 0, data: primaryRows }
            : { items: 3, limit: 40, offset: 0, data: blockedRows },
      });
      const result = (await clientSearch.handler(
        { text: 'q', include_blocked: true, limit: 40 },
        ctx,
      )) as SearchOut;
      expect(result.matches).toHaveLength(8);
      expect(result.warnings.map((w) => w.code)).not.toContain('truncated');
    });
  });
});

describe('client_search input schema', () => {
  it('accepts `query`, the name its sibling client_resolve uses', () => {
    // Real usability defect, not just a bad call: client_resolve takes
    // `query` and client_search took `text`, for the same string over the
    // same population, in tools that are used one after the other. A caller
    // that just ran client_resolve reaches for `query` and gets
    // invalid_input. Both spellings now parse to the same field.
    expect(() => clientSearch.input.parse({ query: 'a', limit: 3 })).not.toThrow();
  });

  it('still accepts the original `text` spelling', () => {
    expect(clientSearch.input.parse({ text: 'a' })).toMatchObject({ text: 'a' });
  });

  it('rejects a call that names neither', () => {
    expect(() => clientSearch.input.parse({ limit: 3 })).toThrow();
  });

  it('rejects two different spellings at once rather than silently picking one', () => {
    expect(() => clientSearch.input.parse({ query: 'a', text: 'b' })).toThrow();
  });

  it('searches for the string given as `query`, not for undefined', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmList: () => [] });
    await clientSearch.handler(
      clientSearch.input.parse({ query: 'needle', limit: 3 }),
      ctx,
    );
    const search = calls.find((c) => c.path === '/admin/user/search');
    expect(search?.params).toMatchObject({ text: 'needle' });
  });

  it('keeps publishing an object schema so MCP can advertise the tool', () => {
    // The registry refuses any tool whose input is not a z.object() with a
    // live `.shape` (packages/registry:76) — a `.transform()` here took the
    // whole server down at startup, which no unit test on `.parse` could see.
    expect(typeof (clientSearch.input as unknown as { shape?: unknown }).shape).toBe('object');
  });
});

describe('client_search × SHM 3.0 argument whitelist', () => {
  /**
   * С 3.0 `/admin/user/search` принимает ровно один аргумент — `text`, — а
   * всё остальное v1.cgi выбрасывает молча и отвечает 200. Инструмент,
   * попросивший 200 строк и получивший 25, обязан это заметить: иначе
   * «клиента в результатах нет» становится утверждением о человеке.
   */
  it('замечает, что limit выброшен, и не выдаёт окно за полный ответ', async () => {
    const page = Array.from({ length: 25 }, (_, index) => ({
      user_id: 6000 + index,
      login: `client${String(index)}`,
      block: 0,
    }));
    const ctx = makeCtx({
      shmList: () => ({ items: 412, limit: 25, offset: 0, data: page }),
    });
    const result = (await clientSearch.handler(
      clientSearch.input.parse({ text: 'client', limit: 200 }),
      ctx,
    )) as { warnings: Array<{ code: string }>; items: number };
    expect(result.warnings.map((one) => one.code)).toContain('search_limit_ignored');
    expect(result.items).toBe(412);
  });

  it('молчит, когда маршрут наш limit всё-таки принял', async () => {
    const page = Array.from({ length: 40 }, (_, index) => ({
      user_id: 6000 + index,
      login: `client${String(index)}`,
      block: 0,
    }));
    const ctx = makeCtx({
      shmList: () => ({ items: 412, limit: 200, offset: 0, data: page }),
    });
    const result = (await clientSearch.handler(
      clientSearch.input.parse({ text: 'client', limit: 200 }),
      ctx,
    )) as { warnings: Array<{ code: string }> };
    expect(result.warnings.map((one) => one.code)).not.toContain('search_limit_ignored');
  });
});
