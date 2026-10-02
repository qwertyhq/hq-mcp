import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { RELAY_BLINDNESS_WARNING } from '../country/health.js';
import { asArray, asRecord, num, settle, str, take, warn, ymd } from '../kit.js';

/**
 * ДОСТУПНОСТЬ СЕРВЕРОВ ДЛЯ БОТА ПОДДЕРЖКИ — ТОЛЬКО ТО, ЧТО МОЖНО СКАЗАТЬ КЛИЕНТУ.
 *
 * Контракт ответа общий с ai-bot (его сторону пишут отдельно и против этой
 * формы), поэтому поля здесь не переименовываются и не убираются; добавлять
 * необязательные можно. В ответе нет ни одного адреса, порта, SNI, тега
 * инбаунда, uuid или ключа — только коды стран, имена нод, счётчики, время и
 * ремарки хостов, то есть ровно то, что клиент и так видит у себя в приложении.
 */

/** start = now − 7 суток, end = сегодня, обе границы включительно (как в country_health). */
const WINDOW_BACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Тот же запас на весь флот, что у country_health: series — это панельный топ-N. */
const BANDWIDTH_TOP_NODES = 100;

export const STATUS_MIN_EXPECTED_VAR = 'HQ_MCP_STATUS_DROP_MIN_EXPECTED';
export const STATUS_DROP_RATIO_VAR = 'HQ_MCP_STATUS_DROP_RATIO';
const DEFAULT_MIN_EXPECTED = 5;
const DEFAULT_DROP_RATIO = 0.3;

export interface StatusThresholds {
  /** Ниже этого ожидаемого онлайна провал не считается: на малых числах это шум. */
  minExpected: number;
  /** Провал — онлайн меньше этой доли от ожидаемого. */
  dropRatio: number;
  /** Переменные, чьё значение не разобрано и заменено умолчанием. */
  invalid: string[];
}

/**
 * Пороги читаются при КАЖДОМ вызове, а не при старте: инструмент не владеет
 * загрузкой конфига, и битое значение здесь не повод ронять весь сервер —
 * его заменяет умолчание, а ответ говорит об этом предупреждением.
 */
export function statusThresholds(env: NodeJS.ProcessEnv = process.env): StatusThresholds {
  const invalid: string[] = [];
  const read = (name: string, fallback: number, ok: (value: number) => boolean): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !ok(value)) {
      invalid.push(name);
      return fallback;
    }
    return value;
  };
  return {
    minExpected: read(STATUS_MIN_EXPECTED_VAR, DEFAULT_MIN_EXPECTED, (value) => value >= 0),
    dropRatio: read(STATUS_DROP_RATIO_VAR, DEFAULT_DROP_RATIO, (value) => value > 0 && value <= 1),
    invalid,
  };
}

/** Типы подписки Remnawave 3.3.2 (SUBSCRIPTION_TEMPLATE_TYPE). */
export const SUBSCRIPTION_TYPES = [
  'XRAY_JSON',
  'XRAY_BASE64',
  'MIHOMO',
  'STASH',
  'CLASH',
  'SINGBOX',
] as const;
type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];

/**
 * Корзины контракта бота → тип подписки панели, чей список в корзину едет.
 * Для mihomo это MIHOMO (FlClash, Clash Verge, mihomo); у Stash и классического
 * Clash списки свои — они лежат в `hostsByType`.
 */
const CLIENT_BUCKETS = {
  xray_json: 'XRAY_JSON',
  mihomo: 'MIHOMO',
  singbox: 'SINGBOX',
  base64: 'XRAY_BASE64',
} as const satisfies Record<string, SubscriptionType>;

type NodeStatus = 'online' | 'offline' | 'disabled';
type CountryStatus = 'ok' | 'degraded' | 'down';
type Reason = 'node_offline' | 'node_disabled' | 'online_drop' | 'no_nodes';
type Overall = 'ok' | 'degraded' | 'outage' | 'unknown';

