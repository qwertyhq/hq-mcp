import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import { defineMutation, planIdField } from './kit.js';
import type { MutationDeps, MutationTool, PlanDraft, PlanGuard } from './kit.js';

/**
 * ВОСЕМЬ ОПЕРАЦИЙ — ЭТО ТРИ РАЗНЫХ МЕХАНИЗМА, А НЕ ОДИН С ВОСЕМЬЮ ИМЕНАМИ.
 * Сверено с контрактом Remnawave 3.2.3 и подтверждено прогоном на работающей
 * панели, а не только по спецификации:
 *
 *  1. ДЕЙСТВИЯ над пользователем — POST на путь с ЧИСЛОВЫМ id:
 *     `{id}/actions/{enable,disable,reset-traffic,revoke,extend}`
 *     (libs/contract/api/controllers/users.ts, USERS_ROUTES.ACTIONS).
 *     `extend` — тоже действие, с телом `{days}`: считать дату руками и
 *     отправлять её обновлением НЕ надо, панель считает сама.
 *  2. ЛИМИТЫ — не действие. Ручки `set-limits` не существует вовсе; лимиты
 *     идут обновлением `PATCH /api/users`, где id лежит В ТЕЛЕ рядом с
 *     `trafficLimitBytes` / `trafficLimitStrategy` / `expireAt` /
 *     `hwidDeviceLimit` (UpdateUserCommand.RequestBodySchema).
 *  3. УСТРОЙСТВА — ДРУГОЙ контроллер, `hwid`: `devices/delete` (одно) и
 *     `devices/delete-all` (все), тело — `{userId, hwid?}`
 *     (libs/contract/commands/hwid/*).
 *
 * Инструмент, который делает вид, что это один механизм, ошибается ровно на
 * границах: посылает id не туда, где его ждут, и получает 400 на валидации.
 *
 * АДРЕСАЦИЯ — ЧИСЛОВОЙ `id`. Поля `uuid` у пользователя в 3.x нет вовсе
 * (UsersSchema: `id: z.number()`), а параметр пути объявлен числом. uuid,
 * поданный сюда, панель отвергает на валидации. Клиент @hq/remna уже отличает
 * 404 маршрутизатора от 404 приложения по `errorCode: A063`, поэтому «нет
 * такого клиента» здесь — это ответ панели, а не наш сбой.
 */
const ACTIONS = [
  'enable',
  'disable',
  'extend',
  'reset_traffic',
  'revoke',
  'set_limits',
  'devices_clear',
  'device_delete',
] as const;

const actionEnum = z.enum(ACTIONS);

type Action = z.infer<typeof actionEnum>;

/** RESET_PERIODS панели 3.2.3 — закрытый список, свободной строки тут нет. */
const RESET_PERIODS = ['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'] as const;

const STATUS_ACTIVE = 'ACTIVE';
const STATUS_DISABLED = 'DISABLED';
const STATUS_LIMITED = 'LIMITED';
const STATUS_EXPIRED = 'EXPIRED';

/**
 * Путь на каждое действие — целым литералом на ветку, подставляется только
 * ЧИСЛОВОЙ id (он перепроверяется схемой прямо перед подстановкой). Сегмент
 * действия из переменной не собирается: у соседнего мутатора спула такая
 * склейка означала бы произвольную запись, и правило дешевле держать общим,
 * чем вспоминать, где оно обязательно, а где «и так сойдёт».
 */
const USER_ACTION_PATH = {
  enable: (id: number): string => `/api/users/${id}/actions/enable`,
  disable: (id: number): string => `/api/users/${id}/actions/disable`,
  reset_traffic: (id: number): string => `/api/users/${id}/actions/reset-traffic`,
  revoke: (id: number): string => `/api/users/${id}/actions/revoke`,
  extend: (id: number): string => `/api/users/${id}/actions/extend`,
} as const;

const DEVICES_DELETE_PATH = '/api/hwid/devices/delete';
const DEVICES_DELETE_ALL_PATH = '/api/hwid/devices/delete-all';
const USERS_UPDATE_PATH = '/api/users';

