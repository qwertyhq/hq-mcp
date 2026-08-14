import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import { defineMutation, planIdField } from '../kit.js';
import { assertNoMaskedValues } from '../server/edit.js';
import type { MutationDeps, MutationTool, PlanDraft, PlanGuard } from '../kit.js';

/**
 * ПРАВКА ХОСТА — READ-MERGE-WRITE, И ОБЕ ЕГО ЛОВУШКИ СВЕРЕНЫ С 3.2.3.
 *
 * 1. ЧИТАТЬ ТОЛЬКО `getRaw`. Обычный `RemnaClient.get` прогоняет ответ через
 *    `redact`, а маскирование идёт ПО ИМЕНИ КЛЮЧА на любой глубине. Проверено
 *    на работающей панели: заметная часть хостов несёт
 *    `finalMask.udp[0].settings.password` — настоящий рабочий пароль UDP-плеча
 *    Hysteria2, и хостов с ним сразу несколько. Тело PATCH,
 *    собранное из редактированного снимка, отправило бы туда строку
 *    `'<redacted>'` и убило бы UDP разом на всех таких хостах — это не «утечка
 *    маски в лог», это авария у клиентов. Тот же снимок идёт в `rollback.body`:
 *    «откат» из масок доломал бы хост окончательно.
 *
 *    Поэтому здесь два независимых предохранителя: канал (`getRaw`) и
 *    `assertNoMaskedValues` на КАЖДОМ теле, уходящем в панель, — включая тело,
 *    приехавшее с диска на применении. Первый ловит намерение, второй —
 *    последствия чужой правки, которая однажды вернёт `get()` обратно.
 *
 * 2. `isDisabled` НЕ ЧАСТИЧНЫЙ. В `UpdateHostCommand.RequestBodySchema` он
 *    объявлен `z.boolean().default(false)` — единственное булево поле схемы
 *    БЕЗ `z.optional()`. Zod подставляет `false` на разбор тела, дальше
 *    `hosts.service.ts` разворачивает `...rest` прямо в
 *    `hostsRepository.update(...)`, и запрос без `isDisabled` ВКЛЮЧАЕТ
 *    выключенный хост. Поймано на работающей панели, подтверждено по исходникам
 *    3.2.3. Остальные булевы (`isHidden`, `overrideSniFromAddress`,
 *    `keepSniBlank`, `shuffleHost`, `mihomoX25519`) сегодня `z.optional` и
 *    пропуск переживают — но в тело всё равно кладутся все, потому что
 *    правило «булево посылается явно» дешевле, чем ежерелизная сверка, какое
 *    из них на этот раз обзавелось `default`.
 *
 * АДРЕСАЦИЯ: `PATCH /api/hosts`, uuid — В ТЕЛЕ (`HOSTS_ROUTES.UPDATE` — пустая
 * строка, `RequestBodySchema` начинается с `HostsSchema.pick({uuid: true})`).
 * Ручки `PATCH /api/hosts/{uuid}` не существует.
 */

/** Строковые поля, которые этот инструмент разрешает менять. */
const TEXT_FIELDS = [
  'remark',
  'address',
  'path',
  'sni',
  'host',
  'alpn',
  'fingerprint',
  'securityLayer',
  'serverDescription',
] as const;

/**
 * Булевы поля хоста в 3.2.3. Список закрытый и служит ТОЛЬКО переносу значений
 * из снимка в тело: менять этим инструментом можно лишь `isDisabled` и
 * `isHidden`, остальные едут своими же значениями.
 */
const BOOL_FIELDS = [
  'isDisabled',
  'isHidden',
  'overrideSniFromAddress',
  'keepSniBlank',
  'shuffleHost',
  'mihomoX25519',
] as const;

const ALPN = ['h3', 'h2', 'http/1.1', 'h3,h2,http/1.1', 'h3,h2', 'h2,http/1.1'] as const;
const SECURITY_LAYERS = ['DEFAULT', 'TLS', 'NONE'] as const;

