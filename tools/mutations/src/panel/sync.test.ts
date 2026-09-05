import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemnaError } from '@hq/remna';
import type { MutationPlan } from '@hq/confirm';
import { panelSync } from './sync.js';
import { callHandler, callTool, makeWorld, planThenApply } from '../testkit.js';
import type { FakeOpts, FakeRoutes, FakeWorld } from '../testkit.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const N1 = 'dddddddd-1111-4111-8111-111111111111';
const N2 = 'dddddddd-2222-4222-8222-222222222222';
const nodeId = (n: number): string => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PLUGINS = '/api/node-plugins';
const LISTS = `${PLUGINS}/shared-lists`;
const SENTINEL = 'sensitive-seed-do-not-expose';
const IP = '203.0.113.77';

function plugin(uuid: string, name: string, pluginConfig: unknown): Record<string, unknown> {
  return { uuid, name, viewPosition: 0, pluginConfig };
}

function node(uuid: string, activePluginUuid: string | null, extra = {}): Record<string, unknown> {
  return { uuid, name: `Node-${uuid.slice(0, 8)}`, activePluginUuid,
    isDisabled: false, isConnected: true, isConnecting: false, ...extra };
}

function data(): Map<string, unknown> {
  return new Map<string, unknown>([
    [PLUGINS, { total: 3, nodePlugins: [plugin(A, 'Main', null), plugin(B, 'Filter', null), plugin(C, 'Unused', null)] }],
    [`${PLUGINS}/${A}`, plugin(A, 'Main', {
      torrentBlocker: { enabled: true, ignoreLists: { ip: ['ext:trusted', 'ext:auxiliary'] }, webhookUrl: SENTINEL },
    })],
    [`${PLUGINS}/${B}`, plugin(B, 'Filter', { ingressFilter: { enabled: false, blockedIps: ['ext:trusted'] } })],
    // A substring is not a JSON value equal to ext:trusted; neither is an object key.
    [`${PLUGINS}/${C}`, plugin(C, 'Unused', { note: 'prefix ext:trusted', 'ext:trusted': false })],
    [LISTS, { total: 2, sharedLists: [
      { name: 'trusted', type: 'ipList', itemsCount: 1 },
      { name: 'auxiliary', type: 'asList', itemsCount: 1 },
    ] }],
    [`${LISTS}/trusted`, { name: 'trusted', config: { type: 'ipList', items: [IP] } }],
    [`${LISTS}/auxiliary`, { name: 'auxiliary', config: { type: 'asList', items: [64512] } }],
    ['/api/nodes', [node(N1, A), node(N2, B),
      node(nodeId(1), A, { isDisabled: true }),
      node(nodeId(2), A, { isConnected: false }),
      node(nodeId(3), A, { isConnecting: true }), node(nodeId(4), C)]],
  ]);
}

const worlds: FakeWorld[] = [];
function world(rows = data(), opts: FakeOpts = {}, send: FakeRoutes['remnaSend'] = () => undefined): FakeWorld {
  const read = (path: string): unknown => {
    if (!rows.has(path)) throw new RemnaError(`missing source ${SENTINEL}`, 404);
    const value = rows.get(path);
    if (value instanceof Error) throw value;
    return { response: structuredClone(value) };
  };
  const w = makeWorld({ remnaGet: read, remnaGetRaw: read, remnaSend: send }, opts);
  worlds.push(w);
  return w;
}
afterEach(async () => { await Promise.all(worlds.splice(0).map((w) => rm(w.dir, { recursive: true, force: true }))); });

interface Plan {
  plan_id: string;
  before: {
    affectedNodeCount: number;
    affectedNodes: Array<{ uuid: string }>;
    attachedNodeCount: number;
    excludedNodeCount: number;
    plugins: Array<{ uuid: string; sharedLists: string[] }>;
    sharedLists: Array<{ name: string; itemsCount: number }>;
  };
  sideEffects: string[];
  rollback?: unknown;
}

