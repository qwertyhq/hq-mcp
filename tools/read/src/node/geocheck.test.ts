import { describe, expect, it } from 'vitest';
import { Budget } from '@hq/budget';
import { executeTool } from '@hq/exec';
import { Registry } from '@hq/registry';
import { createRemnaClient } from '@hq/remna';
import type { ToolContext } from '@hq/types';
import { makeCtx } from '../testkit.js';
import type { StubCall } from '../testkit.js';
import { nodeGeocheck } from './geocheck.js';

const NODE_UUID = '6410d334-fb9c-4eb3-83c2-80385ffe5c7d';
const JOB_ID = '12345';

interface Answer {
  status: 'pending' | 'completed' | 'failed' | 'unavailable';
  job_id: string | null;
  node_uuid: string | null;
  isCompleted: boolean | null;
  isFailed: boolean | null;
  success: boolean | null;
  report: Record<string, unknown> | null;
  next_call: { action: 'result'; job_id: string } | null;
  warnings: { code: string; message: string }[];
  degraded: { system: string; error: string }[];
}

function registry(): Registry {
  const result = new Registry();
  result.register(nodeGeocheck);
  return result;
}

async function run(input: unknown, ctx: ToolContext): Promise<Answer> {
  const result = await executeTool('node_geocheck', input, { registry: registry(), ctx });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.value as Answer;
}

function completed(rawReport: unknown, success = true, message: string | null = null) {
  return {
    isCompleted: true,
    isFailed: false,
    result: { success, nodeUuid: NODE_UUID, image: null, rawReport, message },
  };
}

// Field names follow remnawave/geocheck internal/render/json.go at
// 581444c009cbb90f07a8a383fdb92f101eabafeb; values use documentation addresses.
const REPORT = {
  schema: 1,
  tool: '0.3.0',
  timestamp: '2026-09-05T12:00:00Z',
  duration_ms: 1800,
  identity: { ipv4: '198.51.100.34', asn: 64496, as_name: 'Example ASN', as_country: 'NL' },
  transport: { interface: 'eth0', proxy: 'socks5://operator:private-pass@localhost:1080' },
  findings: [{ id: 'detour', title: 'Path detour', severity: 'warn', detail: 'private detail' }],
  consensus: { ipv4: [{ code: 'NL', country: 'Netherlands', count: 4, total: 5, percent: 80 }] },
  connectivity: {
    icmp_available: true, privileged: true, score: 90, latency_floor_ms: 4,
    breakdown: { direct: 1, peered: 0, transit: 0, detour: 1, intercepted: 0, failed: 0 },
    targets: [{
      id: 'example', name: 'Example target', host: 'example.test', method: 'icmp',
      anycast: false, verdict: 'detour', score: 60, rtt_ms: 45, excess_ms: 40,
      jitter_ms: 2, loss: 0, hops: [{ addr: '192.0.2.1', addrs: ['192.0.2.2'] }],
      notes: ['private note'],
    }],
  },
  connectivity_checks: {
    clean: false, plain_http_blocked: false, ok: 1, captive_portal: 0, altered: 1,
    unreachable: 0, endpoints: [{ body: 'private response body' }],
  },
};