const input = z.object({
  user_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Числовой id пользователя в панели (поле id). НЕ uuid и НЕ telegramId: поля uuid у ' +
        'пользователя в Remnawave 3.x нет вовсе.',
    ),
  action: actionEnum.describe(
    'enable/disable — включить или отключить доступ; extend — продлить на days дней; ' +
      'reset_traffic — обнулить счётчик трафика; revoke — перевыпустить подписку (старая ' +
      'ссылка перестаёт работать); set_limits — изменить лимиты и/или дату окончания ' +
      'обновлением пользователя; devices_clear / device_delete — отвязать все устройства ' +
      'или одно.',
  ),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Только для extend. Панель считает так: max(сейчас, expireAt) + days.'),
  traffic_limit_bytes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Только для set_limits. 0 — безлимит.'),
  traffic_limit_strategy: z
    .enum(RESET_PERIODS)
    .optional()
    .describe('Только для set_limits: период автосброса счётчика трафика.'),
  expire_at: z
    .string()
    .optional()
    .describe(
      'Только для set_limits: АБСОЛЮТНАЯ дата окончания в ISO. Панель отвергает дату в ' +
        'прошлом. Для относительного продления есть extend.',
    ),
  hwid_device_limit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Только для set_limits: сколько устройств разрешено. 0 — без ограничения.'),
  hwid: z.string().min(1).optional().describe('Только для device_delete: какое устройство отвязать.'),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/**
 * Тело обновления пользователя — ЗАКРЫТЫЙ список полей. `strictObject`, а не
 * `object`: план приезжает с диска, и лишний ключ в снимке иначе доехал бы до
 * `PATCH /api/users` нетронутым. Разрешено ровно то, что этот инструмент
 * обещает менять; `status`, `telegramId`, `email`, `tag`, `activeInternalSquads`
 * панель тоже принимает этой же ручкой — и здесь их нет намеренно.
 */
const patchSchema = z.strictObject({
  trafficLimitBytes: z.number().int().min(0).optional(),
  trafficLimitStrategy: z.enum(RESET_PERIODS).optional(),
  expireAt: z.string().optional(),
  hwidDeviceLimit: z.number().int().min(0).optional(),
});

type Patch = z.infer<typeof patchSchema>;

/** Всё, что применение читает из плана. Ничего сверх этого оттуда не берётся. */
const opSchema = z.object({
  action: actionEnum,
  user_id: z.number().int().positive(),
  days: z.number().int().min(1).optional(),
  hwid: z.string().min(1).optional(),
  patch: patchSchema.optional(),
});

type Op = z.infer<typeof opSchema>;

interface RemnaUser {
  id?: number;
  username?: string;
  status?: string;
  expireAt?: string | null;
  trafficLimitBytes?: number;
  trafficLimitStrategy?: string;
  hwidDeviceLimit?: number | null;
  subRevokedAt?: string | null;
  userTraffic?: { usedTrafficBytes?: number } | null;
}

interface HwidDevice {
  hwid: string;
  platform: string | null;
  deviceModel: string | null;
  updatedAt: string | null;
}

interface DevicesResponse {
  total?: number;
  devices?: Array<Record<string, unknown>>;
}

/** Снимок наблюдаемого состояния. Он же — и то, что показывают, и то, что сверяют. */
interface WatchedState {
  id: number;
  username: string | null;
  status: string | null;
  expireAt: string | null;
  trafficLimitBytes: number | null;
  trafficLimitStrategy: string | null;
  hwidDeviceLimit: number | null;
  usedTrafficBytes: number | null;
  subRevokedAt: string | null;
  deviceHwids?: string[];
  devices?: HwidDevice[];
}

/**
 * Поля, расхождение которых означает «мир уехал».
 *
 * `usedTrafficBytes` сюда НЕ входит: у подключённого клиента счётчик растёт сам
 * по себе, и сверка по нему отвергала бы каждый второй план как чужую правку.
 * `deviceHwids` — наоборот, входит: это единственный ключ, который ловит и
 * «устройств стало другое количество», и «того самого устройства больше нет»,
 * тогда как счётчик устройств пропустил бы обмен одного на другое. Для
 * операций, не касающихся устройств, ключа нет ни в снимке, ни в перечитанном
 * состоянии — сравниваются два `undefined`, то есть сверка молчит по делу.
 */
const GUARD_KEYS = [
  'status',
  'expireAt',
  'trafficLimitBytes',
  'trafficLimitStrategy',
  'hwidDeviceLimit',
  'deviceHwids',
];

const DEVICE_ACTIONS = new Set<Action>(['devices_clear', 'device_delete']);

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Чтение пользователя ЧЕРЕЗ РЕДАКТИРУЕМЫЙ канал, и это не оплошность.
 *
 * `getRaw` нужен там, где тело записи собирается из прочитанного
 * (read-merge-write): маскированный `trojanPassword`, уехавший обратно в
 * панель, уничтожает учётку клиента. Здесь такого нет ни в одной ветке:
 * `PATCH /api/users` принимает ТОЛЬКО те поля, которые названы явно, а
 * действия не принимают состояния вовсе. Значит нередактированный ответ был бы
 * лишним риском без единой выгоды — и он же уехал бы в журнал мутаций и в
 * снимок плана открытым текстом.
 */
async function readUser(ctx: ToolContext, userId: number): Promise<RemnaUser> {
  const user = await ctx.remna.get<RemnaUser | null>(`/api/users/${userId}`);
  const id = numOrNull(asRecord(user).id);
  if (user === null || user === undefined || id === null) {
    throw new Error(
      `subscription_ops: пользователя id=${userId} в панели нет (панель ответила «нет такого ` +
        'пользователя», а не отказом маршрута). Проверьте id инструментом client_resolve: ' +
        'в 3.x адресация числовая, telegramId и uuid сюда не подходят.',
    );
  }
  return user;
}

async function readDevices(ctx: ToolContext, userId: number): Promise<HwidDevice[]> {
  const answer = await ctx.remna.get<DevicesResponse | null>(`/api/hwid/devices/${userId}`);
  const raw = answer === null || answer === undefined ? undefined : answer.devices;
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map((row) => ({
      hwid: strOrNull(row.hwid) ?? '',
      platform: strOrNull(row.platform),
      deviceModel: strOrNull(row.deviceModel),
      updatedAt: strOrNull(row.updatedAt),
    }))
    .filter((device) => device.hwid !== '')
    .sort((left, right) => left.hwid.localeCompare(right.hwid));
}

function stateOf(userId: number, user: RemnaUser, devices?: HwidDevice[]): WatchedState {
  const base: WatchedState = {
    id: userId,
    username: strOrNull(user.username),
    status: strOrNull(user.status),
    expireAt: strOrNull(user.expireAt),
    trafficLimitBytes: numOrNull(user.trafficLimitBytes),
    trafficLimitStrategy: strOrNull(user.trafficLimitStrategy),
    hwidDeviceLimit: numOrNull(user.hwidDeviceLimit),
    usedTrafficBytes: numOrNull(user.userTraffic?.usedTrafficBytes),
    subRevokedAt: strOrNull(user.subRevokedAt),
  };
  if (devices === undefined) return base;
  return { ...base, deviceHwids: devices.map((device) => device.hwid), devices };
}

/**
 * Та же формула, что у панели: `base = max(now, expireAt)`, дальше `+ days`
 * (users.service.ts:471-474, `dayjs.utc`). Считается здесь ТОЛЬКО ради
 * предсказания в плане — применяет `POST …/actions/extend` с телом `{days}`,
 * и окончательную дату ставит панель.
 */
export function computeExpireAt(current: string | null | undefined, days: number, now: Date): string {
  const currentMs = current === null || current === undefined ? Number.NaN : Date.parse(current);
  const base = Number.isFinite(currentMs) && currentMs > now.getTime() ? currentMs : now.getTime();
  return new Date(base + days * 86_400_000).toISOString();
}

const MARKER_REVOKED = '<панель проставит время перевыпуска>';

/** Общее для всех веток: чего этот инструмент про панель НЕ обещает. */
const COMMON_EFFECTS: readonly string[] = [
  'У панели нет ни dry-run, ни ключа идемпотентности: показанное «после» — это предсказание по ' +
    'снимку состояния, а не ответ бэкенда на пробный вызов.',
  'Правка сделана только в панели. Биллинг SHM о ней не узнает: следующая задача провижининга ' +
    'по этой услуге перезапишет лимиты и срок теми значениями, которые считает верными SHM.',
  'Панель эмитит событие пользователя своим подписчикам вебхуков; в этом развёртывании ' +
    'подписчик — шаблон SHM, то есть у правки есть продолжение за пределами панели.',
];

function refuse(message: string): never {
  throw new Error(`subscription_ops: ${message}`);
}

interface Prepared {
  after: WatchedState;
  op: Op;
  effects: string[];
}

function prepare(i: Input, state: WatchedState, now: Date): Prepared {
  const op: Op = { action: i.action, user_id: i.user_id };

  switch (i.action) {
    case 'enable': {
      if (state.status === STATUS_ACTIVE) {
        refuse(
          `клиент ${i.user_id} уже ACTIVE — панель отвечает на это ошибкой USER_ALREADY_ENABLED, ` +
            'а не тихим успехом. Если доступа всё равно нет, причина не в статусе.',
        );
      }
      return {
        op,
        after: { ...state, status: STATUS_ACTIVE },
        effects: [
          'Клиент получит доступ немедленно: панель вернёт его на ноды. Дата окончания и лимиты ' +
            'не меняются — истёкшего клиента одно это не оживит.',
        ],
      };
    }

    case 'disable': {
      if (state.status === STATUS_DISABLED) {
        refuse(
          `клиент ${i.user_id} уже DISABLED — панель отвечает на это ошибкой ` +
            'USER_ALREADY_DISABLED.',
        );
      }
      return {
        op,
        after: { ...state, status: STATUS_DISABLED },
        effects: [
          'Клиент немедленно теряет доступ на ВСЕХ устройствах: панель снимает его с нод. ' +
            'Деньги при этом не двигаются и услуга в биллинге остаётся как была.',
        ],
      };
    }

    case 'extend': {
      if (i.days === undefined) {
        refuse('extend требует days. Абсолютную дату ставит set_limits через expire_at.');
      }
      const expireAt = computeExpireAt(state.expireAt, i.days, now);
      const effects = [
        `Панель считает дату сама: max(сейчас, expireAt) + ${i.days} дн. Показанное ` +
          `${expireAt} — предсказание по той же формуле, а не ответ панели.`,
      ];
      const after: WatchedState = { ...state, expireAt };
      if (state.status === STATUS_EXPIRED) {
        after.status = STATUS_ACTIVE;
        effects.push(
          'Клиент со статусом EXPIRED станет ACTIVE и вернётся на ноды — это делает сама ' +
            'панель, отдельного включения не нужно.',
        );
      } else if (state.status === STATUS_DISABLED || state.status === STATUS_LIMITED) {
        effects.push(
          `Статус ${state.status} панель НЕ меняет: срок продлится, а доступа у клиента как не ` +
            'было, так и не будет. Включение — это enable.',
        );
      }
      return { op: { ...op, days: i.days }, after, effects };
    }

    case 'reset_traffic': {
      if ((state.usedTrafficBytes ?? 0) === 0 && state.status !== STATUS_LIMITED) {
        refuse(
          `счётчик трафика клиента ${i.user_id} уже нулевой, и статус не LIMITED — обнулять нечего.`,
        );
      }
      const after: WatchedState = { ...state, usedTrafficBytes: 0 };
      const effects = ['Счётчик обнулится; лимит трафика и дата окончания не меняются.'];
      if (state.status === STATUS_LIMITED) {
        after.status = STATUS_ACTIVE;
        effects.push(
          'Клиент со статусом LIMITED станет ACTIVE и снова попадёт на ноды: панель делает это ' +
            'сама при сбросе трафика.',
        );
      }
      return { op, after, effects };
    }

    case 'revoke': {
      return {
        op,
        after: { ...state, subRevokedAt: MARKER_REVOKED },
        effects: [
          'Панель выпустит НОВЫЕ shortUuid, trojanPassword, vlessUuid и ssPassword. Старая ссылка ' +
            'подписки и все уже установленные конфиги перестанут работать в тот же миг.',
          'Новую ссылку этот инструмент не выдаёт и выдать не может: редакция ответов маскирует ' +
            'ссылку подписки хвостом на выходе любого инструмента. Заберите её в панели и ' +
            'доставьте клиенту сами — автоматической рассылки новой ссылки в системе нет.',
        ],
      };
    }

    case 'set_limits': {
      const patch: Patch = {};
      const after: WatchedState = { ...state };
      const effects: string[] = [];

      if (i.traffic_limit_bytes !== undefined) {
        patch.trafficLimitBytes = i.traffic_limit_bytes;
        after.trafficLimitBytes = i.traffic_limit_bytes;
        const raised =
          i.traffic_limit_bytes === 0 || i.traffic_limit_bytes > (state.trafficLimitBytes ?? 0);
        if (state.status === STATUS_LIMITED && raised) {
          after.status = STATUS_ACTIVE;
          effects.push(
            'Клиент со статусом LIMITED станет ACTIVE и вернётся на ноды: панель делает это ' +
              'сама, когда лимит поднимают или снимают.',
          );
        }
        effects.push(
          'Порог уже отправленных уведомлений о трафике сбросится в ноль — клиент получит ' +
            'предупреждения заново.',
        );
      }
      if (i.traffic_limit_strategy !== undefined) {
        patch.trafficLimitStrategy = i.traffic_limit_strategy;
        after.trafficLimitStrategy = i.traffic_limit_strategy;
      }
      if (i.hwid_device_limit !== undefined) {
        patch.hwidDeviceLimit = i.hwid_device_limit;
        after.hwidDeviceLimit = i.hwid_device_limit;
        effects.push(
          'Уже привязанные устройства сверх нового лимита сами не отвяжутся: их снимает ' +
            'device_delete / devices_clear.',
        );
      }
      if (i.expire_at !== undefined) {
        const parsed = Date.parse(i.expire_at);
        if (!Number.isFinite(parsed)) {
          refuse(`expire_at=${JSON.stringify(i.expire_at)} не разбирается как дата ISO.`);
        }
        if (parsed <= now.getTime()) {
          refuse(
            `expire_at=${i.expire_at} в прошлом — панель отвергает такую дату на валидации. ` +
              'Чтобы закрыть доступ, есть disable.',
          );
        }
        const expireAt = new Date(parsed).toISOString();
        patch.expireAt = expireAt;
        after.expireAt = expireAt;
      }

      if (Object.keys(patch).length === 0) {
        refuse(
          'set_limits требует хотя бы одно из traffic_limit_bytes, traffic_limit_strategy, ' +
            'hwid_device_limit, expire_at.',
        );
      }
      return { op: { ...op, patch }, after, effects };
    }

    case 'devices_clear': {
      const devices = state.devices ?? [];
      if (devices.length === 0) {
        refuse(`у клиента ${i.user_id} нет привязанных устройств — отвязывать нечего.`);
      }
      return {
        op,
        after: { ...state, deviceHwids: [], devices: [] },
        effects: [
          `Отвяжутся ВСЕ ${devices.length} устройств(а) разом. Клиенту придётся подключить ` +
            'каждое заново; слоты освободятся сразу.',
        ],
      };
    }

    case 'device_delete': {
      if (i.hwid === undefined) {
        refuse('device_delete требует hwid. Список устройств показывает device_history.');
      }
      const devices = state.devices ?? [];
      if (!devices.some((device) => device.hwid === i.hwid)) {
        refuse(
          `устройства ${i.hwid} у клиента ${i.user_id} сейчас нет. Привязаны: ` +
            `${devices.map((device) => device.hwid).join(', ') || '(ни одного)'}.`,
        );
      }
      const left = devices.filter((device) => device.hwid !== i.hwid);
      return {
        op: { ...op, hwid: i.hwid },
        after: { ...state, deviceHwids: left.map((device) => device.hwid), devices: left },
        effects: ['Слот освободится сразу; клиенту придётся подключить это устройство заново.'],
      };
    }
  }
}

/**
 * Сверка мира перед применением (§7.4). Читает то же самое, что читал план, и
 * тем же способом: устройства — только для операций над устройствами, иначе
 * ключ `deviceHwids` отсутствовал бы в снимке и присутствовал в перечитанном
 * состоянии, и каждый второй план отвергался бы как «мир уехал».
 */
const guard: PlanGuard = {
  keys: GUARD_KEYS,
  read: async (plan, ctx) => {
    const parsed = opSchema.safeParse(asRecord(plan.after).op);
    if (!parsed.success) {
      throw new Error(
        'subscription_ops: снимок плана не несёт разрешённой операции — применять его нельзя, ' +
          'постройте план заново.',
      );
    }
    const { action, user_id: userId } = parsed.data;
    const user = await readUser(ctx, userId);
    const devices = DEVICE_ACTIONS.has(action) ? await readDevices(ctx, userId) : undefined;
    return stateOf(userId, user, devices);
  },
};

function projectUser(value: unknown): Record<string, unknown> {
  const user = asRecord(value);
  return {
    id: numOrNull(user.id),
    status: strOrNull(user.status),
    expireAt: strOrNull(user.expireAt),
    trafficLimitBytes: numOrNull(user.trafficLimitBytes),
    trafficLimitStrategy: strOrNull(user.trafficLimitStrategy),
    hwidDeviceLimit: numOrNull(user.hwidDeviceLimit),
    subRevokedAt: strOrNull(user.subRevokedAt),
  };
}

export function subscriptionOps(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'subscription_ops',
      description:
        'Операции над подпиской клиента в панели Remnawave по ЧИСЛОВОМУ id: enable, disable, ' +
        'extend, reset_traffic, revoke, set_limits, devices_clear, device_delete. Под ними три ' +
        'разных механизма панели: действия над пользователем, обновление пользователя (лимиты и ' +
        'абсолютная дата) и отдельный контроллер устройств. extend продлевает срок и НЕ включает ' +
        'отключённого клиента — для этого есть enable. revoke перевыпускает подписку: старая ' +
        'ссылка умирает немедленно, а новую инструмент не выдаёт (редакция ответов её ' +
        'маскирует) — забирать её надо в панели. Правки в биллинг SHM не переносятся. Без ' +
        'plan_id возвращает план и ничего не меняет.',
      input,
      risk: 'high',
      // Только человек. Каждая ветка видна клиенту немедленно, а revoke и
      // disable рвут работающее подключение; отдавать это боту поддержки
      // значит отдать ему возможность отключить клиента без человека.
      profiles: ['human'],
      endpoints: [
        'GET /api/users/{userId}',
        'GET /api/hwid/devices/{userId}',
        'PATCH /api/users',
        'POST /api/users/{userId}/actions/enable',
        'POST /api/users/{userId}/actions/disable',
        'POST /api/users/{userId}/actions/reset-traffic',
        'POST /api/users/{userId}/actions/revoke',
        'POST /api/users/{userId}/actions/extend',
        'POST /api/hwid/devices/delete',
        'POST /api/hwid/devices/delete-all',
      ],
      guard,
      target: (i) => ({ system: 'remna', id: i.user_id }),

      plan: async (i, ctx): Promise<PlanDraft> => {
        const user = await readUser(ctx, i.user_id);
        const devices = DEVICE_ACTIONS.has(i.action)
          ? await readDevices(ctx, i.user_id)
          : undefined;
        const before = stateOf(i.user_id, user, devices);
        const { after, op, effects } = prepare(i, before, ctx.now());

        return {
          before,
          // `op` лежит рядом с предсказанным состоянием: применению нужны
          // действие и его параметры, оператору — «что станет». В diff `op` не
          // попадает, он посчитан по паре состояний.
          after: { ...after, op },
          diff: buildDiff(before, after, ctx.profile),
          sideEffects: [...effects, ...COMMON_EFFECTS],
        };
      },

      apply: async (plan, ctx) => {
        // План приезжает С ДИСКА, и подписи у снимка нет. Всё, что уходит в
        // панель, перепроверяется теми же схемами, что и вход: действие —
        // закрытым enum, id — положительным целым (только после этого он
        // подставляется в путь), тело обновления — strictObject с четырьмя
        // разрешёнными полями.
        const parsed = opSchema.safeParse(asRecord(plan.after).op);
        if (!parsed.success) {
          throw new Error(
            'subscription_ops: снимок плана не несёт разрешённой операции — применять его ' +
              'нельзя. Постройте план заново.',
          );
        }
        const op = parsed.data;
        const userId = op.user_id;

        switch (op.action) {
          case 'enable':
          case 'disable':
          case 'reset_traffic': {
            const user = await ctx.remna.send<unknown>('POST', USER_ACTION_PATH[op.action](userId));
            return { action: op.action, user: projectUser(user) };
          }

          case 'extend': {
            if (op.days === undefined) {
              throw new Error('subscription_ops: в плане extend нет days — постройте план заново.');
            }
            const user = await ctx.remna.send<unknown>('POST', USER_ACTION_PATH.extend(userId), {
              days: op.days,
            });
            return { action: op.action, days: op.days, user: projectUser(user) };
          }

          case 'revoke': {
            // `revokeOnlyPasswords: false` передаётся ЯВНО: без тела панель
            // ведёт себя так же, но полагаться на умолчание в операции, которая
            // рвёт клиенту доступ, не стоит.
            const user = await ctx.remna.send<unknown>('POST', USER_ACTION_PATH.revoke(userId), {
              revokeOnlyPasswords: false,
            });
            return {
              action: op.action,
              user: projectUser(user),
              // Читается нередактированным каналом ссылка или обычным —
              // безразлично: `executeTool` маскирует ответ инструмента целиком
              // на выходе. Обходить это переименованием поля (ссылка под именем
              // без слова subscription прошла бы) — значит своими руками
              // сделать дыру в §7.2, поэтому ссылки здесь нет вовсе.
              note:
                'Подписка перевыпущена. Новая ссылка не выдаётся ни этому, ни любому другому ' +
                'профилю: заберите её в панели и доставьте клиенту — рассылки новой ссылки в ' +
                'системе нет.',
            };
          }

          case 'set_limits': {
            if (op.patch === undefined || Object.keys(op.patch).length === 0) {
              throw new Error(
                'subscription_ops: в плане set_limits нет ни одного поля — постройте план заново.',
              );
            }
            // id — В ТЕЛЕ, и это не описка: обновление пользователя в 3.2.3
            // адресуется телом, а не путём.
            const user = await ctx.remna.send<unknown>('PATCH', USERS_UPDATE_PATH, {
              id: userId,
              ...op.patch,
            });
            return { action: op.action, patch: op.patch, user: projectUser(user) };
          }

          case 'devices_clear': {
            const answer = await ctx.remna.send<DevicesResponse>('POST', DEVICES_DELETE_ALL_PATH, {
              userId,
            });
            return { action: op.action, devicesLeft: answer?.total ?? 0 };
          }

          case 'device_delete': {
            if (op.hwid === undefined) {
              throw new Error('subscription_ops: в плане device_delete нет hwid — постройте план заново.');
            }
            const answer = await ctx.remna.send<DevicesResponse>('POST', DEVICES_DELETE_PATH, {
              userId,
              hwid: op.hwid,
            });
            return { action: op.action, hwid: op.hwid, devicesLeft: answer?.total ?? 0 };
          }
        }
      },
    },
    deps,
  );
}
