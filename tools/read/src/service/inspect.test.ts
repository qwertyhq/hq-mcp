import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { serviceInspect } from './inspect.js';

interface InspectOut {
  services: Array<{
    user_service_id: number;
    status: string | null;
    next: number | null;
    spool: unknown[];
  }>;
  items: number;
  limit: number;
  warnings: Array<{ code: string }>;
}

const services = [
  { user_service_id: 51, service_id: 21, name: 'Trial', status: 'ACTIVE', expire: '2026-09-01', next: 21 },
  { user_service_id: 52, service_id: 22, name: 'Family', status: 'PROGRESS', expire: null, next: -1 },
];

/**
 * Реальная форма строки спула. Колонка `spool.user_service_id` существует
 * (app/sql/shm/shm_structure.sql:176), но провижининг её не заполняет:
 * USObject::make_commands_by_event кладёт id услуги в settings
 * (USObject.pm:463 `$args{settings}{user_service_id} = $self->id + 0`), а
 * Core::Base::_add_or_set (Base.pm:332-374) ключи settings в колонки не
 * переносит. Именно поэтому /admin/user/service/spool ищет задачи через
 * list_by_settings, то есть по `settings.user_service_id` (USObject.pm:558,
 * Base.pm:497). Статусы — из Core::Const.pm:78-83; 'ERROR' спул не выдаёт.
 */
const spool = [
  {
    id: 900,
    user_id: 3073,
    user_service_id: null,
    status: 'DELAYED',
    event: { name: 'PROLONGATE' },
    settings: { user_service_id: 51 },
  },
  {
    id: 901,
    user_id: 3073,
    user_service_id: null,
    status: 'FAIL',
    event: { name: 'CREATE' },
    settings: { user_service_id: 52 },
  },
];

describe('service_inspect', () => {
  it('attaches spool tasks to their service', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: null },
      ctx,
    )) as InspectOut;
    expect(result.services).toHaveLength(2);
    expect(result.services[0]?.spool).toHaveLength(1);
    expect(result.services[1]?.spool).toHaveLength(1);
  });

  it('warns that next=-1 deletes the service and that PROGRESS blocks actions', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: null },
      ctx,
    )) as InspectOut;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('next_deletes_service');
    expect(codes).toContain('service_in_progress');
  });

  it('filters down to one service when asked', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: 51 },
      ctx,
    )) as InspectOut;
    expect(result.services).toHaveLength(1);
    expect(result.services[0]?.user_service_id).toBe(51);
    expect(result.warnings.map((w) => w.code)).not.toContain('next_deletes_service');
  });

  it('never lets "no such service" hide a filled window', async () => {
    // Именно на этом ответе план 2 строит assertOwnsService: если items больше
    // отданных строк, «услуга клиенту не принадлежит» — недоказуемое утверждение.
    const ctx = makeCtx({
      shmList: (path, params) =>
        path === '/admin/user/service'
          ? { items: 940, limit: Number(params?.limit ?? 200), offset: 0, data: services }
          : spool,
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: null },
      ctx,
    )) as InspectOut;
    expect(result.items).toBe(940);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  // Not in the brief's Step 1 fixture set. SHM's UserService::list_for_api
  // (app/lib/Core/UserService.pm:435-436 in shm-fork-from-orig) applies
  // `where.parent=NULL` and `where.status!=REMOVED` by default whenever the
  // call does not narrow to one row server-side — which this tool never does,
  // it always lists by user_id and filters client-side. So every answer from
  // this tool silently omits children of composite tariffs and removed
  // services; "the client's services" must not be read as exhaustive without
  // this being said out loud.
  it('states that the default listing hides composite children and removed services', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: null },
      ctx,
    )) as InspectOut;
    expect(result.warnings.map((w) => w.code)).toContain('excludes_children_and_removed');
  });

  // Not in the brief's Step 1 fixture set. The route this tool used to read,
  // GET /admin/user/service/spool, is declared with
  // `required => ['user_id','user_service_id']` (app/public_html/shm/v1.cgi:
  // 877-884) and the dispatcher answers 400 before the controller runs when a
  // required field is absent (v1.cgi:1692-1698). Called with user_id alone it
  // returned 400 on EVERY call, silently swallowed into `degraded`, so the
  // `spool` array of every service was permanently empty. The queue is read
  // from /admin/spool instead: `user_id` genuinely scopes it server-side
  // (Sql/Data.pm:750-754 puts it into `where` for admin calls), it is the same
  // table, and one call covers every service of the client.
  it('reads the queue from a route that does not 400 on a missing user_service_id', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    await serviceInspect.handler({ shm_user_id: 3073, user_service_id: null }, ctx);

    expect(calls.some((call) => call.path === '/admin/user/service/spool')).toBe(false);
    const queue = calls.find((call) => call.path === '/admin/spool');
    expect(queue?.params).toEqual({ user_id: 3073, limit: 200 });
  });

  // Not in the brief's Step 1 fixture set. See the `spool` fixture comment:
  // the column is NULL on every provisioning task, so matching on it attached
  // nothing at all — the original fixture only passed because it invented a
  // populated column.
  it('attaches tasks by the settings key rather than the empty column', async () => {
    const ctx = makeCtx({
      shmList: (path) => (path === '/admin/user/service' ? services : spool),
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: 52 },
      ctx,
    )) as InspectOut;
    expect(result.services[0]?.spool).toHaveLength(1);
  });

  // Not in the brief's Step 1 fixture set. `degraded` was already returned by
  // Step 3's reference handler but nothing in `warnings` ever pointed at it —
  // exactly the silent-partial-result shape client_overview.ts's carry-forward
  // comment warns against.
  it('flags a partial result instead of staying silent when the spool call fails', async () => {
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === '/admin/spool') throw new Error('SHM 500');
        return services;
      },
    });
    const result = (await serviceInspect.handler(
      { shm_user_id: 3073, user_service_id: null },
      ctx,
    )) as InspectOut;
    expect(result.services.every((s) => s.spool.length === 0)).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });
});
