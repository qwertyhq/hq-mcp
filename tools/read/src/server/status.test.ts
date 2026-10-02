import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import {
  STATUS_DROP_RATIO_VAR,
  STATUS_MIN_EXPECTED_VAR,
  serverStatus,
  statusThresholds,
} from './status.js';

interface NodeOut {
  name: string;
  status: 'online' | 'offline' | 'disabled';
  usersOnline: number;
  expectedOnline: number | null;
  onlineDrop: boolean;
  since: string | null;
}

interface StatusOut {
  generatedAt: string;
  overall: 'ok' | 'degraded' | 'outage' | 'unknown';
  countries: Array<{
    countryCode: string;
    status: 'ok' | 'degraded' | 'down';
    reasons: string[];
    nodes: NodeOut[];
  }>;
  subscription: {
    hostsByClient: Record<'xray_json' | 'mihomo' | 'singbox' | 'base64', string[]>;
    hostsByType: Record<string, string[]>;
  };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * Формы — как у работающей панели 3.3.2 (имена полей сняты с живого ответа),
 * значения выдуманы: адреса из 192.0.2.0/24, домены example.com. Именно эти
 * значения тест потом ищет в ответе — инструмент для бота не имеет права
 * отдать ни одно из них.
 */
const REALITY_KEY = 'c3ludGhldGljLXJlYWxpdHkta2V5LWZvci10ZXN0cy0wMDAx';
const inbound = (
  uuid: string,
  tag: string,
  type: string,
  network: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  uuid,
  profileUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
  tag,
  type,
  network,
  security: type === 'hysteria' ? 'tls' : 'reality',
  port: 8443,
  rawInbound: {
    tag,
    port: 8443,
    protocol: type,
    settings: { clients: [], ...extra },
    streamSettings: {
      network,
      realitySettings: { privateKey: REALITY_KEY, serverNames: ['cover.example.com'] },
    },
  },
});

const I_VISION = inbound('10000000-0000-4000-8000-000000000001', 'DE_VLESS_VISION', 'vless', 'raw');
const I_XHTTP = inbound('10000000-0000-4000-8000-000000000002', 'DE_VLESS_XHTTP', 'vless', 'xhttp');
const I_HY2 = inbound('10000000-0000-4000-8000-000000000003', 'DE_HY2', 'hysteria', 'hysteria');
const I_TROJAN = inbound('10000000-0000-4000-8000-000000000004', 'DE_TROJAN', 'trojan', 'raw');
const I_PL = inbound('10000000-0000-4000-8000-000000000005', 'PL_VLESS', 'vless', 'raw');
const I_EE = inbound('10000000-0000-4000-8000-000000000006', 'EE_VLESS', 'vless', 'raw');
const I_NL = inbound('10000000-0000-4000-8000-000000000007', 'NL_VLESS', 'vless', 'raw');
const I_OBHOD = inbound('10000000-0000-4000-8000-000000000008', 'RU_OBHOD', 'vless', 'raw');
const DE_INBOUNDS = [I_VISION, I_XHTTP, I_HY2, I_TROJAN];

const node = (
  uuid: string,
  name: string,
  countryCode: string,
  state: { isConnected: boolean; isDisabled?: boolean; usersOnline: number; since?: string | null },
  inbounds: Array<Record<string, unknown>>,
  viewPosition = 0,
): Record<string, unknown> => ({
  uuid,
  name,
  countryCode,
  address: '192.0.2.10',
  port: 2222,
  ips: ['192.0.2.11'],
  isConnected: state.isConnected,
  isConnecting: false,
  isDisabled: state.isDisabled ?? false,
  lastStatusChange: state.since === undefined ? '2026-08-08T10:00:00.000Z' : state.since,
  lastStatusMessage: null,
  usersOnline: state.usersOnline,
  viewPosition,
  configProfile: { activeConfigProfileUuid: 'aaaaaaaa-0000-4000-8000-000000000001', activeInbounds: inbounds },
});

