import { describe, expect, it } from 'vitest';
import { ShmError } from '@hq/shm';
import { callTool, listOf, makeWorld } from '../testkit.js';
import type { FakeOpts, FakeWorld } from '../testkit.js';
import { billingAdjust } from './billingAdjust.js';

interface Scene {
  user: Record<string, unknown>;
  pays: Record<string, unknown>[];
  bonuses: Record<string, unknown>[];
  payResult: unknown;
  bonusResult: unknown;
  actionFails: number;
  /** Что происходит на бэкенде в тот момент, когда наружу уходит 408. */
  writeOnFail: (() => void) | null;
}

function scene(over: Partial<Scene> = {}, opts: FakeOpts = {}): { w: FakeWorld; state: Scene } {
  const state: Scene = {
    user: { user_id: 3073, balance: 500, bonus: 10, block: 0, partner_id: 0 },
    pays: [],
    bonuses: [],
    payResult: [{ id: 4700, user_id: 3073, money: -100 }],
    bonusResult: [{ id: 2307, user_id: 3073, bonus: 50 }],
    actionFails: 0,
    writeOnFail: null,
    ...over,
  };
  const w = makeWorld(
    {
      shmList: (path) => {
        if (path.endsWith('/pay')) return listOf(state.pays);
        if (path.endsWith('/bonus')) return listOf(state.bonuses);
        return listOf([state.user]);
      },
      shmAction: (_method, path) => {
        if (state.actionFails > 0) {
          state.actionFails -= 1;
          state.writeOnFail?.();
          throw new ShmError('SHM request PUT failed: 408', 408, true);
        }
        return path.endsWith('/bonus') ? state.bonusResult : state.payResult;
      },
    },
    opts,
  );
  return { w, state };
}

const BALANCE = { user_id: 3073, kind: 'balance', amount: -100, comment: 'коррекция оператором' };
const BONUS = { user_id: 3073, kind: 'bonus', amount: 50, comment: 'бонус за отзыв' };

interface Plan {
  status: string;
  plan_id: string;
  before: { balance: number; bonus: number; lastPayId: number; lastBonusId: number };
  after: Record<string, unknown>;
  diff: { path: string; from: unknown; to: unknown }[];
  sideEffects: string[];
  rollback: { method: string; path: string; body: Record<string, unknown> };
}

async function plan(w: FakeWorld, args: Record<string, unknown>): Promise<Plan> {
  return (await callTool(billingAdjust(w.deps), args, w)) as Plan;
}

async function apply(w: FakeWorld, args: Record<string, unknown>, planId: string): Promise<unknown> {
  return callTool(billingAdjust(w.deps), { ...args, plan_id: planId }, w);
}

