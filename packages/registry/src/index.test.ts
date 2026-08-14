import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProbeResult, ToolContext } from '@hq/types';
import { CAPABILITIES } from '@hq/types';
import { Registry, createProbeStore, createRegistry, defineTool } from './index.js';

const reader = defineTool({
  name: 'client_overview',
  description: 'read',
  input: z.object({ shm_user_id: z.number().int() }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  handler: async (input) => ({ echoed: input.shm_user_id }),
});

const writer = defineTool({
  name: 'billing_adjust',
  description: 'write',
  input: z.object({ money: z.number() }),
  access: 'rw',
  risk: 'high',
  profiles: ['human'],
  handler: async (input) => ({ money: input.money }),
});

const humanOnly = defineTool({
  name: 'sql_query',
  description: 'human only',
  input: z.object({ sql: z.string() }),
  access: 'ro',
  risk: 'medium',
  profiles: ['human'],
  requires: ['tunnel.postgres'],
  handler: async () => ({ rows: [] }),
});

function probeWith(overrides: Partial<ProbeResult['capabilities']>): ProbeResult {
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((cap) => [cap, 'unknown' as const]),
  ) as ProbeResult['capabilities'];
  return {
    checkedAt: '2026-08-08T12:00:00.000Z',
    cached: false,
    shm: {
      configured: true,
      reachable: true,
      error: null,
      spoolStatuses: [],
      version: null,
      live: true,
      credentialsRejected: false,
    },
    remna: {
      configured: true,
      reachable: true,
      error: null,
      version: '2.8.0',
      credentialsRejected: false,
      runtime: null,
    },
    capabilities: { ...capabilities, ...overrides },
    warnings: [],
  };
}

describe('Registry.list', () => {
  it('hides rw tools entirely in ro mode', () => {
    const registry = createRegistry([reader, writer]);
    expect(registry.list({ mode: 'ro', profile: 'human' }).map((d) => d.name)).toEqual([
      'client_overview',
    ]);
    expect(registry.list({ mode: 'rw', profile: 'human' }).map((d) => d.name)).toEqual([
      'billing_adjust',
      'client_overview',
    ]);
  });

  it('filters by profile', () => {
    const registry = createRegistry([reader, humanOnly]);
    expect(registry.list({ mode: 'ro', profile: 'bot' }).map((d) => d.name)).toEqual([
      'client_overview',
    ]);
    expect(registry.list({ mode: 'ro', profile: 'human' }).map((d) => d.name)).toEqual([
      'client_overview',
      'sql_query',
    ]);
  });

  it('drops a tool whose required capability is known to be missing', () => {
    const registry = createRegistry([reader, humanOnly]);
    const down = probeWith({ 'tunnel.postgres': false });
    expect(registry.list({ mode: 'ro', profile: 'human', probe: down }).map((d) => d.name)).toEqual([
      'client_overview',
    ]);
  });

  it('keeps the tool when the capability could not be verified', () => {
    const registry = createRegistry([reader, humanOnly]);
    const unsure = probeWith({});
    expect(
      registry.list({ mode: 'ro', profile: 'human', probe: unsure }).map((d) => d.name),
    ).toEqual(['client_overview', 'sql_query']);
    const up = probeWith({ 'tunnel.postgres': true });
    expect(registry.list({ mode: 'ro', profile: 'human', probe: up }).map((d) => d.name)).toEqual([
      'client_overview',
      'sql_query',
    ]);
  });
});

describe('Registry.register', () => {
  it('rejects duplicates, bad names, empty profiles and non-zod input', () => {
    const registry = new Registry();
    registry.register(reader);
    expect(() => registry.register(reader)).toThrow(/already registered/);
    // Точка в имени запрещена: имя доезжает до модели через Messages API,
    // где действует ^[a-zA-Z0-9_-]{1,64}$.
    expect(() => registry.register({ ...reader, name: 'client.overview' })).toThrow(
      /<domain>_<action>/,
    );
    expect(() => registry.register({ ...reader, name: 'clientOverview' })).toThrow(
      /<domain>_<action>/,
    );
    expect(() => registry.register({ ...reader, name: 'a_b', profiles: [] })).toThrow(/profiles/);
    expect(() =>
      registry.register({ ...reader, name: 'a_b', input: {} as (typeof reader)['input'] }),
    ).toThrow(/z\.object/);
    expect(() =>
      registry.register({ ...reader, name: 'a_b', requires: ['shm.nope'] as never }),
    ).toThrow(/capability/);
  });

  it('rejects a name over 64 characters but accepts one at exactly 64', () => {
    // Имя доезжает до модели как mcp__<server>__<name>, а принимающий API режет
    // на ^[a-zA-Z0-9_-]{1,64}$: слишком длинное имя роняет вызов вне нашего контроля.
    const registry = new Registry();
    const name64 = `a_${'a'.repeat(62)}`;
    const name65 = `a_${'a'.repeat(63)}`;
    expect(name64).toHaveLength(64);
    expect(name65).toHaveLength(65);
    expect(() => registry.register({ ...reader, name: name64 })).not.toThrow();
    expect(() => registry.register({ ...reader, name: name65 })).toThrow(/64/);
  });
});

describe('createProbeStore', () => {
  it('starts empty and remembers the last probe', () => {
    const store = createProbeStore();
    expect(store.get()).toBeNull();
    const value = probeWith({ 'shm.filter': true });
    store.set(value);
    expect(store.get()?.capabilities['shm.filter']).toBe(true);
  });
});

describe('defineTool', () => {
  it('keeps the handler callable through the erased ToolDef', async () => {
    const registry = createRegistry([reader]);
    const def = registry.get('client_overview');
    expect(def).toBeDefined();
    const ctx = {} as ToolContext;
    await expect(def?.handler({ shm_user_id: 3073 }, ctx)).resolves.toEqual({ echoed: 3073 });
    expect(registry.get('nope')).toBeUndefined();
  });
});
