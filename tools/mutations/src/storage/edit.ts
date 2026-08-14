import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import { STORAGE_PREFIX_VAR, ShmError, resolvePanelNaming } from '@hq/shm';
import {
  defaultBackupDir,
  readBackup,
  sha256Of,
  stableStringify,
  writeBackup,
} from '../backups.js';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationPlan } from '@hq/confirm';
import type { PanelNaming, PrefixSource } from '@hq/shm';
import type { ToolContext } from '@hq/types';
import type { MutationDeps, MutationTool, PlanDraft } from '../kit.js';

/**
 * СПИСОК ЗАКРЫТЫЙ — НО СОБИРАЕТСЯ ПО ЭТОЙ ИНСТАЛЛЯЦИИ, А НЕ ПО ТОЙ, ГДЕ ЕГО
 * ПИСАЛИ.
 *
 * В storage работающей установки лежат тысячи строк, и подавляющее большинство
 * — служебные счётчики воркеров (`wh_hwid_stats`, `wh_traffic_stats`,
 * `whevt_seen`, `wh_revoke_log_*`).
 * Именно контенция на общей строке `storage(wh_hwid_stats)` уже подвешивала
 * core: правка таких ключей руками инструмента добавляет писателя туда,
 * где писателей и так слишком много. Поэтому разрешены ровно два вида ключей,
 * адресуемых клиентом, — и у них РАЗНОЕ происхождение, что и было главной
 * ошибкой прежней версии, склеивавшей оба в один прибитый гвоздями литерал
 * `/^(?:vpn_mrzb_\d+|wbap_device_names)$/`:
 *
 *  1. СНИМОК КОНФИГУРАЦИИ УСЛУГИ — производная от префикса, который шаблон
 *     провижининга ВЫЧИСЛЯЕТ (`config.remnawave.storage_prefix || "vpn_mrzb_"`).
 *     У другой инсталляции он другой, и прибитый `vpn_mrzb_` отказывал бы там
 *     писать по совершенно правильному ключу. Берётся из `resolvePanelNaming`
 *     — тем же чтением, каким его берут читающие инструменты, чтобы «куда
 *     смотрит diagnose» и «куда готов писать edit» не разъехались.
 *  2. КЛЮЧ ПРИЛОЖЕНИЯ (`wbap_device_names`) — НЕ производная префикса и
 *     никакой живой системой не подтверждается: его пишет мини-апп
 *     (`wbap/src/lib/api/deviceNames.ts`), имя выбрано в его коде, и в SHM нет
 *     строки, у которой это имя можно было бы спросить. Вывести его неоткуда,
 *     поэтому он остаётся ЛИТЕРАЛОМ — но настраиваемым: у чужой установки
 *     мини-апп другой, а значит и ключ другой. Дефолт — этот, замена целиком —
 *     HQ_MCP_STORAGE_APP_KEYS.
 */
export const STORAGE_APP_KEYS_VAR = 'HQ_MCP_STORAGE_APP_KEYS';
export const DEFAULT_STORAGE_APP_KEYS: readonly string[] = ['wbap_device_names'];

/**
 * ГРАНИЦА, КОТОРУЮ НАСТРОЙКА НЕ ДВИГАЕТ.
 *
 * Разрешительный список — предохранитель, и расширяемый предохранитель обязан
 * иметь то, чего расширение не касается. Строки `wh_*`/`whevt_*` пишут сами
 * воркеры (счётчики hwid, трафика, журнал revoke, отметки обработанных
 * вебхуков); именно на них случилась контенция, подвесившая core. Оператор,
 * вписавший такое имя в HQ_MCP_STORAGE_APP_KEYS, почти наверняка не знает этой
 * истории — и узнаёт из отказа, а не из инцидента. То же правило действует и
 * на префикс: `HQ_MCP_STORAGE_PREFIX=wh_` не превращает счётчики воркеров в
 * записываемые ключи.
 */
const WORKER_KEY_RE = /^whevt_|^wh_/;

