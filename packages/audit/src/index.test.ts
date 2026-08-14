import { mkdtempSync } from 'node:fs';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuditLog, unclosedAttempts } from './index.js';
import type { AuditEntry } from './index.js';

const fixedNow = new Date('2026-08-08T12:00:00.000Z');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hq-audit-')), 'nested', 'audit.jsonl');
}

/** Обязательный минимум записи: всё, что писатель обязан заполнить всегда. */
function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    tool: 'billing_adjust',
    profile: 'human',
    mode: 'rw',
    input: {},
    before: null,
    after: null,
    outcome: 'applied',
    ...over,
  };
}

describe('createAuditLog', () => {
  it('appends one JSONL line, creates the directory and stamps a unique id', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });

    const rec = await log.write(
      entry({
        input: { user_id: 3073, amount: -100 },
        before: { balance: 500 },
        after: { balance: 400 },
        outcome: 'planned',
        token: 'e1f9d0c8-0000-4000-8000-000000000001',
      }),
    );

    expect(rec.at).toBe('2026-08-08T12:00:00.000Z');
    // §1.3: идентификатор — uuid, а не `${ms}-${seq}`: seq обнуляется рестартом и
    // совпадает у двух процессов, пишущих в один файл.
    expect(rec.id).toMatch(UUID_RE);
    expect(rec.seq).toBe(1);

    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw.trim())).toMatchObject({
      tool: 'billing_adjust',
      outcome: 'planned',
      profile: 'human',
      mode: 'rw',
      token: 'e1f9d0c8-0000-4000-8000-000000000001',
    });
  });

  it('creates the directory 0700 and the file 0600: the journal holds raw snapshots', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    await log.write(entry());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it('writes failures with the error text and returns them by tool', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    await log.write(entry({ tool: 'host_edit' }));
    await log.write(entry({ outcome: 'failed', error: 'HTTP 408' }));

    const { records, corrupt } = await log.search({ tool: 'billing_adjust' });
    expect(corrupt).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.error).toBe('HTTP 408');
  });

  it('returns the newest first, cuts by limit and since, and counts unreadable lines', async () => {
    const path = tmpPath();
    let tick = 0;
    const log = createAuditLog(path, { now: () => new Date(fixedNow.getTime() + tick * 1000) });
    for (tick = 0; tick < 3; tick += 1) {
      await log.write(entry({ tool: `t${tick}` }));
    }
    await appendFile(path, 'not a json line\n', 'utf8');

    const all = await log.search({ limit: 2 });
    expect(all.records.map((r) => r.tool)).toEqual(['t2', 't1']);
    // §1.2: битая строка не роняет чтение, но и не исчезает молча.
    expect(all.corrupt).toBe(1);

    const since = await log.search({ since: '2026-08-08T12:00:02.000Z' });
    expect(since.records.map((r) => r.tool)).toEqual(['t2']);
    expect(since.corrupt).toBe(1);
  });

  it('counts a JSON line that is not a record as corrupt instead of returning it', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    await log.write(entry({ tool: 'host_edit' }));
    await appendFile(path, '{"tool":"host_edit"}\n[]\n"поехали"\n', 'utf8');

    const { records, corrupt } = await log.search({});
    expect(records.map((r) => r.tool)).toEqual(['host_edit']);
    expect(corrupt).toBe(3);
  });

  it('returns nothing for a missing file', async () => {
    const log = createAuditLog(join(tmpdir(), 'hq-audit-missing', 'nope.jsonl'), {
      now: () => fixedNow,
    });
    await expect(log.search({})).resolves.toEqual({ records: [], corrupt: 0 });
  });

  it('keeps ids unique across restarts and keeps seq as a field', async () => {
    const path = tmpPath();
    const first = await createAuditLog(path, { now: () => fixedNow }).write(entry());
    // Второй экземпляр — модель рестарта процесса и второго процесса на общем файле.
    const second = await createAuditLog(path, { now: () => fixedNow }).write(entry());

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(1);
    expect(second.id).not.toBe(first.id);
  });

  it('finds records by plan token and by target', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    await log.write(
      entry({ tool: 'billing_adjust', token: 'tok-1', target: { system: 'shm', id: 3073 } }),
    );
    await log.write(
      entry({ tool: 'subscription_ops', token: 'tok-2', target: { system: 'remna', id: 41 } }),
    );
    await log.write(
      entry({ tool: 'billing_refund_service', token: 'tok-3', target: { system: 'shm', id: 999 } }),
    );

    const byToken = await log.search({ token: 'tok-2' });
    expect(byToken.records.map((r) => r.tool)).toEqual(['subscription_ops']);

    // «Что делали клиенту 3073» — вопрос, на который журнал обязан отвечать.
    const byTarget = await log.search({ target: { id: 3073 } });
    expect(byTarget.records.map((r) => r.tool)).toEqual(['billing_adjust']);

    const bySystem = await log.search({ target: { system: 'shm' } });
    expect(bySystem.records.map((r) => r.tool)).toEqual([
      'billing_refund_service',
      'billing_adjust',
    ]);

    // Строка и число — один и тот же клиент: id прилетает из разных схем ввода.
    const loose = await log.search({ target: { system: 'shm', id: '3073' } });
    expect(loose.records.map((r) => r.tool)).toEqual(['billing_adjust']);
  });

  it('records what is about to be called before it is called', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    const started = await log.write(
      entry({
        outcome: 'applying',
        token: 'tok-1',
        calls: ['PUT /admin/user/payment'],
        target: { system: 'shm', id: 3073 },
      }),
    );
    await log.write(
      entry({
        outcome: 'applied',
        token: 'tok-1',
        attempt: started.id,
        calls: ['PUT /admin/user/payment'],
        result: { id: 77 },
      }),
    );

    const { records } = await log.search({ token: 'tok-1' });
    expect(records.map((r) => r.outcome)).toEqual(['applied', 'applying']);
    expect(records[0]?.attempt).toBe(started.id);
    expect(records[1]?.calls).toEqual(['PUT /admin/user/payment']);
    expect(records[0]?.result).toEqual({ id: 77 });
  });

  it('reports an applying record that never got its terminal pair', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    const closed = await log.write(entry({ outcome: 'applying', token: 'tok-1' }));
    await log.write(entry({ outcome: 'applied', token: 'tok-1', attempt: closed.id }));
    // Процесс умер между вызовом бэкенда и терминальной записью: деньги ушли,
    // план уже удалён, и единственный след — эта незакрытая строка.
    const orphan = await log.write(entry({ outcome: 'applying', token: 'tok-2' }));

    const { records } = await log.search({});
    expect(unclosedAttempts(records).map((r) => r.id)).toEqual([orphan.id]);
  });

  it('rotates by size instead of growing without bound', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow, maxBytes: 1 });
    await log.write(entry({ tool: 'first' }));
    await log.write(entry({ tool: 'second' }));

    const dir = dirname(path);
    const files = await readdir(dir);
    expect(files).toHaveLength(2);

    const active = await log.search({});
    expect(active.records.map((r) => r.tool)).toEqual(['second']);

    const rotated = files.find((name) => name !== basename(path)) ?? '';
    expect(rotated.startsWith(`${basename(path)}.`)).toBe(true);
    const rolled = await readFile(join(dir, rotated), 'utf8');
    expect(JSON.parse(rolled.trim())).toMatchObject({ tool: 'first' });
  });

  it('survives concurrent writes without tearing a line', async () => {
    const path = tmpPath();
    const log = createAuditLog(path, { now: () => fixedNow });
    // Снимки before/after в реальной записи — килобайты; всё, что крупнее
    // PIPE_BUF, appendFile атомарно не пишет.
    const bulky = 'x'.repeat(64 * 1024);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.write(entry({ tool: `t${i}`, before: bulky }))),
    );

    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(20);

    const { records, corrupt } = await log.search({ limit: 100 });
    expect(corrupt).toBe(0);
    expect(new Set(records.map((r) => r.id)).size).toBe(20);
    expect([...records].map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});
