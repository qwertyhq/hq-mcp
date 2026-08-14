import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, num, settle, str, take, warn, ymd } from '../kit.js';

/** start = now − 7 суток, end = сегодня, и панель включает обе границы. */
const WINDOW_BACK_DAYS = 7;
const WINDOW_DAYS = WINDOW_BACK_DAYS + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько рядов графика просить у /api/bandwidth-stats/nodes.
 *
 * Параметр там ровно один — `topNodesLimit` (api-remna.json; ср.
 * wbap/src/lib/adminApi/connections.ts:346-358 против :370-383, где
 * `topUsersLimit` уходит в СОСЕДНЮЮ ручку /nodes/{uuid}/users). И он делает
 * `series` глобальным топ-N: на панели из 66 нод (снимок zqwerty) топ-5
 * означает, что у любой страны вне этой пятёрки трафик приедет пустым — то
 * есть инструмент про здоровье страны скажет «ноль байт» на работающей
 * инфраструктуре. Поэтому лимит берётся с запасом на весь флот, а не «дефолт 5»
 * из §6.17, и там, где он всё-таки мог сработать, ответ говорит об этом вслух.
 */
const BANDWIDTH_TOP_NODES = 100;

/**
 * Обязательная оговорка: панель видит только соединение своего агента с нодой.
 * Инцидент Germany 2: isConnected=true, lastStatusChange не менялся,
 * а пользователи 6 часов ехали через backup-ноды из-за отказа бэкендов релея.
 */
export const RELAY_BLINDNESS_WARNING: ToolWarning = {
  code: 'panel_blind_to_relay_dataplane',
  message:
    'Remnawave only knows whether its own agent link to the node is up. It sees nothing of the ' +
    'relay data plane in front of the node: the HAProxy relays, their backends and the actual ' +
    'client traffic path. A node can report isConnected=true with an unchanged lastStatusChange ' +
    'while every real user is being pushed to backup countries — that is exactly what happened ' +
    'to Germany 2 for six hours. Never conclude "the country is healthy" from this ' +
    'tool alone; confirm on the relay (HAProxy stats, Prometheus, Uptime Kuma), which is outside ' +
    'the scope of this MCP.',
};

interface HostRow {
  uuid: string;
  remark: string | null;
  /** Единственная страна, если она одна; иначе null — «не берусь утверждать». */
  countryCode: string | null;
  /** Всё, во что разрешился инбаунд хоста. Пусто = привязать не удалось. */
  countryCodes: string[];
  inboundUuid: string | null;
  isDisabled: boolean;
  isHidden: boolean;
}

