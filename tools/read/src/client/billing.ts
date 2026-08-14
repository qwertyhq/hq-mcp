import { defineTool } from '@hq/registry';
import { scrubSecretShapes } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  CLIENT_ITEMS_UNRELIABLE,
  EMPTY_LIST,
  asArray,
  asRecord,
  capLimit,
  clientExists,
  firstRow,
  listOut,
  num,
  safeEndpoint,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

const ROUTES = {
  forecast: '/user/pay/forecast',
  paysystems: '/user/pay/paysystems',
  payments: '/user/pay',
  withdraws: '/user/withdraw',
  autopay: '/user/autopayment',
} as const;

const MAX_LIMIT = 200;

/**
 * Горизонт прогноза. `Core::Pay::forecast` объявляет `days => 3` дефолтом
 * (app/lib/Core/Pay.pm:96-101) и отбирает услуги с `auto_bill = 1`, у которых
 * `expire` наступает раньше «завтра + days». Число живёт здесь, чтобы его
 * можно было назвать вслух в предупреждении: пустой список — это «в ближайшие
 * трое суток списывать нечего», а не «клиент ничего не платит».
 */
const FORECAST_DAYS = 3;

interface OfferedPaysystem {
  /**
   * Настоящий идентификатор платёжной системы — из параметра `ps` ссылки
   * оплаты; ровно он стоит в `pay_system_id` строки платежа.
   *
   * ПОЛЕ НАЗВАНО `paysystemId`, А НЕ `key`, И ЭТО НЕ ВКУСОВЩИНА. Редакция
   * исполнителя маскирует по ИМЕНИ поля правилом /token|secret|key|password|
   * auth/i, то есть поле с именем `key` уехало бы вызывающему маркером в
   * каждом ответе — вместе с единственным значением, ради которого ссылка
   * вообще разбиралась.
   */
  paysystemId: string | null;
  /** Значение поля `paysystem`: у нескольких разных методов оно совпадает. */
  family: string | null;
  label: string | null;
  recurring: boolean;
  internal: boolean;
  allowDeletion: boolean;
  /** Что сделает ссылка: `create` — завести платёж, `payment` — списать по сохранённому методу. */
  action: string | null;
  /** Только схема и хост ссылки оплаты; путь, query и креды из значения вырезаны. */
  endpoint: string | null;
  proposedAmount: number | null;
}

/** Значение query-параметра ссылки оплаты; ссылка целиком наружу не уходит. */
function urlParam(url: string | null, name: string): string | null {
  if (url === null) return null;
  const found = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  const value = found?.[1];
  return value === undefined || value === '' ? null : decodeURIComponent(value);
}

function buildPaysystem(row: Record<string, unknown>): OfferedPaysystem {
  const url = str(row.shm_url);
  const amount = num(row.amount, Number.NaN);
  return {
    paysystemId: urlParam(url, 'ps'),
    family: str(row.paysystem),
    // Название метода приходит из конфигурации и является свободным текстом —
    // прогоняем его через чистку по форме, а не доверяем имени поля.
    label: str(scrubSecretShapes(str(row.name) ?? '').text),
    recurring: num(row.recurring, 0) === 1,
    internal: num(row.internal, 0) === 1,
    allowDeletion: num(row.allow_deletion, 0) === 1,
    action: urlParam(url, 'action'),
    endpoint: safeEndpoint(url).value,
    proposedAmount: Number.isFinite(amount) ? amount : null,
  };
}

function buildForecastItem(row: Record<string, unknown>): Record<string, unknown> {
  const next = asRecord(row.next);
  return {
    userServiceId: num(row.user_service_id, Number.NaN) || null,
    serviceId: num(row.service_id, Number.NaN) || null,
    name: str(row.name),
    status: str(row.status),
    expire: str(row.expire),
    currentCost: num(row.total, 0),
    next: {
      serviceId: num(next.service_id, Number.NaN) || null,
      name: str(next.name),
      cost: num(next.cost, 0),
      months: num(next.months, 0),
      discount: num(next.discount, 0),
      bonusApplied: num(next.bonus, 0),
      total: num(next.total, 0),
    },
  };
}

