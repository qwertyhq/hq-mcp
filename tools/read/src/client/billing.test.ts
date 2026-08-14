import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { clientBillingView } from './billing.js';

const USER = 4242;

/**
 * Форма ответов клиентских маршрутов, снятая с работающей SHM 2.19.4
 * (значения выдуманы, имена полей настоящие). Прогноз приезжает ОДНИМ объектом
 * в `data`, а не списком, и `items` конверта к его размеру отношения не имеет.
 */
const FORECAST = [
  {
    balance: 301,
    bonuses: 0,
    total: 0,
    items: [
      {
        name: 'Trial 1 day',
        service_id: '21',
        usi: '11219',
        user_service_id: '11219',
        status: 'ACTIVE',
        expire: '2026-08-13 20:24:06',
        cost: 0,
        months: 0.01,
        qnt: 1,
        discount: 0,
        total: 0,
        next: {
          name: 'VPN 1 month',
          service_id: 12,
          cost: 300,
          months: 1,
          qnt: 1,
          discount: 0,
          bonus: 0,
          total: 300,
        },
      },
    ],
  },
];

/**
 * Четыре предложенных способа оплаты с одинаковым `paysystem` и РАЗНЫМ `ps` в
 * ссылке — ровно то, что отдаёт работающая SHM: поле `paysystem` схлопнуто
 * override'ом, а настоящий ключ (`platega_ru_card`, тот самый, что стоит в
 * `pay_system_id` платежа) живёт только в query-строке ссылки оплаты.
 */
const PAYSYSTEMS = [
  {
    paysystem: 'platega',
    name: 'SBP QR',
    weight: 2,
    recurring: 0,
    internal: 0,
    allow_deletion: 0,
    forecast: 450,
    amount: '',
    user_id: USER,
    shm_url:
      'https://billing.example.test/shm/pay_systems/platega.cgi?action=create&user_id=4242&ts=1&ps=platega&amount=',
  },
  {
    paysystem: 'platega',
    name: 'RU cards',
    weight: 1,
    recurring: 0,
    internal: 0,
    allow_deletion: 0,
    forecast: 450,
    amount: 300,
    user_id: USER,
    shm_url:
      'https://billing.example.test/shm/pay_systems/platega.cgi?action=create&user_id=4242&ts=1&ps=platega_ru_card&amount=300',
  },
];

const PAYS = [
  {
    id: 4689,
    user_id: USER,
    date: '2026-08-13 06:24:55',
    money: 301,
    pay_system_id: 'platega_ru_card',
    uniq_id: 'aaaa-bbbb',
    comment: { amount: 331.1, currency: 'RUB', status: 'CONFIRMED' },
  },
];

const WITHDRAWS = [
  {
    withdraw_id: 24616,
    user_id: USER,
    user_service_id: 11219,
    service_id: 21,
    name: 'Trial 1 day',
    total: 0,
    cost: 0,
    months: 0.01,
    withdraw_date: '2026-08-12 20:24:07',
    end_date: '2026-08-13 20:24:06',
  },
];

interface Options {
  exists?: boolean;
  autopay?: unknown;
  fail?: string[];
  calls?: StubCall[];
}

function ctxFor(opts: Options = {}): Parameters<typeof clientBillingView.handler>[1] {
  const fail = opts.fail ?? [];
  const boom = (path: string): never => {
    throw new Error(`SHM GET ${path}: HTTP 500: Internal Server Error`);
  };
  return makeCtx({
    ...(opts.calls === undefined ? {} : { calls: opts.calls }),
    shmList: (path) => {
      if (fail.includes(path)) return boom(path);
      if (path === '/admin/user') return (opts.exists ?? true) ? [{ user_id: USER }] : [];
      if (path === '/user/pay') return PAYS;
      if (path === '/user/withdraw') return WITHDRAWS;
      return [];
    },
    shmGet: (path) => {
      if (fail.includes(path)) return boom(path);
      if (path === '/user/pay/forecast') return FORECAST;
      if (path === '/user/pay/paysystems') return PAYSYSTEMS;
      if (path === '/user/autopayment') return [opts.autopay ?? {}];
      return [];
    },
  });
}

async function run(opts: Options = {}): Promise<Record<string, unknown>> {
  const input = clientBillingView.input.parse({ shm_user_id: USER });
  return (await clientBillingView.handler(input, ctxFor(opts))) as Record<string, unknown>;
}

function codes(result: Record<string, unknown>): string[] {
  return (result.warnings as Array<{ code: string }>).map((one) => one.code);
}