const input = z.object({
  uuid: z
    .string()
    .uuid()
    .describe('uuid хоста. В 3.2.3 он едет В ТЕЛЕ PATCH /api/hosts, а не в пути.'),
  remark: z.string().min(1).max(100).optional().describe('Подпись хоста в подписке клиента.'),
  address: z.string().min(1).optional().describe('Адрес, на который пойдёт клиент.'),
  port: z.number().int().min(1).max(65535).optional(),
  sni: z.string().nullable().optional().describe('null — стереть значение.'),
  host: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  alpn: z.enum(ALPN).nullable().optional(),
  fingerprint: z.string().nullable().optional(),
  security_layer: z.enum(SECURITY_LAYERS).optional(),
  server_description: z.string().max(30).nullable().optional(),
  tags: z
    .array(
      z
        .string()
        .max(36)
        .regex(/^[A-Z0-9_:]+$/, 'Тег панели — только заглавные, цифры, подчёркивание и двоеточие'),
    )
    .max(10)
    .optional(),
  is_disabled: z
    .boolean()
    .optional()
    .describe(
      'Выключить или включить хост. Выключенный хост исчезает из подписок ВСЕХ клиентов, ' +
        'которым этот инбаунд светил.',
    ),
  is_hidden: z
    .boolean()
    .optional()
    .describe('Скрыть хост из выдачи, оставив его включённым для тех, кто уже знает адрес.'),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/**
 * Тело PATCH — `strictObject`: план приезжает С ДИСКА, и лишний ключ в снимке
 * иначе доехал бы до панели нетронутым. Здесь ровно то, что инструмент
 * обещает: uuid, все булевы хоста и разрешённая к правке текстовая часть.
 *
 * Чего здесь НЕТ и не будет: `inbound` (перевод хоста на другой инбаунд — это
 * правка топологии, ею занимаются карта и host_cleanup), `nodes` и
 * `excludedInternalSquads` (панель на них делает clear+add, то есть пересобирает
 * связи целиком), `xhttpExtraParams` / `muxParams` / `sockoptParams` /
 * `finalMask` (свободный JSON, и именно в `finalMask` лежит настоящий пароль UDP —
 * давать модели переписывать этот блоб значит однажды его потерять),
 * `xrayJsonTemplateUuid`, `vlessRouteId`, `pinnedPeerCertSha256`,
 * `verifyPeerCertByName`, `mihomoIpVersion`.
 */
const bodySchema = z.strictObject({
  uuid: z.string().uuid(),
  isDisabled: z.boolean(),
  isHidden: z.boolean().optional(),
  overrideSniFromAddress: z.boolean().optional(),
  keepSniBlank: z.boolean().optional(),
  shuffleHost: z.boolean().optional(),
  mihomoX25519: z.boolean().optional(),
  remark: z.string().min(1).max(100).optional(),
  address: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  sni: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  alpn: z.enum(ALPN).nullable().optional(),
  fingerprint: z.string().nullable().optional(),
  securityLayer: z.enum(SECURITY_LAYERS).optional(),
  serverDescription: z.string().max(30).nullable().optional(),
  tags: z.array(z.string().max(36)).max(10).optional(),
});

export type HostPatchBody = z.infer<typeof bodySchema>;

const HOSTS_PATH = '/api/hosts';

/**
 * Поля, расхождение которых означает «мир уехал». `viewPosition` сюда НЕ
 * входит: его двигает любая перестановка хостов в UI, а к содержимому правки
 * она отношения не имеет — сверка по нему отвергала бы планы за чужой drag&drop.
 */
const GUARD_KEYS = [...TEXT_FIELDS, ...BOOL_FIELDS, 'port', 'tags'];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function refuse(message: string): never {
  throw new Error(`host_edit: ${message}`);
}

/**
 * Последний рубеж перед записью — ОДИН НА ВЕСЬ ПАКЕТ, и живёт он у соседа.
 *
 * `assertNoMaskedValues` написан для `server_edit` (пароль SMTP, адрес
 * вебхука), но проверяет ровно то же самое утверждение: «в теле запроса нет
 * значения, собранного из редактированного чтения». Своя копия здесь
 * разъехалась бы с ней на первом же уточнении маркера — и продолжала бы
 * выглядеть работающей. Импорт из `../server/edit.js`, а не из барреля, чтобы
 * не заводить цикл через `index.ts`.
 */

/**
 * Читает хосты ТОЛЬКО нередактированным каналом. Экспортируется, потому что тем
 * же чтением живёт `host_cleanup`: снимок удаляемого хоста — единственный путь
 * восстановления, а из масок хост не пересоздашь.
 */
export async function readHostsRaw(ctx: ToolContext): Promise<Record<string, unknown>[]> {
  const raw = await ctx.remna.getRaw<unknown>(HOSTS_PATH);
  if (Array.isArray(raw)) return raw.map(asRecord);
  const nested = asRecord(raw).hosts;
  if (Array.isArray(nested)) return nested.map(asRecord);
  return [];
}

export async function readHostRaw(
  ctx: ToolContext,
  uuid: string,
  tool: string,
): Promise<Record<string, unknown>> {
  const hosts = await readHostsRaw(ctx);
  const host = hosts.find((one) => one.uuid === uuid);
  if (host === undefined) {
    throw new Error(
      `${tool}: хоста ${uuid} в панели нет. Список хостов с их uuid показывает infra_map; ` +
        `сейчас панель вернула ${String(hosts.length)} хост(ов).`,
    );
  }
  return host;
}

/** Наблюдаемое состояние хоста: и то, что показывают, и то, что сверяют. */
export function hostState(host: Record<string, unknown>): Record<string, unknown> {
  const state: Record<string, unknown> = { uuid: host.uuid, port: host.port ?? null };
  for (const key of TEXT_FIELDS) state[key] = host[key] ?? null;
  for (const key of BOOL_FIELDS) state[key] = key in host ? host[key] : null;
  state.tags = Array.isArray(host.tags) ? host.tags : [];
  state.inboundUuid = asRecord(host.inbound).configProfileInboundUuid ?? null;
  return state;
}

/**
 * Тело PATCH: uuid + ВСЕ булевы снимка + изменяемые поля. Собирается из СЫРОГО
 * хоста, а не из `hostState`: состояние нормализует отсутствующие поля в `null`,
 * а `null` в булевом поле панель отвергнет на валидации.
 */
export function mergeHost(
  host: Record<string, unknown>,
  patch: Record<string, unknown>,
): HostPatchBody {
  if (typeof host.isDisabled !== 'boolean') {
    refuse(
      `панель не вернула isDisabled для хоста ${String(host.uuid)}. Подставить сюда false ` +
        'нельзя: в 3.2.3 это ровно то значение, которым панель ВКЛЮЧАЕТ хост, когда поле в ' +
        'теле отсутствует. Обновите чтение хоста, а не это место.',
    );
  }
  const body: Record<string, unknown> = { uuid: host.uuid };
  for (const key of BOOL_FIELDS) {
    if (typeof host[key] === 'boolean') body[key] = host[key];
  }
  Object.assign(body, patch);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    refuse(
      `тело PATCH не проходит собственную схему (${parsed.error.issues
        .map((one) => `${one.path.join('.')}: ${one.message}`)
        .join('; ')}). В панель такое не уходит.`,
    );
  }
  assertNoMaskedValues(parsed.data, 'host_edit: тело PATCH /api/hosts');
  return parsed.data;
}

/** Прежние значения ровно тех полей, которые меняет патч, — для отката. */
export function previousOf(
  host: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const previous: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (key in host && host[key] !== undefined) previous[key] = host[key];
  }
  return previous;
}

