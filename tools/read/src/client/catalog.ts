import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asRecord,
  capLimit,
  clientExists,
  listOut,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

const ROUTES = {
  /** Прайс-лист, посчитанный ДЛЯ КОНКРЕТНОГО клиента. */
  clientOrder: '/service/order',
  /** Тот же обработчик без переключения контекста — каталог «вообще». */
  catalogueOrder: '/admin/service/order',
  service: '/service',
  promo: '/promo',
} as const;

const MAX_LIMIT = 500;

interface Offer {
  serviceId: number | null;
  name: string | null;
  category: string | null;
  period: number | null;
  /** Цена по прайсу. */
  cost: number;
  discountPercent: number;
  bonusApplied: number;
  /** Цена после скидки, до бонусов. */
  costAfterDiscount: number;
  /** Сколько клиент заплатит на самом деле. */
  clientPays: number;
}

function buildOffer(row: Record<string, unknown>): Offer {
  return {
    serviceId: num(row.service_id, Number.NaN) || null,
    name: str(row.name),
    category: str(row.category),
    period: num(row.period, Number.NaN) || null,
    cost: num(row.cost, 0),
    discountPercent: num(row.discount, 0),
    bonusApplied: num(row.cost_bonus, 0),
    costAfterDiscount: num(row.real_cost, 0),
    clientPays: num(row.real_cost_with_bonuses, 0),
  };
}

