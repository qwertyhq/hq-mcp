import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { createRegistry } from '@hq/registry';
import type { ToolDef } from '@hq/types';
import type { Hono } from 'hono';
import { createApp, MAX_BODY_BYTES } from './app.js';
import type { AppDeps, AppEnv } from './app.js';
import { AUTH_HEADERS, fakeCtx, fakeDeps as makeFakeDeps } from './testing.js';

function fakeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return makeFakeDeps({ ctx: fakeCtx({ profile: 'human' }), ...over });
}

const MCP_URL = 'http://127.0.0.1/mcp';

/**
 * Заголовки, которые streamable HTTP требует от POST-а: SDK отвечает 406, если
 * клиент не объявил, что понимает ОБА типа ответа, и 415 на чужой content-type.
 * Сырые запросы ниже проверяют транспорт, а не эту проверку, поэтому шлют их.
 */
const RPC_HEADERS = {
  ...AUTH_HEADERS,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/**
 * Настоящий клиент MCP поверх `createApp`, БЕЗ слушающего сокета: `app.fetch` —
 * это обычный веб-стандартный обработчик, а клиентскому транспорту как раз
 * можно подсунуть свой `fetch`. Так тест проходит ровно тот путь, которым
 * ходит живой клиент (initialize → notifications/initialized → GET на SSE →
 * tools/list), а не его пересказ сырыми запросами.
 */
async function connect(
  app: Hono<AppEnv>,
  init: RequestInit = { headers: AUTH_HEADERS },
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: init,
    fetch: async (url: string | URL, opts?: RequestInit): Promise<Response> =>
      app.fetch(new Request(url, opts)),
  });
  const client = new Client({ name: 'hq-mcp-test-client', version: '0.0.0' });
  // Приведение — дефект типов SDK, а не наш: `Transport.sessionId` объявлен как
  // необязательное `string`, а у клиентского транспорта это геттер
  // `string | undefined`. Под exactOptionalPropertyTypes два этих типа не
  // совпадают, хотя множество значений у них одно. Узкое, одно на файл.
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

interface ToolListing {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

describe('POST /mcp — настоящий клиент MCP', () => {
  it('проходит initialize и видит имя, версию и инструкции сервера', async () => {
    const { client, transport } = await connect(createApp(fakeDeps()));
    // Версия — из package.json приложения (deps.version), а не из умолчания
    // createServer: иначе /healthz и MCP-рукопожатие называли бы разные числа.
    expect(client.getServerVersion()).toEqual({ name: 'hq-mcp', version: 'test' });
    // Инструкции §8 — те же, что на stdio: их даёт одна и та же createServer.
    expect(client.getInstructions()).toContain('deliberately absent');
    // Сессий нет: сервер не выдаёт Mcp-Session-Id, клиент его не хранит.
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it('keeps native MCP available to the human profile', async () => {
    const app = createApp(fakeDeps());
    const { client } = await connect(app);
    const listing = (await client.listTools()) as ToolListing;
    expect(listing.tools.map((t) => t.name).sort()).toEqual([
      'client_overview',
      'spool_inspect',
      'sql_query',
    ]);
    const overview = listing.tools.find((t) => t.name === 'client_overview');
    expect((overview?.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
    await client.close();
  });

  it('tools/call возвращает данные, отредактированные по профилю', async () => {
    const deps = fakeDeps();
    const { client } = await connect(createApp(deps));
    const result = await client.callTool({
      name: 'client_overview',
      arguments: { query: 'tg100000001' },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain('3073');
    // Редакцию делает executeTool по human-профилю — тот же слой, что на stdio.
    // Своего второго прохода у этого маршрута нет намеренно: иначе один и тот же
    // инструмент в одном профиле отвечал бы по stdio и по /mcp по-разному.
    expect(text).not.toContain('p@ssw0rd');
    expect(text).not.toContain('AbCdEf12');
    expect(text).toContain('client@example.com');
    // Вызов виден в /metrics: без этого auth.ok рос бы, а totals.calls стоял.
    const snapshot = deps.metrics.snapshot();
    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.totals.ok).toBe(1);
    expect(snapshot.byTool.client_overview?.ok).toBe(1);
    expect(snapshot.byClient.test?.ok).toBe(1);
    await client.close();
  });

  it('невалидный вход — isError от SDK, а не падение протокола', async () => {
    const deps = fakeDeps();
    const { client } = await connect(createApp(deps));
    const result = await client.callTool({
      name: 'client_overview',
      arguments: { query: 42 },
    });
    expect(result.isError).toBe(true);
    // Вход разбирает САМ SDK, до колбэка инструмента, поэтому код исполнителя
    // invalid_input сюда не доезжает — известная асимметрия stdio/MCP и REST.
    expect(JSON.stringify(result.content)).toContain('MCP error -32602');
    // И по той же причине исход не попадает в счётчики: до onCall дело не дошло.
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
    await client.close();
  });

  it('неизвестное имя инструмента — отказ SDK, реестр по-прежнему не виден', async () => {
    const deps = fakeDeps();
    const { client } = await connect(createApp(deps));
    const unknown = await client.callTool({ name: 'missing_tool', arguments: {} });
    expect(unknown.isError).toBe(true);
    // Неизвестное имя не вызывает ни один handler — ровно как на stdio и REST.
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
    await client.close();
  });

  it('падение инструмента едет как isError с кодом исполнителя и считается в failed', async () => {
    const boom: ToolDef = {
      name: 'spool_inspect',
      description: 'always fails',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      handler: async () => {
        throw new Error('SHM answered 403');
      },
    };
    const deps = fakeDeps({ registry: createRegistry([boom]) });
    const { client } = await connect(createApp(deps));
    const failed = await client.callTool({ name: 'spool_inspect', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('handler_failed');
    const snapshot = deps.metrics.snapshot();
    expect(snapshot.totals.failed).toBe(1);
    expect(snapshot.byClient.test?.failed).toBe(1);
    await client.close();
  });
});

describe('POST /mcp — ворота и потолки', () => {
  it('без токена — 401 из общих ворот, до всякого разбора JSON-RPC', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'valid Bearer token required' },
    });
    expect(deps.metrics.snapshot().auth).toEqual({ ok: 0, rejected: 1 });
  });

  it('настоящий клиент без токена не поднимает соединение', async () => {
    const app = createApp(fakeDeps());
    await expect(connect(app, {})).rejects.toThrow();
  });

  it('без токена не видно ни одного имени инструмента', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(await res.text()).not.toContain('client_overview');
  });

  it('слишком большое тело по Content-Length — 413, до чтения потока', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: 'payload_too_large', message: `request body exceeds ${MAX_BODY_BYTES} bytes` },
    });
  });

