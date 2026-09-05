import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '@hq/redact';
import { RemnaError } from '@hq/remna';
import { hostEdit } from './hostEdit.js';
import { callTool, callToolResult, makeWorld } from '../testkit.js';

const UUID = '8b0b40cd-ed47-47ad-894c-0a16d168ba22';
const OLD_VALUE = 'old-arbitrary-credential';
const NEW_VALUE = 'new-arbitrary-credential';
const OLD_MAPPER = {
  mihomo: [{ op: 'set', to: 'obfs-password', value: OLD_VALUE }, { op: 'unset', to: 'smux' }],
  singbox: [{ op: 'unset', to: 'multiplex' }],
};
const NEW_MAPPER = {
  xrayJson: [
    { op: 'copy', from: '$host.securityOptions.serverName', to: 'streamSettings.tlsSettings.serverName' },
    { op: 'set', to: 'settings.servers.0', value: { address: NEW_VALUE, password: 'nested-credential' } },
    { op: 'unset', to: 'mux' },
  ],
  mihomo: [],
  base64: [{ op: 'set', to: 'obfs-password', value: NEW_VALUE }],
  singbox: [{ op: 'set', to: 'tcp_fast_open', value: true }],
};
const HOST = {
  uuid: UUID, remark: 'Germany', address: 'de.example.test', port: 443,
  isDisabled: true, isHidden: false, overrideSniFromAddress: false, keepSniBlank: false,
  shuffleHost: false, mihomoX25519: false, tags: [], mapper: OLD_MAPPER,
};

interface Plan {
  plan_id: string;
  before: Record<string, unknown>;
  after: { body?: Record<string, unknown>; bodyRef?: { path: string; sha256: string } };
  rollback: { method: string; path: string; body: Record<string, unknown> };
}

function setup(initial: Record<string, unknown> = HOST) {
  let current = structuredClone(initial);
  const w = makeWorld({
    remnaGetRaw: () => ({ response: [current] }),
    remnaSend: (_method, _path, body) => {
      current = { ...current, ...(body as Record<string, unknown>) };
      return { response: current };
    },
  });
  const tool = hostEdit(w.deps, join(w.dir, 'backups'));
  return { w, tool, current: () => current, change: (patch: Record<string, unknown>) => { current = { ...current, ...patch }; } };
}