interface NodeOut {
  name: string;
  status: NodeStatus;
  usersOnline: number;
  expectedOnline: number | null;
  onlineDrop: boolean;
  since: string | null;
}

interface CountryOut {
  countryCode: string;
  status: CountryStatus;
  reasons: Reason[];
  nodes: NodeOut[];
}

interface InboundInfo {
  protocol: string | null;
  transport: string;
  /** VLESS с шифрованием (decryption ≠ none): sing-box генератор такой хост пропускает. */
  vlessEncrypted: boolean;
}

/**
 * Протоколы, которые резолвер панели вообще умеет превратить в строку подписки
 * (resolve-proxy-config.service.ts → resolveProtocolOptions). Остальное он
 * отбрасывает для ВСЕХ форматов.
 */
const RESOLVABLE_PROTOCOLS = new Set(['vless', 'trojan', 'shadowsocks', 'hysteria']);

/**
 * Транспорт так, как его видит резолвер (resolveTransport): `raw` и `tcp` —
 * одно и то же, незнакомое значение и пустота — tcp.
 */
function transportOf(network: string | null): string {
  switch (network) {
    case 'xhttp':
    case 'ws':
    case 'httpupgrade':
    case 'grpc':
    case 'kcp':
    case 'hysteria':
      return network;
    default:
      return 'tcp';
  }
}

function inboundInfoOf(row: Record<string, unknown>): InboundInfo {
  const raw = asRecord(row.rawInbound);
  const protocol = (str(row.type) ?? str(raw.protocol))?.toLowerCase() ?? null;
  const network = str(row.network) ?? str(asRecord(raw.streamSettings).network);
  const decryption = str(asRecord(raw.settings).decryption);
  return {
    protocol,
    transport: transportOf(network?.toLowerCase() ?? null),
    vlessEncrypted: protocol === 'vless' && decryption !== null && decryption !== 'none',
  };
}

/**
 * Что пропускает генератор каждого формата (Remnawave 3.3.2,
 * src/modules/subscription-template/generators/*). Исключение по
 * `excludeFromSubscriptionTypes` и скрытость проверяются раньше и общие.
 */
function generatorAccepts(type: SubscriptionType, inbound: InboundInfo | null): boolean {
  if (inbound === null) return true;
  const { protocol, transport } = inbound;
  switch (type) {
    case 'XRAY_JSON':
    case 'XRAY_BASE64':
      return true;
    case 'MIHOMO':
      return transport !== 'kcp';
    case 'STASH':
      return transport !== 'kcp' && transport !== 'xhttp';
    case 'CLASH':
      return (
        !['hysteria', 'kcp', 'xhttp'].includes(transport) &&
        protocol !== 'hysteria' &&
        protocol !== 'vless'
      );
    case 'SINGBOX':
      return transport !== 'kcp' && transport !== 'xhttp' && !inbound.vlessEncrypted;
  }
}

