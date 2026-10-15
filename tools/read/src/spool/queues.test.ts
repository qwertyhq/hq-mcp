import { describe, expect, it } from 'vitest';
import { ShmError } from '@hq/shm';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { SPOOL_QUEUES_PATH, spoolQueues } from './queues.js';

interface Out {
  available: boolean | null;
  items: number | null;
  queues: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/** Форма строки spool_queues SHM 3.0.23+ (migrations/3.0.23.sql). */
function queue(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Рассылка ${String(id)}`,
    rate_limit: null,
    status: 'active',
    last_executed_at: '2026-10-12 20:58:10',
    created_at: '2026-10-12 20:56:30',
    finished_at: '2026-10-12 20:58:10',
    total_added: 1322,
    cnt_success: 1300,
    cnt_fail: 22,
    cnt_delayed: 0,
    cnt_stuck: 0,
    cnt_paused: 0,
    cnt_skipped: 0,
    cnt_pending: 0,
    ...over,
  };
}

async function run(input: Record<string, unknown>, shmList: (path: string) => unknown, calls: StubCall[] = []): Promise<Out> {
  const ctx = makeCtx({ calls, shmList });
  return (await spoolQueues.handler(spoolQueues.input.parse(input), ctx)) as Out;
}

describe('spool_queues', () => {
  it('reads newest first and counts progress the way SHM does: success + skipped, not fail', async () => {
    const calls: StubCall[] = [];
    const out = await run({}, () => [queue(9001)], calls);
    expect(calls[0]?.path).toBe(SPOOL_QUEUES_PATH);
    expect(calls[0]?.params).toMatchObject({ sort_field: 'id', sort_direction: 'desc' });
    expect(out.queues[0]).toMatchObject({ id: 9001, total_added: 1322, success: 1300, fail: 22, progress_pct: 98 });
    expect(out.warnings).toEqual([]);
  });

  it('flags a queue that holds stuck tasks — SHM never finishes it', async () => {
    const out = await run({}, () => [queue(1, { finished_at: null, cnt_stuck: 3, cnt_pending: 3 })]);
    expect(out.warnings.map((one) => one.code)).toEqual(['spool_queue_stuck']);
    expect(out.warnings[0]?.message).toContain('#1');
  });

  it('keeps only unfinished queues when asked', async () => {
    const out = await run({ active_only: true }, () => [queue(2, { finished_at: null, cnt_pending: 5 }), queue(1)]);
    expect(out.queues.map((one) => one.id)).toEqual([2]);
  });

  it('has no percentage for a queue nothing was added to', async () => {
    const out = await run({}, () => [queue(3, { total_added: 0, cnt_success: 0, cnt_fail: 0 })]);
    expect(out.queues[0]?.progress_pct).toBeNull();
  });

  it('names a missing route as the SHM version, below 3.0.36', async () => {
    const out = await run({}, () => {
      throw new ShmError('Method not found', 404);
    });
    expect(out).toMatchObject({ available: false, queues: [], degraded: [] });
    expect(out.warnings.map((one) => one.code)).toEqual(['shm_route_absent']);
  });
});
