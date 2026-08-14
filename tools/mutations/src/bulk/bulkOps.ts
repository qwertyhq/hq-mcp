import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool, PlanDraft, PlanGuard } from '../kit.js';
import { USER_STATUSES, readFleet, readFleetTotal, resolveUserIds } from './fleet.js';
import type { FleetUser } from './fleet.js';

/**
 * МАССОВЫЕ ОПЕРАЦИИ НАД КЛИЕНТАМИ ПАНЕЛИ. ДВЕ СЕМЬИ, И ОНИ НЕ ОДНО И ТО ЖЕ.
 *
 * Сверено с контрактом Remnawave 3.2.3 (libs/contract/commands/users/bulk и
 * .../bulk-all) и с реализацией (src/modules/users/users.service.ts,
 * repositories/users.repository.ts):
 *
 *  1. ПО НАЗВАННОМУ НАБОРУ — `bulk/{update, reset-traffic, revoke-subscription,
 *     update-squads, extend-expiration-date, delete}`. В теле `userIds`, и схема
 *     объявляет `z.array(z.number()).min(1).max(500)`: ПЯТЬСОТ — предел одного
 *     вызова у самой панели, не наша выдумка.
 *  2. ПО ВСЕМУ ФЛОТУ — `bulk/all/{update, reset-traffic, extend-expiration-date}`.
 *     Списка нет вовсе; репозиторий идёт по диапазонам id и трогает КАЖДУЮ
 *     строку таблицы (`bulkUpdateAllUsersByRange`, `bulkAllExtendExpirationDate`).
 *
 * ЧТО ЭТИ РУЧКИ ОТВЕЧАЮТ: НИЧЕГО. Контроллер `UsersBulkActionsController`
 * возвращает `202 Accepted` или `204 No Content` с ПУСТЫМ ТЕЛОМ на всех десяти
 * маршрутах. 202 — это «поставлено в очередь», а не «сделано»: `bulkUpdateUsers`,
 * `bulkResetUserTraffic`, `bulkRevokeUsersSubscription` и всё семейство `all/*`
 * уходят в `usersQueuesService` и обрабатываются потом, по одному. Отсюда два
 * следствия, которые план обязан говорить вслух: подтверждения, что операция
 * применилась, не будет НИКОГДА, и числа затронутых панель не вернёт тоже.
 * Единственное честное число — то, что мы сами посчитали ДО применения.
 *
 * ПОЧЕМУ ГЕЙТ ЖЁСТЧЕ, ЧЕМ У СОСЕДНИХ МУТАТОРОВ. У точечных инструментов цена
 * ошибки — один клиент, и он же о ней сообщит. Здесь цена ошибки — бизнес:
 * `sync_audit` находит ЕДИНИЦЫ услуг с настоящей поломкой, а неосторожный вызов
 * задевает весь флот учёток разом. Поэтому: число затронутых берётся у панели и
 * без него плана нет вовсе; потолок `HQ_MCP_MAX_BULK_USERS` (каркас, дефолт 100);
 * `profiles: ['human']`; первой строкой побочных эффектов — необратимость.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО:
 *  - `POST /api/users/bulk/delete-by-status` — запрещённая ручка (§8) и
 *    остаётся ею. Тело у неё `{status}`: удаляет тех, кто подпадёт под статус
 *    В МОМЕНТ РАБОТЫ ОЧЕРЕДИ, а не тех, кого показали оператору. Действие
 *    `delete_by_status` здесь есть, но работает иначе: план ПЕРЕЧИСЛЯЕТ
 *    конкретные id с этим статусом, а применение удаляет ровно их через
 *    `bulk/delete`. Разница не косметическая — между планом и применением
 *    клиенты истекают, и беспамятная ручка удалила бы тех, кого никто не видел.
 *  - `telegramId` и `email` в полях обновления. Одно значение на весь набор
 *    склеивает N личностей в одну; правка личности — операция поштучная.
 *  - `description` — там лежат заметки ПО КЛИЕНТУ, и массовая запись стирает
 *    N разных текстов, ни один из которых мы не показывали.
 *  - `externalSquadUuid` — переселение между внешними сквадами через поле
 *    обновления обошло бы запрет §8 на `/bulk-actions/` с другого конца.
 */

const SET_ACTIONS = [
  'update',
  'reset_traffic',
  'revoke_subscription',
  'update_squads',
  'extend_expiration',
  'delete',
  'delete_by_status',
] as const;

const FLEET_ACTIONS = ['all_update', 'all_reset_traffic', 'all_extend_expiration'] as const;

const ACTIONS = [...SET_ACTIONS, ...FLEET_ACTIONS] as const;

const actionEnum = z.enum(ACTIONS);

type Action = z.infer<typeof actionEnum>;

const FLEET_SET = new Set<Action>(FLEET_ACTIONS);
const DELETE_SET = new Set<Action>(['delete', 'delete_by_status']);

/** RESET_PERIODS панели 3.2.3 — закрытый список. */
const RESET_PERIODS = ['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'] as const;

/**
 * Статусы, которые панель принимает в массовом обновлении: `bulkUpdateUsers` и
 * `bulkUpdateAllUsers` отвечают INVALID_USER_STATUS_ERROR на EXPIRED и LIMITED
 * (users.service.ts:632-637, :676-679). Их выставляет сама панель по сроку и по
 * трафику, руками они не ставятся.
 */
const SETTABLE_STATUSES = ['ACTIVE', 'DISABLED'] as const;

const STATUS_ACTIVE = 'ACTIVE';

/** Потолок `userIds` у панели. Не настройка: так объявлена схема запроса. */
const PANEL_SET_LIMIT = 500;

const TAG_RE = /^[A-Z0-9_]+$/;

