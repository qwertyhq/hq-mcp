import type { TcpProbe, ToolDef, TunnelConfig } from '@hq/types';
import { autopayInspect } from './billing/autopay.js';
import { billingLedger } from './billing/ledger.js';
import { catalogRead } from './catalog/read.js';
import { clientAccountState } from './client/account.js';
import { clientBillingView } from './client/billing.js';
import { clientCatalogView } from './client/catalog.js';
import { clientOverview } from './client/overview.js';
import { clientResolve } from './client/resolve.js';
import { clientReach } from './client/reach.js';
import { clientSearch } from './client/search.js';
import { configRead } from './config/read.js';
import { deviceInventory } from './device/inventory.js';
import { connectionsInspect } from './connections/inspect.js';
import { countryHealth } from './country/health.js';
import { createAbuseReportTool } from './abuse/report.js';
import { createPlatformProbeTool } from './platform/probe.js';
import { createSqlQueryTool, probeTcp } from './sql/query.js';
import { infraCosts } from './infra/costs.js';
import { infraMap } from './infra/map.js';
import { nodeConfigAudit } from './node/config.js';
import { nodeGeocheck } from './node/geocheck.js';
import { nodeIntegrationsRead } from './node/integrations.js';
import { notifyHistory } from './notify/history.js';
import { panelActivity } from './panel/activity.js';
import { sharedListsRead } from './plugins/sharedLists.js';
import { promoRead } from './promo/read.js';
import { provisioningDiagnose } from './provisioning/diagnose.js';
import { serverInventory } from './server/inventory.js';
import { serverStatus } from './server/status.js';
import { serviceInspect } from './service/inspect.js';
import { spoolInspect } from './spool/inspect.js';
import { squadsRead } from './squads/read.js';
import { subpageRead } from './subpage/read.js';
import { subscriptionInspect } from './subscription/inspect.js';
import { syncAudit } from './sync/audit.js';
import { templateRead } from './template/read.js';
import { torrentReports } from './torrent/reports.js';
import { trafficStats } from './traffic/stats.js';

export interface CreateReadToolsOptions {
  tunnel: TunnelConfig;
  fetchImpl?: typeof fetch;
  probeTcp?: TcpProbe;
}

/**
 * Читающие инструменты. Шестнадцать из раздела 5.1 дизайна плюс два, выросших
 * из инвентаризации настоящих данных: autopay_inspect (состояние
 * автоплатежа не в настройках клиента, а в JSON-комментариях к платежам) и
 * notify_history (журнал доставки уведомлений, который до сих пор не
 * показывал никто), плюс два из аудита покрытия обоих API:
 * connections_inspect (контроллер connections не был покрыт вовсе — живые
 * подключения, которые поддержка спрашивает постоянно) и traffic_stats
 * (из bandwidth-stats читалась только панельная ручка по нодам, то есть
 * «куда делся трафик КЛИЕНТА» оставалось без ответа), server_inventory
 * (собственный список серверов SHM, по которому и ходит провижининг, — это НЕ
 * ноды панели), infra_costs (контроллер infra-billing панели: во что обходится
 * инфраструктура и не платим ли мы за ноду, которой никто не пользуется) и
 * squads_read (external-squads не читался вовсе, а internal-squads — только
 * ради счётчика участников; сквады решают, до каких инбаундов клиент достаёт,
 * то есть «почему он видит меньше серверов, чем сосед» было без ответа),
 * torrent_reports (контроллер node-plugins не читался вовсе — отчёты
 * блокировщика торрентов вместе с ответом на вопрос, включён ли он вообще) и
 * promo_read (промокоды с находкой на невидимые символы в идентификаторе,
 * которые однажды уже сделали действующий промокод неприменимым),
 * плюс пять из аудита ОСТАВШЕЙСЯ поверхности Remnawave 3.2.3 (197 маршрутов в
 * 20 контроллерах): subpage_read (что страница подписки показывает
 * клиенту, плюс сниппеты — тело живёт ТОЛЬКО в карточке, список всегда отдаёт
 * `config: null`), node_config_audit (вычисленный конфиг против объявленного,
 * теги нод и плагины — «что нода реально исполняет» было без ответа),
 * client_reach (до каких нод достаёт КОНКРЕТНЫЙ клиент — единственный маршрут
 * панели, который это складывает сам), device_inventory (картина устройств по
 * всему флоту, без которой «у клиента 5 устройств» — число без масштаба) и
 * panel_activity (recap/digest/http-счётчики и история обращений за подпиской:
 * кто, чем и по какому правилу SRR её тянет), плюс три из аудита КЛИЕНТСКОЙ
 * части API SHM — той, которой проект не касался вовсе, потому что
 * читал только `swagger_admin.json`: полная спека объявляет 39 клиентских
 * маршрутов, и они принимают `?user_id=`, то есть под админскими кредами
 * отвечают «как это видит клиент». Ответ на такой вопрос регулярно другой:
 * client_billing_view (прогноз списания, предлагаемые способы оплаты, платежи и
 * списания — у админского API прогноза нет вовсе), client_account_state
 * (почта, OTP, passkey, вход по паролю, рефералы — ни одного админского
 * маршрута под это не существует) и client_catalog_view (прайс-лист, посчитанный
 * ДЛЯ КЛИЕНТА: скрытые одноразовые тарифы и цена с его бонусами против того же
 * перечня без контекста).
 *
 * Три инструмента, а не тринадцать, потому что группировка идёт по ВОПРОСУ, а
 * не по маршруту: «сколько с меня возьмут и чем платить», «как я вхожу» и «что
 * мне продают». Разделение проходит и по экспозиции — состояние входа
 * человеческое, деньги и каталог доступны боту.
 */
