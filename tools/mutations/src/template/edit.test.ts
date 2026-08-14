import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateEdit } from './edit.js';
import { callTool, makeWorld } from '../testkit.js';
import type { FakeWorld } from '../testkit.js';

/**
 * СЕКРЕТ В ТЕЛЕ СОБРАН СКЛЕЙКОЙ, а не написан строкой.
 *
 * `scripts/no-secrets.test.ts` гоняет по трекаемым файлам ровно те же
 * регулярки, которыми `scrubSecretShapes` чистит тела шаблонов. Литеральный
 * JWT в этом файле был бы нарушением — и «починить» это ослаблением
 * предохранителя значило бы научить его пропускать настоящие секреты ради
 * прохождения теста.
 */
const FAKE_JWT = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ1dWlkIjoidGVzdCJ9', '.', 'c2lnbmF0dXJlX3Rlc3Q'].join('');

const LIVE_BODY = [
  '{{ # hwid blocker }}',
  `{{ REMNA_TOKEN = "${FAKE_JWT}" }}`,
  '{{ http.get(url) }}',
  'tail line',
].join('\n');

const NEW_BODY = [
  '{{ # hwid blocker }}',
  `{{ REMNA_TOKEN = "${FAKE_JWT}" }}`,
  '{{ http.post(url) }}',
  'tail line',
].join('\n');

interface Plan {
  plan_id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  sideEffects: string[];
}

interface Applied {
  status: string;
  result: { backup: string; sha256: string; restore_hint: string; drift?: unknown };
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'hq-tpl-'));
}

function world(opts: { bodies?: string[]; onAction?: (body: unknown) => void } = {}): FakeWorld {
  const bodies = opts.bodies ?? [LIVE_BODY, LIVE_BODY, LIVE_BODY, NEW_BODY];
  let read = 0;
  return makeWorld({
    shmGetRaw: () => {
      const body = bodies[Math.min(read, bodies.length - 1)];
      read += 1;
      return body === null ? { data: [] } : { data: [{ id: 'hwid_blocker', data: body, settings: {} }] };
    },
    // Редактируемый канал намеренно отдаёт ЧУШЬ: инструмент обязан читать
    // тело только через getRaw, иначе снимок отката соберётся из маски.
    shmGet: () => ({ data: [{ id: 'hwid_blocker', data: '<redacted:jwt> WRONG CHANNEL', settings: {} }] }),
    shmAction: (_method, _path, body) => {
      opts.onAction?.(body);
      return { data: [{ id: 'hwid_blocker', data: 'ok', settings: {} }] };
    },
  });
}

