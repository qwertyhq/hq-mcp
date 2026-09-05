import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { infraMap } from './map.js';

interface HostGapRow {
  uuid: string;
  remark: string | null;
  inboundUuid: string | null;
}

interface InboundGapRow {
  uuid: string;
  tag: string | null;
  activeOnNodes: string[];
}

interface Gaps {
  hostsWithUnknownInbound: HostGapRow[] | null;
  inboundsActiveWithoutHost: InboundGapRow[] | null;
  inboundsPublishedOnlyByDisabledHosts: Array<{ uuid: string; tag: string | null }> | null;
  nodesWithoutProfile: Array<{ uuid: string; name: string | null }> | null;
  disabledHosts: number | null;
}

interface MapOut {
  counts: {
    nodes: number;
    profiles: number;
    inbounds: number;
    hosts: number;
    squads: number;
    reported: { profiles: number | null; inbounds: number | null; squads: number | null };
  };
  nodes: Array<{
    uuid: string;
    name: string | null;
    profileUuid: string | null;
    activeInbounds: Array<{ uuid: string; tag: string | null }>;
  }>;
  profiles: Array<{
    uuid: string;
    name: string | null;
    inbounds: Array<{ uuid: string; tag: string | null; type: string | null }>;
  }>;
  hosts: Array<{
    uuid: string;
    remark: string | null;
    inboundUuid: string | null;
    isDisabled: boolean;
  }>;
  squads: Array<{ uuid: string; name: string | null; membersCount: number }>;
  gaps: Gaps;
  suppressed: Array<{ gap: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * Формы из снимков работающих панелей — и большой, в десятки нод, и совсем
 * маленькой. Реальный xray-конфиг лежит инлайном в ДВУХ местах —
 * profile.config и rawInbound каждого инбаунда, в том числе внутри
 * node.configProfile.activeInbounds, — и несёт Reality privateKey.
 */
const rawInbound = (tag: string): Record<string, unknown> => ({
  tag,
  port: 2053,
  protocol: 'vless',
  streamSettings: {
    security: 'reality',
    realitySettings: { shortIds: ['0858af97f4e7324d'], privateKey: 'SECRET-REALITY-KEY' },
  },
});

const inbound = (uuid: string, tag: string): Record<string, unknown> => ({
  uuid,
  profileUuid: 'p-1',
  tag,
  type: 'vless',
  network: 'raw',
  security: 'reality',
  port: 2053,
  rawInbound: rawInbound(tag),
  activeSquads: ['s-1'],
});

const I_DE = inbound('i-de', 'VLESS_TCP_REALITY_de');
const I_DE2 = inbound('i-de2', 'VLESS_TCP_REALITY_de2');
// Мост берёт трафик с другой ноды, а не от клиентов: скрипт настройки моста
// заводит его, включает на ноде, кладёт в сквад — и хоста НЕ создаёт.
const I_BRIDGE = inbound('i-bridge', 'BRIDGE_RU_IN');
// Существует в профиле, но не включён ни на одной ноде и не опубликован.
const I_UNUSED = inbound('i-unused', 'VLESS_TCP_REALITY_unused');

const node = (
  uuid: string,
  name: string,
  countryCode: string,
  profile: Record<string, unknown>,
): Record<string, unknown> => ({
  uuid,
  name,
  countryCode,
  address: '192.0.2.1',
  port: 2222,
  isConnected: true,
  isDisabled: false,
  lastStatusChange: '2026-08-01T09:06:04.411Z',
  usersOnline: 10,
  configProfile: profile,
});

const NODES = [
  node('n-de', 'de-1', 'DE', { activeConfigProfileUuid: 'p-1', activeInbounds: [I_DE, I_DE2] }),
  node('n-ru', 'ru-relay', 'RU', { activeConfigProfileUuid: 'p-1', activeInbounds: [I_BRIDGE] }),
  node('n-orphan', 'ORPHAN', 'DE', {}),
];

const PROFILES = {
  total: 1,
  configProfiles: [
    {
      uuid: 'p-1',
      name: 'Steal',
      viewPosition: 0,
      config: {
        inbounds: [
          {
            tag: 'VLESS_TCP_REALITY_de',
            streamSettings: { realitySettings: { privateKey: 'SECRET-REALITY-KEY' } },
          },
        ],
      },
      inbounds: [I_DE, I_DE2, I_BRIDGE, I_UNUSED],
      nodes: [],
    },
  ],
};

const INBOUNDS = { total: 4, inbounds: [I_DE, I_DE2, I_BRIDGE, I_UNUSED] };

const host = (
  uuid: string,
  remark: string,
  inboundUuid: string,
  isDisabled = false,
): Record<string, unknown> => ({
  uuid,
  remark,
  address: 'shop.example.ru',
  port: 2053,
  isDisabled,
  isHidden: false,
  inbound: { configProfileUuid: 'p-1', configProfileInboundUuid: inboundUuid },
  nodes: [],
});

const HOSTS = [
  host('h-de', '🇩🇪 Германия 1', 'i-de'),
  // Единственный хост своего инбаунда, и он выключен: страна погасла молча.
  host('h-de2', '🇩🇪 Германия 8', 'i-de2', true),
  host('h-zombie', 'ZOMBIE', 'i-gone'),
];

const SQUADS = {
  total: 1,
  internalSquads: [
    {
      uuid: 's-1',
      name: 'vk-turn',
      info: { membersCount: 12, inboundsCount: 1 },
      inbounds: [I_BRIDGE],
    },
  ],
};

const routes = (path: string): unknown => {
  if (path === '/api/nodes') return NODES;
  if (path === '/api/config-profiles') return PROFILES;
  if (path === '/api/config-profiles/inbounds') return INBOUNDS;
  if (path === '/api/hosts') return HOSTS;
  if (path === '/api/internal-squads') return SQUADS;
  throw new Error(`unexpected path ${path}`);
};

const without = (dead: string, error = 'HTTP 404') => (path: string): unknown => {
  if (path === dead) throw new Error(error);
  return routes(path);
};

const codes = (result: MapOut): string[] => result.warnings.map((one) => one.code);
const suppressedGaps = (result: MapOut): string[] => result.suppressed.map((one) => one.gap);

describe('infra_map', () => {
  it('maps the panel and highlights zombie hosts and nodes without a profile', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.hostsWithUnknownInbound).toEqual([
      { uuid: 'h-zombie', remark: 'ZOMBIE', inboundUuid: 'i-gone' },
    ]);
    expect(result.gaps.nodesWithoutProfile).toEqual([{ uuid: 'n-orphan', name: 'ORPHAN' }]);
    expect(result.gaps.disabledHosts).toBe(1);
    expect(result.squads).toEqual([{ uuid: 's-1', name: 'vk-turn', membersCount: 12 }]);
    expect(result.counts).toEqual({
      nodes: 3,
      profiles: 1,
      inbounds: 4,
      hosts: 3,
      squads: 1,
      reported: { profiles: 1, inbounds: 4, squads: 1 },
    });
  });

  it('calls an inbound unhosted only when a node actually serves it', async () => {
    // I3: на снимках работающих панелей наивный алгоритм объявляет «дырой»
    // изрядную часть инбаундов, включая BRIDGE_DE_IN и BRIDGE_RU_IN. Агент,
    // чинящий такую «дыру», опубликует клиентам внутренний релейный хоп.
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.inboundsActiveWithoutHost).toEqual([
      { uuid: 'i-bridge', tag: 'BRIDGE_RU_IN', activeOnNodes: ['n-ru'] },
    ]);
    const relay = result.warnings.find((one) => one.code === 'unhosted_inbound_may_be_a_relay');
    expect(relay).toBeDefined();
    expect(relay?.message).toContain('bridge');
  });

