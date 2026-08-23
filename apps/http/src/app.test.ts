import { describe, expect, it, vi } from 'vitest';
import { BOT_MAX_BODY_BYTES, createApp, MAX_BODY_BYTES } from './app.js';
import { AUTH_HEADERS, fakeCtx, fakeDeps, TEST_TOKEN } from './testing.js';

describe('createApp', () => {
  it('/healthz публичен и не требует токена', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: 'hq-mcp-http',
      version: 'test',
      profile: 'bot',
      mode: 'ro',
      tools: 2,
    });
  });

  it('/healthz отдаёт число инструментов, но ни одного имени', async () => {
    // Публичной ручке нужен признак жизни, а не инвентарь: количество не даёт перебрать
    // реестр, а имя — даёт. Ровно это единообразный отказ `Tool <name> not found` в
    // @hq/exec закрывает с другой стороны.
    const app = createApp(fakeDeps());
    const body = await (await app.request('/healthz')).text();
    expect(body).not.toContain('client_overview');
    expect(body).not.toContain('spool_inspect');
    expect(body).not.toContain('sql_query');
  });

  it('/metrics human-профиля без токена — 401 с WWW-Authenticate', async () => {
    const deps = fakeDeps({ ctx: fakeCtx({ profile: 'human' }) });
    const app = createApp(deps);
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'valid Bearer token required' },
    });
    expect(deps.metrics.snapshot().auth).toEqual({ ok: 0, rejected: 1 });
  });

  it('/metrics не выдаёт инвентарь allowlist-а без токена', async () => {
    // byTool назван именами инструментов, которые бот РЕАЛЬНО может звать. Открытый
    // /metrics отдал бы наружу список, который @hq/exec прячет единообразным отказом:
    // перебор реестра снова стал бы возможен, только через другую дверь.
    const deps = fakeDeps({ ctx: fakeCtx({ profile: 'human' }) });
    deps.metrics.noteCall('client_overview', 'ok', 'test');
    const app = createApp(deps);
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('client_overview');
  });

  it('/metrics с чужим токеном — тоже 401', async () => {
    const app = createApp(fakeDeps({ ctx: fakeCtx({ profile: 'human' }) }));
    const res = await app.request('/metrics', {
      headers: { authorization: `Bearer ${TEST_TOKEN}-nope` },
    });
    expect(res.status).toBe(401);
  });

  it('keeps guarded metrics available to the human profile', async () => {
    const deps = fakeDeps({ ctx: fakeCtx({ profile: 'human' }) });
    const app = createApp(deps);
    const res = await app.request('/metrics', { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { ok: number };
      totals: { calls: number };
      byClient: Record<string, unknown>;
    };
    expect(body.auth.ok).toBe(1);
    expect(body.totals.calls).toBe(0);
    expect(body.byClient).toEqual({});
  });

  it('слишком большое тело отбивается по Content-Length, до чтения потока', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request('/v1/tools/client_overview', {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
        'content-length': String(BOT_MAX_BODY_BYTES + 1),
      },
      body: '{}',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: 'payload_too_large',
        message: `request body exceeds ${BOT_MAX_BODY_BYTES} bytes`,
      },
    });
    // тело даже не разбиралось, инструмент не звался
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
  });

  it('does not register native MCP in the bot profile', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'unknown route' } });
  });

  it('does not register metrics in the bot profile', async () => {
    const res = await createApp(fakeDeps()).request('/metrics', { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'unknown route' } });
  });

  it('cancels a chunked bot REST body as soon as 16 KiB is crossed', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4096));
        if (pulls === 100) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://localhost/v1/tools/client_overview', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await createApp(fakeDeps()).fetch(request);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
  });

  it('потолок тела стоит ЗА гейтом: без токена сначала 401', async () => {
    // Порядок не косметика: неаутентифицированный клиент не должен узнавать по коду
    // ответа, какой у нас потолок тела и есть ли за этим путём вообще ручка.
    const app = createApp(fakeDeps());
    const res = await app.request('/v1/tools/client_overview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('неизвестный маршрут — 404 в едином конверте', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/admin/user/search?text=ivan', { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'unknown route' } });
  });

  it('падение обработчика не выносит наружу ни текста, ни стека', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    app.get('/boom', () => {
      throw new Error(
        'SHM GET https://admin.example.io/shm/v1/admin/user?secret=shm-all-xyz failed',
      );
    });
    // Диагностика уходит в stderr (stdout зарезервирован под JSON-RPC stdio-сервера),
    // а наружу — только код: в тексте исключения бывает URL с секретом shm-all.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: { code: 'error', message: 'internal error' } }));
    expect(body).not.toContain('shm-all');
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
