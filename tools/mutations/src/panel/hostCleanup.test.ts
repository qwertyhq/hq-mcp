import { describe, expect, it } from 'vitest';
import { MAX_CLEANUP_BATCH, hostCleanup } from './hostCleanup.js';
import { callTool, makeWorld, sequence } from '../testkit.js';
import type { FakeWorld } from '../testkit.js';

const ZOMBIE_1 = '11111111-1111-4111-8111-111111111111';
const ZOMBIE_2 = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333333';
const LIVE_TWIN = '44444444-4444-4444-8444-444444444444';
const DARK = '55555555-5555-4555-8555-555555555555';
const GHOST = '99999999-9999-4999-8999-999999999999';

const I_LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const I_DARK = 'aaaaaaaa-0000-4000-8000-000000000002';
const I_BRIDGE = 'aaaaaaaa-0000-4000-8000-000000000003';
const I_GONE = 'aaaaaaaa-0000-4000-8000-000000000009';

const host = (
  uuid: string,
  inboundUuid: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  uuid,
  remark: `host ${uuid.slice(0, 4)}`,
  address: 'de.example.io',
  port: 443,
  isDisabled: false,
  inbound: { configProfileUuid: 'p-1', configProfileInboundUuid: inboundUuid },
  ...extra,
});

const HOSTS = [
  host(ZOMBIE_1, I_GONE, { isDisabled: true, remark: 'VISPARK leftover 1' }),
  host(ZOMBIE_2, I_GONE, { isDisabled: true, remark: 'VISPARK leftover 2' }),
  host(LIVE, I_LIVE),
  host(LIVE_TWIN, I_LIVE),
  host(DARK, I_DARK, { isDisabled: true }),
];

/** Нода обслуживает живой инбаунд, погасший инбаунд и МОСТ — у моста хоста нет. */
const NODES = [
  {
    uuid: 'n-de',
    name: 'Germany',
    isConnected: true,
    isDisabled: false,
    configProfile: {
      activeConfigProfileUuid: 'p-1',
      activeInbounds: [
        { uuid: I_LIVE, tag: 'VLESS_DE_IN' },
        { uuid: I_DARK, tag: 'VLESS_DE_OLD' },
        { uuid: I_BRIDGE, tag: 'BRIDGE_DE_IN' },
      ],
    },
  },
];

const PROFILES = {
  total: 1,
  configProfiles: [
    {
      uuid: 'p-1',
      name: 'main',
      inbounds: [
        { uuid: I_LIVE, tag: 'VLESS_DE_IN', type: 'vless' },
        { uuid: I_DARK, tag: 'VLESS_DE_OLD', type: 'vless' },
        { uuid: I_BRIDGE, tag: 'BRIDGE_DE_IN', type: 'vless' },
      ],
    },
  ],
};

/**
 * Чтений хостов ровно два: одно в плане, одно в верификации после удалений
 * (само удаление счётчик не двигает). Полный список отдаётся на первых двух —
 * план и сверка мира, — а после применения возвращается остаток.
 */
function world(hosts = HOSTS, doomed: string[] = []): FakeWorld {
  const left = hosts.filter((one) => !doomed.includes(String(one.uuid)));
  const answers = sequence([hosts, hosts, left]);
  return makeWorld({
    remnaGetRaw: () => ({ response: answers() }),
    remnaGet: (path) => {
      if (path === '/api/nodes') return { response: NODES };
      if (path === '/api/config-profiles') return { response: PROFILES };
      return { response: { total: 0, inbounds: [] } };
    },
    remnaSend: () => ({ response: true }),
  });
}

describe('host_cleanup — план', () => {
  it('показывает поимённо, что удаляется, сколько и что останется', async () => {
    const w = world();
    const plan = (await callTool(
      hostCleanup(w.deps),
      { uuids: [ZOMBIE_1, ZOMBIE_2], reason: 'осиротели после сноса HA-CLONE DE' },
      w,
    )) as {
      before: { totalHosts: number; hosts: Array<Record<string, unknown>> };
      after: { deleting: number; totalHosts: number; hosts: Array<Record<string, unknown>> };
      rollback?: unknown;
      sideEffects: string[];
    };

    expect(plan.after.deleting).toBe(2);
    expect(plan.before.totalHosts).toBe(5);
    expect(plan.after.totalHosts).toBe(3);
    expect(plan.after.hosts.map((one) => one.uuid)).toEqual([ZOMBIE_1, ZOMBIE_2]);
    expect(plan.after.hosts.every((one) => one.isZombie === true)).toBe(true);
    // Снимок полный и нередактированный: восстанавливать больше нечем.
    expect(plan.before.hosts[0]).toMatchObject({ uuid: ZOMBIE_1, remark: 'VISPARK leftover 1' });
  });

  it('называет необратимость и не притворяется, что откат есть', async () => {
    const w = world();
    const plan = (await callTool(
      hostCleanup(w.deps),
      { uuids: [ZOMBIE_1], reason: 'зомби после сноса профиля' },
      w,
    )) as { rollback?: unknown; sideEffects: string[] };

    expect(plan.rollback).toBeUndefined();
    expect(plan.sideEffects.join(' ')).toMatch(/НЕОБРАТИМО/);
  });

  it('читает хосты только нередактированным каналом', async () => {
    const w = world();
    await callTool(hostCleanup(w.deps), { uuids: [ZOMBIE_1], reason: 'зомби панели' }, w);
    const hostReads = w.calls.filter((call) => call.method === 'GET' && call.path === '/api/hosts');
    expect(hostReads.length).toBeGreaterThan(0);
    expect(hostReads.every((call) => call.raw === true)).toBe(true);
  });

  it('рассказывает про мост, но не предлагает его чинить', async () => {
    const w = world();
    const plan = (await callTool(
      hostCleanup(w.deps),
      { uuids: [ZOMBIE_1], reason: 'зомби панели' },
      w,
    )) as { sideEffects: string[] };
    expect(plan.sideEffects.join(' ')).toMatch(/BRIDGE_DE_IN/);
    expect(plan.sideEffects.join(' ')).toMatch(/мосты и релейные хопы/);
  });
});