/** Аргументы вызова → имена полей панели. */
function patchOf(i: Input): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (i.remark !== undefined) patch.remark = i.remark;
  if (i.address !== undefined) patch.address = i.address;
  if (i.port !== undefined) patch.port = i.port;
  if (i.sni !== undefined) patch.sni = i.sni;
  if (i.host !== undefined) patch.host = i.host;
  if (i.path !== undefined) patch.path = i.path;
  if (i.alpn !== undefined) patch.alpn = i.alpn;
  if (i.fingerprint !== undefined) patch.fingerprint = i.fingerprint;
  if (i.security_layer !== undefined) patch.securityLayer = i.security_layer;
  if (i.server_description !== undefined) patch.serverDescription = i.server_description;
  if (i.tags !== undefined) patch.tags = i.tags;
  if (i.is_disabled !== undefined) patch.isDisabled = i.is_disabled;
  if (i.is_hidden !== undefined) patch.isHidden = i.is_hidden;
  return patch;
}

const guard: PlanGuard = {
  keys: GUARD_KEYS,
  read: async (plan, ctx) => {
    const uuid = asRecord(asRecord(plan.after).body).uuid;
    if (typeof uuid !== 'string') {
      refuse('снимок плана не несёт uuid хоста — применять его нельзя, постройте план заново.');
    }
    return hostState(await readHostRaw(ctx, uuid, 'host_edit'));
  },
};

