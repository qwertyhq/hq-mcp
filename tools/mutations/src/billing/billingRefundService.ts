import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import { classifyPaymentResult, stampComment, uniqKeyFor } from '@hq/idempotency';
import { defineMutation, planIdField } from '../kit.js';
import {
  UNIQ_KEY_DROPPED_NOTE,
  asRecord,
  assertNoHqTwin,
  findPlanRow,
  readClientMoney,
  readHistory,
  round2,
  toNumber,
  uniqKeyLanded,
} from './money.js';
import { assertOwnsService } from './ownership.js';
import type { MutationDeps, MutationTool } from '../kit.js';
import type { MoneyRow } from './money.js';
import type { OwnedService } from './ownership.js';
import type { MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';

const NAME = 'billing_refund_service';

const input = z.object({
  user_id: z.number().int().positive(),
  user_service_id: z
    .number()
    .int()
    .positive()
    .describe('Услуга клиента, за текущий оплаченный период которой возвращаются деньги'),
  comment: z
    .string()
    .min(3)
    .describe('Причина возврата: попадает в историю платежей и в уведомление клиенту'),
  allow_duplicate: z
    .boolean()
    .optional()
    .describe(
      'Осознанный повтор. Без него план откажется строиться, если такая же сумма этому клиенту ' +
        'уже возвращена этим сервером.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

interface RefundBefore {
  user_id: number;
  balance: number;
  lastPayId: number;
  user_service_id: number;
  status: string;
  expire: string;
  withdraw_id: number;
  withdraw_total: number;
  withdraw_bonus: number;
  withdraw_period_start: string;
  withdraw_period_end: string;
}

interface RefundTarget {
  user_id: number;
  user_service_id: number;
  money: number;
  comment: string;
}

function firstOf(raw: unknown): Record<string, unknown> {
  return asRecord(Array.isArray(raw) ? raw[0] : raw);
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

interface RefundState {
  before: RefundBefore;
  service: OwnedService;
  /** Последние платежи клиента: из них ищется собственная строка плана. */
  pays: MoneyRow[];
}

/**
 * Снимок «до»: клиент, услуга и СПИСАНИЕ, из которого берётся сумма возврата.
 *
 * Собирается одной функцией для плана и для сверки мира — иначе guard сравнивал
 * бы поля, посчитанные другим кодом, и «мир уехал» зависело бы от того, чья
 * нормализация строже.
 */
async function readRefundState(
  ctx: ToolContext,
  userId: number,
  userServiceId: number,
): Promise<RefundState> {
  const read = await readClientMoney(ctx, userId, NAME);
  const service = await assertOwnsService(ctx, userId, userServiceId, NAME);
  const withdraw = asRecord(service.withdraws);

  return {
    before: {
      user_id: userId,
      balance: read.snapshot.balance,
      lastPayId: read.snapshot.lastPayId,
      user_service_id: userServiceId,
      status: text(service.status),
      expire: text(service.expire),
      withdraw_id: toNumber(service.withdraw_id ?? withdraw.withdraw_id),
      withdraw_total: round2(toNumber(withdraw.total)),
      withdraw_bonus: round2(toNumber(withdraw.bonus)),
      withdraw_period_start: text(withdraw.create_date),
      withdraw_period_end: text(withdraw.end_date),
    },
    service,
    pays: read.pays,
  };
}

/**
 * Возврат за услугу компенсирующим платежом.
 *
 * ОТКУДА БЕРЁТСЯ СУММА И ПОЧЕМУ НЕ ИЗ dry_run. План этой задачи предписывал
 * спросить сумму у бэкенда: `POST /admin/user/service/change` с `dry_run=1` и
 * взять `money_back` из ответа. Такого поля в ответе не существует, и это
 * проверено с двух сторон:
 *   - `Core::USObject::change` возвращает `1` (USObject.pm:906-937), а
 *     диспетчер кладёт в ответ ровно то, что вернул метод
 *     (v1.cgi:1788-1793) — то есть `{"data":[1]}`;
 *   - `Core::Billing::money_back` (Billing.pm:525-595) — это ПРОЦЕДУРА внутри
 *     `USObject::finish`: она переписывает строку withdraw и сама зачисляет
 *     деньги через `set_balance`, а свои `($delta_money, $delta_bonus)` отдаёт
 *     только перловому вызывающему. Наружу они не уезжают ни при каком флаге.
 * Значит `dry_run` дал бы не сумму, а `1` — при том что запрос с ним делает
 * `finish` НАСТОЯЩЕЙ услуге и ставит задачи в спул, надеясь на откат транзакции в
 * самом конце (v1.cgi:1890). Платить таким риском за ноль информации нельзя,
 * поэтому смена тарифа здесь не вызывается вовсе, а `requires: ['shm.dry_run']`
 * снято: инструмент не пользуется этой возможностью.
 *
 * Сумма всё равно НЕ считается агентом. Она берётся из строки
 * `withdraw_history`, которую SHM подмешивает в саму услугу
 * (`UserService::with`, UserService.pm:130-141): `total` — это деньги, которые
 * биллинг записал снятыми за текущий период (`$wd{total} -= $wd{bonus}`,
 * Billing.pm:229). Возврат ПОЛНЫЙ, без пропорции за неиспользованный остаток:
 * пропорцию умеет считать только сам SHM внутри смены/снятия услуги, а считать
 * её здесь означало бы ровно ту агентскую арифметику, которая запрещена.
 * Оператор видит в плане и сумму, и границы периода и решает сам.
 *
 * `DELETE /admin/user/pay` не используется и не будет: удаление платежа не
 * возвращает денег, а users.balance при нём не пересчитывается — история и
 * баланс расходятся навсегда (тот самый дрейф, который ищет billing_ledger).
 */
export function billingRefundService(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: NAME,
      description:
        'Вернуть клиенту деньги за услугу: на баланс зачисляется сумма, которую SHM записал ' +
        'снятой за текущий оплаченный период (withdraw_history.total). Возврат полный, не ' +
        'пропорциональный: собственный money_back SHM считается только внутри смены/снятия услуги ' +
        'и в ответах API не возвращается. Услугу НЕ останавливает и тариф НЕ меняет — это ' +
        'service_lifecycle. Удаление платежа не используется: оно не возвращает деньги, а ломает ' +
        'баланс. Без plan_id возвращает план и ничего не меняет.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [
        'GET /admin/user',
        'GET /admin/user/pay',
        'GET /admin/user/bonus',
        'GET /admin/user/service',
        'PUT /admin/user/payment',
      ],
      // Сумма из аргументов не выводится вовсе: её сообщает план через
      // PlanDraft.amount, и потолок каркас проверяет уже по ней.
      amountOf: () => null,
      target: (i) => ({ system: 'shm', id: i.user_id }),

      guard: {
        keys: [
          'balance',
          'lastPayId',
          'status',
          'expire',
          'withdraw_id',
          'withdraw_total',
          'withdraw_bonus',
        ],
        read: async (plan: MutationPlan, ctx: ToolContext): Promise<RefundBefore> => {
          const before = asRecord(plan.before);
          const userId = toNumber(before.user_id, 'user_id из снимка плана');
          const state = await readRefundState(
            ctx,
            userId,
            toNumber(before.user_service_id, 'user_service_id из снимка плана'),
          );
          const mine = findPlanRow(state.pays, plan.token);
          if (mine !== undefined) {
            throw new Error(
              `${NAME}: план уже применён — в истории платежей клиента лежит строка ` +
                `id=${String(mine.id)} с маркером hq-plan:${plan.token} от ${String(mine.date)}. ` +
                'Повторное применение запрещено.',
            );
          }
          return state.before;
        },
      },

      plan: async (i, ctx) => {
        const state = await readRefundState(ctx, i.user_id, i.user_service_id);
        const { before } = state;

        if (before.withdraw_id === 0) {
          throw new Error(
            `${NAME}: у услуги user_service_id=${i.user_service_id} нет учтённого списания ` +
              '(withdraw_id пуст), то есть биллинг не записал за неё ни одного оплаченного ' +
              'периода. Возвращать не по чему: сумму брать неоткуда, а считать её самим запрещено.',
          );
        }
        if (before.withdraw_total <= 0) {
          throw new Error(
            `${NAME}: за текущий период услуги снято денег ${before.withdraw_total} ` +
              `(бонусами ${before.withdraw_bonus}) — возвращать нечего. Бонусная часть периода ` +
              'деньгами не возвращается: для неё есть billing_adjust с kind=bonus.',
          );
        }

        const money = before.withdraw_total;
        if (i.allow_duplicate !== true) {
          assertNoHqTwin(NAME, state.pays, 'money', money, 'возврат', i.user_id);
        }

        const after: RefundTarget = {
          user_id: i.user_id,
          user_service_id: i.user_service_id,
          money,
          comment: i.comment,
        };

        const sideEffects = [
          `Возврат ПОЛНЫЙ: ${money} — это withdraw_history.total, то есть все деньги, которые ` +
            `биллинг снял за период ${before.withdraw_period_start} … ${before.withdraw_period_end}. ` +
            'Пропорции за неиспользованный остаток здесь нет и быть не может: собственный ' +
            'money_back SHM (Billing.pm:525) считается только внутри смены или снятия услуги и ни ' +
            'в одном ответе API не возвращается — POST /admin/user/service/change отдаёт "1". ' +
            'Если период почти израсходован, решение возвращать целиком принимает оператор.',
          'Услуга остаётся как есть: не останавливается, тариф не меняется, срок не сдвигается. ' +
            'Остановка и смена тарифа — отдельный вызов service_lifecycle.',
          'Возврат в платёжную систему (Platega/СБП) НЕ выполняется: меняется только внутренний ' +
            'баланс SHM. Деньги клиента остаются у нас.',
          'Клиенту и админам уйдёт уведомление о зачислении: Core::User::payment ставит событие ' +
            'payment в спул (User.pm:1017).',
          'Повтор ЭТОГО ЖЕ плана защищён uniq_key (UNIQUE(user_id, uniq_key) в pays_history). От ' +
            'повтора руками он не защищает: новый план — новый ключ, поэтому план отказывается ' +
            'строиться, если такая же сумма этому клиенту уже возвращена этим сервером.',
          `Откат — компенсирующее списание на ${round2(-money)}; ключ для него считается по ` +
            `формуле hq:billing_refund_service:${i.user_id}:<plan_id>:rollback, где plan_id — из ` +
            'этого же ответа. В теле отката его нет: токен плана рождается позже черновика.',
        ];

        if (before.withdraw_bonus > 0) {
          sideEffects.push(
            `Бонусная часть периода (${before.withdraw_bonus}) деньгами НЕ возвращается: ` +
              'withdraw.total — это уже за вычетом бонусов (Billing.pm:229). Если её тоже нужно ' +
              'вернуть, это отдельная операция billing_adjust с kind=bonus.',
          );
        }

        return {
          before,
          after,
          amount: money,
          diff: buildDiff(
            { balance: before.balance },
            { balance: round2(before.balance + money) },
            ctx.profile,
          ),
          sideEffects,
          idempotencyKey: uniqKeyFor('billing_refund_service', i.user_id),
          rollback: {
            method: 'PUT',
            path: '/admin/user/payment',
            body: {
              user_id: i.user_id,
              money: round2(-money),
              comment: { msg: `откат возврата за услугу ${i.user_service_id}: ${i.comment}` },
            },
          },
        };
      },

      apply: async (plan, ctx) => {
        const after = asRecord(plan.after);
        const before = asRecord(plan.before);
        const userId = toNumber(after.user_id, 'user_id из снимка плана');
        const money = toNumber(after.money, 'сумму возврата из снимка плана');

        // Своя строка ПЕРЕД записью: сверка мира отработала до первой попытки,
        // а retryOn408 повторяет применение целиком.
        const rows = await readHistory(ctx, 'balance', userId, NAME);
        const mine = findPlanRow(rows, plan.token);
        if (mine !== undefined) {
          return {
            outcome: 'already_applied',
            payment: mine,
            refunded: money,
            note:
              `Платёж с маркером ЭТОГО плана уже есть в истории (id=${String(mine.id)}): возврат ` +
              'выполнен раньше, сейчас в SHM не ушло ничего. НЕ ПОВТОРЯЙТЕ вызов.',
          };
        }

        const uniqKey = plan.idempotencyKey;
        if (uniqKey === undefined || uniqKey === '') {
          throw new Error(
            `${NAME}: в снимке плана нет uniq_key, а без него повтор возврата ничем не остановлен. ` +
              'Постройте план заново.',
          );
        }

        const raw = await ctx.shm.action<unknown>('PUT', '/admin/user/payment', {
          user_id: userId,
          money,
          comment: stampComment(String(after.comment ?? ''), plan.token),
          uniq_key: uniqKey,
        });
        const payment = firstOf(raw);
        const outcome = classifyPaymentResult({
          returnedPayId: toNumber(payment.id, 'id платежа из ответа SHM'),
          lastPayIdAtPlan: toNumber(before.lastPayId),
        });
        const landed = uniqKeyLanded(payment, uniqKey);
        return {
          outcome,
          payment,
          refunded: money,
          /**
           * Доехал ли ключ идемпотентности до базы; null — ответ об этом
           * молчит. Поле НЕ называется *Key намеренно: редакция маскирует по
           * имени правилом /token|secret|key|password|auth/i, и булев флаг
           * уехал бы вызывающему маркером '<redacted>' — то есть ответ на
           * «сработала ли защита от дубля» не читался бы вовсе.
           */
          idempotencyStored: landed,
          ...(landed === false ? { idempotencyWarning: UNIQ_KEY_DROPPED_NOTE } : {}),
          ...(outcome === 'already_applied'
            ? {
                note:
                  'SHM вернул СУЩЕСТВУЮЩИЙ платёж: сработал дедуп по uniq_key, второго зачисления ' +
                  'не произошло. НЕ ПОВТОРЯЙТЕ операцию.',
              }
            : {}),
        };
      },
    },
    deps,
  );
}
