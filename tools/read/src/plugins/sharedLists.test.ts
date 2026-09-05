import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import type { MakeCtxOptions, StubCall } from '../testkit.js';
import { sharedListsRead } from './sharedLists.js';

const PLUGIN = '33000000-0000-4000-8000-000000000001';
const CATALOG = { total: 2, sharedLists: [
  { name: 'trusted', type: 'ipList', itemsCount: 2 },
  { name: 'providers', type: 'asList', itemsCount: 1 },
] };
const CARD = {
  uuid: PLUGIN, name: 'Blocker', pluginConfig: {
    torrentBlocker: { enabled: true, blockDuration: 60, ignoreLists: { ip: ['ext:trusted', '198.51.100.9', 'ext:missing'] }, webhookUrl: 'https://private.example/token' },
    sharedLists: [{ name: 'ext:missing', type: 'ipList', items: ['198.51.100.99'] }],
  },
};

interface Out {
  lists: { complete: boolean; declaredTotal: number | null; items: Array<{
    name: string; reference: string; exists: boolean | null; itemsCount: number | null;
    detailRead: boolean; detail: { type: string | null; itemsCount: number | null } | null;
    pluginsUsing: Array<{ uuid: string | null; name: string | null }> | null;
    nodesUsing: Array<{ uuid: string | null; name: string | null }> | null;
  }> };
  plugins: { complete: boolean; items: Array<{ uuid: string | null; references: Array<{ name: string; reference: string; exists: boolean | null }> | null }> };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ error: string }>;
}

