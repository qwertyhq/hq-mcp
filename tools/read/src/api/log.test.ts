import { describe, expect, it } from 'vitest';
import { ShmError } from '@hq/shm';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { API_LOG_PATH, apiLog } from './log.js';

interface Out {
  available: boolean | null;
  items: number | null;
  returned: number;
  calls: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const ROW = {
  user_id: 4242,
  date: '2026-10-15 09:00:00',
  ip: '203.0.113.40',
  url: '/shm/v1/user/passwd',
  method: 'POST',
  args: { password: '***' },
  descr: null,
  duration: 41,
  response_code: 400,
  response_error: 'OLD_PASSWORD_REQUIRED',
};

async function run(input: Record<string, unknown>, shmList: (path: string) => unknown, calls: StubCall[] = []): Promise<Out> {
  const ctx = makeCtx({ calls, shmList });
  return (await apiLog.handler(apiLog.input.parse(input), ctx)) as Out;
}

describe('api_log', () => {
  it('asks about a client through filter, never through ?user_id= (that would switch_user)', async () => {
    const calls: StubCall[] = [];
    await run({ shm_user_id: 4242, response_code: 400 }, () => [ROW], calls);
    expect(calls[0]?.path).toBe(API_LOG_PATH);
    expect(calls[0]?.params).toMatchObject({
      filter: JSON.stringify({ user_id: 4242, response_code: 400 }),
      sort_field: 'date',
      sort_direction: 'desc',
    });
    expect(calls[0]?.params).not.toHaveProperty('user_id');
  });

  it('reads one call into named fields and keeps an anonymous call anonymous', async () => {
    const out = await run({}, () => [ROW, { ...ROW, user_id: 0 }]);
    expect(out.available).toBe(true);
    expect(out.calls[0]).toMatchObject({
      user_id: 4242,
      method: 'POST',
      url: '/shm/v1/user/passwd',
      response_code: 400,
      response_error: 'OLD_PASSWORD_REQUIRED',
      duration_ms: 41,
    });
    expect(out.calls[1]?.user_id).toBeNull();
  });

  it('says the window is cut when SHM holds more matching calls', async () => {
    const out = await run({ limit: 1 }, () => ({ items: 9, limit: 1, offset: 0, data: [ROW] }));
    expect(out.warnings.map((one) => one.code)).toContain('truncated');
  });

  it('names a missing route as the SHM version, not as an empty log', async () => {
    const out = await run({}, () => {
      throw new ShmError('Method not found', 404);
    });
    expect(out).toMatchObject({ available: false, calls: [], degraded: [] });
    expect(out.warnings.map((one) => one.code)).toEqual(['shm_route_absent']);
  });

  it('reports any other failure as degraded, not as an old version', async () => {
    const out = await run({}, () => {
      throw new ShmError('Forbidden', 403);
    });
    expect(out.available).toBeNull();
    expect(out.degraded).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  });
});