/** Экранирование префикса: он приходит из окружения и живого конфига. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STORAGE_PREFIX_HINT =
  `config.remnawave.storage_prefix в самой SHM (или ${STORAGE_PREFIX_VAR}, если панель уже ` +
  `носит другие имена), а список ключей приложений — ${STORAGE_APP_KEYS_VAR}`;

/** Откуда взялся префикс — «дефолт» значит «ни одна живая система не подтверждала». */
function prefixOrigin(source: PrefixSource): string {
  if (source === 'env') return `задан в ${STORAGE_PREFIX_VAR}`;
  if (source === 'shm_config') return 'прочитан из config.remnawave этой SHM в момент вызова';
  return 'взят из умолчания шаблона провижининга и живой системой не подтверждён';
}

export interface StorageAllowlist {
  /** Префикс снимка конфигурации услуги и откуда он взялся. */
  prefix: string;
  prefixFrom: PrefixSource;
  /** Ключи приложений и откуда взялись они. */
  appKeys: readonly string[];
  appKeysFrom: 'env' | 'default';
  /** Имена, отвергнутые как служебные строки воркеров, — чтобы сказать вслух. */
  refusedAppKeys: readonly string[];
  allows(name: string): boolean;
  /** Человеческое «что сюда можно» для отказа. */
  summary(): string;
}

/**
 * Сборка списка по разрешённому именованию. Отдельная функция, а не выражение
 * внутри `plan`, ровно затем, чтобы её можно было проверить тестом на том, что
 * она НЕ ПУСКАЕТ: у предохранителя интересна не разрешающая половина.
 */
export function storageAllowlist(
  naming: PanelNaming,
  env: NodeJS.ProcessEnv = process.env,
): StorageAllowlist {
  const raw = (env[STORAGE_APP_KEYS_VAR] ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '');
  const fromEnv = raw.length > 0;
  const candidates = fromEnv ? [...new Set(raw)] : DEFAULT_STORAGE_APP_KEYS;
  const appKeys = candidates.filter((one) => !WORKER_KEY_RE.test(one));
  const refusedAppKeys = candidates.filter((one) => WORKER_KEY_RE.test(one));

  // Префикс экранируется, иначе точка или скобка в нём превратили бы
  // разрешительный список в существенно более широкий: `vpn.` без экранирования
  // пустил бы и `vpnX9996`, а имя ключа приходит от вызывающего.
  const snapshot = new RegExp(`^${escapeRe(naming.storagePrefix)}\\d+$`);

  return {
    prefix: naming.storagePrefix,
    prefixFrom: naming.storagePrefixFrom,
    appKeys,
    appKeysFrom: fromEnv ? 'env' : 'default',
    refusedAppKeys,
    allows: (name: string): boolean => {
      // Запрет воркерских строк проверяется ПЕРВЫМ и не зависит ни от чего:
      // им не может открыть дорогу ни настройка ключей, ни настройка префикса.
      if (WORKER_KEY_RE.test(name)) return false;
      return snapshot.test(name) || appKeys.includes(name);
    },
    summary: (): string =>
      `${naming.storagePrefix}<user_service_id>` +
      (appKeys.length === 0 ? '' : ` или ${appKeys.join(', ')}`),
  };
}

/**
 * ЕДИНСТВЕННАЯ форма маршрута, которая работает у АДМИНА, и это не то же самое,
 * чем пользуется веб-клиент.
 *
 * Разбирались по исходнику (`app/public_html/shm/v1.cgi`), потому что разница
 * не видна ни из swagger, ни из кода фронта:
 *
 *  1. У `/admin/storage/manage/*` (имя в пути) объявлены только GET, POST и
 *     DELETE. **PUT там нет вовсе** — роутер такой маршрут не соединяет, и
 *     запрос уходит в 404 «Method not found». Создать ключ можно только через
 *     `/admin/storage/manage` с именем в ТЕЛЕ.
 *  2. Клиентские `/storage/manage/*` PUT и POST объявлены со
 *     `skip_auto_parse_json => 1` — поэтому веб-клиент (wbap, deviceNames.ts)
 *     шлёт голое значение телом, и SHM берёт его из `PUTDATA`/`POSTDATA`.
 *     У АДМИНСКИХ маршрутов этого флага НЕТ: `parse_args` разбирает JSON в
 *     `%in` и `delete $in{POSTDATA}` — то есть голое значение телом означало бы
 *     `$args{data} = undef` и запись NULL поверх снимка конфигурации клиента.
 *  3. `Core::Storage::_add_or_replace` кодирует значение сам и только если
 *     `ref $args{data}` истинно. Значит значение обязано приехать полем `data`
 *     и обязано быть объектом или массивом.
 *
 * Из этих трёх фактов и собран путь: один литерал, имя ключа в теле.
 */
