import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { RELAY_BLINDNESS_WARNING, countryHealth } from './health.js';

interface HostOut {
  uuid: string;
  remark: string | null;
  countryCode: string | null;
  countryCodes: string[];
  inboundUuid: string | null;
  isDisabled: boolean;
  isHidden: boolean;
}

interface HealthOut {
  country: string | null;
  window: { start: string; end: string; days: number };
  totals: { nodes: number; hosts: number };
  nodes: Array<{
    uuid: string;
    name: string | null;
    countryCode: string | null;
    isConnected: boolean;
    isDisabled: boolean;
    lastStatusChange: string | null;
    usersOnline: number;
  }>;
  hosts: HostOut[];
  hostsWithoutCountry: Array<{ uuid: string; remark: string | null; inboundUuid: string | null }>;
  bandwidth: Array<{
    nodeUuid: string;
    name: string | null;
    countryCode: string | null;
    totalBytes: number;
    daily: number[];
  }>;
  bandwidthDays: string[];
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * Формы взяты из снимков работающих панелей, а не из спеки. Ключевое, что
 * оттуда видно и чего не было в исходном брифе: у хоста НЕТ поля countryCode —
 * ни у одного объекта ни в одном из просмотренных снимков, — а страну
 * приходится выводить через инбаунд, который обслуживают ноды.
 */
const rawInbound = (tag: string): Record<string, unknown> => ({
  tag,
  port: 2053,
  listen: '0.0.0.0',
  protocol: 'vless',
  streamSettings: {
    network: 'raw',
    security: 'reality',
    realitySettings: {
      dest: '127.0.0.1:9443',
      shortIds: ['0858af97f4e7324d'],
      privateKey: 'SECRET-REALITY-KEY',
      serverNames: ['shop.example.ru'],
    },
  },
});

const activeInbound = (uuid: string, tag: string): Record<string, unknown> => ({
  uuid,
  profileUuid: 'p-1',
  tag,
  type: 'vless',
  network: 'raw',
  security: 'reality',
  port: 2053,
  rawInbound: rawInbound(tag),
});

const node = (
  uuid: string,
  name: string,
  countryCode: string,
  isConnected: boolean,
  inbounds: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  uuid,
  name,
  countryCode,
  address: '192.0.2.1',
  port: 2222,
  isConnected,
  isConnecting: false,
  isDisabled: false,
  isTrafficTrackingActive: false,
  lastStatusChange: '2026-08-01T09:06:04.411Z',
  lastStatusMessage: null,
  usersOnline: 10,
  viewPosition: 0,
  configProfile: { activeConfigProfileUuid: 'p-1', activeInbounds: inbounds },
});

const host = (
  uuid: string,
  remark: string,
  inboundUuid: string,
  nodes: string[],
  isDisabled = false,
): Record<string, unknown> => ({
  uuid,
  remark,
  address: 'shop.example.ru',
  port: 2053,
  viewPosition: 0,
  isDisabled,
  isHidden: false,
  securityLayer: 'DEFAULT',
  inbound: { configProfileUuid: 'p-1', configProfileInboundUuid: inboundUuid },
  nodes,
});

const I_DE = activeInbound('i-de', 'VLESS_TCP_REALITY_de');
const I_DE2 = activeInbound('i-de2', 'VLESS_TCP_REALITY_de2');
const I_SHARED = activeInbound('i-shared', 'VLESS_TCP_REALITY_shared');

const NODES = [
  node('n-de', 'de-1', 'DE', true, [I_DE, I_DE2]),
  node('n-nl', 'nl-1', 'NL', false, [I_SHARED]),
  node('n-gb', 'gb-1', 'GB', true, [I_SHARED]),
];

const HOSTS = [
  host('h-de', '🇩🇪 Германия 1', 'i-de', ['n-de']),
  // Хост выключен, но страну свою не теряет: он обязан приехать в ответ по DE.
  host('h-de2', '🇩🇪 Германия 8', 'i-de2', [], true),
  // Инбаунд общий для NL и GB — привязка к ноде снимает неоднозначность.
  host('h-nl', '🇳🇱 Нидерланды 1', 'i-shared', ['n-nl']),
  host('h-gb', '🇬🇧 Британия 1', 'i-shared', []),
  // Инбаунда больше нет ни в одном профиле и ни на одной ноде.
  host('h-dead', '🇩🇪 Германия (резерв-2)', 'i-gone', []),
];

