import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nodeManage } from './nodeManage.js';
import { defineMutation, planIdField } from '../kit.js';
import { callTool, makeWorld, planThenApply } from '../testkit.js';
import type { FakeWorld } from '../testkit.js';

const DE = 'dc287b03-9bb7-48f5-b3e5-62aed2fa02c8';
const NL = 'ffc95fbd-7c12-4a13-84a3-9bac37466ceb';
const OFF = 'aaaaaaaa-1111-4111-8111-111111111111';
const BARE = 'bbbbbbbb-2222-4222-8222-222222222222';
const GHOST = 'cccccccc-3333-4333-8333-333333333333';

const PROFILE = 'd73e2561-43f2-4a30-97ca-8f8cd317499f';
const INBOUND = 'eeeeeeee-0000-4000-8000-000000000001';
const OTHER_INBOUND = 'eeeeeeee-0000-4000-8000-000000000002';

const node = (
  uuid: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  uuid,
  name,
  address: `${name.toLowerCase()}.example.io`,
  port: 2222,
  countryCode: 'DE',
  isDisabled: false,
  isConnected: true,
  isConnecting: false,
  usersOnline: 180,
  xrayUptime: 98_000,
  trafficUsedBytes: 4_000_000,
  trafficLimitBytes: 0,
  isTrafficTrackingActive: false,
  trafficResetDay: null,
  notifyPercent: null,
  consumptionMultiplier: 1,
  nodeConsumptionMultiplier: 1,
  note: null,
  tags: [],
  configProfile: {
    activeConfigProfileUuid: PROFILE,
    activeInbounds: [{ uuid: INBOUND, tag: 'VLESS_DE_IN' }],
  },
  ...extra,
});

const NODES = [
  node(DE, 'Germany'),
  node(NL, 'Netherlands', { usersOnline: 217 }),
  node(OFF, 'Spare', { isDisabled: true, isConnected: false, usersOnline: 0 }),
  // Нода без профиля: панель на «включить» ответит успехом и оставит её выключенной.
  node(BARE, 'Bare', {
    isDisabled: true,
    isConnected: false,
    usersOnline: 0,
    configProfile: { activeConfigProfileUuid: null, activeInbounds: [] },
  }),
];

const PROFILES = {
  total: 1,
  configProfiles: [
    {
      uuid: PROFILE,
      name: 'main',
      inbounds: [
        { uuid: INBOUND, tag: 'VLESS_DE_IN', type: 'vless' },
        { uuid: OTHER_INBOUND, tag: 'VLESS_DE_ALT', type: 'vless' },
      ],
    },
  ],
};

function world(nodes = NODES): FakeWorld {
  return makeWorld({
    remnaGet: (path) => {
      if (path === '/api/nodes') return { response: nodes };
      if (path === '/api/config-profiles') return { response: PROFILES };
      return { response: [] };
    },
    remnaSend: (_method, path, body) => {
      if (String(path) === '/api/nodes') {
        return { response: { ...node(DE, 'Germany'), ...(body as Record<string, unknown>) } };
      }
      return { response: node(DE, 'Germany') };
    },
  });
}

describe('node_manage — disable', () => {
  it('план называет число клиентов, которые оборвутся, и кто останется в строю', async () => {
    const w = world();
    const plan = (await callTool(nodeManage(w.deps), { action: 'disable', uuid: DE }, w)) as {
      before: Record<string, unknown>;
      sideEffects: string[];
    };
    expect(plan.before).toMatchObject({ name: 'Germany', usersOnline: 180, isDisabled: false });
    expect(plan.sideEffects.join(' ')).toMatch(/180 подключённых клиентов/);
    expect(plan.sideEffects.join(' ')).toMatch(/Netherlands/);
  });

  it('ОТКАЗ: гасить последнюю живую ноду парка нельзя', async () => {
    const w = world([node(DE, 'Germany'), NODES[2] as Record<string, unknown>]);
    await expect(
      callTool(nodeManage(w.deps), { action: 'disable', uuid: DE }, w),
    ).rejects.toThrow(/последняя включённая и подключённая нода/);
  });

  it('уже выключенную не выключают повторно', async () => {
    const w = world();
    await expect(
      callTool(nodeManage(w.deps), { action: 'disable', uuid: OFF }, w),
    ).rejects.toThrow(/уже выключена/);
  });

  it('применение шлёт POST на путь с uuid', async () => {
    const w = world();
    await planThenApply(nodeManage(w.deps), { action: 'disable', uuid: DE }, w);
    const sent = w.calls.find((call) => call.method === 'POST');
    expect(sent?.path).toBe(`/api/nodes/${DE}/actions/disable`);
    expect(sent?.body).toBeUndefined();
  });
});

