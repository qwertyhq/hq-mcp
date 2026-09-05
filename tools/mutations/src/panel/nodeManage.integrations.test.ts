import { describe, expect, it } from 'vitest';
import { RemnaError } from '@hq/remna';
import { nodeManage } from './nodeManage.js';
import { callTool, callToolResult, makeWorld, planThenApply } from '../testkit.js';

const NODE = 'dc287b03-9bb7-48f5-b3e5-62aed2fa02c8';
const PROFILE = 'd73e2561-43f2-4a30-97ca-8f8cd317499f';
const INBOUND = 'eeeeeeee-0000-4000-8000-000000000001';
const FIRST = 'eeeeeeee-0000-4000-8000-000000000011';
const SECOND = 'eeeeeeee-0000-4000-8000-000000000012';
const UNKNOWN = 'eeeeeeee-0000-4000-8000-000000000019';
const CATALOG = { total: 2, nodeIntegrations: [
  { uuid: FIRST, name: 'First', config: { credential: 'private-integration-value' } },
  { uuid: SECOND, name: 'Second', config: { credential: 'private-integration-value' } },
] };
const CURRENT = {
  uuid: NODE, name: 'Germany', address: 'de.example.test', port: 2222, countryCode: 'DE',
  isDisabled: false, isConnected: true, usersOnline: 7, xrayUptime: 100,
  trafficUsedBytes: 0, trafficLimitBytes: 0, isTrafficTrackingActive: false,
  trafficResetDay: null, notifyPercent: null, consumptionMultiplier: 1,
  nodeConsumptionMultiplier: 1, note: null, tags: [], integrationUuids: [FIRST, SECOND],
  configProfile: { activeConfigProfileUuid: PROFILE, activeInbounds: [{ uuid: INBOUND }] },
};
const CREATE = { action: 'create', name: 'Netherlands', address: 'nl.example.test', config_profile_uuid: PROFILE, active_inbound_uuids: [INBOUND] };
interface Plan {
  plan_id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  sideEffects: string[];
  rollback?: { method: string; path: string; body: Record<string, unknown> };
}

