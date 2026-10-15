import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asRecord, assertHumanOnly, capLimit, errMessage, httpStatus, num, str, warn } from '../kit.js';

export const SPOOL_QUEUES_PATH = '/admin/spool/queues';

const MAX_LIMIT = 200;

/**
 * ОЧЕРЕДИ МАССОВЫХ ЗАДАЧ SHM — ДАННЫЕ, КОТОРЫХ ДО 3.0 НЕ БЫЛО.
 *
 * С 3.0.36 (миграция 3.0.23) каждая массовая задача (Core::Jobs: `job_users`, рассылки,
 * пересчёты) раскладывается по отдельной строке `spool_queues`, и сама SHM
 * ведёт по ней счётчики: сколько задач поставлено (`total_added`), сколько
 * кончилось успехом, ошибкой, пропуском, сколько зависло и сколько ещё в
 * работе (`cnt_pending`), плюс `rate_limit` и статус active/paused
 * (Core::SpoolQueue, migrations/3.0.23.sql). До этого «дошла ли рассылка до
 * всех» считали руками по `spool_history` и ловили частичное число, пока
 * хвост ещё в работе.
 *
 * `finished_at` SHM ставит только когда `cnt_pending = 0` И `cnt_stuck = 0`
 * (SpoolQueue::on_task_finish), поэтому очередь с зависшими задачами не
 * «закончится» никогда — это и есть находка, а не задержка.
 *
 * Процент — по формуле самой SHM (SpoolQueue::progress): успех + пропуск от
 * поставленного. Ошибки в него не входят.
 */
interface Queue {
  id: number;
  name: string | null;
  status: string | null;
  rate_limit: number | null;
  created_at: string | null;
  last_executed_at: string | null;
  finished_at: string | null;
  total_added: number;
  success: number;
  fail: number;
  skipped: number;
  delayed: number;
  stuck: number;
  paused: number;
  pending: number;
  progress_pct: number | null;
}

function toQueue(row: Record<string, unknown>): Queue {
  const total = num(row.total_added, 0);
  const success = num(row.cnt_success, 0);
  const skipped = num(row.cnt_skipped, 0);
  const rate = num(row.rate_limit, Number.NaN);
  return {
    id: num(row.id, 0),
    name: str(row.name),
    status: str(row.status),
    rate_limit: Number.isFinite(rate) ? rate : null,
    created_at: str(row.created_at),
    last_executed_at: str(row.last_executed_at),
    finished_at: str(row.finished_at),
    total_added: total,
    success,
    fail: num(row.cnt_fail, 0),
    skipped,
    delayed: num(row.cnt_delayed, 0),
    stuck: num(row.cnt_stuck, 0),
    paused: num(row.cnt_paused, 0),
    pending: num(row.cnt_pending, 0),
    progress_pct: total > 0 ? Math.round(((success + skipped) / total) * 100) : null,
  };
}

export const spoolQueues = defineTool({
  name: 'spool_queues',
  description:
    'SHM 3.0.36+: the queues of mass tasks (broadcasts, job_users and other bulk jobs) with the ' +
    "counters SHM keeps itself — added, success, fail, skipped, stuck, paused, still pending — " +
    'its rate limit and active/paused status. Answers "did the broadcast reach everyone" without ' +
    'counting spool_history by hand while the tail is still running. A queue with stuck tasks ' +
    'never gets finished_at: that is a finding, not a delay. Newest first. On SHM below 3.0.36 ' +
    'the route does not exist and the tool says so. Read-only: pausing, resuming and deleting ' +
    'queues are deliberately not implemented here.',
  input: z.object({
    id: z.number().int().positive().nullable().default(null).describe('One queue by id.'),
    active_only: z
      .boolean()
      .default(false)
      .describe('Only queues SHM has not marked finished (finished_at is empty).'),
    limit: z.number().int().default(20).describe('Queues, newest first; capped at 200.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  backends: ['shm'],
  handler: async ({ id, active_only, limit }, ctx) => {
    assertHumanOnly(ctx, 'spool_queues is available to the human profile only: queue names describe internal broadcasts and jobs');
    const cap = capLimit(limit, 20, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    try {
      const page = await ctx.shm.list<Record<string, unknown>>(SPOOL_QUEUES_PATH, {
        ...(id === null ? {} : { id }),
        sort_field: 'id',
        sort_direction: 'desc',
        limit: cap,
        offset: 0,
      });
      let queues = page.data.map((row) => toQueue(asRecord(row)));
      if (active_only) queues = queues.filter((one) => one.finished_at === null);
      if (page.items > page.data.length) {
        warnings.push(
          warn(
            'truncated',
            `"${SPOOL_QUEUES_PATH}" holds ${String(page.items)} queues; the ${String(page.data.length)} ` +
              'newest were read' +
              (active_only ? ' and filtered client-side, so older unfinished queues may be missing.' : '.'),
          ),
        );
      }
      const stuck = queues.filter((one) => one.stuck > 0);
      if (stuck.length > 0) {
        warnings.push(
          warn(
            'spool_queue_stuck',
            `${String(stuck.length)} queue(s) hold stuck tasks (${stuck.map((one) => `#${String(one.id)}`).join(', ')}): ` +
              'SHM will not mark them finished until those are resolved — see spool_inspect.',
          ),
        );
      }
      return { available: true, items: page.items, queues, warnings, degraded };
    } catch (caught: unknown) {
      if (httpStatus(caught) === 404) {
        warnings.push(
          warn(
            'shm_route_absent',
            `SHM has no ${SPOOL_QUEUES_PATH}: mass-task queues appeared in SHM 3.0.36 (migration 3.0.23). Below it, ` +
              'read spool_history through spool_inspect / notify_history instead.',
          ),
        );
        return { available: false, items: null, queues: [], warnings, degraded };
      }
      degraded.push({ system: 'shm', error: errMessage(caught) });
      return { available: null, items: null, queues: [], warnings, degraded };
    }
  },
});