/** GetStatsNodesUsageResponseDto: это график, а не строки по нодам. */
const BANDWIDTH = {
  categories: ['2026-08-01', '2026-08-02'],
  sparklineData: [1024, 2048],
  topNodes: [{ uuid: 'n-de', color: '#fff', name: 'de-1', countryCode: 'DE', total: 10737418240 }],
  series: [
    {
      uuid: 'n-de',
      name: 'de-1',
      color: '#fff',
      countryCode: 'DE',
      total: 10737418240,
      data: [5368709120, 5368709120],
    },
    {
      uuid: 'n-nl',
      name: 'nl-1',
      color: '#000',
      countryCode: 'NL',
      total: 1048576,
      data: [524288, 524288],
    },
  ],
};

const METRICS = {
  nodes: [
    {
      nodeUuid: 'n-de',
      nodeName: 'de-1',
      countryEmoji: '🇩🇪',
      providerName: 'hetzner',
      usersOnline: 120,
      inboundsStats: [],
      outboundsStats: [],
    },
  ],
};

const routes = (path: string): unknown => {
  if (path === '/api/nodes') return NODES;
  if (path === '/api/system/nodes/metrics') return METRICS;
  if (path === '/api/bandwidth-stats/nodes') return BANDWIDTH;
  if (path === '/api/hosts') return HOSTS;
  throw new Error(`unexpected path ${path}`);
};

const codes = (result: HealthOut): string[] => result.warnings.map((one) => one.code);

