import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { billingLedger, round2 } from './ledger.js';

interface Identity {
  recorded: number;
  computed: number;
  delta: number | null;
  matches: boolean | null;
  complete: boolean;
}

interface LedgerOut {
  balance: Identity;
  bonus: Identity;
  payments: { total: number; items: number; limit: number; read: number; rows: unknown[] };
  bonuses: { total: number; items: number; read: number; rows: unknown[] };
  withdraws: {
    total: number;
    items: number;
    read: number;
    rows: unknown[];
    unsettled: { rows: number; gross_total: number };
  };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

// A withdraw row partly paid from bonus. Verified against SHM source
// (shm-fork-from-orig): Core::Billing::is_pay/calc_payment splits the
// withdraw's ORIGINAL cost into a money part and a bonus part and
// OVERWRITES `total` with only the money part at the moment of payment
// (app/lib/Core/Billing.pm, is_pay ~line 296, calc_payment ~line 260-266):
//   $total -= $bonus;               # `total` becomes the money-only part
//   $wd->set(bonus => $bonus, total => $total, withdraw_date => now);
// So for THIS row the original cost was 500 (300 money + 200 bonus), and
// after payment the DB holds total=300 (money part), bonus=200 (bonus
// part) — the two fields are disjoint, not total-inclusive-of-bonus.
// The split only ever exists together with a real withdraw_date: is_pay
// sets bonus/total/withdraw_date in the SAME `$wd->set(...)` call.
const withdraws = [{ total: 300, bonus: 200, withdraw_date: '2026-08-01 12:00:00' }];
const pays = [{ money: 1000 }];
const bonusHistory = [{ bonus: 500 }];

// money = Σ pays.money − Σ (settled) withdraw.total = 1000 − 300 = 700
// bonus = Σ bonus_history.bonus (alone)             = 500
const clean = (path: string): unknown => {
  if (path === '/admin/user') return [{ user_id: 3073, balance: 700, bonus: 500 }];
  if (path === '/admin/user/pay') return pays;
  if (path === '/admin/user/bonus') return bonusHistory;
  if (path === '/admin/user/service/withdraw') return withdraws;
  throw new Error(`unexpected path ${path}`);
};

// A client with one paid withdraw (money+bonus split, real withdraw_date)
// and one pending withdraw for a future/unbilled period (no withdraw_date
// yet). Core::Withdraw::sum — the method User::recash itself reconciles
// through — sums only rows with withdraw_date set
// (Withdraw.pm:271: `$args{where}{withdraw_date} ||= {'!=' => undef}`).
// An unpaid row's `total` is calc_withdraw's GROSS pre-bonus figure
// (Billing.pm:229 `$wd{total} -= $wd{bonus}` runs against bonus=>0 at
// creation, add_withdraw_next Billing.pm:186), not the same quantity as a
// paid row's money-only `total` — mixing the two sums apples with oranges.
const mixed = (path: string): unknown => {
  if (path === '/admin/user') return [{ user_id: 3073, balance: 700, bonus: 300 }];
  if (path === '/admin/user/pay') return pays;
  if (path === '/admin/user/bonus') return [{ bonus: 500 }, { bonus: -200 }];
  if (path === '/admin/user/service/withdraw') {
    return [
      { total: 300, bonus: 200, withdraw_date: '2026-08-01 12:00:00' }, // paid
      { total: 400, bonus: 0, withdraw_date: null }, // pending
    ];
  }
  throw new Error(`unexpected path ${path}`);
};

describe('billing_ledger', () => {
  it('reconciles both the money and the bonus identity cleanly on a bonus-funded withdraw', async () => {
    const ctx = makeCtx({ shmList: clean });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.payments.total).toBe(1000);
    expect(result.bonuses.total).toBe(500);
    expect(result.withdraws.total).toBe(300);
    expect(result.balance).toEqual({ recorded: 700, computed: 700, delta: 0, matches: true, complete: true });
    expect(result.bonus).toEqual({ recorded: 500, computed: 500, delta: 0, matches: true, complete: true });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).not.toContain('balance_mismatch');
    expect(codes).not.toContain('bonus_mismatch');
  });