describe('panel_sync — reviewed impact and confirmation', () => {
  it('plans the exact connected/enabled/non-connecting membership without sending', async () => {
    const w = world();
    const plan = await callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w) as Plan;
    expect(plan.before.affectedNodes.map((one) => one.uuid)).toEqual([N1]);
    expect(plan.before).toMatchObject({ affectedNodeCount: 1, attachedNodeCount: 4, excludedNodeCount: 3 });
    expect(plan.before.plugins).toMatchObject([{ uuid: A, sharedLists: ['auxiliary', 'trusted'] }]);
    expect(plan.before.sharedLists).toMatchObject([{ name: 'auxiliary', itemsCount: 1 }, { name: 'trusted', itemsCount: 1 }]);
    expect(w.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(plan.rollback).toBeUndefined();
    expect(plan.sideEffects.join(' ')).toMatch(/не отменяет|не откатывает/i);
  });

  it('shared-list sync finds exact recursive references, including disabled plugin sections', async () => {
    const w = world();
    const plan = await callTool(panelSync(w.deps), { target: 'shared_list', name: 'trusted' }, w) as Plan;
    expect(plan.before.affectedNodes.map((one) => one.uuid)).toEqual([N1, N2]);
    expect(plan.before.plugins.map((one) => one.uuid)).toEqual([A, B]);
    expect(plan.before.sharedLists.map((one) => one.name)).toEqual(['auxiliary', 'trusted']);
    expect(w.calls.filter((call) => call.raw).map((call) => call.path)).toEqual(expect.arrayContaining([
      `${PLUGINS}/${A}`, `${PLUGINS}/${B}`, `${PLUGINS}/${C}`, `${LISTS}/trusted`, `${LISTS}/auxiliary`,
    ]));
  });

  it.each([
    [{ target: 'plugin', uuid: A }, `${PLUGINS}/actions/sync`, { uuid: A }],
    [{ target: 'shared_list', name: 'trusted' }, `${LISTS}/actions/sync`, { name: 'trusted' }],
  ])('sends only the confirmed %j endpoint/body and reports queued acceptance', async (args, path, body) => {
    const w = world();
    const response = await planThenApply(panelSync(w.deps), args, w);
    expect(w.calls.filter((call) => call.method !== 'GET')).toEqual([
      { system: 'remna', method: 'POST', path, body },
    ]);
    expect(response).toMatchObject({ status: 'applied', result: { status: 'queued', accepted: true, completed: false } });
    expect(response).not.toHaveProperty('rollback');
    const audit = (await readFile(w.auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((entry) => entry.outcome)).toEqual(['planned', 'applying', 'applied']);
    expect(audit[2]?.result).toMatchObject({ status: 'queued', completed: false });
  });

  it('refuses a changed target and a reused confirmation before another POST', async () => {
    const w = world();
    const tool = panelSync(w.deps);
    const plan = await callTool(tool, { target: 'plugin', uuid: A }, w) as Plan;
    await expect(callTool(tool, { target: 'plugin', uuid: B, plan_id: plan.plan_id }, w)).rejects.toThrow();
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
    await callTool(tool, { target: 'plugin', uuid: A, plan_id: plan.plan_id }, w);
    await expect(callTool(tool, { target: 'plugin', uuid: A, plan_id: plan.plan_id }, w)).rejects.toThrow();
    expect(w.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it.each([
    {}, { target: 'plugin' }, { target: 'shared_list' },
    { target: 'plugin', uuid: A, name: 'trusted' }, { target: 'shared_list', name: 'trusted', uuid: A },
    { target: 'shared_list', name: 'ext:trusted' }, { target: 'shared_list', name: '../nodes' },
    { target: 'plugin', uuid: A, config: {} },
  ])('refuses an ambiguous or unsupported input %j before reading sources', async (args) => {
    const w = world();
    await expect(callTool(panelSync(w.deps), args, w)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });

  it.each([{ profile: 'bot' as const }, { mode: 'ro' as const }])('is unavailable under %j', async (opts) => {
    const w = world(data(), opts);
    await expect(callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow();
    await expect(callHandler(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
});

describe('panel_sync — stale or incomplete sources fail closed', () => {
  const changes: Array<[string, (rows: Map<string, unknown>) => void]> = [
    ['private plugin setting', (rows) => { rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { privateKey: 'new-key', seed: SENTINEL })); }],
    ['same-size shared-list content', (rows) => { rows.set(`${LISTS}/trusted`, { name: 'trusted', config: { type: 'ipList', items: ['198.51.100.88'] } }); }],
    ['node assignment', (rows) => { rows.set('/api/nodes', [node(N1, B), node(N2, A)]); }],
    ['new affected node', (rows) => { (rows.get('/api/nodes') as unknown[]).push(node(nodeId(9), A)); }],
    ['previously connecting node becomes eligible', (rows) => { (rows.get('/api/nodes') as Array<Record<string, unknown>>)[4]!.isConnecting = false; }],
    ['plugin catalog gains an entry', (rows) => {
      const catalog = rows.get(PLUGINS) as { total: number; nodePlugins: unknown[] };
      catalog.total += 1;
      catalog.nodePlugins.push(plugin(nodeId(9), 'New', null));
      rows.set(`${PLUGINS}/${nodeId(9)}`, plugin(nodeId(9), 'New', {}));
    }],
    ['dependent plugin gains reference', (rows) => { rows.set(`${PLUGINS}/${C}`, plugin(C, 'Unused', { nested: ['ext:trusted'] })); }],
    ['dependent plugin loses reference', (rows) => { rows.set(`${PLUGINS}/${B}`, plugin(B, 'Filter', {})); }],
    ['source disappears', (rows) => { rows.delete('/api/nodes'); }],
  ];
  it.each(changes)('refuses confirmation after %s', async (_label, change) => {
    const rows = data();
    const w = world(rows);
    const tool = panelSync(w.deps);
    const args = { target: 'shared_list', name: 'trusted' };
    const plan = await callTool(tool, args, w) as Plan;
    change(rows);
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/изменилось|источник|неполный/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it.each([PLUGINS, LISTS, '/api/nodes', `${PLUGINS}/${C}`, `${LISTS}/auxiliary`])('refuses a missing source %s', async (path) => {
    const rows = data();
    rows.delete(path);
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'shared_list', name: 'trusted' }, w)).rejects.toThrow(/источник/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(await readFile(w.auditPath, 'utf8')).not.toContain(SENTINEL);
  });

  it.each([
    [PLUGINS, { total: 4, nodePlugins: [plugin(A, 'Main', null)] }],
    [PLUGINS, { nodePlugins: [] }], [PLUGINS, { total: 2, nodePlugins: [plugin(A, 'Main', null), plugin(A, 'Main', null)] }],
    [LISTS, { total: 9, sharedLists: [] }], [LISTS, { total: 0, sharedLists: [] }],
    ['/api/nodes', { total: 2, nodes: [node(N1, A)] }], ['/api/nodes', null],
    ['/api/nodes', [node(N1, A, { isConnected: undefined })]],
    [`${PLUGINS}/${B}`, { uuid: B, name: 'Filter' }],
    [`${PLUGINS}/${B}`, plugin(A, 'Wrong identity', {})],
    [`${LISTS}/trusted`, { name: 'trusted', config: null }],
    [`${LISTS}/trusted`, { name: 'trusted', config: { type: 'ipList', items: [IP, IP] } }],
  ])('refuses malformed/partial/inconsistent source at %s', async (path, value) => {
    const rows = data();
    rows.set(path, value);
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'shared_list', name: 'trusted' }, w)).rejects.toThrow();
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps raw configs, IPs and backend error bodies out of plans, snapshots, results and audit', async () => {
    const w = world();
    const tool = panelSync(w.deps);
    const args = { target: 'shared_list', name: 'trusted' };
    const plan = await callTool(tool, args, w) as Plan;
    const files = await readdir(w.snapshotDir);
    const snapshots = await Promise.all(files.map((file) => readFile(join(w.snapshotDir, file), 'utf8')));
    const response = await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    const all = JSON.stringify([plan, response, snapshots, await readFile(w.auditPath, 'utf8')]);
    for (const value of [SENTINEL, IP, 'webhookUrl', 'pluginConfig']) expect(all).not.toContain(value);
  });

  it('hashes masked values before redaction, so a secret-only change is stale', async () => {
    const rows = data();
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { privateKey: 'first-key' }));
    const w = world(rows);
    const tool = panelSync(w.deps);
    const plan = await callTool(tool, { target: 'plugin', uuid: A }, w) as Plan;
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { privateKey: 'second-key' }));
    await expect(callTool(tool, { target: 'plugin', uuid: A, plan_id: plan.plan_id }, w)).rejects.toThrow(/изменилось/);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('a verified empty fleet is zero impact, with acceptance still not completion', async () => {
    const rows = data();
    rows.set('/api/nodes', []);
    const w = world(rows);
    const response = await planThenApply(panelSync(w.deps), { target: 'plugin', uuid: A }, w);
    expect(response).toMatchObject({ result: { expectedAffectedNodeCount: 0, completed: false } });
  });

  it('does not require optional shared-list routes for a plugin with no external references', async () => {
    const rows = data();
    rows.delete(LISTS);
    const w = world(rows);
    const response = await planThenApply(panelSync(w.deps), { target: 'plugin', uuid: C }, w);
    expect(response).toMatchObject({ result: { expectedAffectedNodeCount: 1, status: 'queued' } });
    expect(w.calls.every((call) => !call.path.startsWith(LISTS))).toBe(true);
  });

  it.each([0, 403, 404, 429, 500])('does not leak or retry a send failure with status %i', async (status) => {
    const w = world(data(), {}, () => { throw new RemnaError(`upstream config ${SENTINEL} ${IP}`, status); });
    await expect(planThenApply(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow(/не подтверждён/);
    expect(w.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const audit = await readFile(w.auditPath, 'utf8');
    expect(audit).not.toContain(SENTINEL);
    expect(audit).not.toContain(IP);
    expect(audit).not.toContain('"outcome":"applied"');
  });

  it('canonical object ordering and catalog order do not invalidate an unchanged plan', async () => {
    const rows = data();
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { first: true, second: false }));
    const w = world(rows);
    const tool = panelSync(w.deps);
    const args = { target: 'plugin', uuid: A };
    const plan = await callTool(tool, args, w) as Plan;
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { second: false, first: true }));
    (rows.get(PLUGINS) as { nodePlugins: unknown[] }).nodePlugins.reverse();
    (rows.get('/api/nodes') as unknown[]).reverse();
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).resolves.toMatchObject({ result: { status: 'queued' } });
  });
});

describe('panel_sync — bounded enumeration', () => {
  it('refuses too many plugin details before fan-out instead of inspecting a partial catalog', async () => {
    const rows = data();
    rows.set(PLUGINS, { total: 11, nodePlugins: Array.from({ length: 11 }, (_, n) => plugin(nodeId(n), `P${n}`, null)) });
    rows.set('/api/nodes', []);
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'shared_list', name: 'trusted' }, w)).rejects.toThrow(/лимит|потолок/i);
    expect(w.calls.filter((call) => call.path.startsWith(`${PLUGINS}/`) && call.raw)).toEqual([]);
  });

  it('refuses a fleet beyond the read ceiling instead of truncating to the safe nodes', async () => {
    const rows = data();
    rows.set('/api/nodes', Array.from({ length: 501 }, (_, n) => node(nodeId(n), null)));
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow(/лимит|потолок/i);
  });

  it('refuses more than 20 affected nodes even when all sources are complete', async () => {
    const rows = data();
    rows.set('/api/nodes', Array.from({ length: 21 }, (_, n) => node(nodeId(n), A)));
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow(/лимит|потолок/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses more than 10 shared-list dependencies before requesting their content', async () => {
    const rows = data();
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', { refs: Array.from({ length: 11 }, (_, n) => `ext:list_${n}`) }));
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow(/лимит|потолок/i);
    expect(w.calls.every((call) => !call.path.startsWith(LISTS))).toBe(true);
  });

  it.each([
    ['nested traversal', Array.from({ length: 66 }).reduce<unknown>((value) => ({ nested: value }), null)],
    ['many values', { entries: Array.from({ length: 100_001 }, () => 0) }],
    ['long string', { seed: 'x'.repeat(2_000_001) }],
    ['masked values', { seed: '<redacted>' }],
  ])('refuses %s without retaining raw configuration', async (_label, config) => {
    const rows = data();
    rows.set(`${PLUGINS}/${A}`, plugin(A, 'Main', config));
    const w = world(rows);
    await expect(callTool(panelSync(w.deps), { target: 'plugin', uuid: A }, w)).rejects.toThrow(/лимит|маски/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
    expect((await readFile(w.auditPath, 'utf8')).length).toBeLessThan(5000);
  });
});

