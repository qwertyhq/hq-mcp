import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeExpireAt, subscriptionOps } from './subscriptionOps.js';
import { callTool, makeWorld } from './testkit.js';
import type { FakeRoutes, FakeWorld } from './testkit.js';

const USER_ID = 18171;

/**
 * Пользователь ровно в той форме, в какой его отдаёт работающая панель 3.2.3:
 * ЧИСЛОВОЙ `id`, поля `uuid` нет вовсе, счётчик
 * трафика — внутри `userTraffic`.
 */
const USER = {
  id: USER_ID,
  username: 'client-3073',
  status: 'ACTIVE',
  expireAt: '2026-09-01T00:00:00.000Z',
  trafficLimitBytes: 53_687_091_200,
  trafficLimitStrategy: 'MONTH',
  hwidDeviceLimit: 5,
  subRevokedAt: null,
  shortUuid: 'abcdefghijklmnopqrst',
  subscriptionUrl: 'https://sub.example.io/abcdefghijklmnopqrst',
  trojanPassword: 'live-trojan-password',
  ssPassword: 'live-ss-password',
  vlessUuid: '11111111-2222-3333-4444-555555555555',
  userTraffic: { usedTrafficBytes: 1_000_000 },
};

const DEVICES = {
  total: 2,
  devices: [
    { hwid: 'HW-A', platform: 'ios', deviceModel: 'iPhone', updatedAt: '2026-08-10T00:00:00.000Z' },
    { hwid: 'HW-B', platform: 'android', deviceModel: 'Pixel', updatedAt: '2026-08-11T00:00:00.000Z' },
  ],
};

interface PlanOut {
  status: string;
  plan_id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  sideEffects: string[];
}

function world(user: Record<string, unknown> = {}, routes: FakeRoutes = {}): FakeWorld {
  return makeWorld({
    remnaGet: (path) => (path.startsWith('/api/hwid/') ? DEVICES : { ...USER, ...user }),
    remnaSend: (_method, path) =>
      path.startsWith('/api/hwid/') ? { total: 0, devices: [] } : { ...USER, ...user },
    ...routes,
  });
}

async function planOf(w: FakeWorld, args: Record<string, unknown>): Promise<PlanOut> {
  return (await callTool(subscriptionOps(w.deps), args, w)) as unknown as PlanOut;
}

async function apply(w: FakeWorld, args: Record<string, unknown>): Promise<unknown> {
  const plan = await planOf(w, args);
  return callTool(subscriptionOps(w.deps), { ...args, plan_id: plan.plan_id }, w);
}

describe('computeExpireAt', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');

  it('продлевает от текущей даты окончания, пока она в будущем', () => {
    expect(computeExpireAt('2026-09-01T00:00:00.000Z', 30, now)).toBe('2026-10-01T00:00:00.000Z');
  });

  it('продлевает от «сейчас», если срок уже истёк или даты нет', () => {
    expect(computeExpireAt('2026-01-01T00:00:00.000Z', 1, now)).toBe('2026-08-14T12:00:00.000Z');
    expect(computeExpireAt(null, 1, now)).toBe('2026-08-14T12:00:00.000Z');
  });
});