function setup(initial: Record<string, unknown> = CURRENT) {
  let current = structuredClone(initial);
  let catalog: unknown = CATALOG;
  const w = makeWorld({
    remnaGet: (path) => {
      if (path === '/api/nodes') return { response: [current] };
      if (path === '/api/config-profiles') return { response: { total: 1, configProfiles: [{ uuid: PROFILE, inbounds: [{ uuid: INBOUND }] }] } };
      if (path === '/api/node-integrations') {
        if (catalog instanceof Error) throw catalog;
        return { response: catalog };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    remnaSend: (_method, _path, body) => {
      current = { ...current, ...(body as Record<string, unknown>) };
      return { response: current };
    },
  });
  return { w, tool: nodeManage(w.deps), current: () => current,
    change: (patch: Record<string, unknown>) => { current = { ...current, ...patch }; },
    catalog: (value: unknown) => { catalog = value; } };
}

describe('node_manage — integration bindings 3.3.2', () => {
  it('передаёт ordered UUIDs, сохраняет исходный порядок для rollback и предупреждает о force restart', async () => {
    const { w, tool, current } = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [SECOND, FIRST] };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.before.integrationUuids).toEqual([FIRST, SECOND]);
    expect(plan.after.integrationUuids).toEqual([SECOND, FIRST]);
    expect(plan.rollback).toMatchObject({ method: 'PATCH', path: '/api/nodes', body: { uuid: NODE, integrationUuids: [FIRST, SECOND] } });
    expect(plan.sideEffects.join(' ')).toMatch(/integrationUuids.*принудительн|принудительн.*integrationUuids/i);
    expect(JSON.stringify(plan)).not.toContain('private-integration-value');
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current().integrationUuids).toEqual([SECOND, FIRST]);
    expect(w.calls.filter((call) => call.method !== 'GET')).toEqual([
      { system: 'remna', method: 'PATCH', path: '/api/nodes', body: { uuid: NODE, isTrafficTrackingActive: false, integrationUuids: [SECOND, FIRST] } },
    ]);
  });

  it('обычная правка сохраняет bindings без лишнего integrationUuids и чтения каталога', async () => {
    const { w, tool, current } = setup();
    const args = { action: 'update', uuid: NODE, name: 'Germany 2' };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.before.integrationUuids).toEqual([FIRST, SECOND]);
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current().integrationUuids).toEqual([FIRST, SECOND]);
    expect(w.calls.find((call) => call.method === 'PATCH')?.body).not.toHaveProperty('integrationUuids');
    expect(plan.rollback?.body).not.toHaveProperty('integrationUuids');
    expect(w.calls.some((call) => call.path === '/api/node-integrations')).toBe(false);
  });

  it('явный пустой список очищает связи и также вызывает force restart включённой ноды', async () => {
    const { w, tool, current } = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [] };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.sideEffects.join(' ')).toMatch(/принудительн/i);
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current().integrationUuids).toEqual([]);
  });

  it('правка связей выключенной ноды не обещает restart', async () => {
    const { w, tool } = setup({ ...CURRENT, isDisabled: true });
    const plan = await callTool(tool, { action: 'update', uuid: NODE, integration_uuids: [FIRST] }, w) as Plan;
    expect(plan.sideEffects.join(' ')).not.toMatch(/ПЕРЕЗАПУСТИТ|принудительн/i);
  });

  it('create передаёт integrations в заданном порядке', async () => {
    const { w, tool } = setup();
    await planThenApply(tool, { ...CREATE, integration_uuids: [SECOND, FIRST] }, w);
    expect(w.calls.find((call) => call.method === 'POST')?.body).toMatchObject({ integrationUuids: [SECOND, FIRST] });
  });

  it.each(['create', 'update'])('%s не принимает несуществующую интеграцию', async (action) => {
    const { w, tool } = setup();
    const args = action === 'create' ? CREATE : { action, uuid: NODE };
    await expect(callTool(tool, { ...args, integration_uuids: [UNKNOWN] }, w)).rejects.toThrow(/интеграц/i);
    expect(w.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it.each([
    ['отказ доступа', new Error('HTTP 403: private response')],
    ['неполный каталог', { total: 3, nodeIntegrations: CATALOG.nodeIntegrations }],
    ['неверная форма', {}],
  ])('не строит план при недостоверном каталоге: %s', async (_label, catalog) => {
    const setupWorld = setup();
    setupWorld.catalog(catalog);
    await expect(callTool(setupWorld.tool, { action: 'update', uuid: NODE, name: 'Germany 2', integration_uuids: [FIRST] }, setupWorld.w)).rejects.toThrow();
    expect(setupWorld.w.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('повторно проверяет существование интеграции перед подтверждённым PATCH', async () => {
    const s = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [FIRST] };
    const plan = await callTool(s.tool, args, s.w) as Plan;
    s.catalog({ total: 0, nodeIntegrations: [] });
    await expect(callTool(s.tool, { ...args, plan_id: plan.plan_id }, s.w)).rejects.toThrow(/интеграц/i);
    expect(s.w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('guard замечает изменение порядка связей даже при обычной правке', async () => {
    const { w, tool, change } = setup();
    const args = { action: 'update', uuid: NODE, name: 'Germany 2' };
    const plan = await callTool(tool, args, w) as Plan;
    change({ integrationUuids: [SECOND, FIRST] });
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('при отсутствующем поле bindings отказывается менять его без точного rollback', async () => {
    const { integrationUuids: _omitted, ...legacy } = CURRENT;
    const { w, tool } = setup(legacy);
    await expect(callTool(tool, { action: 'update', uuid: NODE, integration_uuids: [FIRST] }, w)).rejects.toThrow(/integrationUuids|откат/i);
  });

  it.each([
    ['не UUID', ['not-a-uuid']],
    ['21 UUID', Array.from({ length: 21 }, () => FIRST)],
  ])('отклоняет некорректные bindings: %s', async (_label, integration_uuids) => {
    const { w, tool } = setup();
    await expect(callTool(tool, { action: 'update', uuid: NODE, integration_uuids }, w)).rejects.toThrow();
    expect(w.calls).toHaveLength(0);
  });

  it('сохраняет повтор UUID в порядке списка как в контракте 3.3.2', async () => {
    const { w, tool, current } = setup();
    await planThenApply(tool, { action: 'update', uuid: NODE, integration_uuids: [FIRST, SECOND, FIRST] }, w);
    expect(current().integrationUuids).toEqual([FIRST, SECOND, FIRST]);
  });

  it('не игнорирует integration_uuids у restart', async () => {
    const { w, tool } = setup();
    await expect(callTool(tool, { action: 'restart', uuid: NODE, force_restart: false, integration_uuids: [FIRST] }, w)).rejects.toThrow(/create|update/i);
    expect(w.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('явная отправка прежнего порядка остаётся подтверждаемой принудительной операцией', async () => {
    const { w, tool } = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [FIRST, SECOND] };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.sideEffects.join(' ')).toMatch(/ПРИНУДИТЕЛЬНЫЙ/);
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(w.calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
    expect(w.calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({ integrationUuids: [FIRST, SECOND] });
  });

  it.each(['target', 'order', 'rollback'])('не применяет повреждённый снимок integration плана: %s', async (part) => {
    const { w, tool } = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [SECOND, FIRST] };
    const result = await callTool(tool, args, w) as Plan;
    const saved = await w.deps.confirm.peek(result.plan_id);
    const after = saved.after as { op: { patch: Record<string, unknown> } };
    if (part === 'target') after.op.patch.uuid = UNKNOWN;
    if (part === 'order') after.op.patch.integrationUuids = [FIRST, SECOND];
    if (part === 'rollback') (saved.rollback!.body as Record<string, unknown>).integrationUuids = [];
    writeFileSync(join(w.snapshotDir, `${result.plan_id}.json`), JSON.stringify(saved));
    await expect(callTool(tool, { ...args, plan_id: result.plan_id }, w)).rejects.toThrow(/план|снимок|откат/i);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it.each(['plan', 'confirm'])('не пишет integration config в audit при недоступности каталога: %s', async (stage) => {
    const s = setup();
    const args = { action: 'update', uuid: NODE, integration_uuids: [FIRST] };
    let plan_id: string | undefined;
    if (stage === 'confirm') plan_id = (await callTool(s.tool, args, s.w) as Plan).plan_id;
    const sentinel = 'fake-integration-private-seed';
    s.catalog(new RemnaError(`Remnawave GET /api/node-integrations HTTP 500: {"config":{"arbitrary":"${sentinel}"}}`, 500));
    const result = await callToolResult(s.tool, { ...args, ...(plan_id === undefined ? {} : { plan_id }) }, s.w);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('500');
    expect(JSON.stringify([result, await s.w.deps.audit.search()])).not.toContain(sentinel);
    expect(s.w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it.each(['input', 'catalog'])('UUID интеграций сравниваются без учёта регистра: %s', async (source) => {
    const s = setup();
    if (source === 'catalog') {
      s.catalog({ total: 2, nodeIntegrations: [{ uuid: FIRST.toUpperCase() }, { uuid: SECOND.toUpperCase() }] });
    }
    const integration_uuids = source === 'input' ? [SECOND.toUpperCase(), FIRST.toUpperCase()] : [SECOND, FIRST];
    await planThenApply(s.tool, { action: 'update', uuid: NODE, integration_uuids }, s.w);
    expect(s.current().integrationUuids).toEqual([SECOND, FIRST]);
  });
});
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
