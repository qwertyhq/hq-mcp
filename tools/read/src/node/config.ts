import { defineTool } from '@hq/registry';
import { scrubSecretShapesDeep } from '@hq/redact';
import { z } from 'zod';
import type { SecretShapeHit } from '@hq/redact';
import type { Degraded, ToolWarning } from '@hq/types';
import { diagnoseReferences, resolveReferences, scanReferences } from '../plugins/dependencies.js';
import type { ReferenceScan, SharedListReference } from '../plugins/dependencies.js';
import { parseCatalog, partial, pluginNodeCoverage, strings } from '../plugins/sources.js';
import {
  asArray,
  asRecord,
  assertHumanOnly,
  capLimit,
  declaredTotal,
  envelope,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

const PROFILES_PATH = '/api/config-profiles';
const NODES_PATH = '/api/nodes';
const NODE_TAGS_PATH = '/api/nodes/tags';
const PLUGINS_PATH = '/api/node-plugins';

const MAX_LIMIT = 40;
const DEFAULT_LIMIT = 20;

/**
 * Сколько профилей сверяется с вычисленным конфигом, когда конкретный не
 * назван. Сверка — отдельный запрос на профиль, а профилей в работающей
 * установке заводят больше десятка, так что потолок стоит чуть выше этого.
 */
const MAX_COMPARED = 15;

/** Сколько карточек плагинов читается: `pluginConfig` в списке ВСЕГДА null (см. torrent_reports). */
const MAX_PLUGIN_DETAILS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ПОЛЯ ИНБАУНДА, КОТОРЫЕ ПОКИДАЮТ ЭТОТ ИНСТРУМЕНТ. Список БЕЛЫЙ, и это
 * единственная настоящая защита здесь — не скруббер.
 *
 * Сырой xray-конфиг снят с работающей панели 3.2.3. В одном
 * `streamSettings.realitySettings` лежат рядом:
 *   privateKey   — приватный ключ Reality. Редакция по ИМЕНИ его ловит:
 *                  `SECRET_KEY_RE` матчит подстроку `Key`.
 *   shortIds     — имя под регулярку не попадает вовсе;
 *   dest, serverNames — куда маскируется инбаунд;
 * а рядом, в `settings`, — `seed: "xhttp-r3mna-s33d-7k2pQ"`. Ни `seed`, ни
 * `shortIds` не содержат ни одного слова из /token|secret|key|password|auth/,
 * то есть редакция по имени их не видит. Скруббер ПО ФОРМЕ их тоже не видит:
 * `seed` рассыпается дефисами на куски по пять символов, `shortIds` — 16 hex
 * при пороге 32. Оба фильтра пропускают их молча.
 *
 * Отсюда конструкция: наружу уезжает то, что ПЕРЕЧИСЛЕНО здесь, и ничего
 * больше. Чёрный список пропустил бы первое же поле, которое заведёт
 * следующая версия панели, — а это ровно та форма утечки, которой этот проект
 * стоил трёх инцидентов за один день.
 */
interface InboundFacts {
  tag: string | null;
  protocol: string | null;
  network: string | null;
  security: string | null;
  port: number | null;
  listen: string | null;
}

function inboundFacts(row: Record<string, unknown>): InboundFacts {
  const stream = asRecord(row.streamSettings);
  return {
    tag: str(row.tag),
    protocol: str(row.protocol) ?? str(row.type),
    network: str(row.network) ?? str(stream.network),
    security: str(row.security) ?? str(stream.security),
    port: optionalNumber(row.port),
    listen: str(row.listen),
  };
}

function tagsOf(config: Record<string, unknown>): string[] {
  return asArray(config.inbounds)
    .map(asRecord)
    .map((one) => str(one.tag))
    .filter((one): one is string => one !== null);
}

interface ComputedVerdict {
  /** Спрашивали ли панель вовсе. false — сверки не было, а НЕ «расхождений нет». */
  compared: boolean;
  identical: boolean | null;
  onlyDeclared: string[];
  onlyComputed: string[];
  /**
   * Верхнеуровневые секции конфига, различающиеся между объявленным и
   * вычисленным (log / inbounds / outbounds / routing).
   *
   * НАЗЫВАЕТСЯ `changedSections`, А НЕ `changedKeys`, ПО ИЗМЕРЕНИЮ, А НЕ ПО
   * ВКУСУ: `SECRET_KEY_RE` в @hq/redact матчит подстроку `Keys` в ИМЕНИ поля,
   * и под прежним именем весь список уезжал вызывающему как '<redacted>' —
   * то есть самая содержательная часть вердикта о расхождении была нечитаема,
   * а инструмент выглядел исправным. Поймал redaction-contract на настоящем
   * executeTool; тесты, зовущие хендлер напрямую, были зелены.
   */
  changedSections: string[];
}

const NOT_COMPARED: ComputedVerdict = {
  compared: false,
  identical: null,
  onlyDeclared: [],
  onlyComputed: [],
  changedSections: [],
};

/**
 * Сравнение идёт по УЖЕ ОТРЕДАКТИРОВАННЫМ телам: `privateKey` в обоих равен
 * одному и тому же маркеру, поэтому равенство сохраняется, а различие в самих
 * ключах — единственное, чего это сравнение увидеть не может. Названо вслух в
 * предупреждении, а не спрятано: «конфиги идентичны» здесь означает
 * «идентичны во всём, кроме, возможно, значений замаскированных полей».
 */
function compare(declared: Record<string, unknown>, computed: Record<string, unknown>): ComputedVerdict {
  const declaredTags = tagsOf(declared);
  const computedTags = tagsOf(computed);
  const keys = new Set([...Object.keys(declared), ...Object.keys(computed)]);
  const changedSections = [...keys].filter(
    (key) => JSON.stringify(declared[key]) !== JSON.stringify(computed[key]),
  );
  return {
    compared: true,
    identical: changedSections.length === 0,
    onlyDeclared: declaredTags.filter((tag) => !computedTags.includes(tag)),
    onlyComputed: computedTags.filter((tag) => !declaredTags.includes(tag)),
    changedSections,
  };
}

interface ProfileFacts {
  uuid: string | null;
  name: string | null;
  viewPosition: number | null;
  inboundCount: number;
  inbounds: InboundFacts[];
  nodeCount: number;
  nodeNames: string[];
  computed: ComputedVerdict;
}

interface PluginFacts {
  uuid: string | null;
  name: string | null;
  configRead: boolean;
  /** Имена секций конфигурации плагина. Значения не выносятся — форма чужая и растущая. */
  configSections: string[];
  nodesUsing: string[] | null;
  sharedListReferences: SharedListReference[] | null;
  sharedListReferencesComplete: boolean;
}

export const nodeConfigAudit = defineTool({
  name: 'node_config_audit',
  description:
    'The configuration layer of the fleet: config profiles, the inbounds they declare, the ' +
    'COMPUTED config the panel would actually hand a node, node tags, node plugins, and one ' +
    "node's card on request. The reason this exists is the comparison — a profile declares one " +
    'thing and the panel computes another, and until now nothing here could see the difference. ' +
    'The verdict is per profile: identical, or which inbound tags and which top-level keys ' +
    'differ. `compared: false` means the comparison was not run, never that nothing differs. ' +
    'Also answers the cheaper question nobody was asking: which config profiles are attached to ' +
    'no node at all — dead profiles still hold live Reality keys and still get served by the ' +
    'API. ' +
    'RAW XRAY CONFIG IS NEVER RETURNED, in declared or computed form. Only tag, protocol, ' +
    'network, security, port and listen leave this tool, chosen by an allowlist rather than by ' +
    'stripping known-bad names: a Reality block carries `privateKey` (which name-based ' +
    'redaction does catch) next to `seed` and `shortIds` (which it does not, and which the ' +
    'shape scrubber does not catch either — too short, too many separators). Anything that ' +
    'still matched a secret shape on the way out is counted in `scrubbed`. ' +
    'Every write on these controllers is deliberately absent — creating, updating, deleting or ' +
    'reordering a profile or a plugin reconfigures the fleet, and reorder changes the default ' +
    'object for every client at once.',
  input: z.object({
    profile_uuid: z
      .string()
      .nullable()
      .default(null)
      .describe('Narrow to one config profile by uuid; omit for all of them'),
    node_uuid: z
      .string()
      .nullable()
      .default(null)
      .describe("Also read one node's card: its live state, versions, active inbound tags"),
    compare_computed: z
      .boolean()
      .default(true)
      .describe('Ask the panel for each profile\'s computed config and diff it (one call each)'),
    include_plugins: z.boolean().default(true).describe('Also read node plugins and their config sections'),
    limit: z.number().int().default(DEFAULT_LIMIT).describe('Profiles returned, capped at 40'),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * Только human — по той же границе, что infra_map и squads_read: ответ
   * называет ноды, страны, имена профилей и теги инбаундов, то есть топологию.
   * Это операторское знание, а не ответ на вопрос клиента (§7.2). Разница с
   * subpage_read, который открыт обоим профилям, ровно в этом: там текст,
   * который панель и так показывает каждому подписчику, здесь — карта того,
   * из чего он собран.
   */
  profiles: ['human'],
  backends: ['remna'],
  handler: async (
    { profile_uuid, node_uuid, compare_computed, include_plugins, limit },
    ctx,
  ) => {
    assertHumanOnly(
      ctx,
      'node_config_audit is available to the human profile only: it names nodes, countries, ' +
        'config profiles and inbound tags — the topology, not an answer to a client question ' +
        '(§7.2), the same boundary infra_map and squads_read stand behind.',
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);
    const wantedProfile = str(profile_uuid);
    const wantedNode = str(node_uuid);

    for (const [label, value] of [
      ['profile_uuid', wantedProfile],
      ['node_uuid', wantedNode],
    ] as const) {
      if (value !== null && !UUID_RE.test(value)) {
        warnings.push(
          warn(
            'config_uuid_malformed',
            `\`${label}\` = "${value}" is not a uuid. The panel validates the format strictly ` +
              'and would answer 400, which would look like a read failure rather than a missing ' +
              'object. Call without it to list what exists.',
          ),
        );
      }
    }

    const [listed, nodeTags, plugins, nodes] = await Promise.all([
      settle(ctx.remna.get<unknown>(PROFILES_PATH)),
      settle(ctx.remna.get<unknown>(NODE_TAGS_PATH)),
      include_plugins
        ? settle(ctx.remna.get<unknown>(PLUGINS_PATH))
        : Promise.resolve({ ok: true as const, value: null }),
      settle(ctx.remna.get<unknown>(NODES_PATH)),
    ]);

    // См. device_inventory: `envelope` подставляет длину списка вместо
    // отсутствующего `total`, поэтому объявленное сервером число берётся
    // отдельно и остаётся null, когда он его не назвал.
    const listedBody = take(listed, 'remna', degraded, null);
    const listing = envelope(listedBody, 'configProfiles');
    const all = listing.rows;
    const matched =
      wantedProfile === null
        ? all
        : all.filter((row) => (str(row.uuid) ?? '').toLowerCase() === wantedProfile.toLowerCase());
    const selected = matched.slice(0, cap);

    const profiles: ProfileFacts[] = [];
    const hits: SecretShapeHit[] = [];
    let comparisons = 0;
    for (const row of selected) {
      const uuid = str(row.uuid);
      const declared = asRecord(row.config);
      const attached = asArray(row.nodes).map(asRecord);
      let verdict = NOT_COMPARED;
      if (compare_computed && uuid !== null && comparisons < MAX_COMPARED) {
        const computed = await settle(
          ctx.remna.get<unknown>(`${PROFILES_PATH}/${uuid}/computed-config`),
        );
        if (computed.ok) {
          comparisons += 1;
          verdict = compare(declared, asRecord(asRecord(computed.value).config));
        } else {
          degraded.push({ system: 'remna', error: computed.error });
        }
      }
      profiles.push({
        uuid,
        name: str(row.name),
        viewPosition: optionalNumber(row.viewPosition),
        inboundCount: asArray(row.inbounds).length,
        inbounds: asArray(declared.inbounds).map(asRecord).map(inboundFacts),
        nodeCount: attached.length,
        nodeNames: attached.map((one) => str(one.name) ?? str(one.uuid) ?? 'unnamed'),
        computed: verdict,
      });
    }

    const nodeCatalog = parseCatalog(take(nodes, 'remna', degraded, null), 'nodes', 'uuid');
    const nodeRows = nodeCatalog.rows;
    const nodesComplete = pluginNodeCoverage(nodeCatalog);
    const pluginCatalog = include_plugins
      ? parseCatalog(take(plugins, 'remna', degraded, null), 'nodePlugins', 'uuid') : null;
    const pluginRows = pluginCatalog?.rows ?? [];
    const pluginFacts: PluginFacts[] = [];
    const pluginScans: Array<ReferenceScan | null> = [];
    for (const row of pluginRows.slice(0, MAX_PLUGIN_DETAILS)) {
      const uuid = str(row.uuid);
      const card = uuid === null ? null : await settle(ctx.remna.get<unknown>(`${PLUGINS_PATH}/${uuid}`));
      if (card !== null && !card.ok) degraded.push({ system: 'remna', error: card.error });
      const config = card?.ok === true ? asRecord(card.value).pluginConfig : null;
      const configRead = config !== null && typeof config === 'object' && !Array.isArray(config);
      pluginScans.push(configRead ? scanReferences(config) : null);
      pluginFacts.push({
        uuid,
        name: str(row.name),
        configRead,
        configSections:
          configRead ? Object.keys(asRecord(config)) : [],
        nodesUsing: nodesComplete
          ? nodeRows
              .filter((one) => str(one.activePluginUuid) === uuid)
              .map((one) => str(one.name) ?? 'unnamed')
          : null,
        sharedListReferences: null,
        sharedListReferencesComplete: false,
      });
    }
    const sharedCatalog = await diagnoseReferences(ctx, pluginScans.filter((one): one is ReferenceScan => one !== null), degraded, warnings);
    for (const [index, facts] of pluginFacts.entries()) {
      const scan = pluginScans[index];
      facts.sharedListReferences = scan == null ? null : resolveReferences(scan, sharedCatalog);
      facts.sharedListReferencesComplete = scan?.complete ?? false;
    }
    const pluginCoverageComplete = pluginCatalog?.complete === true &&
      pluginScans.length === pluginRows.length && pluginScans.every((one) => one?.complete === true);
    if (include_plugins && !pluginCoverageComplete) partial(warnings, 'Plugin details or external dependency scans are incomplete; unchecked plugins remain unknown.');
    if (include_plugins && !nodesComplete) partial(warnings, 'The node source is incomplete; full plugin usage cannot be established.');

    let node: Record<string, unknown> | null = null;
    if (wantedNode !== null && UUID_RE.test(wantedNode)) {
      const card = await settle(ctx.remna.get<unknown>(`${NODES_PATH}/${wantedNode}`));
      if (!card.ok) degraded.push({ system: 'remna', error: card.error });
      else node = buildNode(asRecord(card.value));
    }

    const nodeIntegrations = nodeRows.slice(0, cap).map((row) => ({
      uuid: str(row.uuid), name: str(row.name), integrationUuids: strings(row.integrationUuids)?.slice(0, 20) ?? null,
    }));
    if (nodeIntegrations.some((row) => (row.integrationUuids?.length ?? 0) > 0) ||
        (strings(node?.integrationUuids)?.length ?? 0) > 0) {
      warnings.push(warn('node_integrations_separate_config', 'Node integrations are applied in the listed order, separately from the computed Xray profile. Later top-level values override earlier ones; node_integrations_read resolves these bindings.'));
    }

    const scrubbed = scrubSecretShapesDeep({ profiles, plugins: pluginFacts, node, nodeIntegrations });
    hits.push(...scrubbed.hits);

    const orphans = profiles.filter((one) => one.nodeCount === 0).map((one) => one.name ?? one.uuid);
    const differing = profiles.filter((one) => one.computed.identical === false);
    const tagList = asArray(asRecord(take(nodeTags, 'remna', degraded, null)).tags)
      .map((one) => str(one))
      .filter((one): one is string => one !== null);

    if (differing.length > 0) {
      warnings.push(
        warn(
          'computed_config_differs',
          `${String(differing.length)} profile(s) compute to something other than what they ` +
            `declare: ${differing.map((one) => one.name ?? one.uuid ?? '?').join(', ')}. What a ` +
            'node runs is the computed side. Read `onlyComputed` / `onlyDeclared` for the ' +
            'inbound tags that exist on one side only — an inbound present in the declaration ' +
            'and absent from the computation serves nobody, however correct it looks in the panel.',
        ),
      );
    }
    if (comparisons > 0 && differing.length === 0) {
      warnings.push(
        warn(
          'computed_config_identical',
          `All ${String(comparisons)} compared profile(s) compute exactly what they declare, so ` +
            'no discrepancy explains a routing problem here. One blind spot, named rather than ' +
            'hidden: both sides are compared AFTER field-name redaction, so two different ' +
            'private keys under the same masked name would compare equal. Every other ' +
            'difference — inbound sets, ports, transports, routing — is covered.',
        ),
      );
    }
    /**
     * УСЛОВИЕ НАМЕРЕННО НЕ СМОТРИТ НА `compare_computed`. Первая версия
     * смотрела — и ровно тогда, когда вызывающий сверку ВЫКЛЮЧИЛ, ответ уезжал
     * с `compared: false` у всех профилей и без единого слова об этом.
     * Молчание в этом месте читается как «расхождений нет», то есть выключенная
     * проверка выглядела успешной. Поймал это собственный тест инструмента.
     * Причина несверки (выключили, упёрлись в потолок, звонок не прошёл) на
     * вывод не влияет: несверенный профиль не согласован, он не проверен.
     */
    if (selected.length > comparisons) {
      warnings.push(
        warn(
          'computed_config_not_compared',
          `${String(comparisons)} of ${String(selected.length)} profiles were compared` +
            (compare_computed
              ? ` (cap ${String(MAX_COMPARED)} per call, plus any call that failed).`
              : ' — `compare_computed` was off, so none of them were asked about.') +
            ' The rest carry `compared: false`, which means the question was not asked — not ' +
            'that they agree. Nothing below rules out a node running something other than what ' +
            'its profile declares.',
        ),
      );
    }
    if (listed.ok && orphans.length > 0) {
      warnings.push(
        warn(
          'config_profile_without_nodes',
          `${String(orphans.length)} of ${String(profiles.length)} config profiles are attached ` +
            `to no node at all (${orphans.join(', ')}). Nothing serves them, so editing one ` +
            'changes nothing and diagnosing from one explains nothing. They are not inert, ' +
            'though: each still holds live Reality keys and still answers the API, so they are ' +
            'worth deleting rather than leaving.',
        ),
      );
    }
    if (nodeTags.ok && tagList.length === 0) {
      warnings.push(
        warn(
          'feature_present_but_unused',
          'The node tag route answered normally and returned no tags: tagging is available on ' +
            'this panel and nothing uses it. Any filter or automation keyed on a node tag ' +
            'matches nothing here — not because it is broken, but because there is nothing to ' +
            'match.',
        ),
      );
    }
    if (matched.length > selected.length) {
      warnings.push(
        warn(
          'truncated',
          `${String(selected.length)} of ${String(matched.length)} config profiles are shown ` +
            `(limit ${String(cap)}). Nothing about the profiles left out can be concluded here.`,
        ),
      );
    }
    if (hits.length > 0) {
      warnings.push(
        warn(
          'secrets_scrubbed',
          `${String(hits.length)} value(s) matching a secret shape were removed on the way out. ` +
            'This answer is built from an allowlist of scalar fields, so a hit here means a ' +
            'secret reached one of tag / protocol / network / security / port / listen / node ' +
            'name — worth looking at directly, because that is not a place a key belongs.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). A profile without a comparison and ' +
            'a plugin without its config sections are unknown here, not empty.',
        ),
      );
    }

    return {
      profiles: {
        declared_total: listed.ok ? declaredTotal(listedBody) : null,
        matched: matched.length,
        returned: profiles.length,
        compared: comparisons,
        orphanCount: orphans.length,
        items: scrubbed.value.profiles,
      },
      nodeTags: nodeTags.ok ? tagList : null,
      plugins: include_plugins
        ? { installed: pluginCatalog?.declaredTotal ?? null, complete: pluginCoverageComplete, items: scrubbed.value.plugins }
        : null,
      node: scrubbed.value.node,
      nodeIntegrations: { complete: nodeCatalog.complete && nodeRows.length <= cap, items: scrubbed.value.nodeIntegrations },
      warnings,
      degraded,
    };
  },
});

/**
 * Карточка ноды → факты. Тот же белый список: `configProfile.activeInbounds`
 * несут `rawInbound` с полным xray-конфигом инлайном, поэтому из них берутся
 * только теги. Адрес ноды и её hostname остаются — это тот самый операторский
 * слой, ради которого инструмент объявлен human-only.
 */
function buildNode(row: Record<string, unknown>): Record<string, unknown> {
  const profile = asRecord(row.configProfile);
  const system = asRecord(row.system);
  const info = asRecord(system.info);
  return {
    uuid: str(row.uuid),
    name: str(row.name),
    countryCode: str(row.countryCode),
    address: str(row.address),
    port: optionalNumber(row.port),
    isConnected: row.isConnected === true,
    isDisabled: row.isDisabled === true,
    lastStatusChange: str(row.lastStatusChange),
    lastStatusMessage: str(row.lastStatusMessage),
    xrayUptimeSeconds: optionalNumber(row.xrayUptime),
    usersOnline: optionalNumber(row.usersOnline),
    trafficUsedBytes: optionalNumber(row.trafficUsedBytes),
    trafficLimitBytes: optionalNumber(row.trafficLimitBytes),
    versions: asRecord(row.versions),
    tags: asArray(row.tags)
      .map((one) => str(one))
      .filter((one): one is string => one !== null),
    activeConfigProfileUuid: str(profile.activeConfigProfileUuid),
    activeInboundTags: asArray(profile.activeInbounds)
      .map(asRecord)
      .map((one) => str(one.tag))
      .filter((one): one is string => one !== null),
    activePluginUuid: str(row.activePluginUuid),
    integrationUuids: strings(row.integrationUuids)?.slice(0, 20) ?? null,
    host: {
      hostname: str(info.hostname),
      platform: str(info.platform),
      arch: str(info.arch),
      cpus: optionalNumber(info.cpus),
      memoryTotal: optionalNumber(info.memoryTotal),
    },
  };
}

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