describe('host_cleanup — отказы', () => {
  it('ОТКАЗ: удаление гасит живую точку входа', async () => {
    const w = world();
    await expect(
      callTool(hostCleanup(w.deps), { uuids: [LIVE, LIVE_TWIN], reason: 'чистка Германии' }, w),
    ).rejects.toThrow(/VLESS_DE_IN/);
    expect(w.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('снос ОДНОГО из двух живых хостов проходит: точка входа остаётся', async () => {
    const w = world();
    const plan = (await callTool(
      hostCleanup(w.deps),
      { uuids: [LIVE], reason: 'дубль адреса, оставляем второй' },
      w,
    )) as { after: { deleting: number } };
    expect(plan.after.deleting).toBe(1);
  });

  it('снос последнего ВЫКЛЮЧЕННОГО хоста разрешён, но карта об этом предупреждает', async () => {
    const w = world();
    const plan = (await callTool(
      hostCleanup(w.deps),
      { uuids: [DARK], reason: 'страна закрыта полгода назад' },
      w,
    )) as { sideEffects: string[] };
    expect(plan.sideEffects.join(' ')).toMatch(/неотличимы от моста/);
  });

  it('неизвестный uuid валит план целиком — частичного удаления не бывает', async () => {
    const w = world();
    await expect(
      callTool(hostCleanup(w.deps), { uuids: [ZOMBIE_1, GHOST], reason: 'снос зомби' }, w),
    ).rejects.toThrow(new RegExp(GHOST));
  });

  it('нельзя снести все хосты разом', async () => {
    const w = world();
    await expect(
      callTool(
        hostCleanup(w.deps),
        { uuids: HOSTS.map((one) => String(one.uuid)), reason: 'снести всё' },
        w,
      ),
    ).rejects.toThrow(/ни одного хоста/);
  });

  it('повтор в списке — отказ: план обязан совпадать со списком удалений', async () => {
    const w = world();
    await expect(
      callTool(hostCleanup(w.deps), { uuids: [ZOMBIE_1, ZOMBIE_1], reason: 'снос зомби' }, w),
    ).rejects.toThrow(/повторы/);
  });

  /**
   * Без листинга нод «этот инбаунд кто-то обслуживает» установить нечем, и
   * проверка «не гаснет ли страна» замолкает — оставаясь на вид пройденной.
   */
  it('пустой листинг нод — план не строится вовсе', async () => {
    const w = makeWorld({
      remnaGetRaw: () => ({ response: HOSTS }),
      remnaGet: (path) => (path === '/api/nodes' ? { response: [] } : { response: { total: 0 } }),
      remnaSend: () => ({ response: true }),
    });
    await expect(
      callTool(hostCleanup(w.deps), { uuids: [ZOMBIE_1], reason: 'снос зомби' }, w),
    ).rejects.toThrow(/ни одной ноды/);
  });

  it('партия ограничена сверху схемой входа', () => {
    const w = world();
    const many = Array.from(
      { length: MAX_CLEANUP_BATCH + 1 },
      (_one, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(hostCleanup(w.deps).def.input.safeParse({ uuids: many, reason: 'много' }).success).toBe(
      false,
    );
  });
});

describe('host_cleanup — применение', () => {
  it('удаляет поштучно по uuid в ПУТИ и проверяет, что хосты исчезли', async () => {
    const w = world(HOSTS, [ZOMBIE_1, ZOMBIE_2]);
    const tool = hostCleanup(w.deps);
    const args = { uuids: [ZOMBIE_1, ZOMBIE_2], reason: 'осиротели после сноса профиля' };
    const plan = (await callTool(tool, args, w)) as { plan_id: string };
    const applied = (await callTool(tool, { ...args, plan_id: plan.plan_id }, w)) as {
      result: { deleted: string[]; stillPresent: string[]; remaining: number; verified: boolean };
    };

    const deletes = w.calls.filter((call) => call.method === 'DELETE');
    expect(deletes.map((call) => call.path)).toEqual([
      `/api/hosts/${ZOMBIE_1}`,
      `/api/hosts/${ZOMBIE_2}`,
    ]);
    expect(applied.result.deleted).toEqual([ZOMBIE_1, ZOMBIE_2]);
    expect(applied.result.stillPresent).toEqual([]);
    expect(applied.result.remaining).toBe(3);
    expect(applied.result.verified).toBe(true);
  });

  it('обрыв на середине называет то, что уже удалено и не вернётся', async () => {
    const w = makeWorld({
      remnaGetRaw: () => ({ response: HOSTS }),
      remnaGet: (path) => {
        if (path === '/api/nodes') return { response: NODES };
        if (path === '/api/config-profiles') return { response: PROFILES };
        return { response: { total: 0, inbounds: [] } };
      },
      remnaSend: (_method, path) => {
        if (String(path).endsWith(ZOMBIE_2)) throw new Error('HTTP 500');
        return { response: true };
      },
    });
    const tool = hostCleanup(w.deps);
    const args = { uuids: [ZOMBIE_1, ZOMBIE_2], reason: 'осиротели после сноса профиля' };
    const plan = (await callTool(tool, args, w)) as { plan_id: string };
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(
      new RegExp(`УЖЕ УДАЛЕНЫ[^]*${ZOMBIE_1}`),
    );
  });
});
