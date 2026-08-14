import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShmError } from '@hq/shm';
import { SPOOL_SCAN_LIMIT, findSpoolTask, provisioningRepair } from './provisioningRepair.js';
import { callTool, listOf, makeWorld } from './testkit.js';
import type { FakeRoutes, FakeWorld } from './testkit.js';

/**
 * Строка спула ровно в той форме, в какой её отдаёт работающая SHM 2.19.4
 * (снято с работающей системы, а не взято из спеки): `user_service_id` колонкой
 * приходит `null`, а настоящий id услуги лежит в `settings`.
 */
const STUCK = {
  id: 455827,
  user_id: 3073,
  user_service_id: null,
  status: 'STUCK',
  prio: 1,
  delayed: 27,
  created: '2026-08-05 21:59:10',
  executed: '2026-08-05 21:59:24',
  event: { kind: 'Cloud::Vpn', method: 'create', name: 'CREATE', title: 'remnawave create' },
  response: { error: 'remnawave: 502 bad gateway' },
  settings: { user_service_id: 55 },
};

const STRANGERS = [
  { id: 11, status: 'NEW', delayed: 0, settings: {} },
  { id: 12, status: 'NEW', delayed: 0, settings: {} },
];

interface PlanOut {
  status: string;
  plan_id: string;
  before: { id: number; status: string; user_service_id: number | null; delayed: number };
  after: Record<string, unknown>;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  sideEffects: string[];
}

function world(routes: FakeRoutes = {}): FakeWorld {
  return makeWorld({
    shmList: () => listOf([STUCK]),
    shmAction: () => [{ id: STUCK.id, status: 'NEW' }],
    ...routes,
  });
}

async function planOf(w: FakeWorld, args: Record<string, unknown>): Promise<PlanOut> {
  return (await callTool(provisioningRepair(w.deps), args, w)) as unknown as PlanOut;
}

describe('provisioning_repair: план', () => {
  it('находит задачу фильтром по id и показывает её статус до изменения', async () => {
    const w = world();
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    expect(plan.status).toBe('plan');
    expect(plan.before.status).toBe('STUCK');
    // id услуги читается из settings: колонкой SHM его не заполняет.
    expect(plan.before.user_service_id).toBe(55);
    expect(w.calls[0]).toMatchObject({ method: 'LIST', path: '/admin/spool' });
    expect((w.calls[0]?.params as { id?: number } | undefined)?.id).toBe(455827);
    // План — это план: ни одной записи в SHM.
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('retry обещает ровно то, что делает SHM: статус в NEW и задержку в ноль', async () => {
    const w = world();
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    expect(plan.diff).toEqual([
      { path: 'delayed', from: 27, to: 0 },
      { path: 'status', from: 'STUCK', to: 'NEW' },
    ]);
  });

  it('pause двигает только статус — задержку api_pause не трогает', async () => {
    const w = world();
    const plan = await planOf(w, { task_id: 455827, action: 'pause' });

    expect(plan.diff).toEqual([{ path: 'status', from: 'STUCK', to: 'PAUSED' }]);
    expect(plan.sideEffects.join(' ')).toMatch(/PAUSED/);
  });

  it('resume описан как то же самое действие, что retry, а не как соседнее', async () => {
    const w = world();
    const retry = await planOf(w, { task_id: 455827, action: 'retry' });
    const resume = await planOf(world(), { task_id: 455827, action: 'resume' });

    expect(resume.diff).toEqual(retry.diff);
    // И сказано это вслух: инструмент, у которого resume и retry выглядят
    // разными операциями, заставляет оператора выбирать между одинаковым.
    expect(provisioningRepair(w.deps).def.description).toMatch(/один и тот же обработчик/);
  });

  it('говорит про SUCCESS словами и НЕ цитирует запрещённый путь строкой', async () => {
    const w = world();
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    expect(tool.def.description).toMatch(/SUCCESS/);
    expect(plan.sideEffects.join(' ')).toMatch(/SUCCESS/);
    // Скан запрещённых литералов (@hq/registry) обходит tools/ целиком, и путь
    // запрещённой ручки в прозе покраснел бы by construction.
    expect(`${tool.def.description} ${plan.sideEffects.join(' ')}`).not.toContain(
      '/admin/spool/manual/',
    );
  });

  it('предупреждает отдельно, если задача уже числится выполненной', async () => {
    const w = world({ shmList: () => listOf([{ ...STUCK, status: 'SUCCESS' }]) });
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });
    expect(plan.sideEffects.join(' ')).toMatch(/УЖЕ ЧИСЛИТСЯ ВЫПОЛНЕННОЙ/);
  });

  it('отказывает, когда действие ничего не изменит, и объясняет, куда смотреть', async () => {
    const w = world({ shmList: () => listOf([{ ...STUCK, status: 'NEW', delayed: 0 }]) });
    await expect(planOf(w, { task_id: 455827, action: 'retry' })).rejects.toThrow(
      /ничего не изменит/,
    );
    const { records } = await w.deps.audit.search({});
    expect(records.map((r) => r.outcome)).toEqual(['rejected']);
  });
});