export const clientBillingView = defineTool({
  name: 'client_billing_view',
  description:
    "Money as the CLIENT sees it, not as the admin tables show it. Reads SHM's client-side API " +
    'under admin credentials with `?user_id=` context switching: the upcoming charge and what it ' +
    'is made of (`/user/pay/forecast`), which payment methods this client is actually offered ' +
    '(`/user/pay/paysystems`), their payments (`/user/pay`), their service charges ' +
    '(`/user/withdraw`) and whatever recurring method SHM has on file for them ' +
    '(`/user/autopayment`). billing_ledger answers "what was moved" from the admin tables; this ' +
    'answers "what is about to be taken, and how can this client pay it" from the same place the ' +
    'client Mini App reads. The forecast covers a three-day window of auto-billed services only, ' +
    'so an empty one is never proof that nothing will be charged. Payment-initiation URLs are not ' +
    'returned: the route hands out ready-to-use links that create a payment, and only the method ' +
    'key, the action and the host survive. Nothing here writes — the mutating siblings (PUT ' +
    '/service/order, POST /user/service/change, DELETE /user/autopayment) are not implemented.',
  input: z.object({
    shm_user_id: z
      .number()
      .int()
      .positive()
      .describe('SHM user_id whose own view of billing to read. Resolve it with client_resolve.'),
    limit: z
      .number()
      .int()
      .default(25)
      .describe('Rows of payments and of service charges, capped at 200. Newest first.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, limit }, ctx) => {
    const cap = capLimit(limit, 25, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    // Существование клиента проверяется ПЕРВЫМ и отдельным запросом: клиентские
    // маршруты на неизвестном user_id отвечают пятисоткой, а не пустотой.
    const presence = await clientExists(ctx.shm, shm_user_id);
    if (presence.error !== null) degraded.push({ system: 'shm', error: presence.error });
    if (presence.exists === false) {
      warnings.push(
        warn(
          'user_not_found',
          `SHM has no user_id ${String(shm_user_id)}. The client-side routes were not called at ` +
            'all: switching context to a user that does not exist does not return an empty ' +
            'answer there, it returns HTTP 500, which reads exactly like the backend being down. ' +
            'Deleted clients behave the same way while their payments and promo redemptions stay ' +
            'in the admin tables — so "no such client here" and "this id never existed" are ' +
            'different statements, and only the first is made.',
        ),
      );
      return {
        userId: shm_user_id,
        exists: false,
        forecast: null,
        paysystems: { offered: [], count: 0, payableIncludingBlocked: null },
        payments: EMPTY_LIST,
        withdraws: EMPTY_LIST,
        autopay: { recordedMethods: [], count: 0 },
        warnings,
        degraded,
      };
    }

    const scope = { user_id: shm_user_id };
    const [forecastRaw, paysystemsRaw, autopayRaw, paymentsRes, withdrawsRes] = await Promise.all([
      settle(ctx.shm.get<unknown>(ROUTES.forecast, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.paysystems, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.autopay, scope)),
      settle(ctx.shm.list<unknown>(ROUTES.payments, { ...scope, limit: cap })),
      settle(ctx.shm.list<unknown>(ROUTES.withdraws, { ...scope, limit: cap })),
    ]);

    const forecastRow = firstRow(take(forecastRaw, 'shm', degraded, [] as unknown));
    const forecastRead = forecastRaw.ok;
    const forecastItems = asArray(forecastRow.items).map(asRecord).map(buildForecastItem);
    const debt = num(forecastRow.dept, Number.NaN);
    const forecast = forecastRead
      ? {
          balance: num(forecastRow.balance, 0),
          bonuses: num(forecastRow.bonuses, 0),
          /** Сколько НАДО ДОПЛАТИТЬ: уже уменьшено на баланс и бонусы. */
          amountDue: num(forecastRow.total, 0),
          /** Долг: заполнен, только когда баланс отрицательный. */
          debt: Number.isFinite(debt) ? debt : null,
          windowDays: FORECAST_DAYS,
          items: forecastItems,
        }
      : null;

    const paysystemRows = asArray(take(paysystemsRaw, 'shm', degraded, [] as unknown)).map(asRecord);
    const offered = paysystemRows.map(buildPaysystem);
    /**
     * Сумма, которую форма оплаты подставит клиенту. Это НЕ `amountDue` выше:
     * `Core::Pay::paysystems` зовёт свой прогноз с `blocked => 1`
     * (app/lib/Core/Pay.pm:271), а маршрут прогноза считает с дефолтным
     * `blocked => 0` (Pay.pm:99). То есть одно число включает заблокированные
     * услуги, а другое нет, и расходятся они ровно на них.
     */
    const payableRow = paysystemRows[0];
    const payable = payableRow === undefined ? Number.NaN : num(payableRow.forecast, Number.NaN);
    const payableIncludingBlocked = Number.isFinite(payable) ? payable : null;

    const autopayRow = firstRow(take(autopayRaw, 'shm', degraded, [] as unknown));
    // ЗНАЧЕНИЯ НЕ ВЫНОСЯТСЯ. Под каждым ключом лежит запись платёжной системы о
    // сохранённом методе — идентификатор подписки и то, чем с неё списывают. Её
    // содержимое не нужно ни для одного вопроса поддержки, а имя поля над ним
    // ничего не обещает, то есть маскировать его нечем. Наружу идёт факт
    // наличия и перечень имён полей.
    const recordedMethods = Object.entries(autopayRow).map(([key, value]) => ({
      paysystem: key,
      fieldsPresent: Object.keys(asRecord(value)).sort(),
    }));

    const payments = listOut(
      take(paymentsRes, 'shm', degraded, EMPTY_LIST),
      warnings,
      'client payments',
    );
    const withdraws = listOut(
      take(withdrawsRes, 'shm', degraded, EMPTY_LIST),
      warnings,
      'client service charges',
    );

    if (forecastRead && forecastItems.length === 0) {
      warnings.push(
        warn(
          'forecast_window_is_empty',
          `Nothing is due in the next ${String(FORECAST_DAYS)} days. That is the whole claim: the ` +
            'forecast only lists services with auto-billing on whose expiry falls inside that ' +
            'window, so a service expiring next week, a service with auto-billing off, and a ' +
            'client who simply has no services all produce this same empty list. Read ' +
            'service_inspect for what the client actually holds.',
        ),
      );
    }
    if (forecastRead && forecastItems.length > 0 && num(forecastRow.total, 0) === 0) {
      warnings.push(
        warn(
          'forecast_covered_by_balance',
          'There are charges coming, but the amount to pay is 0 because the balance and bonuses ' +
            'already cover them. "Total 0" here does not mean "nothing will be taken".',
        ),
      );
    }

    const families = new Set(offered.map((one) => one.family));
    if (offered.length > families.size) {
      warnings.push(
        warn(
          'paysystem_family_collapsed',
          `${String(offered.length)} payment methods are offered but only ${String(families.size)} ` +
            'distinct values of `paysystem` among them: SHM lets a method override that field, so ' +
            'several separate methods report the same family name. The identifier that actually ' +
            'matches `pay_system_id` on a payment row is `key`, taken from the payment link. ' +
            'Matching a client\'s payment to a method by `family` merges methods that are not the ' +
            'same one.',
        ),
      );
    }
    if (
      forecastRead &&
      payableIncludingBlocked !== null &&
      payableIncludingBlocked !== num(forecastRow.total, 0)
    ) {
      warnings.push(
        warn(
          'payable_amount_differs_from_forecast',
          `The payment form would propose ${String(payableIncludingBlocked)} while the forecast ` +
            `says ${String(num(forecastRow.total, 0))} is due. Both numbers are correct and they ` +
            'are not the same question: the payment form asks for a forecast that INCLUDES ' +
            'blocked services, the forecast route excludes them. The gap is what it would cost to ' +
            'bring the blocked services back. Quote `amountDue` for "what is due", ' +
            '`payableIncludingBlocked` for "what the client will be asked to pay".',
        ),
      );
    }
    if (offered.length > 0) {
      warnings.push(
        warn(
          'payment_url_dropped',
          'Each offered method came with a ready-to-use link that CREATES a payment for this ' +
            'client (action, user_id, timestamp and amount are all in its query string). The link ' +
            'is not reproduced: only its host, its `action` and the method key are. Do not ' +
            'reconstruct it.',
        ),
      );
    }
    if (autopayRaw.ok && recordedMethods.length === 0) {
      warnings.push(
        warn(
          'autopay_not_recorded_in_shm',
          "SHM has no recurring method on file for this client — and on this installation that is " +
            'NOT evidence that nobody is charging them. Checked on a running SHM rather than in ' +
            'the spec: clients with active recurring charges (payments under a `platega_sub` pay ' +
            'system) still return an empty record here: the route reads `user.settings.pay_systems` ' +
            'and drops every entry whose configured pay system does not declare `allow_recurring`. ' +
            'The subscription state that actually governs those charges lives in the payment ' +
            'comments — read autopay_inspect before telling anyone their autopayment is off.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one client-side route did not answer (see `degraded`). Whatever came back ' +
            'empty because of that is missing data, not an absent charge, an absent payment ' +
            'method or an absent payment.',
        ),
      );
    }

    return {
      userId: shm_user_id,
      exists: true,
      forecast,
      paysystems: {
        offered,
        count: offered.length,
        payableIncludingBlocked,
        itemsNote: CLIENT_ITEMS_UNRELIABLE,
      },
      payments,
      withdraws,
      autopay: { recordedMethods, count: recordedMethods.length },
      warnings,
      degraded,
    };
  },
});