describe('panel_sync — stored plan integrity', () => {
  const corruptions: Array<[string, (plan: MutationPlan) => void]> = [
    ['POST target changes to a plugin beyond the impact ceiling', (plan) => {
      (plan.after as { operation: Record<string, unknown> }).operation.uuid = B;
    }],
    ['POST target changes from a plugin to a shared list', (plan) => {
      (plan.after as { operation: unknown }).operation = { target: 'shared_list', name: 'trusted' };
    }],
    ['expected count changes independently of the reviewed nodes', (plan) => {
      (plan.after as { expectedAffectedNodeCount: number }).expectedAffectedNodeCount = 0;
    }],
    ['reviewed count changes independently of the expected count', (plan) => {
      (plan.before as { affectedNodeCount: number }).affectedNodeCount = 0;
    }],
    ['reviewed node list changes independently of its count', (plan) => {
      (plan.before as { affectedNodes: unknown[] }).affectedNodes = [];
    }],
    ['a malformed fingerprint includes raw configuration', (plan) => {
      (plan.before as { configFingerprint: unknown }).configFingerprint = { seed: SENTINEL, address: IP };
    }],
  ];

  it.each(corruptions)('refuses before source reads when %s', async (_label, corrupt) => {
    const rows = data();
    rows.set('/api/nodes', [node(N1, A), ...Array.from({ length: 21 }, (_, n) => node(nodeId(n), B))]);
    const w = world(rows);
    const tool = panelSync(w.deps);
    const args = { target: 'plugin', uuid: A };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.before.affectedNodeCount).toBe(1);
    const saved = await w.deps.confirm.peek(plan.plan_id);
    corrupt(saved);
    await writeFile(join(w.snapshotDir, `${plan.plan_id}.json`), JSON.stringify(saved));
    const callsBefore = w.calls.length;
    let error: unknown;
    try { await callTool(tool, { ...args, plan_id: plan.plan_id }, w); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/повреждён|несогласован|снимок/i);
    expect(String(error)).not.toContain(SENTINEL);
    expect(String(error)).not.toContain(IP);
    expect(w.calls).toHaveLength(callsBefore);
  });

  it('the applier also refuses an internally inconsistent snapshot without relying on the guard', async () => {
    const w = world();
    const tool = panelSync(w.deps);
    const plan = await callTool(tool, { target: 'plugin', uuid: A }, w) as Plan;
    const saved = await w.deps.confirm.peek(plan.plan_id);
    (saved.after as { operation: { uuid: string } }).operation.uuid = B;
    await expect(tool.apply(saved, w.ctx)).rejects.toThrow(/повреждён|несогласован|снимок/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('binds the stored operation to the original input hash used to select the audit target', async () => {
    const w = world();
    const tool = panelSync(w.deps);
    const plan = await callTool(tool, { target: 'plugin', uuid: A }, w) as Plan;
    const saved = await w.deps.confirm.peek(plan.plan_id);
    // Partial corruption of identity: the stored confirmation hash still belongs to plugin A.
    (saved.before as { operation: { uuid: string } }).operation.uuid = B;
    (saved.after as { operation: { uuid: string } }).operation.uuid = B;
    const callsBefore = w.calls.length;
    await expect(tool.guard.read(saved, w.ctx)).rejects.toThrow(/повреждён|несогласован|снимок/i);
    await expect(tool.apply(saved, w.ctx)).rejects.toThrow(/повреждён|несогласован|снимок/i);
    expect(w.calls).toHaveLength(callsBefore);
  });

  it('compares reviewed node metadata with the live impact without reflecting corrupted strings', async () => {
    const w = world();
    const tool = panelSync(w.deps);
    const args = { target: 'plugin', uuid: A };
    const plan = await callTool(tool, args, w) as Plan;
    const saved = await w.deps.confirm.peek(plan.plan_id);
    (saved.before as { affectedNodes: Array<{ name: string }> }).affectedNodes[0]!.name = SENTINEL;
    await writeFile(join(w.snapshotDir, `${plan.plan_id}.json`), JSON.stringify(saved));
    let error: unknown;
    try { await callTool(tool, { ...args, plan_id: plan.plan_id }, w); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/снимок охвата/);
    expect(String(error)).not.toContain(SENTINEL);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
