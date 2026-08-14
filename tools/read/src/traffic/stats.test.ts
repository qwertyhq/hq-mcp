import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { TRAFFIC_SCOPE_WARNING, trafficStats } from './stats.js';

interface Out {
  scope: string;
  found: boolean;
  window: { start: string; end: string; days: number };
  days?: string[];
  totalBytes?: number;
  nodes?: { inPanel: number | null; withTraffic: number };
  byNode?: Array<{
    nodeUuid: string | null;
    name: string | null;
    countryCode: string | null;
    totalBytes: number;
    daily: number[];
  }>;
  bySquad?: Array<{
    uuid: string;
    name: string | null;
    totalBytes: number;
    nodeUuids: string[];
    daily: Array<{ date: string | null; totalBytes: number }>;
  }>;
  squad?: { uuid: string; name: string | null; membersCount: number | null } | null;
  node?: { uuid: string; name: string | null } | null;
  daily?: number[];
  totals?: Record<string, number | boolean>;
  users?: Array<{ userId: number | null; username?: string | null; totalBytes: number }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const NODE_A = '0fd1f977-4167-47c9-8352-f123b7d6db0c';
const NODE_B = '7c39c520-87ed-4c64-aaf0-5246bdbffb36';
const SQUAD_A = 'bacc4949-e7d9-4102-b7e7-4a512925b76a';
const SQUAD_B = '0b71eea8-d631-49cd-b40c-c07a2ac13974';

const NODES = [
  { uuid: NODE_A, name: 'Poland', countryCode: 'PL', isConnected: true, isDisabled: false },
  { uuid: NODE_B, name: 'Finland', countryCode: 'FI', isConnected: true, isDisabled: false },
];

const SQUADS = {
  internalSquads: [
    { uuid: SQUAD_A, name: 'Main Squad', info: { membersCount: 120 } },
    { uuid: SQUAD_B, name: 'Hysteria2', info: { membersCount: 2 } },
  ],
};

/**
 * Карта клиента: сквады приезжают ИМЕННО отсюда, с uuid и именем — выверено
 * на работающей панели 3.2.3.
 */
const CARD = {
  id: 6,
  username: 'HQVPN_51',
  status: 'ACTIVE',
  userTraffic: { usedTrafficBytes: 47_000_000_000, lifetimeUsedTrafficBytes: 47_000_000_000 },
  activeInternalSquads: [
    { uuid: SQUAD_A, name: 'Main Squad' },
    { uuid: SQUAD_B, name: 'Hysteria2' },
  ],
};

/**
 * График трафика клиента. Ключевое, что здесь проверяется и чего нет в
 * контракте: `topNodesLimit` в 3.2.3 режет ТОЛЬКО `topNodes`, а `series`
 * приезжает по всем нодам с байтами (при limit=1 работающая панель отдала одну
 * строку topNodes и шесть рядов series). Поэтому цифры берутся из `series`, и
 * фикстура специально делает `topNodes` короче.
 */
const USER_CHART = {
  categories: ['2026-08-07', '2026-08-08'],
  sparklineData: [30, 70],
  topNodes: [{ uuid: NODE_A, color: '#1', name: 'Poland', countryCode: 'pl', total: 60 }],
  series: [
    { uuid: NODE_A, name: 'Poland', color: '#1', countryCode: 'pl', total: 60, data: [20, 40] },
    { uuid: NODE_B, name: 'Finland', color: '#2', countryCode: 'fi', total: 40, data: [10, 30] },
  ],
};

const squadDays = (nodes: string[]): unknown => ({
  days: [
    { date: '2026-08-07', nodes: nodes.map((uuid) => ({ uuid, totalBytes: 10 })) },
    { date: '2026-08-08', nodes: nodes.map((uuid) => ({ uuid, totalBytes: 20 })) },
  ],
});

interface Wiring {
  card?: unknown;
  cardThrows?: boolean;
  chart?: unknown;
  chartThrows?: boolean;
  nodes?: unknown;
  nodesThrow?: boolean;
  squads?: unknown;
  squadUsage?: unknown;
  squadDaysFor?: Record<string, unknown>;
  nodeUsers?: unknown;
  calls?: StubCall[];
}

function ctxFor(wiring: Wiring = {}): ReturnType<typeof makeCtx> {
  return makeCtx({
    calls: wiring.calls ?? [],
    remnaGet: (path) => {
      if (path === '/api/nodes') {
        if (wiring.nodesThrow === true) throw new Error('nodes unavailable');
        return wiring.nodes ?? NODES;
      }
      if (path === '/api/internal-squads') return wiring.squads ?? SQUADS;
      if (path.startsWith('/api/users/')) {
        if (wiring.cardThrows === true) throw new Error('card unavailable');
        return wiring.card === undefined ? CARD : wiring.card;
      }
      if (path.startsWith('/api/bandwidth-stats/users/')) {
        if (wiring.chartThrows === true) throw new Error('chart unavailable');
        return wiring.chart === undefined ? USER_CHART : wiring.chart;
      }
      if (path.includes('/users/') && path.endsWith('/usage')) {
        const squad = path.split('/')[4] ?? '';
        return wiring.squadDaysFor?.[squad] ?? squadDays([NODE_A]);
      }
      if (path.endsWith('/usage')) return wiring.squadUsage ?? { users: [], hasMore: false };
      if (path.endsWith('/users')) return wiring.nodeUsers ?? { categories: [], topUsers: [] };
      throw new Error(`unexpected remna GET ${path}`);
    },
  });
}

const userInput = (over: Record<string, unknown> = {}): never =>
  ({ user_id: 6, squad_uuid: null, node_uuid: null, days: 7, limit: 250, ...over }) as never;

describe('traffic_stats: one client', () => {
  it('reads the figures from `series`, not from the capped `topNodes`', async () => {
    const calls: StubCall[] = [];
    const out = (await trafficStats.handler(userInput(), ctxFor({ calls }))) as Out;

    expect(out.found).toBe(true);
    expect(out.byNode?.map((one) => one.nodeUuid)).toEqual([NODE_A, NODE_B]);
    expect(out.totalBytes).toBe(100);
    // Ряд по дням доезжает целиком: за неделю шестичасовой провал в сумме
    // невидим и виден только в кривой.
    expect(out.byNode?.[1]?.daily).toEqual([10, 30]);
    expect(out.days).toEqual(['2026-08-07', '2026-08-08']);
    expect(out.nodes).toEqual({ inPanel: 2, withTraffic: 2 });
    expect(out.warnings).toContainEqual(TRAFFIC_SCOPE_WARNING);
    // Окно обе границы включительно: семь суток назад — это восемь дней.
    expect(out.window).toEqual({ start: '2026-08-01', end: '2026-08-08', days: 8 });
    const chart = calls.find((one) => one.path === '/api/bandwidth-stats/users/6');
    expect(chart?.params).toMatchObject({ start: '2026-08-01', end: '2026-08-08' });
  });

  it('says out loud that squad totals overlap and must not be added up', async () => {
    // На работающей панели один клиент показал одни и те же 268,1 ГБ и в Main
    // Squad, и в Hysteria2: оба сквада достают до одних и тех же нод, и панель
    // считает байты каждой ноды ОБОИМ. Сумма по сквадам поэтому больше
    // настоящего трафика.
    const out = (await trafficStats.handler(
      userInput(),
      ctxFor({ squadDaysFor: { [SQUAD_A]: squadDays([NODE_A]), [SQUAD_B]: squadDays([NODE_A]) } }),
    )) as Out;

    expect(out.bySquad?.map((one) => one.name)).toEqual(['Main Squad', 'Hysteria2']);
    expect(out.bySquad?.[0]?.totalBytes).toBe(30);
    expect(out.bySquad?.[1]?.totalBytes).toBe(30);
    expect(out.warnings.map((one) => one.code)).toContain('squad_totals_overlap');
  });

  it('stays quiet about overlap when the squads reach different nodes', async () => {
    const out = (await trafficStats.handler(
      userInput(),
      ctxFor({ squadDaysFor: { [SQUAD_A]: squadDays([NODE_A]), [SQUAD_B]: squadDays([NODE_B]) } }),
    )) as Out;

    expect(out.warnings.map((one) => one.code)).not.toContain('squad_totals_overlap');
  });

  it('does not let a 200-with-zeroes pass for a subscriber the panel does not have', async () => {
    // Ручка трафика на неизвестном id отвечает 200 с пустой series (проверено
    // на работающей панели: id 99999999 вернул categories и sparkline из
    // нулей). Только карта отличает «нет такого» от «ничего не качал».
    const out = (await trafficStats.handler(
      userInput(),
      ctxFor({ card: null, chart: { categories: [], sparklineData: [], topNodes: [], series: [] } }),
    )) as Out;

    expect(out.found).toBe(false);
    expect(out.totalBytes).toBe(0);
    expect(out.warnings.map((one) => one.code)).toContain('user_not_found');
  });

  it('reports a broken card as unavailable, and leaves the squad breakdown empty by refusal', async () => {
    const out = (await trafficStats.handler(userInput(), ctxFor({ cardThrows: true }))) as Out;

    expect(out.found).toBe(false);
    expect(out.bySquad).toEqual([]);
    expect(out.warnings.map((one) => one.code)).toContain('card_unavailable');
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
    expect(out.warnings.map((one) => one.code)).not.toContain('user_not_found');
  });

  it('warns when the node top-N could have hidden a node, instead of showing a short list', async () => {
    const shortSeries = {
      ...USER_CHART,
      series: [USER_CHART.series[0]],
      topNodes: [...USER_CHART.topNodes, { uuid: NODE_B, name: 'Finland', total: 40 }],
    };
    const out = (await trafficStats.handler(userInput(), ctxFor({ chart: shortSeries }))) as Out;

    expect(out.warnings.map((one) => one.code)).toContain('bandwidth_top_n');
  });

  it('does not invent a figure out of a payload it did not recognise', async () => {
    const out = (await trafficStats.handler(
      userInput(),
      ctxFor({ chart: { categories: [], sparklineData: [] } }),
    )) as Out;

    expect(out.byNode).toEqual([]);
    expect(out.warnings.map((one) => one.code)).toContain('bandwidth_shape_unrecognised');
  });

  it('keeps the client answer when the node listing fails, but stops claiming a fleet size', async () => {
    const out = (await trafficStats.handler(userInput(), ctxFor({ nodesThrow: true }))) as Out;

    expect(out.nodes?.inPanel).toBeNull();
    expect(out.byNode).toHaveLength(2);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });
});

describe('traffic_stats: one squad', () => {
  const squadInput = (over: Record<string, unknown> = {}): never =>
    ({ user_id: null, squad_uuid: SQUAD_A, node_uuid: null, days: 7, limit: 2, ...over }) as never;

  it('sorts by bytes and reports the cursor truncation the route publishes no total for', async () => {
    const out = (await trafficStats.handler(
      squadInput(),
      ctxFor({
        squadUsage: {
          squadUuid: SQUAD_A,
          users: [
            { id: 1, totalBytes: 100 },
            { id: 4, totalBytes: 900 },
          ],
          nextCursor: '9',
          hasMore: true,
        },
      }),
    )) as Out;

    expect(out.found).toBe(true);
    expect(out.squad).toEqual({ uuid: SQUAD_A, name: 'Main Squad', membersCount: 120 });
    expect(out.users?.map((one) => one.userId)).toEqual([4, 1]);
    expect(out.totals).toMatchObject({ returned: 2, limit: 2, hasMore: true });
    const truncated = out.warnings.find((one) => one.code === 'truncated');
    // Числа расхода у этой ручки нет вовсе — только курсор. Членство в скваде
    // это ДРУГОЕ число, и подменять им итог нельзя.
    expect(truncated?.message).toContain('no total');
  });

  it('names an unknown squad uuid rather than answering it like an empty squad', async () => {
    const out = (await trafficStats.handler(
      squadInput({ squad_uuid: 'no-such-squad' }),
      ctxFor(),
    )) as Out;

    expect(out.found).toBe(false);
    expect(out.squad).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('squad_not_in_panel');
  });
});

describe('traffic_stats: one node', () => {
  const nodeInput = (over: Record<string, unknown> = {}): never =>
    ({ user_id: null, squad_uuid: null, node_uuid: NODE_A, days: 7, limit: 2, ...over }) as never;

  it('treats a full page as truncation, because the leaderboard publishes no total', async () => {
    const out = (await trafficStats.handler(
      nodeInput(),
      ctxFor({
        nodeUsers: {
          categories: ['2026-08-07', '2026-08-08'],
          sparklineData: [5, 7],
          topUsers: [
            { color: '#1', userId: 52, username: 'HQVPN_52', total: 900 },
            { color: '#2', userId: 6, username: 'HQVPN_51', total: 100 },
          ],
        },
      }),
    )) as Out;

    expect(out.node?.name).toBe('Poland');
    expect(out.users?.map((one) => one.username)).toEqual(['HQVPN_52', 'HQVPN_51']);
    expect(out.daily).toEqual([5, 7]);
    expect(out.warnings.map((one) => one.code)).toContain('truncated');
  });

  it('stays quiet when fewer rows came back than were asked for', async () => {
    const out = (await trafficStats.handler(
      nodeInput({ limit: 5 }),
      ctxFor({
        nodeUsers: { categories: [], sparklineData: [], topUsers: [{ userId: 6, total: 1 }] },
      }),
    )) as Out;

    expect(out.warnings.map((one) => one.code)).not.toContain('truncated');
    expect(out.totals).toMatchObject({ returned: 1, limit: 5 });
  });
});

describe('traffic_stats: input and boundary', () => {
  it('demands exactly one scope', () => {
    expect(() => trafficStats.input.parse({})).toThrow();
    expect(() => trafficStats.input.parse({ user_id: 6, node_uuid: NODE_A })).toThrow();
    expect(trafficStats.input.parse({ squad_uuid: SQUAD_A })).toMatchObject({
      user_id: null,
      node_uuid: null,
      days: 7,
      limit: 250,
    });
  });

  it('caps the window instead of asking the panel for a year of daily rows', async () => {
    const out = (await trafficStats.handler(userInput({ days: 3650 }), ctxFor())) as Out;
    expect(out.window.days).toBe(32);
  });

  it('states the boundary with subscription_inspect in both descriptions', async () => {
    const { subscriptionInspect } = await import('../subscription/inspect.js');
    expect(trafficStats.description).toContain('subscription_inspect');
    expect(subscriptionInspect.description).toContain('traffic_stats');
    expect(trafficStats.access).toBe('ro');
    expect(trafficStats.profiles).toEqual(['human', 'bot']);
  });
});
