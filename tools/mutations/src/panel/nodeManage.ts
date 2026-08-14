import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool, PlanDraft, PlanGuard } from '../kit.js';

/**
 * НОДЫ: ДЕЙСТВИЯ ПО ОДНОЙ, СОЗДАНИЕ И ПРАВКА. СВЕРЕНО С КОНТРАКТОМ 3.2.3 И
 * ИСХОДНИКАМИ `nodes.service.ts`.
 *
 * АДРЕСАЦИЯ РАЗНАЯ У РАЗНЫХ МЕХАНИЗМОВ, И ЭТО НЕ СТИЛЬ:
 *  - действия — uuid в ПУТИ: `/api/nodes/{uuid}/actions/{enable,disable,restart,reset-traffic}`;
 *  - правка — uuid в ТЕЛЕ `PATCH /api/nodes` (`NODES_ROUTES.UPDATE` — пустая строка);
 *  - создание — `POST /api/nodes` без uuid вовсе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ:
 *  - `restart-all` и `reorder`. Радиус — весь парк, отката нет, а `reorder`
 *    меняет объект по умолчанию для каждого клиента. Оба запрещены реестром
 *    (`FORBIDDEN_RULES`), поэтому объявить их в `endpoints` физически нельзя:
 *    `assertEndpoints` уронил бы сборку рантайма при старте процесса.
 *  - `bulk-actions` по той же причине.
 *  - удаление ноды. Снос ноды уносит её статистику и связи; отдельного
 *    инструмента она стоит больше, чем ветки в этом.
 *
 * ПРО КЛЮЧИ. Создание ноды НЕ требует читать `/api/keygen`:
 * `CreateNodeCommand.RequestBodySchema` не содержит ни одного поля с ключевым
 * материалом — нужны имя, адрес и профиль с инбаундами. Сертификат из
 * `/api/keygen` потребляет remnanode НА САМОЙ КОРОБКЕ (переменная окружения при
 * установке), а не этот вызов. Поэтому create реализован, а `/api/keygen`
 * остаётся запрещённым реестром на любом методе: приватный ключ не должен
 * попадать в контекст модели ни ради какой задачи.
 */
const ACTIONS = ['enable', 'disable', 'restart', 'reset_traffic', 'update', 'create'] as const;

const actionEnum = z.enum(ACTIONS);

type Action = z.infer<typeof actionEnum>;

const NODES_PATH = '/api/nodes';

/**
 * Путь на каждое действие — целым литералом на ветку, подставляется только
 * uuid (перепроверенный схемой прямо перед подстановкой). Сегмент действия из
 * переменной не собирается: такая склейка означала бы произвольную запись.
 */
const NODE_ACTION_PATH = {
  enable: (uuid: string): string => `/api/nodes/${uuid}/actions/enable`,
  disable: (uuid: string): string => `/api/nodes/${uuid}/actions/disable`,
  restart: (uuid: string): string => `/api/nodes/${uuid}/actions/restart`,
  reset_traffic: (uuid: string): string => `/api/nodes/${uuid}/actions/reset-traffic`,
} as const;

const tagsSchema = z
  .array(
    z
      .string()
      .max(36)
      .regex(/^[A-Z0-9_:]+$/, 'Тег панели — только заглавные, цифры, подчёркивание и двоеточие'),
  )
  .max(10);

