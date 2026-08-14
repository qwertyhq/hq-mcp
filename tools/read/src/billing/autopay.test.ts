import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { autopayFacts, autopayInspect, parsePayComment } from './autopay.js';

interface Subscription {
  id: string;
  id_fields: string[];
  state: string;
  status: string | null;
  next_charge_at: string | null;
  payment_method: string | number | null;
  charges_seen: number;
  charges_recorded: number | null;
  cancelled_by_fee: boolean;
  rows: number;
}

interface AutopayOut {
  connected: boolean | null;
  checked: boolean;
  verdict: { signal: string; pay_id: number | null; subscription_id: string | null; status: string | null };
  next_charge_at: string | null;
  charges: { current_subscription: number | null; recorded: number | null; total_rows: number };
  payment_method: string | number | null;
  spellings_seen: string[];
  subscriptions: Subscription[];
  withholdings: Array<{
    pay_id: number;
    money: number;
    fee_rate: number | null;
    kind: string | null;
    reason: string | null;
    subscription_id: string | null;
    charges_count: number | null;
  }>;
  rows: { items: number; scanned: number; autopay: number; unreadable_comments: number };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const USER = 4242;

/**
 * Строки повторяют форму настоящего ответа (id и uuid выдуманы, форма и
 * НАПИСАНИЯ ключей — как есть).
 *
 * Вебхук подписки Платеги пишет `subscriptionid`/`paymentmethod` без
 * подчёркиваний, патч удержания SHM — `subscription_id` с подчёркиванием.
 * Ни одна строка не несёт оба написания сразу — это проверено на настоящей
 * таблице, а не выведено из документации.
 */
const SUB_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const CHARGE_A = {
  id: 4681,
  user_id: USER,
  date: '2026-08-12 21:33:05',
  money: 300,
  pay_system_id: 'platega_sub',
  comment: {
    amount: 300,
    currency: 'RUB',
    id: 'ffffffff-0000-4000-8000-ffffffffffff',
    nextchargeat: '2026-09-12T18:32:54.8527041Z',
    payload: '',
    paymentmethod: 6,
    status: 'CONFIRMED',
    subscriptionid: SUB_A,
  },
};

const CHARGE_B = {
  id: 4682,
  user_id: USER,
  date: '2026-08-12 21:37:02',
  money: 300,
  pay_system_id: 'platega_sub',
  comment: {
    amount: 300,
    currency: 'RUB',
    id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee',
    nextchargeat: '2026-09-12T18:36:59.8051299Z',
    payload: '',
    paymentmethod: 6,
    status: 'CONFIRMED',
    subscriptionid: SUB_B,
  },
};

/** Удержание 9%: единственная строка, где живут charges_count и подчёркнутое написание. */
const CANCEL_FEE_B = {
  id: 4683,
  user_id: USER,
  date: '2026-08-12 21:38:52',
  money: -27,
  pay_system_id: 'platega_sub-fee',
  comment: {
    charge_amount: 300,
    charge_date: '2026-08-12 21:37:02',
    charge_source: 'pays_history',
    charges_count: 1,
    fee_rate: 0.09,
    kind: 'autopay_cancel_fee',
    reason: 'client_cancel',
    subscription_id: SUB_B,
  },
};

/** Отключение без удержания: money=0, статус CANCELED. Позже своего списания. */
const CANCELLED_A = {
  id: 4690,
  user_id: USER,
  date: '2026-08-12 22:34:21',
  money: 0,
  pay_system_id: 'platega_sub-canceled',
  comment: { amount: 300, currency: 'RUB', paymentmethod: 6, status: 'CANCELED', subscriptionid: SUB_A },
};

/**
 * РАЗОВЫЙ платёж. `paymentMethod` в camelCase и `payload` вида
 * "<user_id>:platega_ru_card:<сумма>" — таких строк в таблице платежей
 * подавляющее большинство, и ни одна из них не автоплатёж. Признаком подписки
 * является id подписки, а не написание paymentMethod: инструмент, взявший
 * camelCase за признак, объявил бы автоплатёж у каждого второго клиента.
 */
const ONE_OFF = {
  id: 4600,
  user_id: USER,
  date: '2026-08-01 10:00:00',
  money: 301,
  pay_system_id: 'platega_ru_card',
  comment: {
    amount: 331.1,
    currency: 'RUB',
    id: 'dddddddd-0000-4000-8000-dddddddddddd',
    payload: '4242:platega_ru_card:301',
    paymentMethod: 11,
    status: 'CONFIRMED',
  },
};

const USER_ROW = { user_id: USER, login: 'client', balance: 301 };

function stub(pays: unknown[], user: unknown[] = [USER_ROW]) {
  return (path: string): unknown => {
    if (path === '/admin/user') return user;
    if (path === '/admin/user/pay') return pays;
    throw new Error(`unexpected path ${path}`);
  };
}

async function run(pays: unknown[], user: unknown[] = [USER_ROW]): Promise<AutopayOut> {
  const ctx = makeCtx({ shmList: stub(pays, user) });
  return (await autopayInspect.handler({ shm_user_id: USER, limit: 100 }, ctx)) as AutopayOut;
}

describe('autopay comment normalisation', () => {
  /**
   * ТЕСТ, КОТОРЫЙ ПАДАЕТ, ЕСЛИ ЧИТАЕТСЯ ОДНО НАПИСАНИЕ. Каждый случай несёт
   * РОВНО ОДНО написание — на комментарии с обоими написаниями сразу проверка
   * зеленела бы и у реализации, знающей только первое.
   */
  it.each([
    ['subscriptionid', { subscriptionid: SUB_A }],
    ['subscription_id', { subscription_id: SUB_A }],
    ['subscriptionId', { subscriptionId: SUB_A }],
    ['SubscriptionID', { SubscriptionID: SUB_A }],
  ])('reads the subscription id spelled %s', (field, fields) => {
    const facts = autopayFacts(fields);
    expect(facts.subscription_id).toBe(SUB_A);
    expect(facts.subscription_id_field).toBe(field);
  });

  it.each([
    ['paymentmethod', { paymentmethod: 6 }],
    ['paymentMethod', { paymentMethod: 11 }],
    ['payment_method', { payment_method: 6 }],
  ])('reads the payment method spelled %s', (field, fields) => {
    const facts = autopayFacts(fields);
    expect(facts.payment_method_field).toBe(field);
    expect(typeof facts.payment_method).toBe('number');
  });

  it('reports the comment shape instead of collapsing every failure into "no fields"', () => {
    expect(parsePayComment({ a: 1 }).shape).toBe('object');
    expect(parsePayComment('{"a":1}').shape).toBe('json_string');
    expect(parsePayComment('{"a":').shape).toBe('unreadable');
    expect(parsePayComment('[1,2]').shape).toBe('unreadable');
    expect(parsePayComment('refund by hand').shape).toBe('plain_string');
    expect(parsePayComment(null).shape).toBe('absent');
    expect(parsePayComment('').shape).toBe('absent');
  });

  it('parses a comment that arrives as a JSON string exactly like an object', () => {
    const asObject = autopayFacts(parsePayComment(CHARGE_A.comment).fields);
    const asString = autopayFacts(parsePayComment(JSON.stringify(CHARGE_A.comment)).fields);
    expect(asString).toEqual(asObject);
    expect(asString.subscription_id).toBe(SUB_A);
  });
});

describe('autopay_inspect', () => {
  it('reads both spellings from one client and says which ones it saw', async () => {
    const result = await run([CANCEL_FEE_B, CHARGE_B, CHARGE_A]);
    expect(result.spellings_seen).toEqual(['paymentmethod', 'subscription_id', 'subscriptionid']);
    expect(result.subscriptions.map((one) => one.id).sort()).toEqual([SUB_A, SUB_B].sort());
  });

  /**
   * КОНТРПРИМЕР ИЗ НАСТОЯЩИХ ДАННЫХ. Самая свежая строка ПОДПИСКИ у этого клиента —
   * CONFIRMED, а через 110 секунд после неё лежит удержание за отключение.
   * Вердикт «по статусу последней строки подписки» ответил бы «подключён».
   */
  it('derives disconnection from the withholding row, not from the newest subscription status', async () => {
    const result = await run([CANCEL_FEE_B, CHARGE_B, CHARGE_A]);
    expect(result.connected).toBe(false);
    expect(result.verdict.signal).toBe('cancel_fee_charged');
    expect(result.verdict.pay_id).toBe(CANCEL_FEE_B.id);
    expect(result.verdict.subscription_id).toBe(SUB_B);
    // …и без строки удержания тот же набор читается как подключённый.
    const without = await run([CHARGE_B, CHARGE_A]);
    expect(without.connected).toBe(true);
    expect(without.verdict.signal).toBe('confirmed_subscription');
  });

  it('reads a CANCELED subscription row as disconnected', async () => {
    const result = await run([CANCELLED_A, CHARGE_A]);
    expect(result.connected).toBe(false);
    expect(result.verdict.signal).toBe('cancelled_subscription');
    expect(result.subscriptions[0]?.state).toBe('cancelled');
  });

  it('answers connected=false, checked=true when the client has no autopay rows at all', async () => {
    const result = await run([ONE_OFF]);
    expect(result.connected).toBe(false);
    expect(result.checked).toBe(true);
    expect(result.verdict.signal).toBe('no_autopay_rows');
    expect(result.subscriptions).toEqual([]);
    expect(result.rows.autopay).toBe(0);
    expect(result.rows.scanned).toBe(1);
  });

  it('does not mistake a one-off payment carrying camelCase paymentMethod for autopay', async () => {
    const result = await run([ONE_OFF, ONE_OFF, ONE_OFF]);
    expect(result.rows.autopay).toBe(0);
    expect(result.spellings_seen).toEqual([]);
  });

  it('surfaces the next charge only while connected', async () => {
    const live = await run([CHARGE_B]);
    expect(live.next_charge_at).toBe('2026-09-12T18:36:59.8051299Z');
    const dead = await run([CANCEL_FEE_B, CHARGE_B]);
    expect(dead.next_charge_at).toBeNull();
    expect(dead.subscriptions[0]?.next_charge_at).toBeNull();
  });

  it('counts charges from the rows and reports the recorded count separately', async () => {
    const result = await run([CANCEL_FEE_B, CHARGE_B, CHARGE_A]);
    // Списание — строка с деньгами. Удержание (-27) и отмена (0) не списания.
    expect(result.charges.current_subscription).toBe(1);
    expect(result.charges.recorded).toBe(1);
    expect(result.charges.total_rows).toBe(2);
  });

  it('leaves the recorded charge count null when only subscription rows exist', async () => {
    // charges_count живёт ТОЛЬКО на строке удержания: у подключённого клиента
    // его нет вовсе, и null здесь — отсутствие, а не ноль.
    const result = await run([CHARGE_B]);
    expect(result.charges.recorded).toBeNull();
    expect(result.charges.current_subscription).toBe(1);
  });

  it('returns every withholding with its rate and reason', async () => {
    const result = await run([CANCEL_FEE_B, CHARGE_B]);
    expect(result.withholdings).toHaveLength(1);
    expect(result.withholdings[0]).toMatchObject({
      pay_id: CANCEL_FEE_B.id,
      money: -27,
      fee_rate: 0.09,
      kind: 'autopay_cancel_fee',
      reason: 'client_cancel',
      subscription_id: SUB_B,
      charges_count: 1,
    });
  });

  it('reports the payment method from the subscription the verdict rests on', async () => {
    const result = await run([CHARGE_B]);
    expect(result.payment_method).toBe(6);
  });

  it('warns when more than one subscription still looks live', async () => {
    const result = await run([CHARGE_B, CHARGE_A]);
    expect(result.warnings.map((w) => w.code)).toContain('autopay_multiple_live_subscriptions');
    expect(result.subscriptions.filter((one) => one.state === 'connected')).toHaveLength(2);
  });

  it('does not warn about multiple live subscriptions once one of them is cancelled', async () => {
    const result = await run([CANCEL_FEE_B, CHARGE_B, CHARGE_A]);
    expect(result.warnings.map((w) => w.code)).not.toContain('autopay_multiple_live_subscriptions');
  });

  it('counts an unreadable comment and says the verdict may be missing evidence', async () => {
    const broken = { ...CHARGE_A, id: 4690, comment: '{"subscriptionid":' };
    const result = await run([broken, CHARGE_B]);
    expect(result.rows.unreadable_comments).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain('autopay_comment_unreadable');
    // Строка всё равно попала в выборку — по pay_system_id, а не по комментарию.
    expect(result.rows.autopay).toBe(2);
  });

  it('does not count an ordinary human note as unreadable', async () => {
    const result = await run([{ ...ONE_OFF, comment: 'возврат вручную' }]);
    expect(result.rows.unreadable_comments).toBe(0);
    expect(result.warnings.map((w) => w.code)).not.toContain('autopay_comment_unreadable');
  });

  it('refuses to guess on a status it does not know', async () => {
    const odd = { ...CHARGE_B, id: 4700, comment: { ...CHARGE_B.comment, status: 'PENDING' } };
    const result = await run([odd]);
    expect(result.connected).toBeNull();
    expect(result.verdict.signal).toBe('unknown_status');
    expect(result.warnings.map((w) => w.code)).toContain('autopay_status_unknown');
  });

  it('degrades instead of throwing, and suppresses the verdict when the ledger did not answer', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') return [USER_ROW];
        throw new Error('SHM GET /admin/user/pay: HTTP 503');
      },
    });
    const result = (await autopayInspect.handler(
      { shm_user_id: USER, limit: 100 },
      ctx,
    )) as AutopayOut;
    expect(result.connected).toBeNull();
    expect(result.checked).toBe(false);
    expect(result.subscriptions).toEqual([]);
    expect(result.degraded).toHaveLength(1);
    const partial = result.warnings.find((w) => w.code === 'partial_result');
    expect(partial?.message).toContain('not evidence');
  });

  it('keeps the verdict when only the existence check failed', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') throw new Error('SHM GET /admin/user: HTTP 503');
        return [CHARGE_B];
      },
    });
    const result = (await autopayInspect.handler(
      { shm_user_id: USER, limit: 100 },
      ctx,
    )) as AutopayOut;
    expect(result.connected).toBe(true);
    expect(result.checked).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('says the client does not exist rather than letting an empty answer stand for it', async () => {
    const result = await run([], []);
    expect(result.warnings.map((w) => w.code)).toContain('user_not_found');
  });

  it('surfaces the server-side items count and warns when the window is short', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') return [USER_ROW];
        return { items: 4630, limit: 2, offset: 0, data: [CHARGE_B, CHARGE_A] };
      },
    });
    const result = (await autopayInspect.handler(
      { shm_user_id: USER, limit: 2 },
      ctx,
    )) as AutopayOut;
    expect(result.rows.items).toBe(4630);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  it('asks SHM for the client, not for the whole table', async () => {
    // NonNullable: у makeCtx параметр со значением по умолчанию, поэтому
    // Parameters<...>[0] включает undefined и индексироваться не может.
    const calls: NonNullable<Parameters<typeof makeCtx>[0]>['calls'] = [];
    const ctx = makeCtx({ shmList: stub([CHARGE_B]), calls });
    await autopayInspect.handler({ shm_user_id: USER, limit: 1000 }, ctx);
    const pay = calls.find((call) => call.path === '/admin/user/pay');
    expect(pay?.params).toMatchObject({ user_id: USER, limit: 500 });
  });

  /**
   * Проверено на работающей SHM 2.19.4: `GET /admin/user?user_id=<нет такого>`
   * БРОСАЕТ «Недоступно в данной версии», а `?filter={"user_id":...}` отдаёт
   * 200 с items: 0. С первой формой «клиента нет» приезжало бы как
   * partial_result, то есть как отказ источника.
   */
  it('checks existence through filter, because ?user_id= throws on an absent client', async () => {
    // NonNullable: у makeCtx параметр со значением по умолчанию, поэтому
    // Parameters<...>[0] включает undefined и индексироваться не может.
    const calls: NonNullable<Parameters<typeof makeCtx>[0]>['calls'] = [];
    const ctx = makeCtx({ shmList: stub([CHARGE_B]), calls });
    await autopayInspect.handler({ shm_user_id: USER, limit: 100 }, ctx);
    const lookup = calls.find((call) => call.path === '/admin/user');
    expect(lookup?.params?.filter).toBe(JSON.stringify({ user_id: USER }));
    expect(lookup?.params?.user_id).toBeUndefined();
  });
});