const N_DE1 = '20000000-0000-4000-8000-000000000001';
const N_DE2 = '20000000-0000-4000-8000-000000000002';
const N_NL1 = '20000000-0000-4000-8000-000000000003';
const N_PL1 = '20000000-0000-4000-8000-000000000004';
const N_EE1 = '20000000-0000-4000-8000-000000000005';
const N_XX = '20000000-0000-4000-8000-000000000006';

/** Онлайн по флоту = 12 + 0 + 0 + 1 + 20 + 0 = 33. */
const NODES = [
  node(N_DE1, 'DE-01', 'DE', { isConnected: true, usersOnline: 12 }, DE_INBOUNDS, 1),
  node(N_DE2, 'DE-02', 'DE', { isConnected: false, usersOnline: 0, since: null }, DE_INBOUNDS, 2),
  node(N_NL1, 'NL-01', 'NL', { isConnected: false, isDisabled: true, usersOnline: 0 }, [I_NL], 3),
  node(N_PL1, 'PL-01', 'PL', { isConnected: true, usersOnline: 1 }, [I_PL], 4),
  node(N_EE1, 'EE-01', 'EE', { isConnected: true, usersOnline: 20 }, [I_EE], 5),
  // Remnawave пишет XX, когда страна ноды не задана.
  node(N_XX, 'spare', 'XX', { isConnected: true, usersOnline: 0 }, [], 6),
];

/**
 * Доли трафика за неделю: DE-01 0.3, DE-02 0.1, PL-01 0.4, EE-01 0.2, у NL-01
 * строки нет. Ожидаемый онлайн: DE-01 9.9, DE-02 3.3, PL-01 13.2, EE-01 6.6.
 */
const series = (uuid: string, name: string, countryCode: string, total: number) => ({
  uuid,
  name,
  color: '#fff',
  countryCode,
  total,
  data: [total],
});
const BANDWIDTH = {
  categories: ['2026-08-08'],
  sparklineData: [1000],
  topNodes: [],
  series: [
    series(N_DE1, 'DE-01', 'DE', 300),
    series(N_DE2, 'DE-02', 'DE', 100),
    series(N_PL1, 'PL-01', 'PL', 400),
    series(N_EE1, 'EE-01', 'EE', 200),
  ],
};

const host = (
  uuid: string,
  remark: string,
  inboundUuid: string,
  viewPosition: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  uuid,
  remark,
  address: '192.0.2.20',
  port: 443,
  sni: 'sni.example.com',
  host: 'front.example.com',
  path: '/secret-path',
  viewPosition,
  isDisabled: false,
  isHidden: false,
  securityLayer: 'DEFAULT',
  excludeFromSubscriptionTypes: [],
  excludedInternalSquads: [],
  tags: [],
  mapper: [],
  shuffleHost: false,
  nodes: [],
  inbound: {
    configProfileUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
    configProfileInboundUuid: inboundUuid,
  },
  ...extra,
});

const HOSTS = [
  // Порядок в массиве перепутан намеренно: выдачу решает viewPosition.
  host('30000000-0000-4000-8000-000000000003', '📱 🇩🇪 Germany XHTTP', I_XHTTP.uuid as string, 3, {
    excludeFromSubscriptionTypes: ['XRAY_JSON'],
  }),
  host('30000000-0000-4000-8000-000000000001', '🌎 Auto', I_VISION.uuid as string, 1, {
    excludeFromSubscriptionTypes: ['XRAY_BASE64', 'STASH', 'MIHOMO', 'SINGBOX', 'CLASH'],
    xrayJsonTemplateUuid: '40000000-0000-4000-8000-000000000001',
  }),
  host('30000000-0000-4000-8000-000000000002', '🇩🇪 Germany', I_VISION.uuid as string, 2),
  host('30000000-0000-4000-8000-000000000004', '⚡ 🇩🇪 Germany H2', I_HY2.uuid as string, 4, {
    excludeFromSubscriptionTypes: ['XRAY_JSON'],
  }),
  host('30000000-0000-4000-8000-000000000005', '🇩🇪 Germany Trojan', I_TROJAN.uuid as string, 5),
  host('30000000-0000-4000-8000-000000000006', 'DE auto · VLESS', I_VISION.uuid as string, 6, {
    isHidden: true,
    tags: ['AUTO_DE_A'],
  }),
  host('30000000-0000-4000-8000-000000000007', '🇩🇪 Germany old', I_VISION.uuid as string, 7, {
    isDisabled: true,
  }),
  // Инбаунда нет ни в одном скваде — панель такой хост не отдаст никому.
  host('30000000-0000-4000-8000-000000000008', 'orphan', '10000000-0000-4000-8000-0000000000ff', 8),
  host('30000000-0000-4000-8000-000000000009', '🇵🇱 Poland', I_PL.uuid as string, 9),
  host('30000000-0000-4000-8000-000000000010', '🇪🇪 Estonia', I_EE.uuid as string, 10),
  host('30000000-0000-4000-8000-000000000011', '🇳🇱 Netherlands', I_NL.uuid as string, 11),
  host('30000000-0000-4000-8000-000000000012', '🇷🇺 Obhod', I_OBHOD.uuid as string, 12),
];

