import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { catalogRead } from './read.js';

interface CatalogOut {
  section: string;
  items: number;
  limit: number;
  offset: number;
  rows: unknown[];
  warnings: Array<{ code: string; message: string }>;
}

describe('catalog_read', () => {
  it('maps every section to its route', async () => {
    const expected: Record<string, string> = {
      services: '/admin/service',
      order: '/admin/service/order',
      children: '/admin/service/children',
      events: '/admin/service/event',
      categories: '/admin/user/service/categories',
    };
    for (const [section, path] of Object.entries(expected)) {
      const calls: StubCall[] = [];
      const ctx = makeCtx({ calls, shmList: () => [{ service_id: 21 }] });
      const result = (await catalogRead.handler(
        { section, service_id: section === 'children' ? 21 : null, limit: 100 },
        ctx,
      )) as CatalogOut;
      expect(calls[0]?.path).toBe(path);
      expect(result.section).toBe(section);
      expect(result.items).toBe(1);
    }
  });

  it('demands service_id for the section SHM itself demands it on', async () => {
    // v1.cgi:653-660 — GET /admin/service/children carries required => ['service_id'].
    const ctx = makeCtx({ shmList: () => [] });
    await expect(
      catalogRead.handler({ section: 'children', service_id: null, limit: 100 }, ctx),
    ).rejects.toThrow(/service_id/);
  });

  it('reads the event catalogue without a service_id and says so when one is passed', async () => {
    // The events table has no service_id column at all (app/sql/shm/shm_structure.sql:163-171)
    // and Core::Events::list_for_api builds its WHERE from id/kind only (Events.pm:104-120),
    // so a service_id sent here is silently dropped by SHM. Demanding it — as the brief did —
    // makes the tool refuse a legitimate global read; forwarding it would let a caller believe
    // the returned events belong to that service. Neither is acceptable: read it globally and
    // say out loud that the answer is not scoped.
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmList: () => [{ id: 1, kind: 'UserService', name: 'CREATE' }] });

    const global = (await catalogRead.handler(
      { section: 'events', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(global.items).toBe(1);
    expect(global.warnings).toEqual([]);

    const scoped = (await catalogRead.handler(
      { section: 'events', service_id: 21, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(calls[1]?.params).toEqual({ limit: 100 });
    const ignored = scoped.warnings.find((w) => w.code === 'service_id_ignored');
    expect(ignored).toBeDefined();
    expect(ignored?.message).toContain('not scoped');
  });

  it('passes service_id through and caps the limit', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmList: () => [] });
    await catalogRead.handler({ section: 'children', service_id: 21, limit: 9999 }, ctx);
    expect(calls[0]?.params).toEqual({ service_id: 21, limit: 500 });

    // Core::Service::list_for_api narrows to one tariff on service_id (Service.pm:224-247),
    // so the parameter is real on this section too and must not be dropped.
    await catalogRead.handler({ section: 'services', service_id: 21, limit: 100 }, ctx);
    expect(calls[1]?.params).toEqual({ service_id: 21, limit: 100 });
  });

  it('keeps the categories rows, which SHM returns as bare strings', async () => {
    // Core::Service::categories is a selectcol_arrayref (Service.pm:337-347): the payload is
    // ['vpn','hosting'], not rows. Mapping it through asRecord — as the brief did — turns every
    // category into {} and the tool answers "5 categories" while naming none of them.
    const ctx = makeCtx({ shmList: () => ['vpn', 'hosting'] });
    const result = (await catalogRead.handler(
      { section: 'categories', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(result.rows).toEqual(['vpn', 'hosting']);
  });

  it('never lets a filled window pass for the whole catalogue', async () => {
    // /admin/service уходит в Sql::Data::list_for_api (Data.pm:728) с calc => 1,
    // то есть items — настоящий FOUND_ROWS(). Каталог больше окна обрезается
    // молча, и «такого тарифа нет» опирается на необъявленное окно.
    const ctx = makeCtx({
      shmList: (_path, params) => ({
        items: 940,
        limit: Number(params?.limit ?? 100),
        offset: 0,
        data: [{ service_id: 21 }, { service_id: 22 }],
      }),
    });
    const result = (await catalogRead.handler(
      { section: 'services', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(result.items).toBe(940);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  it('does not cry truncation on "order", where items counts a different query', async () => {
    // v1.cgi:1760 отдаёт FOUND_ROWS() последнего выполненного SELECT, а
    // api_price_list зовёт list() без calc и потом на каждой позиции
    // was_ever_provided (wd->list, limit => 1) и cost_composite (->id()),
    // каждый из которых сбрасывает счётчик до ≤1 (Service.pm:255-327). Здесь
    // перечень пуст (например, всё отсеял order_only_once), а счётчик показывает
    // единицу от постороннего запроса — и 1 > 0 подняло бы «поднимите лимит»
    // на разделе, где лимит вообще не действует.
    const ctx = makeCtx({
      shmList: (_path, params) => ({
        items: 1,
        limit: Number(params?.limit ?? 100),
        offset: 0,
        data: [],
      }),
    });
    const result = (await catalogRead.handler(
      { section: 'order', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(result.warnings.map((w) => w.code)).not.toContain('truncated');
  });

  it('stays quiet when the whole catalogue fits in the window', async () => {
    const ctx = makeCtx({ shmList: () => [{ service_id: 21 }] });
    const result = (await catalogRead.handler(
      { section: 'services', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut;
    expect(result.warnings).toEqual([]);
  });

  it('degrades instead of throwing when SHM does not answer', async () => {
    const ctx = makeCtx({
      shmList: () => {
        throw new Error('SHM 500');
      },
    });
    const result = (await catalogRead.handler(
      { section: 'order', service_id: null, limit: 100 },
      ctx,
    )) as CatalogOut & { degraded: Array<{ system: string }> };
    expect(result.rows).toEqual([]);
    expect(result.degraded).toEqual([{ system: 'shm', error: 'SHM 500' }]);
    // Пустой каталог и неотвеченный запрос — разные утверждения: на первом
    // строится «такого тарифа нет».
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });
});
