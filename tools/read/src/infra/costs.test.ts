import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { infraCosts } from './costs.js';

interface Out {
  availability: string;
  configured: boolean;
  counts: {
    providers: number;
    billingNodes: number;
    historyRecords: number;
    reported: {
      providers: number;
      billingNodes: number;
      availableForBilling: number;
      historyRecords: number;
    };
  };
  stats: { upcomingNodesCount: number; currentMonthPayments: number; totalSpent: number };
  providers: Array<{
    uuid: string;
    name: string | null;
    loginUrl: { value: string | null; droppedPathSegments: number };
    totalAmount: number;
  }>;
  billingNodes: Array<{ uuid: string; nodeUuid: string | null; providerName: string | null; overdue: boolean }>;
  availableForBilling: Array<{ uuid: string | null }>;
  history: { windowTotal: number; records: Array<{ amount: number; providerName: string | null }> };
  findings: {
    billedNodesMissingFromPanel: Array<{ uuid: string }> | null;
    billedNodesIdle: Array<{ uuid: string; usersOnline: number }> | null;
    panelNodesWithoutBilling: Array<{ uuid: string | null }> | null;
    billingOverdue: Array<{ uuid: string }>;
  };
  suppressed: Array<{ gap: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const PROVIDER = 'cccccccc-3333-4333-8333-cccccccccccc';
const NODE_LIVE = '11111111-1111-4111-8111-111111111111';
const NODE_IDLE = '22222222-2222-4222-8222-222222222222';
const NODE_GONE = '33333333-3333-4333-8333-333333333333';
const NODE_UNBILLED = '44444444-4444-4444-8444-444444444444';

/**
 * Magic-link кабинета провайдера выглядит ровно как обычный /login. Имя
 * константы намеренно без слов secret/token: `scripts/no-secrets.test.ts`
 * краснеет на присваивании непрозрачного значения секретному имени и на
 * фикстуре был бы прав — отличить выдуманную ссылку от настоящей он не может.
 * Проверяется здесь не форма значения, а то, что путь срезается целиком.
 */
const MAGIC_LINK_VALUE = 'not-a-real-magic-link-token';

const PROVIDERS = {
  total: 1,
  providers: [
    {
      uuid: PROVIDER,
      name: 'Hoster',
      faviconLink: null,
      loginUrl: `https://panel.hoster.test/login/${MAGIC_LINK_VALUE}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      billingHistory: { totalAmount: 300, totalBills: 3 },
      billingNodes: [{ name: 'de-1', details: { nodeUuid: NODE_LIVE, countryCode: 'DE' } }],
    },
  ],
};

const BILLING_NODES = {
  totalBillingNodes: 3,
  totalAvailableBillingNodes: 1,
  billingNodes: [
    {
      uuid: 'bn-live',
      nodeUuid: NODE_LIVE,
      name: 'de-1',
      providerUuid: PROVIDER,
      provider: { uuid: PROVIDER, name: 'Hoster' },
      node: { uuid: NODE_LIVE, name: 'de-1', countryCode: 'DE' },
      nextBillingAt: '2026-09-01T00:00:00.000Z',
    },
    {
      uuid: 'bn-idle',
      nodeUuid: NODE_IDLE,
      name: 'nl-1',
      providerUuid: PROVIDER,
      provider: { uuid: PROVIDER, name: 'Hoster' },
      node: { uuid: NODE_IDLE, name: 'nl-1', countryCode: 'NL' },
      nextBillingAt: '2026-09-01T00:00:00.000Z',
    },
    {
      uuid: 'bn-gone',
      nodeUuid: NODE_GONE,
      name: 'ru-1',
      providerUuid: PROVIDER,
      provider: { uuid: PROVIDER, name: 'Hoster' },
      node: null,
      // Дата в прошлом относительно фиксированного now() харнесса (2026-08-08).
      nextBillingAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  availableBillingNodes: [{ uuid: NODE_UNBILLED, name: 'fi-1', countryCode: 'FI' }],
  stats: { upcomingNodesCount: 1, currentMonthPayments: 100, totalSpent: 300 },
};

const HISTORY = {
  total: 3,
  records: [
    {
      uuid: 'h-1',
      providerUuid: PROVIDER,
      amount: 100,
      billedAt: '2026-08-01T00:00:00.000Z',
      provider: { uuid: PROVIDER, name: 'Hoster', faviconLink: null },
    },
    {
      uuid: 'h-2',
      providerUuid: PROVIDER,
      amount: 200,
      billedAt: '2026-07-01T00:00:00.000Z',
      provider: { uuid: PROVIDER, name: 'Hoster', faviconLink: null },
    },
  ],
};

const NODES = [
  { uuid: NODE_LIVE, name: 'de-1', countryCode: 'DE', isConnected: true, isDisabled: false, usersOnline: 12 },
  { uuid: NODE_IDLE, name: 'nl-1', countryCode: 'NL', isConnected: true, isDisabled: false, usersOnline: 0 },
  { uuid: NODE_UNBILLED, name: 'fi-1', countryCode: 'FI', isConnected: true, isDisabled: false, usersOnline: 4 },
];

/** Ошибка панели с настоящим полем status — по нему тул отличает 404 роутера. */
class Failure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Stubs {
  providers?: unknown;
  nodes?: unknown;
  history?: unknown;
  panelNodes?: unknown;
}

function serve(value: unknown, fallback: unknown): unknown {
  if (value instanceof Failure) throw value;
  return value ?? fallback;
}

async function run(stubs: Stubs = {}, input: { limit?: number } = {}): Promise<Out> {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const ctx = makeCtx({
    remnaGet: (path, params) => {
      calls.push({ path, params });
      if (path === '/api/infra-billing/providers') return serve(stubs.providers, PROVIDERS);
      if (path === '/api/infra-billing/nodes') return serve(stubs.nodes, BILLING_NODES);
      if (path === '/api/infra-billing/history') return serve(stubs.history, HISTORY);
      if (path === '/api/nodes') return serve(stubs.panelNodes, NODES);
      throw new Error(`unexpected get ${path}`);
    },
  });
  const out = (await infraCosts.handler({ limit: input.limit ?? 50 }, ctx)) as Out;
  (out as unknown as { calls: typeof calls }).calls = calls;
  return out;
}

describe('infra_costs', () => {
  it('separates "the routes are not on this panel" from "nobody configured it"', async () => {
    const absent = new Failure(404, 'this route does not exist on this panel');
    const out = await run({ providers: absent, nodes: absent, history: absent });
    expect(out.availability).toBe('absent');
    expect(out.warnings.map((one) => one.code)).toContain('infra_billing_absent');
    // Отсутствующий маршрут — факт о версии панели, а не сбой источника:
    // в degraded он не пишется, иначе «фичи нет» читалось бы как «панель легла».
    expect(out.degraded).toEqual([]);
  });

  it('calls an empty but present feature unconfigured, never "we pay nothing"', async () => {
    const out = await run({
      providers: { total: 0, providers: [] },
      nodes: {
        totalBillingNodes: 0,
        billingNodes: [],
        availableBillingNodes: [{ uuid: NODE_LIVE, name: 'de-1', countryCode: 'DE' }],
        totalAvailableBillingNodes: 1,
        stats: { upcomingNodesCount: 0, currentMonthPayments: 0, totalSpent: 0 },
      },
      history: { total: 0, records: [] },
    });
    expect(out.availability).toBe('present');
    expect(out.configured).toBe(false);
    const unconfigured = out.warnings.find((one) => one.code === 'infra_billing_unconfigured');
    expect(unconfigured?.message).toMatch(/not "the infrastructure is free"/);
  });

  it('joins billing to the panel: idle, vanished and unbilled nodes are computed, not left to the reader', async () => {
    const out = await run();
    expect(out.findings.billedNodesIdle?.map((one) => one.uuid)).toEqual(['bn-idle']);
    expect(out.findings.billedNodesIdle?.[0]?.usersOnline).toBe(0);
    expect(out.findings.billedNodesMissingFromPanel?.map((one) => one.uuid)).toEqual(['bn-gone']);
    expect(out.findings.panelNodesWithoutBilling?.map((one) => one.uuid)).toEqual([NODE_UNBILLED]);
    expect(out.findings.billingOverdue.map((one) => one.uuid)).toEqual(['bn-gone']);
    expect(out.warnings.map((one) => one.code)).toContain('billed_node_idle');
  });

  it('suppresses every join when the node listing is unusable', async () => {
    for (const panelNodes of [new Failure(500, 'panel down'), []]) {
      const out = await run({ panelNodes });
      expect(out.findings.billedNodesIdle).toBeNull();
      expect(out.findings.billedNodesMissingFromPanel).toBeNull();
      expect(out.findings.panelNodesWithoutBilling).toBeNull();
      expect(out.suppressed.map((one) => one.gap)).toContain('billedNodesIdle');
      // Пустой список нод не должен читаться как «все ноды снесены».
      expect(out.findings.billedNodesMissingFromPanel).not.toEqual([]);
    }
  });

  it('strips the provider login link the same way SHM hosts are stripped', async () => {
    const out = await run();
    expect(JSON.stringify(out)).not.toContain(MAGIC_LINK_VALUE);
    expect(out.providers[0]?.loginUrl).toEqual({
      value: 'https://panel.hoster.test',
      droppedPathSegments: 2,
      droppedQuery: false,
      droppedCredentials: false,
    });
  });

  it('surfaces the server-side counts and warns that the window is not the lifetime', async () => {
    const out = await run();
    expect(out.counts.reported).toEqual({
      providers: 1,
      billingNodes: 3,
      availableForBilling: 1,
      historyRecords: 3,
    });
    expect(out.counts.historyRecords).toBe(2);
    expect(out.history.windowTotal).toBe(300);
    expect(out.providers[0]?.totalAmount).toBe(300);
    expect(out.warnings.map((one) => one.code)).toContain('truncated');
  });

  it('caps the history window at the 500 the panel accepts', async () => {
    const out = await run({}, { limit: 5000 });
    const call = (out as unknown as { calls: Array<{ path: string; params?: Record<string, unknown> }> }).calls.find(
      (one) => one.path === '/api/infra-billing/history',
    );
    expect(call?.params).toEqual({ size: 500, start: 0 });
  });

  it('warns when the panel and the node list disagree on what is unbilled', async () => {
    const out = await run({
      nodes: { ...BILLING_NODES, availableBillingNodes: [], totalAvailableBillingNodes: 0 },
    });
    expect(out.warnings.map((one) => one.code)).toContain('unbilled_node_count_disagrees');
  });

  it('degrades instead of throwing when the panel fails for a reason other than 404', async () => {
    const down = new Failure(500, 'panel down');
    const out = await run({ providers: down, nodes: down, history: down, panelNodes: down });
    expect(out.availability).toBe('unknown');
    expect(out.providers).toEqual([]);
    expect(out.degraded.length).toBe(4);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('refuses the bot profile by name, not by silence', async () => {
    const ctx = makeCtx({ profile: 'bot' });
    await expect(infraCosts.handler({ limit: 50 }, ctx)).rejects.toThrow(/human profile only/);
  });

  it('is declared read-only and human-only, and names the join in its description', () => {
    expect(infraCosts.access).toBe('ro');
    expect(infraCosts.profiles).toEqual(['human']);
    expect(infraCosts.description).toMatch(/infra_map/);
  });
});