export function createReadTools(opts: CreateReadToolsOptions): ToolDef[] {
  const tcp = opts.probeTcp ?? probeTcp;
  return [
    createPlatformProbeTool(opts.tunnel, { probeTcp: tcp }),
    clientResolve,
    clientOverview,
    clientSearch,
    billingLedger,
    autopayInspect,
    clientBillingView,
    clientAccountState,
    serviceInspect,
    catalogRead,
    clientCatalogView,
    provisioningDiagnose,
    subscriptionInspect,
    subpageRead,
    clientReach,
    syncAudit,
    countryHealth,
    serverStatus,
    connectionsInspect,
    trafficStats,
    infraMap,
    squadsRead,
    nodeConfigAudit,
    nodeIntegrationsRead,
    sharedListsRead,
    nodeGeocheck,
    serverInventory,
    infraCosts,
    deviceInventory,
    panelActivity,
    createAbuseReportTool(opts.tunnel, { fetchImpl: opts.fetchImpl ?? fetch }),
    torrentReports,
    promoRead,
    spoolInspect,
    notifyHistory,
    templateRead,
    configRead,
    createSqlQueryTool(opts.tunnel, { probeTcp: tcp }),
  ];
}

export { createPlatformProbeTool, resetProbeCache, UNKNOWN_CAPABILITIES } from './platform/probe.js';
export { nodeGeocheck } from './node/geocheck.js';
export { nodeIntegrationsRead } from './node/integrations.js';
export { sharedListsRead } from './plugins/sharedLists.js';
// resetAbuseBudget едет рядом с resetProbeCache не для симметрии: бюджет
// abuse_report — такое же модульное состояние, что и кэш пробы, и живёт он на
// настоящих часах. Рантайм, собранный в процессе второй раз, унаследовал бы
// счётчик первого и отказал бы в вызове по причине, которой в этой сборке не
// было.
export { createAbuseReportTool, resetAbuseBudget } from './abuse/report.js';
export { createSqlQueryTool, assertReadOnlySql, probeTcp } from './sql/query.js';
export type { TcpProbe } from './sql/query.js';
/**
 * Резолвер именования — наружу, потому что спрашивать «как эта инсталляция
 * называет свои объекты» полезно не только инструментам. Мастер установки
 * (`apps/setup`) зовёт его сразу после проверки кредов и ПОКАЗЫВАЕТ ответ
 * вместе с источником: «прочитано у работающей SHM» и «умолчание шаблона, ни
 * одной работающей системой не подтверждённое» — разные основания, и второе
 * оператор обязан увидеть при установке, а не через неделю в виде «у всех
 * услуг нет пользователя панели». Своей копии этой логики у мастера нет и быть
 * не должно.
 */
export {
  PANEL_PREFIXES_VAR,
  STORAGE_PREFIX_VAR,
  prefixSourcePhrase,
  resetPanelNamingCache,
  resolvePanelNaming,
} from './kit.js';
export type { PanelNaming, PrefixSource } from './kit.js';
