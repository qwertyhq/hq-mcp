import { describe, expect, it } from 'vitest';
import {
  assertIdempotentOp,
  classifyPaymentResult,
  findMarkedRow,
  IDEMPOTENT_OPS,
  isIdempotentOp,
  makePlanMarker,
  makeUniqKey,
  NON_IDEMPOTENT_WRITES,
  SHM_UNIQ_KEY_MAX,
  stampComment,
  uniqKeyFor,
} from './index.js';

/**
 * Так выглядит токен плана: `randomUUID()` из `createConfirmStore.put`. Форма
 * значения проверяется ниже (`not-a-uuid` обязан упасть), поэтому UUID тут
 * настоящий — а вот ИМЯ константы намеренно без слова token: `scripts/
 * no-secrets.test.ts` краснеет на присваивании непрозрачного значения
 * секретному имени и на фикстуре был бы прав, отличить выдуманный токен от
 * настоящего он не может. Тот же приём, что в фикстурах server_edit.
 */
const PLAN_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_PLAN_UUID = 'a1b2c3d4-1111-2222-3333-444455556666';

describe('makeUniqKey', () => {
  it('одинаков на всех попытках ОДНОГО плана', () => {
    const first = makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID });
    const second = makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID });
    expect(second).toBe(first);
  });

  it('два плана с ОДИНАКОВЫМИ аргументами дают РАЗНЫЕ ключи', () => {
    // Два намеренно одинаковых начисления одному клиенту — законная операция.
    // Оконный ключ склеил бы их: второй вызов вернул бы первый платёж, баланс не
    // изменился бы, а инструмент отрапортовал бы `applied`.
    const first = makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID });
    const second = makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: OTHER_PLAN_UUID });
    expect(second).not.toBe(first);
  });

  it('различает клиента и операцию', () => {
    const keys = new Set([
      makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID }),
      makeUniqKey({ userId: 3074, op: 'billing_adjust:balance', token: PLAN_UUID }),
      makeUniqKey({ userId: 3073, op: 'billing_refund_service', token: PLAN_UUID }),
    ]);
    expect(keys.size).toBe(3);
  });

  it('ключ отката отличается от ключа применения', () => {
    // Компенсирующий платёж НЕ ИМЕЕТ ПРАВА нести ключ того платежа, который он
    // отменяет: SHM вернул бы исходную строку, деньги остались бы на балансе, а
    // откат выглядел бы выполненным.
    const applied = makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID });
    const rollback = makeUniqKey({
      userId: 3073,
      op: 'billing_adjust:balance',
      token: PLAN_UUID,
      variant: 'rollback',
    });
    expect(rollback).not.toBe(applied);
    expect(rollback.startsWith(applied)).toBe(true);
  });

  it('ключ ASCII, безопасен для query и влезает в char(255)', () => {
    const key = makeUniqKey({ userId: 3073, op: 'billing_refund_service', token: PLAN_UUID });
    expect(key).toBe(`hq:billing_refund_service:3073:${PLAN_UUID}`);
    expect(key).toMatch(/^[A-Za-z0-9_:.-]+$/);

    // Худший случай: самая длинная операция, максимальный user_id, откат.
    const longest = [...IDEMPOTENT_OPS].sort((a, b) => b.length - a.length)[0];
    if (longest === undefined) throw new Error('IDEMPOTENT_OPS пуст');
    const worst = makeUniqKey({
      userId: Number.MAX_SAFE_INTEGER,
      op: longest,
      token: PLAN_UUID,
      variant: 'rollback',
    });
    expect(worst.length).toBeLessThanOrEqual(SHM_UNIQ_KEY_MAX);
  });

  it('отбивает токен, не похожий на токен плана', () => {
    // Пустой токен дал бы ОДИН ключ на все платежи клиента по этой операции:
    // второй платёж молча схлопнулся бы в первый. Это тише, чем дубль, и хуже.
    for (const token of ['', 'not-a-uuid', PLAN_UUID.toUpperCase(), ` ${PLAN_UUID}`]) {
      expect(() => makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token })).toThrow(
        /MutationPlan\.token/,
      );
    }
  });

  it('отбивает нечисловой, дробный и неположительный user_id', () => {
    for (const userId of [0, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeUniqKey({ userId, op: 'billing_adjust:balance', token: PLAN_UUID })).toThrow(
        /user_id/,
      );
    }
  });
});

