import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Budget } from '@hq/budget';
import { createRegistry } from '@hq/registry';
import type { ToolDef } from '@hq/types';
import { createApp } from './app.js';
import { Metrics } from './metrics.js';
import { AUTH_HEADERS, fakeCtx, FIXED_NOW, TEST_TOKENS } from './testing.js';

function appWithBudget(limit: number): { app: ReturnType<typeof createApp>; metrics: Metrics } {
  const probeTool: ToolDef = {
    name: 'platform_probe',
    description: 'cheap read; budget is taken by the transport, not by the handler',
    input: z.object({}),
    access: 'ro',
    risk: 'none',
    profiles: ['human', 'bot'],
    handler: async () => ({ ok: true }),
  };
  const metrics = new Metrics({ now: FIXED_NOW });
  const app = createApp({
    registry: createRegistry([probeTool]),
    ctx: fakeCtx(),
    budget: new Budget({ limit, windowMs: 60_000, now: FIXED_NOW }),
    tokens: TEST_TOKENS,
    metrics,
    version: 'test',
  });
  return { app, metrics };
}

async function post(app: ReturnType<typeof createApp>, name: string): Promise<Response> {
  return app.request(`/v1/tools/${name}`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
    body: '{}',
  });
}

async function probe(app: ReturnType<typeof createApp>): Promise<Response> {
  return post(app, 'platform_probe');
}

describe('budget denials', () => {
  it('первый вызов проходит, второй отдаёт 429 с Retry-After', async () => {
    const { app } = appWithBudget(1);
    expect((await probe(app)).status).toBe(200);

    const denied = await probe(app);
    expect(denied.status).toBe(429);
    const retryAfter = denied.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    const body = (await denied.json()) as {
      outcome: string;
      error: { code: string; retryAfterMs: number };
    };
    expect(body.outcome).toBe('budget');
    expect(body.error.code).toBe('budget');
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
  });

  it('слот тратится и на перебор несуществующих имён (§6.14, запрет перебора)', async () => {
    const { app } = appWithBudget(1);
    const guess = await post(app, 'no_such_tool');
    expect(guess.status).toBe(404);
    // слот израсходован попыткой перебора, следующий реальный вызов уже отбит
    expect((await probe(app)).status).toBe(429);
  });

  it('ведро ОДНО на процесс: имя инструмента не заводит собственный лимит', async () => {
    // Ключ ведра не должен зависеть от имени: иначе перебор бесплатен (каждое выдуманное
    // имя приходит со своим нетронутым лимитом), а общий потолок §6.14 превращается в
    // «лимит на инструмент», которого никто не заказывал. Тест выше ловит это на двух
    // именах, этот — на трёх подряд, чтобы причина падения читалась без гадания.
    const { app } = appWithBudget(2);
    expect((await post(app, 'first_guess')).status).toBe(404);
    expect((await post(app, 'second_guess')).status).toBe(404);
    expect((await post(app, 'third_guess')).status).toBe(429);
  });

  it('отказ по бюджету неотличим для существующего и выдуманного имени', async () => {
    // 429 берётся ДО обращения к реестру. Иначе исчерпанное ведро стало бы оракулом:
    // «существует» отвечало бы 429, а «не существует» — 404.
    const { app } = appWithBudget(1);
    await probe(app);
    const known = await post(app, 'platform_probe');
    const unknown = await post(app, 'platform_probee');
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    const a = (await known.text()).replaceAll('platform_probe', 'NAME');
    const b = (await unknown.text()).replaceAll('platform_probee', 'NAME');
    expect(a).toBe(b);
  });

  it('отказы по бюджету видны в /metrics отдельным счётчиком', async () => {
    const { app, metrics } = appWithBudget(2);
    await probe(app);
    await probe(app);
    await probe(app);
    await probe(app);

    const snap = metrics.snapshot();
    expect(snap.totals.calls).toBe(4);
    expect(snap.totals.ok).toBe(2);
    expect(snap.totals.budget).toBe(2);
    expect(snap.byTool['platform_probe']?.budget).toBe(2);
    expect(snap.byClient.test?.budget).toBe(2);

    const res = await app.request('/metrics', { headers: AUTH_HEADERS });
    const served = (await res.json()) as { totals: { budget: number } };
    expect(served.totals.budget).toBe(2);
  });

  it('429 остаётся терминальным: повторный вызов снова 429, счётчик не «прощает»', async () => {
    const { app } = appWithBudget(1);
    await probe(app);
    expect((await probe(app)).status).toBe(429);
    expect((await probe(app)).status).toBe(429);
  });

  it('текст отказа не выносит наружу ни URL, ни адресов', async () => {
    const { app } = appWithBudget(1);
    await probe(app);
    const body = await (await probe(app)).text();
    expect(body).not.toMatch(/https?:\/\//);
  });
});
