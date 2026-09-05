import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { ProbeResult, RemnaRuntimeHealth, TcpProbe, ToolDef, TunnelConfig } from '@hq/types';
import { catalogCapability } from './capabilities.js';
import {
  MIN_REMNA_VERSION,
  MIN_SHM_VERSION,
  REMNA_TOP_LIMIT,
  asArray,
  asRecord,
  num,
  settle,
  spoolStatusName,
  str,
  versionBelow,
  warn,
} from '../kit.js';

const TTL_MS = 5 * 60 * 1000;
const TUNNEL_TIMEOUT_MS = 1_500;

/**
 * Значение, которого не может быть ни в одном имени пользователя панели. Живые
 * имена собираются провижинингом как `<префикс><id услуги>`
 * (resolvePanelNaming в kit.ts), то есть буквы, цифра и подчёркивание — совпасть с
 * этим нельзя. Постоянная строка, а не случайная: проба должна быть
 * воспроизводимой, а её след в логах панели — узнаваемым.
 */
const NO_SUCH_USERNAME = '__hq_mcp_probe_no_such_username__';

/** Аптайм моложе TTL кэша пробы: перезапуск, который кэш успел бы проглотить. */
const RESTART_WINDOW_S = TTL_MS / 1000;

/** Ничего не проверено — это НЕ «возможности нет». */
export const UNKNOWN_CAPABILITIES: ProbeResult['capabilities'] = {
  'shm.filter': 'unknown',
  'shm.dry_run': 'unknown',
  'remna.subscriptionRequestHistory': 'unknown',
  'remna.realtimeBandwidth': 'unknown',
  'remna.nodeIntegrations': 'unknown',
  'remna.sharedLists': 'unknown',
  'tunnel.mysql': 'unknown',
  'tunnel.postgres': 'unknown',
  'tunnel.abuse': 'unknown',
};

let cache: { at: number; value: ProbeResult } | null = null;

export function resetProbeCache(): void {
  cache = null;
}

/** Итог одной пробы возможности: значение при успехе, вердикт при отказе. */
type CapabilityProbe<T> = { ok: true; value: T } |
  { ok: false; verdict: false | 'unknown'; status?: number };

/**
 * Классифицирует отказ, а не факт отказа: `settle()` стирает исходную ошибку в
 * строку и для reachability этого достаточно, но для возможности важно, что
 * именно доказал бэкенд.
 *
 * - `false` — бэкенд отверг параметр (400) или маршрут (404). Это и
 *   есть ответ на вопрос «поддерживается ли возможность».
 * - `'unknown'` — доказано НИЧЕГО: сетевой сбой или таймаут без статуса вовсе,
 *   оборванный запрос, либо 5xx. 5xx означает «сервер сломан прямо сейчас», а
 *   не «возможности нет» — битый деплой не имеет права молча урезать набор
 *   инструментов на 5 минут (TTL кэша).
 *
 * Локальный хелпер, а не расширение контракта `settle`: `ShmError`/`RemnaError`
 * уже несут `status`, и различение нужно только здесь, у трёх проб возможностей.
 */
function statusOf(error: unknown): number | undefined {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status: unknown }).status
      : undefined;
  return typeof status === 'number' ? status : undefined;
}

function classifyRejection(error: unknown): false | 'unknown' {
  const status = statusOf(error);
  return status === 400 || status === 404 ? false : 'unknown';
}

/** Как `settle`, но сохраняет статус: `settle` стирает ошибку в строку. */
type SettledHttp<T> =
  | { ok: true; value: T; status: undefined }
  | { ok: false; error: string; status: number | undefined };

async function settleHttp<T>(promise: Promise<T>): Promise<SettledHttp<T>> {
  try {
    return { ok: true, value: await promise, status: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: statusOf(error),
    };
  }
}