const input = z.object({
  action: actionEnum.describe(
    'enable/disable — вернуть ноду в строй или снять с неё всех клиентов; restart — ' +
      'перезапустить xray на ноде; reset_traffic — обнулить счётчик трафика САМОЙ ноды; ' +
      'update — правка параметров; create — завести новую ноду в панели.',
  ),
  uuid: z
    .string()
    .uuid()
    .optional()
    .describe('uuid ноды. Обязателен для всего, кроме create. Список нод показывает infra_map.'),
  force_restart: z
    .boolean()
    .optional()
    .describe(
      'Только для restart. false — мягкий рестарт, true — принудительный. Панель требует это ' +
        'поле в теле явно, умолчания у него нет.',
    ),
  name: z.string().min(3).max(30).optional(),
  address: z.string().min(2).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  country_code: z.string().length(2).optional().describe('ISO-код страны, напр. DE. Панель приводит к верхнему регистру.'),
  note: z.string().max(255).nullable().optional(),
  tags: tagsSchema.optional(),
  is_traffic_tracking_active: z.boolean().optional(),
  traffic_limit_bytes: z.number().int().min(0).optional().describe('0 — без лимита.'),
  notify_percent: z.number().int().min(0).max(100).optional(),
  traffic_reset_day: z.number().int().min(1).max(31).optional(),
  consumption_multiplier: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Множитель списания трафика клиентам на этой ноде. Меняет счёт КАЖДОМУ на ней.'),
  node_consumption_multiplier: z.number().min(0).max(100).optional(),
  config_profile_uuid: z.string().uuid().optional().describe('Только для create: профиль конфигурации ноды.'),
  active_inbound_uuids: z
    .array(z.string().uuid())
    .min(1)
    .optional()
    .describe(
      'Только для create: какие инбаунды профиля нода поднимает. Пустым быть не может — ' +
        'ноду без инбаундов панель молча выключает при первом же enable.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/** Тело PATCH /api/nodes — закрытый список. План приезжает с диска. */
const patchSchema = z.strictObject({
  uuid: z.string().uuid(),
  name: z.string().min(3).max(30).optional(),
  address: z.string().min(2).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  countryCode: z.string().length(2).optional(),
  note: z.string().max(255).nullable().optional(),
  tags: tagsSchema.optional(),
  isTrafficTrackingActive: z.boolean().optional(),
  trafficLimitBytes: z.number().int().min(0).optional(),
  notifyPercent: z.number().int().min(0).max(100).optional(),
  trafficResetDay: z.number().int().min(1).max(31).optional(),
  consumptionMultiplier: z.number().min(0).max(100).optional(),
  nodeConsumptionMultiplier: z.number().min(0).max(100).optional(),
});

/** Тело POST /api/nodes — тоже закрытый список. Ключевого материала здесь нет. */
const createSchema = z.strictObject({
  name: z.string().min(3).max(30),
  address: z.string().min(2),
  port: z.number().int().min(1).max(65535).optional(),
  countryCode: z.string().length(2),
  note: z.string().max(255).optional(),
  tags: tagsSchema.optional(),
  configProfile: z.object({
    activeConfigProfileUuid: z.string().uuid(),
    activeInbounds: z.array(z.string().uuid()).min(1),
  }),
});

const opSchema = z.object({
  action: actionEnum,
  uuid: z.string().uuid().optional(),
  forceRestart: z.boolean().optional(),
  patch: patchSchema.optional(),
  create: createSchema.optional(),
});

type Op = z.infer<typeof opSchema>;

interface NodeState extends Record<string, unknown> {
  uuid: string | null;
  name: string | null;
  address: string | null;
  port: number | null;
  countryCode: string | null;
  isDisabled: boolean | null;
  isConnected: boolean | null;
  usersOnline: number | null;
  xrayUptime: number | null;
  trafficUsedBytes: number | null;
  trafficLimitBytes: number | null;
  isTrafficTrackingActive: boolean | null;
  trafficResetDay: number | null;
  notifyPercent: number | null;
  consumptionMultiplier: number | null;
  nodeConsumptionMultiplier: number | null;
  note: string | null;
  tags: string[];
  profileUuid: string | null;
  activeInboundCount: number;
}

/**
 * Ключи сверки мира. `isConnected`, `usersOnline`, `xrayUptime` и
 * `trafficUsedBytes` сюда НЕ входят: у работающей ноды они меняются сами по себе
 * каждую секунду, и сверка по ним отвергала бы каждый второй план как чужую
 * правку. `exists` — ключ ветки create: пока ноды нет, обе стороны его дают.
 */
const GUARD_KEYS = [
  'exists',
  'isDisabled',
  'name',
  'address',
  'port',
  'countryCode',
  'trafficLimitBytes',
  'isTrafficTrackingActive',
  'trafficResetDay',
  'notifyPercent',
  'consumptionMultiplier',
  'nodeConsumptionMultiplier',
  'note',
  'tags',
  'profileUuid',
  'activeInboundCount',
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function refuse(message: string): never {
  throw new Error(`node_manage: ${message}`);
}

function nodeState(node: Record<string, unknown>): NodeState {
  const profile = asRecord(node.configProfile);
  return {
    uuid: strOrNull(node.uuid),
    name: strOrNull(node.name),
    address: strOrNull(node.address),
    port: numOrNull(node.port),
    countryCode: strOrNull(node.countryCode),
    isDisabled: boolOrNull(node.isDisabled),
    isConnected: boolOrNull(node.isConnected),
    usersOnline: numOrNull(node.usersOnline),
    xrayUptime: numOrNull(node.xrayUptime),
    trafficUsedBytes: numOrNull(node.trafficUsedBytes),
    trafficLimitBytes: numOrNull(node.trafficLimitBytes),
    isTrafficTrackingActive: boolOrNull(node.isTrafficTrackingActive),
    trafficResetDay: numOrNull(node.trafficResetDay),
    notifyPercent: numOrNull(node.notifyPercent),
    consumptionMultiplier: numOrNull(node.consumptionMultiplier),
    nodeConsumptionMultiplier: numOrNull(node.nodeConsumptionMultiplier),
    note: strOrNull(node.note),
    tags: asArray(node.tags)
      .map((one) => strOrNull(one))
      .filter((one): one is string => one !== null),
    profileUuid: strOrNull(profile.activeConfigProfileUuid ?? node.activeConfigProfileUuid),
    activeInboundCount: asArray(profile.activeInbounds).length,
  };
}

async function readNodes(ctx: ToolContext): Promise<Record<string, unknown>[]> {
  const raw = await ctx.remna.get<unknown>(NODES_PATH);
  if (Array.isArray(raw)) return raw.map(asRecord);
  const nested = asRecord(raw).nodes;
  return Array.isArray(nested) ? nested.map(asRecord) : [];
}

async function readNode(ctx: ToolContext, uuid: string): Promise<Record<string, unknown>> {
  const nodes = await readNodes(ctx);
  const node = nodes.find((one) => one.uuid === uuid);
  if (node === undefined) {
    refuse(
      `ноды ${uuid} в панели нет (панель вернула ${String(nodes.length)} нод). Список нод с их ` +
        'uuid показывает infra_map.',
    );
  }
  return node;
}

const guard: PlanGuard = {
  keys: GUARD_KEYS,
  read: async (plan, ctx) => {
    const parsed = opSchema.safeParse(asRecord(plan.after).op);
    if (!parsed.success) {
      refuse('снимок плана не несёт разрешённой операции — постройте план заново.');
    }
    const op = parsed.data;
    if (op.action === 'create') {
      const create = op.create;
      if (create === undefined) refuse('в плане create нет тела — постройте план заново.');
      const nodes = await readNodes(ctx);
      const twin = nodes.find(
        (one) => one.name === create.name || one.address === create.address,
      );
      return { exists: twin !== undefined, name: create.name, address: create.address };
    }
    if (op.uuid === undefined) refuse('в плане нет uuid ноды — постройте план заново.');
    return nodeState(await readNode(ctx, op.uuid));
  },
};

const COMMON_EFFECTS: readonly string[] = [
  'У панели нет ни dry-run, ни ключа идемпотентности: показанное «после» — предсказание по ' +
    'снимку состояния, а не ответ бэкенда на пробный вызов.',
  'Правка сделана только в панели: биллинг SHM о ней не узнает.',
];

interface Prepared {
  after: NodeState | Record<string, unknown>;
  op: Op;
  effects: string[];
}

function usersNote(state: NodeState): string {
  const online = state.usersOnline ?? 0;
  return state.isConnected === true
    ? `Сейчас на ноде ${String(online)} подключённых клиентов — все они оборвутся.`
    : 'Нода сейчас не подключена, обрывать нечего.';
}

function patchOf(i: Input): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (i.name !== undefined) patch.name = i.name;
  if (i.address !== undefined) patch.address = i.address;
  if (i.port !== undefined) patch.port = i.port;
  if (i.country_code !== undefined) patch.countryCode = i.country_code.toUpperCase();
  if (i.note !== undefined) patch.note = i.note;
  if (i.tags !== undefined) patch.tags = i.tags;
  if (i.is_traffic_tracking_active !== undefined) {
    patch.isTrafficTrackingActive = i.is_traffic_tracking_active;
  }
  if (i.traffic_limit_bytes !== undefined) patch.trafficLimitBytes = i.traffic_limit_bytes;
  if (i.notify_percent !== undefined) patch.notifyPercent = i.notify_percent;
  if (i.traffic_reset_day !== undefined) patch.trafficResetDay = i.traffic_reset_day;
  if (i.consumption_multiplier !== undefined) patch.consumptionMultiplier = i.consumption_multiplier;
  if (i.node_consumption_multiplier !== undefined) {
    patch.nodeConsumptionMultiplier = i.node_consumption_multiplier;
  }
  return patch;
}

function prepareAction(i: Input, uuid: string, state: NodeState, fleet: NodeState[]): Prepared {
  const op: Op = { action: i.action, uuid };

  switch (i.action) {
    case 'enable': {
      if (state.isDisabled === false) {
        refuse(`нода ${state.name ?? uuid} уже включена — менять нечего.`);
      }
      /**
       * ЛОВУШКА ПАНЕЛИ, А НЕ НАША ПРИДИРКА. `enableNode` начинается с проверки
       * `!activeConfigProfileUuid || activeInbounds.length === 0` и в этом
       * случае ставит `isDisabled: TRUE` — то есть на «включить» отвечает
       * успехом и оставляет ноду выключенной. Оператор видит ok и уходит.
       */
      if (state.profileUuid === null || state.activeInboundCount === 0) {
        refuse(
          `у ноды ${state.name ?? uuid} нет активного профиля конфигурации или ни одного ` +
            'инбаунда. Панель на такое «включение» ответит успехом и ОСТАВИТ ноду выключенной ' +
            '(nodes.service.ts, enableNode). Сначала назначьте профиль и инбаунды.',
        );
      }
      return {
        op,
        after: { ...state, isDisabled: false },
        effects: [
          'Нода вернётся в строй: панель поднимет на ней xray и начнёт раздавать её клиентам, ' +
            'которым светят её инбаунды.',
        ],
      };
    }

    case 'disable': {
      if (state.isDisabled === true) {
        refuse(`нода ${state.name ?? uuid} уже выключена — менять нечего.`);
      }
      /**
       * Погасить ПОСЛЕДНЮЮ живую ноду — это выключить сервис целиком. Отказ, а
       * не предупреждение: обратно её поднимает не эта же команда, а живой
       * xray, который ещё должен подняться.
       */
      const liveOthers = fleet.filter(
        (one) => one.uuid !== uuid && one.isDisabled === false && one.isConnected === true,
      );
      if (liveOthers.length === 0) {
        refuse(
          `это последняя включённая и подключённая нода парка (всего нод ${String(fleet.length)}). ` +
            'Её выключение оставит без доступа ВСЕХ клиентов сервиса, а не только тех, кто ' +
            'сидит на ней. Если это плановые работы, гасите ноды по одной, оставляя хотя бы одну ' +
            'живой.',
        );
      }
      return {
        op,
        after: { ...state, isDisabled: true, isConnected: false, usersOnline: 0 },
        effects: [
          `Клиенты немедленно теряют эту точку входа. ${usersNote(state)} Их приложения ` +
            'переключатся на другую ноду только если она есть в их подписке.',
          `В строю останется ${String(liveOthers.length)} подключённых нод: ` +
            `${liveOthers.map((one) => one.name ?? one.uuid ?? '?').join(', ')}.`,
          'Деньги не двигаются, услуги в биллинге не меняются.',
        ],
      };
    }

    case 'restart': {
      if (i.force_restart === undefined) {
        refuse(
          'restart требует force_restart. Панель объявила это поле обязательным в теле ' +
            '(RestartNodeCommand.RequestBodySchema), умолчания у него нет.',
        );
      }
      // `restartNode` отвечает NODE_IS_DISABLED на выключенной ноде.
      if (state.isDisabled === true) {
        refuse(
          `нода ${state.name ?? uuid} выключена — панель отвечает на рестарт ошибкой ` +
            'NODE_IS_DISABLED. Сначала enable.',
        );
      }
      return {
        op: { ...op, forceRestart: i.force_restart },
        after: { ...state, xrayUptime: 0 },
        effects: [
          `Перезапускается xray на ноде. ${usersNote(state)} Клиенты переподключатся сами, но ` +
            'разрыв они увидят.',
          i.force_restart
            ? 'force_restart=true: панель перезапустит ноду принудительно, не дожидаясь мягкой ' +
              'остановки.'
            : 'force_restart=false: мягкий перезапуск.',
        ],
      };
    }

    case 'reset_traffic': {
      if ((state.trafficUsedBytes ?? 0) === 0) {
        refuse(`счётчик трафика ноды ${state.name ?? uuid} уже нулевой — обнулять нечего.`);
      }
      return {
        op,
        after: { ...state, trafficUsedBytes: 0 },
        effects: [
          'Обнуляется счётчик трафика САМОЙ НОДЫ. Трафик клиентов не трогается: их счётчики ' +
            'живут отдельно и сбрасываются subscription_ops.',
          'НЕОБРАТИМО: прежнее значение счётчика панель нигде не хранит, вернуть его нельзя.',
          state.isTrafficTrackingActive === true
            ? 'Учёт трафика на ноде включён: после обнуления лимит начнёт считаться заново, и ' +
              'уже отправленные уведомления о пороге придут повторно.'
            : 'Учёт трафика на ноде выключен, лимит и уведомления от этого не зависят.',
        ],
      };
    }

    case 'update': {
      const patch = patchOf(i);
      if (Object.keys(patch).length === 0) {
        refuse(
          'update требует хотя бы одно поле: name, address, port, country_code, note, tags, ' +
            'is_traffic_tracking_active, traffic_limit_bytes, notify_percent, traffic_reset_day, ' +
            'consumption_multiplier, node_consumption_multiplier.',
        );
      }
      const body: Record<string, unknown> = { uuid };
      // Булево — явно, тем же правилом, что у хостов. Контракт ноды сегодня
      // объявляет его `z.optional` и пропуск переживает, но правило дешевле
      // ежерелизной сверки, какое поле на этот раз обзавелось `default`.
      if (state.isTrafficTrackingActive !== null) {
        body.isTrafficTrackingActive = state.isTrafficTrackingActive;
      }
      Object.assign(body, patch);
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) {
        refuse(
          `тело PATCH не проходит собственную схему (${parsed.error.issues
            .map((one) => `${one.path.join('.')}: ${one.message}`)
            .join('; ')}).`,
        );
      }

      const effects: string[] = [];
      /**
       * `updateNode` заканчивается на `if (!node.isDisabled) startNode(...)` —
       * правка ВКЛЮЧЁННОЙ ноды перезапускает на ней xray. Переименование ноды
       * обрывает сессии ровно так же, как рестарт, и об этом в панели не
       * написано нигде.
       */
      if (state.isDisabled === false) {
        effects.push(
          `Нода включена, поэтому панель после правки ПЕРЕЗАПУСТИТ на ней xray — любое ` +
            `изменение здесь равносильно рестарту. ${usersNote(state)}`,
        );
      }
      if (patch.consumptionMultiplier !== undefined) {
        effects.push(
          'Меняется множитель списания трафика: с этого момента каждый клиент на этой ноде ' +
            'тратит свой лимит по новому курсу.',
        );
      }
      if (patch.address !== undefined) {
        effects.push(
          'Меняется адрес ноды. Панель пойдёт по новому адресу; хосты, раздающие клиентам ' +
            'старый адрес, этим не правятся — их правит host_edit.',
        );
      }
      return { op: { ...op, patch: parsed.data }, after: { ...state, ...patch }, effects };
    }

    case 'create': {
      return refuse('внутренняя ошибка ветвления: create обрабатывается отдельно.');
    }
  }
}

async function prepareCreate(i: Input, ctx: ToolContext): Promise<Prepared> {
  if (i.uuid !== undefined) {
    refuse('create не принимает uuid: его назначает панель.');
  }
  if (i.name === undefined || i.address === undefined) {
    refuse('create требует name и address.');
  }
  if (i.config_profile_uuid === undefined || i.active_inbound_uuids === undefined) {
    refuse(
      'create требует config_profile_uuid и active_inbound_uuids. Нода без профиля и инбаундов ' +
        'создастся, но первое же включение панель молча превратит в выключение.',
    );
  }

  const profilesRaw = await ctx.remna.get<unknown>('/api/config-profiles');
  const profileRows = (
    Array.isArray(profilesRaw) ? profilesRaw : asArray(asRecord(profilesRaw).configProfiles)
  ).map(asRecord);
  const profile = profileRows.find((one) => one.uuid === i.config_profile_uuid);
  if (profile === undefined) {
    refuse(
      `профиля конфигурации ${i.config_profile_uuid} в панели нет (профилей: ` +
        `${String(profileRows.length)}). Список показывает infra_map.`,
    );
  }
  const known = new Set(
    asArray(profile.inbounds)
      .map(asRecord)
      .map((one) => strOrNull(one.uuid))
      .filter((one): one is string => one !== null),
  );
  const strangers = i.active_inbound_uuids.filter((uuid) => !known.has(uuid));
  if (strangers.length > 0) {
    refuse(
      `инбаунд(ы) ${strangers.join(', ')} не принадлежат профилю ${i.config_profile_uuid}. ` +
        'Панель отвечает на это CONFIG_PROFILE_INBOUND_NOT_FOUND_IN_SPECIFIED_PROFILE.',
    );
  }

  const nodes = await readNodes(ctx);
  const twin = nodes.find((one) => one.name === i.name || one.address === i.address);
  if (twin !== undefined) {
    refuse(
      `нода с таким именем или адресом уже есть (${String(twin.name)} / ${String(twin.address)}, ` +
        `uuid ${String(twin.uuid)}). Панель держит на них уникальный индекс.`,
    );
  }

  const body: Record<string, unknown> = {
    name: i.name,
    address: i.address,
    countryCode: (i.country_code ?? 'XX').toUpperCase(),
    configProfile: {
      activeConfigProfileUuid: i.config_profile_uuid,
      activeInbounds: i.active_inbound_uuids,
    },
  };
  if (i.port !== undefined) body.port = i.port;
  if (i.tags !== undefined) body.tags = i.tags;
  if (i.note !== undefined && i.note !== null) body.note = i.note;

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    refuse(
      `тело POST не проходит собственную схему (${parsed.error.issues
        .map((one) => `${one.path.join('.')}: ${one.message}`)
        .join('; ')}).`,
    );
  }

  return {
    op: { action: 'create', create: parsed.data },
    after: {
      exists: true,
      name: parsed.data.name,
      address: parsed.data.address,
      countryCode: parsed.data.countryCode,
      profileUuid: parsed.data.configProfile.activeConfigProfileUuid,
      activeInboundCount: parsed.data.configProfile.activeInbounds.length,
    },
    effects: [
      'Нода создаётся ВКЛЮЧЁННОЙ (isDisabled: false в createNode) и сразу попадает в парк.',
      'ПОДКЛЮЧИТЬСЯ ОНА НЕ СМОЖЕТ, пока на самой коробке не установлен remnanode с ' +
        'сертификатом из /api/keygen. Этот инструмент сертификат не читает и прочитать не ' +
        'может: /api/keygen запрещён реестром на любом методе — это приватный ключ, и в ' +
        'контексте модели ему делать нечего. Заберите его в панели руками.',
      'До установки нода будет висеть неподключённой; клиентам она при этом уже объявлена, ' +
        'если хост на её инбаунд существует.',
    ],
  };
}

export function nodeManage(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'node_manage',
      description:
        'Операции над ОДНОЙ нодой Remnawave: enable, disable, restart, reset_traffic, update, ' +
        'create. Действия адресуются uuid в пути, правка — uuid в теле PATCH /api/nodes, ' +
        'создание — POST /api/nodes. Отключение ноды немедленно рвёт всех её подключённых ' +
        'клиентов, а правка включённой ноды перезапускает на ней xray — план называет число ' +
        'клиентов до операции. Массовых действий здесь нет: restart-all и reorder запрещены ' +
        'реестром (радиус — весь парк, отката нет). Создание не читает /api/keygen и не может: ' +
        'сертификат ставится на самой коробке. Без plan_id возвращает план и ничего не меняет.',
      input,
      risk: 'high',
      // Только человек: одно disable снимает с сети сотни клиентов разом.
      profiles: ['human'],
      endpoints: [
        'GET /api/nodes',
        'GET /api/config-profiles',
        'POST /api/nodes',
        'PATCH /api/nodes',
        'POST /api/nodes/{uuid}/actions/enable',
        'POST /api/nodes/{uuid}/actions/disable',
        'POST /api/nodes/{uuid}/actions/restart',
        'POST /api/nodes/{uuid}/actions/reset-traffic',
      ],
      guard,
      // restart наблюдаемого состояния не меняет, если xray и так лежал:
      // пустой diff у этой ветки законен.
      allowEmptyDiff: true,
      target: (i) => (i.uuid === undefined ? undefined : { system: 'remna', id: i.uuid }),

      plan: async (i, ctx): Promise<PlanDraft> => {
        if (i.action === 'create') {
          const { after, op, effects } = await prepareCreate(i, ctx);
          const before = { exists: false, name: i.name ?? null, address: i.address ?? null };
          return {
            before,
            after: { ...after, op },
            diff: buildDiff(before, after, ctx.profile),
            sideEffects: [...effects, ...COMMON_EFFECTS],
          };
        }

        if (i.uuid === undefined) {
          refuse(`действие ${i.action} требует uuid ноды.`);
        }
        const nodes = await readNodes(ctx);
        const node = nodes.find((one) => one.uuid === i.uuid);
        if (node === undefined) {
          refuse(
            `ноды ${i.uuid} в панели нет (панель вернула ${String(nodes.length)} нод). Список ` +
              'нод с их uuid показывает infra_map.',
          );
        }
        const before = nodeState(node);
        const fleet = nodes.map(nodeState);
        const { after, op, effects } = prepareAction(i, i.uuid, before, fleet);

        return {
          before,
          after: { ...after, op },
          diff: buildDiff(before, after, ctx.profile),
          sideEffects: [...effects, ...COMMON_EFFECTS],
        };
      },

      apply: async (plan, ctx) => {
        const parsed = opSchema.safeParse(asRecord(plan.after).op);
        if (!parsed.success) {
          refuse('снимок плана не несёт разрешённой операции — постройте план заново.');
        }
        const op = parsed.data;

        switch (op.action) {
          case 'enable':
          case 'disable':
          case 'reset_traffic': {
            if (op.uuid === undefined) refuse('в плане нет uuid ноды — постройте план заново.');
            const answer = await ctx.remna.send<unknown>(
              'POST',
              NODE_ACTION_PATH[op.action](op.uuid),
            );
            return { action: op.action, uuid: op.uuid, node: nodeState(asRecord(answer)) };
          }

          case 'restart': {
            if (op.uuid === undefined) refuse('в плане нет uuid ноды — постройте план заново.');
            if (op.forceRestart === undefined) {
              refuse('в плане restart нет forceRestart — постройте план заново.');
            }
            await ctx.remna.send<unknown>('POST', NODE_ACTION_PATH.restart(op.uuid), {
              forceRestart: op.forceRestart,
            });
            return {
              action: op.action,
              uuid: op.uuid,
              forceRestart: op.forceRestart,
              note: 'Панель приняла задачу на перезапуск; xray поднимется асинхронно.',
            };
          }

          case 'update': {
            if (op.patch === undefined) refuse('в плане update нет тела — постройте план заново.');
            const answer = await ctx.remna.send<unknown>('PATCH', NODES_PATH, op.patch);
            return { action: op.action, uuid: op.patch.uuid, node: nodeState(asRecord(answer)) };
          }

          case 'create': {
            if (op.create === undefined) refuse('в плане create нет тела — постройте план заново.');
            const answer = await ctx.remna.send<unknown>('POST', NODES_PATH, op.create);
            return {
              action: op.action,
              node: nodeState(asRecord(answer)),
              note:
                'Нода заведена. Она не подключится, пока на коробке не поднят remnanode с ' +
                'сертификатом из панели — этот инструмент его не выдаёт.',
            };
          }
        }
      },
    },
    deps,
  );
}
