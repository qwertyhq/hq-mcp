import { describe, expect, it } from 'vitest';
import { callTool, listOf, makeWorld } from '../testkit.js';
import type { FakeOpts, FakeWorld } from '../testkit.js';
import { billingRefundService } from './billingRefundService.js';

const WITHDRAW = {
  withdraw_id: 24641,
  user_service_id: 55,
  service_id: 21,
  total: 640.5,
  bonus: 0,
  cost: 640.5,
  months: 1,
  create_date: '2026-08-01 10:00:00',
  end_date: '2026-09-01 10:00:00',
  withdraw_date: '2026-08-01 10:00:00',
};

const SERVICE = {
  user_service_id: 55,
  user_id: 3073,
  service_id: 21,
  status: 'ACTIVE',
  name: 'VPN 1 Месяц',
  expire: '2026-09-01 10:00:00',
  withdraw_id: 24641,
  withdraws: WITHDRAW,
};

interface Scene {
  user: Record<string, unknown>;
  pays: Record<string, unknown>[];
  bonuses: Record<string, unknown>[];
  services: Record<string, unknown>[];
  payResult: unknown;
}

function scene(over: Partial<Scene> = {}, opts: FakeOpts = {}): { w: FakeWorld; state: Scene } {
  const state: Scene = {
    user: { user_id: 3073, balance: 500, bonus: 10, block: 0, partner_id: 0 },
    pays: [],
    bonuses: [],
    services: [SERVICE],
    payResult: [{ id: 4700, user_id: 3073, money: 640.5 }],
    ...over,
  };
  const w = makeWorld(
    {
      shmList: (path) => {
        if (path.endsWith('/service')) return listOf(state.services);
        if (path.endsWith('/pay')) return listOf(state.pays);
        if (path.endsWith('/bonus')) return listOf(state.bonuses);
        return listOf([state.user]);
      },
      shmAction: () => state.payResult,
    },
    opts,
  );
  return { w, state };
}

const ARGS = { user_id: 3073, user_service_id: 55, comment: 'возврат за неиспользованный период' };

interface Plan {
  status: string;
  plan_id: string;
  before: Record<string, unknown>;
  after: { money: number };
  diff: { path: string; from: unknown; to: unknown }[];
  sideEffects: string[];
}

async function plan(w: FakeWorld, args: Record<string, unknown> = ARGS): Promise<Plan> {
  return (await callTool(billingRefundService(w.deps), args, w)) as Plan;
}

describe('billing_refund_service: откуда берётся сумма', () => {
  it('сумма — та, что бэкенд записал списанной за период; агент её не считает', async () => {
    const { w } = scene();
    const built = await plan(w);

    expect(built.status).toBe('plan');
    expect(built.after.money).toBe(640.5);
    expect(built.diff).toEqual([{ path: 'balance', from: 500, to: 1140.5 }]);
    expect(built.before).toMatchObject({
      user_service_id: 55,
      withdraw_id: 24641,
      withdraw_total: 640.5,
      withdraw_period_start: '2026-08-01 10:00:00',
      withdraw_period_end: '2026-09-01 10:00:00',
    });
  });

  it('НЕ ходит в смену тарифа: dry_run там не считает возврат, а сам возврат ничего не меняет', async () => {
    const { w } = scene();
    await plan(w);
    expect(w.calls.some((c) => c.path.includes('/change'))).toBe(false);
    expect(w.calls.every((c) => c.method === 'LIST')).toBe(true);
  });

  it('план прямо говорит, что возврат ПОЛНЫЙ, а не за неиспользованный остаток', async () => {
    const { w } = scene();
    const text = (await plan(w)).sideEffects.join(' ');
    expect(text).toMatch(/пропорц/i);
    expect(text).toMatch(/money_back/);
    expect(text).toMatch(/service_lifecycle/);
  });

  it('бонусная часть периода не возвращается — и это сказано', async () => {
    const { w } = scene({
      services: [{ ...SERVICE, withdraws: { ...WITHDRAW, total: 100, bonus: 540.5 } }],
    });
    const built = await plan(w);
    expect(built.after.money).toBe(100);
    expect(built.sideEffects.join(' ')).toMatch(/540\.5/);
  });

  it('период оплачен целиком бонусами — возвращать нечего', async () => {
    const { w } = scene({
      services: [{ ...SERVICE, withdraws: { ...WITHDRAW, total: 0, bonus: 640.5 } }],
    });
    await expect(plan(w)).rejects.toThrow(/возвращать нечего/);
  });

  it('у услуги нет списания — отказ, а не возврат наугад', async () => {
    const { w } = scene({
      services: [{ user_service_id: 55, user_id: 3073, status: 'ACTIVE', withdraw_id: null }],
    });
    await expect(plan(w)).rejects.toThrow(/списани/i);
  });

  it('сумма выше потолка отбивается и пишется в журнал как rejected', async () => {
    const { w } = scene(
      { services: [{ ...SERVICE, withdraws: { ...WITHDRAW, total: 99999 } }] },
      { maxOpAmount: 5000 },
    );
    await expect(plan(w)).rejects.toThrow(/MAX_OP_AMOUNT=5000/);

    const { records } = await w.deps.audit.search({});
    expect(records[0]).toMatchObject({ tool: 'billing_refund_service', outcome: 'rejected' });
  });
});

