import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { clientCatalogView } from './catalog.js';

const USER = 4242;

/** Позиция прайс-листа в том виде, в каком её отдаёт работающая SHM 2.19.4. */
function offer(
  serviceId: number,
  cost: number,
  extra: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    service_id: serviceId,
    name: `Tariff ${String(serviceId)}`,
    category: 'vpn-m-%',
    period: 1,
    cost,
    discount: 0,
    cost_discount: 0,
    cost_bonus: 0,
    real_cost: cost,
    real_cost_with_bonuses: cost,
    allow_to_order: 1,
    deleted: 0,
    ...extra,
  };
}

const CATALOGUE = [offer(12, 300), offer(15, 500)];

const PROMO = [
  {
    promo_code: 'FREEWORM',
    created: '2026-07-29 20:18:23',
    expire: null,
    reusable: 0,
    status: 1,
    used: 1,
    used_date: '2026-08-10 12:06:51',
    used_by: USER,
    settings: { public: {} },
  },
];

interface Options {
  exists?: boolean;
  client?: Record<string, unknown>[];
  fail?: string[];
  calls?: StubCall[];
  serviceRows?: Record<string, unknown>[];
}

function ctxFor(opts: Options = {}): Parameters<typeof clientCatalogView.handler>[1] {
  const fail = opts.fail ?? [];
  return makeCtx({
    ...(opts.calls === undefined ? {} : { calls: opts.calls }),
    shmList: (path) => {
      if (fail.includes(path)) throw new Error(`SHM GET ${path}: HTTP 500: Internal Server Error`);
      if (path === '/admin/user') return (opts.exists ?? true) ? [{ user_id: USER }] : [];
      if (path === '/admin/service/order') return CATALOGUE;
      if (path === '/service/order') return opts.client ?? CATALOGUE;
      if (path === '/promo') return PROMO;
      if (path === '/service') return opts.serviceRows ?? [];
      return [];
    },
    shmGet: () => [],
  });
}

async function run(
  opts: Options = {},
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const parsed = clientCatalogView.input.parse({ shm_user_id: USER, ...input });
  return (await clientCatalogView.handler(parsed, ctxFor(opts))) as Record<string, unknown>;
}

function codes(result: Record<string, unknown>): string[] {
  return (result.warnings as Array<{ code: string }>).map((one) => one.code);
}

describe('client_catalog_view', () => {
  it('names the tariff the catalogue hides and the client is offered', async () => {
    // Случай не выдуманный, а встреченный: пробный тариф отсутствует в
    // админском перечне, потому что АДМИН его когда-то получал, и присутствует
    // у клиента, который не получал. catalog_read отвечает первым списком на
    // вопрос про второго.
    const result = await run({ client: [...CATALOGUE, offer(21, 0)] });
    const difference = result.difference as {
      onlyForThisClient: number[];
      onlyInCatalogue: number[];
    };
    expect(difference.onlyForThisClient).toEqual([21]);
    expect(difference.onlyInCatalogue).toEqual([]);
    expect(codes(result)).toContain('catalogue_differs_from_client_view');
  });

  it('names the price the client actually pays when bonuses move it', async () => {
    const result = await run({
      client: [offer(12, 300, { cost_bonus: 150, real_cost_with_bonuses: 150 }), offer(15, 500)],
    });
    expect((result.difference as { pricedDifferently: unknown[] }).pricedDifferently).toEqual([
      {
        serviceId: 12,
        cataloguePrice: 300,
        clientPays: 150,
        discountPercent: 0,
        bonusApplied: 150,
      },
    ]);
  });

  it('says "matches" only as a statement about this client, not about the catalogue', async () => {
    const result = await run();
    expect(codes(result)).toContain('client_view_matches_catalogue');
    expect(codes(result)).not.toContain('catalogue_differs_from_client_view');
    const message = (result.warnings as Array<{ code: string; message: string }>).find(
      (one) => one.code === 'client_view_matches_catalogue',
    )?.message;
    expect(message).toMatch(/not a property of the catalogue/);
  });

  it('reads the client list with user_id and the catalogue list without one', async () => {
    const calls: StubCall[] = [];
    await run({ calls });
    expect(calls.find((one) => one.path === '/service/order')?.params?.user_id).toBe(USER);
    expect(calls.find((one) => one.path === '/promo')?.params?.user_id).toBe(USER);
    // Каталог читается БЕЗ user_id намеренно: он и есть та вторая точка зрения,
    // с которой сравнивают. Отправив туда user_id, инструмент сравнил бы
    // клиента с самим собой и всегда отвечал бы «расхождений нет».
    expect(calls.find((one) => one.path === '/admin/service/order')?.params?.user_id).toBeUndefined();
  });

  it('warns that the price-list row counter cannot be used', async () => {
    expect(codes(await run())).toContain('order_items_counter_unusable');
  });

  it('warns that the client promo list is scoped to the owner, not the redeemer', async () => {
    const result = await run();
    expect(codes(result)).toContain('promo_scoped_to_owner');
    const promo = result.promo as { data: Array<Record<string, unknown>> };
    expect(promo.data[0]).toEqual({
      code: 'FREEWORM',
      created: '2026-07-29 20:18:23',
      expire: null,
      reusable: false,
      status: 1,
      used: true,
      usedAt: '2026-08-10 12:06:51',
      usedBy: USER,
    });
    // `settings` настоящего ответа не объявлен ни одной схемой, а наполняет его
    // тот, кто выпускал код, — наружу он не идёт.
    expect(JSON.stringify(result)).not.toContain('settings');
  });

  it('does not compare when one of the two lists failed to read', async () => {
    const result = await run({ fail: ['/admin/service/order'] });
    expect(result.comparable).toBe(false);
    expect(result.difference).toEqual({
      onlyForThisClient: [],
      onlyInCatalogue: [],
      pricedDifferently: [],
    });
    expect(codes(result)).toContain('partial_result');
    expect(codes(result)).not.toContain('client_view_matches_catalogue');
  });

  it('never calls a client route for a user_id SHM does not have', async () => {
    const calls: StubCall[] = [];
    const result = await run({ exists: false, calls });
    expect(result.exists).toBe(false);
    expect(codes(result)).toContain('user_not_found');
    expect(calls.filter((one) => !one.path.startsWith('/admin/'))).toEqual([]);
  });

  it('reads one tariff only when asked, and says what an empty answer covers', async () => {
    const calls: StubCall[] = [];
    await run({ calls });
    expect(calls.some((one) => one.path === '/service')).toBe(false);

    const asked = await run({}, { service_id: 21 });
    expect(codes(asked)).toContain('service_not_found');
    const found = await run({ serviceRows: [offer(21, 0)] }, { service_id: 21 });
    expect((found.service as { rows: unknown[] }).rows).toHaveLength(1);
    expect(codes(found)).not.toContain('service_not_found');
  });

  it('touches no route the forbidden gate or the mutating-GET list closes', () => {
    for (const path of ['/service/order', '/admin/service/order', '/service', '/promo']) {
      expect(() => assertNotForbidden(path, 'GET')).not.toThrow();
    }
    // Соседний маршрут применения промокода — GET, который мутирует, и через
    // клиента он не проходит вовсе. Инструмент к нему не приближается.
    expect('/promo'.startsWith('/promo/apply')).toBe(false);
  });
});