describe('template_edit', () => {
  it('боту инструмент не отдаётся, риск high, объявлены только GET и POST', () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    expect(tool.def.profiles).toEqual(['human']);
    expect(tool.def.risk).toBe('high');
    expect(tool.endpoints).toEqual(['GET /admin/template', 'POST /admin/template']);
  });

  it('план читает тело НЕредактированным каналом и не показывает секрет из старого тела', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    const plan = (await callTool(tool, { id: 'hwid_blocker', body: NEW_BODY }, w)) as Plan;

    const read = w.calls.find((c) => c.method === 'GET');
    expect(read?.raw).toBe(true);
    expect(read?.path).toBe('/admin/template');

    // Ответ ушёл через настоящий executeTool: если бы секрет попал в diff или
    // в before, он был бы прямо здесь — редакция по имени поля его не видит.
    const rendered = JSON.stringify(plan);
    expect(rendered).not.toContain(FAKE_JWT);
    expect(rendered).toContain('<redacted:jwt>');
    // ...и при этом diff по существу показывает, что именно изменилось.
    expect(plan.diff.some((d) => d.path === 'sha256')).toBe(true);
    expect(plan.diff.some((d) => String(d.from ?? '').includes('http.get'))).toBe(true);
    expect(plan.diff.some((d) => String(d.to ?? '').includes('http.post'))).toBe(true);
    expect(plan.before.scrubbed).toBe(1);
  });

  it('применение снимает предыдущие байты в файл ДО записи и пишет их СЫРЫМИ', async () => {
    const backups = dir();
    const bodies: unknown[] = [];
    const w = world({ onAction: (body) => bodies.push(body) });
    const tool = templateEdit(w.deps, backups);
    const plan = (await callTool(tool, { id: 'hwid_blocker', body: NEW_BODY }, w)) as Plan;
    const applied = (await callTool(
      tool,
      { id: 'hwid_blocker', body: NEW_BODY, plan_id: plan.plan_id },
      w,
    )) as Applied;

    expect(applied.status).toBe('applied');
    const snapshot = JSON.parse(readFileSync(applied.result.backup, 'utf8')) as {
      kind: string;
      target: string;
      payload: string;
    };
    expect(snapshot.kind).toBe('template');
    expect(snapshot.target).toBe('hwid_blocker');
    // Снимок обязан содержать НАСТОЯЩИЙ токен: иначе восстановление запишет в
    // исполняемый шаблон строку "<redacted:jwt>".
    expect(snapshot.payload).toBe(LIVE_BODY);
    expect(snapshot.payload).toContain(FAKE_JWT);

    // ...а наружу тот же секрет не ушёл ни в одном поле ответа.
    expect(JSON.stringify(applied)).not.toContain(FAKE_JWT);

    expect(bodies).toEqual([{ id: 'hwid_blocker', data: NEW_BODY, format: '' }]);
    expect(applied.result.restore_hint).toContain('restore_from');
  });

  it('не пишет в SHM, если снимок снять не удалось', async () => {
    const blocked = join(dir(), 'file.txt');
    writeFileSync(blocked, 'not a directory');
    const writes: unknown[] = [];
    const w = world({ onAction: (body) => writes.push(body) });
    const tool = templateEdit(w.deps, join(blocked, 'nested'));
    const plan = (await callTool(tool, { id: 'hwid_blocker', body: NEW_BODY }, w)) as Plan;

    await expect(
      callTool(tool, { id: 'hwid_blocker', body: NEW_BODY, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/ENOTDIR|EEXIST|ENOENT/);
    expect(writes).toEqual([]);
  });

  it('тело с маркером редакции отвергается: это вывод template_read', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(
      callTool(
        tool,
        { id: 'hwid_blocker', body: '{{ REMNA_TOKEN = "<redacted:jwt>" }}\nx' },
        w,
      ),
    ).rejects.toThrow(/маркер редакции/);
    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({ tool: 'template_edit', outcome: 'rejected' });
  });

  it('пустое тело отвергается без allow_empty и проходит с ним', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(callTool(tool, { id: 'hwid_blocker', body: '   ' }, w)).rejects.toThrow(
      /SKIPPED\/EMPTY_RENDER/,
    );

    const plan = (await callTool(
      tool,
      { id: 'hwid_blocker', body: '   ', allow_empty: true },
      w,
    )) as Plan;
    expect(plan.sideEffects.join('\n')).toContain('ТЕЛО ПУСТОЕ');
  });

  it('тело "0" отвергается всегда: Perl считает его ложным и запишет пустой файл', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(
      callTool(tool, { id: 'hwid_blocker', body: '0', allow_empty: true }, w),
    ).rejects.toThrow(/ПУСТОЙ файл/);
  });

  it('несуществующий шаблон не создаётся, а имя с ../ и копии не пишутся вовсе', async () => {
    const w = makeWorld({ shmGetRaw: () => ({ data: [] }) });
    const tool = templateEdit(w.deps, dir());
    await expect(callTool(tool, { id: 'nope', body: 'x' }, w)).rejects.toThrow(/не существует/);

    const w2 = world();
    const tool2 = templateEdit(w2.deps, dir());
    await expect(callTool(tool2, { id: '../../etc/passwd', body: 'x' }, w2)).rejects.toThrow(
      /parent-directory step/,
    );
    await expect(callTool(tool2, { id: '.DAV/hwid_blocker', body: 'x' }, w2)).rejects.toThrow(
      /НЕ исполняет/,
    );
    // Ни один отказ не дошёл до SHM записью.
    expect([...w.calls, ...w2.calls].some((c) => c.method === 'POST')).toBe(false);
  });

  it('побайтово одинаковое тело — отказ, а не пустой план', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(callTool(tool, { id: 'hwid_blocker', body: LIVE_BODY }, w)).rejects.toThrow(
      /побайтово совпадает/,
    );
  });

  it('чужая правка между планом и применением отвергается и до записи не доходит', async () => {
    const writes: unknown[] = [];
    const w = world({
      bodies: [LIVE_BODY, 'кто-то переписал шаблон между планом и применением'],
      onAction: (body) => writes.push(body),
    });
    const tool = templateEdit(w.deps, dir());
    const plan = (await callTool(tool, { id: 'hwid_blocker', body: NEW_BODY }, w)) as Plan;
    await expect(
      callTool(tool, { id: 'hwid_blocker', body: NEW_BODY, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось/);
    expect(writes).toEqual([]);
  });

  it('restore_from возвращает прежнее тело, не протаскивая его через ответ', async () => {
    const backups = dir();
    const bodies: unknown[] = [];
    // Первый прогон: пишем NEW_BODY поверх LIVE_BODY и получаем снимок.
    const first = world({ onAction: (body) => bodies.push(body) });
    const tool = templateEdit(first.deps, backups);
    const plan = (await callTool(tool, { id: 'hwid_blocker', body: NEW_BODY }, first)) as Plan;
    const applied = (await callTool(
      tool,
      { id: 'hwid_blocker', body: NEW_BODY, plan_id: plan.plan_id },
      first,
    )) as Applied;

    // Второй прогон: мир теперь отдаёт NEW_BODY, восстанавливаем из снимка.
    const second = world({ bodies: [NEW_BODY], onAction: (body) => bodies.push(body) });
    const restore = templateEdit(second.deps, backups);
    const args = { id: 'hwid_blocker', restore_from: applied.result.backup };
    const rplan = (await callTool(restore, args, second)) as Plan;

    // Снимок несёт настоящий токен — и всё же его нет ни в плане, ни в after.
    expect(JSON.stringify(rplan)).not.toContain(FAKE_JWT);
    expect(rplan.after.body).toBeUndefined();
    expect(rplan.after.restore_from).toBe(applied.result.backup);

    const rapplied = (await callTool(
      restore,
      { ...args, plan_id: rplan.plan_id },
      second,
    )) as Applied;
    expect(rapplied.status).toBe('applied');
    expect(JSON.stringify(rapplied)).not.toContain(FAKE_JWT);
    // ...а в SHM ушло ровно прежнее тело целиком.
    expect(bodies.at(-1)).toEqual({ id: 'hwid_blocker', data: LIVE_BODY, format: '' });
  });

  it('снимок другого шаблона в restore_from отвергается', async () => {
    const backups = dir();
    const foreign = join(backups, 'template-other-1.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(backups, { recursive: true });
    writeFileSync(
      foreign,
      JSON.stringify({
        kind: 'template',
        target: 'other_template',
        savedAt: '2026-08-13T00:00:00.000Z',
        bytes: 1,
        sha256: 'x',
        payload: 'чужое тело',
      }),
    );
    const w = world();
    const tool = templateEdit(w.deps, backups);
    await expect(
      callTool(tool, { id: 'hwid_blocker', restore_from: foreign }, w),
    ).rejects.toThrow(/чужое содержимое/);
  });

  it('снимок вне каталога снимков не читается', async () => {
    const outside = join(dir(), 'elsewhere.json');
    writeFileSync(outside, JSON.stringify({ kind: 'template', target: 'hwid_blocker' }));
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(
      callTool(tool, { id: 'hwid_blocker', restore_from: outside }, w),
    ).rejects.toThrow(/вне каталога снимков/);
  });

  it('нужен ровно один источник тела', async () => {
    const w = world();
    const tool = templateEdit(w.deps, dir());
    await expect(callTool(tool, { id: 'hwid_blocker' }, w)).rejects.toThrow(/ровно одно/);
    await expect(
      callTool(tool, { id: 'hwid_blocker', body: 'x', restore_from: '/tmp/x.json' }, w),
    ).rejects.toThrow(/ровно одно/);
  });
});