function run(input: unknown = {}, options: {
  catalog?: unknown; plugins?: unknown; card?: unknown; details?: unknown; nodes?: unknown;
  calls?: StubCall[]; profile?: MakeCtxOptions['profile'];
} = {}): Promise<Out> {
  const resolve = (value: unknown) => { if (value instanceof Error) throw value; return value; };
  const ctx = makeCtx({
    ...(options.calls === undefined ? {} : { calls: options.calls }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    remnaGet: (path) => {
      if (path === '/api/node-plugins/shared-lists') return resolve(options.catalog ?? CATALOG);
      if (path.startsWith('/api/node-plugins/shared-lists/')) return resolve('details' in options ? options.details : {
        name: path.split('/').at(-1), config: path.endsWith('trusted')
          ? { type: 'ipList', items: ['198.51.100.1', '2001:db8::/32'], seed: 'private-list-seed' }
          : { type: 'asList', items: [64512] },
      });
      if (path === '/api/node-plugins') return resolve(options.plugins ?? { total: 1, nodePlugins: [{ uuid: PLUGIN, name: 'Blocker', pluginConfig: null }] });
      if (path.startsWith('/api/node-plugins/')) return resolve(options.card ?? CARD);
      if (path === '/api/nodes') return resolve(options.nodes ?? [{ uuid: 'example-node', name: 'Example', activePluginUuid: PLUGIN }]);
      throw new Error(`unexpected path ${path}`);
    },
  });
  return sharedListsRead.handler(sharedListsRead.input.parse(input), ctx) as Promise<Out>;
}

describe('shared_lists_read', () => {
  it('reads full list details separately from previews and never returns item values', async () => {
    const calls: StubCall[] = [];
    const out = await run({}, { calls });
    expect(out.lists.items[0]).toMatchObject({
      name: 'trusted', reference: 'ext:trusted', exists: true, itemsCount: 2,
      detailRead: true, detail: { type: 'ipList', itemsCount: 2 },
      pluginsUsing: [{ uuid: PLUGIN, name: 'Blocker' }],
      nodesUsing: [{ uuid: 'example-node', name: 'Example' }],
    });
    expect(calls.map((one) => one.path)).toContain('/api/node-plugins/shared-lists/trusted');
    const serialized = JSON.stringify(out);
    for (const secret of ['198.51.100', '2001:db8', '64512', 'private-list-seed', 'private.example', 'webhookUrl']) expect(serialized).not.toContain(secret);
  });

  it('finds ext references while ignoring embedded sharedLists, which the panel discards', async () => {
    const out = await run();
    expect(out.plugins.items[0]?.references).toEqual([
      { name: 'trusted', reference: 'ext:trusted', exists: true },
      { name: 'missing', reference: 'ext:missing', exists: false },
    ]);
    expect(out.warnings.map((one) => one.code)).toContain('shared_list_reference_missing');
  });

  it.each([
    new Error('404 private-list-seed'),
    { total: 3, sharedLists: CATALOG.sharedLists },
    { sharedLists: CATALOG.sharedLists },
    {},
  ])('keeps unresolved references unknown for failed or incomplete catalogs', async (catalog) => {
    const out = await run({}, { catalog });
    expect(out.plugins.items[0]?.references?.at(-1)?.exists).toBeNull();
    expect(out.warnings.map((one) => one.code)).not.toContain('shared_list_reference_missing');
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
    expect(JSON.stringify(out)).not.toContain('private-list-seed');
  });

  it('retains previews when detail scope is denied', async () => {
    const out = await run({}, { details: new Error('403') });
    expect(out.lists.items[0]).toMatchObject({ name: 'trusted', itemsCount: 2, detailRead: false, detail: null });
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('keeps plugin usage unknown after a failed or truncated plugin source', async () => {
    for (const plugins of [new Error('403'), { total: 2, nodePlugins: [{ uuid: PLUGIN, name: 'Blocker' }] }]) {
      const out = await run({}, { plugins });
      expect(out.plugins.complete).toBe(false);
      expect(out.lists.items[0]?.pluginsUsing).toBeNull();
      expect(out.lists.items[0]?.nodesUsing).toBeNull();
    }
  });

  it('does not claim zero users of a list when a plugin card failed', async () => {
    const out = await run({}, { card: new Error('403') });
    expect(out.lists.items[0]?.pluginsUsing).toBeNull();
    expect(out.plugins.items[0]?.references).toBeNull();
  });

  it('does not treat an omitted node plugin binding as an explicit null binding', async () => {
    const out = await run({}, { nodes: [{ uuid: 'example-node', name: 'Example' }] });
    expect(out.lists.items[0]?.nodesUsing).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('does not turn a malformed plugin card into an empty reference set', async () => {
    const out = await run({}, { card: { uuid: PLUGIN, pluginConfig: null } });
    expect(out.plugins.items[0]?.references).toBeNull();
    expect(out.plugins.complete).toBe(false);
  });

  it('does not claim complete plugin coverage when redaction concealed a possible dependency', async () => {
    const out = await run({}, { card: { ...CARD, pluginConfig: { privateExtension: '<redacted>' } } });
    expect(out.plugins.complete).toBe(false);
    expect(out.lists.items[0]?.pluginsUsing).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('bounds dependency scans without declaring the unvisited tail unused', async () => {
    const out = await run({}, { card: { ...CARD, pluginConfig: { ingressFilter: {
      blockedIps: [...Array.from({ length: 10_001 }, () => '198.51.100.1'), 'ext:trusted'],
    } } } });
    expect(out.plugins.complete).toBe(false);
    expect(out.lists.items[0]?.pluginsUsing).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('marks an empty successful detail body unreadable instead of returning a healthy preview', async () => {
    const out = await run({}, { details: null });
    expect(out.lists.items[0]?.detailRead).toBe(false);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
    expect(out.degraded.length).toBeGreaterThan(0);
  });

  it('can return previews without reading detail bodies', async () => {
    const calls: StubCall[] = [];
    const out = await run({ include_details: false }, { calls });
    expect(out.lists.items[0]?.detailRead).toBe(false);
    expect(calls.filter((one) => one.path.startsWith('/api/node-plugins/shared-lists/'))).toEqual([]);
  });

  it('limits detail requests and labels unexamined plugin coverage incomplete', async () => {
    const calls: StubCall[] = [];
    const out = await run({}, {
      calls,
      catalog: { total: 100, sharedLists: Array.from({ length: 100 }, (_, i) => ({ name: `list-${String(i)}`, type: 'ipList', itemsCount: 0 })) },
      plugins: { total: 100, nodePlugins: Array.from({ length: 100 }, (_, i) => ({ uuid: `plugin-${String(i)}`, name: `Plugin ${String(i)}` })) },
    });
    expect(calls.filter((one) => one.path.startsWith('/api/node-plugins/shared-lists/')).length).toBeLessThanOrEqual(5);
    expect(calls.filter((one) => /^\/api\/node-plugins\/plugin-/.test(one.path)).length).toBeLessThanOrEqual(5);
    expect(out.plugins.complete).toBe(false);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('identifies an empty available catalog explicitly', async () => {
    const out = await run({}, { catalog: { total: 0, sharedLists: [] }, plugins: { total: 0, nodePlugins: [] } });
    expect(out.lists).toMatchObject({ complete: true, declaredTotal: 0, items: [] });
    expect(out.warnings.map((one) => one.code)).toContain('shared_lists_unused');
    expect(out.degraded).toEqual([]);
  });

  it('reads a named list without requiring catalog permission', async () => {
    const out = await run({ name: 'trusted' }, { catalog: new Error('403') });
    expect(out.lists.items[0]).toMatchObject({ name: 'trusted', exists: true, detailRead: true, detail: { type: 'ipList', itemsCount: 2 } });
    expect(out.lists.complete).toBe(false);
  });

  it.each([
    { label: 'complete absence without detail read', includeDetails: false, catalog: { total: 0, sharedLists: [] }, details: null, exists: false },
    { label: 'incomplete catalog without detail read', includeDetails: false, catalog: { total: 1, sharedLists: [] }, details: null, exists: null },
    { label: 'unavailable catalog without detail read', includeDetails: false, catalog: new Error('403'), details: null, exists: null },
    { label: 'valid detail after catalog permission failure', includeDetails: true, catalog: new Error('403'), details: { name: 'unseen', config: { type: 'asList', items: [] } }, exists: true },
    { label: 'valid detail after complete empty catalog', includeDetails: true, catalog: { total: 0, sharedLists: [] }, details: { name: 'unseen', config: { type: 'asList', items: [] } }, exists: true },
    { label: 'failed detail with complete absent catalog entry', includeDetails: true, catalog: { total: 0, sharedLists: [] }, details: new Error('403'), exists: false },
    { label: 'failed detail with incomplete catalog', includeDetails: true, catalog: { total: 1, sharedLists: [] }, details: new Error('403'), exists: null },
    { label: 'failed detail with known catalog entry', includeDetails: true, catalog: { total: 1, sharedLists: [{ name: 'unseen', type: 'asList', itemsCount: 0 }] }, details: new Error('403'), exists: true },
    { label: 'mismatched detail with complete absent catalog entry', includeDetails: true, catalog: { total: 0, sharedLists: [] }, details: { name: 'different', config: { type: 'asList', items: [] } }, exists: false },
  ])('reports selected list existence for $label', async ({ includeDetails, catalog, details, exists }) => {
    const out = await run({ name: 'unseen', include_details: includeDetails }, {
      catalog, details, plugins: { total: 0, nodePlugins: [] }, nodes: [],
    });
    expect(out.lists.items).toHaveLength(1);
    expect(out.lists.items[0]?.exists).toBe(exists);
    if (!includeDetails && exists === false) expect(out.degraded).toEqual([]);
  });

  it('rejects ext-prefixed API names, traversal and bots before source access', async () => {
    for (const name of ['ext:trusted', '../trusted', 'a', 'has space']) expect(() => sharedListsRead.input.parse({ name })).toThrow();
    const calls: StubCall[] = [];
    await expect(run({}, { profile: 'bot', calls })).rejects.toThrow(/human/i);
    expect(calls).toEqual([]);
    expect(sharedListsRead.access).toBe('ro');
    expect(sharedListsRead.backends).toEqual(['remna']);
  });
});
