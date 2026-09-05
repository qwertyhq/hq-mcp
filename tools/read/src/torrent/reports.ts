import { defineTool } from '@hq/registry';
import { scrubSecretShapesDeep } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, capLimit, num, settle, str, take, warn } from '../kit.js';
import { diagnoseReferences, resolveReferences, scanReferences } from '../plugins/dependencies.js';
import { parseCatalog, partial, pluginNodeCoverage, strings } from '../plugins/sources.js';

/**
 * Контроллер node-plugins панели 3.2.3. Раздел TORRENT_BLOCKER объявляет три
 * маршрута: GET_REPORTS, GET_REPORTS_STATS и TRUNCATE_REPORTS. Здесь читаются
 * первые два. TRUNCATE_REPORTS не реализован НАМЕРЕННО и не будет: он стирает
 * таблицу отчётов целиком, а эта таблица — единственная запись о том, кто и
 * когда ловился на торрентах. Уничтожение улик не бывает диагностикой.
 */
const REPORTS_PATH = '/api/node-plugins/torrent-blocker';
const STATS_PATH = '/api/node-plugins/torrent-blocker/stats';
const PLUGINS_PATH = '/api/node-plugins';
const NODES_PATH = '/api/nodes';

/** `size` у ручки объявлен `.max(1000)` включительно: 1001 отвергается валидацией (проверено). */
const MAX_LIMIT = 200;
const MAX_TOP = 100;

/**
 * Сколько плагинов вычитывается поштучно ради их конфигурации. Список
 * `GET /api/node-plugins` отдаёт `pluginConfig: null` ВСЕГДА — флаг
 * `torrentBlocker.enabled` живёт только в ответе `GET /api/node-plugins/{uuid}`
 * (проверено на работающей панели: список — null, карточка — полный
 * объект). То есть узнать, включён ли блокировщик, из списка нельзя в принципе,
 * и поштучное чтение здесь не оптимизация, а единственный источник.
 */
const MAX_PLUGIN_DETAILS = 5;

/**
 * Число или «панель его не назвала». Через `|| null` этого делать нельзя:
 * ноль — законное и содержательное значение и у `distinctNodes`, и у
 * `blockDuration`, а `0 || null` превратил бы его в «неизвестно».
 */