/**
 * Ничего не спрашивали, потому что спрашивать негде: этой системы в
 * развёртывании нет. Отдельно от `settleHttp` по смыслу, а не по форме — ниже
 * такой исход превращается в `configured: false` и `error: null`, а НЕ в
 * `reachable: false` с текстом ошибки. Разница ровно та, ради которой поле
 * `configured` и заведено: «сюда никто не ходил» против «ходили и не дошли».
 */
const NOT_ASKED = 'not asked: this backend is not configured in this deployment';

function skipped<T>(): Promise<SettledHttp<T>> {
  return Promise.resolve({ ok: false, error: NOT_ASKED, status: undefined });
}

function skippedCapability<T>(): Promise<CapabilityProbe<T>> {
  return Promise.resolve({ ok: false, verdict: 'unknown' });
}

/**
 * Бэкенд ОТВЕТИЛ и отверг именно наши креды. Это ровно тот случай, который
 * прежняя проба сливала с отказом системы: живость SHM доказывалась АДМИНСКИМ
 * вызовом, поэтому просроченный пароль читался как «SHM недоступна», и оператор
 * шёл чинить исправное. Смотрим на СТАТУС, а не на текст: SHM отвечает
 * по-русски и версионно, панель — 'Unauthorized', и разбор строк здесь ломается
 * на первом же релизе.
 */
function credentialsRejected(result: SettledHttp<unknown>): boolean {
  return !result.ok && (result.status === 401 || result.status === 403);
}

/**
 * Сводка ручки здоровья панели. Аптайм берётся по САМОМУ МОЛОДОМУ инстансу:
 * панель работает несколькими процессами, и перезапуск одного из них — уже
 * событие, объясняющее и оборванные запросы, и опустевшие кэши.
 */
function runtimeHealth(value: unknown): RemnaRuntimeHealth | null {
  const rows = asArray(asRecord(value).runtimeMetrics).map(asRecord);
  if (rows.length === 0) return null;
  const numbers = (key: string): number[] =>
    rows.map((row) => num(row[key], Number.NaN)).filter((one) => Number.isFinite(one));
  const uptimes = numbers('uptime');
  const delays = numbers('eventLoopDelayMs');
  return {
    instances: rows.length,
    youngestUptimeSeconds: uptimes.length === 0 ? null : Math.floor(Math.min(...uptimes)),
    worstEventLoopDelayMs: delays.length === 0 ? null : Math.max(...delays),
  };
}

async function probeCapability<T>(promise: Promise<T>): Promise<CapabilityProbe<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    const status = statusOf(error);
    return { ok: false, verdict: classifyRejection(error), ...(status === undefined ? {} : { status }) };
  }
}

/**
 * §9 + §11: спеки врут, поэтому контракт проверяется на живой системе, а
 * результат гейтит остальные инструменты. Probe — единственное место, где
 * открытые вопросы Q1/Q11/Q17 превращаются из допущения в факт.
 * Фабрика, а не константа: нужен инжектируемый TCP-пробник.
 */
