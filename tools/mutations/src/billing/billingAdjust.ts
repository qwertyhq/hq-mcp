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
import type { MutationDeps, MutationTool } from '../kit.js';
import type { ClientMoney, MoneyRow } from './money.js';
import type { MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';

const NAME = 'billing_adjust';

const input = z.object({
  user_id: z.number().int().positive(),
  kind: z
    .enum(['balance', 'bonus'])
    .describe(
      'balance — деньги (PUT /admin/user/payment, идемпотентно по uniq_key); ' +
        'bonus — бонусы (PUT /admin/user/bonus, идемпотентности НЕТ ВООБЩЕ)',
    ),
  amount: z
    .number()
    .describe('Положительное — начислить, отрицательное — списать. Ноль запрещён.'),
  comment: z
    .string()
    .min(3)
    .describe('Причина корректировки: попадает в историю клиента и в уведомление ему же'),
  allow_duplicate: z
    .boolean()
    .optional()
    .describe(
      'Осознанный повтор. Без него план откажется строиться, если такая же сумма этому клиенту ' +
        'уже начислена этим сервером — почти всегда это повтор после потерянного ответа.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

type Kind = 'balance' | 'bonus';

interface AdjustTarget {
  user_id: number;
  kind: Kind;
  money: number;
  comment: string;
  balance?: number;
  bonus?: number;
}

function targetOf(plan: MutationPlan): AdjustTarget {
  const after = asRecord(plan.after);
  const kind = after.kind === 'bonus' ? 'bonus' : 'balance';
  return {
    user_id: toNumber(after.user_id, 'user_id из снимка плана'),
    kind,
    money: toNumber(after.money, 'сумму из снимка плана'),
    comment: String(after.comment ?? ''),
  };
}

function firstOf(raw: unknown): Record<string, unknown> {
  return asRecord(Array.isArray(raw) ? raw[0] : raw);
}

function alreadyApplied(kind: Kind, row: MoneyRow): Record<string, unknown> {
  return {
    outcome: 'already_applied',
    [kind === 'balance' ? 'payment' : 'bonus']: row,
    note:
      `Строка с маркером ЭТОГО плана уже есть в истории клиента (id=${String(row.id)}): ` +
      'операция была выполнена раньше, сейчас в SHM не ушло ничего. НЕ ПОВТОРЯЙТЕ вызов — ' +
      'сверьте историю инструментом billing_ledger.',
  };
}

/**
 * «Этот план уже применён» — до сверки полей, потому что это точный ответ, а
 * «состояние изменилось (bonus: 10 -> 60)» — общий: оператор по нему не знает,
 * его ли это собственная запись или чужая, и естественная реакция на второе —
 * построить план заново и начислить второй раз.
 */
function assertPlanNotApplied(kind: Kind, rows: readonly MoneyRow[], plan: MutationPlan): void {
  const mine = findPlanRow(rows, plan.token);
  if (mine === undefined) return;
  throw new Error(
    `${NAME}: план уже применён — в истории клиента лежит строка id=${String(mine.id)} с маркером ` +
      `hq-plan:${plan.token} (${kind === 'balance' ? 'платёж' : 'бонус'} от ${String(mine.date)}). ` +
      'Повторное применение запрещено: у бонусов его не остановит ничто на стороне SHM.',
  );
}

/**
 * Корректировка баланса и бонусов клиента SHM.
 *
 * ДВЕ ОПЕРАЦИИ С РАЗНОЙ БЕЗОПАСНОСТЬЮ ПОД ОДНИМ ИМЕНЕМ, И ЭТО НАДО ЧИТАТЬ
 * БУКВАЛЬНО:
 *
 * - `balance` идёт в `PUT /admin/user/payment` → `Core::User::payment`, где
 *   есть дедуп по `(user_id, uniq_key)` (User.pm:1006-1015) поверх уникального
 *   индекса `pays_history` (shm_structure.sql:109-110). Ключ считается один раз,
 *   на этапе плана, из токена плана.
 * - `bonus` идёт в `PUT /admin/user/bonus` → `Core::Bonus::api_add` →
 *   `User::set_bonus`, где `uniq_key` не читается никогда, у `bonus_history`
 *   нет ни колонки, ни индекса (shm_structure.sql:354-362), а
 *   `Core::Sql::Data::clean_query_args` (:503-521) молча выбрасывает поле,
 *   которого нет в структуре таблицы. То есть ключ, положенный в тело запроса,
 *   исчез бы по дороге, ручка вернула бы 200, а бонус клиента удвоился бы.
 *   Поэтому в бонусной ветке его нет ВОВСЕ — вместо него две настоящие защиты:
 *   сверка состояния перед применением (guard каркаса) и поиск собственной
 *   строки по маркеру плана непосредственно перед записью.
 *
 * Инструмент обязан говорить, что именно он делает и чем это защищено: разница
 * уезжает и в `description`, и в `sideEffects` каждого плана.
 */
export function billingAdjust(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: NAME,
      description:
        'Изменить баланс или бонусы клиента SHM. Без plan_id возвращает план (текущее состояние, ' +
        'целевое, diff, побочные эффекты) и НИЧЕГО не меняет. Деньги (kind=balance) защищены ' +
        'uniq_key от повтора одного и того же плана; бонусы (kind=bonus) не защищены ничем на ' +
        'стороне SHM — их повтор удваивает начисление, поэтому инструмент ищет собственную строку ' +
        'в истории перед записью и отказывается строить план на сумму, которую уже начислял.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [
        'GET /admin/user',
        'GET /admin/user/pay',
        'GET /admin/user/bonus',
        'PUT /admin/user/payment',
        'PUT /admin/user/bonus',
      ],
      amountOf: (i) => i.amount,
      target: (i) => ({ system: 'shm', id: i.user_id }),

      guard: {
        // Любое движение денег или бонусов этого клиента между планом и
        // применением делает показанный оператору diff неправдой, а снятие
        // блокировки/блокировку — другой ситуацией. Водяные знаки истории
        // ловят и то движение, которое не изменило сумму (правка строки).
        keys: ['balance', 'bonus', 'block', 'lastPayId', 'lastBonusId'],
        read: async (plan: MutationPlan, ctx: ToolContext): Promise<ClientMoney> => {
          const target = targetOf(plan);
          const fresh = await readClientMoney(ctx, target.user_id, NAME);
          assertPlanNotApplied(target.kind, target.kind === 'balance' ? fresh.pays : fresh.bonuses, plan);
          return fresh.snapshot;
        },
      },

      plan: async (i, ctx) => {
        if (i.amount === 0) {
          throw new Error(`${NAME}: сумма 0 ничего не меняет и в истории клиента только мешает`);
        }

        const read = await readClientMoney(ctx, i.user_id, NAME);
        const isMoney = i.kind === 'balance';
        const rows = isMoney ? read.pays : read.bonuses;
        if (i.allow_duplicate !== true) {
          assertNoHqTwin(
            NAME,
            rows,
            isMoney ? 'money' : 'bonus',
            i.amount,
            isMoney ? 'платёж' : 'начисление бонусов',
            i.user_id,
          );
        }

        const field: Kind = i.kind;
        const current = read.snapshot[field];
        const next = round2(current + i.amount);
        const after: AdjustTarget = {
          user_id: i.user_id,
          kind: i.kind,
          money: i.amount,
          comment: i.comment,
          [field]: next,
        };

        const notify = isMoney
          ? 'Клиенту и админам уйдёт уведомление: Core::User::payment ставит событие payment в ' +
            'спул (User.pm:1017). Тихой корректировки баланса не бывает.'
          : i.amount > 0
            ? 'Клиенту уйдёт уведомление о бонусе (User::set_bonus → make_event("bonus"), User.pm:961).'
            : 'СПИСАНИЕ бонусов не шлёт ничего: make_event("bonus") стоит под условием bonus > 0 ' +
              '(User.pm:961). Клиент увидит минус только в интерфейсе.';

        const protection = isMoney
          ? 'Повтор ЭТОГО ЖЕ плана защищён uniq_key: при совпадении (user_id, uniq_key) ' +
            'Core::User::payment вернёт существующий платёж и баланс не изменится (User.pm:1006-1015). ' +
            'От повтора РУКАМИ ключ не защищает: новый план — новый токен и новый ключ, поэтому ' +
            'план отказывается строиться, если такая же сумма уже начислена этим сервером.'
          : 'Идемпотентности здесь нет ВООБЩЕ: у bonus_history нет ни колонки uniq_key, ни ' +
            'уникального индекса (shm_structure.sql:354-362), а clean_query_args молча выбросил бы ' +
            'ключ из запроса (Sql/Data.pm:503-521) — он выглядел бы защитой и ею не был бы. ' +
            'ПОВТОРНАЯ ЗАПИСЬ УДВОИТ БОНУС и вернёт 200. Защищают две вещи, обе на стороне ' +
            'инструмента: сверка состояния клиента перед записью и поиск собственной строки по ' +
            'маркеру плана прямо перед PUT (найдётся — записи не будет, ответ будет already_applied).';

        const sideEffects = [
          notify,
          protection,
          'Комментарий уедет json-объектом {msg, hq_plan}: колонка comment у обеих таблиц — json ' +
            '(shm_structure.sql:107, :358), голую строку Core::Bonus в неё не оборачивает (в ' +
            'отличие от Core::Pay::add), а маркер плана — единственный способ узнать свою строку.',
          isMoney
            ? `Откат — компенсирующий платёж на ${round2(-i.amount)}. В теле отката нет uniq_key: ` +
              'токен плана рождается позже черновика. Ключ для ручного отката считается по ' +
              `формуле hq:billing_adjust:balance:${i.user_id}:<plan_id>:rollback, где plan_id — из ` +
              'этого же ответа; без него повтор отката спишет деньги второй раз.'
            : `Откат — обратное начисление на ${round2(-i.amount)}, и он защищён ровно так же ` +
              'плохо, как сама операция: ключа у бонусов не существует, повтор отката спишет ' +
              'бонусы дважды.',
        ];

        if (next < 0) {
          sideEffects.push(
            `ПОСЛЕ ОПЕРАЦИИ ${isMoney ? 'баланс' : 'бонусы'} клиента станет отрицательным: ` +
              `${current} → ${next}. SHM это разрешает и списание проведёт, но клиент уйдёт в ` +
              'минус, а следующее списание за услугу упрётся в нехватку средств. Убедитесь, что ' +
              'это то, что нужно.',
          );
        }

        if (isMoney && i.amount > 0 && read.snapshot.partner_id > 0) {
          sideEffects.push(
            `У клиента есть партнёр (user_id=${read.snapshot.partner_id}): зачисление money > 0 ` +
              'отдельной строкой начислит ему бонус income_percent от суммы ' +
              '(Core::User::add_bonuses_for_partners, User.pm:1019-1088). Откат этой корректировки ' +
              'партнёрский бонус НЕ снимет — условие money > 0 стоит только на начислении.',
          );
        }

        return {
          before: read.snapshot,
          after,
          diff: buildDiff({ [field]: current }, { [field]: next }, ctx.profile),
          sideEffects,
          // Ключ ТОЛЬКО денежной ветке и только функцией от токена: в бонусной
          // он не существует, и @hq/idempotency не даст его собрать даже по типам.
          ...(isMoney ? { idempotencyKey: uniqKeyFor('billing_adjust:balance', i.user_id) } : {}),
          rollback: {
            method: 'PUT',
            path: isMoney ? '/admin/user/payment' : '/admin/user/bonus',
            body: {
              user_id: i.user_id,
              ...(isMoney ? { money: round2(-i.amount) } : { bonus: round2(-i.amount) }),
              comment: { msg: `откат корректировки: ${i.comment}` },
            },
          },
        };
      },

      apply: async (plan, ctx) => {
        const target = targetOf(plan);
        const before = asRecord(plan.before);

        // Поиск собственной строки ПЕРЕД записью. Сверка мира отработала до
        // первой попытки, а `retryOn408` каркаса повторяет применение целиком:
        // 408 от прокси ПОСЛЕ успешной записи на бэкенде — единственный
        // сценарий, в котором вторая попытка удвоила бы бонус.
        const rows = await readHistory(ctx, target.kind, target.user_id, NAME);
        const mine = findPlanRow(rows, plan.token);
        if (mine !== undefined) return alreadyApplied(target.kind, mine);

        const comment = stampComment(target.comment, plan.token);

        if (target.kind === 'bonus') {
          // Никакого uniq_key: см. докстринг инструмента.
          const raw = await ctx.shm.action<unknown>('PUT', '/admin/user/bonus', {
            user_id: target.user_id,
            bonus: target.money,
            comment,
          });
          return { outcome: 'applied', bonus: firstOf(raw) };
        }

        const uniqKey = plan.idempotencyKey;
        if (uniqKey === undefined || uniqKey === '') {
          throw new Error(
            `${NAME}: в снимке плана нет uniq_key, а без него повтор платежа ничем не остановлен. ` +
              'Постройте план заново.',
          );
        }

        // dataTruthyGuard уже внутри ShmClient.action: 200 + {data:[null]} —
        // это «операция не выполнена», и до сюда такой ответ не доходит.
        const raw = await ctx.shm.action<unknown>('PUT', '/admin/user/payment', {
          user_id: target.user_id,
          money: target.money,
          comment,
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
                  'SHM вернул СУЩЕСТВУЮЩИЙ платёж: сработал дедуп по uniq_key, второго списания ' +
                  'не произошло и уведомление клиенту не ушло. НЕ ПОВТОРЯЙТЕ операцию.',
              }
            : {}),
        };
      },
    },
    deps,
  );
}