  it('слишком большое тело БЕЗ Content-Length ловится по факту прочитанных байт', async () => {
    // Потолок в app.ts считает по заголовку, а его может не быть вовсе
    // (chunked). Здесь заголовок не выставлен — отбой обязан дать сам маршрут.
    const deps = fakeDeps();
    const app = createApp(deps);
    const padding = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: RPC_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'client_overview', arguments: { query: padding } },
      }),
    });
    expect(res.status).toBe(413);
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
  });
});

describe('POST /mcp — защита от DNS rebinding', () => {
  it('запрос с Origin отбивается 403, даже с верным токеном', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, origin: 'https://evil.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Origin header is not accepted on this endpoint' },
      id: null,
    });
    // Инструменты не звались и имён своих не показали.
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
  });

  it('пустой Origin запрос не рубит: заголовок есть, а происхождения в нём нет', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, origin: '' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });

  it('отказ по Origin стоит ЗА воротами: без токена сначала 401', async () => {
    // Порядок не косметика: странице без токена незачем узнавать по коду
    // ответа, что за этим путём вообще что-то есть.
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('/mcp — методы и протокольные ошибки', () => {
  it.each(['GET', 'DELETE', 'PUT'])('%s получает 405 с Allow, а не 404 из notFound', async (m) => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: m,
      headers: { ...AUTH_HEADERS, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  it('неизвестный метод JSON-RPC — -32601, а не 404 и не падение', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: RPC_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'resources/list' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; error: { code: number; message: string } };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
  });

  it('битый JSON — разбор и форму отказа даёт SDK, а не свой парсер', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: RPC_HEADERS,
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
  });

  it('бессессионный транспорт не переиспользуется: два вызова подряд проходят', async () => {
    // SDK бросает «Stateless transport cannot be reused across requests», если
    // один и тот же транспорт увидит второй запрос. Этот тест краснеет ровно
    // тогда, когда сервер и транспорт перестали быть свежими на запрос.
    const app = createApp(fakeDeps());
    const { client } = await connect(app);
    expect(((await client.listTools()) as ToolListing).tools).toHaveLength(3);
    expect(((await client.listTools()) as ToolListing).tools).toHaveLength(3);
    const called = await client.callTool({
      name: 'spool_inspect',
      arguments: {},
    });
    expect(called.isError).toBeFalsy();
    await client.close();
  });

  it('падение внутри маршрута не выносит наружу ни текста, ни стека', async () => {
    const deps = fakeDeps();
    // Реестр, который бросает на листинге видимых инструментов: это ровно та
    // ошибка, что случится ДО того, как транспорт соберёт свой ответ.
    const broken: AppDeps = {
      ...deps,
      registry: {
        ...deps.registry,
        list: () => {
          throw new Error('SHM GET https://admin.example.io/shm/v1?secret=shm-all-xyz failed');
        },
      } as unknown as AppDeps['registry'],
    };
    const app = createApp(broken);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: RPC_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: { code: 'error', message: 'internal error' } }));
    expect(text).not.toContain('shm-all');
    logged.mockRestore();
  });
});