describe('billing_refund_service: чья услуга', () => {
  it('чужая услуга не возвращается', async () => {
    const { w } = scene({ services: [{ ...SERVICE, user_id: 9999 }] });
    await expect(plan(w)).rejects.toThrow(/принадлежит клиенту user_id=9999/);
  });

  it('услуги нет в SHM — отказ до любой записи', async () => {
    const { w } = scene({ services: [] });
    await expect(plan(w)).rejects.toThrow(/нет в SHM/);
  });

  it('несуществующий клиент — отказ раньше всего остального', async () => {
    const { w } = scene({ user: { user_id: 1, balance: 0 } });
    await expect(plan(w)).rejects.toThrow(/фильтр|не найден/i);
  });
});

describe('billing_refund_service: применение', () => {
  it('зачисляет ровно money бэкенда через PUT /admin/user/payment с ключом плана', async () => {
    const { w } = scene();
    const built = await plan(w);
    const result = (await callTool(
      billingRefundService(w.deps),
      { ...ARGS, plan_id: built.plan_id },
      w,
    )) as { status: string; result: { outcome: string; refunded: number } };

    expect(result.status).toBe('applied');
    expect(result.result).toMatchObject({ outcome: 'applied', refunded: 640.5 });

    const write = w.calls.find((c) => c.method === 'PUT');
    expect(write?.path).toBe('/admin/user/payment');
    expect(write?.body).toEqual({
      user_id: 3073,
      money: 640.5,
      comment: { msg: 'возврат за неиспользованный период', hq_plan: `hq-plan:${built.plan_id}` },
      uniq_key: `hq:billing_refund_service:3073:${built.plan_id}`,
    });
  });

  it('услугу продлили между планом и применением — отказ: сумма возврата устарела', async () => {
    const { w, state } = scene();
    const built = await plan(w);
    state.services = [
      { ...SERVICE, withdraw_id: 24700, withdraws: { ...WITHDRAW, withdraw_id: 24700, total: 700 } },
    ];

    await expect(
      callTool(billingRefundService(w.deps), { ...ARGS, plan_id: built.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('ложный успех SHM (200 + data:[null]) возвратом не считается', async () => {
    const { w } = scene({ payResult: [null] });
    const built = await plan(w);
    await expect(
      callTool(billingRefundService(w.deps), { ...ARGS, plan_id: built.plan_id }, w),
    ).rejects.toThrow();

    const { records } = await w.deps.audit.search({});
    expect(records[0]?.outcome).toBe('failed');
  });
});

describe('billing_refund_service: объявление', () => {
  it('удаление платежа не объявлено и объявлено быть не может', () => {
    const { w } = scene();
    const tool = billingRefundService(w.deps);
    expect(tool.endpoints).toContain('PUT /admin/user/payment');
    expect(tool.endpoints.some((one) => one.startsWith('DELETE'))).toBe(false);
    expect(tool.endpoints.some((one) => one.includes('/change'))).toBe(false);
  });

  it('возможности, которой инструмент не пользуется, он не требует', () => {
    const { w } = scene();
    expect(billingRefundService(w.deps).def.requires).toBeUndefined();
  });
});