describe('node_geocheck lifecycle', () => {
  it.each([{}, { ip: '198.51.100.34' }, { ip: '2001:db8::34' }, { interface: 'eth0' }])(
    'starts exactly one diagnostic job and returns a resumable ID: %j',
    async (selector) => {
      const calls: StubCall[] = [];
      const answer = await run({ action: 'start', node_uuid: NODE_UUID, ...selector }, makeCtx({
        calls, backends: { shm: false, remna: true },
        remnaSend: () => ({ jobId: JOB_ID }),
      }));
      expect(calls).toEqual([{
        system: 'remna', method: 'POST', path: `/api/connections/geocheck/${NODE_UUID}`,
        params: undefined, body: selector,
      }]);
      expect(answer).toMatchObject({
        status: 'pending', job_id: JOB_ID, node_uuid: NODE_UUID,
        isCompleted: null, isFailed: null, success: null, report: null,
        next_call: { action: 'result', job_id: JOB_ID }, degraded: [],
      });
    },
  );

  it('reads pending once without calling it a success, a failure, or an empty report', async () => {
    const calls: StubCall[] = [];
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      calls, remnaGet: () => ({ isCompleted: false, isFailed: false, result: null }),
    }));
    expect(calls).toEqual([{
      system: 'remna', method: 'GET', path: `/api/connections/geocheck/${JOB_ID}`,
      params: undefined, body: undefined,
    }]);
    expect(answer).toMatchObject({
      status: 'pending', isCompleted: false, isFailed: false, success: null, report: null,
      next_call: { action: 'result', job_id: JOB_ID }, degraded: [],
    });
  });

  it('returns useful allowlisted diagnostic facts when the node check succeeds', async () => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => completed(REPORT),
    }));
    expect(answer).toMatchObject({
      status: 'completed', node_uuid: NODE_UUID, isCompleted: true, isFailed: false,
      success: true, next_call: null, degraded: [],
      report: {
        schema: 1, tool: '0.3.0', duration_ms: 1800,
        identity: { ipv4: '198.51.100.34', asn: 64496, as_country: 'NL' },
        consensus: { ipv4: { total: 1, returned: 1, items: [{ code: 'NL', percent: 80 }] } },
        findings: { total: 1, returned: 1, items: [{ id: 'detour', severity: 'warn' }] },
        connectivity: {
          score: 90, breakdown: { direct: 1, detour: 1, failed: 0 },
          targets: { total: 1, returned: 1, items: [{ id: 'example', verdict: 'detour', rtt_ms: 45 }] },
        },
        connectivity_checks: { clean: false, altered: 1 },
      },
    });
    const text = JSON.stringify(answer);
    expect(answer.report).not.toHaveProperty('transport');
    for (const hidden of ['private-pass', 'private detail', 'private note', 'private response body', '192.0.2.1', '192.0.2.2', '"hops"']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('distinguishes a failed queue job from a completed but unsuccessful node check', async () => {
    const queueFailure = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => ({ isCompleted: false, isFailed: true, result: null }),
    }));
    expect(queueFailure).toMatchObject({
      status: 'failed', isCompleted: false, isFailed: true, success: null,
      report: null, next_call: null,
    });
    const nodeFailure = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => completed(null, false, 'Node not found.'),
    }));
    expect(nodeFailure).toMatchObject({
      status: 'failed', isCompleted: true, isFailed: false, success: false,
      node_uuid: NODE_UUID, report: null, next_call: null,
    });
    expect(JSON.stringify(nodeFailure.warnings)).toContain('Node not found.');
  });

  it.each([
    null, {}, { isCompleted: true, isFailed: false, result: null },
    { isCompleted: true, isFailed: true, result: null },
    { isCompleted: false, isFailed: false, result: completed(REPORT).result },
    { isCompleted: true, isFailed: false, result: { success: 'true', nodeUuid: NODE_UUID } },
  ])('does not turn malformed lifecycle evidence into a completed check: %j', async (reply) => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({ remnaGet: () => reply }));
    expect(answer.status).toBe('unavailable');
    expect(answer.success).toBeNull();
    expect(answer.report).toBeNull();
    expect(answer.degraded).not.toEqual([]);
  });

  it.each([{}, { jobId: '' }, { jobId: '../nodes' }, { jobId: 'x'.repeat(129) }])(
    'does not return an unsafe or absent job ID from a start response: %j', async (reply) => {
      const answer = await run({ action: 'start', node_uuid: NODE_UUID }, makeCtx({ remnaSend: () => reply }));
      expect(answer.status).toBe('unavailable');
      expect(answer.job_id).toBeNull();
      expect(answer.next_call).toBeNull();
    },
  );
});