const STORAGE_PATH = '/admin/storage/manage';

const REDACTION_MARKER_RE = /<redacted[:>]/;

interface StorageValue {
  exists: boolean;
  value: unknown;
  bytes: number;
  sha256: string;
}

interface StorageBefore {
  name: string;
  user_id: number;
  exists: boolean;
  bytes: number | null;
  sha256: string | null;
  /** `settings.json` строки storage: 1 — значение читается объектом, иначе строкой. */
  stored_as_json: boolean | null;
}

interface StorageAfter {
  name: string;
  user_id: number;
  bytes: number;
  sha256: string;
  source: 'value' | 'restore';
  /**
   * Новое значение — ТОЛЬКО когда его прислал вызывающий. На пути
   * восстановления его здесь нет: `after` уезжает в ответ модели, а снимок
   * `vpn_mrzb_*` несёт `trojanPassword`, `ssPassword`, `vlessUuid` и 5944
   * символа готового конфига в `subscription_config`, у которого нет имени, по
   * которому редакция могла бы его замаскировать.
   */
  value?: unknown;
  restore_from?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  if (typeof value === 'object') return `object(${String(Object.keys(value).length)})`;
  if (typeof value === 'string') return `string(${String(value.length)})`;
  return typeof value;
}

function measure(value: unknown): { bytes: number; sha256: string } {
  const json = stableStringify(value);
  return { bytes: Buffer.byteLength(json, 'utf8'), sha256: sha256Of(json) };
}

/**
 * ОЧЕРТАНИЕ значения вместо самого значения — то, из чего строится diff.
 *
 * Показать содержимое здесь нельзя, и это не перестраховка: `vpn_mrzb_*`
 * хранит объект пользователя панели целиком. `trojanPassword` и `ssPassword`
 * редакция замаскирует по имени, а `subscription_config` — нет: это одна
 * строка на 5944 символа, внутри которой лежат живые ссылки клиента, и ни
 * одно правило по имени поля её не видит. Поэтому diff отвечает на вопрос
 * «что структурно меняется» — сколько байт, какие ключи верхнего уровня
 * появились, исчезли или изменились, — и не отвечает на вопрос «что там
 * написано». Второй вопрос решается ДО вызова, чтением того, что вы
 * собираетесь заменить.
 */
function outline(value: unknown): Record<string, unknown> {
  const total = measure(value);
  const out: Record<string, unknown> = {
    shape: shapeOf(value),
    bytes: total.bytes,
    sha256: total.sha256,
  };
  if (isPlainObject(value)) {
    const fields: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      const one = measure(item);
      fields[field] = `${shapeOf(item)} ${String(one.bytes)}b sha256:${one.sha256.slice(0, 12)}`;
    }
    out.fields = fields;
  }
  return out;
}

/**
 * Значение НЕредактированным каналом — единственная причина, по которой этот
 * инструмент вообще пользуется `getRaw`.
 *
 * Прочитанное отсюда уходит в снимок отката, и маска в снимке — это маска,
 * записанная обратно в снимок конфигурации клиента. `trojanPassword:
 * '<redacted>'` в `vpn_mrzb_*` не «портит отчёт», он уничтожает доступ: этим
 * снимком пользуется провижининг, а починить его после записи можно только
 * перевыпуском.
 *
 * Отсутствующий ключ SHM отдаёт как 200 с ПУСТЫМ телом (проверено на
 * работающей SHM), то есть `undefined`, а не 404.
 */