describe('subscription_ops: три механизма, а не один', () => {
  it('действия идут на путь с числовым id и без тела', async () => {
    const w = world({ status: 'DISABLED' });
    await apply(w, { user_id: USER_ID, action: 'enable' });

    const post = w.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/api/users/${USER_ID}/actions/enable`);
    expect(post?.body).toBeUndefined();
  });

  it('extend — тоже действие панели: POST …/actions/extend с телом {days}, дату считает панель', async () => {
    const w = world();
    await apply(w, { user_id: USER_ID, action: 'extend', days: 30 });

    const post = w.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/api/users/${USER_ID}/actions/extend`);
    expect(post?.body).toEqual({ days: 30 });
    // Ни одного обновления пользователя: считать дату руками и слать её PATCH-ем не надо.
    expect(w.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('лимиты — не действие: PATCH /api/users, id В ТЕЛЕ, и ничего сверх названных полей', async () => {
    const w = world();
    await apply(w, {
      user_id: USER_ID,
      action: 'set_limits',
      traffic_limit_bytes: 0,
      hwid_device_limit: 3,
    });

    const patch = w.calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/api/users');
    expect(patch?.body).toEqual({ id: USER_ID, trafficLimitBytes: 0, hwidDeviceLimit: 3 });
    expect(JSON.stringify(patch?.body)).not.toContain('status');
  });

  it('устройства — другой контроллер, и тело называет userId, а не uuid', async () => {
    const w = world();
    await apply(w, { user_id: USER_ID, action: 'devices_clear' });
    const clear = w.calls.filter((c) => c.method === 'POST').at(-1);
    expect(clear?.path).toBe('/api/hwid/devices/delete-all');
    expect(clear?.body).toEqual({ userId: USER_ID });

    const w2 = world();
    await apply(w2, { user_id: USER_ID, action: 'device_delete', hwid: 'HW-B' });
    const one = w2.calls.filter((c) => c.method === 'POST').at(-1);
    expect(one?.path).toBe('/api/hwid/devices/delete');
    expect(one?.body).toEqual({ userId: USER_ID, hwid: 'HW-B' });
  });
});

describe('subscription_ops: план', () => {
  it('extend меняет только дату и говорит, что отключённого клиента это не включит', async () => {
    const w = world({ status: 'DISABLED' });
    const plan = await planOf(w, { user_id: USER_ID, action: 'extend', days: 30 });

    expect(plan.diff).toEqual([
      { path: 'expireAt', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    ]);
    expect(plan.sideEffects.join(' ')).toMatch(/Статус DISABLED панель НЕ меняет/);
  });

  it('extend по истёкшему клиенту предупреждает, что панель сама вернёт его в ACTIVE', async () => {
    const w = world({ status: 'EXPIRED', expireAt: '2026-01-01T00:00:00.000Z' });
    const plan = await planOf(w, { user_id: USER_ID, action: 'extend', days: 7 });

    expect(plan.diff.map((d) => d.path).sort()).toEqual(['expireAt', 'status']);
    expect(plan.sideEffects.join(' ')).toMatch(/EXPIRED станет ACTIVE/);
  });

  it('reset_traffic по клиенту LIMITED показывает, что статус тоже изменится', async () => {
    const w = world({ status: 'LIMITED' });
    const plan = await planOf(w, { user_id: USER_ID, action: 'reset_traffic' });

    expect(plan.diff.map((d) => d.path).sort()).toEqual(['status', 'usedTrafficBytes']);
    expect(plan.sideEffects.join(' ')).toMatch(/LIMITED станет ACTIVE/);
  });

  it('поднятый лимит трафика клиенту LIMITED — тоже включение, и план это показывает', async () => {
    const w = world({ status: 'LIMITED' });
    const plan = await planOf(w, {
      user_id: USER_ID,
      action: 'set_limits',
      traffic_limit_bytes: 0,
    });
    expect(plan.diff.map((d) => d.path).sort()).toEqual(['status', 'trafficLimitBytes']);
    expect(plan.sideEffects.join(' ')).toMatch(/LIMITED станет ACTIVE/);
  });

  it('devices_clear показывает, что именно будет отвязано', async () => {
    const w = world();
    const plan = await planOf(w, { user_id: USER_ID, action: 'devices_clear' });

    expect(plan.before.deviceHwids).toEqual(['HW-A', 'HW-B']);
    expect(plan.after.deviceHwids).toEqual([]);
    expect(plan.sideEffects.join(' ')).toMatch(/ВСЕ 2 устройств/);
  });

  it('план не трогает панель ни одним методом записи', async () => {
    const w = world();
    await planOf(w, { user_id: USER_ID, action: 'revoke' });
    expect(w.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('во всех ветках сказано, что биллинг SHM об этой правке не узнает', async () => {
    const w = world();
    const plan = await planOf(w, { user_id: USER_ID, action: 'reset_traffic' });
    expect(plan.sideEffects.join(' ')).toMatch(/Биллинг SHM о ней не узнает/);
  });
});

describe('subscription_ops: отказы на плане', () => {
  it.each([
    [{ action: 'enable' }, /уже ACTIVE/],
    [{ action: 'disable', user: { status: 'DISABLED' } }, /уже DISABLED/],
    [{ action: 'extend' }, /extend требует days/],
    [{ action: 'set_limits' }, /хотя бы одно из/],
    [{ action: 'device_delete' }, /device_delete требует hwid/],
    [{ action: 'device_delete', hwid: 'HW-ZZZ' }, /устройства HW-ZZZ .* сейчас нет/],
    [{ action: 'reset_traffic', user: { userTraffic: { usedTrafficBytes: 0 } } }, /обнулять нечего/],
    [
      { action: 'set_limits', expire_at: '2020-01-01T00:00:00.000Z' },
      /в прошлом — панель отвергает/,
    ],
  ])('%o отбивается на плане', async (args, pattern) => {
    const { user, ...rest } = args as { user?: Record<string, unknown> } & Record<string, unknown>;
    const w = world(user ?? {});
    await expect(planOf(w, { user_id: USER_ID, ...rest })).rejects.toThrow(pattern);

    const { records } = await w.deps.audit.search({});
    expect(records.map((r) => r.outcome)).toEqual(['rejected']);
    expect(w.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('несуществующий клиент — это ответ панели, а не пустой успех', async () => {
    const w = makeWorld({ remnaGet: () => null });
    await expect(planOf(w, { user_id: 999_999_999, action: 'enable' })).rejects.toThrow(
      /в панели нет/,
    );
  });

  it('uuid вместо числового id не проходит валидацию схемы', () => {
    const w = makeWorld();
    const parsed = subscriptionOps(w.deps).def.input.safeParse({
      user_id: '11111111-2222-3333-4444-555555555555',
      action: 'enable',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('subscription_ops: revoke', () => {
  it('не выдаёт новую ссылку ни в каком виде и говорит, где её взять', async () => {
    const w = world();
    const applied = (await apply(w, { user_id: USER_ID, action: 'revoke' })) as {
      result: { note: string; user: Record<string, unknown> };
    };

    expect(applied.result.note).toMatch(/заберите её в панели/i);
    // Ни ссылки, ни её обломков — и ни одного нередактированного канала.
    const serialized = JSON.stringify(applied);
    expect(serialized).not.toContain('sub.example.io');
    expect(serialized).not.toContain('abcdefghijklmnopqrst');
    expect(w.calls.some((c) => c.raw === true)).toBe(false);
  });

  it('в ответ не утекают перевыпущенные креды', async () => {
    const w = world();
    const applied = await apply(w, { user_id: USER_ID, action: 'revoke' });
    const serialized = JSON.stringify(applied);
    expect(serialized).not.toContain('live-trojan-password');
    expect(serialized).not.toContain('live-ss-password');
  });

  it('журнал мутаций тоже не хранит перевыпущенные креды открытым текстом', async () => {
    const w = world();
    await apply(w, { user_id: USER_ID, action: 'revoke' });
    const written = readFileSync(w.auditPath, 'utf8');
    expect(written).not.toContain('live-trojan-password');
    expect(written).not.toContain('live-ss-password');
    expect(written).toContain('"outcome":"applied"');
  });

  it('тело перевыпуска называет revokeOnlyPasswords явно', async () => {
    const w = world();
    await apply(w, { user_id: USER_ID, action: 'revoke' });
    const post = w.calls.find((c) => c.path.endsWith('/actions/revoke'));
    expect(post?.body).toEqual({ revokeOnlyPasswords: false });
  });
});

describe('subscription_ops: сверка мира и снимок плана', () => {
  it('уехавший статус между планом и применением — отказ, а не повторное применение', async () => {
    let reads = 0;
    const w = world(
      {},
      {
        remnaGet: (path) => {
          if (path.startsWith('/api/hwid/')) return DEVICES;
          reads += 1;
          return reads === 1 ? USER : { ...USER, status: 'DISABLED' };
        },
      },
    );
    const tool = subscriptionOps(w.deps);
    const plan = await planOf(w, { user_id: USER_ID, action: 'reset_traffic' });

    await expect(
      callTool(tool, { user_id: USER_ID, action: 'reset_traffic', plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось после построения плана/);
    expect(w.calls.filter((c) => c.method === 'POST')).toEqual([]);
    const { records } = await w.deps.audit.search({});
    expect(records.map((r) => r.outcome)).toEqual(['rejected', 'planned']);
  });

  it('подмена устройства между планом и применением ловится, хотя количество то же', async () => {
    let reads = 0;
    const w = world(
      {},
      {
        remnaGet: (path) => {
          if (!path.startsWith('/api/hwid/')) return USER;
          reads += 1;
          return reads === 1
            ? DEVICES
            : { total: 2, devices: [DEVICES.devices[0], { hwid: 'HW-C' }] };
        },
      },
    );
    const tool = subscriptionOps(w.deps);
    const plan = await planOf(w, { user_id: USER_ID, action: 'device_delete', hwid: 'HW-B' });

    await expect(
      callTool(
        tool,
        { user_id: USER_ID, action: 'device_delete', hwid: 'HW-B', plan_id: plan.plan_id },
        w,
      ),
    ).rejects.toThrow(/deviceHwids/);
    expect(w.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('счётчик трафика, выросший за время жизни плана, планом не считается уехавшим миром', async () => {
    let reads = 0;
    const w = world(
      {},
      {
        remnaGet: () => {
          reads += 1;
          return {
            ...USER,
            status: 'LIMITED',
            userTraffic: { usedTrafficBytes: 1_000_000 + reads },
          };
        },
      },
    );
    const applied = (await apply(w, { user_id: USER_ID, action: 'reset_traffic' })) as {
      status: string;
    };
    expect(applied.status).toBe('applied');
  });

  it('подменённый на диске снимок не даёт отправить в панель чужое поле', async () => {
    const w = world();
    const tool = subscriptionOps(w.deps);
    const plan = await planOf(w, {
      user_id: USER_ID,
      action: 'set_limits',
      hwid_device_limit: 3,
    });

    // У снимка нет ни подписи, ни контрольной суммы: единственное, что стоит
    // между записью на диске и телом PATCH, — перепроверка strictObject.
    const file = join(w.snapshotDir, `${plan.plan_id}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      after: { op: { patch: Record<string, unknown> } };
    };
    raw.after.op.patch.activeInternalSquads = [];
    writeFileSync(file, JSON.stringify(raw));

    await expect(
      callTool(
        tool,
        { user_id: USER_ID, action: 'set_limits', hwid_device_limit: 3, plan_id: plan.plan_id },
        w,
      ),
    ).rejects.toThrow(/не несёт разрешённой операции/);
    expect(w.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
