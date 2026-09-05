import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { torrentReports } from './reports.js';

interface Report {
  id: number;
  userId: number;
  username: string | null;
  ip: string | null;
  destination: string | null;
  nodeCountry: string | null;
}

interface Out {
  plugin: {
    installed: number | null;
    configsRead: number;
    configsComplete: boolean;
    torrentBlockerEnabled: boolean | null;
    blockDurationSeconds: number | null;
    ignoredUserIds: number[];
    ignoredIpCount: number | null;
    nodesWithoutPlugin: string[] | null;
    rulePlacement: number | null;
    includeRuleTags: string[] | null;
    includeRuleTagCount: number | null;
    configurations: Array<{ uuid: string | null; rulePlacement: number | null; includeRuleTags: string[] | null }>;
    sharedListReferences: Array<{ name: string; reference: string; exists: boolean | null }> | null;
  };
  stats: {
    totalReports: number | null;
    reportsLast24Hours: number | null;
    distinctUsers: number | null;
    distinctNodes: number | null;
    topUsersCoversEveryone: boolean;
  } | null;
  reportsForUser: number | null;
  topUsers: Array<{ userId: number; total: number }>;
  topNodes: Array<{ name: string | null; total: number }>;
  reports: { items: number | null; limit: number; offset: number; returned: number; data: Report[] };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const PLUGIN_UUID = '650a4724-0000-4000-8000-000000000001';

/**
 * Форма карточки плагина повторяет настоящий ответ панели. Существенны две
 * вещи: `pluginConfig` в СПИСКЕ приходит null и полным объектом только в
 * карточке (иначе флаг `enabled` читать неоткуда), а `ignoreLists.ip` — массив
 * под именем, которое профиль bot маскирует.
 */
const PLUGIN_CARD = {
  uuid: PLUGIN_UUID,
  viewPosition: 1,
  name: 'Torrent block',
  pluginConfig: {
    torrentBlocker: {
      enabled: true,
      blockDuration: 3600,
      ignoreLists: { ip: ['198.51.100.7', '198.51.100.8'], userId: [51, 77] },
    },
    connectionDrop: { enabled: false, whitelistIps: [] },
  },
};

/** Строка отчёта повторяет форму настоящего ответа целиком, включая то, что наружу не идёт. */
function report(id: number, userId: number, nodeName: string): Record<string, unknown> {
  return {
    id,
    userId,
    nodeId: 5,
    user: { username: `HQVPN_${String(userId)}` },
    node: { uuid: `node-${nodeName}`, name: nodeName, countryCode: 'EE' },
    report: {
      actionReport: {
        blocked: true,
        ip: '203.0.113.9',
        blockDuration: 3600,
        willUnblockAt: '2026-02-04T09:30:44.259Z',
        userId: String(userId),
        processedAt: '2026-02-04T08:30:44.259Z',
      },
      xrayReport: {
        email: String(userId),
        level: 0,
        protocol: 'bittorrent',
        network: 'tcp',
        source: '203.0.113.9:50069',
        destination: '104.28.163.196:50000',
        routeTarget: null,
        originalTarget: 'tcp:104.28.163.196:50000',
        inboundTag: 'XH-INBOUND USA',
        inboundName: 'vless',
        inboundLocal: '[::]:8446',
        outboundTag: 'RW_TB_OUTBOUND_BLOCK',
        ts: 1770193844,
      },
    },
    createdAt: `2026-02-04T08:30:5${String(id % 10)}.298Z`,
  };
}

const STATS = {
  stats: { distinctNodes: 2, distinctUsers: 2, totalReports: 30, reportsLast24Hours: 4 },
  topUsers: [
    { userId: 51, color: '#6ae3bd', username: 'HQVPN_51', total: 25 },
    { userId: 6, color: '#78336c', username: 'admin_', total: 5 },
  ],
  topNodes: [
    { uuid: 'node-Estonia', countryCode: 'EE', color: '#a1', name: 'Estonia', total: 20 },
    { uuid: 'node-Finland', countryCode: 'FI', color: '#a2', name: 'Finland', total: 10 },
  ],
};

const NODES = [
  { uuid: 'node-Estonia', name: 'Estonia', activePluginUuid: PLUGIN_UUID, isDisabled: false },
  { uuid: 'node-Finland', name: 'Finland', activePluginUuid: PLUGIN_UUID, isDisabled: false },
  { uuid: 'node-Germany', name: 'Germany', activePluginUuid: null, isDisabled: false },
  { uuid: 'node-Retired', name: 'Retired', activePluginUuid: null, isDisabled: true },
];

interface Overrides {
  plugins?: unknown;
  card?: unknown;
  stats?: unknown;
  reports?: unknown;
  nodes?: unknown;
  sharedLists?: unknown;
  profile?: 'human' | 'bot';
}

function run(
  input: Record<string, unknown>,
  over: Overrides = {},
  calls: StubCall[] = [],
): Promise<Out> {
  const ctx = makeCtx({
    calls,
    ...(over.profile === undefined ? {} : { profile: over.profile }),
    remnaGet: (path) => {
      if (path === '/api/node-plugins') {
        if (over.plugins !== undefined) {
          if (over.plugins === 'throw') throw new Error('plugins down');
          return over.plugins;
        }
        // Список ВСЕГДА отдаёт pluginConfig: null — это и есть настоящая форма.
        return { total: 1, nodePlugins: [{ ...PLUGIN_CARD, pluginConfig: null }] };
      }
      if (path.startsWith('/api/node-plugins/torrent-blocker/stats')) {
        if (over.stats === 'throw') throw new Error('stats down');
        return over.stats ?? STATS;
      }
      if (path === '/api/node-plugins/torrent-blocker') {
        if (over.reports === 'throw') throw new Error('reports down');
        return over.reports ?? { total: 2, records: [report(2, 51, 'Estonia'), report(1, 6, 'Finland')] };
      }
      if (path === '/api/node-plugins/shared-lists') {
        if (over.sharedLists === 'throw') throw new Error('403');
        return over.sharedLists ?? { total: 0, sharedLists: [] };
      }
      if (path.startsWith('/api/node-plugins/')) {
        if (over.card === 'throw') throw new Error('card down');
        return over.card ?? PLUGIN_CARD;
      }
      if (path === '/api/nodes') {
        if (over.nodes === 'throw') throw new Error('nodes down');
        return over.nodes ?? NODES;
      }
      return [];
    },
  });
  const parsed = torrentReports.input.parse(input);
  return torrentReports.handler(parsed, ctx) as Promise<Out>;
}

function codes(out: Out): string[] {
  return out.warnings.map((one) => one.code).sort();
}

describe('torrent_reports', () => {
  it('reads the blocker state from the plugin card, which the plugin list never carries', async () => {
    const calls: StubCall[] = [];
    const out = await run({}, {}, calls);
    expect(out.plugin.installed).toBe(1);
    expect(out.plugin.configsRead).toBe(1);
    expect(out.plugin.torrentBlockerEnabled).toBe(true);
    expect(out.plugin.blockDurationSeconds).toBe(3600);
    expect(out.plugin.ignoredUserIds).toEqual([51, 77]);
    expect(out.plugin.ignoredIpCount).toBe(2);
    // Карточка читается ОТДЕЛЬНЫМ запросом — без него флаг взять негде.
    expect(calls.map((one) => one.path)).toContain(`/api/node-plugins/${PLUGIN_UUID}`);
  });

  it('separates "no plugin installed" from "no reports"', async () => {
    const out = await run({}, { plugins: { total: 0, nodePlugins: [] }, reports: { total: 0, records: [] } });
    expect(out.reports.data).toEqual([]);
    expect(codes(out)).toContain('torrent_blocker_not_installed');
    expect(out.plugin.installed).toBe(0);
    // Отсутствие плагина — не отказ источника: degraded пуст.
    expect(out.degraded).toEqual([]);
  });

  it('says the blocker is switched off rather than letting an empty list speak', async () => {
    const out = await run(
      {},
      {
        card: {
          ...PLUGIN_CARD,
          pluginConfig: { torrentBlocker: { enabled: false, blockDuration: 3600 } },
        },
        stats: { ...STATS, stats: { ...STATS.stats, reportsLast24Hours: 0 } },
      },
    );
    expect(out.plugin.torrentBlockerEnabled).toBe(false);
    expect(codes(out)).toContain('torrent_blocker_disabled');
    expect(codes(out)).toContain('no_recent_torrent_reports');
  });

  it('never reports the blocker state as false when the card could not be read', async () => {
    const out = await run({}, { card: 'throw' });
    expect(out.plugin.torrentBlockerEnabled).toBeNull();
    expect(out.plugin.configsRead).toBe(0);
    expect(codes(out)).toContain('torrent_blocker_state_unknown');
    expect(codes(out)).toContain('partial_result');
    expect(codes(out)).not.toContain('torrent_blocker_disabled');
  });

  it('does not count a malformed plugin config as a successful configuration read', async () => {
    const out = await run({}, { card: { ...PLUGIN_CARD, pluginConfig: null } });
    expect(out.plugin.configsRead).toBe(0);
    expect(out.plugin.configsComplete).toBe(false);
    expect(out.plugin.includeRuleTags).toBeNull();
    expect(out.plugin.rulePlacement).toBeNull();
    expect(codes(out)).toContain('partial_result');
  });

  it('names the enabled nodes that carry no plugin at all, and skips disabled ones', async () => {
    const out = await run({});
    expect(out.plugin.nodesWithoutPlugin).toEqual(['Germany']);
    const warning = out.warnings.find((one) => one.code === 'nodes_without_torrent_blocker');
    expect(warning?.message).toContain('Germany');
    expect(warning?.message).not.toContain('Retired');
  });

  it('suppresses the node-coverage finding when the node list failed', async () => {
    const out = await run({}, { nodes: 'throw' });
    expect(out.plugin.nodesWithoutPlugin).toBeNull();
    expect(codes(out)).not.toContain('nodes_without_torrent_blocker');
    expect(codes(out)).toContain('partial_result');
    expect(out.degraded[0]?.system).toBe('remna');
  });

  it('does not label a node uncovered when its plugin binding was omitted', async () => {
    const out = await run({}, { nodes: [{ uuid: 'node-Example', name: 'Example', isDisabled: false }] });
    expect(out.plugin.nodesWithoutPlugin).toBeNull();
    expect(codes(out)).not.toContain('nodes_without_torrent_blocker');
    expect(codes(out)).toContain('partial_result');
  });

  /**
   * Главная защита инструмента. Фильтр панели — подстрочный LIKE: на работающей
   * панели `filters=[{"id":"userId","value":"6"}]` возвращает строки десятков
   * посторонних клиентов, у которых шестёрка встречается где угодно в id, и
   * `total` считает их все. Инструмент, отдающий это как «отчёты клиента 6»,
   * приписал бы ему чужой абуз.
   */
  it('drops the rows the panel matched by substring instead of attributing them', async () => {
    const out = await run(
      { user_id: 6 },
      { reports: { total: 137, records: [report(3, 6, 'Estonia'), report(4, 16, 'Finland'), report(5, 62, 'Estonia')] } },
    );
    expect(out.reports.data.map((one) => one.userId)).toEqual([6]);
    expect(out.reports.returned).toBe(1);
    expect(codes(out)).toContain('user_filter_matched_by_substring');
    // Точное число берётся у панели, а не из окна.
    expect(out.reportsForUser).toBe(5);
  });

  it('answers zero for a client absent from a provably complete topUsers list', async () => {
    const out = await run({ user_id: 999 }, { reports: { total: 0, records: [] } });
    expect(out.stats?.topUsersCoversEveryone).toBe(true);
    expect(out.reportsForUser).toBe(0);
  });

  it('refuses to turn a top-N into zero when the list does not cover everyone', async () => {
    const out = await run(
      { user_id: 999 },
      {
        stats: { ...STATS, stats: { ...STATS.stats, distinctUsers: 40 } },
        reports: { total: 0, records: [] },
      },
    );
    expect(out.stats?.topUsersCoversEveryone).toBe(false);
    expect(out.reportsForUser).toBeNull();
  });

  it('surfaces the server-side count and warns when the window is a slice', async () => {
    const out = await run({ limit: 2 }, { reports: { total: 3120, records: [report(2, 51, 'Estonia')] } });
    expect(out.reports.items).toBe(3120);
    const warning = out.warnings.find((one) => one.code === 'truncated');
    expect(warning?.message).toContain('3120');
  });

  it('says so when the panel returned no count at all instead of trusting the length', async () => {
    const out = await run({}, { reports: { records: [report(2, 51, 'Estonia')] } });
    expect(out.reports.items).toBeNull();
    expect(codes(out)).toContain('server_count_absent');
    expect(codes(out)).not.toContain('truncated');
  });

  /**
   * `source` — тот же адрес клиента, что и `ip`, но под именем, которое
   * редакция профиля bot не знает. Его отсутствие в ответе — не косметика.
   */
  it('does not carry the client address out under a name redaction cannot see', async () => {
    const out = await run({});
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('203.0.113.9:50069');
    expect(serialized).not.toContain('outboundTag');
    expect(out.reports.data[0]?.ip).toBe('203.0.113.9');
    expect(out.reports.data[0]?.destination).toBe('104.28.163.196:50000');
  });

  it('sends the only filter key the panel actually honours', async () => {
    const calls: StubCall[] = [];
    await run({ user_id: 51, limit: 5, offset: 10 }, {}, calls);
    const call = calls.find((one) => one.path === '/api/node-plugins/torrent-blocker');
    expect(call?.params).toEqual({
      size: 5,
      start: 10,
      filters: JSON.stringify([{ id: 'userId', value: '51' }]),
    });
  });

  it('caps the window and the top lists', async () => {
    const calls: StubCall[] = [];
    const out = await run({ limit: 9000, top_limit: 1 }, {}, calls);
    const call = calls.find((one) => one.path === '/api/node-plugins/torrent-blocker');
    expect(call?.params?.size).toBe(200);
    expect(out.topUsers).toHaveLength(1);
    expect(out.topNodes).toHaveLength(1);
    expect(codes(out)).toContain('top_list_truncated');
  });

  it('keeps the rest of the answer when the report list itself fails', async () => {
    const out = await run({}, { reports: 'throw' });
    expect(out.reports.data).toEqual([]);
    expect(out.stats?.totalReports).toBe(30);
    expect(codes(out)).toContain('partial_result');
    expect(out.degraded.map((one) => one.error)).toContain('reports down');
  });

  it('leaves stats null rather than zero when the panel did not answer', async () => {
    const out = await run({ user_id: 6 }, { stats: 'throw' });
    expect(out.stats).toBeNull();
    expect(out.reportsForUser).toBeNull();
    expect(codes(out)).toContain('partial_result');
  });

  it.each([
    { placement: undefined, want: null },
    { placement: 0, want: 0 },
    { placement: 12.5, want: 12.5 },
  ])('preserves rulePlacement $placement without synthesizing a default', async ({ placement, want }) => {
    const out = await run({}, { card: { ...PLUGIN_CARD, pluginConfig: { torrentBlocker: {
      ...PLUGIN_CARD.pluginConfig.torrentBlocker,
      ...(placement === undefined ? {} : { rulePlacement: placement }),
      includeRuleTags: ['route-one', 'route-two'],
    } } } });
    expect(out.plugin.rulePlacement).toBe(want);
    expect(out.plugin.includeRuleTags).toEqual(['route-one', 'route-two']);
    expect(out.plugin.includeRuleTagCount).toBe(2);
    expect(out.plugin.configurations[0]).toMatchObject({ uuid: PLUGIN_UUID, rulePlacement: want });
  });

  it.each([
    { sharedLists: { total: 0, sharedLists: [] }, exists: false },
    { sharedLists: 'throw', exists: null },
    { sharedLists: { total: 1, sharedLists: [] }, exists: null },
  ])('diagnoses ext references without counting them as literal ignored IPs', async ({ sharedLists, exists }) => {
    const out = await run({}, { sharedLists, card: { ...PLUGIN_CARD, pluginConfig: { torrentBlocker: {
      ...PLUGIN_CARD.pluginConfig.torrentBlocker,
      ignoreLists: { ip: ['198.51.100.7', 'ext:trusted'] },
    } } } });
    expect(out.plugin.sharedListReferences).toEqual([{ name: 'trusted', reference: 'ext:trusted', exists }]);
    expect(out.plugin.ignoredIpCount).toBe(1);
    expect(codes(out).includes('shared_list_reference_missing')).toBe(exists === false);
    expect(JSON.stringify(out)).not.toContain('198.51.100.7');
  });

  it('does not report the whole fleet disabled when unread plugin cards may be enabled', async () => {
    const ctx = makeCtx({ remnaGet: (path) => {
      if (path === '/api/node-plugins') return { total: 2, nodePlugins: [{ uuid: 'off' }, { uuid: 'unread' }] };
      if (path === '/api/node-plugins/off') return { uuid: 'off', pluginConfig: { torrentBlocker: { enabled: false } } };
      if (path === '/api/node-plugins/unread') throw new Error('403');
      if (path === '/api/node-plugins/torrent-blocker/stats') return STATS;
      if (path === '/api/node-plugins/torrent-blocker') return { total: 0, records: [] };
      if (path === '/api/nodes') return [];
      throw new Error(`unexpected path ${path}`);
    } });
    const out = await torrentReports.handler(torrentReports.input.parse({}), ctx) as Out;
    expect(out.plugin.torrentBlockerEnabled).toBeNull();
    expect(codes(out)).not.toContain('torrent_blocker_disabled');
  });

  it('keeps new bot diagnostics structural and does not read the human-only shared-list catalog', async () => {
    const calls: StubCall[] = [];
    const out = await run({}, { profile: 'bot', card: { ...PLUGIN_CARD, pluginConfig: { torrentBlocker: {
      ...PLUGIN_CARD.pluginConfig.torrentBlocker, rulePlacement: 5, includeRuleTags: ['private-rule'],
      ignoreLists: { ip: ['ext:private-list'] },
    } } } }, calls);
    expect(out.plugin.rulePlacement).toBe(5);
    expect(out.plugin.includeRuleTags).toBeNull();
    expect(out.plugin.includeRuleTagCount).toBe(1);
    expect(out.plugin.sharedListReferences).toBeNull();
    expect(JSON.stringify(out)).not.toContain('private-rule');
    expect(JSON.stringify(out)).not.toContain('private-list');
    expect(calls.some((one) => one.path === '/api/node-plugins/shared-lists')).toBe(false);
  });
});