  it('a client with one paid and one unpaid withdraw reconciles cleanly', async () => {
    const ctx = makeCtx({ shmList: mixed });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.balance).toEqual({
      recorded: 700,
      computed: 700,
      delta: 0,
      matches: true,
      complete: true,
    });
    expect(result.bonus).toEqual({ recorded: 300, computed: 300, delta: 0, matches: true, complete: true });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).not.toContain('balance_mismatch');
    expect(codes).not.toContain('bonus_mismatch');
  });

  it('the unpaid row stays visible and is counted separately from the settled sum', async () => {
    const ctx = makeCtx({ shmList: mixed });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    // A pending charge is real data the operator needs — it must not vanish
    // just because it doesn't count toward the settled reconciliation.
    expect(result.withdraws.rows).toHaveLength(2);
    expect(result.withdraws.total).toBe(300);
    expect(result.withdraws.unsettled).toEqual({ rows: 1, gross_total: 400 });
  });

  it.each([
    ['null', { total: 999, bonus: 0, withdraw_date: null }],
    ['key absent', { total: 999, bonus: 0 }],
    ['empty string', { total: 999, bonus: 0, withdraw_date: '' }],
    ['MySQL zero-date', { total: 999, bonus: 0, withdraw_date: '0000-00-00 00:00:00' }],
  ] satisfies Array<[string, Record<string, unknown>]>)(
    'treats withdraw_date = %s as unpaid, never as settled',
    async (_label, row) => {
      const ctx = makeCtx({
        shmList: (path) => {
          if (path === '/admin/user') return [{ user_id: 3073, balance: 1000, bonus: 500 }];
          if (path === '/admin/user/pay') return pays;
          if (path === '/admin/user/bonus') return bonusHistory;
          if (path === '/admin/user/service/withdraw') return [row];
          throw new Error(`unexpected path ${path}`);
        },
      });
      const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
      expect(result.withdraws.total).toBe(0);
      expect(result.withdraws.unsettled).toEqual({ rows: 1, gross_total: 999 });
      expect(result.withdraws.rows).toHaveLength(1);
    },
  );

  it('detects money-ledger drift without accusing the bonus identity', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user' ? [{ user_id: 3073, balance: 500, bonus: 500 }] : clean(path),
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.balance).toEqual({
      recorded: 500,
      computed: 700,
      delta: -200,
      matches: false,
      complete: true,
    });
    const mismatch = result.warnings.find((w) => w.code === 'balance_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain('500');
    expect(mismatch?.message).toContain('700');
    expect(result.bonus.matches).toBe(true);
    expect(result.warnings.map((w) => w.code)).not.toContain('bonus_mismatch');
  });

  it('detects bonus-ledger drift, independently, without accusing the money identity', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === '/admin/user' ? [{ user_id: 3073, balance: 700, bonus: 50 }] : clean(path),
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.bonus).toEqual({
      recorded: 50,
      computed: 500,
      delta: -450,
      matches: false,
      complete: true,
    });
    const mismatch = result.warnings.find((w) => w.code === 'bonus_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain('50');
    expect(mismatch?.message).toContain('500');
    expect(result.balance.matches).toBe(true);
    expect(result.warnings.map((w) => w.code)).not.toContain('balance_mismatch');
  });

  it('a withdraw fully paid from bonus does not touch the money identity', async () => {
    // Original cost was 400, fully covered by bonus: calc_payment sets
    // total=0 (money part) and bonus=400 (bonus part), and is_pay stamps
    // withdraw_date in the same statement. The same is_pay call writes a
    // matching -400 row to bonus_history via set_bonus, so bonus history
    // nets to 500 - 400 = 100 without any separate subtraction of
    // withdraw.bonus.
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === '/admin/user') return [{ user_id: 3073, balance: 1000, bonus: 100 }];
        if (path === '/admin/user/pay') return pays;
        if (path === '/admin/user/bonus') return [{ bonus: 500 }, { bonus: -400 }];
        if (path === '/admin/user/service/withdraw') {
          return [{ total: 0, bonus: 400, withdraw_date: '2026-08-01 12:00:00' }];
        }
        throw new Error(`unexpected path ${path}`);
      },
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.balance).toEqual({
      recorded: 1000,
      computed: 1000,
      delta: 0,
      matches: true,
      complete: true,
    });
    expect(result.bonus).toEqual({
      recorded: 100,
      computed: 100,
      delta: 0,
      matches: true,
      complete: true,
    });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).not.toContain('balance_mismatch');
    expect(codes).not.toContain('bonus_mismatch');
  });

  it('a failed bonus fetch does not silence a real money mismatch', async () => {
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === '/admin/user/bonus') throw new Error('HTTP 404');
        if (path === '/admin/user') return [{ user_id: 3073, balance: 500, bonus: 500 }];
        return clean(path);
      },
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.balance.matches).toBe(false);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('balance_mismatch');
    expect(codes).not.toContain('bonus_mismatch');
    expect(codes).toContain('partial_result');
    expect(result.degraded).toEqual([{ system: 'shm', error: 'HTTP 404' }]);
  });

  it('a failed pay fetch does not accuse deletion and does not silence a real bonus mismatch', async () => {
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === '/admin/user/pay') throw new Error('HTTP 500');
        if (path === '/admin/user') return [{ user_id: 3073, balance: 700, bonus: 50 }];
        return clean(path);
      },
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).not.toContain('balance_mismatch');
    expect(codes).toContain('bonus_mismatch');
    expect(codes).toContain('partial_result');
  });

  it('carries the real payment count outward and warns when the window was filled', async () => {
    const ctx = makeCtx({
      shmList: (path, params) =>
        path === '/admin/user/pay'
          ? { items: 812, limit: Number(params?.limit ?? 50), offset: 0, data: [{ id: 1, money: 10 }] }
          : clean(path),
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 1 }, ctx)) as LedgerOut;
    expect(result.payments.items).toBe(812);
    expect(result.payments.rows).toHaveLength(1);
    // Расхождение баланса, посчитанное по одной строке из 812, — это артефакт
    // окна, и предупреждение об усечении обязано стоять рядом с ним.
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  /**
   * Клиент, чьих списаний больше, чем помещается в окно показа. Инструмент
   * печатал `matches: false` с дельтой, посчитанной по срезу, — и дельта меняла
   * ЗНАК вместе с размером окна. Сервер здесь ведёт себя как настоящий:
   * называет полный `items` и отдаёт ровно то окно, которое просили.
   */
  it('does not reconcile at all when the ledger could not be read to completeness', async () => {
    const ctx = makeCtx({
      shmList: (path, params) =>
        path === '/admin/user/service/withdraw'
          ? {
              items: 900,
              limit: Number(params?.limit ?? 50),
              offset: Number(params?.offset ?? 0),
              // Короткая страница при непокрытом items — то же, что делает SHM,
              // упёршийся в собственный потолок выдачи.
              data: [{ total: 300, bonus: 0, withdraw_date: '2026-08-01 12:00:00' }],
            }
          : clean(path),
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.balance.complete).toBe(false);
    expect(result.balance.matches).toBeNull();
    expect(result.balance.delta).toBeNull();
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('reconciliation_incomplete');
    // Ни обвинения, ни оправдания: сверки не было.
    expect(codes).not.toContain('balance_mismatch');
    // Бонусная лента прочитана целиком, и её сверка остаётся настоящей.
    expect(result.bonus.complete).toBe(true);
    expect(result.bonus.matches).toBe(true);
  });

  /**
   * Обратная сторона того же: окно показа маленькое, но лента вычитана
   * постранично до конца — значит сверка НАСТОЯЩАЯ, а не «настолько, насколько
   * влезло». 600 платежей — это две страницы чтения (SHM отдаёт максимум 500 за
   * запрос) при окне показа в 50 строк.
   */
  it('reconciles over every page, not over the printed window', async () => {
    const all = Array.from({ length: 600 }, (_, index) => ({ id: index + 1, money: 1 }));
    const ctx = makeCtx({
      shmList: (path, params) => {
        if (path === '/admin/user') return [{ user_id: 3073, balance: 600, bonus: 500 }];
        if (path === '/admin/user/pay') {
          const limit = Number(params?.limit ?? 500);
          const offset = Number(params?.offset ?? 0);
          return { items: all.length, limit, offset, data: all.slice(offset, offset + limit) };
        }
        if (path === '/admin/user/bonus') return bonusHistory;
        if (path === '/admin/user/service/withdraw') return [];
        throw new Error(`unexpected path ${path}`);
      },
    });
    const result = (await billingLedger.handler({ shm_user_id: 3073, limit: 50 }, ctx)) as LedgerOut;
    expect(result.payments.read).toBe(600);
    expect(result.payments.total).toBe(600);
    expect(result.payments.rows).toHaveLength(50);
    expect(result.balance).toEqual({
      recorded: 600,
      computed: 600,
      delta: 0,
      matches: true,
      complete: true,
    });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('truncated');
    expect(codes).not.toContain('reconciliation_incomplete');
    expect(codes).not.toContain('balance_mismatch');
  });

  it('rounds to kopecks', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(150.005)).toBe(150.01);
  });
});