describe('country_health', () => {
  it('always carries the relay blindness warning, even when everything is green', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    const blindness = result.warnings.find((w) => w.code === RELAY_BLINDNESS_WARNING.code);
    expect(blindness).toBeDefined();
    expect(blindness?.message).toContain('relay');
    expect(result.nodes).toHaveLength(3);
    expect(result.totals).toEqual({ nodes: 3, hosts: 5 });
  });

  it('still carries the warning when the panel is completely down, and says so', async () => {
    // Пустой список нод при упавшей панели — не «в стране нет нод». Пять
    // инструментов до этого несут partial_result ровно поэтому.
    const ctx = makeCtx({
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(codes(result)).toContain(RELAY_BLINDNESS_WARNING.code);
    expect(codes(result)).toContain('partial_result');
    expect(result.nodes).toEqual([]);
    expect(result.hosts).toEqual([]);
    expect(result.degraded).toHaveLength(4);
  });

  it('resolves host countries through the inbounds their nodes serve', async () => {
    // C1: ни у одного хоста в просмотренных снимках нет countryCode.
    // Фильтрация по этому полю вернула бы [] на здоровой инфраструктуре, то
    // есть «у страны нет ни одной точки входа».
    const ctx = makeCtx({ remnaGet: routes });
    const de = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(de.country).toBe('DE');
    expect(de.nodes.map((one) => one.uuid)).toEqual(['n-de']);
    expect(de.hosts.map((one) => one.uuid)).toEqual(['h-de', 'h-de2']);
    expect(de.hosts[0]?.countryCode).toBe('DE');
    // Выключенный хост остаётся в стране, а не выпадает из ответа.
    expect(de.hosts[1]?.isDisabled).toBe(true);
  });

  it('narrows a shared inbound by the nodes the host is pinned to', async () => {
    // Случай из работающей панели: 🇫🇮Финляндия 6 и 🇬🇧Великобритания 1 сидят
    // на одном инбаунде, и различает их только host.nodes. Пин при этом НЕ
    // первичен — в другой панели он пуст у всех хостов до единого.
    const ctx = makeCtx({ remnaGet: routes });
    const nl = (await countryHealth.handler({ country_code: 'nl' }, ctx)) as HealthOut;
    expect(nl.hosts.map((one) => one.uuid)).toEqual(['h-nl', 'h-gb']);
    expect(nl.hosts[0]?.countryCode).toBe('NL');
    // Хост без пина остаётся неоднозначным: две страны и ни одной единственной.
    expect(nl.hosts[1]?.countryCodes).toEqual(['NL', 'GB']);
    expect(nl.hosts[1]?.countryCode).toBeNull();
  });

  it('keeps hosts it cannot attribute to any country instead of dropping them', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(result.hostsWithoutCountry.map((one) => one.uuid)).toEqual(['h-dead']);
    expect(codes(result)).toContain('hosts_without_country');
  });

  it('asks bandwidth-stats for a YYYY-MM-DD window with topNodesLimit and nothing else', async () => {
    // topUsersLimit — параметр /api/bandwidth-stats/nodes/{uuid}/users, а не
    // этого маршрута (api-remna.json; в клиентах панели эти два вызова стоят
    // рядом и путаются один с другим). Лимит просится с запасом на весь флот:
    // топ-5 на панели из десятков нод означал бы, что у любой страны вне этой
    // пятёрки трафик — пустой.
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, remnaGet: routes, now: new Date('2026-08-08T12:00:00.000Z') });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    const stats = calls.find((one) => one.path === '/api/bandwidth-stats/nodes');
    expect(stats?.params).toEqual({ start: '2026-08-01', end: '2026-08-08', topNodesLimit: 100 });
    expect(result.window).toEqual({ start: '2026-08-01', end: '2026-08-08', days: 8 });
  });

  it('keeps the Remnawave window in UTC instead of the SHM timezone', async () => {
    // Гвардрейл: ymd() — это toISOString(), и это НЕ дефект задачи 14. Панель
    // хранит трафик в UTC, и работающие клиенты панели считают окно так же,
    // а ctx.shmTz существует только для наивных штампов strftime(localtime) SHM.
    const ctx = makeCtx({
      remnaGet: routes,
      now: new Date('2026-08-08T21:13:00.000Z'),
      shmTz: 'Europe/Moscow',
    });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    expect(result.window.end).toBe('2026-08-08');
    expect(result.window.start).toBe('2026-08-01');
  });

  it('reads the bandwidth chart series and filters it by country', async () => {
    // C2: ответ — {categories, sparklineData, topNodes, series}, а не строки по
    // нодам. asArray от объекта отдаёт [obj], поэтому наивное чтение положило бы
    // весь график одной фальшивой строкой — и трафик Германии уехал бы в ответ
    // про Молдову.
    const ctx = makeCtx({ remnaGet: routes });
    const de = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(de.bandwidth).toEqual([
      {
        nodeUuid: 'n-de',
        name: 'de-1',
        countryCode: 'DE',
        totalBytes: 10737418240,
        // Дневная кривая — единственное поле этой ручки, в котором вообще
        // виден шестичасовой провал: на окне в 8 суток он ~3% от total.
        daily: [5368709120, 5368709120],
      },
    ]);
    expect(de.bandwidthDays).toEqual(['2026-08-01', '2026-08-02']);
    const serialized = JSON.stringify(de);
    expect(serialized).not.toContain('sparklineData');
    expect(serialized).not.toContain('1048576');
  });

  it('says when the country has nodes but none of them appear in the traffic chart', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const gb = (await countryHealth.handler({ country_code: 'gb' }, ctx)) as HealthOut;
    expect(gb.nodes.map((one) => one.uuid)).toEqual(['n-gb']);
    expect(gb.bandwidth).toEqual([]);
    const topN = gb.warnings.find((one) => one.code === 'bandwidth_top_n');
    expect(topN).toBeDefined();
    expect(topN?.message).toContain('top');
  });

  it('notices a chart shorter than the fleet even without a country filter', async () => {
    // Панель может срезать topNodesLimit молча и НИЖЕ запрошенного: тогда
    // «пришло меньше, чем просили» не сработает, а ряды всё равно не покрывают
    // флот. Условие по числу нод ловит любой предел, каким бы он ни был.
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    // 3 ноды в панели, 2 ряда в графике.
    expect(result.totals.nodes).toBe(3);
    expect(result.bandwidth).toHaveLength(2);
    expect(codes(result)).toContain('bandwidth_top_n');
  });

  it('stays quiet when the chart covers every node of the fleet', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/bandwidth-stats/nodes') {
          return {
            categories: ['2026-08-01'],
            sparklineData: [1],
            topNodes: [],
            series: [
              { uuid: 'n-de', name: 'de-1', countryCode: 'DE', total: 3, data: [3] },
              { uuid: 'n-nl', name: 'nl-1', countryCode: 'NL', total: 2, data: [2] },
              { uuid: 'n-gb', name: 'gb-1', countryCode: 'GB', total: 1, data: [1] },
            ],
          };
        }
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    expect(codes(result)).not.toContain('bandwidth_top_n');
  });

  it('does not read an empty chart as a quiet fleet', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/bandwidth-stats/nodes') {
          return { categories: [], sparklineData: [], topNodes: [], series: [] };
        }
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    expect(result.bandwidth).toEqual([]);
    expect(codes(result)).toContain('bandwidth_top_n');
  });

  it('says when the chart came back as long as the limit it asked for', async () => {
    const series = Array.from({ length: 100 }, (_, index) => ({
      uuid: `n-${String(index)}`,
      name: `node-${String(index)}`,
      color: '#fff',
      countryCode: 'DE',
      total: 1024,
      data: [1024],
    }));
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/bandwidth-stats/nodes') {
          return { categories: [], sparklineData: [], topNodes: [], series };
        }
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    expect(codes(result)).toContain('bandwidth_top_n');
  });

  it('does not read an unrecognised chart payload as zero traffic', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/bandwidth-stats/nodes') return { somethingElse: [1, 2, 3] };
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: null }, ctx)) as HealthOut;
    expect(result.bandwidth).toEqual([]);
    expect(codes(result)).toContain('bandwidth_shape_unrecognised');
  });

  it('warns instead of implying an outage when no node carries the country code', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await countryHealth.handler({ country_code: 'md' }, ctx)) as HealthOut;
    expect(result.nodes).toEqual([]);
    const unknown = result.warnings.find((one) => one.code === 'country_not_in_panel');
    expect(unknown).toBeDefined();
    expect(unknown?.message).toContain('DE');
  });

  it('refuses to attribute hosts to a country when the node listing failed', async () => {
    // Страна хоста выводится ЧЕРЕЗ ноды. Если их нет, «в DE нет хостов» и
    // «все хосты панели без страны» — обе выдумки упавшего источника.
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/nodes') throw new Error('HTTP 503');
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(result.hosts).toEqual([]);
    expect(result.hostsWithoutCountry).toEqual([]);
    expect(codes(result)).toContain('hosts_not_attributable');
    expect(codes(result)).toContain('partial_result');
    expect(codes(result)).not.toContain('hosts_without_country');
  });

  it('survives one route failing and falls back to the node row for usersOnline', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/system/nodes/metrics') throw new Error('HTTP 500');
        return routes(path);
      },
    });
    const result = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(result.degraded).toEqual([{ system: 'remna', error: 'HTTP 500' }]);
    expect(codes(result)).toContain('partial_result');
    expect(result.nodes[0]?.usersOnline).toBe(10);
  });

  it('joins the metrics route on nodeUuid for the online count', async () => {
    const ctx = makeCtx({ remnaGet: routes });
    const result = (await countryHealth.handler({ country_code: 'de' }, ctx)) as HealthOut;
    expect(result.nodes[0]?.usersOnline).toBe(120);
    expect(result.nodes[0]?.isConnected).toBe(true);
    expect(result.nodes[0]?.lastStatusChange).toBe('2026-08-01T09:06:04.411Z');
  });

  it('is visible to both profiles and reads nothing but the panel', () => {
    expect(countryHealth.profiles).toEqual(['human', 'bot']);
    expect(countryHealth.access).toBe('ro');
  });
});