export function createPlatformProbeTool(
  cfg: TunnelConfig,
  deps: { probeTcp: TcpProbe },
): ToolDef {
  return defineTool({
    name: 'platform_probe',
    description:
      'Which backends this deployment has, plus a liveness and capability probe of them. Each of ' +
      'the two systems is optional and at least one is configured, so `shm.configured` and ' +
      '`remna.configured` come first: they say whether a system exists here at all, and the tools ' +
      'that need a system this install does not have are not published — absent, not failing. ' +
      'Ask this before concluding that a capability is missing from the product. Then: ' +
      'reachability, versions, SHM spool ' +
      'statuses, panel process health, and which undocumented features actually work on ' +
      'production right now (server-side filter, the realtime bandwidth route, whether the panel ' +
      'records subscription-request history at all, node integration and shared-list catalogs, ' +
      'the ssh tunnels). Optional 3.3 APIs are checked independently of the base 3.0 floor. ' +
      'It separates "the backend ' +
      'is down" from "our credentials are wrong": SHM proves liveness on an unauthenticated ' +
      'healthcheck, and a 401/403 from either system is reported as credentialsRejected rather ' +
      'than as an outage. Cached for 5 minutes. Run it first when a tool fails in an unclear ' +
      'way, and run it before trusting anything: whatever OpenAPI file you hold for either ' +
      'system lags production and lies. It also states whether the two backends are new enough ' +
      `for the base tool set — SHM ${MIN_SHM_VERSION} and Remnawave ${MIN_REMNA_VERSION} are ` +
      'the floors, and a version ' +
      'below one of them is reported as a warning here rather than discovered later as an ' +
      'unexplained refusal.',
    input: z.object({
      refresh: z.boolean().default(false).describe('Ignore the 5-minute cache and re-check now'),
    }),
    access: 'ro',
    risk: 'none',
    profiles: ['human', 'bot'],
    // Ни одной — и это ГЛАВНОЕ его свойство в этой теме. Проба и есть то
    // место, где модель узнаёт форму развёртывания: какие системы настроены,
    // а какие нет. Инструмент, который исчезает вместе с бэкендом, ответить
    // на этот вопрос не может по построению.
    backends: [],
    handler: async ({ refresh }, ctx): Promise<ProbeResult> => {
      const nowMs = ctx.now().getTime();
      if (!refresh && cache !== null && nowMs - cache.at < TTL_MS) {
        const cached = { ...cache.value, cached: true };
        ctx.probe.set(cached);
        return cached;
      }

      /**
       * Какие системы у этой установки есть. Ни один запрос к ненастроенной
       * системе не отправляется: её клиент отказал бы внятно, но `reachable:
       * false` с текстом отказа читается как «система лежит», а лежать может
       * только то, что здесь стоит.
       */
      const shmOn = ctx.backends.shm;
      const remnaOn = ctx.backends.remna;

      const [
        statuses,
        metadata,
        shmConfig,
        filtered,
        realtime,
        shmAlive,
        panelHealth,
        panelConfig,
        userBaseline,
        userFiltered,
        integrations,
        sharedLists,
      ] = await Promise.all([
        shmOn ? settleHttp(ctx.shm.get<unknown>('/admin/spool/statuses')) : skipped<unknown>(),
        remnaOn ? settleHttp(ctx.remna.get<unknown>('/api/system/metadata')) : skipped<unknown>(),
        // Версия SHM берётся ОТТУДА ЖЕ, откуда её берёт сама SHM: Core/Swagger.pm
        // штампует `info.version` из строки конфига `_shm` в рантайме, а не из
        // образа. Поэтому число в приложенной спеке — это отпечаток чужого
        // стенда, а живое значение лежит здесь. Клиент редактирует секреты этой
        // строки сам (`cloud.auth` → <redacted>).
        shmOn ? settleHttp(ctx.shm.get<unknown>('/admin/config/_shm')) : skipped<unknown>(),
        // Q1: работает ли server-side filter. На нём построена ветка
        // include_blocked в client_search, и в обычной работе им никто не пользуется.
        shmOn
          ? probeCapability(
              ctx.shm.list<Record<string, unknown>>('/admin/user', {
                filter: JSON.stringify({ block: 1 }),
                limit: 1,
              }),
            )
          : skippedCapability<{ data: unknown[] }>(),
        // Q17: существует ли realtime-маршрут, который wbap зовёт и глотает 404.
        // Только topNodesLimit. topUsersLimit — параметр СОСЕДНЕГО маршрута
        // /api/bandwidth-stats/nodes/{uuid}/users; у /api/bandwidth-stats/nodes
        // объявлены ровно topNodesLimit+start+end, а у /api/system/stats —
        // пустой список параметров (схема API Remnawave). §6.17 говорит про
        // СЕМЕЙСТВО bandwidth-stats, и прочесть это как контракт одного маршрута
        // здесь особенно дорого: лишний параметр рискует вернуть 400, а 400 у нас
        // означает «возможности нет» (Task 9) — то есть проба объявила бы живой
        // маршрут отсутствующим и спрятала инструменты.
        remnaOn
          ? probeCapability(
              ctx.remna.get<unknown>('/api/bandwidth-stats/nodes/realtime', {
                topNodesLimit: REMNA_TOP_LIMIT,
              }),
            )
          : skippedCapability<unknown>(),
        /**
         * Живость SHM БЕЗ учётных данных. Ручка отвечает 200 и на пустой, и на
         * заведомо неверный Basic — проверено на работающей 2.19.4, а не по
         * спецификации, — поэтому её ответ доказывает, что жив сервер, а не что
         * верны креды.
         * Ровно этого различения пробе и не хватало: `reachable` доказывался
         * админским /admin/spool/statuses, который на протухшем пароле отдаёт
         * 401, и «SHM лежит» становилось выводом из проблемы с доступом.
         */
        shmOn ? settleHttp(ctx.shm.get<unknown>('/healthcheck')) : skipped<unknown>(),
        /**
         * Ручка здоровья панели. АВТОРИЗАЦИЮ ТРЕБУЕТ: без токена 200 не бывает,
         * проверено на работающей 3.2.3 (401 {"message":"Unauthorized"}). То есть
         * симметричного SHM-разделения «сервер лежит / креды не те» она НЕ даёт
         * и дать не может — это делает классификация статуса выше. Здесь она
         * ради того, чего больше нет нигде: сколько процессов у панели, как
         * давно перезапустился самый молодой и насколько просажен event loop.
         */
        remnaOn ? settleHttp(ctx.remna.get<unknown>('/api/system/health')) : skipped<unknown>(),
        /**
         * Собственные настройки панели (появились в 3.2.0). Единственный
         * источник ответа на вопрос, который subscription_inspect задать не мог:
         * ведётся ли журнал обращений за подпиской вообще. При выключенной
         * записи ручка истории отвечает 200 и пустым списком, то есть «клиент ни
         * разу не подключался» и «панель этого не пишет» неразличимы по её
         * ответу.
         */
        remnaOn ? settleHttp(ctx.remna.get<unknown>('/api/system/configuration')) : skipped<unknown>(),
        /**
         * Опорное число пользователей для пробы фильтра ниже. Нужно именно оно,
         * а не абстрактный успех: без него «фильтр вернул ноль» на пустой панели
         * означало бы «фильтр работает», не доказав ничего.
         */
        remnaOn
          ? settleHttp(ctx.remna.get<unknown>('/api/users', { size: 1, start: 0 }))
          : skipped<unknown>(),
        /**
         * НАСТОЯЩИЙ сужающий параметр `/api/users` — `filters`, массив
         * `{id, value}` в JSON. Здесь стоял `searchValue`, и это была проба,
         * которая не могла провалиться: схема запроса (TanstackQueryRequestQuery)
         * БАЙТ В БАЙТ одинакова на 2.8.1 и 3.2.3 и `searchValue` не содержала
         * никогда, а `z.object` нестрогий — незнакомый ключ молча выбрасывается,
         * запрос отвечает 200, и возможность рапортовалась `true` всегда.
         * Проверено на работающей панели, а не по спецификации: с `searchValue`
         * total не изменился вовсе, с `filters` по несуществующему имени стал 0,
         * а по status=DISABLED сузился до подмножества, где все строки
         * действительно DISABLED; несуществующее имя колонки панель тоже молча
         * игнорирует. Поэтому значение подставляется заведомо непопадающее, а
         * вывод делается по СРАВНЕНИЮ с опорным total, а не по коду ответа.
         */
        remnaOn
          ? settleHttp(
              ctx.remna.get<unknown>('/api/users', {
                size: 1,
                start: 0,
                filters: JSON.stringify([{ id: 'username', value: NO_SUCH_USERNAME }]),
              }),
            )
          : skipped<unknown>(),
        remnaOn ? settleHttp(ctx.remna.get<unknown>('/api/node-integrations')) : skipped<unknown>(),
        remnaOn ? settleHttp(ctx.remna.get<unknown>('/api/node-plugins/shared-lists')) : skipped<unknown>(),
      ]);

      const integrationAccess = catalogCapability(remnaOn, '/api/node-integrations', 'nodeIntegrations', integrations);
      const sharedListAccess = catalogCapability(remnaOn, '/api/node-plugins/shared-lists', 'sharedLists', sharedLists);

      const [pgOpen, mysqlOpen, abuseOpen] = await Promise.all([
        deps.probeTcp(cfg.postgres.host, cfg.postgres.port, TUNNEL_TIMEOUT_MS),
        cfg.mysql === null
          ? Promise.resolve(false)
          : deps.probeTcp(cfg.mysql.host, cfg.mysql.port, TUNNEL_TIMEOUT_MS),
        (async (): Promise<boolean> => {
          const url = new URL(cfg.abuseUrl);
          const port = url.port === '' ? 80 : Number(url.port);
          return deps.probeTcp(url.hostname, port, TUNNEL_TIMEOUT_MS);
        })(),
      ]);

      const metaRecord = metadata.ok ? asRecord(metadata.value) : {};
      // Ручка отдаёт СПИСОК строк конфига; нужна первая.
      const shmConfigRow = shmConfig.ok
        ? asRecord(asArray(shmConfig.value)[0] ?? shmConfig.value)
        : {};
      const shmVersion = shmConfig.ok ? str(shmConfigRow.version) : null;
      const remnaVersion = metadata.ok
        ? str(asRecord(metaRecord.app).version ?? metaRecord.version)
        : null;

      // Правило классификации: успех → true, отказ параметра/маршрута (400/404)
      // → false, «система не ответила базовой проверкой ИЛИ конкретный вызов
      // ничего не доказал» (права, лимит, сеть, таймаут, 5xx) → unknown. Смешивать
      // нельзя: 'unknown' оставляет инструмент видимым, false — прячет его.
      const filterWorks: boolean | 'unknown' = !statuses.ok
        ? 'unknown'
        : filtered.ok
          ? filtered.value.data.every((row) => asRecord(row).block !== 0)
          : filtered.verdict;

      /**
       * Записывает ли панель историю обращений за подпиской. Обратите внимание
       * на `'unknown'` в ветке отказа: для остальных возможностей 400/404 означает
       * «бэкенд отверг ЭТОТ параметр», то есть ответ по существу, а здесь 404
       * приходит от МАРШРУТА КОНФИГУРАЦИИ — его нет на панелях до 3.2.0. Прочесть
       * это как `false` значило бы на каждой 3.1.x объявлять, что панель истории
       * не пишет, и превратить subscription_inspect в источник ровно той
       * неправды, ради устранения которой возможность и заведена.
       */
      const srhRecorded: boolean | 'unknown' = panelConfig.ok
        ? asRecord(asRecord(panelConfig.value).service).disableSrhRecords !== true
        : 'unknown';

      /**
       * Сузил ли `filters` выборку. Проверяется СРАВНЕНИЕМ двух total, а не
       * кодом ответа: панель молча выбрасывает и незнакомый параметр, и
       * незнакомое имя колонки, отвечая 200 в обоих случаях. Опорный total
       * обязан быть положительным — на панели без пользователей отфильтрованный
       * ноль не доказывает ничего, и это честное 'unknown', а не 'true'.
       */
      const baselineTotal = userBaseline.ok ? num(asRecord(userBaseline.value).total, -1) : -1;
      const filteredTotal = userFiltered.ok ? num(asRecord(userFiltered.value).total, -1) : -1;
      const userFilterNarrows: boolean | 'unknown' =
        !userBaseline.ok || !userFiltered.ok || baselineTotal <= 0 || filteredTotal < 0
          ? 'unknown'
          : filteredTotal === 0;

      const panelRuntime = panelHealth.ok ? runtimeHealth(panelHealth.value) : null;
      const restartedSeconds = panelRuntime?.youngestUptimeSeconds ?? null;
      const shmCredentials = credentialsRejected(statuses);
      const remnaCredentials = credentialsRejected(metadata);

      /**
       * 404 НА HEALTHCHECK — ЭТО НЕ «СЕРВЕР ЛЁГ», А «В ЭТОЙ ВЕРСИИ ТАКОГО
       * МАРШРУТА НЕТ». Неавторизованный `/healthcheck` появился в SHM 2.18.0;
       * ниже неё роутер отвечает `{"error":"Method not found","status":404}`,
       * и прежняя ветка (`status < 500 → false`) объявляла живую SHM мёртвой —
       * ровно тот класс уверенной неправды, ради которого поле `live` и
       * заведено. Отсюда `null`: «не проверено», плюс предупреждение ниже,
       * называющее версию.
       */
      const healthcheckRouteAbsent = !shmAlive.ok && shmAlive.status === 404;
      const shmLive: boolean | null = shmAlive.ok
        ? true
        : healthcheckRouteAbsent
          ? null
          : shmAlive.status !== undefined && shmAlive.status < 500
            ? false
            : null;

      /**
       * Версия ниже той, на которой набор инструментов работает целиком.
       * Считается ТОЛЬКО для настроенной и ответившей системы: у ненастроенной
       * версии нет, а у неответившей `version === null` даёт честное
       * `'unknown'`, которое ниже ничего не печатает.
       */
      const shmTooOld = shmOn ? versionBelow(shmVersion, MIN_SHM_VERSION) : 'unknown';
      const remnaTooOld = remnaOn ? versionBelow(remnaVersion, MIN_REMNA_VERSION) : 'unknown';

      const value: ProbeResult = {
        checkedAt: ctx.now().toISOString(),
        cached: false,
        shm: {
          configured: shmOn,
          reachable: statuses.ok,
          // `null` при `configured: false` — намеренно. Текст «не спрашивали»
          // в поле `error` читался бы как сбой, а сбоя не было: не было и
          // запроса. Отсутствие системы называет `configured`, а не ошибка.
          error: !shmOn || statuses.ok ? null : statuses.error,
          spoolStatuses: statuses.ok
            ? asArray(statuses.value)
                .map(spoolStatusName)
                .filter((name): name is string => name !== null)
            : [],
          version: shmVersion,
          // `null`, а не `false`: неудача самого healthcheck ничего не говорит
          // о SHM, а `false` здесь читалось бы как «сервер лёг».
          live: shmLive,
          credentialsRejected: shmCredentials,
        },
        remna: {
          configured: remnaOn,
          reachable: metadata.ok,
          error: !remnaOn || metadata.ok ? null : metadata.error,
          version: remnaVersion,
          credentialsRejected: remnaCredentials,
          runtime: panelRuntime,
        },
        capabilities: {
          ...UNKNOWN_CAPABILITIES,
          'shm.filter': filterWorks,
          // dry_run проверяется только мутацией, а мутировать прод probe не имеет
          // права — остаётся честно неизвестным (открытый вопрос Q2).
          'shm.dry_run': 'unknown',
          'remna.subscriptionRequestHistory': srhRecorded,
          'remna.realtimeBandwidth': !metadata.ok ? 'unknown' : realtime.ok ? true : realtime.verdict,
          'remna.nodeIntegrations': integrationAccess.capability,
          'remna.sharedLists': sharedListAccess.capability,
          'tunnel.postgres': pgOpen,
          'tunnel.mysql': cfg.mysql === null ? false : mysqlOpen,
          'tunnel.abuse': abuseOpen,
        },
        warnings: [
          ...integrationAccess.warnings,
          ...sharedListAccess.warnings,
          ...(remnaOn && !realtime.ok && realtime.status === 404
            ? [warn('realtime_route_absent',
              '/api/bandwidth-stats/nodes/realtime returned 404. Remnawave 3.3.2 retains a ' +
              'route constant without a handler; realtime traffic is unavailable here. ' +
              'The historical bandwidth tools still report period totals, not realtime rates.')]
            : []),
          ...(shmOn && remnaOn
            ? []
            : [
                warn(
                  /**
                   * ПЕРВЫМ, И ЭТО ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЭТО НАПИСАНО.
                   *
                   * Инструменты, которым нужна ненастроенная система, в реестре
                   * не показываются вовсе — иначе модель получила бы тринадцать
                   * ручек, каждая из которых отказывает по одной и той же
                   * причине, и узнавала бы эту причину тринадцать раз подряд.
                   * Цена такого решения — исчезнувший инструмент ничего не
                   * объясняет, и расплатиться за неё обязана проба: форма
                   * развёртывания называется здесь, целиком и один раз.
                   */
                  'backend_not_configured',
                  `${!shmOn && !remnaOn ? 'Neither backend is' : !shmOn ? 'SHM (the billing) is' : 'Remnawave (the panel) is'} ` +
                    'not configured in this deployment, and the tools that need it are not ' +
                    'published at all — they are absent, not failing. Anything that can only be ' +
                    'answered by that system cannot be answered here by any tool, and no retry, ' +
                    'no other tool name and no refresh changes that: it is how this server was ' +
                    'started. Everything the remaining tools report is complete for the system ' +
                    'they do read.',
                ),
              ]),
          ...(shmTooOld === true || remnaTooOld === true
            ? [
                warn(
                  /**
                   * ВЕРСИЯ НИЖЕ ТОЙ, НА КОТОРОЙ НАБОР РАБОТАЕТ ЦЕЛИКОМ.
                   *
                   * Инструменты при этом остаются на месте и продолжают
                   * отвечать: там, где маршрута нет, отказ ГРОМКИЙ, и цена
                   * старой версии — не тихая неправда, а серия непонятных
                   * отказов посреди неродственных вопросов. Это предупреждение
                   * существует ровно затем, чтобы такой отказ читался с
                   * первого раза.
                   */
                  'backend_version_below_minimum',
                  (shmTooOld === true
                    ? `SHM ${shmVersion ?? '?'} is below ${MIN_SHM_VERSION}, the version this ` +
                      'server was built against. Below 2.18.0 the unauthenticated /healthcheck ' +
                      'route does not exist, so `shm.live` stays null and "the billing is down" ' +
                      'cannot be told apart from "the credentials are wrong"; below 2.11.3 ' +
                      '/admin/user/search is gone and client_search and client_resolve refuse; ' +
                      'below 2.9.0 /user/referrals is gone and client_account_state loses the ' +
                      'referral count. Everything else these tools call has been in SHM since 1.x. '
                    : '') +
                    (remnaTooOld === true
                      ? `Remnawave ${remnaVersion ?? '?'} is below ${MIN_REMNA_VERSION}, the ` +
                        'version this server was built against. Remnawave 3.0.0 replaced the ' +
                        'user `uuid` with a numeric `id`, so on 2.x every /api/users/{id} call ' +
                        'here is rejected by validation with 400; /api/connections/*, ' +
                        '/api/users/{id}/actions/extend and /api/system/stats/{digest,http} do ' +
                        'not exist at all and answer a router 404, which this server reports as ' +
                        'a missing route rather than as a missing client. '
                      : '') +
                    'Nothing is silently degraded by this: the affected calls fail loudly. Read ' +
                    'a refusal from one of the routes named above as this version gap, not as a ' +
                    'defect in the tool and not as an absent client.',
                ),
              ]
            : []),
          ...(healthcheckRouteAbsent
            ? [
                warn(
                  'shm_healthcheck_route_absent',
                  'SHM answered its router 404 ("Method not found") on /healthcheck: the route ' +
                    'itself is missing, which means this SHM predates 2.18.0. That is not an ' +
                    'outage — `shm.reachable` above is the authenticated answer and is the one ' +
                    'to read. The only thing lost is the split between "the billing is down" ' +
                    'and "these credentials are wrong": with no unauthenticated route to ask, ' +
                    '`shm.live` stays null on purpose rather than claiming the server is dead.',
                ),
              ]
            : []),
          warn(
            'specs_are_stale',
            'Whatever OpenAPI file you hold for either system lags production. This deployment ' +
            'runs ' +
              `Remnawave ${remnaOn ? (remnaVersion ?? 'at a version that could not be read') : '(not configured here)'} and ` +
              `SHM ${shmOn ? (shmVersion ?? 'at a version that could not be read') : '(not configured here)'} — read live just ` +
              'now, not asserted from a spec. Two traps behind that gap: the bundled SHM spec ' +
              'stamps `info.version` from the `_shm` config row at runtime, so its number ' +
              'describes whatever stand produced the dump rather than this one; and Remnawave 3.x ' +
              'removed `uuid` from the user object together with the by-telegram-id, by-email and ' +
              'by-tag routes, so anything written against a 2.x spec addresses users by a field ' +
              'and by routes that no longer exist. Trust this probe and the live routers.',
          ),
          ...(filterWorks === false
            ? [
                warn(
                  // Тот же код, что у client_search и sync_audit: факт один —
                  // «filter={"block":1} не сузил выборку», — и три имени на
                  // него означали, что вызывающий, ключующийся на код одного
                  // инструмента, у двух других его не узнаёт.
                  'blocked_filter_not_applied',
                  'Server-side filter did not narrow the result: this probe asked for ' +
                    'filter={"block":1} and got rows back that are not blocked. client_search ' +
                    'include_blocked is built on that filter — treat its blocked half as ' +
                    'unreliable, and read sync_audit\'s blocked counts the same way.',
                ),
              ]
            : []),
          ...(shmCredentials || remnaCredentials
            ? [
                warn(
                  'credentials_rejected',
                  `${shmCredentials && remnaCredentials ? 'Both backends' : shmCredentials ? 'SHM' : 'Remnawave'} ` +
                    'answered 401/403: the service is running and refused these credentials. This ' +
                    'is not an outage, and restarting anything will not fix it — rotate or correct ' +
                    'the configured credentials. ' +
                    (shmCredentials
                      ? shmAlive.ok
                        ? "SHM's unauthenticated healthcheck answered, which confirms the server " +
                          'itself is up.'
                        : "SHM's unauthenticated healthcheck did not answer either, so the server " +
                          'itself is unconfirmed.'
                      : 'Remnawave has no unauthenticated route, so its 401 is the only evidence ' +
                        'that the panel is serving at all — and it is enough: a dead panel does ' +
                        'not answer 401.'),
                ),
              ]
            : []),
          ...(userFilterNarrows === false
            ? [
                warn(
                  // Тот же код и тот же факт, что у notify_history: «мы попросили
                  // бэкенд сузить выборку по пользователю, и он этого не сделал».
                  'user_filter_not_applied',
                  'The panel ignored `filters` on the user listing: a filter for a username that ' +
                    'cannot exist came back with the same total as the unfiltered call. Anything ' +
                    'that narrows users panel-side is unreliable on this deployment — count and ' +
                    'match client-side instead. Note that the panel answers 200 either way: it ' +
                    'drops unknown query parameters and unknown column ids silently, so a ' +
                    'successful response is not evidence that a filter was applied.',
                ),
              ]
            : []),
          ...(restartedSeconds !== null && restartedSeconds < RESTART_WINDOW_S
            ? [
                warn(
                  'panel_recently_restarted',
                  `The youngest Remnawave process has been up for ${String(restartedSeconds)}s — ` +
                    'less than this probe\'s own 5-minute cache window. Failures reported by other ' +
                    'tools just before now may be the restart rather than a defect, and a probe ' +
                    'result taken from cache can predate it. Re-run with refresh=true before ' +
                    'concluding anything.',
                ),
              ]
            : []),
        ],
      };

      cache = { at: nowMs, value };
      ctx.probe.set(value);
      return value;
    },
  });
}