const EFFECTS: readonly string[] = [
  'Правка видна клиентам при следующем обновлении подписки: хост уезжает в конфиг всем, кому ' +
    'светит его инбаунд. Ни dry-run, ни ключа идемпотентности у панели нет — показанное ' +
    '«после» это предсказание по снимку, а не ответ бэкенда на пробный вызов.',
  'В тело PATCH уедут ВСЕ булевы поля снимка, а не только изменяемые: запрос без isDisabled ' +
    'включает выключенный хост (z.boolean().default(false) в контракте 3.2.3).',
  'Инбаунд, ноды, составы сквадов и блобы xhttp/mux/sockopt/finalMask этот инструмент не ' +
    'трогает — они не входят в тело запроса вовсе.',
  'Откат подготовлен вторым PATCH и лежит в поле rollback: он возвращает прежние значения ' +
    'изменённых полей вместе со всеми булевыми.',
];

export function hostEdit(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'host_edit',
      description:
        'Правка хоста Remnawave: подпись, адрес, порт, SNI/host/path/ALPN/fingerprint, слой ' +
        'безопасности, описание, теги, включение и скрытие. Хост адресуется uuid В ТЕЛЕ ' +
        'PATCH /api/hosts. Снимок читается нередактированным каналом, и в тело всегда уходят ' +
        'все булевы поля: запрос без isDisabled включает выключенный хост. Инбаунд, ноды и ' +
        'сырые блобы (xhttpExtraParams / muxParams / sockoptParams / finalMask) не меняются — ' +
        'в finalMask лежит рабочий пароль UDP-плеча. Без plan_id возвращает план с готовым ' +
        'откатом и ничего не меняет.',
      input,
      risk: 'high',
      // Только человек: выключение хоста немедленно убирает точку входа у всех
      // клиентов, которым светил его инбаунд.
      profiles: ['human'],
      endpoints: ['GET /api/hosts', 'PATCH /api/hosts'],
      guard,
      target: (i) => ({ system: 'remna', id: i.uuid }),

      plan: async (i, ctx): Promise<PlanDraft> => {
        const patch = patchOf(i);
        if (Object.keys(patch).length === 0) {
          refuse(
            'не передано ни одного изменяемого поля. Назовите хотя бы одно: remark, address, ' +
              'port, sni, host, path, alpn, fingerprint, security_layer, server_description, ' +
              'tags, is_disabled, is_hidden.',
          );
        }

        const host = await readHostRaw(ctx, i.uuid, 'host_edit');
        const before = hostState(host);
        const body = mergeHost(host, patch);
        const after = hostState({ ...host, ...patch });

        const rollbackBody = mergeHost(host, previousOf(host, patch));
        assertNoMaskedValues(rollbackBody, 'host_edit: тело отката');

        const effects = [...EFFECTS];
        if (patch.isDisabled === true) {
          effects.unshift(
            'Хост выключается: он немедленно перестанет попадать в подписки. Если это ' +
              'последний включённый хост своего инбаунда, точка входа гаснет целиком — ' +
              'проверьте по infra_map (gaps.inboundsPublishedOnlyByDisabledHosts).',
          );
        }
        if (patch.isDisabled === false) {
          effects.unshift(
            'Хост включается и начинает раздаваться клиентам. Убедитесь, что это не мост и не ' +
              'релейный хоп: такой хост отдаёт клиенту внутренний адрес.',
          );
        }

        return {
          before,
          // `body` лежит рядом с предсказанным состоянием: применению нужно
          // тело, оператору — «что станет». В diff тело не попадает, он
          // посчитан по паре состояний.
          after: { ...after, body },
          diff: buildDiff(before, after, ctx.profile),
          sideEffects: effects,
          rollback: { method: 'PATCH', path: HOSTS_PATH, body: rollbackBody },
        };
      },

      apply: async (plan, ctx) => {
        // План приезжает С ДИСКА, подписи у снимка нет: тело перепроверяется
        // той же схемой, что и на планировании, и той же проверкой на маску.
        const parsed = bodySchema.safeParse(asRecord(plan.after).body);
        if (!parsed.success) {
          refuse('снимок плана не несёт разрешённого тела PATCH — постройте план заново.');
        }
        assertNoMaskedValues(parsed.data, 'host_edit: тело PATCH /api/hosts из снимка плана');

        // sendRaw, а не send: ответ панели — это тот же хост, и редакция его
        // ответа нам не мешает, но и не помогает. Наружу он всё равно уходит
        // через `redact` исполнителя, поэтому берём обычный send: сырой ответ
        // в журнале мутаций был бы лишним хранением пароля из finalMask.
        const updated = await ctx.remna.send<unknown>('PATCH', HOSTS_PATH, parsed.data);
        return { uuid: parsed.data.uuid, host: hostState(asRecord(updated)) };
      },
    },
    deps,
  );
}
