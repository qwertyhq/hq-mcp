import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import type { MakeCtxOptions, StubCall } from '../testkit.js';
import { nodeIntegrationsRead } from './integrations.js';

const FIRST = '11000000-0000-4000-8000-000000000001';
const SECOND = '11000000-0000-4000-8000-000000000002';
const MISSING = '11000000-0000-4000-8000-000000000003';
const NODE = '22000000-0000-4000-8000-000000000001';
const CATALOG = {
  total: 2,
  nodeIntegrations: [
    { uuid: FIRST, name: 'First', description: null, config: { outbound: { seed: 'private-seed' } } },
    { uuid: SECOND, name: 'Second', description: 'Overrides first', config: { outbound: { value: 'private-cert' }, credentials: 'private-pass' } },
  ],
};
const NODES = [{ uuid: NODE, name: 'Example', integrationUuids: [SECOND, FIRST, MISSING], isDisabled: false }];

interface Out {
  integrations: {
    declaredTotal: number | null;
    complete: boolean;
    items: Array<{ uuid: string | null; name: string | null; configRead: boolean; configSectionCount: number | null; configSections: string[]; nodesUsing: unknown[] | null }>;
  };
  nodes: {
    complete: boolean;
    items: Array<{ uuid: string | null; integrationUuids: string[] | null; bindings: Array<{ uuid: string; position: number; exists: boolean | null }> }>;
  };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

function run(input: unknown = {}, options: {
  catalog?: unknown;
  nodes?: unknown;
  card?: unknown;
  profile?: MakeCtxOptions['profile'];
  calls?: StubCall[];
} = {}): Promise<Out> {
  const resolve = (value: unknown) => {
    if (value instanceof Error) throw value;
    return value;
  };
  const ctx = makeCtx({
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.calls === undefined ? {} : { calls: options.calls }),
    remnaGet: (path) => {
      if (path === '/api/node-integrations') return resolve(options.catalog ?? CATALOG);
      if (path === '/api/nodes') return resolve(options.nodes ?? NODES);
      if (path === `/api/node-integrations/${FIRST}`) return resolve(options.card ?? CATALOG.nodeIntegrations[0]);
      throw new Error(`unexpected path ${path}`);
    },
  });
  return nodeIntegrationsRead.handler(nodeIntegrationsRead.input.parse(input), ctx) as Promise<Out>;
}

describe('node_integrations_read', () => {
  it('preserves node binding precedence and diagnoses absent integration references', async () => {
    const out = await run();
    expect(out.nodes.items[0]?.integrationUuids).toEqual([SECOND, FIRST, MISSING]);
    expect(out.nodes.items[0]?.bindings).toEqual([
      { uuid: SECOND, position: 0, exists: true },
      { uuid: FIRST, position: 1, exists: true },
      { uuid: MISSING, position: 2, exists: false },
    ]);
    expect(out.warnings.map((one) => one.code)).toContain('node_integration_missing');
    expect(out.integrations.items[0]?.nodesUsing).toEqual([{ uuid: NODE, name: 'Example', position: 1 }]);
  });

  it('returns only structural configuration information, never arbitrary values', async () => {
    const out = await run();
    expect(out.integrations.items[0]?.configSections).toEqual(['outbound']);
    const serialized = JSON.stringify(out);
    for (const secret of ['private-seed', 'private-cert', 'private-pass']) expect(serialized).not.toContain(secret);
  });

  it.each([
    { label: 'unavailable', catalog: new Error('403 private-seed') },
    { label: 'truncated', catalog: { total: 3, nodeIntegrations: CATALOG.nodeIntegrations } },
    { label: 'malformed', catalog: {} },
    { label: 'uncounted', catalog: { nodeIntegrations: CATALOG.nodeIntegrations } },
  ])('does not assert missing references when the catalog is $label', async ({ catalog }) => {
    const out = await run({}, { catalog });
    expect(out.integrations.complete).toBe(false);
    expect(out.nodes.items[0]?.bindings.at(-1)?.exists).toBeNull();
    expect(out.warnings.map((one) => one.code)).not.toContain('node_integration_missing');
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
    expect(JSON.stringify(out)).not.toContain('private-seed');
  });

  it('does not label integrations unused when the node source fails', async () => {
    const out = await run({}, { nodes: new Error('403') });
    expect(out.nodes.complete).toBe(false);
    expect(out.integrations.items[0]?.nodesUsing).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('does not convert an unreadable integration config into an empty one', async () => {
    const out = await run({}, { catalog: { total: 1, nodeIntegrations: [{ uuid: FIRST, name: 'First', config: null }] } });
    expect(out.integrations.items[0]).toMatchObject({ configRead: false, configSectionCount: null });
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('bounds malformed binding arrays instead of returning unlimited usage positions', async () => {
    const out = await run({}, { nodes: [{ ...NODES[0], integrationUuids: Array.from({ length: 10_000 }, () => FIRST) }] });
    expect(out.nodes.items[0]?.integrationUuids).toHaveLength(20);
    expect(out.integrations.items[0]?.nodesUsing).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('does not assume a locally bounded catalog is complete', async () => {
    const integrations = Array.from({ length: 501 }, (_, i) => ({ uuid: `integration-${String(i)}`, name: 'Example', config: {} }));
    const out = await run({}, {
      catalog: { total: 501, nodeIntegrations: integrations },
      nodes: [{ ...NODES[0], integrationUuids: ['integration-500'] }],
    });
    expect(out.integrations.complete).toBe(false);
    expect(out.nodes.items[0]?.bindings[0]?.exists).toBeNull();
    expect(out.warnings.map((one) => one.code)).not.toContain('node_integration_missing');
  });

  it('distinguishes an available empty catalog from an unavailable one', async () => {
    const out = await run({}, { catalog: { total: 0, nodeIntegrations: [] }, nodes: [] });
    expect(out.integrations).toMatchObject({ declaredTotal: 0, complete: true, items: [] });
    expect(out.warnings.map((one) => one.code)).toContain('node_integrations_unused');
    expect(out.degraded).toEqual([]);
  });

  it('reads an explicitly selected card even when list permission is missing', async () => {
    const calls: StubCall[] = [];
    const out = await run({ integration_uuid: FIRST }, { catalog: new Error('403'), calls });
    expect(out.integrations.items.map((one) => one.uuid)).toEqual([FIRST]);
    expect(out.integrations.complete).toBe(false);
    expect(calls.some((one) => one.path === `/api/node-integrations/${FIRST}`)).toBe(true);
  });

  it('caps output while retaining reference checks against the full catalog', async () => {
    const out = await run({ limit: 1 });
    expect(out.integrations.items).toHaveLength(1);
    expect(out.nodes.items[0]?.bindings[0]?.exists).toBe(true);
  });

  it('rejects bots before any source access and rejects malformed UUIDs', async () => {
    const calls: StubCall[] = [];
    await expect(run({}, { profile: 'bot', calls })).rejects.toThrow(/human/i);
    expect(calls).toEqual([]);
    expect(() => nodeIntegrationsRead.input.parse({ integration_uuid: '../secret' })).toThrow();
    expect(nodeIntegrationsRead.access).toBe('ro');
    expect(nodeIntegrationsRead.backends).toEqual(['remna']);
  });
});