describe('client_billing_view', () => {
  it('answers with the forecast the client would see, not with ledger rows', async () => {
    const result = await run();
    const forecast = result.forecast as {
      balance: number;
      bonuses: number;
      amountDue: number;
      windowDays: number;
      items: Array<{ next: { total: number; serviceId: number | null } }>;
    };
    expect(forecast.balance).toBe(301);
    expect(forecast.amountDue).toBe(0);
    expect(forecast.windowDays).toBe(3);
    expect(forecast.items).toHaveLength(1);
    expect(forecast.items[0]?.next.total).toBe(300);
    expect(forecast.items[0]?.next.serviceId).toBe(12);
  });

  it('switches context with user_id on every client route and on nothing else', async () => {
    const calls: StubCall[] = [];
    await run({ calls });
    const client = calls.filter((one) => !one.path.startsWith('/admin/'));
    expect(client.map((one) => one.path).sort()).toEqual([
      '/user/autopayment',
      '/user/pay',
      '/user/pay/forecast',
      '/user/pay/paysystems',
      '/user/withdraw',
    ]);
    // Без user_id клиентский маршрут отвечает про АДМИНА, а не про клиента, и
    // это самая дорогая из возможных здесь ошибок: ответ выглядит правдоподобно.
    for (const call of client) expect(call.params?.user_id).toBe(USER);
    // Проверка существования идёт через filter, а не через ?user_id=.
    const probe = calls.find((one) => one.path === '/admin/user');
    expect(probe?.params?.user_id).toBeUndefined();
    expect(probe?.params?.filter).toBe(JSON.stringify({ user_id: USER }));
  });

  it('never calls a client route for a user_id SHM does not have', async () => {
    const calls: StubCall[] = [];
    const result = await run({ exists: false, calls });
    expect(result.exists).toBe(false);
    expect(codes(result)).toContain('user_not_found');
    expect(calls.filter((one) => !one.path.startsWith('/admin/'))).toEqual([]);
    // Ключевое: это НЕ деградация. Источник ответил, ответ получен.
    expect(result.degraded).toEqual([]);
  });

  it('keeps the real payment-system key and drops the link that would create a payment', async () => {
    const result = await run();
    const offered = (result.paysystems as { offered: Array<Record<string, unknown>> }).offered;
    expect(offered.map((one) => one.paysystemId)).toEqual(['platega', 'platega_ru_card']);
    // Значение `paysystem` схлопнуто, и по нему платёж к методу не привязать.
    expect(offered.map((one) => one.family)).toEqual(['platega', 'platega']);
    expect(offered[0]?.action).toBe('create');
    expect(offered[0]?.endpoint).toBe('https://billing.example.test');
    expect(offered[1]?.proposedAmount).toBe(300);
    const text = JSON.stringify(result);
    expect(text).not.toContain('shm_url');
    expect(text).not.toContain('pay_systems/platega.cgi');
    expect(text).not.toContain('ts=1');
    expect(codes(result)).toContain('payment_url_dropped');
    expect(codes(result)).toContain('paysystem_family_collapsed');
  });

  it('separates "what is due" from "what the payment form will ask for"', async () => {
    // Расхождение, снятое с работающей установки: форма оплаты предлагала
    // ненулевую сумму клиенту, у которого прогноз показывал 0. Оба числа
    // верны — прогноз формы считается с заблокированными услугами, прогноз
    // маршрута без них.
    const result = await run();
    expect((result.paysystems as { payableIncludingBlocked: number }).payableIncludingBlocked).toBe(450);
    expect((result.forecast as { amountDue: number }).amountDue).toBe(0);
    expect(codes(result)).toContain('payable_amount_differs_from_forecast');
  });

  it('reports a stored recurring method by name only, never by value', async () => {
    const result = await run({
      autopay: {
        platega_sub: {
          subscription_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
          card: '552461******7890',
          token: 'not-a-real-recurring-token',
        },
      },
    });
    const autopay = result.autopay as {
      count: number;
      recordedMethods: Array<{ paysystem: string; fieldsPresent: string[] }>;
    };
    expect(autopay.count).toBe(1);
    expect(autopay.recordedMethods[0]?.paysystem).toBe('platega_sub');
    expect(autopay.recordedMethods[0]?.fieldsPresent).toEqual(['card', 'subscription_id', 'token']);
    const text = JSON.stringify(result);
    expect(text).not.toContain('bbbbbbbb-2222');
    expect(text).not.toContain('552461');
    expect(text).not.toContain('not-a-real-recurring-token');
    expect(codes(result)).not.toContain('autopay_not_recorded_in_shm');
  });

  it('says out loud that an empty autopay record is not proof nobody is charging', async () => {
    expect(codes(await run())).toContain('autopay_not_recorded_in_shm');
  });

  it('says out loud that an empty forecast window is not proof nothing is due', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user' ? [{ user_id: USER }] : []),
      shmGet: (path) =>
        path === '/user/pay/forecast' ? [{ balance: 0, bonuses: 0, total: 0, items: [] }] : [],
    });
    const input = clientBillingView.input.parse({ shm_user_id: USER });
    const result = (await clientBillingView.handler(input, ctx)) as Record<string, unknown>;
    expect(codes(result)).toContain('forecast_window_is_empty');
  });

  it('distinguishes "covered by balance" from "nothing is due"', async () => {
    expect(codes(await run())).toContain('forecast_covered_by_balance');
    expect(codes(await run())).not.toContain('forecast_window_is_empty');
  });

  it('degrades one route at a time instead of losing the whole answer', async () => {
    const result = await run({ fail: ['/user/pay/forecast'] });
    expect(result.forecast).toBeNull();
    expect((result.payments as { data: unknown[] }).data).toHaveLength(1);
    expect(result.degraded).toHaveLength(1);
    expect(codes(result)).toContain('partial_result');
  });

  it('touches no route the forbidden gate or the mutating-GET list closes', () => {
    for (const path of ['/user/pay', '/user/pay/forecast', '/user/pay/paysystems', '/user/withdraw', '/user/autopayment']) {
      expect(() => assertNotForbidden(path, 'GET')).not.toThrow();
    }
  });

  it('is available to the bot: the client\'s own money is a support answer', () => {
    expect(clientBillingView.profiles).toEqual(['human', 'bot']);
    expect(clientBillingView.access).toBe('ro');
  });
});