  it('names the inbounds whose only host is switched off', async () => {
    // I4: на каждой из просмотренных панелей набирается по нескольку таких
    // инбаундов — резервные направления и точки входа, выключенные «на время».
    // Голый счётчик disabledHosts об этом молчит.
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.inboundsPublishedOnlyByDisabledHosts).toEqual([
      { uuid: 'i-de2', tag: 'VLESS_TCP_REALITY_de2' },
    ]);
    const dark = result.warnings.find((one) => one.code === 'inbounds_left_without_a_live_host');
    expect(dark).toBeDefined();
    expect(dark?.message).toContain('disabled');
  });

  it('never returns a raw xray config, from a profile or from a node', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-REALITY-KEY');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('rawInbound');
    expect(result.profiles[0]?.inbounds).toEqual([
      { uuid: 'i-de', tag: 'VLESS_TCP_REALITY_de', type: 'vless' },
      { uuid: 'i-de2', tag: 'VLESS_TCP_REALITY_de2', type: 'vless' },
      { uuid: 'i-bridge', tag: 'BRIDGE_RU_IN', type: 'vless' },
      { uuid: 'i-unused', tag: 'VLESS_TCP_REALITY_unused', type: 'vless' },
    ]);
    expect(result.nodes[0]?.activeInbounds).toEqual([
      { uuid: 'i-de', tag: 'VLESS_TCP_REALITY_de' },
      { uuid: 'i-de2', tag: 'VLESS_TCP_REALITY_de2' },
    ]);
  });

  it('degrades softly when one route is unavailable', async () => {
    const ctx = makeCtx({ remnaGet: without('/api/internal-squads') });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.squads).toEqual([]);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'HTTP 404' }]);
    expect(result.nodes).toHaveLength(3);
    expect(codes(result)).toContain('partial_result');
    // Сквады ни на одну дыру не влияют — остальное считается как обычно.
    expect(result.suppressed).toEqual([]);
    expect(result.gaps.hostsWithUnknownInbound).toHaveLength(1);
  });

  it('keeps the host gap honest when the flat inbound listing fails', async () => {
    // I2: список известных инбаундов есть и в /api/config-profiles, поэтому одна
    // упавшая ручка не превращает КАЖДЫЙ хост в «указывает на несуществующий
    // инбаунд» — на снимках это ложная находка про каждый хост до единого.
    const ctx = makeCtx({ remnaGet: without('/api/config-profiles/inbounds') });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.hostsWithUnknownInbound).toEqual([
      { uuid: 'h-zombie', remark: 'ZOMBIE', inboundUuid: 'i-gone' },
    ]);
    expect(result.counts.inbounds).toBe(4);
  });

  it('suppresses the host gap when no inbound listing answered at all', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/config-profiles' || path === '/api/config-profiles/inbounds') {
          throw new Error('HTTP 500');
        }
        return routes(path);
      },
    });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.hostsWithUnknownInbound).toBeNull();
    expect(suppressedGaps(result)).toContain('hostsWithUnknownInbound');
    // То, что от инбаундов не зависит, считается по-прежнему.
    expect(result.gaps.nodesWithoutProfile).toEqual([{ uuid: 'n-orphan', name: 'ORPHAN' }]);
    expect(result.gaps.disabledHosts).toBe(1);
  });

  it('suppresses the host gap when the surviving listing yields no inbound at all', async () => {
    // «Ответил целиком» ещё не значит «назвал хоть один инбаунд»: пустой
    // (или без вложенных inbounds) листинг профилей вместе с упавшей плоской
    // ручкой даёт пустое множество известных — и та же инверсия I2, только
    // через дверь поуже.
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/config-profiles/inbounds') throw new Error('HTTP 500');
        if (path === '/api/config-profiles') return { total: 0, configProfiles: [] };
        return routes(path);
      },
    });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.hostsWithUnknownInbound).toBeNull();
    expect(suppressedGaps(result)).toContain('hostsWithUnknownInbound');
  });

  it('does not turn every inbound into a gap when the host listing fails', async () => {
    // Симметрия I2: без хостов «этот инбаунд никто не публикует» становится
    // истинным про все инбаунды панели сразу.
    const ctx = makeCtx({ remnaGet: without('/api/hosts', 'HTTP 502') });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.inboundsActiveWithoutHost).toBeNull();
    expect(result.gaps.inboundsPublishedOnlyByDisabledHosts).toBeNull();
    expect(result.gaps.hostsWithUnknownInbound).toBeNull();
    expect(result.gaps.disabledHosts).toBeNull();
    expect(suppressedGaps(result)).toEqual(
      expect.arrayContaining([
        'hostsWithUnknownInbound',
        'inboundsActiveWithoutHost',
        'inboundsPublishedOnlyByDisabledHosts',
        'disabledHosts',
      ]),
    );
    expect(result.gaps.nodesWithoutProfile).toEqual([{ uuid: 'n-orphan', name: 'ORPHAN' }]);
  });

  it('suppresses the node gaps when the node listing fails', async () => {
    const ctx = makeCtx({ remnaGet: without('/api/nodes', 'HTTP 503') });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.gaps.nodesWithoutProfile).toBeNull();
    expect(result.gaps.inboundsActiveWithoutHost).toBeNull();
    expect(suppressedGaps(result)).toContain('nodesWithoutProfile');
    expect(result.gaps.hostsWithUnknownInbound).toHaveLength(1);
  });

  it('surfaces the totals the panel reports and refuses to guess from a short listing', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/config-profiles/inbounds') return { total: 9, inbounds: [I_DE] };
        if (path === '/api/config-profiles') {
          return { total: 5, configProfiles: PROFILES.configProfiles };
        }
        return routes(path);
      },
    });
    const result = (await infraMap.handler({}, ctx)) as MapOut;
    expect(result.counts.reported).toEqual({ profiles: 5, inbounds: 9, squads: 1 });
    const truncated = result.warnings.find((one) => one.code === 'truncated');
    expect(truncated).toBeDefined();
    expect(result.gaps.hostsWithUnknownInbound).toBeNull();
    expect(suppressedGaps(result)).toContain('hostsWithUnknownInbound');
  });

  it('is a human-only tool: the map is topology, not client support', () => {
    expect(infraMap.profiles).toEqual(['human']);
    expect(infraMap.access).toBe('ro');
  });

  it('summarizes mapper operations and preserves ordered node integrations without config values', async () => {
    const ctx = makeCtx({ remnaGet: (path) => {
      if (path === '/api/nodes') return [{
        ...NODES[0], integrationUuids: ['integration-second', 'integration-first'],
      }];
      if (path === '/api/hosts') return [{
        ...HOSTS[0], mapper: {
          xrayJson: [{ op: 'set', to: 'password', value: 'DO-NOT-RETURN-MAPPER-VALUE' }],
          singbox: [{ op: 'unset', to: 'tls.insecure' }, { op: 'copy', from: '$host.port', to: 'server_port' }],
        },
      }];
      return routes(path);
    } });
    const result = await infraMap.handler({}, ctx) as {
      nodes: Array<{ integrationUuids: string[] | null }>;
      hosts: Array<{ mapper: { configured: boolean; operations: Record<string, number> } | null }>;
    };
    expect(result.nodes[0]?.integrationUuids).toEqual(['integration-second', 'integration-first']);
    expect(result.hosts[0]?.mapper).toEqual({
      configured: true, operations: { xrayJson: 1, mihomo: 0, base64: 0, singbox: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN-MAPPER-VALUE');
    expect(JSON.stringify(result)).not.toContain('tls.insecure');
  });

  it('distinguishes absent extension fields from configured empty arrays', async () => {
    const result = await infraMap.handler({}, makeCtx({ remnaGet: routes })) as {
      nodes: Array<{ integrationUuids: string[] | null }>;
      hosts: Array<{ mapper: unknown }>;
    };
    expect(result.nodes[0]?.integrationUuids).toBeNull();
    expect(result.hosts[0]?.mapper).toBeNull();
  });
});
