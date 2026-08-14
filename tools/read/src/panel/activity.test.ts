import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { panelActivity } from './activity.js';

interface Answer {
  recap: { version: string | null } | null;
  digest: { days: number; users: Record<string, unknown> } | null;
  http: { declared_total: number | null; routes: { route: string | null }[] } | null;
  requests: {
    hourlyWindowHours: number | null;
    window: { items: number | null; returned: number; data: { ip: string | null }[] } | null;
  };
  warnings: { code: string; message: string }[];
}

type Handler = typeof panelActivity.handler;
type Input = Parameters<Handler>[0];

async function run(input: unknown, ctx: Parameters<Handler>[1]): Promise<Answer> {
  return (await panelActivity.handler(panelActivity.input.parse(input) as Input, ctx)) as Answer;
}

const RECAP = {
  thisMonth: { users: 122, traffic: '41744370303683' },
  total: { users: 1125, nodes: 6, traffic: '545021749488123', distinctCountries: 6 },
  version: '3.2.3',
  initDate: '2025-05-20T18:25:01.256Z',
};

const DIGEST = {
  users: { createdCount: 78, expiredCount: 188 },
  traffic: { totalBytes: '23738829710434', byUsersCreatedInRangeBytes: '288132015129' },
  hwidDevices: { createdCount: 177 },
};

const HTTP = {
  total: 20000,
  routes: [
    { method: 'GET', route: '/api/hwid/devices/:userId', count: 4568 },
    { method: 'GET', route: '/api/sub/:shortUuid', count: 4115 },
    { method: 'GET', route: '/api/keygen', count: 128 },
  ],
};

const HISTORY_STATS = {
  byParsedApp: [
    { app: 'Happ', count: 13966 },
    { app: 'INCY', count: 3457 },
  ],
  hourlyRequestStats: [
    { dateTime: '2026-08-11T08:00:00.000Z', requestCount: 75 },
    { dateTime: '2026-08-11T09:00:00.000Z', requestCount: 120 },
  ],
};

const HISTORY = {
  total: 18210,
  records: [
    {
      id: 603786,
      userId: 6659,
      requestAt: '2026-08-13T08:21:04.341Z',
      requestIp: '203.0.113.72',
      userAgent: 'Happ/2.7.0/Windows',
      srrRuleName: 'Fallback Base64',
      srrResponseType: 'XRAY_BASE64',
    },
    {
      id: 603785,
      userId: 16075,
      requestAt: '2026-08-13T08:21:04.184Z',
      requestIp: '203.0.113.72',
      userAgent: 'Happ/4.1.0/Android',
      srrRuleName: 'Fallback Base64',
      srrResponseType: 'XRAY_BASE64',
    },
  ],
};

function ctxWith(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; params: unknown }[] = [];
  const ctx = makeCtx({
    remnaGet: (path, params) => {
      calls.push({ path, params });
      if (path === '/api/system/stats/recap') return overrides.recap ?? RECAP;
      if (path === '/api/system/stats/digest') return overrides.digest ?? DIGEST;
      if (path === '/api/system/stats/http') return overrides.http ?? HTTP;
      if (path === '/api/subscription-request-history') return overrides.history ?? HISTORY;
      if (path === '/api/subscription-request-history/stats') {
        return overrides.historyStats ?? HISTORY_STATS;
      }
      throw new Error(`unexpected path ${path}`);
    },
  });
  return { ctx, calls };
}

describe('panel_activity', () => {
  /**
   * Ручка digest отвечает 400 без `start`/`end` — проверено на работающей
   * панели, а не взято из спецификации. Окно обязано уезжать всегда, иначе
   * секция молча уходит в degraded.
   */
  it('always sends the digest window the panel refuses to work without', async () => {
    const { ctx, calls } = ctxWith();
    const result = await run({ days: 7 }, ctx);
    const digestCall = calls.find((one) => one.path === '/api/system/stats/digest');
    const params = digestCall?.params as { start?: string; end?: string } | undefined;
    expect(params?.start).toBe('2026-08-01T12:00:00.000Z');
    expect(params?.end).toBe('2026-08-08T12:00:00.000Z');
    expect(result.digest?.days).toBe(7);
    expect(result.digest?.users).toEqual({ createdCount: 78, expiredCount: 188 });
  });

  /**
   * Три числа про «активность», посчитанные за три разных отрезка. Ответ обязан
   * подписать каждый своим отрезком, а не дать сложить их.
   */
  it('labels every window and refuses to let them be compared', async () => {
    const { ctx } = ctxWith();
    const result = await run({}, ctx);
    expect(result.requests.hourlyWindowHours).toBe(2);
    const codes = result.warnings.map((one) => one.code);
    expect(codes).toContain('stats_windows_differ');
    expect(codes).toContain('http_stats_period_unstated');
  });

  it('sorts HTTP routes busiest first and declares the server-side total', async () => {
    const { ctx } = ctxWith();
    const result = await run({}, ctx);
    expect(result.http?.declared_total).toBe(20000);
    expect(result.http?.routes[0]?.route).toBe('/api/hwid/devices/:userId');
  });

  it('reports when every request in the window fell through to one rule', async () => {
    const { ctx } = ctxWith();
    const result = await run({}, ctx);
    const warning = result.warnings.find((one) => one.code === 'srr_single_rule_matched');
    expect(warning?.message).toContain('Fallback Base64');
    expect(warning?.message).toMatch(/matching nobody/);
  });

  it('stays quiet about rules when more than one matched', async () => {
    const { ctx } = ctxWith({
      history: {
        total: 2,
        records: [
          { ...HISTORY.records[0], srrRuleName: 'Fallback Base64' },
          { ...HISTORY.records[1], srrRuleName: 'Happ Native' },
        ],
      },
    });
    const result = await run({}, ctx);
    expect(result.warnings.map((one) => one.code)).not.toContain('srr_single_rule_matched');
  });

  it('names the address field so profile redaction can see it', async () => {
    const { ctx } = ctxWith();
    const result = await run({}, ctx);
    expect(result.requests.window?.data[0]?.ip).toBe('203.0.113.72');
    expect(JSON.stringify(result)).not.toContain('requestIp');
  });

  it('warns that the request window is a slice of the server-side count', async () => {
    const { ctx } = ctxWith();
    const result = await run({ limit: 2 }, ctx);
    expect(result.requests.window?.items).toBe(18210);
    expect(result.warnings.map((one) => one.code)).toContain('truncated');
  });

  it('reports a failed section as unknown rather than as an idle panel', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/subscription-request-history') throw new Error('panel down');
        if (path === '/api/system/stats/recap') return RECAP;
        if (path === '/api/system/stats/digest') return DIGEST;
        if (path === '/api/system/stats/http') return HTTP;
        if (path === '/api/subscription-request-history/stats') return HISTORY_STATS;
        throw new Error(`unexpected path ${path}`);
      },
    });
    const result = await run({}, ctx);
    expect(result.requests.window?.items).toBeNull();
    expect(result.requests.window?.returned).toBe(0);
    const codes = result.warnings.map((one) => one.code);
    expect(codes).toContain('partial_result');
    expect(codes).not.toContain('srr_single_rule_matched');
  });

  it('refuses the bot profile: fleet-wide addresses and the panel operator picture', async () => {
    const ctx = makeCtx({ profile: 'bot', remnaGet: () => RECAP });
    await expect(run({}, ctx)).rejects.toThrow(/human profile only/);
  });
});