describe('node_manage — enable', () => {
  it('ОТКАЗ: у ноды нет профиля — панель ответила бы успехом и оставила её выключенной', async () => {
    const w = world();
    await expect(callTool(nodeManage(w.deps), { action: 'enable', uuid: BARE }, w)).rejects.toThrow(
      /ОСТАВИТ ноду выключенной/,
    );
  });

  it('выключенную ноду с профилем включает', async () => {
    const w = world();
    const plan = (await callTool(nodeManage(w.deps), { action: 'enable', uuid: OFF }, w)) as {
      diff: Array<{ path: string; from: unknown; to: unknown }>;
    };
    expect(plan.diff).toEqual([{ path: 'isDisabled', from: true, to: false }]);
  });

  it('уже включённую не включают повторно', async () => {
    const w = world();
    await expect(callTool(nodeManage(w.deps), { action: 'enable', uuid: DE }, w)).rejects.toThrow(
      /уже включена/,
    );
  });
});

describe('node_manage — restart', () => {
  it('без force_restart план не строится: панель объявила поле обязательным', async () => {
    const w = world();
    await expect(callTool(nodeManage(w.deps), { action: 'restart', uuid: DE }, w)).rejects.toThrow(
      /force_restart/,
    );
  });

  it('выключенную ноду не перезапускают: панель ответит NODE_IS_DISABLED', async () => {
    const w = world();
    await expect(
      callTool(nodeManage(w.deps), { action: 'restart', uuid: OFF, force_restart: false }, w),
    ).rejects.toThrow(/NODE_IS_DISABLED/);
  });

  it('тело несёт forceRestart явно', async () => {
    const w = world();
    await planThenApply(
      nodeManage(w.deps),
      { action: 'restart', uuid: DE, force_restart: true },
      w,
    );
    const sent = w.calls.find((call) => call.method === 'POST');
    expect(sent?.path).toBe(`/api/nodes/${DE}/actions/restart`);
    expect(sent?.body).toEqual({ forceRestart: true });
  });
});

describe('node_manage — reset_traffic', () => {
  it('называет необратимость и не трогает трафик клиентов', async () => {
    const w = world();
    const plan = (await callTool(nodeManage(w.deps), { action: 'reset_traffic', uuid: DE }, w)) as {
      sideEffects: string[];
    };
    expect(plan.sideEffects.join(' ')).toMatch(/НЕОБРАТИМО/);
    expect(plan.sideEffects.join(' ')).toMatch(/Трафик клиентов не трогается/);
  });

  it('нулевой счётчик обнулять нечего', async () => {
    const w = world([node(DE, 'Germany', { trafficUsedBytes: 0 }), NODES[1] as Record<string, unknown>]);
    await expect(
      callTool(nodeManage(w.deps), { action: 'reset_traffic', uuid: DE }, w),
    ).rejects.toThrow(/уже нулевой/);
  });
});

describe('node_manage — update', () => {
  it('предупреждает, что правка включённой ноды перезапускает на ней xray', async () => {
    const w = world();
    const plan = (await callTool(
      nodeManage(w.deps),
      { action: 'update', uuid: DE, name: 'Germany 2' },
      w,
    )) as { sideEffects: string[] };
    expect(plan.sideEffects.join(' ')).toMatch(/ПЕРЕЗАПУСТИТ на ней xray/);
    expect(plan.sideEffects.join(' ')).toMatch(/180 подключённых клиентов/);
  });

  it('uuid едет В ТЕЛЕ PATCH /api/nodes, булево — явно', async () => {
    const w = world();
    await planThenApply(
      nodeManage(w.deps),
      { action: 'update', uuid: DE, name: 'Germany 2' },
      w,
    );
    const patch = w.calls.find((call) => call.method === 'PATCH');
    expect(patch?.path).toBe('/api/nodes');
    expect(patch?.body).toEqual({
      uuid: DE,
      isTrafficTrackingActive: false,
      name: 'Germany 2',
    });
  });

  it('пустая правка планом не становится', async () => {
    const w = world();
    await expect(
      callTool(nodeManage(w.deps), { action: 'update', uuid: DE }, w),
    ).rejects.toThrow(/update требует хотя бы одно поле/);
  });

  it('смена множителя списания названа отдельно', async () => {
    const w = world();
    const plan = (await callTool(
      nodeManage(w.deps),
      { action: 'update', uuid: DE, consumption_multiplier: 2 },
      w,
    )) as { sideEffects: string[] };
    expect(plan.sideEffects.join(' ')).toMatch(/каждый клиент на этой ноде/);
  });
});