export const clientCatalogView = defineTool({
  name: 'client_catalog_view',
  description:
    'The catalogue and the promo codes as ONE CLIENT sees them, which is not what the catalogue ' +
    'says. `GET /service/order` is per-user: it hides tariffs the client may not order again ' +
    '(`order_only_once` plus a charge in their history) and prices every remaining one with their ' +
    'own discount and bonus balance. catalog_read reads the same handler with no user context, so ' +
    'it answers for whoever authenticated — the admin — and that answer is wrong for a client ' +
    'question in both directions: verified against a working installation, the admin view hid the ' +
    'free trial a client was actually being offered, and showed full price to a client whose ' +
    'bonuses took 150 off it. This tool reads both and reports the difference, which is the ' +
    'point. Also ' +
    "returns the client's own promo codes (`GET /promo`) and, on request, one tariff as the " +
    'client sees it (`GET /service`). Read-only: the ordering sibling is PUT /service/order and ' +
    'the redemption route GET /promo/apply/{code} is a GET that mutates — neither is implemented.',
  input: z.object({
    shm_user_id: z
      .number()
      .int()
      .positive()
      .describe('SHM user_id whose catalogue to build. Resolve it with client_resolve.'),
    service_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Optional: also read this one tariff through the client-side route.'),
    limit: z
      .number()
      .int()
      .default(100)
      .describe('Promo rows, capped at 500. The price list is never limited — SHM returns it whole.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, service_id, limit }, ctx) => {
    const cap = capLimit(limit, 100, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const presence = await clientExists(ctx.shm, shm_user_id);
    if (presence.error !== null) degraded.push({ system: 'shm', error: presence.error });
    if (presence.exists === false) {
      warnings.push(
        warn(
          'user_not_found',
          `SHM has no user_id ${String(shm_user_id)}. The client-side routes were not called: ` +
            'switching context to an unknown user makes them answer HTTP 500, which is ' +
            'indistinguishable from the backend failing.',
        ),
      );
      return {
        userId: shm_user_id,
        exists: false,
        offers: [],
        catalogue: [],
        difference: { onlyForThisClient: [], onlyInCatalogue: [], pricedDifferently: [] },
        service: null,
        promo: EMPTY_LIST,
        warnings,
        degraded,
      };
    }

    const scope = { user_id: shm_user_id };
    const [clientRes, catalogueRes, promoRes, serviceRes] = await Promise.all([
      settle(ctx.shm.list<unknown>(ROUTES.clientOrder, scope)),
      settle(ctx.shm.list<unknown>(ROUTES.catalogueOrder, {})),
      settle(ctx.shm.list<unknown>(ROUTES.promo, { ...scope, limit: cap })),
      service_id === null
        ? Promise.resolve({ ok: true as const, value: EMPTY_LIST })
        : settle(ctx.shm.list<unknown>(ROUTES.service, { ...scope, service_id })),
    ]);

    const offers = take(clientRes, 'shm', degraded, EMPTY_LIST).data.map(asRecord).map(buildOffer);
    const catalogue = take(catalogueRes, 'shm', degraded, EMPTY_LIST).data
      .map(asRecord)
      .map(buildOffer);

    const clientIds = new Set(offers.map((one) => one.serviceId));
    const catalogueIds = new Set(catalogue.map((one) => one.serviceId));
    const byId = new Map(catalogue.map((one) => [one.serviceId, one]));
    const comparable = clientRes.ok && catalogueRes.ok;
    const difference = {
      onlyForThisClient: comparable
        ? offers.filter((one) => !catalogueIds.has(one.serviceId)).map((one) => one.serviceId)
        : [],
      onlyInCatalogue: comparable
        ? catalogue.filter((one) => !clientIds.has(one.serviceId)).map((one) => one.serviceId)
        : [],
      pricedDifferently: comparable
        ? offers
            .filter((one) => {
              const same = byId.get(one.serviceId);
              return same !== undefined && same.clientPays !== one.clientPays;
            })
            .map((one) => ({
              serviceId: one.serviceId,
              cataloguePrice: byId.get(one.serviceId)?.clientPays ?? null,
              clientPays: one.clientPays,
              discountPercent: one.discountPercent,
              bonusApplied: one.bonusApplied,
            }))
        : [],
    };

    const promo = listOut(take(promoRes, 'shm', degraded, EMPTY_LIST), warnings, 'client promo');
    // `settings` встречается в настоящем ответе (`{"public":{}}`), но его формы
    // никто не объявлял, а содержимое задаёт тот, кто выпускал код. Поэтому
    // наружу идёт перечень известных полей, а не строка целиком.
    const promoRows = promo.data.map((row) => ({
      code: str(row.promo_code),
      created: str(row.created),
      expire: str(row.expire),
      reusable: num(row.reusable, 0) === 1,
      status: num(row.status, Number.NaN) || 0,
      used: num(row.used, 0) === 1,
      usedAt: str(row.used_date),
      usedBy: num(row.used_by, Number.NaN) || null,
    }));

    const serviceRows = take(serviceRes, 'shm', degraded, EMPTY_LIST).data.map(asRecord);

    if (comparable) {
      const differs =
        difference.onlyForThisClient.length +
        difference.onlyInCatalogue.length +
        difference.pricedDifferently.length;
      if (differs > 0) {
        warnings.push(
          warn(
            'catalogue_differs_from_client_view',
            `${String(differs)} difference(s) between what the catalogue says and what this ` +
              'client is offered. `catalogue` here is the SAME handler read without a user, which ' +
              'is exactly what catalog_read section="order" returns — so on this client, that ' +
              'tool answers a different question than the one being asked. Quote `offers`, not ' +
              '`catalogue`, when the question is about a person.',
          ),
        );
      } else {
        warnings.push(
          warn(
            'client_view_matches_catalogue',
            'This client sees the catalogue price list unchanged — no tariff hidden, no discount ' +
              'and no bonus applied. True for this client today, and not a property of the ' +
              'catalogue: another client with bonuses or with a used-up one-time tariff sees a ' +
              'different list from the same rows.',
          ),
        );
      }
    }
    if (clientRes.ok) {
      warnings.push(
        warn(
          'order_items_counter_unusable',
          'The price-list routes report an `items` counter that is not the number of offers — the ' +
            'handler runs a further query per position, and the envelope carries the row count of ' +
            'whichever ran last (a working installation returned `items: 1` for seven offers). ' +
            'Counts here are counted from the rows. The list itself is never truncated: SHM ' +
            'builds it with no ' +
            'LIMIT.',
        ),
      );
    }
    if (promoRes.ok) {
      warnings.push(
        warn(
          'promo_scoped_to_owner',
          'This is the promo table filtered by the OWNER column, which is not the same as "codes ' +
            'this client used". One-time codes issued by an admin stay owned by the admin after ' +
            'redemption, so a client who redeemed one sees nothing here — verified against a ' +
            "working installation, where a deleted client's redemptions all sat under the admin " +
            'account. Use promo_read, which matches both the owner and the redeemer column.',
        ),
      );
    }
    if (service_id !== null && serviceRes.ok && serviceRows.length === 0) {
      warnings.push(
        warn(
          'service_not_found',
          `No tariff ${String(service_id)} is visible on the client-side route. That route hides ` +
            'deleted tariffs, so this covers both "no such service_id" and "it exists but is ' +
            'marked deleted" — catalog_read can tell those apart.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one route did not answer (see `degraded`). `difference` is only computed when ' +
            'BOTH price lists were read — otherwise it is empty, and an empty difference then ' +
            'means "not compared", not "the client sees the catalogue".',
        ),
      );
    }

    return {
      userId: shm_user_id,
      exists: true,
      offers,
      catalogue,
      comparable,
      difference,
      service: service_id === null ? null : { serviceId: service_id, rows: serviceRows },
      promo: { items: promo.items, limit: promo.limit, offset: promo.offset, data: promoRows },
      warnings,
      degraded,
    };
  },
});
