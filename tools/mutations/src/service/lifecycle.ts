import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import { NO_MONEY, defineMutation, planIdField } from '../kit.js';
import type { DeclaredAmount, MutationDeps, MutationTool, PlanDraft } from '../kit.js';
import { assertServiceOwner, readServicesPage } from './ownership.js';
import type { OwnedService } from './ownership.js';
import type { AuditTarget } from '@hq/audit';
import type { MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';

export type LifecycleAction =
  | 'give'
  | 'touch'
  | 'change_plan'
  | 'schedule_change'
  | 'stop'
  | 'activate'
  | 'delete';

const ACTIONS = [
  'give',
  'touch',
  'change_plan',
  'schedule_change',
  'stop',
  'activate',
  'delete',
] as const;

/** Семь значений `Core::Const.pm` (Const.pm:47-53). Больше статусов у услуги не бывает. */
export const SERVICE_STATUSES = [
  'INIT',
  'NOT PAID',
  'PROGRESS',
  'ACTIVE',
  'BLOCK',
  'REMOVED',
  'ERROR',
] as const;

/**
 * СХЕМА НАМЕРЕННО НЕ ЗАПРЕЩАЕТ ОТРИЦАТЕЛЬНЫЙ `service_id`.
 *
 * `next = -1` — это «удалить услугу по истечении периода» (описание поля в
 * `Core::USObject::structure`, USObject.pm:88-92). Запрет, живущий в zod,
 * доехал бы до пользователя как «Too small: expected number to be >0» — то
 * есть как ошибка ввода, а не как объяснение, что он только что заказал
 * отложенное удаление. Проверку делает хендлер, потому что она про смысл, а не
 * про тип.
 */
const input = z.object({
  user_id: z.number().int().positive(),
  action: z.enum(ACTIONS),
  user_service_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Обязателен для всех действий, кроме give'),
  service_id: z
    .number()
    .int()
    .optional()
    .describe(
      'Обязателен для give, change_plan, schedule_change. Отрицательные значения схема ' +
        'пропускает намеренно: next=-1 означает удаление услуги по истечении периода, и ' +
        'объяснить это должен инструмент, а не валидатор.',
    ),
  finish_active: z
    .union([z.literal(0), z.literal(1)])
    .optional()
    .describe(
      'Только для change_plan и обязателен там явно: 1 — оборвать оплаченный период сейчас с ' +
        'возвратом остатка, 0 — сменить тариф с конца периода. Дефолта нет, хотя у бэкенда он ' +
        'есть и равен 1.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

interface LifecycleBefore {
  user_id: number;
  /** null — действие не адресует существующую услугу (give). */
  user_service_id: number | null;
  status: string | null;
  service_id: number | null;
  next: number | null;
  expire: string | null;
  /**
   * Водяной знак для `give`: у заказа нет «объекта до», а сверка мира (§7.4)
   * обязана на что-то опираться. Максимальный id услуги клиента ловит ровно то,
   * от чего защищаемся, — второй заказ, приехавший между планом и применением.
   * Для остальных действий поле всегда null с обеих сторон, иначе чужой заказ
   * ломал бы никак не связанный с ним `stop`.
   */
  last_user_service_id: number | null;
}

interface LifecycleAfter {
  action: LifecycleAction;
  user_id: number;
  user_service_id: number | null;
  service_id: number | null;
  finish_active: 0 | 1 | null;
  state: Record<string, unknown>;
}

/** Статусы, из которых `USObject::change` вообще что-то делает (USObject.pm:906-936). */
const CHANGEABLE = new Set(['NOT PAID', 'BLOCK', 'ACTIVE']);

/**
 * ДЕЙСТВИЯ, КОТОРЫЕ СПИСЫВАЮТ С БАЛАНСА КЛИЕНТА — и потому обязаны проходить
 * через потолок MAX_OP_AMOUNT. Вердикт по каждому из семи вынесен по коду SHM,
 * а не по названию действия:
 *
 *  give   — ДА. `create_for_api` → `create` → `Billing::create_service`, и при
 *           `auto_bill` (структура `us`, default 1) сразу
 *           `process_service_recursive(EVENT_CREATE)` → `Billing::create` →
 *           `is_pay` → `set_balance(-total)` (Billing.pm:38-46, 337-352).
 *  touch  — ДА. `touch_api` → `touch(EVENT_PROLONGATE)` → `process_service`:
 *           у новой услуги `create`, у истёкшей `prolongate`, и обе кончаются
 *           тем же `is_pay` (USObject.pm:376-382, Billing.pm:122-166, 354-420).
 *  change_plan — ДА. Из BLOCK/NOT PAID — `switch_to_next_service` с новым
 *           списанием; из ACTIVE при `finish_active=1` — `finish` (возврат
 *           остатка) и следом `touch(EVENT_PROLONGATE)`, то есть списание за
 *           новый тариф (USObject.pm:906-937).
 *  activate — ДА. У истёкшей услуги `activate_force` зовёт
 *           `Billing::prolongate(force => 1)`; «Not enough money» из этой ветки
 *           — прямое доказательство, что деньги здесь ходят (USObject.pm:753-774).
 *
 *  schedule_change — НЕТ. Это `USObject::api_set` с whitelist
 *           `admin|auto_bill|next|settings` (USObject.pm:886-899): пишется поле
 *           `next`, и больше не происходит НИЧЕГО — ни события, ни спула, ни
 *           списания. Деньги двинутся при истечении периода, и двинет их крон,
 *           а не этот вызов.
 *  stop   — НЕТ. `block_force` → `touch(EVENT_BLOCK_FORCE)` → `Billing::block`,
 *           который только возвращает событие (Billing.pm:475-479). Возврат
 *           остатка делает `USObject::finish`, и `block_force` его не зовёт.
 *  delete — НЕТ, и это не пропуск. `Billing::remove` → `money_back`: деньги
 *           ВОЗВРАЩАЮТСЯ клиенту. Сумму возврата считает SHM по остатку
 *           периода (`calc_total_by_date_range`), заранее её не знает никто, и
 *           потолок на неведомом числе означал бы запрет удалять услуги вовсе.
 *
 * `change_plan` попадает сюда ЦЕЛИКОМ, хотя из ACTIVE при `finish_active=0`
 * списания сейчас не будет: оператору эти две ветки выглядят одним действием, а
 * у отложенной ветки есть точный неденежный двойник — `schedule_change`. То
 * есть строгость здесь ничего законного не запрещает, а мягкость открыла бы
 * ветку, в которой достаточно опечатки в `finish_active`, чтобы обойти потолок.
 */
const SPENDS_BALANCE = new Set<LifecycleAction>(['give', 'touch', 'change_plan', 'activate']);

/**
 * Событие спула, которое действие ставит в очередь, — для действий, которые
 * НЕ меняют ни одного поля строки услуги.
 *
 * `touch` — ровно такое: `touch_api` зовёт `touch(EVENT_PROLONGATE)`
 * (USObject.pm:376-382), продление двигает `expire` и баланс, но новое
 * значение `expire` считает бэкенд, и заранее его не знает никто. Без этой
 * строки diff продления пуст, а каркас (справедливо) отказывается выдавать
 * токен на план, который ничего не меняет: продлить услугу стало бы нельзя.
 * `change_plan` тоже заканчивается этим событием (USObject.pm:934).
 */
const EVENT_OF: Partial<Record<LifecycleAction, string>> = {
  touch: 'PROLONGATE',
  change_plan: 'PROLONGATE',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function maxServiceId(services: OwnedService[]): number | null {
  return services.reduce<number | null>(
    (top, row) => (top === null || row.user_service_id > top ? row.user_service_id : top),
    null,
  );
}

const SPOOL_NOTE =
  'Биллинг и панель — две системы: 200 от SHM означает «биллинг принял», а не «клиент ' +
  'переключён». Итог смотрите в спуле, он приложен к ответу применения.';

const LOCK_NOTE =
  'Диспетчер SHM берёт лок на строку услуги на 3 секунды и отвечает 408 «The service is ' +
  'locked», если не взял (v1.cgi:1786-1794). Это единственный статус, на который каркас ' +
  'повторяет запрос: бэкенд про него сказал, что не сделал ничего.';

function sideEffectsFor(action: LifecycleAction, before: LifecycleBefore, cost: number | null): string[] {
  // Ветки `null` для тратящих действий не бывает: план отказывает раньше, чем
  // доходит сюда (см. отказ «стоимость … прочитать не удалось»). Она осталась
  // для остальных действий, которым эта строка не показывается вовсе.
  const money =
    cost === null
      ? 'Стоимость целевого тарифа прочитать не удалось — сумма списания неизвестна заранее.'
      : `С баланса клиента спишется ${cost} — стоимость тарифа по каталогу SHM. Эта сумма ` +
        'проходит через потолок MAX_OP_AMOUNT наравне с прямыми платежами: план, который его ' +
        'превышает, не выдаётся вовсе. Фактическое списание может оказаться МЕНЬШЕ — SHM ' +
        'применяет скидку клиента и доступные бонусы (Billing::calc_withdraw, calc_payment), — ' +
        'но не больше.';

  switch (action) {
    case 'give':
      return [
        'Заказ ставит задачу провижининга в спул: в Remnawave клиент появится не мгновенно. ' +
          SPOOL_NOTE,
        money,
        'Отдельного лимита на заказ здесь НЕТ. Счётчик «5 заказов за 10 минут» живёт в ' +
          '`create_for_api_safe` (USObject.pm:1017-1037) — это КЛИЕНТСКИЙ маршрут /service/order. ' +
          'Админский /admin/service/order зовёт `create_for_api` напрямую, и общий счётчик ' +
          'v1.cgi:1723-1731 с тегом core::usobject-create_for_api-<ip> не инкрементирует никто. ' +
          'Ограничитель здесь — только общее ведро запросов процесса.',
        'Каталожная проверка allow_to_order под админом не применяется (USObject.pm:960-969): ' +
          'выдать можно и тариф, закрытый для самостоятельного заказа.',
      ];
    case 'touch':
      return [
        'Продление спишет деньги с баланса клиента и уведомит его через спул. ' + SPOOL_NOTE,
        money,
        LOCK_NOTE,
      ];
    case 'change_plan':
      return [
        before.status === 'ACTIVE'
          ? 'Статус ACTIVE: finish_active=1 обрывает оплаченный период немедленно и возвращает ' +
            'остаток на баланс; finish_active=0 только записывает next и оставляет период ' +
            'доживать — то есть при 0 это ПЛАНОВАЯ смена, а не мгновенная (USObject.pm:906-936).'
          : `Статус ${String(before.status)}: смена произойдёт немедленно через ` +
            'switch_to_next_service, значение finish_active на это НЕ влияет (USObject.pm:925-927).',
        'Смена тарифа порождает задачу провижининга: лимиты и сквады в Remnawave поедут вслед за ' +
          'биллингом. ' +
          SPOOL_NOTE,
        money,
        LOCK_NOTE,
      ];
    case 'schedule_change':
      return [
        'Плановая смена: сработает при истечении текущего периода, немедленного эффекта нет и ' +
          'денег сейчас не двигает.',
        'Это тот же самый эффект, что даёт клиентский шаблон /template/smena: его тело — ' +
          '`us.set( next = new_service_id )` для обычной услуги. Шаблон дополнительно отказывает ' +
          'на бесплатных тарифах и делает НЕМЕДЛЕННУЮ смену для BLOCK/NOT PAID; здесь это ' +
          'разные действия (change_plan) и выбирает их оператор, а не шаблон за него.',
        'На админском маршруте api_safe_args НЕ применяется: диспетчер ставит admin=1 для любого ' +
          '/admin/* (v1.cgi:1670-1683), а Core::Base::api фильтрует поля только без этого флага ' +
          '(Base.pm:417-425). Значит записано будет ВСЁ, что отправлено, — поэтому отправляются ' +
          'ровно user_id, user_service_id и next.',
        LOCK_NOTE,
      ];
    case 'stop':
      return [
        'Остановка отключит клиента в Remnawave через провижининг. ' + SPOOL_NOTE,
        'block_force срабатывает ТОЛЬКО из статуса ACTIVE (USObject.pm:736-749): из любого ' +
          'другого он возвращает ту же строку с кодом 200 и не делает ничего. Предусловие ' +
          'проверено при построении плана и перепроверяется перед применением.',
        LOCK_NOTE,
      ];
    case 'activate':
      return [
        'Активация спишет деньги, если период уже истёк: activate_force зовёт prolongate(force) ' +
          '(USObject.pm:753-774). При нехватке баланса SHM отвечает ошибкой «Not enough money», ' +
          'и услуга остаётся заблокированной.',
        money,
        'activate_force срабатывает ТОЛЬКО из статуса BLOCK: из любого другого он молча ' +
          'возвращает строку. Предусловие проверено планом.',
        SPOOL_NOTE,
        LOCK_NOTE,
      ];
    case 'delete':
      return [
        'Удаление услуги необратимо: отката нет, восстановление — только ручное пересоздание с ' +
          'нуля и новой историей списаний.',
        'Провижининг снесёт пользователя в Remnawave: устройства и ссылка подписки перестанут ' +
          'работать. ' +
          SPOOL_NOTE,
        'Удалённая услуга исчезнет и из списков: USObject::_list дописывает status != REMOVED, ' +
          'когда в условии нет ключа таблицы (USObject.pm:110-121).',
        LOCK_NOTE,
      ];
  }
}

/** Стоимость тарифа по каталогу. Ошибка чтения не бросает — решение принимает вызывающий. */
async function readTariffCost(ctx: ToolContext, serviceId: number): Promise<number | null> {
  try {
    const page = await ctx.shm.list<Record<string, unknown>>('/admin/service', {
      service_id: serviceId,
      limit: 1,
    });
    const row = page.data[0];
    return row === undefined ? null : num(asRecord(row).cost);
  } catch {
    return null;
  }
}

/**
 * ЗА КАКОЙ ТАРИФ ПОЙДЁТ СПИСАНИЕ — а это не всегда тот, что назвал вызывающий,
 * и не всегда текущий тариф услуги.
 *
 * `prolongate` (Billing.pm:354-420) перед оплатой смотрит на `next`: при
 * `next > 0` она зовёт `switch_to_next_service`, и новое списание считается по
 * СЛЕДУЮЩЕМУ тарифу, а не по текущему. То есть `touch` услуги, у которой
 * назначена плановая смена, спишет цену будущего тарифа — и проверять потолок
 * по текущему значило бы проверять не то число.
 *
 * `next < 0` (услуга помечена к удалению по истечении) читается как текущий
 * тариф намеренно: у `prolongate` эта ветка кончается возвратом денег только
 * когда списание УЖЕ оплачено (`withdraw->paid`), а иначе доходит до того же
 * `is_pay`. Взять большее из двух правдоподобных чисел — единственный
 * безопасный выбор там, где точного не существует до самого вызова.
 */
function chargedTariffOf(
  action: LifecycleAction,
  serviceId: number | undefined,
  current: OwnedService | undefined,
): number | null {
  if (!SPENDS_BALANCE.has(action)) return null;
  if (action === 'give' || action === 'change_plan') return serviceId ?? null;
  const next = current?.next ?? null;
  return next !== null && next > 0 ? next : current?.service_id ?? null;
}

/**
 * Цена тарифа, по которой пойдёт списание.
 *
 * Строка услуги уже прочитана и несёт `cost` того же тарифа (`list_for_api`
 * подмешивает поля каталога), поэтому лишнего запроса к `/admin/service` для
 * продления не делается: ведро SHM общее на весь сервис по IP (§6.14), и
 * запрос ради числа, которое уже лежит в руках, — это чужой отказ. Каталог
 * читается там, где тариф ДРУГОЙ (заказ, смена, плановая смена уже
 * назначена), и как вторая попытка, если в строке услуги цены не оказалось.
 */
async function readChargedCost(
  ctx: ToolContext,
  target: number | null,
  current: OwnedService | undefined,
): Promise<number | null> {
  if (target === null) return null;
  if (current !== undefined && target === current.service_id && current.cost !== null) {
    return current.cost;
  }
  return readTariffCost(ctx, target);
}

function beforeOf(plan: MutationPlan): LifecycleBefore {
  const raw = asRecord(plan.before);
  return {
    user_id: num(raw.user_id) ?? 0,
    user_service_id: num(raw.user_service_id),
    status: str(raw.status),
    service_id: num(raw.service_id),
    next: num(raw.next),
    expire: str(raw.expire),
    last_user_service_id: num(raw.last_user_service_id),
  };
}

/**
 * Что читается заново перед применением и почему именно это.
 *
 * `status` — половина действий инструмента бессмысленна или разрушительна из
 * другого статуса (block_force из не-ACTIVE молчит, change из PROGRESS
 * возвращает undef). `service_id` и `next` — смена тарифа поверх чужой смены
 * тарифа. `expire` — услуга, продлившаяся сама между планом и применением:
 * touch поверх такой продлевает второй раз и списывает дважды.
 */
async function readWorld(plan: MutationPlan, ctx: ToolContext): Promise<LifecycleBefore> {
  const before = beforeOf(plan);

  if (before.user_service_id === null) {
    const page = await readServicesPage(ctx, before.user_id);
    return {
      user_id: before.user_id,
      user_service_id: null,
      status: null,
      service_id: null,
      next: null,
      expire: null,
      last_user_service_id: maxServiceId(page.services),
    };
  }

  // Через ту же проверку владения, а не «прочитать строку»: за десять минут
  // жизни плана услуга могла быть удалена или переписана на другого клиента, и
  // применение к ней — ровно то, от чего проверка и стоит. Её исключение
  // каркас запишет как rejected и до бэкенда не пойдёт.
  const row = await assertServiceOwner(
    ctx,
    before.user_id,
    before.user_service_id,
    'service_lifecycle',
  );
  return {
    user_id: before.user_id,
    user_service_id: before.user_service_id,
    status: row.status,
    service_id: row.service_id,
    next: row.next,
    expire: row.expire,
    last_user_service_id: null,
  };
}

interface Call {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
}

function callFor(after: LifecycleAfter): Call {
  const base = { user_id: after.user_id };
  switch (after.action) {
    case 'give':
      return {
        method: 'PUT',
        path: '/admin/service/order',
        body: { ...base, service_id: after.service_id },
      };
    case 'touch':
      return {
        method: 'POST',
        path: '/admin/user/service/touch',
        body: { ...base, user_service_id: after.user_service_id },
      };
    case 'change_plan':
      return {
        method: 'POST',
        path: '/admin/user/service/change',
        body: {
          ...base,
          user_service_id: after.user_service_id,
          service_id: after.service_id,
          finish_active: after.finish_active,
        },
      };
    case 'schedule_change':
      // Только три поля — см. side effect про admin=1: на админском маршруте
      // записывается всё присланное, а не «то, что переживёт api_safe_args».
      return {
        method: 'POST',
        path: '/admin/user/service',
        body: { ...base, user_service_id: after.user_service_id, next: after.service_id },
      };
    case 'stop':
      return {
        method: 'POST',
        path: '/admin/user/service/stop',
        body: { ...base, user_service_id: after.user_service_id },
      };
    case 'activate':
      return {
        method: 'POST',
        path: '/admin/user/service/activate',
        body: { ...base, user_service_id: after.user_service_id },
      };
    case 'delete':
      return {
        method: 'DELETE',
        path: '/admin/user/service',
        body: { ...base, user_service_id: after.user_service_id },
      };
  }
}

/** Чего мы ждём от строки услуги после применения. null — проверяемого инварианта нет. */
function expectationFor(after: LifecycleAfter): { field: string; value: unknown } | null {
  if (after.action === 'stop') return { field: 'status', value: 'BLOCK' };
  if (after.action === 'activate') return { field: 'status', value: 'ACTIVE' };
  if (after.action === 'schedule_change') return { field: 'next', value: after.service_id };
  return null;
}

export function serviceLifecycle(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'service_lifecycle',
      description:
        'Жизненный цикл услуги клиента SHM: give | touch | change_plan | schedule_change | stop | ' +
        'activate | delete. Проверяет принадлежность услуги клиенту (бэкенд её не проверяет) и ' +
        'предусловие по статусу — половина действий из «неправильного» статуса отвечает 200 и не ' +
        'делает ничего. Для change_plan finish_active обязателен явно. give, touch, change_plan и ' +
        'activate списывают с баланса клиента: их сумма — цена тарифа по каталогу — проходит ' +
        'через потолок MAX_OP_AMOUNT, и план, у которого цену прочитать не удалось, не ' +
        'выдаётся. Без plan_id возвращает план и не меняет ничего.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [
        'GET /admin/user/service',
        'GET /admin/service',
        'GET /admin/user/service/spool',
        'PUT /admin/service/order',
        'POST /admin/user/service/touch',
        'POST /admin/user/service/change',
        'POST /admin/user/service',
        'POST /admin/user/service/stop',
        'POST /admin/user/service/activate',
        'DELETE /admin/user/service',
      ],
      target: (i): AuditTarget => ({ system: 'shm', id: i.user_id }),
      /**
       * Денежность здесь — свойство ДЕЙСТВИЯ, и потому решается по `action`, а
       * не по инструменту: десять объявленных ручек и семь действий под одним
       * именем, из которых четыре тратят баланс, а три не трогают его вовсе.
       * Пометить инструмент денежным целиком значило бы требовать сумму у
       * `stop` и `schedule_change` — и уронить их отказом «план не сообщил
       * сумму» за преступление, которого они не совершали.
       *
       * Число не возвращается никогда: цена тарифа лежит в каталоге SHM, а не в
       * аргументах вызова. `null` — обещание сообщить её планом, и каркас
       * взыщет это обещание отказом, если план его не сдержит.
       */
      amountOf: (i): DeclaredAmount => (SPENDS_BALANCE.has(i.action) ? null : NO_MONEY),
      guard: {
        keys: ['status', 'service_id', 'next', 'expire', 'last_user_service_id'],
        read: readWorld,
      },

      plan: async (i, ctx): Promise<PlanDraft> => {
        if (i.action !== 'give' && i.user_service_id === undefined) {
          throw new Error(`service_lifecycle: action=${i.action} требует user_service_id`);
        }
        if (i.action === 'give' && i.user_service_id !== undefined) {
          throw new Error(
            'service_lifecycle: у give нет user_service_id — услуга ещё не существует. Если ' +
              'нужно продлить существующую, это action=touch.',
          );
        }
        if (
          (i.action === 'give' || i.action === 'change_plan' || i.action === 'schedule_change') &&
          i.service_id === undefined
        ) {
          throw new Error(`service_lifecycle: action=${i.action} требует service_id`);
        }
        if (i.action === 'change_plan' && i.finish_active === undefined) {
          throw new Error(
            'service_lifecycle: finish_active обязателен явно для change_plan. 1 — оборвать ' +
              'активный период сейчас с возвратом остатка, 0 — сменить тариф с конца периода. ' +
              'Дефолта здесь нет намеренно: у бэкенда он равен 1 (USObject.pm:906-913), то есть ' +
              'забытый параметр молча обрывает оплаченный период.',
          );
        }
        if (i.finish_active !== undefined && i.action !== 'change_plan') {
          throw new Error(
            `service_lifecycle: finish_active не имеет смысла для action=${i.action} и был бы ` +
              'записан в тело запроса без всякого эффекта. Уберите его.',
          );
        }
        if (i.service_id !== undefined && i.service_id <= 0) {
          if (i.action === 'schedule_change') {
            throw new Error(
              'service_lifecycle: next=-1 (и любое неположительное значение) означает не смену ' +
                'тарифа, а УДАЛЕНИЕ услуги по истечении периода (USObject.pm:88-92). Если ' +
                'удаление действительно нужно — есть action=delete, который честно покажет ' +
                'необратимость в плане.',
            );
          }
          throw new Error(
            `service_lifecycle: service_id=${i.service_id} бессмыслен для action=${i.action}`,
          );
        }

        // Страница читается ТОЛЬКО для заказа — ей там считается водяной знак.
        // Для остальных действий нужна одна строка, и берётся она фильтром: у
        // страницы нет ни доказательства владельца, ни REMOVED-строк. Ведро SHM
        // общее на весь сервис по IP (§6.14), лишний запрос — чужой отказ.
        const forGive = i.action === 'give';
        const page = forGive ? await readServicesPage(ctx, i.user_id) : null;
        const current =
          i.user_service_id === undefined
            ? undefined
            : await assertServiceOwner(ctx, i.user_id, i.user_service_id, 'service_lifecycle');

        if (current !== undefined) {
          if (i.action === 'stop' && current.status !== 'ACTIVE') {
            throw new Error(
              `service_lifecycle: остановить можно только услугу в статусе ACTIVE, а она в ` +
                `${String(current.status)}. block_force из другого статуса возвращает 200 и ту же ` +
                'строку, не сделав ничего (USObject.pm:736-749) — то есть «успех» здесь был бы ' +
                'ложным.',
            );
          }
          if (i.action === 'activate' && current.status !== 'BLOCK') {
            throw new Error(
              `service_lifecycle: возобновить можно только услугу в статусе BLOCK, а она в ` +
                `${String(current.status)}. activate_force из другого статуса ничего не делает и ` +
                'отвечает 200 (USObject.pm:753-774).',
            );
          }
          if (i.action === 'change_plan' && !CHANGEABLE.has(current.status ?? '')) {
            throw new Error(
              `service_lifecycle: смена тарифа работает из статусов ${[...CHANGEABLE].join(', ')}, ` +
                `а услуга в ${String(current.status)}. USObject::change из остальных возвращает ` +
                'undef (USObject.pm:928-930), и это доедет как ошибка уже после записи next.',
            );
          }
          if (i.action === 'change_plan' && current.service_id === i.service_id) {
            throw new Error(
              `service_lifecycle: услуга уже на тарифе ${String(i.service_id)} — смена на него же ` +
                'обрывает оплаченный период ради ничего.',
            );
          }
        }

        // СУММА — ЧАСТЬ ПЛАНА, А НЕ УКРАШЕНИЕ ОТВЕТА. Каркас проверит её
        // потолком (`PlanDraft.amount`), поэтому «прочитать не удалось» здесь
        // обязано быть отказом: молчаливый пропуск вернул бы ровно ту дыру,
        // ради которой всё это и делается.
        const charged = chargedTariffOf(i.action, i.service_id, current);
        const cost = await readChargedCost(ctx, charged, current);
        if (SPENDS_BALANCE.has(i.action) && cost === null) {
          throw new Error(
            `service_lifecycle: action=${i.action} списывает деньги с баланса клиента, а цену ` +
              `тарифа ${charged === null ? '(его id неизвестен)' : String(charged)} прочитать не ` +
              'удалось: GET /admin/service не ответил либо в строке нет cost. Это отказ, а не ' +
              'пропуск — без суммы потолок MAX_OP_AMOUNT проверить нечем, а незнание цены не ' +
              'делает списание бесплатным. Проверьте тариф инструментом catalog_read.',
          );
        }

        const before: LifecycleBefore = {
          user_id: i.user_id,
          user_service_id: i.user_service_id ?? null,
          status: current?.status ?? null,
          service_id: current?.service_id ?? null,
          next: current?.next ?? null,
          expire: current?.expire ?? null,
          last_user_service_id: page === null ? null : maxServiceId(page.services),
        };

        const state: Record<string, unknown> = {
          status: before.status,
          service_id: before.service_id,
          next: before.next,
          expire: before.expire,
          event: EVENT_OF[i.action] ?? null,
        };
        if (i.action === 'stop') state.status = 'BLOCK';
        if (i.action === 'activate') state.status = 'ACTIVE';
        if (i.action === 'change_plan') state.service_id = i.service_id;
        if (i.action === 'schedule_change') state.next = i.service_id;
        if (i.action === 'give') state.service_id = i.service_id;
        if (i.action === 'delete') state.status = 'REMOVED';

        const after: LifecycleAfter = {
          action: i.action,
          user_id: i.user_id,
          user_service_id: i.user_service_id ?? null,
          service_id: i.service_id ?? null,
          finish_active: i.finish_active ?? null,
          state,
        };

        const rollback =
          i.action === 'schedule_change'
            ? {
                method: 'POST' as const,
                path: '/admin/user/service',
                body: {
                  user_id: i.user_id,
                  user_service_id: i.user_service_id,
                  // 0, а не null: SHM читает поле сравнениями `get_next > 0`
                  // (сменить) и `get_next < 0` (удалить) — USObject.pm:417-418,
                  // Billing.pm:388-390. Ноль означает «плановой смены нет», то
                  // есть ровно исходное состояние, а null в теле JSON часть
                  // ручек просто выбрасывает и откат оказался бы пустым.
                  next: before.next ?? 0,
                },
              }
            : undefined;

        return {
          before,
          after,
          diff: buildDiff(
            {
              status: before.status,
              service_id: before.service_id,
              next: before.next,
              event: null,
            },
            {
              status: state.status,
              service_id: state.service_id,
              next: state.next,
              event: state.event,
            },
            ctx.profile,
          ),
          sideEffects: sideEffectsFor(i.action, before, cost),
          // Заполняется РОВНО для тратящих действий: у `stop` и
          // `schedule_change` суммы нет, и выдуманный ноль означал бы «сумма
          // известна и равна нулю» вместо «денег тут не двигают».
          ...(SPENDS_BALANCE.has(i.action) && cost !== null ? { amount: cost } : {}),
          ...(rollback === undefined ? {} : { rollback }),
        };
      },

      apply: async (plan, ctx) => {
        const raw = asRecord(plan.after);
        const after: LifecycleAfter = {
          action: String(raw.action) as LifecycleAction,
          user_id: num(raw.user_id) ?? 0,
          user_service_id: num(raw.user_service_id),
          service_id: num(raw.service_id),
          finish_active: raw.finish_active === 0 || raw.finish_active === 1 ? raw.finish_active : null,
          state: asRecord(raw.state),
        };

        const call = callFor(after);
        // Без собственного retryOn408: applyPlan уже оборачивает применение.
        // Второй слой повторов перемножил бы попытки (3 × 3 = 9 записей на
        // ручке, у которой идемпотентности нет).
        const result = await ctx.shm.action<unknown>(call.method, call.path, call.body);

        // id новой услуги нужен и для спула, и для ответа: заказ — единственное
        // действие, после которого адрес объекта появляется только сейчас.
        const created = Array.isArray(result) ? asRecord(result[0]) : asRecord(result);
        const userServiceId = after.user_service_id ?? num(created.user_service_id);

        let observed: OwnedService | null = null;
        let verifyError: string | undefined;
        try {
          const page = await readServicesPage(ctx, after.user_id);
          observed = page.services.find((one) => one.user_service_id === userServiceId) ?? null;
        } catch (error: unknown) {
          verifyError = error instanceof Error ? error.message : String(error);
        }

        // Спул читается ПОСЛЕ проверки состояния и требует ОБА id: маршрут
        // объявлен `required => ['user_id','user_service_id']` (v1.cgi:877-884),
        // и диспетчер отвечает 400 ещё до контроллера, если второго нет.
        let spool: unknown[] = [];
        let spoolError: string | undefined;
        if (userServiceId !== null) {
          try {
            const tasks = await ctx.shm.list<unknown>('/admin/user/service/spool', {
              user_id: after.user_id,
              user_service_id: userServiceId,
              limit: 10,
            });
            spool = tasks.data;
          } catch (error: unknown) {
            spoolError = error instanceof Error ? error.message : String(error);
          }
        }

        // Расхождение — предупреждение, а не ошибка: часть действий доезжает до
        // строки услуги через спул, и объявить успешную операцию неудачной
        // значит спровоцировать повтор. Молчать о расхождении тоже нельзя —
        // ровно так «успех» и становится ложным.
        const expected = expectationFor(after);
        const drift =
          expected === null || observed === null
            ? null
            : (observed as unknown as Record<string, unknown>)[expected.field] === expected.value
              ? null
              : {
                  field: expected.field,
                  expected: expected.value,
                  observed: (observed as unknown as Record<string, unknown>)[expected.field],
                  note:
                    'Биллинг ответил успехом, но строка услуги этого пока не показывает. Часть ' +
                    'переходов доезжает через спул — сверьтесь со списком задач ниже, прежде ' +
                    'чем повторять: повтор здесь спишет деньги второй раз.',
                };

        return {
          service: result,
          user_service_id: userServiceId,
          state: observed,
          spool,
          ...(drift === null ? {} : { drift }),
          ...(spoolError === undefined ? {} : { spool_error: spoolError }),
          ...(verifyError === undefined ? {} : { verify_error: verifyError }),
        };
      },
    },
    deps,
  );
}