function finite(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

interface TorrentReport {
  id: number;
  userId: number;
  username: string | null;
  nodeName: string | null;
  nodeCountry: string | null;
  nodeUuid: string | null;
  /**
   * Адрес клиента, поймавшегося на торренте. Имя поля выбрано так, чтобы его
   * съела редакция профиля bot: `ip` входит в PII_KEYS (@hq/redact), и боту
   * значение приезжает маркером. Это ЗАМЫСЕЛ, закреплённый тестом
   * redaction-contract.
   */
  ip: string | null;
  /**
   * Куда шёл заблокированный поток — адрес пира/трекера, а не клиента.
   * Остаётся видимым в обоих профилях: это предмет находки.
   */
  destination: string | null;
  protocol: string | null;
  network: string | null;
  inboundTag: string | null;
  blocked: boolean | null;
  blockDurationSeconds: number | null;
  processedAt: string | null;
  createdAt: string | null;
}

interface TopUser {
  userId: number;
  username: string | null;
  total: number;
}

interface TopNode {
  uuid: string | null;
  name: string | null;
  countryCode: string | null;
  total: number;
}

/**
 * Строка отчёта → плоская запись. Из `report.xrayReport` НЕ выносятся наружу
 * два поля, и оба по одной причине — идентификатор клиента, лежащий в ЗНАЧЕНИИ,
 * которого редакция по имени поля не видит (тот же класс, что токен бота в
 * `response.request.url` спула):
 *   `source`  — «185.84.x.x:50069», то есть тот же адрес клиента, что и
 *               `actionReport.ip`, плюс порт. Под именем `source` профиль bot
 *               его НЕ маскирует, и адрес уехал бы боту в обход §7.2, пока
 *               соседнее поле `ip` честно приезжает маркером. Проверено не по
 *               спецификации, а на настоящих строках отчётов: host-часть
 *               `source` совпадает с `ip` в 100% случаев, то есть
 *               выбрасывается дубль, а не факт.
 *   `email`   — у Xray это не почта, а имя пользователя инбаунда: на всех
 *               проверенных строках оно равно String(userId). Для бота имя
 *               `email` попадает в PII и маскируется, то есть поле уехало бы
 *               маркером ради значения, которое уже есть в `userId` числом.
 */
function buildReport(row: Record<string, unknown>): TorrentReport {
  const report = asRecord(row.report);
  const action = asRecord(report.actionReport);
  const xray = asRecord(report.xrayReport);
  const node = asRecord(row.node);
  const blocked = action.blocked;
  return {
    id: num(row.id, 0),
    userId: num(row.userId, 0),
    username: str(asRecord(row.user).username),
    nodeName: str(node.name),
    nodeCountry: str(node.countryCode),
    nodeUuid: str(node.uuid),
    ip: str(action.ip),
    destination: str(xray.destination),
    protocol: str(xray.protocol),
    network: str(xray.network),
    inboundTag: str(xray.inboundTag),
    blocked: typeof blocked === 'boolean' ? blocked : null,
    blockDurationSeconds: finite(action.blockDuration),
    processedAt: str(action.processedAt),
    createdAt: str(row.createdAt),
  };
}

export const torrentReports = defineTool({
  name: 'torrent_reports',
  description:
    'Torrent-blocker evidence from the Remnawave node-plugins controller: which client tripped ' +
    'the blocker, on which node, how often, and whether the blocker is even watching. Answers ' +
    'three separate questions that must not be conflated — is the plugin installed at all, is ' +
    'its torrentBlocker section enabled, and what does the report table contain. An empty or ' +
    'stale report list means nothing until the first two are known. `stats` counts come from ' +
    'the panel and are exact; the report window is a slice. ' +
    'The controller also declares TRUNCATE_REPORTS (wipes the whole report table) and ' +
    'create/update/delete/clone/reorder for plugins: none of them is implemented here on ' +
    'purpose — this server does not destroy abuse evidence and does not reconfigure the fleet.',
  input: z.object({
    user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe(
        'Panel user id — the numeric Remnawave `id`, not a uuid and not the SHM user_id. ' +
          'Warning: the panel filters it with a substring LIKE, see `reports.items`.',
      ),
    limit: z.number().int().default(25).describe('Reports in the window, capped at 200'),
    offset: z.number().int().min(0).default(0).describe('Window start inside the filtered set'),
    top_limit: z
      .number()
      .int()
      .default(10)
      .describe('How many rows of topUsers/topNodes to return, capped at 100'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ user_id, limit, offset, top_limit }, ctx) => {
    const cap = capLimit(limit, 25, MAX_LIMIT);
    const topCap = capLimit(top_limit, 10, MAX_TOP);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const [plugins, stats, reports, nodes] = await Promise.all([
      settle(ctx.remna.get<unknown>(PLUGINS_PATH)),
      settle(ctx.remna.get<unknown>(STATS_PATH)),
      settle(
        ctx.remna.get<unknown>(REPORTS_PATH, {
          size: cap,
          start: offset,
          // Фильтр ручки — tanstack-совместимый массив {id,value}. Работает
          // ТОЛЬКО `userId`: `filters=[{"id":"username",...}]` на работающей
          // панели вернул выборку целиком, ничего не отфильтровав, то есть
          // неизвестный ключ молча игнорируется, а ответ выглядит
          // отфильтрованным. Поэтому ключ здесь один и зашит, а не собирается
          // из ввода.
          ...(user_id === null
            ? {}
            : { filters: JSON.stringify([{ id: 'userId', value: String(user_id) }]) }),
        }),
      ),
      settle(ctx.remna.get<unknown>(NODES_PATH)),
    ]);

    const pluginCatalog = parseCatalog(take(plugins, 'remna', degraded, null), 'nodePlugins', 'uuid');
    const pluginRows = pluginCatalog.rows;
    // Карточки читаются только у тех плагинов, которые в списке есть. Отказ
    // одной карточки отмечается один раз и не отменяет остальные.
    const details = await Promise.all(
      pluginRows
        .slice(0, MAX_PLUGIN_DETAILS)
        .map(async (row) => settle(ctx.remna.get<unknown>(`${PLUGINS_PATH}/${str(row.uuid) ?? ''}`))),
    );
    let detailsRead = 0;
    const configs: Record<string, unknown>[] = [];
    const configRows: Record<string, unknown>[] = [];
    for (const [index, detail] of details.entries()) {
      if (!detail.ok) {
        degraded.push({ system: 'remna', error: detail.error });
        continue;
      }
      const config = asRecord(detail.value).pluginConfig;
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        degraded.push({ system: 'remna', error: 'A plugin card did not contain a readable configuration.' });
        continue;
      }
      detailsRead += 1;
      configs.push(asRecord(config));
      configRows.push(pluginRows[index] ?? {});
    }
    const pluginCoverageComplete = pluginCatalog.complete && detailsRead === pluginRows.length;
    if (!pluginCoverageComplete) partial(warnings, 'Plugin configuration coverage is incomplete; unread plugins can still have an enabled torrent blocker.');
    const referenceScans = ctx.profile === 'human' ? configs.map(scanReferences) : [];
    const sharedCatalog = ctx.profile === 'human'
      ? await diagnoseReferences(ctx, referenceScans, degraded, warnings) : null;
    const combinedScan = {
      names: [...new Set(referenceScans.flatMap((one) => one.names))],
      complete: pluginCoverageComplete && referenceScans.every((one) => one.complete),
    };
    const configurations = configs.map((config, index) => {
      const section = asRecord(config.torrentBlocker);
      const tags = strings(section.includeRuleTags);
      if (tags !== null && tags.length > 100) partial(warnings, 'Only the first 100 rule tags are shown per plugin; includeRuleTagCount retains the full count.');
      return {
        uuid: str(configRows[index]?.uuid),
        torrentBlockerEnabled: typeof section.enabled === 'boolean' ? section.enabled : null,
        rulePlacement: typeof section.rulePlacement === 'number' && Number.isFinite(section.rulePlacement) &&
          section.rulePlacement >= 0 && section.rulePlacement <= 1000 ? section.rulePlacement : null,
        includeRuleTags: ctx.profile === 'human' ? tags?.slice(0, 100) ?? null : null,
        includeRuleTagCount: tags?.length ?? null,
        sharedListReferences: ctx.profile === 'human'
          ? resolveReferences(referenceScans[index] ?? { names: [], complete: false }, sharedCatalog) : null,
      };
    });
    const firstBlockerIndex = configs.findIndex((config) => Object.keys(asRecord(config.torrentBlocker)).length > 0);
    const firstConfiguration = configurations[firstBlockerIndex];

    // «Включён» — только явное true. Отсутствие секции torrentBlocker и
    // нечитаемая карточка обязаны остаться null: false здесь означало бы
    // «панель сказала, что выключено», а это утверждение, которого никто не
    // делал, и оно прямо противоположно по смыслу для находки ниже.
    const blockerSections = configs
      .map((cfg) => asRecord(cfg.torrentBlocker))
      .filter((section) => Object.keys(section).length > 0);
    const enabledFlags = blockerSections.map((section) => section.enabled);
    const torrentBlockerEnabled = enabledFlags.some((flag) => flag === true) ? true
      : pluginCoverageComplete && enabledFlags.length > 0 && enabledFlags.every((flag) => flag === false)
        ? false : null;
    const ignore = asRecord(blockerSections[0]?.ignoreLists);
    const ignoredUserIds = asArray(ignore.userId)
      .map((one) => num(one, Number.NaN))
      .filter((one) => Number.isFinite(one));
    // Считается только по НАСТОЯЩЕМУ массиву: профилю bot список приезжает
    // маркером '<redacted>' (ключ `ip` — PII), и asArray сделал бы из него
    // одну строку, то есть «в игнор-листе один адрес» вместо «спросить нельзя».
    const ignoredIpCount = Array.isArray(ignore.ip)
      ? ignore.ip.filter((one) => typeof one === 'string' && !one.startsWith('ext:')).length : null;

    const nodeCatalog = parseCatalog(take(nodes, 'remna', degraded, null), 'nodes', 'uuid');
    const nodeRows = nodeCatalog.rows;
    const nodesComplete = pluginNodeCoverage(nodeCatalog);
    if (!nodesComplete) partial(warnings, 'The node source is incomplete; fleet plugin coverage is unknown.');
    const uncovered = nodeRows
      .filter((row) => str(row.activePluginUuid) === null && row.isDisabled !== true)
      .map((row) => str(row.name) ?? str(row.uuid) ?? 'unnamed');

    const statsBody = asRecord(take(stats, 'remna', degraded, null));
    const counts = asRecord(statsBody.stats);
    const totalReports = stats.ok ? num(counts.totalReports, Number.NaN) : Number.NaN;
    const last24 = stats.ok ? num(counts.reportsLast24Hours, Number.NaN) : Number.NaN;
    const distinctUsers = num(counts.distinctUsers, Number.NaN);
    const allTopUsers: TopUser[] = asArray(statsBody.topUsers)
      .map(asRecord)
      .map((row) => ({
        userId: num(row.userId, 0),
        username: str(row.username),
        total: num(row.total, 0),
      }));
    const topNodes: TopNode[] = asArray(statsBody.topNodes)
      .map(asRecord)
      .slice(0, topCap)
      .map((row) => ({
        uuid: str(row.uuid),
        name: str(row.name),
        countryCode: str(row.countryCode),
        total: num(row.total, 0),
      }));

    /**
     * Покрывает ли `topUsers` ВСЕХ клиентов, а не верхушку. Проверяется, а не
     * предполагается: ручка называет список «top», и отсутствие клиента в нём
     * само по себе не значит «ноль отчётов». Но если строк ровно
     * `distinctUsers` и их сумма равна `totalReports`, список — это вся
     * выборка, и тогда отсутствие клиента действительно означает ноль.
     * На работающей панели так и оказывается: строк ровно `distinctUsers`,
     * а их сумма сходится с `totalReports`.
     */
    const topUsersComplete =
      stats.ok &&
      Number.isFinite(distinctUsers) &&
      Number.isFinite(totalReports) &&
      allTopUsers.length === distinctUsers &&
      allTopUsers.reduce((sum, one) => sum + one.total, 0) === totalReports;
    const forUser = allTopUsers.find((one) => one.userId === user_id);
    const reportsForUser =
      user_id === null || !stats.ok
        ? null
        : forUser !== undefined
          ? forUser.total
          : topUsersComplete
            ? 0
            : null;

    // Конверт разбирается здесь, а не общим envelope(): тот подставляет
    // rows.length, когда сервер `total` не назвал, и «сервер не сказал»
    // становится неотличимо от «мы увидели всё». Здесь это null, и на нём
    // усечение честно объявляется непроверяемым.
    const reportsBody = asRecord(take(reports, 'remna', degraded, null));
    const declared = num(reportsBody.total, Number.NaN);
    const serverTotal = reports.ok && Number.isFinite(declared) ? declared : null;
    const rawRows = asArray(reportsBody.records).map(asRecord).map(buildReport);
    // Клиентская до-фильтрация: серверный фильтр — подстрочный LIKE (см. ниже),
    // и без этого шага в ответ на «отчёты клиента 6» уехали бы строки клиентов
    // 4667, 6982, 6597 и ещё дюжины, у которых в id встречается шестёрка.
    const data = user_id === null ? rawRows : rawRows.filter((row) => row.userId === user_id);
    const foreign = rawRows.length - data.length;

    if (pluginCatalog.complete && pluginRows.length === 0) {
      warnings.push(
        warn(
          'torrent_blocker_not_installed',
          'No node plugin is installed on this panel at all, so nothing is watching for torrent ' +
            'traffic right now. Whatever the report table holds is history from an earlier ' +
            'configuration. An empty or short list here is evidence about the plugin, not about ' +
            'the clients.',
        ),
      );
    }
    if (torrentBlockerEnabled === false) {
      warnings.push(
        warn(
          'torrent_blocker_disabled',
          'A node plugin exists, but its torrentBlocker section is switched off (`enabled: ' +
            'false`), so no new report can appear no matter how much torrent traffic runs. Do ' +
            'not read an empty window, a zero 24-hour count or a quiet client as absence of ' +
            'abuse — the recorder is off. Turning it back on is a panel change, not an ' +
            'operation this server performs.',
        ),
      );
    }
    if (torrentBlockerEnabled === null && plugins.ok && pluginRows.length > 0) {
      warnings.push(
        warn(
          'torrent_blocker_state_unknown',
          'The plugin list was readable but its configuration was not, so whether the torrent ' +
            'blocker is enabled is unknown. The `enabled` flag lives only in the per-plugin ' +
            'card, never in the list. Treat the counts below as history of unknown currency.',
        ),
      );
    }
    if (nodesComplete && uncovered.length > 0) {
      warnings.push(
        warn(
          'nodes_without_torrent_blocker',
          `${String(uncovered.length)} enabled node(s) have no plugin attached at all ` +
            `(${uncovered.join(', ')}), so torrent traffic through them never produces a report. ` +
            'A client who only ever connects there looks clean here by construction.',
        ),
      );
    }
    if (stats.ok && Number.isFinite(totalReports) && totalReports > 0 && last24 === 0) {
      const newest = data.map((row) => row.createdAt).filter((one) => one !== null);
      const seen =
        user_id === null && newest.length > 0
          ? ` The newest row in this window is dated ${newest.sort().at(-1) ?? ''}.`
          : '';
      warnings.push(
        warn(
          'no_recent_torrent_reports',
          `The panel counts ${String(totalReports)} reports in total and 0 in the last 24 hours, ` +
            `so recording has stopped rather than found nothing.${seen} Check the blocker state ` +
            'above before telling anyone that torrent abuse ended.',
        ),
      );
    }
    if (user_id !== null && foreign > 0) {
      warnings.push(
        warn(
          'user_filter_matched_by_substring',
          `The panel's user filter is a substring LIKE, not an equality: asking for user ` +
            `${String(user_id)} returned ${String(foreign)} row(s) belonging to other clients ` +
            'whose id merely contains those digits, and its `items` count is inflated the same ' +
            'way. Those rows were dropped here, so this window can be shorter than `limit` ' +
            'while more of this client\'s reports still exist. Use `reportsForUser` — it comes ' +
            'from the panel\'s own exact per-user counter — for how many there really are.',
        ),
      );
    }
    if (serverTotal !== null && serverTotal > offset + rawRows.length) {
      warnings.push(
        warn(
          'truncated',
          `"torrent reports" returned ${String(rawRows.length)} of ${String(serverTotal)} rows ` +
            `(limit ${String(cap)}, offset ${String(offset)})` +
            (user_id === null
              ? ''
              : ' — and that server-side count is the substring match, not this client') +
            '. Anything counted from this slice is about the slice. Page or raise the limit ' +
            'before concluding.',
        ),
      );
    }
    if (reports.ok && serverTotal === null) {
      warnings.push(
        warn(
          'server_count_absent',
          'The panel did not return a `total` for the report list, so whether this window is the ' +
            'whole filtered set cannot be checked here. Do not treat its length as the count.',
        ),
      );
    }
    if (allTopUsers.length > topCap || topNodes.length < asArray(statsBody.topNodes).length) {
      warnings.push(
        warn(
          'top_list_truncated',
          `topUsers/topNodes were cut to ${String(topCap)} rows; the panel returned ` +
            `${String(allTopUsers.length)} users and ${String(asArray(statsBody.topNodes).length)} ` +
            'nodes. A client or node missing from the lists below is not one without reports — ' +
            'raise `top_limit` before concluding.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). The findings that depend on it — ' +
            'whether the plugin is installed, whether the blocker is enabled, which nodes are ' +
            'uncovered — are omitted rather than guessed, and an empty report list here is not ' +
            'evidence that no client triggered the blocker.',
        ),
      );
    }

    return {
      plugin: {
        installed: pluginCatalog.declaredTotal,
        configsRead: detailsRead,
        configsComplete: pluginCoverageComplete,
        torrentBlockerEnabled,
        blockDurationSeconds: finite(asRecord(blockerSections[0]).blockDuration),
        settingsPluginUuid: firstConfiguration?.uuid ?? null,
        rulePlacement: firstConfiguration?.rulePlacement ?? null,
        includeRuleTags: scrubSecretShapesDeep(firstConfiguration?.includeRuleTags ?? null).value,
        includeRuleTagCount: firstConfiguration?.includeRuleTagCount ?? null,
        configurations: scrubSecretShapesDeep(configurations).value,
        sharedListReferences: ctx.profile === 'human'
          ? resolveReferences(combinedScan, sharedCatalog) : null,
        sharedListReferencesComplete: ctx.profile === 'human' ? combinedScan.complete : null,
        ignoredUserIds,
        ignoredIpCount,
        nodesWithoutPlugin: nodesComplete ? uncovered : null,
      },
      stats: stats.ok
        ? {
            totalReports: Number.isFinite(totalReports) ? totalReports : null,
            reportsLast24Hours: Number.isFinite(last24) ? last24 : null,
            distinctUsers: Number.isFinite(distinctUsers) ? distinctUsers : null,
            distinctNodes: finite(counts.distinctNodes),
            topUsersCoversEveryone: topUsersComplete,
          }
        : null,
      reportsForUser,
      topUsers: allTopUsers.slice(0, topCap),
      topNodes,
      reports: { items: serverTotal, limit: cap, offset, returned: data.length, data },
      warnings,
      degraded,
    };
  },
});
