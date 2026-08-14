import { describe, expect, it } from 'vitest';
import { BATCH_LIST_LIMITS, Budget, BudgetExceededError, SHM_PER_KEY_LIMITS } from './index.js';

function clock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

describe('Budget', () => {
  it('allows exactly `limit` calls inside the window', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({ limit: 2, windowMs: 60_000, now: c.now });
    budget.take('shm:GET:/admin/user');
    budget.take('shm:GET:/admin/user');
    expect(() => budget.take('shm:GET:/admin/user')).toThrow(BudgetExceededError);
  });

  it('counts each key separately', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({ limit: 1, windowMs: 60_000, now: c.now });
    budget.take('a');
    expect(() => budget.take('b')).not.toThrow();
  });

  it('reopens the bucket once the window has passed', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({ limit: 1, windowMs: 1_000, now: c.now });
    budget.take('k');
    expect(() => budget.take('k')).toThrow(BudgetExceededError);
    c.advance(1_001);
    expect(() => budget.take('k')).not.toThrow();
  });

  it('blocks the key immediately after a 429 and never suggests a retry', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({ limit: 10, windowMs: 180_000, now: c.now });
    budget.take('user-auth');
    budget.note429('user-auth');
    let caught: unknown;
    try {
      budget.take('user-auth');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as BudgetExceededError;
    expect(err.key).toBe('user-auth');
    expect(err.message).toContain('429');
    expect(err.message).toContain('shared by the whole service');
    expect(err.message).not.toMatch(/retry/i);
    expect(err.resetAt.toISOString()).toBe('2026-08-08T12:03:00.000Z');
  });

  it('applies the tighter SHM counters to the keys budgetKey actually produces', () => {
    // Прежняя версия этого теста брала ключ 'shm:POST:/user-auth' — через дефис.
    // Такого ключа не существует: budgetKey (shm/client.ts:57-61) склеивает
    // метод и ПУТЬ, то есть 'shm:POST:/user/auth'. Тест проверял константу
    // против выдуманной формы и потому зеленел, пока ни одно правило не
    // срабатывало ни разу. Здесь — ровно те строки, которые придут с провода.
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({
      limit: 100,
      windowMs: 60_000,
      now: c.now,
      exactKeyLimits: SHM_PER_KEY_LIMITS,
    });
    for (let i = 0; i < 5; i += 1) budget.take('shm:POST:/user/auth');
    let caught: unknown;
    try {
      budget.take('shm:POST:/user/auth');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    // Окно своё, 180 секунд (Core/User.pm:243), а не общее минутное.
    expect((caught as BudgetExceededError).resetAt.toISOString()).toBe(
      '2026-08-08T12:03:00.000Z',
    );
    // Соседние маршруты не задеты, и в частности НЕ задеты /user/* и /admin/user*,
    // которые подстрочное правило '/user' накрыло бы целиком.
    expect(() => budget.take('shm:GET:/admin/user')).not.toThrow();
    expect(() => budget.take('shm:GET:/user/referrals')).not.toThrow();
  });

  it('covers registration and service order, whose routes are not what their counters are called', () => {
    // reg_api_safe висит на PUT /user (v1.cgi:75-81), а create_for_api_safe —
    // на PUT /service/order (v1.cgi:409-411). Ни одно из имён счётчиков SHM
    // в ключе ведра не встречается, поэтому сопоставлять надо по маршруту.
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({
      limit: 100,
      windowMs: 60_000,
      now: c.now,
      exactKeyLimits: SHM_PER_KEY_LIMITS,
    });
    for (let i = 0; i < 5; i += 1) budget.take('shm:PUT:/user');
    expect(() => budget.take('shm:PUT:/user')).toThrow(BudgetExceededError);
    for (let i = 0; i < 5; i += 1) budget.take('shm:PUT:/service/order');
    expect(() => budget.take('shm:PUT:/service/order')).toThrow(BudgetExceededError);
    // GET по тем же путям — обычные чтения, общий потолок.
    expect(() => budget.take('shm:GET:/service/order')).not.toThrow();
  });

  it('gives the batch listing routes their own allowance without widening their neighbours', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({
      limit: 30,
      windowMs: 60_000,
      now: c.now,
      exactKeyLimits: BATCH_LIST_LIMITS,
    });
    // Полная вычитка таблицы услуг — на большой установке это десятки страниц
    // по 500 строк — не должна упираться в гейт, рассчитанный на поштучные
    // чтения.
    for (let i = 0; i < 40; i += 1) budget.take('shm:GET:/admin/user/service');
    expect(() => budget.take('shm:GET:/admin/user/service')).not.toThrow();

    // А соседний маршрут, который просто НАЧИНАЕТСЯ так же, остаётся под общим
    // лимитом: подстрочное совпадение здесь молча раздало бы батчевую квоту
    // половине админского API.
    for (let i = 0; i < 30; i += 1) budget.take('shm:GET:/admin/user/pay');
    expect(() => budget.take('shm:GET:/admin/user/pay')).toThrow(BudgetExceededError);
  });

  it('prefers an exact key limit over a substring one', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({
      limit: 100,
      windowMs: 60_000,
      now: c.now,
      perKeyLimits: { user: { limit: 1, windowMs: 60_000 } },
      exactKeyLimits: { 'shm:GET:/admin/user': { limit: 3, windowMs: 60_000 } },
    });
    for (let i = 0; i < 3; i += 1) budget.take('shm:GET:/admin/user');
    expect(() => budget.take('shm:GET:/admin/user')).toThrow(BudgetExceededError);
    // Подстрока 'user' продолжает действовать там, где точного правила нет.
    budget.take('shm:GET:/admin/user/search');
    expect(() => budget.take('shm:GET:/admin/user/search')).toThrow(BudgetExceededError);
  });

  it('does not mistake an inherited Object property for a configured limit', () => {
    const budget = new Budget({ limit: 2, windowMs: 60_000, exactKeyLimits: {} });
    expect(() => {
      budget.take('toString');
      budget.take('toString');
    }).not.toThrow();
    expect(() => budget.take('toString')).toThrow(BudgetExceededError);
  });

  it('reports live state and forgets expired buckets', () => {
    const c = clock('2026-08-08T12:00:00.000Z');
    const budget = new Budget({ limit: 5, windowMs: 1_000, now: c.now });
    budget.take('k');
    expect(budget.state()).toEqual({
      k: { count: 1, resetAt: '2026-08-08T12:00:01.000Z' },
    });
    c.advance(1_001);
    expect(budget.state()).toEqual({});
  });
});