/** Remnawave пишет `XX`, когда страна ноды не задана. */
function countryCodeOf(value: unknown): string | null {
  const code = str(value)?.toUpperCase() ?? null;
  return code !== null && /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null;
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function uuidsOf(value: unknown): Set<string> {
  return new Set(
    asArray(value)
      .map((one) => (typeof one === 'string' ? one : str(asRecord(one).uuid)))
      .filter((one): one is string => one !== null),
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const SUBSCRIPTION_FORMAT_WARNING: ToolWarning = {
  code: 'subscription_format_by_client_rules',
  message:
    'Which of these lists a given app receives is decided by the panel subscription response ' +
    'rules, which this server does not read. The buckets follow the usual mapping (xray_json: ' +
    'Happ, INCY; mihomo: FlClash, Clash Verge, mihomo; singbox: sing-box apps, Karing; base64: ' +
    'everything else). Two known exceptions on Remnawave 3.3.2: when the panel serves JSON at ' +
    'the base subscription, Streisand, V2Box, v2rayNG and v2rayN receive the xray_json list ' +
    'instead of base64; and an app whose user agent matches no rule (Hiddify, for one) receives ' +
    'base64. Stash and legacy Clash get their own lists, see hostsByType.',
};

export const serverStatus = defineTool({
  name: 'server_status',
  description:
    'Customer-facing server availability: per country, whether the VPN servers are up ' +
    '(ok / degraded / down) and why, and the exact server names a customer sees in each kind ' +
    'of app (hostsByClient). A country is down when all its nodes are offline or disabled, ' +
    'degraded when any node is offline or disabled or has far fewer users online than its share ' +
    'of last week\'s traffic predicts (onlineDrop). `overall` describes the whole fleet even ' +
    'when a country is asked for: outage only when every country is down, unknown when the ' +
    'panel did not answer. Server names follow the panel order and drop hidden and disabled ' +
    'servers and servers excluded for that app format. No addresses, ports or keys are ' +
    'returned. The panel only sees its own link to a node, never the path a customer takes — ' +
    '"ok" here is what the panel believes, not a guarantee.',
  input: z.object({
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 country code, e.g. DE')
      .nullish()
      .describe('ISO 3166-1 alpha-2 code, case-insensitive (e.g. DE); omit for every country'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ country }, ctx) => {
    const degraded: Degraded[] = [];
    const warnings: ToolWarning[] = [RELAY_BLINDNESS_WARNING];
    const now = ctx.now();
    const wanted = country === undefined || country === null ? null : country.toUpperCase();
    const thresholds = statusThresholds();
    if (thresholds.invalid.length > 0) {
      warnings.push(
        warn(
          'status_threshold_invalid',
          `${thresholds.invalid.join(', ')} could not be read as a usable number and the default ` +
            `was used instead (minimum expected online ${String(thresholds.minExpected)}, drop ` +
            `ratio ${String(thresholds.dropRatio)}).`,
        ),
      );
    }

    const [nodes, bandwidth, hosts, squads] = await Promise.all([
      settle(ctx.remna.get<unknown>('/api/nodes')),
      settle(
        ctx.remna.get<unknown>('/api/bandwidth-stats/nodes', {
          start: ymd(new Date(now.getTime() - WINDOW_BACK_DAYS * DAY_MS)),
          end: ymd(now),
          topNodesLimit: BANDWIDTH_TOP_NODES,
        }),
      ),
      settle(ctx.remna.get<unknown>('/api/hosts')),
      settle(ctx.remna.get<unknown>('/api/internal-squads')),
    ]);
    const nodeValue = take(nodes, 'remna', degraded, null);
    const bandwidthValue = take(bandwidth, 'remna', degraded, null);
    const hostValue = take(hosts, 'remna', degraded, null);
    const squadValue = take(squads, 'remna', degraded, null);

    const nodeRows = asArray(asRecord(nodeValue).nodes ?? nodeValue)
      .map(asRecord)
      .sort((a, b) => num(a.viewPosition) - num(b.viewPosition));

    // ── Базовая линия: доля ноды в недельном трафике ─────────────────────────
    const chart = asRecord(bandwidthValue);
    const chartRows = asArray(chart.series ?? chart.topNodes).map(asRecord);
    const bytesByNode = new Map<string, number>();
    for (const row of chartRows) {
      const uuid = str(row.uuid);
      if (uuid !== null) bytesByNode.set(uuid, num(row.total));
    }
    const totalBytes = [...bytesByNode.values()].reduce((sum, one) => sum + one, 0);
    // Срез топ-N мог выбросить ноду; тогда её «ноль байт» — не факт, а пробел.
    const chartTruncated = chartRows.length >= BANDWIDTH_TOP_NODES;
    const shapeKnown = chart.series !== undefined || chart.topNodes !== undefined;
    if (bandwidth.ok && !shapeKnown) {
      warnings.push(
        warn(
          'bandwidth_shape_unrecognised',
          'The bandwidth route answered with a payload carrying neither `series` nor `topNodes`, ' +
            'so there is no traffic baseline: expectedOnline is null and no online drop is judged.',
        ),
      );
    }
    const baseline = bandwidth.ok && shapeKnown && totalBytes > 0;
    const totalOnline = nodeRows.reduce((sum, row) => sum + num(row.usersOnline), 0);

    const nodeOut = (row: Record<string, unknown>): NodeOut => {
      const uuid = str(row.uuid) ?? '';
      const status: NodeStatus =
        row.isDisabled === true ? 'disabled' : row.isConnected === true ? 'online' : 'offline';
      const usersOnline = num(row.usersOnline);
      const bytes = bytesByNode.get(uuid);
      const expected =
        !baseline || (bytes === undefined && chartTruncated)
          ? null
          : (totalOnline * (bytes ?? 0)) / totalBytes;
      const onlineDrop =
        expected !== null &&
        expected >= thresholds.minExpected &&
        usersOnline < thresholds.dropRatio * expected;
      return {
        name: str(row.name) ?? '',
        status,
        usersOnline,
        expectedOnline: expected === null ? null : round1(expected),
        onlineDrop,
        since: isoOrNull(row.lastStatusChange),
      };
    };

    // ── Страны ───────────────────────────────────────────────────────────────
    const byCountry = new Map<string, NodeOut[]>();
    let withoutCountry = 0;
    for (const row of nodeRows) {
      const code = countryCodeOf(row.countryCode);
      if (code === null) {
        withoutCountry += 1;
        continue;
      }
      byCountry.set(code, [...(byCountry.get(code) ?? []), nodeOut(row)]);
    }
    if (withoutCountry > 0) {
      warnings.push(
        warn(
          'nodes_without_country',
          `${String(withoutCountry)} node(s) carry no country code in the panel and are left out ` +
            'of `countries`; they still count toward the fleet-wide online total.',
        ),
      );
    }

    const judge = (code: string, list: NodeOut[]): CountryOut => {
      if (list.length === 0) {
        return { countryCode: code, status: 'down', reasons: ['no_nodes'], nodes: [] };
      }
      const reasons: Reason[] = [];
      if (list.some((one) => one.status === 'offline')) reasons.push('node_offline');
      if (list.some((one) => one.status === 'disabled')) reasons.push('node_disabled');
      // Провал у лежащей ноды объясняет её статус; причиной он идёт только у живой.
      if (list.some((one) => one.status === 'online' && one.onlineDrop)) {
        reasons.push('online_drop');
      }
      const status: CountryStatus = list.every((one) => one.status !== 'online')
        ? 'down'
        : reasons.length > 0
          ? 'degraded'
          : 'ok';
      return { countryCode: code, status, reasons, nodes: list };
    };

    const fleet = [...byCountry.keys()].sort().map((code) => judge(code, byCountry.get(code) ?? []));
    let overall: Overall;
    if (!nodes.ok) overall = 'unknown';
    else if (fleet.length === 0) {
      overall = 'unknown';
      warnings.push(
        warn(
          'no_nodes_in_panel',
          'The panel answered with no node that carries a country. Nothing here can say whether ' +
            'the service is up — check the panel token scope and the node list by hand.',
        ),
      );
    } else if (fleet.every((one) => one.status === 'down')) overall = 'outage';
    else if (fleet.some((one) => one.status !== 'ok')) overall = 'degraded';
    else overall = 'ok';

    let countries: CountryOut[] = fleet;
    if (wanted !== null && nodes.ok) {
      const found = fleet.find((one) => one.countryCode === wanted);
      if (found === undefined) {
        warnings.push(
          warn(
            'country_not_in_panel',
            `No node in the panel carries the country code ${wanted}; the countries actually ` +
              `present are ${fleet.map((one) => one.countryCode).join(', ') || 'none'}. That is ` +
              'a statement about the code, not an outage: check the spelling before telling a ' +
              'customer this country is down.',
          ),
        );
      }
      countries = [found ?? judge(wanted, [])];
    } else if (wanted !== null) {
      countries = [];
    }

    // ── Что клиент видит в приложении ────────────────────────────────────────
    const inbounds = new Map<string, InboundInfo>();
    const collectInbounds = (list: unknown): void => {
      for (const one of asArray(list).map(asRecord)) {
        const uuid = str(one.uuid);
        if (uuid === null) continue;
        // Описание с протоколом бьёт описание без него, откуда бы ни пришло.
        const info = inboundInfoOf(one);
        if (info.protocol !== null || !inbounds.has(uuid)) inbounds.set(uuid, info);
      }
    };
    for (const row of nodeRows) collectInbounds(asRecord(row.configProfile).activeInbounds);

    /**
     * Панель отдаёт хост только тем, чей внутренний сквад держит его инбаунд и
     * не исключает сам хост (hosts.repository.ts → findActiveHostsByUserId).
     * Запрос без клиента отвечает за самый населённый сквад, а расхождение с
     * остальными называется предупреждением.
     */
    const squadRows = asArray(asRecord(squadValue).internalSquads ?? squadValue).map(asRecord);
    for (const squad of squadRows) collectInbounds(squad.inbounds);
    const squadList = squadRows
      .map((squad) => ({
        uuid: str(squad.uuid) ?? '',
        members: num(asRecord(squad.info).membersCount),
        inbounds: uuidsOf(squad.inbounds),
      }))
      .sort((a, b) => b.members - a.members);
    const reference = squads.ok ? (squadList[0] ?? null) : null;
    if (!squads.ok) {
      warnings.push(
        warn(
          'squads_unread',
          'The internal squads did not answer, so the host lists are not narrowed to what a ' +
            'squad can reach: a server that nobody is actually given may appear in them.',
        ),
      );
    }

    const hostRows = asArray(asRecord(hostValue).hosts ?? hostValue)
      .map(asRecord)
      .sort((a, b) => num(a.viewPosition) - num(b.viewPosition));
    const inboundOf = (row: Record<string, unknown>): string | null =>
      str(asRecord(row.inbound).configProfileInboundUuid);
    const visibleTo = (
      row: Record<string, unknown>,
      squad: { uuid: string; inbounds: Set<string> } | null,
    ): boolean => {
      if (row.isDisabled === true) return false;
      if (squad === null) return squads.ok ? false : true;
      const inboundUuid = inboundOf(row);
      return (
        inboundUuid !== null &&
        squad.inbounds.has(inboundUuid) &&
        !uuidsOf(row.excludedInternalSquads).has(squad.uuid)
      );
    };

    const reachable = hostRows.filter((row) => visibleTo(row, reference));
    // Перемешиваемые хосты панель ставит ПЕРВЫМИ и в случайном порядке.
    const fed = [
      ...reachable.filter((row) => row.shuffleHost === true),
      ...reachable.filter((row) => row.shuffleHost !== true),
    ];

    /**
     * Ремарка дедуплицируется по всему, что панель скормила генератору, — а
     * скрытые хосты она кормит только форматам XRAY_JSON и MIHOMO
     * (subscription.service.ts: returnHiddenHosts). Отсюда отдельный проход
     * на каждый тип, а не один общий список.
     */
    const listFor = (type: SubscriptionType): string[] => {
      const known = new Map<string, number>();
      const withHidden = type === 'XRAY_JSON' || type === 'MIHOMO';
      const out: string[] = [];
      for (const row of fed) {
        if (row.isHidden === true && !withHidden) continue;
        // Ремарка как есть, без trim: панель её не нормализует, и клиент видит
        // ровно эту строку.
        const remark = typeof row.remark === 'string' ? row.remark : '';
        const count = known.get(remark) ?? 0;
        known.set(remark, count + 1);
        // deduplicateRemark из resolve-proxy-config.service.ts, один в один.
        const suffixed = remark.includes('^~') && remark.endsWith('~^') ? count : count + 1;
        const finalRemark = count === 0 ? remark : `${remark} ^~${String(suffixed)}~^`;
        if (row.isHidden === true) continue;
        if (asArray(row.excludeFromSubscriptionTypes).includes(type)) continue;
        const inboundUuid = inboundOf(row);
        // Инбаунд без известного протокола — «не знаем», а не «не умеем»: такой
        // хост остаётся в списке без фильтров по формату.
        const described = inboundUuid === null ? undefined : inbounds.get(inboundUuid);
        const inbound = described === undefined || described.protocol === null ? null : described;
        if (inbound !== null && !RESOLVABLE_PROTOCOLS.has(inbound.protocol ?? '')) continue;
        if (!generatorAccepts(type, inbound)) continue;
        out.push(finalRemark);
      }
      return out;
    };

    const hostsByType = Object.fromEntries(
      SUBSCRIPTION_TYPES.map((type) => [type, hosts.ok ? listFor(type) : []]),
    ) as Record<SubscriptionType, string[]>;
    const hostsByClient = Object.fromEntries(
      Object.entries(CLIENT_BUCKETS).map(([bucket, type]) => [bucket, hostsByType[type]]),
    ) as Record<keyof typeof CLIENT_BUCKETS, string[]>;
    warnings.push(SUBSCRIPTION_FORMAT_WARNING);

    if (hosts.ok) {
      const listed = fed.filter((row) => row.isHidden !== true);
      if (listed.some((row) => (str(row.remark) ?? '').includes('{{'))) {
        warnings.push(
          warn(
            'remark_templated',
            'Some server names carry a {{…}} placeholder that the panel fills per customer (days ' +
              'left, traffic and the like); the names here show the placeholder, the app shows the value.',
          ),
        );
      }
      if (listed.some((row) => row.shuffleHost === true)) {
        warnings.push(
          warn(
            'host_order_shuffled',
            'Some servers are marked for shuffling: the panel puts them first in a random order ' +
              'on every refresh, so the order here is not the order every customer sees.',
          ),
        );
      }
      const mapped = listed.some((row) =>
        Object.values(asRecord(row.mapper)).some((ops) => asArray(ops).length > 0),
      );
      if (mapped) {
        warnings.push(
          warn(
            'host_mapper_present',
            'At least one listed server has a host mapper for some app format; a mapper may ' +
              'rename the entry in that format, so its name there can differ from the one listed.',
          ),
        );
      }
      if (reachable.some((row) => (inbounds.get(inboundOf(row) ?? '')?.protocol ?? null) === null)) {
        warnings.push(
          warn(
            'host_protocol_unknown',
            'Some servers point at an inbound no node or squad describes, so the per-format ' +
              'filters could not be applied to them; they are listed in every format.',
          ),
        );
      }
      if (squads.ok && reference !== null) {
        const signature = (squad: { uuid: string; inbounds: Set<string> }): string =>
          hostRows
            .filter((row) => row.isHidden !== true && visibleTo(row, squad))
            .map((row) => str(row.uuid) ?? '')
            .join(',');
        const own = signature(reference);
        const others = squadList.filter(
          (squad) => squad !== reference && squad.members > 0 && signature(squad) !== own,
        );
        if (others.length > 0) {
          warnings.push(
            warn(
              'subscription_varies_by_squad',
              `The lists are built for the squad most customers are in (${String(reference.members)} ` +
                `members). ${String(others.length)} other squad(s) with members see a different ` +
                'set of servers, so a customer outside the main squad may see other names.',
            ),
          );
        }
      }
    }

    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the panel reads did not answer; the fields it owns are empty or null rather ' +
            'than wrong. See `degraded` before telling a customer anything definite.',
        ),
      );
    }

    return {
      generatedAt: now.toISOString(),
      overall,
      countries,
      subscription: { hostsByClient, hostsByType },
      warnings,
      degraded,
    };
  },
});
