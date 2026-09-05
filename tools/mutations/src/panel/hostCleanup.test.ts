import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemnaError } from '@hq/remna';
import { MAX_CLEANUP_BATCH, hostCleanup } from './hostCleanup.js';
import { callTool, callToolResult, makeWorld, sequence } from '../testkit.js';
import type { FakeRoutes, FakeWorld } from '../testkit.js';

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
function world(hosts = HOSTS, doomed: string[] = [], routes: FakeRoutes = {}): FakeWorld {
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
    ...routes,
  });
}

const cleanup = (w: FakeWorld) => hostCleanup(w.deps, join(w.dir, 'backups'));

describe('host_cleanup — план', () => {
  it('показывает поимённо, что удаляется, сколько и что останется', async () => {
    const w = world();
    const plan = (await callTool(
      cleanup(w),
      { uuids: [ZOMBIE_1, ZOMBIE_2], reason: 'осиротели после сноса HA-CLONE DE' },
      w,
    )) as {
      before: { totalHosts: number; hosts: Array<Record<string, unknown>>; backupRef: { path: string; sha256: string } };
      after: { deleting: number; totalHosts: number; hosts: Array<Record<string, unknown>> };
      rollback?: unknown;
      sideEffects: string[];
    };

    expect(plan.after.deleting).toBe(2);
    expect(plan.before.totalHosts).toBe(5);
    expect(plan.after.totalHosts).toBe(3);
    expect(plan.after.hosts.map((one) => one.uuid)).toEqual([ZOMBIE_1, ZOMBIE_2]);
    expect(plan.after.hosts.every((one) => one.isZombie === true)).toBe(true);
    // Полный снимок для ручного восстановления доступен только в закрытом backup.
    expect(plan.before.hosts[0]).toMatchObject({ uuid: ZOMBIE_1, remark: 'VISPARK leftover 1' });
    expect(plan.before.backupRef).toBeDefined();
    const snapshot = JSON.parse(readFileSync(plan.before.backupRef.path, 'utf8')) as { payload: { hosts: unknown[] } };
    expect(snapshot.payload.hosts).toEqual([HOSTS[0], HOSTS[1]]);
  });

  it('называет необратимость и не притворяется, что откат есть', async () => {
    const w = world();
    const plan = (await callTool(
      cleanup(w),
      { uuids: [ZOMBIE_1], reason: 'зомби после сноса профиля' },
      w,
    )) as { rollback?: unknown; sideEffects: string[] };

    expect(plan.rollback).toBeUndefined();
    expect(plan.sideEffects.join(' ')).toMatch(/НЕОБРАТИМО/);
  });

  it('читает хосты только нередактированным каналом', async () => {
    const w = world();
    await callTool(cleanup(w), { uuids: [ZOMBIE_1], reason: 'зомби панели' }, w);
    const hostReads = w.calls.filter((call) => call.method === 'GET' && call.path === '/api/hosts');
    expect(hostReads.length).toBeGreaterThan(0);
    expect(hostReads.every((call) => call.raw === true)).toBe(true);
  });

  it('рассказывает про мост, но не предлагает его чинить', async () => {
    const w = world();
    const plan = (await callTool(
      cleanup(w),
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
      callTool(cleanup(w), { uuids: [LIVE, LIVE_TWIN], reason: 'чистка Германии' }, w),
    ).rejects.toThrow(/VLESS_DE_IN/);
    expect(w.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('снос ОДНОГО из двух живых хостов проходит: точка входа остаётся', async () => {
    const w = world();
    const plan = (await callTool(
      cleanup(w),
      { uuids: [LIVE], reason: 'дубль адреса, оставляем второй' },
      w,
    )) as { after: { deleting: number } };
    expect(plan.after.deleting).toBe(1);
  });

  it('снос последнего ВЫКЛЮЧЕННОГО хоста разрешён, но карта об этом предупреждает', async () => {
    const w = world();
    const plan = (await callTool(
      cleanup(w),
      { uuids: [DARK], reason: 'страна закрыта полгода назад' },
      w,
    )) as { sideEffects: string[] };
    expect(plan.sideEffects.join(' ')).toMatch(/неотличимы от моста/);
  });

  it('неизвестный uuid валит план целиком — частичного удаления не бывает', async () => {
    const w = world();
    await expect(
      callTool(cleanup(w), { uuids: [ZOMBIE_1, GHOST], reason: 'снос зомби' }, w),
    ).rejects.toThrow(new RegExp(GHOST));
  });

  it('нельзя снести все хосты разом', async () => {
    const w = world();
    await expect(
      callTool(
        cleanup(w),
        { uuids: HOSTS.map((one) => String(one.uuid)), reason: 'снести всё' },
        w,
      ),
    ).rejects.toThrow(/ни одного хоста/);
  });

  it('повтор в списке — отказ: план обязан совпадать со списком удалений', async () => {
    const w = world();
    await expect(
      callTool(cleanup(w), { uuids: [ZOMBIE_1, ZOMBIE_1], reason: 'снос зомби' }, w),
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
      callTool(cleanup(w), { uuids: [ZOMBIE_1], reason: 'снос зомби' }, w),
    ).rejects.toThrow(/ни одной ноды/);
  });

  it('партия ограничена сверху схемой входа', () => {
    const w = world();
    const many = Array.from(
      { length: MAX_CLEANUP_BATCH + 1 },
      (_one, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(cleanup(w).def.input.safeParse({ uuids: many, reason: 'много' }).success).toBe(
      false,
    );
  });
});

describe('host_cleanup — применение', () => {
  it('удаляет поштучно по uuid в ПУТИ и проверяет, что хосты исчезли', async () => {
    const w = world(HOSTS, [ZOMBIE_1, ZOMBIE_2]);
    const tool = cleanup(w);
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
    const tool = cleanup(w);
    const args = { uuids: [ZOMBIE_1, ZOMBIE_2], reason: 'осиротели после сноса профиля' };
    const plan = (await callTool(tool, args, w)) as { plan_id: string };
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(
      new RegExp(`УЖЕ УДАЛЕНЫ[^]*${ZOMBIE_1}`),
    );
  });
});

interface CleanupPlan {
  plan_id: string;
  before: {
    backupRef: { path: string; sha256: string };
    selectedHostsFingerprint: string;
    hosts: Array<Record<string, unknown>>;
  };
  rollback?: unknown;
}

const MAPPER_VALUES = ['mx7Q', 'mm9Z', 'mb8R', 'ms6P'];
const PRIVATE_HOST = host(ZOMBIE_1, I_GONE, {
  isDisabled: true,
  mapper: {
    xrayJson: [{ op: 'set', to: 'arbitrary', value: MAPPER_VALUES[0] }],
    mihomo: [{ op: 'set', to: 'arbitrary', value: MAPPER_VALUES[1] }],
    base64: [{ op: 'set', to: 'arbitrary', value: MAPPER_VALUES[2] }],
    singbox: [{ op: 'set', to: 'arbitrary', value: MAPPER_VALUES[3] }],
  },
  finalMask: { udp: [{ settings: { password: 'cleanup-udp-private' } }] },
  arbitraryNested: { value: 'cleanup-extra-private' },
});
const PRIVATE_HOSTS = [PRIVATE_HOST, ...HOSTS.filter((one) => one.uuid !== ZOMBIE_1)];
const CLEANUP_ARGS = { uuids: [ZOMBIE_1], reason: 'осиротевший хост после удаления профиля' };

describe('host_cleanup — закрытый снимок 3.3.2', () => {
  it('mapper всех форматов и полный raw host существуют только в закрытом backup', async () => {
    const w = world(PRIVATE_HOSTS, [ZOMBIE_1]);
    const tool = cleanup(w);
    const plan = await callTool(tool, CLEANUP_ARGS, w) as CleanupPlan;
    const saved = await w.deps.confirm.peek(plan.plan_id);
    const plannedOutput = JSON.stringify([plan, saved, await w.deps.audit.search()]);
    for (const value of [...MAPPER_VALUES, 'cleanup-udp-private', 'cleanup-extra-private']) expect(plannedOutput).not.toContain(value);
    const ref = plan.before.backupRef;
    expect(ref).toBeDefined();
    expect(plan.before.selectedHostsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.before.hosts[0]).toMatchObject({ uuid: ZOMBIE_1, mapperSummary: { total: 4 } });
    expect(plan.rollback).toBeUndefined();
    const snapshot = JSON.parse(readFileSync(ref.path, 'utf8')) as { kind: string; payload: { hosts: unknown[] } };
    expect(snapshot.kind).toBe('host_cleanup');
    expect(snapshot.payload.hosts).toEqual([PRIVATE_HOST]);
    expect(statSync(ref.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.dir, 'backups')).mode & 0o777).toBe(0o700);
    const result = await callTool(tool, { ...CLEANUP_ARGS, plan_id: plan.plan_id }, w);
    expect(result).toMatchObject({ status: 'applied', result: { deleted: [ZOMBIE_1], backupRef: ref } });
    const exposed = JSON.stringify([plan, saved, result, await w.deps.audit.search()]);
    for (const value of [...MAPPER_VALUES, 'cleanup-udp-private', 'cleanup-extra-private']) {
      expect(exposed).not.toContain(value);
    }
  });

  it.each(['mapper', 'finalMask'])('изменение raw %s после плана запрещает DELETE с устаревшим snapshot', async (field) => {
    let changed = false;
    const w = world(PRIVATE_HOSTS, [], {
      remnaGetRaw: () => ({ response: changed ? [{ ...PRIVATE_HOST, [field]: { changed: 'later-private-value' } }, ...PRIVATE_HOSTS.slice(1)] : PRIVATE_HOSTS }),
    });
    const tool = cleanup(w);
    const plan = await callTool(tool, CLEANUP_ARGS, w) as CleanupPlan;
    changed = true;
    await expect(callTool(tool, { ...CLEANUP_ARGS, plan_id: plan.plan_id }, w)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(JSON.stringify(await w.deps.audit.search())).not.toContain('later-private-value');
  });

  it.each(['missing', 'modified', 'malformed', 'foreign'])('проверяет backup до первого DELETE: %s', async (failure) => {
    const w = world(PRIVATE_HOSTS);
    const tool = cleanup(w);
    const plan = await callTool(tool, CLEANUP_ARGS, w) as CleanupPlan;
    expect(plan.before.backupRef).toBeDefined();
    const path = plan.before.backupRef.path;
    if (failure === 'missing') unlinkSync(path);
    if (failure === 'modified') writeFileSync(path, readFileSync(path, 'utf8').replace('mx7Q', 'different-private-value'));
    if (failure === 'malformed') writeFileSync(path, 'malformed-private-json-fragment');
    if (failure === 'foreign') {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      stored.target = 'different-backup-target';
      writeFileSync(path, JSON.stringify(stored));
    }
    const result = await callToolResult(tool, { ...CLEANUP_ARGS, plan_id: plan.plan_id }, w);
    expect(result.ok).toBe(false);
    expect(w.calls.some((call) => call.method === 'DELETE')).toBe(false);
    const exposed = JSON.stringify([result, await w.deps.audit.search()]);
    for (const value of [...MAPPER_VALUES, 'different-private-value', 'malformed-private-json-fragment']) expect(exposed).not.toContain(value);
  });

  it('план не выдаётся, если закрытый backup записать невозможно', async () => {
    const w = world(PRIVATE_HOSTS);
    const path = join(w.dir, 'backups');
    writeFileSync(path, 'this path is a regular file');
    await expect(callTool(cleanup(w), CLEANUP_ARGS, w)).rejects.toThrow(/backup|снимок|каталог/i);
    expect(w.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('DELETE error сохраняет HTTP статус и сведения о частичном удалении без mapper в audit', async () => {
    const sentinel = 'cleanup-delete-private';
    const w = world(PRIVATE_HOSTS, [], {
      remnaSend: (_method, path) => {
        if (path.endsWith(ZOMBIE_2)) throw new RemnaError(`Remnawave DELETE HTTP 400: {"mapper":{"xrayJson":[{"value":"${sentinel}"}]}}`, 400);
        return { response: true };
      },
    });
    const tool = cleanup(w);
    const args = { ...CLEANUP_ARGS, uuids: [ZOMBIE_1, ZOMBIE_2] };
    const plan = await callTool(tool, args, w) as CleanupPlan;
    const result = await callToolResult(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toContain('400');
    expect(result.message).toMatch(new RegExp(`УЖЕ УДАЛЕНЫ[^]*${ZOMBIE_1}`));
    expect(JSON.stringify([result, await w.deps.audit.search()])).not.toContain(sentinel);
  });
});
