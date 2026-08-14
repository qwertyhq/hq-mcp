import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineMutation, planIdField } from './kit.js';
import type { MutationDeps, MutationTool } from './kit.js';
import { callTool, listOf, makeWorld, planThenApply, sequence } from './testkit.js';

/**
 * Харнесс проверяется отдельно и намеренно.
 *
 * Мутатор, зелёный в харнессе без предохранителей клиента, — это мутатор,
 * который в проде отправляет в панель `trojanPassword: '<redacted>'` и
 * уничтожает учётку клиента. Тесты ниже фиксируют, что заготовленные ответы
 * проходят через ТЕ ЖЕ функции, что и живые: редакция, переименование ключей
 * SHM, гард ложного успеха, запрет §8, отказ на мутирующем GET и нормализацию
 * списка. Каждый из них однажды был причиной аварии, а не гипотезой.
 */

const input = z.object({ value: z.number(), ...planIdField });
type Input = z.infer<typeof input>;

describe('makeWorld: каналы SHM', () => {
  it('get редактирует и переименовывает, getRaw отдаёт живое значение', async () => {
    const row = { id: 3073, uniq_key: 'platega-77', password: 'live-secret', login: 'ivan' };
    const world = makeWorld({ shmGet: () => row });

    const clean = await world.ctx.shm.get<Record<string, unknown>>('/admin/user/3073');
    // uniq_key переименован ДО редакции: он не секрет, но попадает под
    // SECRET_KEY_RE, и починить это после redact уже нечем.
    expect(clean.uniq_id).toBe('platega-77');
    expect(clean.uniq_key).toBeUndefined();
    expect(clean.password).toBe('<redacted>');
    expect(clean.login).toBe('ivan');

    const raw = await world.ctx.shm.getRaw<Record<string, unknown>>('/admin/user/3073');
    expect(raw.uniq_key).toBe('platega-77');
    expect(raw.password).toBe('live-secret');
  });

  it('снимает конверт {data:...} — как настоящий клиент', async () => {
    const world = makeWorld({ shmGet: () => ({ data: { id: 7 } }) });
    expect(await world.ctx.shm.get('/admin/user/7')).toEqual({ id: 7 });
  });

  it('action ловит ложный успех {data:[null]} (§6.1)', async () => {
    const world = makeWorld({ shmAction: () => ({ data: [null] }) });
    await expect(world.ctx.shm.action('POST', '/admin/user/service/change')).rejects.toThrow(
      /falsy data/,
    );
    await expect(world.ctx.shm.sendRaw('POST', '/admin/user/service/change')).rejects.toThrow(
      /falsy data/,
    );
  });

  it('list сохраняет полный total и режет запрошенный предел', async () => {
    const world = makeWorld({ shmList: () => listOf([{ id: 1 }], 4211) });
    const page = await world.ctx.shm.list('/admin/user', { limit: 100000 });
    expect(page.items).toBe(4211);
    expect(page.data).toEqual([{ id: 1 }]);
    // Предел зажат ДО обращения к ручке — как в клиенте (SHM_MAX_LIMIT).
    expect(world.calls[0]?.params).toMatchObject({ limit: 500, offset: 0 });
  });

  it('list отказывает на limit<=0: для админа это дамп всей таблицы', async () => {
    const world = makeWorld({ shmList: () => listOf([]) });
    await expect(world.ctx.shm.list('/admin/user', { limit: 0 })).rejects.toThrow(/no LIMIT/);
  });

  it('§8: запрещённый путь не выполняется ни одним каналом', async () => {
    const world = makeWorld({ shmGet: () => ({}), shmAction: () => ({ ok: 1 }) });
    const identity = '/admin/server/identity';
    await expect(world.ctx.shm.get(identity)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.shm.getRaw(identity)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.shm.action('POST', identity)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.shm.sendRaw('POST', identity)).rejects.toThrow(/forbidden/);
  });

  it('§6.15: мутирующий GET отвергается и в get, и в getRaw', async () => {
    const world = makeWorld({ shmGet: () => ({ ok: 1 }) });
    await expect(world.ctx.shm.get('/promo/apply/HQ2026')).rejects.toThrow(/mutates state/);
    await expect(world.ctx.shm.getRaw('/promo/apply/HQ2026')).rejects.toThrow(/mutates state/);
  });

  it('правило, сужённое по методу, оставляет соседа того же пути открытым', async () => {
    const world = makeWorld({ shmList: () => listOf([{ id: 1 }]), shmAction: () => ({ ok: 1 }) });
    await expect(world.ctx.shm.list('/admin/user/pay')).resolves.toBeDefined();
    await expect(world.ctx.shm.action('DELETE', '/admin/user/pay/1')).rejects.toThrow(/forbidden/);
  });
});