async function readValue(ctx: ToolContext, key: string, userId: number): Promise<StorageValue> {
  const value = await ctx.shm.getRaw<unknown>(`${STORAGE_PATH}/${key}`, { user_id: userId });
  if (value === undefined || value === null || value === '') {
    return { exists: false, value: null, bytes: 0, sha256: '' };
  }
  return { exists: true, value, ...measure(value) };
}

/**
 * Метаданные строки: `Core::Storage::list_for_api` вырезает `data` из каждой
 * строки, поэтому список отвечает на вопрос «строка есть?» и «как она
 * хранится?», не таща значение. Отличать «ключа нет» от «ключ есть и пуст»
 * иначе нечем, а именно это решает, каким методом писать.
 */
async function readMeta(
  ctx: ToolContext,
  key: string,
  userId: number,
): Promise<{ row: boolean; storedAsJson: boolean | null }> {
  const page = await ctx.shm.list<Record<string, unknown>>(STORAGE_PATH, {
    user_id: userId,
    name: key,
    limit: 5,
  });
  const row = page.data.find((one) => String(asRecord(one).name) === key);
  if (row === undefined) return { row: false, storedAsJson: null };
  const settings = asRecord(asRecord(row).settings);
  return { row: true, storedAsJson: settings.json === 1 || settings.json === '1' };
}