describe('host_edit — mapper 3.3.2', () => {
  it('обычная правка сохраняет populated mapper и disabled без повторной отправки mapper', async () => {
    const { w, tool, current } = setup();
    const args = { uuid: UUID, remark: 'Germany 2' };
    const plan = await callTool(tool, args, w) as Plan;
    expect(plan.before).toHaveProperty('mapperHash');
    expect(plan.after.body).not.toHaveProperty('mapper');
    expect(plan.rollback.body).not.toHaveProperty('mapper');
    expect(plan.after.bodyRef).toBeUndefined();
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current()).toMatchObject({ mapper: OLD_MAPPER, isDisabled: true, remark: 'Germany 2' });
  });

  it('применяет ordered mapper точно и восстанавливает исходный mapper через подтверждённый rollback', async () => {
    const { w, tool, current } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER, remark: 'Germany 2' };
    const plan = await callTool(tool, args, w) as Plan;
    expect(w.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(plan.after.body).toBeUndefined();
    expect(plan.rollback).toMatchObject({ method: 'TOOL', path: 'host_edit', body: { uuid: UUID } });
    const applied = await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current()).toMatchObject({ mapper: NEW_MAPPER, isDisabled: true, remark: 'Germany 2' });
    const rollback = await callTool(tool, plan.rollback.body, w) as Plan;
    await callTool(tool, { ...plan.rollback.body, plan_id: rollback.plan_id }, w);
    expect(current()).toEqual(HOST);
    const exposed = JSON.stringify([plan, applied, rollback]);
    expect(exposed).not.toContain(OLD_VALUE);
    expect(exposed).not.toContain(NEW_VALUE);
    expect(exposed).not.toContain('nested-credential');
  });

  it('не раскрывает произвольные mapper values в confirm snapshot и audit input', async () => {
    const { w, tool } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    const plan = await callTool(tool, args, w) as Plan;
    const stored = await w.deps.confirm.peek(plan.plan_id);
    const ref = plan.after.bodyRef;
    expect(ref).toBeDefined();
    expect(statSync(ref!.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.dir, 'backups')).mode & 0o777).toBe(0o700);
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    const audit = await w.deps.audit.search();
    const publicState = JSON.stringify([stored, audit]);
    for (const value of [OLD_VALUE, NEW_VALUE, 'nested-credential']) expect(publicState).not.toContain(value);
    expect(readFileSync(ref!.path, 'utf8')).toContain(OLD_VALUE);
    expect(readFileSync(ref!.path, 'utf8')).toContain(NEW_VALUE);
  });

  it.each([
    ['значение', { mihomo: [{ op: 'set', to: 'obfs-password', value: 'concurrent-credential' }], singbox: OLD_MAPPER.singbox }],
    ['порядок', { ...OLD_MAPPER, mihomo: [{ op: 'unset', to: 'smux' }, { op: 'set', to: 'obfs-password', value: OLD_VALUE }] }],
  ])('блокирует обычный PATCH при изменении mapper: %s', async (_label, mapper) => {
    const { w, tool, change } = setup();
    const args = { uuid: UUID, port: 8443 };
    const plan = await callTool(tool, args, w) as Plan;
    change({ mapper });
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('хеш сравнивает mapper независимо от порядка ключей объектов', async () => {
    const { w, tool, change } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    const plan = await callTool(tool, args, w) as Plan;
    change({ mapper: { singbox: OLD_MAPPER.singbox, mihomo: [{ value: OLD_VALUE, to: 'obfs-password', op: 'set' }, { to: 'smux', op: 'unset' }] } });
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).resolves.toHaveProperty('status', 'applied');
  });

  it.each(['__proto__.x', 'settings.constructor.prototype.x', 'settings.prototype.x'])('не принимает опасный to %s', async (to) => {
    const { w, tool } = setup();
    await expect(callTool(tool, { uuid: UUID, remark: 'Germany 2', mapper: { xrayJson: [{ op: 'set', to, value: true }] } }, w)).rejects.toThrow(/mapper|path|пут/i);
    expect(w.calls).toHaveLength(0);
  });

  it('не принимает опасный copy from или prototype key внутри произвольного value', async () => {
    const { w, tool } = setup();
    for (const operation of [
      { op: 'copy', from: '$host.constructor.prototype.secret', to: 'x' },
      { op: 'set', to: 'x', value: JSON.parse('{"__proto__":{"polluted":true}}') as unknown },
    ]) {
      await expect(callTool(tool, { uuid: UUID, remark: 'Germany 2', mapper: { xrayJson: [operation] } }, w)).rejects.toThrow();
    }
    expect(w.calls).toHaveLength(0);
  });

  it('не принимает masked value из входа или исходного mapper для отката', async () => {
    const { w, tool } = setup();
    await expect(callTool(tool, { uuid: UUID, mapper: { base64: [{ op: 'set', to: 'obfs-password', value: REDACTED }] } }, w)).rejects.toThrow(/маск|masked|getRaw/i);
    const masked = setup({ ...HOST, mapper: { base64: [{ op: 'set', to: 'obfs-password', value: REDACTED }] } });
    await expect(callTool(masked.tool, { uuid: UUID, mapper: NEW_MAPPER }, masked.w)).rejects.toThrow(/маск|masked|getRaw/i);
  });

  it('не меняет mapper при отсутствующем исходном поле: точный откат неизвестен', async () => {
    const { mapper: _omitted, ...legacyHost } = HOST;
    const { w, tool } = setup(legacyHost);
    await expect(callTool(tool, { uuid: UUID, mapper: NEW_MAPPER }, w)).rejects.toThrow(/mapper|откат/i);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('отклоняет повреждённый backup до PATCH и не выводит его содержимое', async () => {
    const { w, tool } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    const plan = await callTool(tool, args, w) as Plan;
    const path = plan.after.bodyRef!.path;
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace(NEW_VALUE, 'tampered-credential'));
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/хеш|hash|sha256|целост/i);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('проверяет исходный mapper до создания плана отката и сохраняет пустой mapper как {}', async () => {
    const { w, tool, current, change } = setup();
    const args = { uuid: UUID, mapper: {} };
    const plan = await callTool(tool, args, w) as Plan;
    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    expect(current().mapper).toEqual({});
    const rollback = await callTool(tool, plan.rollback.body, w) as Plan;
    change({ mapper: NEW_MAPPER });
    await expect(callTool(tool, { ...plan.rollback.body, plan_id: rollback.plan_id }, w)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('restore_from отвергает чужой backup, путь вне каталога и смешанную правку', async () => {
    const { w, tool } = setup();
    const plan = await callTool(tool, { uuid: UUID, mapper: NEW_MAPPER }, w) as Plan;
    const saved = plan.after.bodyRef!.path;
    const foreign = 'eeeeeeee-0000-4000-8000-000000000099';
    await expect(callTool(tool, { uuid: foreign, restore_from: saved }, w)).rejects.toThrow(/backup|хост/i);
    await expect(callTool(tool, { uuid: UUID, restore_from: w.auditPath }, w)).rejects.toThrow(/backup/i);
    await expect(callTool(tool, { ...plan.rollback.body, mapper: {} }, w)).rejects.toThrow(/несовместим/i);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('возвращает generic ошибку при повреждённом JSON backup без фрагмента секрета', async () => {
    const { w, tool } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    const plan = await callTool(tool, args, w) as Plan;
    writeFileSync(plan.after.bodyRef!.path, 'private-malformed-json-credential');
    let error: unknown;
    try { await callTool(tool, { ...args, plan_id: plan.plan_id }, w); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('private-malformed-json-credential');
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('не применяет mapper, если ссылка rollback в плане не совпадает с проверенным backup', async () => {
    const { w, tool } = setup();
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    const plan = await callTool(tool, args, w) as Plan;
    const saved = await w.deps.confirm.peek(plan.plan_id);
    (saved.rollback!.body as Record<string, unknown>).restore_from = join(w.dir, 'foreign.json');
    writeFileSync(join(w.snapshotDir, `${plan.plan_id}.json`), JSON.stringify(saved));
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/откат|rollback|backup/i);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it.each(['read', 'write'])('не записывает mapper credentials в audit при transport error: %s', async (stage) => {
    const sentinel = 'fake-mapper-private-seed';
    const failure = new RemnaError(`Remnawave /api/hosts HTTP 400: {"mapper":{"base64":[{"op":"set","to":"x","value":"${sentinel}"}]}}`, 400);
    const w = makeWorld({
      remnaGetRaw: () => { if (stage === 'read') throw failure; return { response: [HOST] }; },
      remnaSendRaw: () => { throw failure; },
    });
    const tool = hostEdit(w.deps, join(w.dir, 'backups'));
    const args = { uuid: UUID, mapper: NEW_MAPPER };
    let plan_id: string | undefined;
    if (stage === 'write') {
      const plan = await callTool(tool, args, w) as Plan;
      plan_id = plan.plan_id;
    }
    const result = await callToolResult(tool, { ...args, ...(plan_id === undefined ? {} : { plan_id }) }, w);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('400');
    expect(JSON.stringify([result, await w.deps.audit.search()])).not.toContain(sentinel);
  });
});
