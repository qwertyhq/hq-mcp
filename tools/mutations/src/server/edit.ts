import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildDiff, redactDiff } from '@hq/confirm';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool, PlanDraft } from '../kit.js';
import type { AuditTarget } from '@hq/audit';
import type { DiffEntry, MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';

/**
 * ТАБЛИЦА `servers` У SHM — ЭТО ТРАНСПОРТЫ, А НЕ VPN-НОДЫ.
 *
 * Проверено на работающей SHM (см. server_inventory): строки этой таблицы —
 * это `http` (вебхуки мессенджера и почтовой рассылки), `ssh` (сервер
 * провижининга) и `mail`. Ни одного адреса VPN-ноды панели там нет вовсе. Этот
 * инструмент правит именно транспорты: то, как биллинг дотягивается до мира.
 *
 * ЧТО ЛЕЖИТ В СТРОКЕ. В колонке `host` части строк — НАСТОЯЩИЙ ТОКЕН БОТА
 * (`https://api.telegram.org/bot<id>:<токен>/sendMessage`), в `settings` —
 * пароль SMTP, заголовок `api-key` и ссылка на приватный ssh-ключ. Отсюда два
 * решения, определяющие весь файл:
 *
 *  1. ЧИТАЕМ ТОЛЬКО `getRaw`. Обычный `get`/`list` прогоняет ответ через
 *     `redact`, а `redact` маскирует по ИМЕНИ поля — `settings.password` и
 *     `settings.key_id` приехали бы строкой '<redacted>'. SHM пишет json-колонку
 *     ЦЕЛИКОМ (`Core::Base::_add_or_set` кодирует хеш и отдаёт его в
 *     `UPDATE ... SET settings=?`), то есть частичная правка настроек — это
 *     read-modify-write, и собранный из редактированного чтения он записал бы
 *     маркер вместо пароля. Работающий транспорт после такой «правки» молча
 *     перестаёт работать. Проверка `assertNoMaskedValues` стоит и на плане, и
 *     перед отправкой: одного канала мало, если канал однажды перепутают.
 *  2. НАРУЖУ НЕ УХОДИТ НИ ОДНО ПРОЧИТАННОЕ ЗНАЧЕНИЕ `host` И НИ ОДНО ЗНАЧЕНИЕ
 *     `settings`. В снимке «до» host заменён на `scheme://host[:port]` плюс
 *     отпечаток полного значения, а settings — на СПИСОК ИМЁН и отпечаток.
 *     Отпечаток нужен не для красоты: без него ротация токена внутри пути дала
 *     бы ПУСТОЙ diff (адрес-то не изменился), а каркас справедливо отказывается
 *     подтверждать план, который ничего не меняет.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ ДЕЛАЕТ И НИКОГДА НЕ БУДЕТ: он не трогает ssh-ключи.
 * Маршрут ключей (и генерация, и список) запрещён целиком правилом-префиксом в
 * @hq/registry — тот GET возвращает приватный ключ в теле ответа. Здесь ровно
 * два пути, оба константы, и ни один сегмент не собирается из ввода; плюс
 * `settings.key_id` запрещён к записи (см. FORBIDDEN_SETTINGS_KEYS).
 */

const SERVERS = '/admin/server';
const GROUPS = '/admin/server/group';
/** Строк в этой таблице единицы; 500 — потолок клиента SHM, берём его как «всё». */
const PAGE = 500;

const ACTIONS = [
  'create_server',
  'update_server',
  'delete_server',
  'create_group',
  'update_group',
  'delete_group',
] as const;

export type ServerEditAction = (typeof ACTIONS)[number];

/** `Core::Server::structure` и `Core::ServerGroups::structure`, enum транспорта. */
export const TRANSPORTS = ['ssh', 'http', 'telegram', 'mail', 'local'] as const;
/** `Core::ServerGroups::structure`, enum способа выборки сервера. */
export const GROUP_TYPES = ['random', 'by-one', 'evenly'] as const;

/** Колонки строки сервера, которые инструмент писать умеет. */
export const SERVER_FIELDS = [
  'server_gid',
  'name',
  'transport',
  'host',
  'ip',
  'weight',
  'enabled',
] as const;

/** Колонки группы, которые инструмент писать умеет. */
export const GROUP_FIELDS = ['name', 'type', 'transport'] as const;

/**
 * Поля, которые бэкенд под админом писать УМЕЕТ, а мы не даём. Умеет он их
 * потому, что `Core::Base::api` фильтрует аргументы через `api_safe_args` только
 * когда флага `admin` нет (Base.pm:417-425), а диспетчер ставит `admin => 1`
 * любому запросу к `/admin/*` (v1.cgi:1670-1683): на этом маршруте не защищено
 * ни одно поле структуры. Единственный whitelist, который существует, — этот.
 */
const FORBIDDEN_FIELD_HINTS: Record<string, string> = {
  server_id:
    'server_id — это АДРЕС строки, а не поле: он передаётся отдельным аргументом. Обновить ключ ' +
    'таблицы бэкенд всё равно не даст (Sql/Data.pm:534-536 выбрасывает его из UPDATE), и ' +
    'молчаливо проигнорированное поле хуже отказа.',
  group_id: 'group_id — адрес группы, а не поле; передаётся отдельным аргументом',
  services_count:
    'счётчик услуг ведёт сам SHM (`services_count_increase`/`decrease` в Core/Server.pm). Правка ' +
    'руками разъезжает его с реальностью, а сравнивается он с settings.max_services — то есть ' +
    'подделанное число молча закрывает или открывает сервер для выборки.',
  success_count: 'по структуре SHM это поле «не используется» — запись в него ничего не значит',
  fail_count: 'по структуре SHM это поле «не используется» — запись в него ничего не значит',
  settings:
    'у настроек отдельный аргумент `settings` с СЛИЯНИЕМ: SHM пишет json-колонку целиком, ' +
    'поэтому передать её в fields значило бы стереть все ключи, которых нет в присланном объекте',
};

/**
 * Ключи settings, запрещённые к записи.
 *
 * `key_id` — ссылка на приватный ssh-ключ провижининга. Проверить, что такой
 * ключ существует, этот сервер не может НИ ОДНИМ способом: маршрут ключей
 * запрещён целиком (он возвращает приватный ключ в теле). То есть запись сюда —
 * это указание провижинингу на ключ, которого никто здесь не видел, а неверный
 * id ломает каждую ssh-задачу молча.
 */
export const FORBIDDEN_SETTINGS_KEYS: Record<string, string> = {
  key_id:
    'settings.key_id указывает, каким приватным ssh-ключом ходит провижининг. Существование ключа ' +
    'этот сервер проверить не может: маршрут ключей запрещён целиком (он отдаёт приватный ключ в ' +
    'теле ответа), поэтому запись сюда — это ссылка на непроверяемый объект, а ошибка в ней ломает ' +
    'каждую ssh-задачу без единой строки в истории клиента. Меняется в админке SHM.',
};

const SETTINGS_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const input = z.object({
  action: z.enum(ACTIONS),
  server_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Обязателен для update_server и delete_server'),
  group_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Обязателен для update_group и delete_group'),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Колонки строки. Сервер: server_gid, name, transport, host, ip, weight, enabled. Группа: ' +
        'name, type, transport. Любое другое поле отклоняется с объяснением: под админом SHM ' +
        'пишет что угодно, включая счётчики, и защиты на его стороне нет.',
    ),
  settings: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Частичная правка json-настроек СЕРВЕРА: переданные ключи накладываются на текущие, ' +
        'значение null удаляет ключ. Слияние делает инструмент, потому что SHM переписывает ' +
        'колонку целиком. У групп настроек нет.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

interface Snapshot {
  kind: 'server' | 'group';
  id: number | null;
  exists: boolean;
  name: string | null;
  transport: string | null;
  /** Только у группы: способ выборки сервера. */
  type: string | null;
  /** Только у сервера. */
  server_gid: number | null;
  enabled: number | null;
  weight: number | null;
  ip: string | null;
  /** `scheme://host[:port]`; путь, query и user:password вырезаны, а не замаскированы. */
  host: string | null;
  /** Отпечаток ПОЛНОГО значения host: без него ротация токена в пути даёт пустой diff. */
  host_fingerprint: string | null;
  /** ИМЕНА ключей settings, а не значения: там живут пароли и заголовки. */
  settingsFields: string[];
  settings_fingerprint: string | null;
  /** Счётчик SHM. Информация, НЕ участвует в сверке: в работающей установке он растёт сам по себе. */
  services_count: number | null;
  /** Только у группы: сколько серверов на неё ссылается. */
  members: number | null;
  /** Водяной знак для создания: максимальный id на момент чтения. */
  last_id: number | null;
}

interface Call {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
}

interface AfterState {
  action: ServerEditAction;
  call: Call;
}

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

/** Первые 12 символов sha256. Достаточно, чтобы заметить изменение; нечего восстанавливать. */
function fingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * `scheme://host[:port]` и ничего больше. Эвристики «оставить безопасно
 * выглядящие сегменты пути» здесь нет намеренно: правило, которое иногда
 * пропускает секрет, защищает только от тех секретов, о которых уже знаешь, — а
 * в этих путях лежит настоящий токен бота.
 */
function safeHost(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  // Схема отрезается вручную: у `smtp.mail.ru:587` конструктор URL считает
  // схемой `smtp.mail.ru:`, а хостом пустую строку — адрес исчез бы целиком.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)?.[0] ?? '';
  const rest = raw.slice(scheme.length);
  const queryAt = rest.search(/[?#]/);
  const authority = (queryAt === -1 ? rest : rest.slice(0, queryAt)).split('/')[0] ?? '';
  const at = authority.lastIndexOf('@');
  return `${scheme}${at === -1 ? authority : authority.slice(at + 1)}`;
}

/** Как host выглядит в diff: безопасный адрес плюс отпечаток полного значения. */
function hostForDiff(value: unknown): string | null {
  const safe = safeHost(value);
  if (safe === null) return null;
  return `${safe} [#${String(fingerprint(str(value)))}]`;
}

export const REDACTION_MARKER = '<redacted';

function findMaskedPath(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes(REDACTION_MARKER)) out.push(path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findMaskedPath(item, `${path}[${String(index)}]`, out);
    });
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    findMaskedPath(item, path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * ПРЕДОХРАНИТЕЛЬ, РАДИ КОТОРОГО НАПИСАНА ПОЛОВИНА ЭТОГО ФАЙЛА.
 *
 * Значение вида '<redacted>' в теле запроса означает ровно одно: тело собрано из
 * ОТРЕДАКТИРОВАННОГО чтения. Отправить его — значит записать маркер вместо
 * пароля SMTP или вместо адреса вебхука и сломать работающий транспорт молча:
 * SHM ответит 200, строка обновится, а письма перестанут уходить. Проверяется и
 * на плане, и перед самой отправкой — потому что между ними лежит диск.
 */
export function assertNoMaskedValues(body: unknown, what: string): void {
  const hits: string[] = [];
  findMaskedPath(body, '', hits);
  if (hits.length === 0) return;
  throw new Error(
    `${what}: в теле запроса маскированные значения (${hits.join(', ')}). Так выглядит тело, ` +
      'собранное из редактированного чтения: @hq/redact маскирует по имени поля, и settings.password ' +
      'или settings.key_id приезжают строкой-маркером. Отправка записала бы маркер вместо секрета и ' +
      'сломала транспорт при ответе 200. Читать для правки нужно ТОЛЬКО getRaw.',
  );
}

/** Пустой снимок: `exists: false`. Отдельный тип не нужен — сверка сравнивает поля. */
function emptySnapshot(kind: 'server' | 'group', id: number | null, lastId: number | null): Snapshot {
  return {
    kind,
    id,
    exists: false,
    name: null,
    transport: null,
    type: null,
    server_gid: null,
    enabled: null,
    weight: null,
    ip: null,
    host: null,
    host_fingerprint: null,
    settingsFields: [],
    settings_fingerprint: null,
    services_count: null,
    members: null,
    last_id: lastId,
  };
}

function settingsOf(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.settings;
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return asRecord(raw);
}

function serverSnapshot(row: Record<string, unknown>, lastId: number | null): Snapshot {
  const settings = settingsOf(row);
  return {
    kind: 'server',
    id: num(row.server_id),
    exists: true,
    name: str(row.name),
    transport: str(row.transport),
    type: null,
    server_gid: num(row.server_gid),
    enabled: num(row.enabled),
    weight: num(row.weight),
    ip: str(row.ip),
    host: safeHost(row.host),
    host_fingerprint: fingerprint(str(row.host)),
    settingsFields: Object.keys(settings).sort(),
    settings_fingerprint: fingerprint(settings),
    services_count: num(row.services_count),
    members: null,
    last_id: lastId,
  };
}

function groupSnapshot(
  row: Record<string, unknown>,
  members: number | null,
  lastId: number | null,
): Snapshot {
  return {
    kind: 'group',
    id: num(row.group_id),
    exists: true,
    name: str(row.name),
    transport: str(row.transport),
    type: str(row.type),
    server_gid: null,
    enabled: null,
    weight: null,
    ip: null,
    host: null,
    host_fingerprint: null,
    settingsFields: [],
    settings_fingerprint: null,
    services_count: null,
    members,
    last_id: lastId,
  };
}

/**
 * Строки читаются НЕредактированным каналом и всегда СПИСКОМ, а нужная
 * выбирается поиском по ключу, а не позицией.
 *
 * Причина не в стиле: серверный фильтр — это возможность (`shm.filter`), а не
 * данность. Сборка, которая его игнорирует, вернула бы на `?server_id=13` ВСЕ
 * одиннадцать строк, и `rows[0]` оказался бы чужим транспортом — то есть правка
 * молча уехала бы не туда. Поиск по id даёт «не найдено» там, где позиция дала
 * бы «нашлось не то».
 */
async function readRows(
  ctx: ToolContext,
  path: string,
  params: Record<string, number>,
): Promise<Record<string, unknown>[]> {
  const raw = await ctx.shm.getRaw<unknown>(path, { ...params, limit: PAGE });
  const rows = (Array.isArray(raw) ? raw : [raw])
    .filter((one) => one !== null && one !== undefined)
    .map(asRecord);
  if (rows.length >= PAGE) {
    // Полная страница означает, что список мог быть обрезан, а вместе с ним и
    // поиск по ключу: «не найдено» стало бы неотличимо от «не доехало».
    throw new Error(
      `server_edit: ${path} вернул ${String(rows.length)} строк — это потолок страницы, то есть ` +
        'список мог быть неполным. Правка по неполному списку — это правка не того объекта.',
    );
  }
  return rows;
}

/** Ответ на запись: `api_add` возвращает голый id, `api_set` — строку целиком. */
function idFromResult(result: unknown, idField: string): number | null {
  const first = Array.isArray(result) ? result[0] : result;
  if (typeof first === 'number' || typeof first === 'string') return num(first);
  return num(asRecord(first)[idField]);
}

function maxId(rows: Record<string, unknown>[], key: string): number | null {
  return rows.reduce<number | null>((top, row) => {
    const id = num(row[key]);
    return id !== null && (top === null || id > top) ? id : top;
  }, null);
}

async function readServer(ctx: ToolContext, serverId: number | null): Promise<Snapshot> {
  const rows = await readRows(ctx, SERVERS, serverId === null ? {} : { server_id: serverId });
  const last = maxId(rows, 'server_id');
  if (serverId === null) return emptySnapshot('server', null, last);
  const row = rows.find((one) => num(one.server_id) === serverId);
  return row === undefined ? emptySnapshot('server', serverId, null) : serverSnapshot(row, null);
}

async function readGroup(ctx: ToolContext, groupId: number | null): Promise<Snapshot> {
  const rows = await readRows(ctx, GROUPS, groupId === null ? {} : { group_id: groupId });
  const last = maxId(rows, 'group_id');
  if (groupId === null) return emptySnapshot('group', null, last);
  const row = rows.find((one) => num(one.group_id) === groupId);
  if (row === undefined) return emptySnapshot('group', groupId, null);
  const servers = await readRows(ctx, SERVERS, {});
  const members = servers.filter((one) => num(one.server_gid) === groupId).length;
  return groupSnapshot(row, members, null);
}

/** Что читается заново перед применением: та же функция, что строила снимок. */
async function readWorld(plan: MutationPlan, ctx: ToolContext): Promise<Snapshot> {
  const before = asRecord(plan.before);
  const kind = before.kind === 'group' ? 'group' : 'server';
  const id = num(before.id);
  return kind === 'group' ? readGroup(ctx, id) : readServer(ctx, id);
}

const FIELD_PROBLEMS: Record<string, (value: unknown) => string | undefined> = {
  server_gid: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0
      ? undefined
      : 'server_gid — положительное целое: id группы, которой принадлежит сервер',
  name: (value) =>
    typeof value === 'string' && value.trim() !== '' && value.length <= 255
      ? undefined
      : 'name — непустая строка до 255 символов',
  transport: (value) =>
    typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value)
      ? undefined
      : `transport принимает только ${TRANSPORTS.join(', ')} (enum структуры SHM)`,
  type: (value) =>
    typeof value === 'string' && (GROUP_TYPES as readonly string[]).includes(value)
      ? undefined
      : `type принимает только ${GROUP_TYPES.join(', ')} (enum структуры SHM)`,
  host: (value) =>
    typeof value === 'string' && value.trim() !== '' && value.length <= 2000
      ? undefined
      : 'host — непустая строка до 2000 символов',
  ip: (value) =>
    value === null || (typeof value === 'string' && value.length <= 45)
      ? undefined
      : 'ip — строка до 45 символов или null',
  weight: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? undefined
      : 'weight — неотрицательное целое: чем больше, тем выше вероятность выборки',
  enabled: (value) =>
    value === 0 || value === 1 ? undefined : 'enabled принимает только 0 или 1 (enum структуры SHM)',
};

function assertFields(
  tool: string,
  incoming: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const keys = Object.keys(incoming).filter((key) => incoming[key] !== undefined);
  for (const key of keys) {
    const hint = FORBIDDEN_FIELD_HINTS[key];
    if (hint !== undefined) throw new Error(`${tool}: поле ${key} запрещено. ${hint}`);
    if (!allowed.includes(key)) {
      throw new Error(
        `${tool}: поле ${key} вне whitelist. Разрешены: ${allowed.join(', ')}. Список держится ` +
          'здесь, а не в SHM: на админском маршруте бэкенд не фильтрует ничего.',
      );
    }
    const problem = FIELD_PROBLEMS[key]?.(incoming[key]);
    if (problem !== undefined) throw new Error(`${tool}: ${problem}`);
  }
  return keys;
}

function mergeSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const forbidden = FORBIDDEN_SETTINGS_KEYS[key];
    if (forbidden !== undefined) throw new Error(`${tool}: settings.${key} запрещён. ${forbidden}`);
    if (!SETTINGS_KEY_RE.test(key)) {
      throw new Error(
        `${tool}: имя ключа настроек ${JSON.stringify(key)} не годится — ожидается идентификатор ` +
          '([A-Za-z_][A-Za-z0-9_.-]*)',
      );
    }
    if (value === null) {
      // Стереть ключ можно только так: SHM переписывает колонку целиком, и
      // «оставить как было» — это не передать ключ вовсе.
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

const ROUTE_NOTE =
  'На админском маршруте api_safe_args НЕ применяется: диспетчер ставит admin=1 любому /admin/* ' +
  '(v1.cgi:1670-1683), а Core::Base::api фильтрует поля только без этого флага (Base.pm:417-425). ' +
  'Записано будет ровно то, что перечислено в diff, и ничего сверх — потому что тело собирается ' +
  'из whitelist, а не из прочитанной строки.';

const HOST_NOTE =
  'Прежнее значение host этот инструмент НЕ возвращает и вернуть не может: на этом деплое в той ' +
  'колонке лежит настоящий токен бота, а маскировка по имени поля его не видит. Поэтому отката для ' +
  'смены host здесь нет — если он может понадобиться, заберите старое значение из админки SHM ДО ' +
  'применения. В плане на диске оно есть (каталог снимков, права 0600).';

const SETTINGS_NOTE =
  'SHM переписывает json-колонку ЦЕЛИКОМ, поэтому отправляется результат слияния текущих настроек ' +
  'с присланными ключами. Значения прочитаны нередактированным каналом; отката для настроек нет ' +
  'намеренно — тело отката ушло бы в ответ модели, а редакция по имени поля превратила бы пароль в ' +
  'маркер, и «откат» стёр бы секрет вместо восстановления.';

function sideEffectsFor(action: ServerEditAction, before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [ROUTE_NOTE];

  if (action === 'create_server' || action === 'update_server') {
    out.push(
      'Транспорт выбирается по ГРУППЕ: Core::Task берёт transport из server_gid, а сервер внутри ' +
        'группы — по её типу выборки, без оглядки на собственный transport строки. Расхождение ' +
        'между transport сервера и transport его группы означает, что задача поедет через чужой ' +
        'транспорт с чужими settings.',
    );
  }
  if (action === 'update_server' && before.enabled === 1 && after.enabled === 0) {
    out.push(
      `ВЫКЛЮЧЕНИЕ ТРАНСПОРТА. Core::ServerGroups::get_servers берёт ТОЛЬКО enabled=1; если это был ` +
        'последний включённый сервер группы, она перестанет выдавать что-либо: SHM запишет в лог ' +
        '"No servers found in the group" и вернёт undef, а событие, маршрутизированное в эту ' +
        'группу, просто не выполнится — молча, без единой строки в истории клиента.',
    );
    if ((before.services_count ?? 0) > 0) {
      out.push(
        `На этом сервере числится ${String(before.services_count)} услуг. Для ssh-транспорта это ` +
          'сервер провижининга: выключение останавливает выдачу и снятие доступа для всех них.',
      );
    }
  }
  if (action === 'delete_server') {
    out.push(
      'Удаление строки транспорта необратимо: ни отката, ни истории. SHM откажет, если на сервер ' +
        'ссылается хоть одна не-REMOVED услуга (Core::Server::delete), и такой отказ приедет как ' +
        'ошибка «SHM ответил 200 с ложным data». Если нужно просто вывести транспорт из ротации — ' +
        'это update_server с enabled=0, обратимо.',
    );
  }
  if (action === 'delete_group') {
    out.push(
      'Удаление группы необратимо и оставляет её серверы сиротами: их server_gid будет указывать ' +
        'на несуществующую группу, а событие, маршрутизированное туда, перестанет выполняться.',
    );
  }
  if (action === 'update_group' && before.type !== null && after.type !== null && before.type !== after.type) {
    out.push(
      'Способ выборки меняет РАСПРЕДЕЛЕНИЕ новых услуг: random — случайный сервер, by-one — самый ' +
        'загруженный, evenly — самый свободный (Core/ServerGroups.pm). Уже выданные услуги ' +
        'остаются там, где были.',
    );
  }
  return out;
}

function callFor(action: ServerEditAction, body: Record<string, unknown>): Call {
  switch (action) {
    case 'create_server':
      return { method: 'PUT', path: SERVERS, body };
    case 'update_server':
      return { method: 'POST', path: SERVERS, body };
    case 'delete_server':
      return { method: 'DELETE', path: SERVERS, body };
    case 'create_group':
      return { method: 'PUT', path: GROUPS, body };
    case 'update_group':
      return { method: 'POST', path: GROUPS, body };
    case 'delete_group':
      return { method: 'DELETE', path: GROUPS, body };
  }
}

const SERVER_ACTIONS = new Set<ServerEditAction>(['create_server', 'update_server', 'delete_server']);
const CREATE_ACTIONS = new Set<ServerEditAction>(['create_server', 'create_group']);
const DELETE_ACTIONS = new Set<ServerEditAction>(['delete_server', 'delete_group']);

/** Поля снимка, которые показываются оператору и сравниваются в diff. */
function display(one: Snapshot): Record<string, unknown> {
  return {
    exists: one.exists,
    name: one.name,
    transport: one.transport,
    type: one.type,
    server_gid: one.server_gid,
    enabled: one.enabled,
    weight: one.weight,
    ip: one.ip,
    host: one.host === null ? null : `${one.host} [#${String(one.host_fingerprint)}]`,
    settings: one.settings_fingerprint === null ? null : `#${one.settings_fingerprint}`,
  };
}

export function serverEdit(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'server_edit',
      description:
        'Create, change or delete an SHM transport row or a transport group (/admin/server, ' +
        '/admin/server/group). These are NOT VPN nodes: the table holds the http webhooks, the ssh ' +
        'provisioning endpoint and the mail senders billing reaches the world through. Rows are ' +
        'read through the unredacted channel and written field by field from a whitelist, because ' +
        'a live bot token sits inside the `host` column and a masked value written back would ' +
        'break a working transport at HTTP 200. Nothing read is ever returned: `host` comes back ' +
        'as scheme://host plus a fingerprint, settings as key NAMES plus a fingerprint. SSH ' +
        'identities are not touched at all — that route returns private keys and is refused by ' +
        'this server. Without plan_id it returns a plan and changes nothing.',
      input,
      risk: 'high',
      /**
       * Только human. Это карта того, как биллинг дотягивается до мира: адреса
       * вебхуков, SMTP-хосты, ёмкость провижининга. Ни на один вопрос клиента
       * она не отвечает (§7.2), а ошибка здесь останавливает провижининг для
       * всех сразу.
       */
      profiles: ['human'],
      endpoints: [
        'GET /admin/server',
        'GET /admin/server/group',
        'PUT /admin/server',
        'POST /admin/server',
        'DELETE /admin/server',
        'PUT /admin/server/group',
        'POST /admin/server/group',
        'DELETE /admin/server/group',
      ],
      target: (i): AuditTarget | undefined => {
        const id = SERVER_ACTIONS.has(i.action) ? i.server_id : i.group_id;
        return id === undefined ? undefined : { system: 'shm', id };
      },
      guard: {
        keys: [
          'exists',
          'name',
          'transport',
          'type',
          'server_gid',
          'enabled',
          'weight',
          'ip',
          'host_fingerprint',
          'settings_fingerprint',
          'members',
          'last_id',
        ],
        read: readWorld,
      },

      plan: async (i, ctx): Promise<PlanDraft> => {
        const tool = 'server_edit';
        const isServer = SERVER_ACTIONS.has(i.action);
        const isCreate = CREATE_ACTIONS.has(i.action);
        const isDelete = DELETE_ACTIONS.has(i.action);
        const idField = isServer ? 'server_id' : 'group_id';
        const id = isServer ? i.server_id : i.group_id;

        if (!isCreate && id === undefined) {
          throw new Error(`${tool}: action=${i.action} требует ${idField}`);
        }
        if (isCreate && id !== undefined) {
          throw new Error(
            `${tool}: у ${i.action} нет ${idField} — объект ещё не существует. SHM назначает ключ ` +
              'сам, а присланный ключ он в INSERT не берёт.',
          );
        }
        if (isServer && i.group_id !== undefined) {
          throw new Error(`${tool}: action=${i.action} адресует сервер, group_id здесь лишний`);
        }
        if (!isServer && i.server_id !== undefined) {
          throw new Error(`${tool}: action=${i.action} адресует группу, server_id здесь лишний`);
        }
        if (!isServer && i.settings !== undefined) {
          throw new Error(
            `${tool}: у групп серверов нет json-настроек (колонка settings объявлена текстом и ` +
              'не читается ни одним потребителем SHM) — правьте name, type и transport.',
          );
        }
        if (isDelete && (i.fields !== undefined || i.settings !== undefined)) {
          throw new Error(`${tool}: ${i.action} ничего не пишет — уберите fields и settings`);
        }

        const incoming = asRecord(i.fields);
        const keys = isDelete
          ? []
          : assertFields(tool, incoming, isServer ? SERVER_FIELDS : GROUP_FIELDS);
        if (!isDelete && keys.length === 0 && i.settings === undefined) {
          throw new Error(`${tool}: не передано ни одного поля для записи`);
        }

        const before = isServer
          ? await readServer(ctx, id ?? null)
          : await readGroup(ctx, id ?? null);

        if (!isCreate && !before.exists) {
          throw new Error(
            `${tool}: ${idField}=${String(id)} в SHM не найден. Строка читается списком и ищется по ` +
              'ключу, а не берётся первой: сборка без серверного фильтра иначе отдала бы чужую.',
          );
        }

        // ПРЕДУСЛОВИЯ, КОТОРЫЕ БЭКЕНД ПРОВЕРЯЕТ МОЛЧА ИЛИ НЕ ПРОВЕРЯЕТ ВОВСЕ.
        if (i.action === 'delete_server' && (before.services_count ?? 0) > 0) {
          throw new Error(
            `${tool}: на сервере ${String(id)} числится ${String(before.services_count)} услуг, и ` +
              'SHM откажет в удалении (Core::Server::delete проверяет не-REMOVED услуги со ссылкой ' +
              'на этот сервер и возвращает undef). Отказ приехал бы как «200 с ложным data». Чтобы ' +
              'вывести транспорт из ротации, есть update_server с enabled=0 — и он обратим.',
          );
        }
        if (i.action === 'delete_group') {
          if (id === 1 || id === 2) {
            throw new Error(
              `${tool}: группы 1 (LOCAL) и 2 (MAIL) удалить нельзя — Core::ServerGroups::delete ` +
                'отказывает на них по константам GROUP_ID_LOCAL/GROUP_ID_MAIL и возвращает undef, ' +
                'то есть «успех» был бы ложным.',
            );
          }
          if ((before.members ?? 0) > 0) {
            throw new Error(
              `${tool}: на группу ${String(id)} ссылается серверов: ${String(before.members)}. ` +
                'Удаление оставит их сиротами — server_gid будет указывать в пустоту, и событие, ' +
                'маршрутизированное туда, перестанет выполняться молча. Сначала переведите серверы ' +
                'в другую группу (update_server, поле server_gid).',
            );
          }
        }
        if (isCreate && isServer) {
          for (const required of ['name', 'transport', 'server_gid']) {
            if (!keys.includes(required)) {
              throw new Error(
                `${tool}: create_server требует ${required}. Сервер без группы не выбирается ` +
                  'никогда: выборку делает группа, а не таблица серверов.',
              );
            }
          }
        }
        if (isCreate && !isServer && !keys.includes('name')) {
          throw new Error(`${tool}: create_group требует name`);
        }

        // Группа назначения обязана существовать: сервер, указывающий на
        // несуществующую группу, не выбирается ничем и молчит об этом.
        const targetGid = num(incoming.server_gid);
        if (isServer && targetGid !== null && targetGid !== before.server_gid) {
          const group = await readGroup(ctx, targetGid);
          if (!group.exists) {
            throw new Error(
              `${tool}: группы server_gid=${String(targetGid)} в SHM нет. Сервер в несуществующей ` +
                'группе не будет выбран никогда — ровно та дыра, которую server_inventory ' +
                'показывает как serversInMissingGroup.',
            );
          }
        }

        const currentSettings = i.settings === undefined ? {} : await readSettings(ctx, before, id);
        const mergedSettings =
          i.settings === undefined ? undefined : mergeSettings(currentSettings, asRecord(i.settings), tool);

        const body: Record<string, unknown> = {};
        if (!isCreate && id !== undefined) body[idField] = id;
        for (const key of keys) body[key] = incoming[key];
        if (mergedSettings !== undefined) body.settings = mergedSettings;

        // Первая из двух проверок: тело, собранное из редактированного чтения,
        // не имеет права дожить даже до плана.
        assertNoMaskedValues(body, tool);

        const call = callFor(i.action, body);
        const after: AfterState = { action: i.action, call };

        const afterDisplay: Record<string, unknown> = { ...display(before) };
        if (isDelete) {
          afterDisplay.exists = false;
        } else {
          if (isCreate) afterDisplay.exists = true;
          for (const key of keys) {
            afterDisplay[key] = key === 'host' ? hostForDiff(incoming[key]) : incoming[key];
          }
          if (mergedSettings !== undefined) {
            afterDisplay.settings = `#${String(fingerprint(mergedSettings))}`;
          }
        }

        const beforeDisplay = isCreate ? display(emptySnapshot(before.kind, null, null)) : display(before);

        /**
         * Ключи settings выносятся в diff по одному — оператор обязан видеть, ЧТО
         * именно меняется, а не только «отпечаток стал другим». Значения проходят
         * `redactDiff`: он маскирует по всем сегментам пути, поэтому
         * `settings.password` и `settings.headers.api-key` уезжают маркером. Тело
         * запроса берётся НЕ отсюда — оно в `after.call.body`, нетронутое.
         */
        const settingsDiff: DiffEntry[] =
          i.settings === undefined
            ? []
            : redactDiff(
                Object.keys(asRecord(i.settings))
                  .map((key) => ({
                    path: `settings.${key}`,
                    from: currentSettings[key] ?? null,
                    to: asRecord(i.settings)[key] ?? null,
                  }))
                  .filter((entry) => JSON.stringify(entry.from) !== JSON.stringify(entry.to)),
                ctx.profile,
              );

        const diff = [...buildDiff(beforeDisplay, afterDisplay, ctx.profile), ...settingsDiff];

        const sideEffects = sideEffectsFor(
          i.action,
          before,
          { ...before, enabled: num(afterDisplay.enabled), type: str(afterDisplay.type) },
        );
        if (keys.includes('host')) sideEffects.push(HOST_NOTE);
        if (mergedSettings !== undefined) sideEffects.push(SETTINGS_NOTE);

        /**
         * ОТКАТ ПРЕДЛАГАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОН ЧЕСТНЫЙ.
         *
         * Тело отката уезжает в ответ модели, а ответ проходит через `redact`:
         * прежний `settings.password` вернулся бы туда строкой '<redacted>', и
         * такой «откат», применённый руками, стёр бы секрет вместо
         * восстановления. Прежний `host` вернулся бы с настоящим токеном внутри.
         * Поэтому откат есть ровно для безопасных скалярных колонок и только
         * когда ИМИ исчерпывается вся правка: частичный откат, выглядящий полным,
         * хуже отсутствующего.
         */
        const rollbackable = keys.filter((key) => key !== 'host');
        const rollback =
          i.action === 'update_server' || i.action === 'update_group'
            ? mergedSettings === undefined && rollbackable.length === keys.length
              ? {
                  method: 'POST' as const,
                  path: isServer ? SERVERS : GROUPS,
                  body: {
                    [idField]: id,
                    ...Object.fromEntries(
                      rollbackable.map((key) => [
                        key,
                        (before as unknown as Record<string, unknown>)[key] ?? null,
                      ]),
                    ),
                  },
                }
              : undefined
            : undefined;

        return {
          // Снимок «до» показывается как есть: значений host и settings в нём
          // нет по построению — только безопасный адрес, имена ключей и отпечатки.
          before: { ...before, action: i.action },
          after,
          diff,
          sideEffects,
          ...(rollback === undefined ? {} : { rollback }),
        };
      },

      apply: async (plan, ctx) => {
        const raw = asRecord(plan.after);
        const call = asRecord(raw.call);
        const action = String(raw.action) as ServerEditAction;
        const body = asRecord(call.body);
        const path = call.path === GROUPS ? GROUPS : SERVERS;
        const method = call.method === 'PUT' ? 'PUT' : call.method === 'DELETE' ? 'DELETE' : 'POST';

        // Вторая проверка: между планом и применением лежит диск, и тело могло
        // приехать не тем, чем уезжало.
        assertNoMaskedValues(body, 'server_edit');

        const result = await ctx.shm.action<unknown>(method, path, body);

        // Ответ бэкенда наружу НЕ отдаётся: `api_set` возвращает строку целиком,
        // вместе с host и settings. Возвращается только id и перечитанный
        // безопасный снимок.
        const isServer = SERVER_ACTIONS.has(action);
        const idField = isServer ? 'server_id' : 'group_id';
        // У создания адрес объекта появляется только сейчас, и приезжает он
        // по-разному: `api_add` отдаёт голый id, `api_set` — строку целиком.
        const id = num(body[idField]) ?? idFromResult(result, idField);

        let state: Snapshot | null = null;
        let verifyError: string | undefined;
        try {
          state = id === null ? null : isServer ? await readServer(ctx, id) : await readGroup(ctx, id);
        } catch (error: unknown) {
          verifyError = error instanceof Error ? error.message : String(error);
        }

        const expectedExists = !DELETE_ACTIONS.has(action);
        const drift =
          state === null || state.exists === expectedExists
            ? null
            : {
                field: 'exists',
                expected: expectedExists,
                observed: state.exists,
                note:
                  'SHM ответил успехом, но строка этого не показывает. Для удаления это обычно ' +
                  'значит, что объект ещё на что-то ссылается; повторять вслепую не нужно — ' +
                  'сначала посмотрите, кто на него ссылается.',
              };

        return {
          action,
          [idField]: id,
          state,
          ...(drift === null ? {} : { drift }),
          ...(verifyError === undefined ? {} : { verify_error: verifyError }),
        };
      },
    },
    deps,
  );
}

/**
 * Текущие настройки сервера НЕредактированным каналом — единственное место, где
 * инструменту нужны сами значения, а не их имена. Результат уходит ровно в две
 * стороны: в тело запроса (слияние) и в diff по одному ключу (там он проходит
 * маскировку по имени). Целиком наружу он не возвращается никогда.
 */
async function readSettings(
  ctx: ToolContext,
  before: Snapshot,
  id: number | undefined,
): Promise<Record<string, unknown>> {
  if (!before.exists || id === undefined) return {};
  const rows = await readRows(ctx, SERVERS, { server_id: id });
  const row = rows.find((one) => num(one.server_id) === id);
  const settings = row === undefined ? {} : settingsOf(row);
  // Если сюда всё-таки приехал маркер — значит чтение шло редактированным
  // каналом, и слияние записало бы его в SHM. Ловим здесь, а не в SHM.
  assertNoMaskedValues(settings, 'server_edit (чтение настроек)');
  return settings;
}