const input = z.object({
  action: actionEnum.describe(
    'ПО НАЗВАННОМУ НАБОРУ (нужен user_ids): update — изменить поля; reset_traffic — обнулить ' +
      'счётчики; revoke_subscription — перевыпустить подписки; update_squads — ЗАМЕНИТЬ набор ' +
      'сквадов; extend_expiration — прибавить дней к сроку; delete — удалить учётки. ' +
      'delete_by_status — удалить всех с указанным status: план перечислит их поимённо, ' +
      'применение удалит ровно перечисленных. ПО ВСЕМУ ФЛОТУ (без списка, каждая учётка ' +
      'панели): all_update, all_reset_traffic, all_extend_expiration.',
  ),
  user_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(PANEL_SET_LIMIT)
    .optional()
    .describe(
      `ЧИСЛОВЫЕ id клиентов панели (поле id), не uuid и не telegramId. Максимум ${String(
        PANEL_SET_LIMIT,
      )} — предел самой панели. Требуется всем действиям, кроме delete_by_status и all_*.`,
    ),
  status: z
    .enum(USER_STATUSES)
    .optional()
    .describe(
      'Только для delete_by_status: чей статус попадает под удаление. Сколько это людей, ' +
        'план сообщит числом до применения.',
    ),
  extend_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe(
      'Только для extend_expiration / all_extend_expiration. ВНИМАНИЕ: массовое продление ' +
        'считается как expireAt + N дней, а НЕ max(сейчас, expireAt) + N. Давно истёкшему ' +
        'клиенту оно доступа не вернёт.',
    ),
  set_status: z
    .enum(SETTABLE_STATUSES)
    .optional()
    .describe(
      'Только для update / all_update: ACTIVE или DISABLED. EXPIRED и LIMITED панель ' +
        'отвергает — их она ставит сама.',
    ),
  traffic_limit_bytes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Только для update / all_update. 0 — безлимит.'),
  traffic_limit_strategy: z
    .enum(RESET_PERIODS)
    .optional()
    .describe('Только для update / all_update: период автосброса счётчика трафика.'),
  expire_at: z
    .string()
    .optional()
    .describe(
      'Только для update: ОДНА абсолютная дата ISO на весь набор. Прежние даты клиентов она ' +
        'затирает. Для all_update запрещена — фleet-wide это уничтожение 1000+ разных дат без ' +
        'источника, из которого их восстановить.',
    ),
  hwid_device_limit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Только для update / all_update: сколько устройств разрешено. 0 — без ограничения.'),
  tag: z
    .string()
    .max(16)
    .regex(TAG_RE, 'tag: только заглавные латинские буквы, цифры и подчёркивание')
    .optional()
    .describe('Только для update: метка группировки. Прежние метки набора она затирает.'),
  squad_uuids: z
    .array(z.string().uuid())
    .optional()
    .describe(
      'Только для update_squads: набор внутренних сквадов, который станет у клиентов вместо ' +
        'нынешнего (панель снимает старые и ставит эти). ПУСТОЙ СПИСОК — это снятие со всех ' +
        'сквадов, то есть потеря доступа ко всем серверам.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/**
 * Поля обновления — ЗАКРЫТЫЙ список. `strictObject`, потому что план приезжает
 * с диска: лишний ключ в снимке иначе доехал бы до панели нетронутым, а
 * `telegramId`/`email`/`description`/`externalSquadUuid` эта ручка принимает
 * (BulkUpdateUsersCommand.RequestBodySchema) — здесь их нет намеренно.
 */
const fieldsSchema = z.strictObject({
  status: z.enum(SETTABLE_STATUSES).optional(),
  trafficLimitBytes: z.number().int().min(0).optional(),
  trafficLimitStrategy: z.enum(RESET_PERIODS).optional(),
  expireAt: z.string().optional(),
  hwidDeviceLimit: z.number().int().min(0).optional(),
  tag: z.string().max(16).regex(TAG_RE).optional(),
});

type Fields = z.infer<typeof fieldsSchema>;

/** Всё, что применение читает из плана. Ничего сверх этого оттуда не берётся. */
const opSchema = z.object({
  action: actionEnum,
  user_ids: z.array(z.number().int().positive()).min(1).max(PANEL_SET_LIMIT).optional(),
  extend_days: z.number().int().min(1).max(3650).optional(),
  fields: fieldsSchema.optional(),
  squad_uuids: z.array(z.string().uuid()).optional(),
});

type Op = z.infer<typeof opSchema>;

/** Пути — целыми литералами на ветку, из переменных не собираются (§8-скан). */
const BULK_PATH = {
  update: '/api/users/bulk/update',
  reset_traffic: '/api/users/bulk/reset-traffic',
  revoke_subscription: '/api/users/bulk/revoke-subscription',
  update_squads: '/api/users/bulk/update-squads',
  extend_expiration: '/api/users/bulk/extend-expiration-date',
  delete: '/api/users/bulk/delete',
  all_update: '/api/users/bulk/all/update',
  all_reset_traffic: '/api/users/bulk/all/reset-traffic',
  all_extend_expiration: '/api/users/bulk/all/extend-expiration-date',
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function refuse(message: string): never {
  throw new Error(`bulk_ops: ${message}`);
}

function isFleet(action: Action): boolean {
  return FLEET_SET.has(action);
}

/**
 * Что видно в снимке. Ключи, попадающие в сверку мира, перечислены в
 * `GUARD_KEYS`; остальные существуют ради оператора и в сверке не участвуют.
 */
type BulkState = Record<string, unknown>;

/**
 * Поля, расхождение которых означает «мир уехал».
 *
 *  - `affectedCount` — то самое число, которое оператор подтверждал. Изменилось
 *    — значит подтверждали другое.
 *  - `userIds` — состав набора (только у действий по списку; у `all_*` ключа
 *    нет ни в снимке, ни в перечитанном состоянии, и сверка по нему молчит).
 *  - `fleetTotal` — размер флота (только у `all_*`, и наоборот). В снимок
 *    действий по списку он НЕ кладётся намеренно: флот растёт от каждой
 *    регистрации, и сверка по нему отвергала бы планы по причине, к набору
 *    отношения не имеющей.
 *  - `targetStatuses` — только у удаления. Статус клиента между планом и
 *    применением меняется сам (истёк срок, кончился трафик), а удаление
 *    необратимо: если состояние тех, кого собрались удалить, стало другим,
 *    решение принималось по устаревшей картине и обязано быть принято заново.
 *  - счётчик трафика и `usedTrafficBytes` сюда не входят: у подключённого
 *    клиента они растут сами, и сверка по ним отвергала бы каждый второй план.
 */
const GUARD_KEYS = ['affectedCount', 'userIds', 'fleetTotal', 'targetStatuses'];

const IRREVERSIBLE: Record<Action, string> = {
  update:
    'НЕОБРАТИМО. Прежние значения полей у затронутых клиентов будут перезаписаны; вернуть их ' +
    'можно только вручную и только по снимку «до» из этого плана.',
  reset_traffic:
    'НЕОБРАТИМО. Обнулённые счётчики трафика не восстанавливаются ничем: прежних значений после ' +
    'применения не существует нигде.',
  revoke_subscription:
    'НЕОБРАТИМО. Старые ссылки подписки и все уже установленные конфиги перестанут работать в тот ' +
    'же миг, у всех сразу. Новые ссылки этот инструмент не выдаёт — их забирают в панели и ' +
    'доставляют клиентам вручную, автоматической рассылки в системе нет.',
  update_squads:
    'НЕОБРАТИМО. Панель СНИМАЕТ прежние сквады и ставит названные; прежний набор восстанавливается ' +
    'только вручную и только по снимку «до» из этого плана.',
  extend_expiration:
    'НЕОБРАТИМО. Обратной операции «убрать дни» у панели нет; возврат — это ручная простановка ' +
    'даты каждому.',
  delete:
    'НЕОБРАТИМО И БЕЗ ВОССТАНОВЛЕНИЯ. Учётки удаляются вместе с ключами, подписками и историей. ' +
    'Резервной копии базы панели, из которой их можно поднять, может не быть вовсе: регулярный ' +
    'pg_dump панели — не данность, и рассчитывать на него нельзя.',
  delete_by_status:
    'НЕОБРАТИМО И БЕЗ ВОССТАНОВЛЕНИЯ. Учётки удаляются вместе с ключами, подписками и историей. ' +
    'Резервной копии базы панели, из которой их можно поднять, может не быть вовсе: регулярный ' +
    'pg_dump панели — не данность, и рассчитывать на него нельзя.',
  all_update:
    'НЕОБРАТИМО И ПО ВСЕМУ ФЛОТУ. Прежние значения будут перезаписаны у КАЖДОЙ учётки панели; ' +
    'снимка, по которому их вернуть, не существует — в плане лежит сводка, а не тысяча строк.',
  all_reset_traffic:
    'НЕОБРАТИМО И ПО ВСЕМУ ФЛОТУ. Счётчики трафика обнулятся у КАЖДОЙ учётки панели, прежних ' +
    'значений не останется нигде.',
  all_extend_expiration:
    'НЕОБРАТИМО И ПО ВСЕМУ ФЛОТУ. Срок сдвинется у КАЖДОЙ учётки панели, включая тех, кто ушёл, ' +
    'не заплатил и был отключён намеренно.',
};

/**
 * ЧТО ОТВЕЧАЮТ, КОГДА МЕНЯТЬ НЕЧЕГО.
 *
 * Каркас на пустой diff отвечает «план ничего не меняет, объявите
 * allowEmptyDiff» — формулировка верная и бесполезная: оператор спрашивал не
 * про устройство каркаса. Пустота здесь всегда означает конкретную вещь, и
 * сказать надо именно её, потому что следующий шаг у оператора разный: у
 * нулевых счётчиков — никакой, у совпавших значений — проверить, тот ли это
 * набор.
 */
const NOTHING_TO_DO: Record<Action, string> = {
  update:
    'у всех клиентов набора названные поля уже равны тому, что вы ставите — менять нечего. ' +
    'Если ожидалось другое, скорее всего набор не тот.',
  reset_traffic:
    'счётчики трафика у всего набора уже нулевые, и со статусом LIMITED в нём никого нет — ' +
    'обнулять нечего.',
  revoke_subscription: 'перевыпускать нечего: в наборе не осталось ни одного клиента.',
  update_squads:
    'у всех клиентов набора уже ровно этот набор сквадов — панель сняла бы их и поставила те же ' +
    'самые.',
  extend_expiration: 'продлевать нечего: в наборе не осталось ни одного клиента.',
  delete: 'удалять нечего: в наборе не осталось ни одного клиента.',
  delete_by_status: 'удалять нечего: под этот статус больше никто не подпадает.',
  all_update:
    'по всему флоту названные поля уже равны тому, что вы ставите — панель переписала бы их теми ' +
    'же значениями.',
  all_reset_traffic: 'обнулять нечего: в панели нет ни одной учётки.',
  all_extend_expiration: 'продлевать нечего: в панели нет ни одной учётки.',
};

/** Общее для всех веток: чего этот инструмент про панель НЕ обещает. */
const COMMON_EFFECTS: readonly string[] = [
  'Панель НЕ подтверждает выполнение: массовые маршруты отвечают 202/204 с пустым телом, а ' +
    'update, reset_traffic, revoke_subscription и все all_* вдобавок уходят в очередь и ' +
    'обрабатываются потом, по одному. «Применено» здесь значит «принято панелью», а не «сделано ' +
    'у всех»; проверять результат надо чтением.',
  'Число затронутых посчитано нами по панели ДО применения. Панель своего числа не возвращает ' +
    'ни на одном из этих маршрутов, поэтому сверить наше с её — нечем.',
  'Правки сделаны только в панели. Биллинг SHM о них не узнает: следующая задача провижининга по ' +
    'услуге перезапишет лимиты и срок теми значениями, которые считает верными SHM.',
  'Панель эмитит событие на каждого затронутого клиента своим подписчикам вебхуков; в этом ' +
    'развёртывании подписчик — шаблон SHM, то есть у массовой правки есть продолжение за ' +
    'пределами панели, и оно тоже массовое.',
];

function sortedIds(users: readonly FleetUser[]): number[] {
  return users.map((user) => user.id).sort((left, right) => left - right);
}

function statusesOf(users: readonly FleetUser[]): string[] {
  return users
    .map((user) => `${String(user.id)}:${user.status ?? 'null'}`)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Сводка по значению поля у набора. Показывается там, где «до» — это N разных
 * значений, а «после» — одно: диапазон дат, набор лимитов, список сквадов.
 * Обрезается по трём, потому что оператору нужен ХАРАКТЕР расхождения
 * («все одинаковые» против «все разные»), а не перечисление сотни чисел, — и
 * потому что снимок уезжает на диск целиком.
 */
function summarize(values: readonly unknown[]): unknown {
  const seen: string[] = [];
  for (const value of values) {
    const key = JSON.stringify(value ?? null);
    if (!seen.includes(key)) seen.push(key);
  }
  if (seen.length === 0) return null;
  if (seen.length === 1) return values[0] ?? null;
  const shown = seen.slice(0, 3).join(', ');
  return `${String(seen.length)} разных значений: ${shown}${seen.length > 3 ? ', …' : ''}`;
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
}

interface Prepared {
  before: BulkState;
  after: BulkState;
  op: Op;
  effects: string[];
  affectedUsers: number;
}

/** Ветки, требующие набора: общая часть снимка и общие отказы. */
function baseSetState(action: Action, users: readonly FleetUser[]): BulkState {
  const state: BulkState = {
    action,
    scope: 'set',
    affectedCount: users.length,
    userIds: sortedIds(users),
  };
  if (DELETE_SET.has(action)) state.targetStatuses = statusesOf(users);
  return state;
}

function fieldsFrom(i: Input, fleetWide: boolean): Fields {
  const fields: Fields = {};
  if (i.set_status !== undefined) {
    if (fleetWide) {
      // Тот же довод, что и у `expire_at` ниже, и он обязан действовать
      // одинаково: во флоте 726 ACTIVE, 376 DISABLED, 22 EXPIRED и 1 LIMITED,
      // и одно значение на всех уничтожает это распределение без источника, из
      // которого его вернуть. `status=ACTIVE` вдобавок включит 376 отключённых
      // — среди них отключённые за неуплату и за абуз, а кто за что, после
      // применения не знает уже никто.
      refuse(
        'set_status во fleet-wide обновлении запрещён этим инструментом. Одно значение статуса ' +
          'на весь флот стирает распределение статусов, а восстановить его неоткуда: снимка на ' +
          'тысячу строк в плане нет. Если нужен аварийный останов — это отключение НОД ' +
          '(node_manage), оно обратимо и не переписывает ни одной учётки. Если нужна ' +
          'выборочная блокировка — это update по названному набору, где видно, кого именно.',
      );
    }
    fields.status = i.set_status;
  }
  if (i.traffic_limit_bytes !== undefined) fields.trafficLimitBytes = i.traffic_limit_bytes;
  if (i.traffic_limit_strategy !== undefined) {
    fields.trafficLimitStrategy = i.traffic_limit_strategy;
  }
  if (i.hwid_device_limit !== undefined) fields.hwidDeviceLimit = i.hwid_device_limit;
  if (i.expire_at !== undefined) {
    if (fleetWide) {
      refuse(
        'expire_at во fleet-wide обновлении запрещён этим инструментом. Одна дата на весь флот ' +
          'уничтожает 1000+ разных дат окончания, и источника, из которого их вернуть, нет: ' +
          'снимка плана хватает на сводку, а не на тысячу строк. Для набора клиентов expire_at ' +
          'разрешён — у него в плане видны прежние даты.',
      );
    }
    fields.expireAt = i.expire_at;
  }
  if (i.tag !== undefined) {
    if (fleetWide) {
      refuse('tag во fleet-wide обновлении бессмыслен: метка, стоящая у всех, не выделяет никого.');
    }
    fields.tag = i.tag;
  }
  return fields;
}

function checkExpireAt(raw: string | undefined, now: Date): void {
  if (raw === undefined) return;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    refuse(`expire_at=${JSON.stringify(raw)} не разбирается как дата ISO.`);
  }
  if (parsed <= now.getTime()) {
    refuse(
      `expire_at=${raw} в прошлом — панель отвергает такую дату на валидации ` +
        '(«Expiration date cannot be in the past»). Чтобы закрыть доступ, есть set_status=DISABLED.',
    );
  }
}

function prepareSet(i: Input, action: Action, users: FleetUser[], now: Date): Prepared {
  const before = baseSetState(action, users);
  const op: Op = { action, user_ids: sortedIds(users) };
  const affectedUsers = users.length;

  switch (action) {
    case 'update': {
      const fields = fieldsFrom(i, false);
      if (Object.keys(fields).length === 0) {
        refuse(
          'update требует хотя бы одно поле: set_status, traffic_limit_bytes, ' +
            'traffic_limit_strategy, expire_at, hwid_device_limit, tag.',
        );
      }
      checkExpireAt(fields.expireAt, now);

      const after: BulkState = { ...before };
      const effects: string[] = [];
      if (fields.status !== undefined) {
        before.status = summarize(users.map((user) => user.status));
        after.status = fields.status;
        effects.push(
          fields.status === STATUS_ACTIVE
            ? 'Клиенты получат доступ немедленно — панель вернёт их на ноды. Дата окончания и ' +
              'лимиты при этом не меняются: истёкшего клиента одно это не оживит.'
            : 'Клиенты немедленно теряют доступ на ВСЕХ устройствах. Деньги не двигаются, услуги ' +
              'в биллинге остаются как были — и биллинг продолжит списывать за них.',
        );
      }
      if (fields.trafficLimitBytes !== undefined) {
        before.trafficLimitBytes = summarize(users.map((user) => user.trafficLimitBytes));
        after.trafficLimitBytes = fields.trafficLimitBytes;
        effects.push(
          'Порог уже отправленных уведомлений о трафике сбросится в ноль у каждого — ' +
            'предупреждения поедут клиентам заново.',
        );
      }
      if (fields.trafficLimitStrategy !== undefined) {
        before.trafficLimitStrategy = summarize(users.map((user) => user.trafficLimitStrategy));
        after.trafficLimitStrategy = fields.trafficLimitStrategy;
      }
      if (fields.hwidDeviceLimit !== undefined) {
        before.hwidDeviceLimit = summarize(users.map((user) => user.hwidDeviceLimit));
        after.hwidDeviceLimit = fields.hwidDeviceLimit;
        effects.push(
          'Уже привязанные устройства сверх нового лимита сами не отвяжутся — их снимает ' +
            'subscription_ops, по клиенту за раз.',
        );
      }
      if (fields.expireAt !== undefined) {
        before.expireAt = summarize(users.map((user) => user.expireAt));
        after.expireAt = fields.expireAt;
        effects.push(
          'Это ОДНА дата на всех: индивидуальные сроки затрутся. Прежние значения видны в ' +
            'снимке «до» этого плана и больше нигде.',
        );
      }
      if (fields.tag !== undefined) {
        before.tag = summarize(users.map((user) => user.tag));
        after.tag = fields.tag;
      }
      return { before, after, op: { ...op, fields }, effects, affectedUsers };
    }

    case 'reset_traffic': {
      const used = sum(users.map((user) => user.usedTrafficBytes));
      before.usedTrafficBytes = used;
      const limited = users.filter((user) => user.status === 'LIMITED');
      // Статус в снимке лежит РЯДОМ со счётчиком, потому что сброс меняет и
      // его: у набора с нулевыми счётчиками и клиентом в LIMITED работа всё
      // равно есть — панель вернёт его на ноды. Без этой пары diff оказался бы
      // пустым, и план отбился бы как «менять нечего», хотя менять есть что.
      before.limitedCount = limited.length;
      return {
        before,
        after: { ...before, usedTrafficBytes: 0, limitedCount: 0 },
        op,
        affectedUsers,
        effects: [
          `Обнулится ${String(used)} байт суммарно по набору. Лимиты трафика и даты окончания не ` +
            'меняются.',
          limited.length === 0
            ? 'Со статусом LIMITED в наборе никого нет — доступ ни у кого не изменится.'
            : `${String(limited.length)} клиент(ов) со статусом LIMITED станут ACTIVE и вернутся ` +
              'на ноды: панель делает это сама при сбросе трафика.',
        ],
      };
    }

    case 'revoke_subscription': {
      before.subscriptionsRevoked = 0;
      return {
        before,
        after: { ...before, subscriptionsRevoked: affectedUsers },
        op,
        affectedUsers,
        effects: [
          'Панель выпустит новые shortUuid, trojanPassword, vlessUuid и ssPassword КАЖДОМУ из ' +
            'набора. Все их старые ссылки и конфиги умрут одновременно — это выглядит как ' +
            'массовая авария и вызовет столько же обращений в поддержку.',
          'Новые ссылки инструмент не выдаёт и выдать не может: редакция ответов маскирует ссылку ' +
            'подписки на выходе любого инструмента. Забирать их надо в панели.',
        ],
      };
    }

    case 'update_squads': {
      if (i.squad_uuids === undefined) {
        refuse(
          'update_squads требует squad_uuids. Какие сквады есть и кто в них состоит, показывает ' +
            'squads_read.',
        );
      }
      const wanted = [...i.squad_uuids].sort((left, right) => left.localeCompare(right));
      before.squadUuids = summarize(users.map((user) => user.squadUuids));
      const effects = [
        'Панель СНИМАЕТ все прежние сквады и ставит названные — это замена набора, а не ' +
          'добавление к нему.',
      ];
      if (wanted.length === 0) {
        effects.push(
          'Список пуст: клиенты останутся БЕЗ единого сквада, то есть без доступа ко всем ' +
            'серверам разом. Если это не то, что задумано, — назовите сквады.',
        );
      }
      return {
        before,
        after: { ...before, squadUuids: wanted },
        op: { ...op, squad_uuids: wanted },
        effects,
        affectedUsers,
      };
    }

    case 'extend_expiration': {
      if (i.extend_days === undefined) refuse('extend_expiration требует extend_days.');
      const days = i.extend_days;
      before.expireAt = summarize(users.map((user) => user.expireAt));
      // Кто останется в прошлом даже после прибавки. Считается ровно по той
      // формуле, которой пользуется панель, — `expire_at + N дней`, без
      // подмешивания «сейчас»: в этом и состоит отличие массового продления от
      // точечного, и молча его сгладить значило бы соврать в предсказании.
      const stale = users.filter((user) => {
        const at = user.expireAt === null ? Number.NaN : Date.parse(user.expireAt);
        return Number.isFinite(at) && at + days * 86_400_000 <= now.getTime();
      });
      const effects = [
        `Панель прибавит ${String(days)} дн. К НЫНЕШНЕЙ дате каждого ` +
          '(SQL `expire_at + interval`), а НЕ к «сейчас». Это отличается от точечного ' +
          'subscription_ops extend, который считает max(сейчас, expireAt) + дни.',
      ];
      effects.push(
        stale.length === 0
          ? 'Всем из набора новая дата придётся в будущее — истёкшие станут ACTIVE и вернутся на ' +
            'ноды (панель делает это сама вторым запросом).'
          : `У ${String(stale.length)} клиент(ов) новая дата всё равно останется в прошлом: они ` +
            'истекли давно, и такое продление им доступа не вернёт. Для них нужна абсолютная ' +
            'дата — update с expire_at.',
      );
      return {
        before,
        after: { ...before, expireAt: `+${String(i.extend_days)} дн. к дате каждого` },
        op: { ...op, extend_days: i.extend_days },
        effects,
        affectedUsers,
      };
    }

    case 'delete':
    case 'delete_by_status': {
      const active = users.filter((user) => user.status === STATUS_ACTIVE);
      if (active.length > 0) {
        refuse(
          `в наборе ${String(active.length)} клиент(ов) со статусом ACTIVE (id ` +
            `${active
              .slice(0, 10)
              .map((user) => String(user.id))
              .join(', ')}${active.length > 10 ? ', …' : ''}). ACTIVE — это оплаченный и ` +
            'подключённый прямо сейчас клиент, и удаление уносит его ключи и подписку без ' +
            'восстановления. Сначала отключите (update с set_status=DISABLED или subscription_ops ' +
            'disable): на этом шаге ещё можно передумать, после удаления — уже нет.',
        );
      }
      before.usersInPanel = affectedUsers;
      return {
        before,
        after: { ...before, usersInPanel: 0 },
        op,
        affectedUsers,
        effects: [
          `Будет удалено ${String(affectedUsers)} учёток вместе с ключами, подписками и историей ` +
            'обращений. Клиенты снимаются со всех нод.',
          'Услуги этих клиентов в биллинге SHM НЕ удаляются и продолжают жить своей жизнью: ' +
            'следующая задача провижининга не найдёт пользователя в панели и упадёт. Это ровно та ' +
            'поломка, которую потом показывает sync_audit.',
        ],
      };
    }

    default:
      return refuse(`действие ${action} не работает по набору клиентов.`);
  }
}

function prepareFleet(i: Input, action: Action, total: number, now: Date): Prepared {
  const before: BulkState = { action, scope: 'fleet', affectedCount: total, fleetTotal: total };
  const op: Op = { action };

  switch (action) {
    case 'all_update': {
      const fields = fieldsFrom(i, true);
      if (Object.keys(fields).length === 0) {
        refuse(
          'all_update требует хотя бы одно поле: traffic_limit_bytes, traffic_limit_strategy, ' +
            'hwid_device_limit. Статус и дату окончания по всему флоту этот инструмент не ' +
            'правит — их прежние значения после такой записи не восстановить ниоткуда.',
        );
      }
      checkExpireAt(fields.expireAt, now);
      // «Было» у всего флота в снимок не помещается — и молчать об этом нельзя:
      // diff без левой стороны читается как «поле было пустым», а оно было
      // тысячей разных значений, которых после применения не останется нигде.
      for (const key of Object.keys(fields)) {
        before[key] = `нынешние значения всех ${String(total)} клиентов (в снимок не помещаются)`;
      }
      const after: BulkState = { ...before, ...fields };
      const effects: string[] = [
        `Поля будут перезаписаны у КАЖДОЙ из ${String(total)} учёток панели, включая тех, кого ` +
          'отключили намеренно, и тех, кто ушёл год назад. Снимка прежних значений нет — в плане ' +
          'сводка, а не тысяча строк.',
      ];
      // Ветки про `status` здесь нет и быть не может: `fieldsFrom` отбивает
      // его для всего флота раньше — см. отказ там.
      if (fields.trafficLimitBytes !== undefined) {
        effects.push(
          'Порог уведомлений о трафике сбросится в ноль у всех — предупреждения поедут заново ' +
            'всему флоту.',
        );
      }
      return { before, after, op: { ...op, fields }, effects, affectedUsers: total };
    }

    case 'all_reset_traffic': {
      return {
        before: { ...before, usedTrafficBytes: 'счётчики всех клиентов' },
        after: { ...before, usedTrafficBytes: 0 },
        op,
        affectedUsers: total,
        effects: [
          `Счётчики обнулятся у КАЖДОЙ из ${String(total)} учёток. Все, кто был LIMITED, станут ` +
            'ACTIVE и вернутся на ноды — включая тех, кого лимит держал намеренно.',
          'Тело у этого запроса не передаётся вовсе: у ручки нет схемы тела, сузить её нечем.',
        ],
      };
    }

    case 'all_extend_expiration': {
      if (i.extend_days === undefined) refuse('all_extend_expiration требует extend_days.');
      return {
        before: { ...before, expireAt: 'нынешние даты всех клиентов' },
        after: { ...before, expireAt: `+${String(i.extend_days)} дн. к дате каждого` },
        op: { ...op, extend_days: i.extend_days },
        affectedUsers: total,
        effects: [
          `Срок сдвинется на ${String(i.extend_days)} дн. у КАЖДОЙ из ${String(total)} учёток — ` +
            'это подарок сервиса всем сразу, включая неплательщиков и отключённых за абуз.',
          'Прибавление идёт к НЫНЕШНЕЙ дате каждого (SQL `expire_at + interval`), а не к «сейчас»: ' +
            'давно истёкшим клиентам доступ так не вернётся, а недавним — вернётся.',
        ],
      };
    }

    default:
      return refuse(`действие ${action} не работает по всему флоту.`);
  }
}

/**
 * Вторая линия к `profiles: ['human']`. Каркас отвергает массовый инструмент,
 * доступный боту, ещё при сборке реестра, а реестр не показывает его боту
 * вовсе, — но резолв по имени в обход `listVisibleTools` однажды появится, и
 * тогда единственной защитой останется эта.
 */
function assertHuman(ctx: ToolContext): void {
  if (ctx.profile !== 'human') {
    refuse(
      'массовые операции доступны только человеку. Бот не видит ни одного из тех, кого задел бы ' +
        'этот вызов, и подтвердить их состав ему нечем.',
    );
  }
}

/**
 * Читает то же самое, что читал план, и тем же способом (§7.4).
 *
 * У действий по набору перечитываются РОВНО те id, что лежат в плане, а не
 * условие, по которому набор собирали. Для `delete_by_status` это и есть вся
 * разница с запрещённой ручкой панели: истёкшие после планирования клиенты в
 * набор не попадут, потому что набор давно зафиксирован поимённо.
 */
async function readWorld(ctx: ToolContext, op: Op): Promise<BulkState> {
  if (isFleet(op.action)) {
    const total = await readFleetTotal(ctx);
    return { action: op.action, scope: 'fleet', affectedCount: total, fleetTotal: total };
  }
  if (op.user_ids === undefined) {
    refuse('снимок плана не несёт списка клиентов — применять его нельзя, постройте план заново.');
  }
  const { found } = await resolveUserIds(ctx, op.user_ids);
  return baseSetState(op.action, found);
}

const guard: PlanGuard = {
  keys: GUARD_KEYS,
  read: async (plan, ctx) => {
    const parsed = opSchema.safeParse(asRecord(plan.after).op);
    if (!parsed.success) {
      refuse(
        'снимок плана не несёт разрешённой операции — применять его нельзя, постройте план заново.',
      );
    }
    assertHuman(ctx);
    return readWorld(ctx, parsed.data);
  },
};

export function bulkOps(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'bulk_ops',
      description:
        'Массовые операции над клиентами панели Remnawave. По названному набору id: update, ' +
        'reset_traffic, revoke_subscription, update_squads, extend_expiration, delete, а также ' +
        'delete_by_status (перечисляет попавших под статус поимённо и удаляет ровно их). По ВСЕМУ ' +
        'флоту, без списка: all_update, all_reset_traffic, all_extend_expiration. План ОБЯЗАН ' +
        'установить у панели точное число затронутых клиентов и отказывается строиться без него; ' +
        'выше потолка HQ_MCP_MAX_BULK_USERS операция отвергается целиком, а не усекается. ' +
        'Операции необратимы, панель не подтверждает их выполнение (202/204 с пустым телом, часть ' +
        'уходит в очередь), и правки не переносятся в биллинг SHM. Только для человека. Без ' +
        'plan_id возвращает план и ничего не меняет.',
      input,
      risk: 'high',
      // Только человек, и это проверяется в трёх местах: здесь, каркасом при
      // сборке (массовая ручка + не-human профиль = отказ) и `assertHuman` на
      // каждом вызове. Три раза — потому что цена промаха тут не один клиент.
      profiles: ['human'],
      endpoints: [
        'GET /api/users',
        'POST /api/users/bulk/update',
        'POST /api/users/bulk/reset-traffic',
        'POST /api/users/bulk/revoke-subscription',
        'POST /api/users/bulk/update-squads',
        'POST /api/users/bulk/extend-expiration-date',
        'POST /api/users/bulk/delete',
        'POST /api/users/bulk/all/update',
        'POST /api/users/bulk/all/reset-traffic',
        'POST /api/users/bulk/all/extend-expiration-date',
      ],
      guard,
      target: (i) => ({
        system: 'remna',
        id: i.user_ids === undefined ? i.action : `${i.action}:${i.user_ids.join(',')}`,
      }),

      plan: async (i, ctx): Promise<PlanDraft> => {
        assertHuman(ctx);
        const now = ctx.now();
        const cap = deps.limits.maxBulkUsers;

        let prepared: Prepared;
        if (isFleet(i.action)) {
          if (i.user_ids !== undefined) {
            refuse(
              `${i.action} применяется ко ВСЕМУ флоту и списка не принимает. Список сузил бы ` +
                'радиус, а ручка его не читает — приняв его молча, инструмент соврал бы про ' +
                'радиус поражения. Для набора есть действия без префикса all_.',
            );
          }
          prepared = prepareFleet(i, i.action, await readFleetTotal(ctx), now);
        } else if (i.action === 'delete_by_status') {
          if (i.status === undefined) {
            refuse('delete_by_status требует status: ACTIVE, DISABLED, LIMITED или EXPIRED.');
          }
          if (i.user_ids !== undefined) {
            refuse('delete_by_status берёт набор из статуса; user_ids здесь лишний.');
          }
          // Читаем с запасом ОДНОЙ строки сверх потолка: этого достаточно,
          // чтобы каркас отверг план по числу, и не нужно вычитывать всех 376
          // DISABLED, чтобы сказать «это больше сотни».
          const { users, total } = await readFleet(ctx, `статус ${i.status}`, {
            cap: cap + 1,
            filters: [{ id: 'status', value: i.status }],
          });
          if (total > cap) {
            // Отказ строится по `total` панели, а не по длине прочитанного:
            // обход мы оборвали намеренно, и длина здесь меньше правды.
            refuse(
              `под статус ${i.status} подпадает ${String(total)} клиент(ов), а потолок ` +
                `HQ_MCP_MAX_BULK_USERS=${String(cap)}. Статус — это не список людей: столько их ` +
                'оказалось на самом деле. Сузьте набор явными user_ids или поднимите потолок ' +
                'осознанно.',
            );
          }
          if (users.length === 0) {
            refuse(`со статусом ${i.status} в панели никого нет — удалять некого.`);
          }
          prepared = prepareSet(i, 'delete_by_status', users, now);
        } else {
          if (i.user_ids === undefined) {
            refuse(`${i.action} требует user_ids — числовые id клиентов панели.`);
          }
          const { found, missing } = await resolveUserIds(ctx, i.user_ids);
          if (missing.length > 0) {
            // Панель молча выбрасывает незнакомые id (`getUsersByUserIds`,
            // `validateUserIds`), то есть оператор, назвавший сто и задевший
            // девяносто пять, не узнал бы об этом никогда. Отказ, а не тихая
            // поправка счётчика: расхождение списка с панелью почти всегда
            // значит, что список собран не про тех.
            refuse(
              `в панели нет клиентов с id ${missing
                .slice(0, 20)
                .map((id) => String(id))
                .join(', ')}${missing.length > 20 ? ', …' : ''} (${String(
                missing.length,
              )} из ${String(i.user_ids.length)}). Панель такие id проглатывает молча, и число ` +
                'затронутых разошлось бы с тем, что вы назвали. Уберите лишние id или проверьте ' +
                'их через client_resolve.',
            );
          }
          prepared = prepareSet(i, i.action, found, now);
        }

        const diff = buildDiff(prepared.before, prepared.after, ctx.profile);
        // Пустой diff отбивается ЗДЕСЬ, до каркаса, потому что причина у него
        // всегда конкретная, а каркас знает только про пустоту вообще.
        if (diff.length === 0) refuse(NOTHING_TO_DO[i.action]);

        return {
          before: prepared.before,
          // `op` лежит рядом с предсказанным состоянием: применению нужны
          // действие и его параметры, оператору — «что станет». В diff `op` не
          // попадает, он посчитан по паре состояний.
          after: { ...prepared.after, op: prepared.op },
          diff,
          // ПЕРВОЙ СТРОКОЙ — необратимость. Не сноской в конце списка: строку,
          // стоящую девятой, читают после того, как решение уже принято.
          sideEffects: [IRREVERSIBLE[i.action], ...prepared.effects, ...COMMON_EFFECTS],
          affectedUsers: prepared.affectedUsers,
        };
      },

      apply: async (plan, ctx) => {
        assertHuman(ctx);
        // План приезжает С ДИСКА, и подписи у снимка нет. Всё, что уходит в
        // панель, перепроверяется теми же схемами, что и вход: действие —
        // закрытым enum, список id — положительными целыми с потолком панели,
        // поля обновления — strictObject с шестью разрешёнными именами.
        const parsed = opSchema.safeParse(asRecord(plan.after).op);
        if (!parsed.success) {
          refuse(
            'снимок плана не несёт разрешённой операции — применять его нельзя. Постройте план ' +
              'заново.',
          );
        }
        const op = parsed.data;
        const ids = op.user_ids;

        const needIds = (): number[] => {
          if (ids === undefined || ids.length === 0) {
            refuse(`в плане ${op.action} нет списка клиентов — постройте план заново.`);
          }
          return ids;
        };
        const needDays = (): number => {
          if (op.extend_days === undefined) {
            refuse(`в плане ${op.action} нет extend_days — постройте план заново.`);
          }
          return op.extend_days;
        };

        switch (op.action) {
          case 'update': {
            if (op.fields === undefined || Object.keys(op.fields).length === 0) {
              refuse('в плане update нет ни одного поля — постройте план заново.');
            }
            await ctx.remna.send<unknown>('POST', BULK_PATH.update, {
              userIds: needIds(),
              fields: op.fields,
            });
            return { action: op.action, users: ids?.length ?? 0, fields: op.fields, ...accepted() };
          }

          case 'reset_traffic': {
            await ctx.remna.send<unknown>('POST', BULK_PATH.reset_traffic, { userIds: needIds() });
            return { action: op.action, users: ids?.length ?? 0, ...accepted() };
          }

          case 'revoke_subscription': {
            await ctx.remna.send<unknown>('POST', BULK_PATH.revoke_subscription, {
              userIds: needIds(),
            });
            return {
              action: op.action,
              users: ids?.length ?? 0,
              ...accepted(),
              note:
                'Подписки перевыпущены. Новые ссылки не выдаются ни этому, ни любому другому ' +
                'профилю: забирайте их в панели и доставляйте клиентам — рассылки в системе нет.',
            };
          }

          case 'update_squads': {
            if (op.squad_uuids === undefined) {
              refuse('в плане update_squads нет squad_uuids — постройте план заново.');
            }
            await ctx.remna.send<unknown>('POST', BULK_PATH.update_squads, {
              userIds: needIds(),
              activeInternalSquads: op.squad_uuids,
            });
            return {
              action: op.action,
              users: ids?.length ?? 0,
              squads: op.squad_uuids.length,
              ...accepted(),
            };
          }

          case 'extend_expiration': {
            await ctx.remna.send<unknown>('POST', BULK_PATH.extend_expiration, {
              userIds: needIds(),
              extendDays: needDays(),
            });
            return {
              action: op.action,
              users: ids?.length ?? 0,
              extendDays: op.extend_days,
              ...accepted(),
            };
          }

          // Обе ветки удаления идут в ОДНУ ручку со списком id, и это главное
          // решение этого инструмента: `bulk/delete-by-status` запрещена (§8),
          // потому что удаляет тех, кто подпадёт под статус в момент работы
          // очереди, а не тех, кого показали оператору.
          case 'delete':
          case 'delete_by_status': {
            await ctx.remna.send<unknown>('POST', BULK_PATH.delete, { userIds: needIds() });
            return { action: op.action, deleted: ids?.length ?? 0, ...accepted() };
          }

          case 'all_update': {
            if (op.fields === undefined || Object.keys(op.fields).length === 0) {
              refuse('в плане all_update нет ни одного поля — постройте план заново.');
            }
            // У fleet-wide обновления поля лежат в КОРНЕ тела, а не в `fields`:
            // BulkAllUpdateUsersCommand — это плоская схема, в отличие от
            // BulkUpdateUsersCommand со вложенным `fields`. Перепутать их —
            // получить 200 и ноль изменений.
            await ctx.remna.send<unknown>('POST', BULK_PATH.all_update, { ...op.fields });
            return { action: op.action, fields: op.fields, ...accepted() };
          }

          case 'all_reset_traffic': {
            // Тела нет: у ручки не объявлено RequestBodySchema вовсе.
            await ctx.remna.send<unknown>('POST', BULK_PATH.all_reset_traffic);
            return { action: op.action, ...accepted() };
          }

          case 'all_extend_expiration': {
            await ctx.remna.send<unknown>('POST', BULK_PATH.all_extend_expiration, {
              extendDays: needDays(),
            });
            return { action: op.action, extendDays: op.extend_days, ...accepted() };
          }
        }
      },
    },
    deps,
  );
}

/**
 * Что можно честно сказать об исходе. Панель отвечает 202/204 с пустым телом, а
 * половина маршрутов вдобавок работает через очередь, — поэтому «выполнено» тут
 * не говорит никто, и поле называется так, как есть на самом деле.
 */
function accepted(): { accepted: true; confirmed: false; note_panel: string } {
  return {
    accepted: true,
    confirmed: false,
    note_panel:
      'Панель приняла запрос и вернула пустое тело (202/204). Сколько клиентов реально изменилось, ' +
      'она не сообщает; часть маршрутов выполняется очередью уже после ответа. Проверяйте ' +
      'результат чтением, а НЕ повторным применением.',
  };
}