describe('node_manage — create', () => {
  it('заводит ноду и честно говорит, что она не подключится без сертификата', async () => {
    const w = world();
    const plan = (await callTool(
      nodeManage(w.deps),
      {
        action: 'create',
        name: 'Sweden',
        address: 'se.example.io',
        country_code: 'se',
        config_profile_uuid: PROFILE,
        active_inbound_uuids: [INBOUND],
      },
      w,
    )) as { sideEffects: string[]; after: Record<string, unknown> };

    expect(plan.after).toMatchObject({ name: 'Sweden', countryCode: 'SE', exists: true });
    expect(plan.sideEffects.join(' ')).toMatch(/remnanode/);
    expect(plan.sideEffects.join(' ')).toMatch(/приватный ключ/);
  });

  it('тело POST не несёт ключевого материала и uuid', async () => {
    const w = world();
    const args = {
      action: 'create',
      name: 'Sweden',
      address: 'se.example.io',
      config_profile_uuid: PROFILE,
      active_inbound_uuids: [INBOUND],
    };
    await planThenApply(nodeManage(w.deps), args, w);
    const post = w.calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/api/nodes');
    expect(post?.body).toEqual({
      name: 'Sweden',
      address: 'se.example.io',
      countryCode: 'XX',
      configProfile: { activeConfigProfileUuid: PROFILE, activeInbounds: [INBOUND] },
    });
  });

  it('ни один вызов не идёт в /api/keygen', async () => {
    const w = world();
    const args = {
      action: 'create',
      name: 'Sweden',
      address: 'se.example.io',
      config_profile_uuid: PROFILE,
      active_inbound_uuids: [INBOUND],
    };
    await planThenApply(nodeManage(w.deps), args, w);
    expect(w.calls.every((call) => !call.path.includes('keygen'))).toBe(true);
  });

  it('чужой инбаунд отбивается до панели', async () => {
    const w = world();
    await expect(
      callTool(
        nodeManage(w.deps),
        {
          action: 'create',
          name: 'Sweden',
          address: 'se.example.io',
          config_profile_uuid: PROFILE,
          active_inbound_uuids: ['ffffffff-0000-4000-8000-000000000009'],
        },
        w,
      ),
    ).rejects.toThrow(/CONFIG_PROFILE_INBOUND_NOT_FOUND_IN_SPECIFIED_PROFILE/);
  });

  it('дубль имени или адреса отбивается до панели', async () => {
    const w = world();
    await expect(
      callTool(
        nodeManage(w.deps),
        {
          action: 'create',
          name: 'Germany',
          address: 'new.example.io',
          config_profile_uuid: PROFILE,
          active_inbound_uuids: [INBOUND],
        },
        w,
      ),
    ).rejects.toThrow(/уникальный индекс/);
  });

  it('пустой список инбаундов схема входа не принимает', () => {
    const w = world();
    const parsed = nodeManage(w.deps).def.input.safeParse({
      action: 'create',
      name: 'Sweden',
      address: 'se.example.io',
      config_profile_uuid: PROFILE,
      active_inbound_uuids: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('node_manage — общее', () => {
  it('несуществующая нода — отказ, а не тихий успех', async () => {
    const w = world();
    await expect(
      callTool(nodeManage(w.deps), { action: 'disable', uuid: GHOST }, w),
    ).rejects.toThrow(/в панели нет/);
  });

  it('уехавший мир отбивает применение', async () => {
    let reads = 0;
    const w = makeWorld({
      remnaGet: (path) => {
        if (path !== '/api/nodes') return { response: PROFILES };
        reads += 1;
        return {
          response: reads <= 1 ? NODES : [node(DE, 'Germany', { isDisabled: true }), NODES[1]],
        };
      },
      remnaSend: () => ({ response: node(DE, 'Germany') }),
    });
    const tool = nodeManage(w.deps);
    const plan = (await callTool(tool, { action: 'disable', uuid: DE }, w)) as { plan_id: string };
    await expect(
      callTool(tool, { action: 'disable', uuid: DE, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  /**
   * Не «мы решили их не делать», а «объявить их нельзя»: реестр запрещает оба
   * пути, и `assertEndpoints` роняет сборку инструмента при старте процесса.
   */
  it('restart-all и reorder объявить эндпоинтами невозможно', () => {
    const w = world();
    for (const path of ['/api/nodes/actions/restart-all', '/api/nodes/actions/reorder']) {
      expect(() =>
        defineMutation(
          {
            name: 'node_manage_forbidden_probe',
            description: 'проба',
            input: z.object({ ...planIdField }),
            risk: 'high',
            profiles: ['human'],
            endpoints: [`POST ${path}`],
            guard: { keys: ['x'], read: async () => ({}) },
            plan: async () => ({ before: {}, after: {}, diff: [], sideEffects: [] }),
            apply: async () => ({}),
          },
          w.deps,
        ),
      ).toThrow(/forbidden/);
    }
  });
});