describe('billing_adjust: план', () => {
  it('снимает баланс и водяные знаки, показывает diff и НИЧЕГО не пишет', async () => {
    const { w } = scene({ pays: [{ id: 4699, user_id: 3073, money: 300 }] });
    const result = await plan(w, BALANCE);

    expect(result.status).toBe('plan');
    expect(result.before).toMatchObject({ balance: 500, lastPayId: 4699 });
    expect(result.diff).toEqual([{ path: 'balance', from: 500, to: 400 }]);
    expect(result.after).toMatchObject({ kind: 'balance', money: -100, balance: 400 });
    expect(w.calls.every((c) => c.method === 'LIST')).toBe(true);
  });

  it('водяной знак lastPayId нужен, чтобы отличить дедуп от нового платежа (§4.3)', async () => {
    const { w } = scene({ pays: [{ id: 4699, user_id: 3073, money: 300 }] });
    const result = await plan(w, BALANCE);
    expect(result.before.lastPayId).toBe(4699);
  });

  it('говорит, ЧЕМ защищён именно этот вызов: у денег это uniq_key', async () => {
    const { w } = scene();
    const result = await plan(w, BALANCE);
    const text = result.sideEffects.join(' ');
    expect(text).toMatch(/uniq_key/);
    expect(text).toMatch(/уведомлени/i);
  });

  it('у бонусов идемпотентности НЕТ, и план обязан сказать это прямо', async () => {
    const { w } = scene();
    const result = await plan(w, BONUS);
    const text = result.sideEffects.join(' ');
    expect(text).toMatch(/uniq_key/);
    expect(text).toMatch(/удво|повтор/i);
    expect(text).toMatch(/маркер/i);
  });

  it('положительное зачисление клиенту с партнёром начислит бонус ПАРТНЁРУ — это в плане', async () => {
    const { w } = scene({ user: { user_id: 3073, balance: 500, bonus: 10, block: 0, partner_id: 2123 } });
    const result = await plan(w, { ...BALANCE, amount: 250 });
    const text = result.sideEffects.join(' ');
    expect(text).toMatch(/партнёр/i);
    expect(text).toMatch(/2123/);
    // И то, что откат его не снимет: add_bonuses_for_partners срабатывает
    // только на money > 0.
    expect(text).toMatch(/откат/i);
  });

  it('списание партнёрских бонусов не порождает — лишнего предупреждения нет', async () => {
    const { w } = scene({ user: { user_id: 3073, balance: 500, bonus: 10, block: 0, partner_id: 2123 } });
    const result = await plan(w, BALANCE);
    expect(result.sideEffects.join(' ')).not.toMatch(/партнёр/i);
  });

  it('уход в минус называется прямо: SHM его разрешает, а оператор мог не заметить', async () => {
    const { w } = scene({ user: { user_id: 3073, balance: 51, bonus: 0, block: 0, partner_id: 0 } });
    const result = await plan(w, BALANCE);
    expect(result.sideEffects.join(' ')).toMatch(/отрицательн/i);
    expect(result.sideEffects.join(' ')).toContain('-49');
  });

  it('операция, не уводящая в минус, лишнего предупреждения не получает', async () => {
    const { w } = scene();
    expect((await plan(w, BALANCE)).sideEffects.join(' ')).not.toMatch(/отрицательн/i);
  });

  it('сумма 0 бессмысленна', async () => {
    const { w } = scene();
    await expect(plan(w, { ...BALANCE, amount: 0 })).rejects.toThrow(/0/);
  });

  it('сумма выше потолка отбивается ДО единого запроса и пишется в журнал', async () => {
    const { w } = scene({}, { maxOpAmount: 5000 });
    await expect(plan(w, { ...BALANCE, amount: -9000 })).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
    expect(w.calls).toEqual([]);

    const { records } = await w.deps.audit.search({});
    expect(records[0]).toMatchObject({ tool: 'billing_adjust', outcome: 'rejected' });
  });

  it('несуществующий клиент — отказ, а не платёж в пустоту', async () => {
    const w = makeWorld({ shmList: () => listOf([]) });
    await expect(callTool(billingAdjust(w.deps), { ...BALANCE, user_id: 999999 }, w)).rejects.toThrow(
      /не найден/,
    );
  });

  it('свежая строка ЭТОГО сервера на ту же сумму — отказ: похоже на повтор после потери ответа', async () => {
    const { w } = scene({
      pays: [
        { id: 4699, user_id: 3073, money: -100, date: '2026-08-08 11:59:00', comment: { msg: 'коррекция', hq_plan: 'hq-plan:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } },
      ],
    });
    await expect(plan(w, BALANCE)).rejects.toThrow(/allow_duplicate/);
  });

  it('осознанный повтор проходит по явному allow_duplicate', async () => {
    const { w } = scene({
      pays: [
        { id: 4699, user_id: 3073, money: -100, comment: { hq_plan: 'hq-plan:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } },
      ],
    });
    const result = await plan(w, { ...BALANCE, allow_duplicate: true });
    expect(result.status).toBe('plan');
  });
});

describe('billing_adjust: применение денег', () => {
  it('пишет PUT /admin/user/payment с ключом плана и маркером в комментарии', async () => {
    const { w } = scene();
    const built = await plan(w, BALANCE);
    const result = (await apply(w, BALANCE, built.plan_id)) as {
      status: string;
      result: { outcome: string; payment: unknown };
    };

    expect(result.status).toBe('applied');
    expect(result.result.outcome).toBe('applied');

    const write = w.calls.find((c) => c.method === 'PUT');
    expect(write?.path).toBe('/admin/user/payment');
    expect(write?.body).toEqual({
      user_id: 3073,
      money: -100,
      comment: { msg: 'коррекция оператором', hq_plan: `hq-plan:${built.plan_id}` },
      uniq_key: `hq:billing_adjust:balance:3073:${built.plan_id}`,
    });
  });

  it('ключ считается ОДИН раз, на этапе плана, и берётся из снимка', async () => {
    const { w } = scene();
    const built = await plan(w, BALANCE);
    await apply(w, BALANCE, built.plan_id);
    const write = w.calls.find((c) => c.method === 'PUT');
    expect((write?.body as { uniq_key: string }).uniq_key).toContain(built.plan_id);
  });

  it('SHM вернул СТАРЫЙ платёж (дедуп) — это already_applied, а не второе списание', async () => {
    const { w } = scene({
      pays: [{ id: 4699, user_id: 3073, money: 300 }],
      payResult: [{ id: 4699, user_id: 3073, money: 300 }],
    });
    const built = await plan(w, BALANCE);
    const result = (await apply(w, BALANCE, built.plan_id)) as {
      result: { outcome: string; note?: string };
    };
    expect(result.result.outcome).toBe('already_applied');
    expect(result.result.note).toMatch(/НЕ ПОВТОРЯЙТЕ|не повторяйте/i);
  });

  it('ложный успех SHM (200 + data:[null]) не считается проведённым платежом', async () => {
    const { w } = scene({ payResult: [null] });
    const built = await plan(w, BALANCE);
    await expect(apply(w, BALANCE, built.plan_id)).rejects.toThrow();

    const { records } = await w.deps.audit.search({});
    expect(records[0]?.outcome).toBe('failed');
  });

  it('мир уехал между планом и применением — отказ без записи в SHM', async () => {
    const { w, state } = scene();
    const built = await plan(w, BALANCE);
    state.user = { ...state.user, balance: 900 };

    await expect(apply(w, BALANCE, built.plan_id)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('billing_adjust: применение бонусов', () => {
  it('пишет PUT /admin/user/bonus полем bonus и БЕЗ uniq_key — его всё равно выбросят', async () => {
    const { w } = scene();
    const built = await plan(w, BONUS);
    await apply(w, BONUS, built.plan_id);

    const write = w.calls.find((c) => c.method === 'PUT');
    expect(write?.path).toBe('/admin/user/bonus');
    expect(write?.body).toEqual({
      user_id: 3073,
      bonus: 50,
      comment: { msg: 'бонус за отзыв', hq_plan: `hq-plan:${built.plan_id}` },
    });
    expect(Object.keys(write?.body as object)).not.toContain('uniq_key');
  });

  it('408 ПОСЛЕ настоящей записи: повтор находит свою строку по маркеру и НЕ дублирует бонус', async () => {
    const { w, state } = scene({ actionFails: 1 });
    const built = await plan(w, BONUS);
    // Прокси ответил 408, хотя бэкенд успел записать строку: ровно тот случай,
    // ради которого поиск собственной строки стоит ПЕРЕД записью. Сверка мира
    // его не поймает — она отработала до первой попытки.
    state.writeOnFail = () => {
      state.bonuses = [
        {
          id: 2307,
          user_id: 3073,
          bonus: 50,
          comment: { msg: 'бонус за отзыв', hq_plan: `hq-plan:${built.plan_id}` },
        },
      ];
    };

    const result = (await apply(w, BONUS, built.plan_id)) as { result: { outcome: string } };
    expect(result.result.outcome).toBe('already_applied');
    expect(w.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('строка этого плана уже в истории — сверка мира говорит ЧТО именно случилось', async () => {
    const { w, state } = scene();
    const built = await plan(w, BONUS);
    state.bonuses = [
      { id: 2307, user_id: 3073, bonus: 50, comment: { hq_plan: `hq-plan:${built.plan_id}` } },
    ];

    await expect(apply(w, BONUS, built.plan_id)).rejects.toThrow(/уже применён/i);
    expect(w.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('billing_adjust: объявление', () => {
  it('денежные ручки объявлены, DELETE платежей — нет и не будет', () => {
    const { w } = scene();
    const tool = billingAdjust(w.deps);
    expect(tool.endpoints).toContain('PUT /admin/user/payment');
    expect(tool.endpoints).toContain('PUT /admin/user/bonus');
    expect(tool.endpoints.some((one) => one.startsWith('DELETE'))).toBe(false);
    expect(tool.def.access).toBe('rw');
    expect(tool.def.profiles).toEqual(['human']);
  });
});