describe('makeWorld: каналы панели', () => {
  it('get маскирует креды, getRaw их сохраняет — на этом ломается read-merge-write', async () => {
    const host = { uuid: 'h-1', trojanPassword: 'live-trojan', remark: 'DE-1' };
    const world = makeWorld({ remnaGet: () => host, remnaSend: (_m, _p, body) => body });

    const viaGet = await world.ctx.remna.get<Record<string, unknown>>('/api/hosts/h-1');
    expect(viaGet.trojanPassword).toBe('<redacted>');

    const viaRaw = await world.ctx.remna.getRaw<Record<string, unknown>>('/api/hosts/h-1');
    expect(viaRaw.trojanPassword).toBe('live-trojan');

    // Тело, собранное из get(), уничтожает учётку — харнесс обязан это ПОКАЗАТЬ,
    // а не сгладить.
    const patched = await world.ctx.remna.sendRaw<Record<string, unknown>>(
      'PATCH',
      '/api/hosts',
      { ...viaGet, remark: 'DE-2' },
    );
    expect(patched.trojanPassword).toBe('<redacted>');
    expect(world.calls.at(-1)?.body).toMatchObject({ trojanPassword: '<redacted>' });
  });

  it('снимает конверт {response:...}', async () => {
    const world = makeWorld({ remnaGet: () => ({ response: { uuid: 'h-1' } }) });
    expect(await world.ctx.remna.get('/api/hosts/h-1')).toEqual({ uuid: 'h-1' });
  });

  it('§8: запрещённый маршрут панели закрыт во всех каналах', async () => {
    const world = makeWorld({ remnaGet: () => ({}), remnaSend: () => ({}) });
    const tokens = '/api/tokens';
    await expect(world.ctx.remna.get(tokens)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.remna.getRaw(tokens)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.remna.send('POST', tokens)).rejects.toThrow(/forbidden/);
    await expect(world.ctx.remna.sendRaw('POST', tokens)).rejects.toThrow(/forbidden/);
  });
});

describe('makeWorld: профиль и контекст', () => {
  it('профиль bot маскирует PII, human — нет', async () => {
    const row = { id: 1, email: 'client@example.com' };
    const human = makeWorld({ shmGet: () => row });
    const bot = makeWorld({ shmGet: () => row }, { profile: 'bot' });
    expect((await human.ctx.shm.get<{ email: string }>('/admin/user/1')).email).toBe(
      'client@example.com',
    );
    expect((await bot.ctx.shm.get<{ email: string }>('/admin/user/1')).email).toBe('<redacted>');
  });

  it('5.11: контекст полон — есть shmTz и probe', () => {
    const world = makeWorld();
    expect(world.ctx.shmTz).toBe('Europe/Moscow');
    expect(world.ctx.probe.get()).toBeNull();
    expect(makeWorld({}, { shmTz: 'UTC' }).ctx.shmTz).toBe('UTC');
  });
});

describe('вспомогательные функции харнесса', () => {
  it('sequence отдаёт ответы по порядку и залипает на последнем', () => {
    const next = sequence([1, 2]);
    expect([next(), next(), next()]).toEqual([1, 2, 2]);
  });

  it('listOf строит ответ списочной ручки с полным total', () => {
    expect(listOf([{ id: 1 }], 900)).toEqual({ items: 900, limit: 25, offset: 0, data: [{ id: 1 }] });
  });
});

describe('planThenApply', () => {
  function tool(deps: MutationDeps, applied: unknown[]): MutationTool {
    return defineMutation<Input>(
      {
        name: 'demo_mutate',
        description: 'demo',
        input,
        risk: 'low',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        guard: { keys: ['value'], read: async () => ({ value: 1 }) },
        plan: async (i) => ({
          before: { value: 1 },
          after: { value: i.value },
          diff: [{ path: 'value', from: 1, to: i.value }],
          sideEffects: [],
        }),
        apply: async (plan) => {
          applied.push(plan.after);
          return { ok: true };
        },
      },
      deps,
    );
  }

  it('строит план и применяет его тем же вызовом', async () => {
    const world = makeWorld();
    const applied: unknown[] = [];
    const res = (await planThenApply(tool(world.deps, applied), { value: 5 }, world)) as {
      status: string;
    };
    expect(res.status).toBe('applied');
    expect(applied).toEqual([{ value: 5 }]);
  });

  it('второй раз тот же plan_id не применяется: план одноразовый', async () => {
    const world = makeWorld();
    const applied: unknown[] = [];
    const demo = tool(world.deps, applied);
    const plan = (await callTool(demo, { value: 5 }, world)) as { plan_id: string };
    await callTool(demo, { value: 5, plan_id: plan.plan_id }, world);
    await expect(callTool(demo, { value: 5, plan_id: plan.plan_id }, world)).rejects.toThrow(
      /не найден|использован/,
    );
    expect(applied).toHaveLength(1);
  });
});