describe('node_geocheck boundaries', () => {
  it.each([
    {}, { action: 'start' }, { action: 'result' }, { action: 'poll', job_id: JOB_ID },
    { action: 'start', node_uuid: NODE_UUID, job_id: JOB_ID },
    { action: 'start', node_uuid: NODE_UUID, ip: '198.51.100.34', interface: 'eth0' },
    { action: 'start', node_uuid: '../nodes' },
    { action: 'start', node_uuid: NODE_UUID, ip: 'https://example.test' },
    { action: 'start', node_uuid: NODE_UUID, ip: '' },
    { action: 'start', node_uuid: NODE_UUID, interface: '' },
    { action: 'start', node_uuid: NODE_UUID, interface: 'eth0; reboot' },
    { action: 'result', job_id: JOB_ID, node_uuid: NODE_UUID },
    { action: 'result', job_id: JOB_ID, ip: '198.51.100.34' },
    { action: 'result', job_id: JOB_ID, interface: 'eth0' },
    { action: 'result', job_id: JOB_ID, poll: true },
    ...['', '../nodes', '..', '%2e%2e', 'a/b', 'x?drop=1', 'x#z', 'x\\y', 'x'.repeat(129)]
      .map((job_id) => ({ action: 'result', job_id })),
  ])('rejects ambiguous, invalid, and path-unsafe inputs before HTTP: %j', async (input) => {
    const calls: StubCall[] = [];
    const result = await executeTool('node_geocheck', input, { registry: registry(), ctx: makeCtx({ calls }) });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it('refuses the bot both through the executor and through direct handler access', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, profile: 'bot' });
    const input = { action: 'start', node_uuid: NODE_UUID };
    expect(await executeTool('node_geocheck', input, { registry: registry(), ctx }))
      .toMatchObject({ ok: false, code: 'not_found' });
    await expect(nodeGeocheck.handler(nodeGeocheck.input.parse(input), ctx)).rejects.toThrow(/human/i);
    expect(calls).toEqual([]);
  });

  it('is unavailable without Remna and works in a Remna-only read-only deployment', async () => {
    const calls: StubCall[] = [];
    const absent = await executeTool('node_geocheck', { action: 'result', job_id: JOB_ID }, {
      registry: registry(), ctx: makeCtx({ calls, backends: { shm: true, remna: false } }),
    });
    expect(absent).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls).toEqual([]);
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      mode: 'ro', backends: { shm: false, remna: true },
      remnaGet: () => ({ isCompleted: false, isFailed: false, result: null }),
    }));
    expect(answer.status).toBe('pending');
  });

  it.each([401, 403, 404, 429, 500])('reports HTTP %i as unavailable without echoing its body', async (status) => {
    for (const action of ['start', 'result'] as const) {
      const ctx = makeCtx();
      const calls: string[] = [];
      ctx.remna = createRemnaClient({ baseUrl: 'https://panel.example.test', token: 'jwt-token' }, {
        budget: new Budget({ limit: 100, windowMs: 60_000 }), profile: 'human',
        fetchImpl: (async (url: unknown) => {
          calls.push(String(url));
          return new Response(JSON.stringify({ message: 'private backend response', statusCode: status }), { status });
        }) as typeof fetch,
      });
      const input = action === 'start' ? { action, node_uuid: NODE_UUID } : { action, job_id: JOB_ID };
      const answer = await run(input, ctx);
      expect(answer).toMatchObject({ status: 'unavailable', success: null, report: null, next_call: null });
      expect(answer.degraded).not.toEqual([]);
      expect(JSON.stringify(answer)).not.toContain('private backend response');
      expect(JSON.stringify(answer.warnings)).toContain(String(status));
      expect(calls).toHaveLength(1);
    }
  });

  it('scrubs permitted text through the real client and executor without exposing raw reports or SVG', async () => {
    const ctx = makeCtx();
    const raw = completed({ ...REPORT, seed: 'short-private-seed', shortIds: ['a1b2c3d4e5f60789'],
      findings: [{ id: 'detour', title: 'API_TOKEN=example-private-value-1234', severity: 'warn' }],
    });
    const imageData = Buffer.from('<svg>private raw drawing</svg>').toString('base64');
    const response = { ...raw, result: { ...raw.result,
      image: { format: 'svg', media_type: 'image/svg+xml', encoding: 'base64', data: imageData },
    } };
    ctx.remna = createRemnaClient({ baseUrl: 'https://panel.example.test', token: 'jwt-token' }, {
      budget: new Budget({ limit: 100, windowMs: 60_000 }), profile: 'human',
      fetchImpl: (async () => new Response(JSON.stringify({ response }))) as typeof fetch,
    });
    const answer = await run({ action: 'result', job_id: JOB_ID }, ctx);
    expect(answer.status).toBe('completed');
    expect(answer.report).toMatchObject({ connectivity: { score: 90 }, identity: { asn: 64496 } });
    const text = JSON.stringify(answer);
    for (const forbidden of ['example-private-value-1234', 'short-private-seed', 'a1b2c3d4e5f60789', 'rawReport', imageData, '<svg>']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('does not expose arbitrary node failure messages', async () => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => completed(null, false, 'private backend body <svg>private drawing</svg>'),
    }));
    expect(answer.status).toBe('failed');
    expect(JSON.stringify(answer)).not.toContain('private backend body');
    expect(JSON.stringify(answer)).not.toContain('<svg>');
  });

  it('marks a malformed consensus section as unreadable instead of silently empty', async () => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => completed({ ...REPORT, consensus: 'private malformed report data' }),
    }));
    expect(answer).toMatchObject({ status: 'completed', success: true, report: { connectivity: { score: 90 } } });
    expect(answer.report?.consensus).toBeNull();
    expect(answer.warnings.map((one) => one.code)).toContain('geocheck_report_invalid_fields');
    expect(JSON.stringify(answer)).not.toContain('private malformed report data');
  });

  it('bounds report lists and strings and explicitly marks truncation', async () => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({
      remnaGet: () => completed({ ...REPORT,
        findings: Array.from({ length: 70 }, (_, n) => ({
          id: `finding-${n}`, title: 'many words '.repeat(100), severity: 'warn',
        })),
      }),
    }));
    const findings = answer.report?.findings as { total: number; returned: number; items: unknown[] };
    expect(findings.total).toBe(70);
    expect(findings.returned).toBeLessThanOrEqual(20);
    expect(findings.items).toHaveLength(findings.returned);
    expect(JSON.stringify(answer).length).toBeLessThan(15_000);
    expect(answer.warnings.some((w) => /truncat/i.test(w.code))).toBe(true);
  });

  it.each([null, {}, { ...REPORT, schema: 2 }])('keeps unrecognized reports separate from successful job execution: %j', async (report) => {
    const answer = await run({ action: 'result', job_id: JOB_ID }, makeCtx({ remnaGet: () => completed(report) }));
    expect(answer).toMatchObject({ status: 'completed', success: true, report: null });
    expect(answer.warnings.some((w) => /report/.test(w.code))).toBe(true);
  });
});