export const countryHealth = defineTool({
  name: 'country_health',
  description:
    'Nodes, online users, traffic and hosts of a country as the panel sees them. Hosts carry no ' +
    'country of their own in Remnawave — theirs is derived from the nodes that serve their ' +
    'inbound, and a host that resolves to nothing is reported apart rather than dropped. Traffic ' +
    'comes from the bandwidth chart series, which is a panel-wide top-N, and the answer says so ' +
    'whenever that limit could have hidden this country. Each traffic row keeps its per-day curve ' +
    '(`daily`, labelled by `bandwidthDays`) as well as the total: over an eight-day window a few ' +
    'hours of collapse is a rounding error in the total and plainly visible in the curve. The ' +
    'answer always carries an explicit ' +
    'warning that the panel is blind to the relay data plane: this tool cannot tell you a country ' +
    'is healthy, only what the panel believes about it.',
  input: z.object({
    country_code: z
      .string()
      .min(2)
      .max(2)
      .nullable()
      .default(null)
      .describe('ISO country code, e.g. DE; null returns every country'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ country_code }, ctx) => {
    const degraded: Degraded[] = [];
    const warnings: ToolWarning[] = [RELAY_BLINDNESS_WARNING];
    const now = ctx.now();
    const end = ymd(now);
    const start = ymd(new Date(now.getTime() - WINDOW_BACK_DAYS * DAY_MS));
    const wanted = country_code === null ? null : (str(country_code) ?? '').toUpperCase();

    const [nodes, metrics, bandwidth, hosts] = await Promise.all([
      settle(ctx.remna.get<unknown>('/api/nodes')),
      settle(ctx.remna.get<unknown>('/api/system/nodes/metrics')),
      // Даты — YYYY-MM-DD в UTC (§6.17). Через ctx.shmTz их гнать НЕЛЬЗЯ: зона
      // существует для наивных штампов strftime(localtime) у SHM, а Remnawave
      // хранит трафик в UTC, и клиентское приложение считает окно так же
      // (wbap connections.ts:352).
      settle(
        ctx.remna.get<unknown>('/api/bandwidth-stats/nodes', {
          start,
          end,
          topNodesLimit: BANDWIDTH_TOP_NODES,
        }),
      ),
      settle(ctx.remna.get<unknown>('/api/hosts')),
    ]);

    // ВСЕ take() — до подсчёта предупреждений: иначе падение источника,
    // разворачиваемого ниже по файлу, не попало бы в partial_result.
    const nodeValue = take(nodes, 'remna', degraded, null);
    const metricValue = take(metrics, 'remna', degraded, null);
    const bandwidthValue = take(bandwidth, 'remna', degraded, null);
    const hostValue = take(hosts, 'remna', degraded, null);

    const allNodeRows = asArray(asRecord(nodeValue).nodes ?? nodeValue).map(asRecord);
    const allHostRows = asArray(asRecord(hostValue).hosts ?? hostValue).map(asRecord);

    const metricByNode = new Map<string, Record<string, unknown>>();
    for (const row of asArray(asRecord(metricValue).nodes ?? metricValue).map(asRecord)) {
      const uuid = str(row.nodeUuid ?? row.uuid);
      if (uuid !== null) metricByNode.set(uuid, row);
    }

    /**
     * Страна хоста выводится транзитивно, потому что своей у него нет: ни у
     * одного объекта в двух снимках работающей панели нет ключа countryCode,
     * и в GetAllHostsResponseDto его тоже нет. Ключ связи —
     * host.inbound.configProfileInboundUuid → ноды, у которых этот инбаунд в
     * configProfile.activeInbounds → их countryCode.
     */
    const nodeCountry = new Map<string, string>();
    const inboundCountries = new Map<string, Set<string>>();
    for (const row of allNodeRows) {
      const uuid = str(row.uuid);
      const code = str(row.countryCode)?.toUpperCase() ?? null;
      if (uuid !== null && code !== null) nodeCountry.set(uuid, code);
      if (code === null) continue;
      for (const active of asArray(asRecord(row.configProfile).activeInbounds).map(asRecord)) {
        const inboundUuid = str(active.uuid);
        if (inboundUuid === null) continue;
        const bucket = inboundCountries.get(inboundUuid) ?? new Set<string>();
        bucket.add(code);
        inboundCountries.set(inboundUuid, bucket);
      }
    }

    /**
     * host.nodes СУЖАЕТ, но первичным ключом быть не может: он пуст у 21/21
     * хоста lostlink. Пересечение, а не замена — на снимке zqwerty есть хост,
     * приколотый к ноде NL, чей инбаунд живёт на нодах RU (по ремарке это
     * Россия), и замена дала бы NL. Пустое пересечение — откат к инбаунду.
     */
    const countriesOf = (row: Record<string, unknown>): string[] => {
      const inboundUuid = str(asRecord(row.inbound).configProfileInboundUuid);
      const viaInbound = inboundUuid === null ? undefined : inboundCountries.get(inboundUuid);
      if (viaInbound === undefined) return [];
      const pinned = asArray(row.nodes)
        .map((one) => str(one))
        .filter((one): one is string => one !== null)
        .map((one) => nodeCountry.get(one))
        .filter((one): one is string => one !== undefined && viaInbound.has(one));
      return pinned.length > 0 ? [...new Set(pinned)] : [...viaInbound];
    };

    /**
     * Привязка хостов к странам живёт на списке нод целиком. Если он не приехал,
     * НИ ОДИН хост не привязывается — и «в стране нет хостов» вместе со списком
     * «хосты без страны» длиной во всю панель были бы выдумкой упавшего
     * источника, а не находкой.
     */
    const canAttribute = nodes.ok;
    const hostRows: HostRow[] = allHostRows.map((row) => {
      const codes = canAttribute ? countriesOf(row) : [];
      return {
        uuid: str(row.uuid) ?? '',
        remark: str(row.remark),
        countryCode: codes.length === 1 ? (codes[0] ?? null) : null,
        countryCodes: codes,
        inboundUuid: str(asRecord(row.inbound).configProfileInboundUuid),
        isDisabled: row.isDisabled === true,
        isHidden: row.isHidden === true,
      };
    });

    const nodeRows = allNodeRows
      .filter((row) => wanted === null || (str(row.countryCode) ?? '').toUpperCase() === wanted)
      .map((row) => {
        const uuid = str(row.uuid) ?? '';
        const metric = metricByNode.get(uuid) ?? {};
        return {
          uuid,
          name: str(row.name),
          countryCode: str(row.countryCode),
          isConnected: row.isConnected === true,
          isDisabled: row.isDisabled === true,
          lastStatusChange: str(row.lastStatusChange),
          usersOnline: num(metric.usersOnline ?? row.usersOnline),
        };
      });

    const shownHosts =
      wanted === null
        ? hostRows
        : canAttribute
          ? hostRows.filter((row) => row.countryCodes.includes(wanted))
          : [];
    const hostsWithoutCountry = canAttribute
      ? hostRows
          .filter((row) => row.countryCodes.length === 0)
          .map((row) => ({
            uuid: row.uuid,
            remark: row.remark,
            inboundUuid: row.inboundUuid,
            isDisabled: row.isDisabled,
          }))
      : [];

    /**
     * Ответ ручки — это ГРАФИК: {categories, sparklineData, topNodes, series}
     * (GetStatsNodesUsageResponseDto; wbap/src/admin/types/connections.ts:187-194,
     * выверено по работающей 2.8.1). Никаких построчных данных по нодам там нет, и
     * asArray от объекта отдал бы [объект], то есть одну фальшивую строку со
     * всем графиком внутри — и без единого шанса отфильтровать её по стране.
     * `series` несёт countryCode, которого нет у хостов; topNodes — то же самое
     * без ряда по дням, и служит запасным источником.
     *
     * Дневная кривая `series[].data[]` отдаётся наружу целиком, а не сворачивается
     * в total: на окне в 8 суток шестичасовой провал — это ~3% суммы, то есть
     * невидимо, и ровно эта кривая — единственное поле ручки, в котором форма
     * инцидента Germany 2 вообще проявляется. Секретов в ней нет.
     */
    const chart = asRecord(bandwidthValue);
    const seriesRows = asArray(chart.series).map(asRecord);
    const topNodeRows = asArray(chart.topNodes).map(asRecord);
    const chartRows = seriesRows.length > 0 ? seriesRows : topNodeRows;
    const bandwidthDays = asArray(chart.categories)
      .map((one) => str(one))
      .filter((one): one is string => one !== null);
    const bandwidthRows = chartRows
      .map((row) => ({
        nodeUuid: str(row.uuid) ?? '',
        name: str(row.name),
        countryCode: str(row.countryCode)?.toUpperCase() ?? null,
        totalBytes: num(row.total),
        // У запасного topNodes ряда по дням нет вовсе — тогда пусто.
        daily: asArray(row.data).map((one) => num(one)),
      }))
      .filter((row) => wanted === null || row.countryCode === wanted);

    if (wanted !== null && nodes.ok && allNodeRows.length > 0 && nodeRows.length === 0) {
      const present = [
        ...new Set(
          allNodeRows
            .map((row) => str(row.countryCode)?.toUpperCase())
            .filter((one): one is string => one !== undefined && one !== null),
        ),
      ].sort();
      warnings.push(
        warn(
          'country_not_in_panel',
          `The panel holds ${String(allNodeRows.length)} nodes and not one of them carries the ` +
            `country code ${wanted}. That is a statement about the code, not about an outage: ` +
            `the codes actually present are ${present.join(', ')}. Check the spelling before ` +
            'reading this empty answer as a country that went down.',
        ),
      );
    }
    if (!canAttribute && allHostRows.length > 0) {
      warnings.push(
        warn(
          'hosts_not_attributable',
          'The node listing did not answer, and a host has no country of its own — it inherits ' +
            'the country of the nodes serving its inbound. No host could be attributed, so the ' +
            'host side is empty by refusal, not because the country has no entry points.',
        ),
      );
    }
    if (hostsWithoutCountry.length > 0) {
      warnings.push(
        warn(
          'hosts_without_country',
          `${String(hostsWithoutCountry.length)} hosts could not be attributed to any country: ` +
            'no node currently serves the inbound they publish. They are listed in ' +
            '`hostsWithoutCountry` rather than dropped, because either reading applies — the host ' +
            'may belong to the country you asked about, or it may be a leftover pointing at an ' +
            'inbound nothing runs any more.',
        ),
      );
    }
    if (bandwidth.ok && chart.series === undefined && chart.topNodes === undefined) {
      warnings.push(
        warn(
          'bandwidth_shape_unrecognised',
          'The bandwidth route answered with a payload carrying neither `series` nor `topNodes`, ' +
            'so no traffic figure could be read from it. `bandwidth` is empty because the shape ' +
            'was not understood — not because the nodes moved no bytes.',
        ),
      );
    } else if (
      bandwidth.ok &&
      // Три разных способа не покрыть флот, и все три обязаны быть слышны:
      // лимит сработал ровно на запрошенном числе; панель срезала его молча
      // НИЖЕ запрошенного (тогда рядов меньше, чем нод, каким бы предел ни
      // был); либо у страны есть ноды, а строк трафика для них не пришло —
      // включая случай пустого графика на панельном вызове.
      (chartRows.length >= BANDWIDTH_TOP_NODES ||
        chartRows.length < allNodeRows.length ||
        (nodeRows.length > 0 && bandwidthRows.length === 0))
    ) {
      warnings.push(
        warn(
          'bandwidth_top_n',
          `The traffic chart is a panel-wide top-N: the request asked for ` +
            `${String(BANDWIDTH_TOP_NODES)} series, got ${String(chartRows.length)} back for a ` +
            `fleet of ${String(allNodeRows.length)} nodes, and ${String(bandwidthRows.length)} of ` +
            'them belong here. A node missing from the chart either fell outside the top-N — the ' +
            'panel may cap that limit below what was asked — or moved no traffic at all, and ' +
            'nothing here tells the two apart. A short or empty bandwidth list is not evidence ' +
            'that these nodes were idle.',
        ),
      );
    }
    // Считается ПОСЛЕ всех четырёх take() выше.
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the panel reads did not answer; the fields it owns are empty rather than wrong. ' +
            'An empty node or host list here is NOT evidence that the country has none — see ' +
            '`degraded` before drawing any conclusion about this country.',
        ),
      );
    }

    return {
      country: wanted,
      // Обе границы включительно, поэтому окно в днях на единицу длиннее сдвига.
      window: { start, end, days: WINDOW_DAYS },
      // Панель-wide, до фильтра по стране: без них «одна нода» неотличимо от
      // «панель отдала одну ноду» (§6.4). Своего total эти две ручки не несут.
      totals: { nodes: allNodeRows.length, hosts: allHostRows.length },
      nodes: nodeRows,
      hosts: shownHosts,
      hostsWithoutCountry,
      bandwidth: bandwidthRows,
      /** Метки дней графика: `daily[i]` каждой строки — это `bandwidthDays[i]`. */
      bandwidthDays,
      warnings,
      degraded,
    };
  },
});