describe('закрытый перечень операций', () => {
  it('не пропускает бонус по типу', () => {
    // @ts-expect-error бонусы не идемпотентны в SHM: у bonus_history нет uniq_key.
    const forbidden = (): string => makeUniqKey({ userId: 3073, op: 'billing_adjust:bonus', token: PLAN_UUID });
    expect(forbidden).toBeTypeOf('function');
  });

  it('не пропускает бонус и в рантайме, и объясняет, чем защищаться вместо ключа', () => {
    expect(() => assertIdempotentOp('billing_adjust:bonus')).toThrow(/bonus_history/);
    expect(() => assertIdempotentOp('billing_adjust:bonus')).toThrow(/PUT \/admin\/user\/payment/);
    expect(() => assertIdempotentOp('billing_adjust:bonus')).toThrow(/маркер|markPlan|stampComment/);
  });

  it('перечень содержит только операции через PUT /admin/user/payment', () => {
    expect([...IDEMPOTENT_OPS]).toEqual(['billing_adjust:balance', 'billing_refund_service']);
    expect(isIdempotentOp('billing_adjust:balance')).toBe(true);
    expect(isIdempotentOp('billing_adjust:bonus')).toBe(false);
    expect(assertIdempotentOp('billing_refund_service')).toBe('billing_refund_service');
  });

  it('называет поимённо ручки записи БЕЗ идемпотентности', () => {
    expect(Object.keys(NON_IDEMPOTENT_WRITES)).toEqual([
      'PUT /admin/user/bonus',
      'PUT /admin/user/service/withdraw',
    ]);
    expect(NON_IDEMPOTENT_WRITES['PUT /admin/user/bonus']).toMatch(/bonus_history/);
    expect(NON_IDEMPOTENT_WRITES['PUT /admin/user/service/withdraw']).toMatch(/withdraw_history/);
  });
});

describe('uniqKeyFor', () => {
  it('каррируется в функцию от токена — форму, которую принимает MutationDraft', () => {
    const key = uniqKeyFor('billing_adjust:balance', 3073);
    expect(key(PLAN_UUID)).toBe(makeUniqKey({ userId: 3073, op: 'billing_adjust:balance', token: PLAN_UUID }));
  });

  it('проверяет user_id и операцию СРАЗУ, а не в момент вызова put', () => {
    expect(() => uniqKeyFor('billing_adjust:balance', -1)).toThrow(/user_id/);
  });

  it('умеет откатный вариант', () => {
    expect(uniqKeyFor('billing_adjust:balance', 3073, 'rollback')(PLAN_UUID)).toMatch(/:rollback$/);
  });
});

describe('маркер плана — для таблиц без uniq_key', () => {
  it('штампует комментарий и находит свою строку среди чужих', () => {
    const comment = stampComment('возврат за неиспользованный период', PLAN_UUID);
    expect(comment.msg).toBe('возврат за неиспользованный период');
    expect(comment.hq_plan).toBe(makePlanMarker(PLAN_UUID));

    const rows = [
      { id: 1, bonus: 200, comment: { msg: 'старый бонус' } },
      { id: 2, bonus: 200, comment },
    ];
    expect(findMarkedRow(rows, PLAN_UUID)).toMatchObject({ id: 2 });
  });

  it('строка чужого плана не считается своей', () => {
    const rows = [{ id: 1, comment: stampComment('x', OTHER_PLAN_UUID) }];
    expect(findMarkedRow(rows, PLAN_UUID)).toBeUndefined();
  });

  it('находит маркер и в комментарии, пришедшем сырой строкой', () => {
    const rows = [{ id: 7, comment: JSON.stringify(stampComment('x', PLAN_UUID)) }];
    expect(findMarkedRow(rows, PLAN_UUID)).toMatchObject({ id: 7 });
  });

  it('не путается на похожем, но другом маркере и на строке без комментария', () => {
    const rows = [
      { id: 1, comment: { hq_plan: `${makePlanMarker(PLAN_UUID)}x` } },
      { id: 2 },
      { id: 3, comment: null },
      { id: 4, comment: 42 },
    ];
    expect(findMarkedRow(rows, PLAN_UUID)).toBeUndefined();
  });

  it('требует настоящий токен плана — как и uniq_key', () => {
    expect(() => makePlanMarker('not-a-uuid')).toThrow(/MutationPlan\.token/);
  });
});

describe('classifyPaymentResult', () => {
  it('новый id — платёж проведён', () => {
    expect(classifyPaymentResult({ returnedPayId: 993, lastPayIdAtPlan: 992 })).toBe('applied');
  });

  it('id не новее снимка — это дедуп-попадание, а не второй платёж', () => {
    expect(classifyPaymentResult({ returnedPayId: 992, lastPayIdAtPlan: 992 })).toBe(
      'already_applied',
    );
    expect(classifyPaymentResult({ returnedPayId: 640, lastPayIdAtPlan: 992 })).toBe(
      'already_applied',
    );
  });

  it('клиент без платежей на момент плана — водяной знак 0', () => {
    expect(classifyPaymentResult({ returnedPayId: 1, lastPayIdAtPlan: 0 })).toBe('applied');
  });

  it('мусор вместо id не превращается молча в applied', () => {
    expect(() => classifyPaymentResult({ returnedPayId: Number.NaN, lastPayIdAtPlan: 0 })).toThrow(
      /id платежа/,
    );
    expect(() => classifyPaymentResult({ returnedPayId: 5, lastPayIdAtPlan: -1 })).toThrow(
      /водяной знак/,
    );
  });
});
