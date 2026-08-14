import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createProbeStore, createRegistry, defineTool } from '@hq/registry';
import type { ToolContext } from '@hq/types';
import { createServer } from './mcpServer.js';

const ctx: ToolContext = {
  shm: {
    get: async <T>() => ({}) as T,
    list: async <T>() => ({ items: 0, limit: 25, offset: 0, data: [] as T[] }),
    action: async <T>() => ({}) as T,
    getRaw: async <T>() => ({}) as T,
    sendRaw: async <T>() => ({}) as T,
  },
  remna: {
    get: async <T>() => ({}) as T,
    send: async <T>() => ({}) as T,
    getRaw: async <T>() => ({}) as T,
    sendRaw: async <T>() => ({}) as T,
  },
  backends: { shm: true, remna: true },
  profile: 'human',
  mode: 'ro',
  now: () => new Date('2026-08-08T12:00:00.000Z'),
  shmTz: 'Europe/Moscow',
  probe: createProbeStore(),
};

const echo = defineTool({
  name: 'client_overview',
  description: 'echo',
  input: z.object({ shm_user_id: z.number().int(), note: z.string().default('none') }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  handler: async (input) => ({
    user_id: input.shm_user_id,
    note: input.note,
    trojanPassword: 'trojan-plaintext',
  }),
});

const boom = defineTool({
  name: 'spool_inspect',
  description: 'always fails',
  input: z.object({ status: z.string().nullable().default(null) }),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  handler: async () => {
    throw new Error('SHM answered 403');
  },
});

const noInput = defineTool({
  name: 'infra_map',
  description: 'no input at all',
  input: z.object({}),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  handler: async () => ({ nodes: [], gaps: { disabledHosts: 0 } }),
});

/**
 * Инструмент с модификатором УРОВНЯ ОБЪЕКТА. Существует ровно затем, чтобы
 * решение «в registerTool уезжает def.input целиком» было проверяемым: при
 * передаче `def.input.shape` SDK пересобирает поля в СВОЙ zod-mini объект
 * (`objectFromShape`, dist/esm/server/zod-compat.js:14-24), и `.strict()`
 * теряется — схема публикуется без `additionalProperties: false`, а лишний
 * ключ молча срезается вместо отказа. На пустом `z.object({})` разницы нет
 * никакой, поэтому пустой вход такой защиты не даёт.
 */
const strictInput = defineTool({
  name: 'service_inspect',
  description: 'rejects unknown keys',
  input: z.object({ service_id: z.number().int() }).strict(),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  handler: async (input) => ({ service_id: input.service_id }),
});

const mutator = defineTool({
  name: 'billing_adjust',
  description: 'writes money',
  input: z.object({ money: z.number() }),
  access: 'rw',
  risk: 'high',
  profiles: ['human'],
  handler: async (input) => ({ money: input.money }),
});

async function connect(mode: 'ro' | 'rw') {
  const registry = createRegistry([echo, boom, noInput, strictInput, mutator]);
  const server = createServer(registry, { ...ctx, mode });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe('createServer', () => {
  it('does not publish rw tools in ro mode and publishes them in rw', async () => {
    const ro = await connect('ro');
    const roNames = (await ro.client.listTools()).tools.map((t) => t.name).sort();
    expect(roNames).toEqual(['client_overview', 'infra_map', 'service_inspect', 'spool_inspect']);
    await ro.client.close();
    await ro.server.close();

    const rw = await connect('rw');
    const rwNames = (await rw.client.listTools()).tools.map((t) => t.name).sort();
    expect(rwNames).toEqual([
      'billing_adjust',
      'client_overview',
      'infra_map',
      'service_inspect',
      'spool_inspect',
    ]);
    await rw.client.close();
    await rw.server.close();
  });

  it('publishes a JSON schema built from the zod input', async () => {
    const { client, server } = await connect('ro');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'client_overview');
    expect(tool?.inputSchema.type).toBe('object');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['shm_user_id', 'note']);
    await client.close();
    await server.close();
  });

  it('publishes and serves a tool whose input schema is an empty object', async () => {
    // Инструмент без параметров обязан получить объектную схему в листинге и
    // отвечать на вызов с пустыми аргументами: у infra_map, sync_audit и
    // country_health вход пустой или почти пустой, и «нет свойств» не должно
    // превращаться в «нет схемы».
    const { client, server } = await connect('ro');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'infra_map');
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      $schema: 'http://json-schema.org/draft-07/schema#',
    });

    const result = await client.callTool({ name: 'infra_map', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ nodes: [], gaps: { disabledHosts: 0 } });
    await client.close();
    await server.close();
  });

  it('keeps object-level modifiers of the tool schema instead of rebuilding it from the shape', async () => {
    const { client, server } = await connect('ro');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'service_inspect');
    expect(tool?.inputSchema.additionalProperties).toBe(false);

    const extra = await client.callTool({
      name: 'service_inspect',
      arguments: { service_id: 1, sneaky: 'x' },
    });
    expect(extra.isError).toBe(true);
    expect(JSON.stringify(extra.content)).toContain('sneaky');
    await client.close();
    await server.close();
  });

  it('returns structured content, applies defaults and redacts the result', async () => {
    const { client, server } = await connect('ro');
    const result = await client.callTool({
      name: 'client_overview',
      arguments: { shm_user_id: 3073 },
    });
    expect(result.structuredContent).toEqual({
      user_id: 3073,
      note: 'none',
      trojanPassword: '<redacted>',
    });
    expect(JSON.stringify(result)).not.toContain('trojan-plaintext');
    await client.close();
    await server.close();
  });

  it('reports bad input and handler failures as isError, not as a protocol crash', async () => {
    const { client, server } = await connect('ro');
    // Вход проверяет САМ SDK, ДО хендлера (dist/esm/server/mcp.js:129-131 →
    // :172-184 → :141-149), поэтому executeTool с его кодом invalid_input сюда
    // не доходит вовсе и текст здесь — сдковский. Это и есть та асимметрия,
    // которую придётся занести в белый список тесту паритета транспортов в
    // плане 3: на REST-маршруте разбор входа делает @hq/exec, здесь — SDK.
    const badInput = await client.callTool({
      name: 'client_overview',
      arguments: { shm_user_id: 'not a number' },
    });
    expect(badInput.isError).toBe(true);
    expect(JSON.stringify(badInput.content)).toContain('MCP error -32602');
    expect(JSON.stringify(badInput.content)).toContain('shm_user_id');
    expect(JSON.stringify(badInput.content)).not.toContain('invalid_input');

    const failed = await client.callTool({ name: 'spool_inspect', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('SHM answered 403');
    await client.close();
    await server.close();
  });

  it('tells the model why the forbidden operations are absent, without a call', async () => {
    const { client, server } = await connect('ro');
    const instructions = client.getInstructions();
    expect(instructions).toContain('deliberately absent');
    expect(instructions).toContain('/api/tokens');
    await client.close();
    await server.close();
  });
});
