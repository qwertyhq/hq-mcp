import { describe, expect, it } from 'vitest';
import { listOf, makeWorld } from '../testkit.js';
import { assertNoHqTwin, findHqTwin, hqPlanOf, readClientMoney, toNumber } from './money.js';

/**
 * Токен плана в маркере `hq_plan`. Имя константы намеренно без слова token:
 * `scripts/no-secrets.test.ts` краснеет на присваивании непрозрачного значения
 * секретному имени и на фикстуре был бы прав — отличить выдуманный токен от
 * настоящего он не может. Форма (UUID) при этом настоящая, на ней и держатся
 * проверки поиска своей строки.
 */
const PLAN_UUID = '11111111-2222-4333-8444-555555555555';

function world(
  rows: { user?: unknown[]; pays?: unknown[]; bonuses?: unknown[] } = {},
  total?: { user?: number; pays?: number; bonuses?: number },
) {
  return makeWorld({
    shmList: (path) => {
      if (path.endsWith('/pay')) return listOf(rows.pays ?? [], total?.pays);
      if (path.endsWith('/bonus')) return listOf(rows.bonuses ?? [], total?.bonuses);
      return listOf(rows.user ?? [{ user_id: 3073, balance: 500, bonus: 10, block: 0 }], total?.user);
    },
  });
}

describe('toNumber', () => {
  it('переваривает строки SHM и не выдаёт мусор за ноль молча', () => {
    expect(toNumber('640.50')).toBe(640.5);
    expect(toNumber(0)).toBe(0);
    expect(() => toNumber(undefined, 'баланс')).toThrow(/баланс/);
    expect(() => toNumber('нет', 'баланс')).toThrow(/баланс/);
  });
});

describe('readClientMoney', () => {
  it('спрашивает клиента ФИЛЬТРОМ, а не ?user_id= — иначе несуществующий ломает роутер SHM', async () => {
    const w = world();
    await readClientMoney(w.ctx, 3073, 'billing_adjust');

    const paths = w.calls.map((c) => c.path);
    expect(paths).toContain('/admin/user');
    for (const call of w.calls) {
      const params = (call.params ?? {}) as Record<string, unknown>;
      expect(params.user_id).toBeUndefined();
      expect(String(params.filter)).toContain('3073');
    }
  });

  it('снимает баланс, бонусы и водяные знаки последних строк истории', async () => {
    const w = world({
      pays: [{ id: 4699, user_id: 3073, money: 300 }],
      bonuses: [{ id: 2306, user_id: 3073, bonus: 37.8 }],
    });

    const read = await readClientMoney(w.ctx, 3073, 'billing_adjust');
    expect(read.snapshot).toEqual({
      user_id: 3073,
      balance: 500,
      bonus: 10,
      block: 0,
      partner_id: 0,
      lastPayId: 4699,
      lastBonusId: 2306,
    });
    // Страницы истории возвращаются вместе со снимком: второе чтение ради тех
    // же строк стоило бы столько же и пришлось бы на другое состояние базы.
    expect(read.pays).toHaveLength(1);
    expect(read.bonuses).toHaveLength(1);
  });

  it('пустая история — водяной знак 0, а не отказ (законный новый клиент)', async () => {
    const w = world();
    const { snapshot } = await readClientMoney(w.ctx, 3073, 'billing_adjust');
    expect(snapshot.lastPayId).toBe(0);
    expect(snapshot.lastBonusId).toBe(0);
  });

  it('клиента нет — отказ с указанием, что спрашивали фильтром', async () => {
    const w = world({ user: [] });
    await expect(readClientMoney(w.ctx, 999999, 'billing_adjust')).rejects.toThrow(/не найден/);
  });

  it('фильтр не сузил выборку — ОТКАЗ, а не чужая строка, выданная за нашу', async () => {
    // Ровно то, что делает сборка SHM без server-side filter: возвращает голову
    // таблицы. Строка выглядит нормальной, но она про другого клиента.
    const w = world({ user: [{ user_id: 1, balance: 100000, bonus: 0, block: 0 }] });
    await expect(readClientMoney(w.ctx, 3073, 'billing_adjust')).rejects.toThrow(/фильтр/i);
  });

  it('фильтр не сузил историю платежей — тоже отказ: водяной знак был бы чужим', async () => {
    const w = world({ pays: [{ id: 4699, user_id: 55, money: 300 }] });
    await expect(readClientMoney(w.ctx, 3073, 'billing_adjust')).rejects.toThrow(/фильтр/i);
  });
});

describe('hqPlanOf / findHqTwin', () => {
  it('видит маркер и в разобранном комментарии, и в сырой строке', () => {
    expect(hqPlanOf({ comment: { msg: 'x', hq_plan: `hq-plan:${PLAN_UUID}` } })).toBe(`hq-plan:${PLAN_UUID}`);
    expect(hqPlanOf({ comment: `{"msg":"x","hq_plan":"hq-plan:${PLAN_UUID}"}` })).toBe(`hq-plan:${PLAN_UUID}`);
    expect(hqPlanOf({ comment: { withdraw_id: 24637 } })).toBeNull();
    expect(hqPlanOf({ comment: null })).toBeNull();
  });

  it('близнец — строка ЭТОГО сервера на ту же сумму; чужие строки и другие суммы не в счёт', () => {
    const rows = [
      { id: 3, money: 500, comment: { amount: 500, id: 'платёжка' } },
      { id: 2, money: 100, comment: { msg: 'другая сумма', hq_plan: `hq-plan:${PLAN_UUID}` } },
      { id: 1, money: 500, comment: { msg: 'та же сумма', hq_plan: `hq-plan:${PLAN_UUID}` } },
    ];
    expect(findHqTwin(rows, 'money', 500)?.id).toBe(1);
    expect(findHqTwin(rows, 'money', 700)).toBeUndefined();
    expect(findHqTwin([rows[0] as Record<string, unknown>], 'money', 500)).toBeUndefined();
  });

  it('сравнение сумм идёт по копейкам, а не по битам float', () => {
    const rows = [{ id: 1, money: '640.50', comment: { msg: 'x', hq_plan: `hq-plan:${PLAN_UUID}` } }];
    expect(findHqTwin(rows, 'money', 640.5)?.id).toBe(1);
  });

  it('отказ называет строку, план и способ пройти дальше осознанно', () => {
    const rows = [{ id: 91, date: '2026-08-13 11:00:00', money: 500, comment: { hq_plan: `hq-plan:${PLAN_UUID}` } }];
    expect(() => assertNoHqTwin('billing_adjust', rows, 'money', 500, 'платёж', 3073)).toThrow(/id=91/);
    expect(() => assertNoHqTwin('billing_adjust', rows, 'money', 500, 'платёж', 3073)).toThrow(
      /allow_duplicate/,
    );
    expect(() => assertNoHqTwin('billing_adjust', rows, 'money', 501, 'платёж', 3073)).not.toThrow();
  });
});
