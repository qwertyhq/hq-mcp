import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeTool } from '@hq/exec';
import { createProbeStore, createRegistry, defineTool } from '@hq/registry';
import type { Profile, ToolContext } from '@hq/types';
import { buildDiff } from './diff.js';

/**
 * Проверка на уровне ИСПОЛНИТЕЛЯ, а не функции: страховочная редакция
 * `executeTool` маскирует по ИМЕНИ КЛЮЧА, а у DiffEntry ключи называются
 * path/from/to — имя изменяемого поля лежит внутри строки `path` как значение.
 * Тест на самом buildDiff этого не покажет: он и есть то место, где дыру
 * закрыли. Здесь же видно, что после всех проходов ответа кред в нём нет.
 */

const before = { uuid: 'h-1', trojanPassword: 'trojan-plaintext', isDisabled: true };
const after = { uuid: 'h-1', trojanPassword: 'trojan-rotated', isDisabled: false };

const hostEdit = defineTool({
  name: 'host_edit',
  description: 'builds a plan and changes nothing',
  input: z.object({ uuid: z.string() }),
  access: 'rw',
  risk: 'high',
  profiles: ['human', 'bot'],
  handler: async (_input, ctx) => ({
    status: 'plan',
    tool: 'host_edit',
    before,
    after,
    diff: buildDiff(before, after, ctx.profile),
  }),
});

/** Тот же план с diff, собранным руками мимо buildDiff — контроль, см. ниже. */
const hostEditRaw = defineTool({
  name: 'host_leak',
  description: 'the same plan with a hand-built diff',
  input: z.object({ uuid: z.string() }),
  access: 'rw',
  risk: 'high',
  profiles: ['human'],
  handler: async () => ({
    status: 'plan',
    before,
    after,
    diff: [{ path: 'trojanPassword', from: before.trojanPassword, to: after.trojanPassword }],
  }),
});

const registry = createRegistry([hostEdit, hostEditRaw]);

function makeCtx(profile: Profile = 'human'): ToolContext {
  return {
    shm: {} as ToolContext['shm'],
    remna: {} as ToolContext['remna'],
    backends: { shm: true, remna: true },
    profile,
    mode: 'rw',
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    shmTz: 'Europe/Moscow',
    probe: createProbeStore(),
  };
}

describe('a plan going through executeTool', () => {
  it('carries no working password anywhere in the response', async () => {
    const result = await executeTool('host_edit', { uuid: 'h-1' }, { registry, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('trojan-plaintext');
    expect(wire).not.toContain('trojan-rotated');
    // Путь остаётся читаемым: оператору нужно видеть, ЧТО меняется.
    expect(wire).toContain('trojanPassword');
  });

  it('keeps the harmless rows of the same diff intact', async () => {
    const result = await executeTool('host_edit', { uuid: 'h-1' }, { registry, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { diff: unknown };
    expect(value.diff).toEqual([
      { path: 'isDisabled', from: true, to: false },
      { path: 'trojanPassword', from: '<redacted>', to: '<redacted>' },
    ]);
  });

  it('masks PII in the diff for the bot profile too', async () => {
    const contact = defineTool({
      name: 'client_edit',
      description: 'changes the contact email',
      input: z.object({}),
      access: 'rw',
      risk: 'medium',
      profiles: ['bot'],
      handler: async (_input, ctx) =>
        buildDiff({ email: 'a@example.com' }, { email: 'b@example.com' }, ctx.profile),
    });
    const result = await executeTool(
      'client_edit',
      {},
      { registry: createRegistry([contact]), ctx: makeCtx('bot') },
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('CONTROL: a hand-built diff is NOT covered by the executor — it must go through redactDiff', async () => {
    // Этот тест закрепляет ПРИЧИНУ, по которой маскирование живёт в diff.ts, а не
    // надеется на executeTool: тот же ответ с diff, собранным руками, уносит
    // рабочий пароль в контекст модели. Мутаторы плана 5 обязаны прогонять свои
    // ручные diff через redactDiff — иначе будет ровно это.
    const result = await executeTool('host_leak', { uuid: 'h-1' }, { registry, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).toContain('trojan-plaintext');
    // При этом before/after в том же ответе замаскированы — предохранитель
    // ВЫГЛЯДИТ работающим (это и есть суть находки 2.1).
    expect(wire).toContain('"before":{"uuid":"h-1","trojanPassword":"<redacted>"');
  });
});
