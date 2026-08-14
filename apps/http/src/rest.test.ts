import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '@hq/registry';
import type { ToolDef } from '@hq/types';
import { createApp, MAX_BODY_BYTES } from './app.js';
import { AUTH_HEADERS, fakeDeps } from './testing.js';

interface ToolListBody {
  profile: string;
  mode: string;
  transport: string;
  tools: Array<{
    name: string;
    description: string;
    access: string;
    risk: string;
    inputSchema: Record<string, unknown>;
  }>;
}

describe('GET /v1/tools', () => {
  it('без токена — 401', async () => {
    const app = createApp(fakeDeps());
    expect((await app.request('/v1/tools')).status).toBe(401);
  });

  it('без токена не видно даже имени чужого инструмента', async () => {
    const app = createApp(fakeDeps());
    const body = await (await app.request('/v1/tools')).text();
    expect(body).not.toContain('client_overview');
    expect(body).not.toContain('sql_query');
  });

  it('отдаёт только инструменты профиля bot, со схемами входа', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/v1/tools', { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ToolListBody;
    expect(body.profile).toBe('bot');
    expect(body.mode).toBe('ro');
    expect(body.transport).toBe('rest-facade');
    expect(body.tools.map((t) => t.name).sort()).toEqual(['client_overview', 'spool_inspect']);
    expect(body.tools.map((t) => t.name)).not.toContain('sql_query');
    const overview = body.tools.find((t) => t.name === 'client_overview');
    expect(overview?.access).toBe('ro');
    expect(overview?.risk).toBe('none');
    expect((overview?.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
  });

  it('список считает listVisibleTools, а не свой фильтр по профилю', async () => {
    // Срез решает ОДНА функция из @hq/exec: mode + profile + probe. Второй фильтр в
    // транспорте разошёлся бы с исполнителем молча — и разошёлся бы именно в сторону
    // «показали то, что вызвать нельзя» (или наоборот).
    const deps = fakeDeps({ ctx: { ...fakeDeps().ctx, profile: 'human' } });
    const app = createApp(deps);
    const body = (await (
      await app.request('/v1/tools', { headers: AUTH_HEADERS })
    ).json()) as ToolListBody;
    expect(body.profile).toBe('human');
    expect(body.tools.map((t) => t.name).sort()).toEqual([
      'client_overview',
      'spool_inspect',
      'sql_query',
    ]);
  });
});

interface CallOkBody {
  tool: string;
  outcome: string;
  data: Record<string, unknown>;
  redaction: { forbiddenKeys: number; scrubbedStrings: number; truncatedLists: number };
  durationMs: number;
}
interface CallErrBody {
  tool: string;
  outcome: string;
  error: { code: string; message: string };
}

async function call(
  app: ReturnType<typeof createApp>,
  name: string,
  body: unknown,
): Promise<Response> {
  return app.request(`/v1/tools/${name}`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/tools/:name', () => {
  it('без токена — 401 и до реестра дело не доходит', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request('/v1/tools/client_overview', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
  });

  it('инструмент чужого профиля — 404, без намёка что он существует', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await call(app, 'sql_query', { sql: 'select 1' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as CallErrBody;
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Tool sql_query not found');
    expect(body.error.message).not.toMatch(/profile|human/i);
    expect(deps.metrics.snapshot().byTool['__unknown__']?.notFound).toBe(1);
  });

  it('несуществующий инструмент — тот же 404 с тем же текстом', async () => {
    const app = createApp(fakeDeps());
    const res = await call(app, 'totally_made_up', {});
    expect(res.status).toBe(404);
    expect(((await res.json()) as CallErrBody).error.message).toBe('Tool totally_made_up not found');
  });

  it('отказ неотличим байт в байт: чужой профиль и несуществующее имя', async () => {
    // Единственный оставшийся способ перебрать реестр — заставить транспорт отличить
    // «есть, но не для тебя» от «нет такого». Совпадать обязаны и статус, и конверт, и
    // длина тела: иначе оракул восстанавливается по любому из трёх.
    const app = createApp(fakeDeps());
    const known = await call(app, 'sql_query', {});
    const unknown = await call(app, 'sql_queryy', {});
    expect(known.status).toBe(unknown.status);
    const a = (await known.text()).replaceAll('sql_query', 'NAME');
    const b = (await unknown.text()).replaceAll('sql_queryy', 'NAME');
    expect(a).toBe(b);
  });

  it('битый вход — 400, в сообщении видно поле', async () => {
    const app = createApp(fakeDeps());
    const res = await call(app, 'client_overview', { query: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as CallErrBody;
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/query/);
  });

  it('невалидный JSON в теле — 400, а не 500', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/v1/tools/client_overview', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as CallErrBody).error.message).toMatch(/valid JSON/i);
  });

  it('битый JSON отвечает одинаково и на существующее, и на выдуманное имя', async () => {
    // Разбор тела идёт ДО обращения к реестру, поэтому этот путь тоже не оракул.
    const app = createApp(fakeDeps());
    const bad = async (name: string): Promise<Response> =>
      app.request(`/v1/tools/${name}`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: '{oops',
      });
    const real = await bad('client_overview');
    const fake = await bad('client_overvieww');
    expect(real.status).toBe(fake.status);
    expect(((await real.json()) as CallErrBody).error.message).toBe(
      ((await fake.json()) as CallErrBody).error.message,
    );
  });

  it('тело сверх потолка отбивается даже без Content-Length', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request('/v1/tools/client_overview', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: `{"query":"${'x'.repeat(MAX_BODY_BYTES)}"}`,
    });
    expect(res.status).toBe(413);
    expect(deps.metrics.snapshot().totals.calls).toBe(0);
  });

  it('успешный вызов — 200 с редакцией клиентского контура и разрезом по клиенту', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await call(app, 'client_overview', { query: '100000001' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CallOkBody;
    expect(body.tool).toBe('client_overview');
    expect(body.outcome).toBe('ok');

    const shm = body.data.shm as Record<string, unknown>;
    const remna = body.data.remna as Record<string, unknown>;
    expect(shm.user_id).toBe(3073);
    expect(shm.balance).toBe(120.5);
    expect(shm.login).toBe('<forbidden:bot>');
    expect(shm.email).toBe('<forbidden:bot>');
    expect(remna.uuid).toBe('a1b2c3d4');
    expect(remna.subscriptionUrl).toBe('<forbidden:bot>');
    expect(remna.shortUuid).toBe('<forbidden:bot>');
    expect(remna.trojanPassword).toBe('<forbidden:bot>');
    expect(body.data.lastIp).toBe('<forbidden:bot>');
    expect(body.data.subLastUserAgent).toBe('<forbidden:bot>');
    expect(body.redaction.forbiddenKeys).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('95.24.11.7');
    expect(raw).not.toContain('sub.example.com');
    expect(raw).not.toContain('p@ssw0rd');
    expect(raw).not.toContain('tg100000001');

    const snap = deps.metrics.snapshot();
    expect(snap.byTool['client_overview']?.ok).toBe(1);
    expect(snap.byClient.test?.ok).toBe(1);
  });

  it('текст ошибки апстрима не выносит наружу URL и параметры запроса', async () => {
    const leaky: ToolDef = {
      name: 'client_overview',
      description: 'fails with a realistic ShmError text',
      input: z.object({ query: z.string() }),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      handler: async () => {
        throw new Error(
          'SHM GET https://billing.example.com/shm/v1/admin/user/search?text=tg100000001&secret=shm-all-xyz failed: 403',
        );
      },
    };
    const app = createApp(fakeDeps({ registry: createRegistry([leaky]) }));
    const res = await call(app, 'client_overview', { query: '100000001' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as CallErrBody;
    expect(body.error.code).toBe('failed');
    expect(body.error.message).not.toContain('billing.example.com');
    expect(body.error.message).not.toContain('shm-all');
    expect(body.error.message).not.toContain('tg100000001');
    expect(body.error.message).toContain('403');
  });

  it('тело ответа бэкенда не доезжает до бота через канал ошибки', async () => {
    // @hq/exec режет всё после маркера «HTTP <код>: » — это единственная причина, по
    // которой бот не может вычитать из текста ошибки строку спула с токеном бота.
    const leaky: ToolDef = {
      name: 'spool_inspect',
      description: 'upstream answers with a body',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      handler: async () => {
        throw new Error(
          'SHM GET /admin/spool failed with HTTP 500: {"bot_token":"1088997701:AAFq7x2Kd0Lm9"}',
        );
      },
    };
    const app = createApp(fakeDeps({ registry: createRegistry([leaky]) }));
    const res = await call(app, 'spool_inspect', {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as CallErrBody;
    expect(body.error.message).not.toContain('AAFq7x2Kd0Lm9');
    expect(body.error.message).not.toContain('bot_token');
  });

  it('пустое тело считается пустым объектом (для схем со значениями по умолчанию)', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/v1/tools/spool_inspect', {
      method: 'POST',
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CallOkBody).data).toEqual({ stuck: 0, failed: 0, items: 0 });
  });
});