function findMarker(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') {
    return REDACTION_MARKER_RE.test(value) ? path : null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const hit = findMarker(item, `${path}.${key}`);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * ЕДИНСТВЕННАЯ проверка, ради которой этот инструмент существует в таком виде.
 *
 * Значение приходит от модели, а модель читает мир через инструменты, которые
 * маскируют: `subscription_inspect`, `client_overview`, любой ответ через
 * `executeTool`. Read-modify-write, собранный из такого чтения, приносит сюда
 * `trojanPassword: '<redacted>'` — и запись уничтожает доступ клиента ровно
 * тем, что выглядит как аккуратная правка одного поля. Отказ обязан стоять ДО
 * запроса и обязан называть путь до найденной маски.
 */
function assertNoMasks(value: unknown, key: string): void {
  const hit = findMarker(value);
  if (hit === null) return;
  throw new Error(
    `storage_edit: значение содержит маркер редакции по пути ${hit} и записано не будет. ` +
      'Так выглядит значение, полученное из ЛЮБОГО читающего инструмента этого сервера: §7.2 ' +
      `маскирует trojanPassword, ssPassword и vlessUuid по имени поля. Записав такое в ${key}, ` +
      'вы заменили бы живые креды клиента строкой "<redacted>" — подписка перестала бы работать, ' +
      'и починка была бы только перевыпуском. Если нужно вернуть прежнее значение — это ' +
      'restore_from со снимком, который инструмент снял перед предыдущей записью: он читается с ' +
      'диска нередактированным и через контекст модели не проходит.',
  );
}

function assertWritableValue(value: unknown, key: string): void {
  if (value === undefined) {
    throw new Error(`storage_edit: value обязателен (ключ ${key})`);
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new Error(
      `storage_edit: значение должно быть объектом или массивом, а пришло ${shapeOf(value)}. ` +
        'Скаляр записать НЕЛЬЗЯ, и это свойство админского маршрута, а не осторожность: ' +
        '`Core::Storage::_add_or_replace` кодирует значение сам только при `ref $args{data}`, ' +
        'иначе берёт его из PUTDATA/POSTDATA — а `parse_args` их удаляет, как только тело ' +
        'разобралось как JSON (у админских маршрутов нет skip_auto_parse_json, в отличие от ' +
        'клиентских). Скаляр молча лёг бы в базу как NULL поверх прежнего значения.',
    );
  }
  assertNoMasks(value, key);
}

function beforeOf(plan: MutationPlan): StorageBefore {
  const raw = asRecord(plan.before);
  return {
    name: String(raw.name ?? ''),
    user_id: typeof raw.user_id === 'number' ? raw.user_id : 0,
    exists: raw.exists === true,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : null,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
    stored_as_json: typeof raw.stored_as_json === 'boolean' ? raw.stored_as_json : null,
  };
}

function afterOf(plan: MutationPlan): StorageAfter {
  const raw = asRecord(plan.after);
  return {
    name: String(raw.name ?? ''),
    user_id: typeof raw.user_id === 'number' ? raw.user_id : 0,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
    source: raw.source === 'restore' ? 'restore' : 'value',
    ...('value' in raw ? { value: raw.value } : {}),
    ...(typeof raw.restore_from === 'string' ? { restore_from: raw.restore_from } : {}),
  };
}

const input = z.object({
  /**
   * ПОЛЕ НАЗЫВАЕТСЯ `name`, А НЕ `key`, И ЭТО НЕ ВКУСОВЩИНА.
   *
   * `SECRET_KEY_RE` в @hq/redact — это /token|secret|key|password|auth/i по
   * ИМЕНИ поля, и подстрока `key` матчится буквально. Поле `key` доезжало бы до
   * модели как '<redacted>' в плане, в ответе применения и в журнале мутаций —
   * то есть журнал не сказал бы, КАКОЙ ключ переписали. Проверено на живом
   * `executeTool`, а не рассуждением: первая версия этого инструмента
   * возвращала ровно `"key":"<redacted>"`. `name` — к тому же имя этого поля в
   * самой SHM (`Core::Storage::structure`).
   */
  /**
   * Описание НЕ называет префикс литералом: он свой у каждой инсталляции и
   * известен только на вызове (`resolvePanelNaming`), а схема строится при
   * сборке. Названный здесь `vpn_mrzb_` был бы подсказкой, верной ровно на том
   * развёртывании, где её писали. Точный список отдаёт отказ — он строится по
   * живому значению и называет и префикс, и его происхождение.
   */
  name: z
    .string()
    .describe(
      'Ключ storage: снимок конфигурации услуги <storage_prefix><user_service_id> (префикс этой ' +
        'инсталляции, по умолчанию vpn_mrzb_) либо один из настроенных ключей приложений (по ' +
        'умолчанию wbap_device_names). Других ключей инструмент не пишет; отказ называет точный ' +
        'список.',
    ),
  user_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Владелец ключа. Админ ходит в клиентский storage через switch_user, поэтому без user_id ' +
        'запись легла бы в storage админа, а не клиента.',
    ),
  value: z
    .unknown()
    .optional()
    .describe(
      'Новое значение ЦЕЛИКОМ: storage перезаписывается полностью, merge на стороне SHM нет. ' +
        'Только объект или массив. Значение с маркерами <redacted> отвергается.',
    ),
  restore_from: z
    .string()
    .optional()
    .describe(
      'Путь к снимку, снятому этим же инструментом перед предыдущей записью. Взаимоисключающ с ' +
        'value и существует затем, чтобы вернуть прежнее значение, НЕ протаскивая ключи клиента ' +
        'через контекст модели.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

export function storageEdit(deps: MutationDeps, backupDir = defaultBackupDir()): MutationTool {
  return defineMutation<Input>(
    {
      name: 'storage_edit',
      description:
        'Запись пользовательского storage SHM. Список ключей закрыт и собирается по ЭТОЙ ' +
        'инсталляции: снимок конфигурации услуги <storage_prefix><user_service_id> — префикс ' +
        'читается из config.remnawave самой SHM в момент вызова (умолчание шаблона vpn_mrzb_) — плюс ' +
        'настроенные ключи приложений (умолчание wbap_device_names). Служебные строки воркеров ' +
        '(wh_*, whevt_*) не открываются никакой настройкой. ' +
        'Значение перезаписывается ЦЕЛИКОМ — merge на стороне SHM нет. PUT создаёт (400, если ' +
        'ключ уже есть), POST заменяет (404, если ключа нет); инструмент выбирает метод по ' +
        'прочитанному состоянию и делает РОВНО ОДИН фолбэк на второй, закрывая гонку. Перед ' +
        'записью прежнее значение уходит в локальный снимок, вернуть его — тем же инструментом ' +
        'по restore_from. Значение с маркерами <redacted> не записывается никогда: это ' +
        'разрушило бы доступ клиента. План показывает ОЧЕРТАНИЕ (байты, ключи, sha256), а не ' +
        'содержимое: в снимке конфигурации услуги лежат живые ключи подписки. Без plan_id ничего ' +
        'не меняет.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [
        `GET ${STORAGE_PATH}`,
        `GET ${STORAGE_PATH}/{name}`,
        `PUT ${STORAGE_PATH}`,
        `POST ${STORAGE_PATH}`,
      ],
      target: (i) => ({ system: 'shm', id: i.user_id }),
      guard: {
        // `exists` — ключ создали или снесли между планом и применением (от
        // этого зависит МЕТОД записи); `sha256` — значение переписал кто-то
        // ещё, и наша запись стёрла бы его целиком, потому что merge здесь нет.
        keys: ['exists', 'sha256'],
        read: async (plan, ctx) => {
          const before = beforeOf(plan);
          const now = await readValue(ctx, before.name, before.user_id);
          return { exists: now.exists, sha256: now.exists ? now.sha256 : null };
        },
      },

      plan: async (i, ctx): Promise<PlanDraft> => {
        const naming = await resolvePanelNaming(ctx);
        const allow = storageAllowlist(naming);
        if (!allow.allows(i.name)) {
          throw new Error(
            `storage_edit: ключ ${i.name} вне allowlist (${allow.summary()}). Префикс снимка ` +
              `конфигурации услуги на этой инсталляции — ${JSON.stringify(allow.prefix)}, и он ` +
              `${prefixOrigin(allow.prefixFrom)}: если ключ верный, а список — нет, поправляйте ` +
              `не ключ, а ${STORAGE_PREFIX_HINT}. Служебные ключи воркеров (wh_hwid_stats, ` +
              'wh_traffic_stats, whevt_seen, wh_revoke_log_*) не открываются никакой настройкой ' +
              'и правятся только руками: их пишут сами воркеры, и контенция на общей строке ' +
              'storage уже подвешивала core.' +
              (allow.refusedAppKeys.length === 0
                ? ''
                : ` Из ${STORAGE_APP_KEYS_VAR} отброшены как строки воркеров: ` +
                  `${allow.refusedAppKeys.join(', ')}.`),
          );
        }

        const sources = (i.value === undefined ? 0 : 1) + (i.restore_from === undefined ? 0 : 1);
        if (sources !== 1) {
          throw new Error(
            'storage_edit: нужно ровно одно из value или restore_from. Два источника значения в ' +
              'одном вызове — это вопрос «какой из них победил», на который ответ виден только ' +
              'после записи.',
          );
        }

        const current = await readValue(ctx, i.name, i.user_id);
        const meta = await readMeta(ctx, i.name, i.user_id);

        let value: unknown;
        let after: StorageAfter;
        if (i.restore_from !== undefined) {
          const snapshot = await readBackup(backupDir, i.restore_from, {
            kind: 'storage',
            target: `${String(i.user_id)}:${i.name}`,
          });
          if (snapshot.payload === null) {
            throw new Error(
              `storage_edit: снимок ${i.restore_from} снят с НЕСУЩЕСТВОВАВШЕГО ключа — вернуть ` +
                'это состояние значит удалить строку, а удаления storage у этого сервера нет ' +
                '(DELETE не объявлен ни одним инструментом).',
            );
          }
          value = snapshot.payload;
          after = {
            name: i.name,
            user_id: i.user_id,
            ...measure(value),
            source: 'restore',
            restore_from: i.restore_from,
          };
        } else {
          value = i.value;
          after = {
            name: i.name,
            user_id: i.user_id,
            ...measure(value),
            source: 'value',
            value,
          };
        }

        assertWritableValue(value, i.name);

        if (current.exists && current.sha256 === after.sha256) {
          throw new Error(
            `storage_edit: новое значение ${i.name} совпадает с текущим — записывать нечего.`,
          );
        }

        const before: StorageBefore = {
          name: i.name,
          user_id: i.user_id,
          exists: current.exists,
          bytes: current.exists ? current.bytes : null,
          sha256: current.exists ? current.sha256 : null,
          stored_as_json: meta.storedAsJson,
        };

        return {
          before,
          after,
          diff: buildDiff(
            current.exists ? outline(current.value) : { shape: 'absent' },
            outline(value),
            ctx.profile,
          ),
          sideEffects: sideEffects({
            name: i.name,
            allow,
            userId: i.user_id,
            exists: current.exists,
            row: meta.row,
            storedAsJson: meta.storedAsJson,
            backupDir,
            after,
          }),
        };
      },

      apply: async (plan, ctx) => {
        const before = beforeOf(plan);
        const after = afterOf(plan);

        let value: unknown;
        if (after.source === 'restore') {
          // Снимок читается ЗАНОВО: прежнее значение не имеет права лежать в
          // `after`, потому что `after` уезжает модели.
          const snapshot = await readBackup(backupDir, after.restore_from ?? '', {
            kind: 'storage',
            target: `${String(after.user_id)}:${after.name}`,
          });
          value = snapshot.payload;
        } else {
          value = after.value;
        }
        const check = measure(value);
        if (check.sha256 !== after.sha256) {
          throw new Error(
            'storage_edit: значение, которое собираемся записать, не совпадает с планом (sha256 ' +
              'разошлись). Для restore_from это означает, что файл снимка изменили после ' +
              'построения плана. Постройте план заново.',
          );
        }
        assertWritableValue(value, after.name);

        const current = await readValue(ctx, after.name, after.user_id);
        if (current.exists !== before.exists || current.sha256 !== (before.sha256 ?? '')) {
          throw new Error(
            `storage_edit: значение ${after.name} изменилось между планом и применением. Запись ` +
              'поверх чужой правки стёрла бы её целиком: merge здесь нет (§7.4).',
          );
        }

        const backup = await writeBackup(backupDir, {
          kind: 'storage',
          target: `${String(after.user_id)}:${after.name}`,
          savedAt: ctx.now().toISOString(),
          bytes: current.bytes,
          sha256: current.exists ? current.sha256 : '',
          // null — «ключа не было». Восстановление из такого снимка отвергается
          // явно: вернуть отсутствие строки можно только удалением, которого у
          // этого сервера нет.
          payload: current.exists ? current.value : null,
        });

        const primary: 'PUT' | 'POST' = current.exists ? 'POST' : 'PUT';
        const fallback: 'PUT' | 'POST' = current.exists ? 'PUT' : 'POST';
        const body = { user_id: after.user_id, name: after.name, data: value };

        let method = primary;
        let usedFallback = false;
        let primaryError: string | undefined;
        try {
          await ctx.shm.action<unknown>(primary, STORAGE_PATH, body);
        } catch (error: unknown) {
          // РОВНО ОДИН фолбэк, и он закрывает одну конкретную гонку: ключ
          // создали или снесли между чтением и записью. Второй провал уходит
          // наружу как есть — цикл «попробуем ещё раз другим методом» на
          // ручке без идемпотентности превращается в неограниченную запись.
          // 408 сюда не попадает вообще: его повторяет каркас тем же методом.
          if (error instanceof ShmError && error.status === 408) throw error;
          primaryError = error instanceof Error ? error.message : String(error);
          await ctx.shm.action<unknown>(fallback, STORAGE_PATH, body);
          method = fallback;
          usedFallback = true;
        }

        let observed: StorageValue | null = null;
        let verifyError: string | undefined;
        try {
          observed = await readValue(ctx, after.name, after.user_id);
        } catch (error: unknown) {
          verifyError = error instanceof Error ? error.message : String(error);
        }
        const drift =
          observed === null || observed.sha256 === after.sha256
            ? null
            : {
                expected_sha256: after.sha256,
                observed_sha256: observed.exists ? observed.sha256 : null,
                observed_bytes: observed.bytes,
                note:
                  'SHM ответил успехом, но перечитанное значение отличается от планового. Самая ' +
                  'частая причина — settings.json у строки не выставлен, и значение вернулось ' +
                  'строкой, а не объектом. Не повторяйте вслепую: прежнее значение лежит в ' +
                  'снимке по пути backup.',
              };

        return {
          name: after.name,
          user_id: after.user_id,
          method,
          fallback: usedFallback,
          bytes: after.bytes,
          sha256: after.sha256,
          backup,
          previous: { exists: before.exists, bytes: before.bytes, sha256: before.sha256 },
          restore_hint:
            `Вернуть прежнее значение: storage_edit { "name": ${JSON.stringify(after.name)}, ` +
            `"user_id": ${String(after.user_id)}, "restore_from": ${JSON.stringify(backup)} }`,
          ...(primaryError === undefined ? {} : { primary_error: primaryError }),
          ...(drift === null ? {} : { drift }),
          ...(verifyError === undefined ? {} : { verify_error: verifyError }),
        };
      },
    },
    deps,
  );
}

function sideEffects(opts: {
  name: string;
  allow: StorageAllowlist;
  userId: number;
  exists: boolean;
  row: boolean;
  storedAsJson: boolean | null;
  backupDir: string;
  after: StorageAfter;
}): string[] {
  const out: string[] = [
    `Значение перезаписывается ЦЕЛИКОМ: merge на стороне SHM отсутствует, «дописать одно поле» ` +
      'здесь означает прислать весь объект вместе с этим полем.',
    `Ключ ${opts.exists ? 'существует' : 'отсутствует'}, поэтому основной метод — ` +
      `${opts.exists ? 'POST' : 'PUT'}, с ОДНИМ фолбэком на второй, если между чтением и записью ` +
      'его создали или снесли с другого устройства.',
    'Перед записью прежнее значение уходит снимком в ' +
      `${opts.backupDir} (0700/0600), путь вернётся в ответе, вернуть его — этим же инструментом ` +
      'с restore_from. Записи без снимка не бывает.',
    'Запись берёт строку storage под лок на 3 секунды и отвечает 408, если не взяла; это ' +
      'единственный статус, на который каркас повторяет запрос.',
    'user_id уходит ПОЛЕМ ТЕЛА вместе с именем ключа, а не в пути: у админского ' +
      '/admin/storage/manage/{name} нет маршрута PUT вовсе, а значение обязано приехать полем ' +
      '`data` объектом — иначе SHM запишет NULL (см. доккомментарий STORAGE_PATH).',
  ];
  // Не по литералу `vpn_mrzb_`: снимок узнаётся по префиксу ЭТОЙ инсталляции,
  // иначе на развёртывании со своим storage_prefix самое важное из
  // предупреждений молча не печаталось бы.
  if (opts.name.startsWith(opts.allow.prefix)) {
    out.push(
      'ЭТО СНИМОК КОНФИГУРАЦИИ УСЛУГИ. Из него работает провижининг и им же отвечают клиентские ' +
        'экраны: внутри объект пользователя панели (trojanPassword, ssPassword, vlessUuid, ' +
        'subscriptionUrl) и готовый конфиг подписки строкой. Неполное значение здесь не «портит ' +
        'отчёт», а рвёт клиенту доступ, и починка — перевыпуск.',
    );
  }
  if (opts.row && opts.storedAsJson === false) {
    out.push(
      'У строки storage НЕ выставлен settings.json, а замена (POST) его не выставляет: ' +
        '`_add_or_replace` в ветке set передаёт в `_set` только `data`. Значение уйдёт ' +
        'закодированным JSON, а прочитается СТРОКОЙ. Если ключ должен читаться объектом — ' +
        'строку надо пересоздавать, а не заменять.',
    );
  }
  if (!opts.row && opts.exists) {
    out.push(
      'Список storage строки не показал, а чтение значение вернуло — состояния разошлись. ' +
        'Скорее всего строка создана прямо сейчас; метод будет выбран по чтению, фолбэк закроет ' +
        'ошибку.',
    );
  }
  if (opts.after.source === 'restore') {
    out.unshift(
      `Восстановление из снимка ${String(opts.after.restore_from)}: значение берётся с диска и в ` +
        'контекст модели не попадает — ни в плане, ни в ответе применения его нет намеренно.',
    );
  }
  return out;
}