const SQ_DEFAULT = '50000000-0000-4000-8000-000000000001';
const SQ_OBHOD = '50000000-0000-4000-8000-000000000002';
const SQUADS = {
  total: 2,
  internalSquads: [
    {
      uuid: SQ_DEFAULT,
      name: 'Default-Squad',
      viewPosition: 1,
      info: { membersCount: 40, inboundsCount: 7 },
      inbounds: [...DE_INBOUNDS, I_PL, I_EE, I_NL],
    },
    {
      uuid: SQ_OBHOD,
      name: 'Obhod',
      viewPosition: 2,
      info: { membersCount: 3, inboundsCount: 1 },
      inbounds: [I_OBHOD],
    },
  ],
};

type Routes = Record<string, unknown>;
const BASE_ROUTES: Routes = {
  '/api/nodes': NODES,
  '/api/bandwidth-stats/nodes': BANDWIDTH,
  '/api/hosts': HOSTS,
  '/api/internal-squads': SQUADS,
};

function ctxWith(overrides: Routes = {}, calls: StubCall[] = []) {
  const routes: Routes = { ...BASE_ROUTES, ...overrides };
  return makeCtx({
    calls,
    now: new Date('2026-08-08T12:00:00.000Z'),
    remnaGet: (path) => {
      if (!(path in routes)) throw new Error(`unexpected path ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    },
  });
}

async function run(input: Record<string, unknown> = {}, overrides: Routes = {}): Promise<StatusOut> {
  const parsed = serverStatus.input.parse(input) as never;
  return (await serverStatus.handler(parsed, ctxWith(overrides))) as StatusOut;
}

const codes = (out: StatusOut): string[] => out.warnings.map((one) => one.code);
const country = (out: StatusOut, code: string) => out.countries.find((one) => one.countryCode === code);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server_status', () => {
  it('is a read-only, bot-visible tool over the panel alone', () => {
    expect(serverStatus.name).toBe('server_status');
    expect(serverStatus.access).toBe('ro');
    expect(serverStatus.risk).toBe('low');
    expect(serverStatus.profiles).toEqual(['human', 'bot']);
    expect(serverStatus.backends).toEqual(['remna']);
  });

  it('reads only GET routes of the panel and never the subscription settings', async () => {
    const calls: StubCall[] = [];
    const parsed = serverStatus.input.parse({}) as never;
    await serverStatus.handler(parsed, ctxWith({}, calls));
    expect(calls.every((one) => one.system === 'remna' && one.method === 'GET')).toBe(true);
    expect(calls.map((one) => one.path).sort()).toEqual([
      '/api/bandwidth-stats/nodes',
      '/api/hosts',
      '/api/internal-squads',
      '/api/nodes',
    ]);
  });

  it('derives country status from node state and the weekly traffic baseline', async () => {
    const out = await run();
    expect(out.generatedAt).toBe('2026-08-08T12:00:00.000Z');
    expect(out.countries.map((one) => one.countryCode)).toEqual(['DE', 'EE', 'NL', 'PL']);

    const de = country(out, 'DE');
    expect(de?.status).toBe('degraded');
    expect(de?.reasons).toEqual(['node_offline']);
    expect(de?.nodes).toEqual([
      {
        name: 'DE-01',
        status: 'online',
        usersOnline: 12,
        expectedOnline: 9.9,
        onlineDrop: false,
        since: '2026-08-08T10:00:00.000Z',
      },
      {
        name: 'DE-02',
        status: 'offline',
        usersOnline: 0,
        expectedOnline: 3.3,
        onlineDrop: false,
        since: null,
      },
    ]);

    expect(country(out, 'EE')).toMatchObject({ status: 'ok', reasons: [] });
    // Единственная нода страны выключена — страны для клиента нет.
    expect(country(out, 'NL')).toMatchObject({ status: 'down', reasons: ['node_disabled'] });
    expect(country(out, 'NL')?.nodes[0]).toMatchObject({ status: 'disabled', expectedOnline: 0 });

    const pl = country(out, 'PL');
    expect(pl).toMatchObject({ status: 'degraded', reasons: ['online_drop'] });
    expect(pl?.nodes[0]).toMatchObject({ usersOnline: 1, expectedOnline: 13.2, onlineDrop: true });

    expect(out.overall).toBe('degraded');
    expect(out.degraded).toEqual([]);
  });

  it('leaves a node without a country out of the countries and says so', async () => {
    const out = await run();
    expect(out.countries.some((one) => one.countryCode === 'XX')).toBe(false);
    expect(codes(out)).toContain('nodes_without_country');
  });

  it('filters by country case-insensitively and keeps overall fleet-wide', async () => {
    const out = await run({ country: 'de' });
    expect(out.countries.map((one) => one.countryCode)).toEqual(['DE']);
    expect(out.overall).toBe('degraded');
  });

  it('answers a country the panel does not have with no_nodes, not with silence', async () => {
    const out = await run({ country: 'JP' });
    expect(out.countries).toEqual([{ countryCode: 'JP', status: 'down', reasons: ['no_nodes'], nodes: [] }]);
    expect(codes(out)).toContain('country_not_in_panel');
  });

  it('rejects a country that is not a two-letter code', () => {
    expect(() => serverStatus.input.parse({ country: 'Germany' })).toThrow();
    expect(() => serverStatus.input.parse({ country: 'D1' })).toThrow();
  });

  it('calls it an outage only when every country is down', async () => {
    const allDown = NODES.map((one) => ({ ...one, isConnected: false }));
    const out = await run({}, { '/api/nodes': allDown });
    expect(out.countries.every((one) => one.status === 'down')).toBe(true);
    expect(country(out, 'DE')?.reasons).toEqual(['node_offline']);
    expect(out.overall).toBe('outage');
  });

  it('reports ok when every node is online and none dropped', async () => {
    const healthy = NODES.map((one) => ({ ...one, isConnected: true, isDisabled: false, usersOnline: 10 }));
    const out = await run({}, { '/api/nodes': healthy });
    expect(out.overall).toBe('ok');
    expect(out.countries.every((one) => one.status === 'ok' && one.reasons.length === 0)).toBe(true);
  });

  it('says unknown, not ok and not outage, when the node list does not answer', async () => {
    const out = await run({}, { '/api/nodes': new Error('Remnawave GET /api/nodes: 502') });
    expect(out.overall).toBe('unknown');
    expect(out.countries).toEqual([]);
    expect(out.degraded).toEqual([{ system: 'remna', error: 'Remnawave GET /api/nodes: 502' }]);
  });

  it('has no baseline without the traffic chart: expectedOnline null, no drop', async () => {
    const out = await run({}, { '/api/bandwidth-stats/nodes': new Error('timeout') });
    const pl = country(out, 'PL');
    expect(pl?.nodes[0]).toMatchObject({ expectedOnline: null, onlineDrop: false });
    expect(pl?.status).toBe('ok');
    expect(out.degraded.map((one) => one.system)).toEqual(['remna']);
  });

  it('has no baseline when the week carried no traffic at all', async () => {
    const out = await run({}, { '/api/bandwidth-stats/nodes': { ...BANDWIDTH, series: [] } });
    expect(out.countries.flatMap((one) => one.nodes).every((one) => one.expectedOnline === null)).toBe(true);
  });

  it('does not invent a zero baseline for a node a truncated chart left out', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      series(`60000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `X-${String(i)}`, 'XX', 1),
    );
    const out = await run({}, { '/api/bandwidth-stats/nodes': { ...BANDWIDTH, series: [...many] } });
    expect(country(out, 'NL')?.nodes[0]?.expectedOnline).toBeNull();
  });

  it('reads the drop thresholds from the environment', async () => {
    vi.stubEnv(STATUS_MIN_EXPECTED_VAR, '50');
    const out = await run();
    expect(country(out, 'PL')).toMatchObject({ status: 'ok', reasons: [] });

    vi.stubEnv(STATUS_MIN_EXPECTED_VAR, '5');
    vi.stubEnv(STATUS_DROP_RATIO_VAR, '0.05');
    const strict = await run();
    expect(country(strict, 'PL')?.nodes[0]?.onlineDrop).toBe(false);
  });

  it('falls back to the defaults on a malformed threshold and says so', async () => {
    expect(statusThresholds({})).toEqual({ minExpected: 5, dropRatio: 0.3, invalid: [] });
    expect(statusThresholds({ [STATUS_DROP_RATIO_VAR]: '2' })).toEqual({
      minExpected: 5,
      dropRatio: 0.3,
      invalid: [STATUS_DROP_RATIO_VAR],
    });
    vi.stubEnv(STATUS_MIN_EXPECTED_VAR, 'many');
    const out = await run();
    expect(codes(out)).toContain('status_threshold_invalid');
    expect(country(out, 'PL')?.nodes[0]?.onlineDrop).toBe(true);
  });

  it('lists what each client format shows, in panel order, the way Remnawave 3.3.2 builds it', async () => {
    const out = await run();
    const rest = ['🇩🇪 Germany Trojan', '🇵🇱 Poland', '🇪🇪 Estonia', '🇳🇱 Netherlands'];
    expect(out.subscription.hostsByClient).toEqual({
      // Скрытые, выключенные, исключённые для формата и хосты чужого сквада — вне списка.
      xray_json: ['🌎 Auto', '🇩🇪 Germany', ...rest],
      // Mihomo умеет и xhttp, и hysteria: пропускает он только kcp.
      mihomo: ['🇩🇪 Germany', '📱 🇩🇪 Germany XHTTP', '⚡ 🇩🇪 Germany H2', ...rest],
      // sing-box не умеет xhttp — генератор панели такой хост пропускает.
      singbox: ['🇩🇪 Germany', '⚡ 🇩🇪 Germany H2', ...rest],
      base64: ['🇩🇪 Germany', '📱 🇩🇪 Germany XHTTP', '⚡ 🇩🇪 Germany H2', ...rest],
    });
    // Классический Clash не умеет ни vless, ни hysteria; Stash — xhttp.
    expect(out.subscription.hostsByType.CLASH).toEqual(['🇩🇪 Germany Trojan']);
    expect(out.subscription.hostsByType.STASH).toEqual([
      '🇩🇪 Germany',
      '⚡ 🇩🇪 Germany H2',
      '🇩🇪 Germany Trojan',
      '🇵🇱 Poland',
      '🇪🇪 Estonia',
      '🇳🇱 Netherlands',
    ]);
    expect(Object.keys(out.subscription.hostsByType).sort()).toEqual([
      'CLASH',
      'MIHOMO',
      'SINGBOX',
      'STASH',
      'XRAY_BASE64',
      'XRAY_JSON',
    ]);
    // Список строится для самого населённого сквада, а соседний видит иначе.
    expect(codes(out)).toContain('subscription_varies_by_squad');
  });

  it('drops a host the reference squad excludes, and a vless host with encryption from sing-box', async () => {
    const encrypted = inbound('10000000-0000-4000-8000-000000000009', 'DE_VLESS_ENC', 'vless', 'raw', {
      decryption: 'mlkem768x25519plus.native.600s.c3ludGhldGlj',
    });
    const nodes = NODES.map((one) =>
      one.uuid === N_DE1
        ? { ...one, configProfile: { activeInbounds: [...DE_INBOUNDS, encrypted] } }
        : one,
    );
    const squads = {
      ...SQUADS,
      internalSquads: [
        { ...SQUADS.internalSquads[0], inbounds: [...(SQUADS.internalSquads[0]?.inbounds ?? []), encrypted] },
        SQUADS.internalSquads[1],
      ],
    };
    const hosts = [
      ...HOSTS,
      host('30000000-0000-4000-8000-000000000013', 'ENC', encrypted.uuid as string, 13),
      host('30000000-0000-4000-8000-000000000014', 'Excluded', I_VISION.uuid as string, 14, {
        excludedInternalSquads: [SQ_DEFAULT],
      }),
    ];
    const out = await run({}, { '/api/nodes': nodes, '/api/internal-squads': squads, '/api/hosts': hosts });
    expect(out.subscription.hostsByClient.base64).toContain('ENC');
    expect(out.subscription.hostsByClient.singbox).not.toContain('ENC');
    expect(out.subscription.hostsByClient.base64).not.toContain('Excluded');
  });

  it('suffixes a repeated remark the way the panel does', async () => {
    const hosts = [
      host('30000000-0000-4000-8000-000000000021', 'Same', I_VISION.uuid as string, 1),
      host('30000000-0000-4000-8000-000000000022', 'Same', I_TROJAN.uuid as string, 2),
    ];
    const out = await run({}, { '/api/hosts': hosts });
    expect(out.subscription.hostsByClient.base64).toEqual(['Same', 'Same ^~2~^']);
  });

  it('warns when a remark is templated per user or a host mapper may rename it', async () => {
    const hosts = [
      host('30000000-0000-4000-8000-000000000031', '{{DAYS_LEFT}} days', I_VISION.uuid as string, 1),
      host('30000000-0000-4000-8000-000000000032', 'Mapped', I_TROJAN.uuid as string, 2, {
        mapper: { mihomo: [{ op: 'set', to: 'name', value: 'Other' }] },
      }),
    ];
    const out = await run({}, { '/api/hosts': hosts });
    expect(codes(out)).toEqual(expect.arrayContaining(['remark_templated', 'host_mapper_present']));
  });

  it('keeps the host lists when the squads do not answer, and says the squad filter is off', async () => {
    const out = await run({}, { '/api/internal-squads': new Error('403') });
    expect(codes(out)).toContain('squads_unread');
    // Без сквадов не доказать, что хост никому не виден, — он остаётся в списке.
    expect(out.subscription.hostsByClient.base64).toContain('orphan');
    expect(out.subscription.hostsByClient.base64).toContain('🇷🇺 Obhod');
    expect(out.degraded).toEqual([{ system: 'remna', error: '403' }]);
  });

  it('returns empty host lists, not stale ones, when the hosts do not answer', async () => {
    const out = await run({}, { '/api/hosts': new Error('boom') });
    expect(out.subscription.hostsByClient).toEqual({ xray_json: [], mihomo: [], singbox: [], base64: [] });
    expect(codes(out)).toContain('partial_result');
  });

  it('carries no address, port, SNI, inbound tag, uuid or key anywhere in the answer', async () => {
    const text = JSON.stringify(await run());
    for (const leak of [
      '192.0.2.',
      'example.com',
      '/secret-path',
      REALITY_KEY,
      'DE_VLESS_VISION',
      'AUTO_DE_A',
      'Default-Squad',
      '"port"',
      '"address"',
      '"sni"',
      '"uuid"',
      '"tag"',
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  });

  it('always tells the caller that the panel is blind to the relay data plane', async () => {
    expect(codes(await run())).toContain('panel_blind_to_relay_dataplane');
  });
});
