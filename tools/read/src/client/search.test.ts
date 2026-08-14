import { describe, expect, it } from 'vitest';
import { createProbeStore } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
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

describe('client_search', () => {
  it('hides blocked clients by default and says so out loud', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: () => ({ items: 1, limit: 25, offset: 0, data: [active] }),
    });
    const result = (await clientSearch.handler(
      { text: 'active', include_blocked: false, limit: 25 },
      ctx,
    )) as SearchOut;
    expect(result.matches).toHaveLength(1);
    expect(result.items).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain('blocked_hidden');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ text: 'active', limit: 25 });
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