describe('provisioning_repair: набор действий закрыт', () => {
  it.each(['success', 'set', 'add', 'delete'])(
    'действие %s не проходит валидацию схемы',
    (action) => {
      const w = makeWorld();
      const parsed = provisioningRepair(w.deps).def.input.safeParse({ task_id: 1, action });
      expect(parsed.success).toBe(false);
    },
  );

  it('подменённый на диске снимок не даёт применить чужое действие', async () => {
    const w = world();
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    // У снимка плана нет ни подписи, ни контрольной суммы (parsePlan проверяет
    // только форму), поэтому запись на диске — настоящая поверхность атаки:
    // единственное, что стоит между ней и произвольной записью в строку спула,
    // это перепроверка действия тем же enum на применении.
    const file = join(w.snapshotDir, `${plan.plan_id}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      after: { op: { action: string } };
    };
    raw.after.op.action = 'set';
    writeFileSync(file, JSON.stringify(raw));

    await expect(
      callTool(tool, { task_id: 455827, action: 'retry', plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/не несёт разрешённого действия/);
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('provisioning_repair: применение', () => {
  it('шлёт POST на литеральный путь действия с телом {id}', async () => {
    const w = world();
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    const applied = (await callTool(
      tool,
      { task_id: 455827, action: 'retry', plan_id: plan.plan_id },
      w,
    )) as { status: string };

    expect(applied.status).toBe('applied');
    const post = w.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/admin/spool/manual/retry');
    expect(post?.body).toEqual({ id: 455827 });
  });

  it.each([
    ['resume', '/admin/spool/manual/resume'],
    ['pause', '/admin/spool/manual/pause'],
  ])('%s уходит на свой собственный путь', async (action, path) => {
    const w = world();
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action });
    await callTool(tool, { task_id: 455827, action, plan_id: plan.plan_id }, w);
    expect(w.calls.find((c) => c.method === 'POST')?.path).toBe(path);
  });

  it('408 (лок строки) повторяется каркасом, задача в итоге применяется', async () => {
    let attempts = 0;
    const w = world({
      shmAction: () => {
        attempts += 1;
        if (attempts < 3) throw new ShmError('service row is locked; HTTP 408: locked', 408, true);
        return [{ id: 455827, status: 'NEW' }];
      },
    });
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });
    const applied = (await callTool(
      tool,
      { task_id: 455827, action: 'retry', plan_id: plan.plan_id },
      w,
    )) as { status: string };

    expect(applied.status).toBe('applied');
    expect(attempts).toBe(3);
  });

  it('задача, успевшая выполниться после построения плана, не ретраится молча', async () => {
    let reads = 0;
    const w = world({
      shmList: () => {
        reads += 1;
        return listOf([reads === 1 ? STUCK : { ...STUCK, status: 'SUCCESS' }]);
      },
    });
    const tool = provisioningRepair(w.deps);
    const plan = await planOf(w, { task_id: 455827, action: 'retry' });

    await expect(
      callTool(tool, { task_id: 455827, action: 'retry', plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось после построения плана/);
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);

    // search отдаёт журнал новыми записями вперёд.
    const { records } = await w.deps.audit.search({});
    expect(records.map((r) => r.outcome)).toEqual(['rejected', 'planned']);
    // Записи `applying` нет: до бэкенда не дошло, и журнал это показывает.
    expect(records.some((r) => r.outcome === 'applying')).toBe(false);
  });
});

describe('findSpoolTask', () => {
  it('не берёт первую попавшуюся задачу, если фильтр по id проигнорирован', async () => {
    const pages = [STRANGERS, STRANGERS, [STUCK]];
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        const page = pages[Math.min(call, pages.length - 1)] ?? [];
        call += 1;
        return listOf(page, 300);
      },
    });

    const task = await findSpoolTask(w.ctx, 455827);
    expect(task.id).toBe(455827);
    // Первый вызов — попытка фильтра, дальше постраничный обход.
    expect(call).toBeGreaterThan(1);
    expect(w.calls.slice(1).every((c) => (c.params as { id?: number }).id === undefined)).toBe(true);
  });

  it('пустой ответ фильтра — это «задачи нет», и подсказка ведёт в spool_inspect', async () => {
    const w = makeWorld({ shmList: () => listOf([]) });
    const promise = findSpoolTask(w.ctx, 999);
    await expect(promise).rejects.toThrow(/не найдена/);
    await expect(promise).rejects.toThrow(/spool_inspect/);
  });

  it('обход ограничен потолком и не листает очередь бесконечно', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return listOf(
          Array.from({ length: 100 }, (_, i) => ({ id: 1000 + call * 100 + i, status: 'NEW' })),
          100_000,
        );
      },
    });

    await expect(findSpoolTask(w.ctx, 455827)).rejects.toThrow(/не найдена/);
    // Одна попытка фильтра плюс страницы до потолка — и ни страницей больше.
    expect(call).toBe(1 + SPOOL_SCAN_LIMIT / 100);
  });
});
