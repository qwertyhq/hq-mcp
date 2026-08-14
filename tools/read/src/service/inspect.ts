import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asRecord,
  listOut,
  num,
  settle,
  spoolUserServiceId,
  withoutSpoolSecrets,
  str,
  take,
  warn,
} from '../kit.js';

export const serviceInspect = defineTool({
  name: 'service_inspect',
  description:
    'Services of one client with their statuses, expiry, the scheduled next tariff and the spool ' +
    'tasks attached to each. Use it before any lifecycle decision: a service in PROGRESS silently ' +
    'refuses changes and next=-1 means the service is scheduled for deletion. The default SHM ' +
    'listing this tool reads hides child services of composite tariffs and removed services — see ' +
    'the excludes_children_and_removed warning on every answer.',
  input: z.object({
    shm_user_id: z.number().int().positive(),
    user_service_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Narrow the answer to one service'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, user_service_id }, ctx) => {
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const [services, spool] = await Promise.all([
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
          user_id: shm_user_id,
          limit: 200,
        }),
      ),
      // НЕ /admin/user/service/spool: тот маршрут объявлен с
      // required => ['user_id','user_service_id'] (app/public_html/shm/v1.cgi:
      // 877-884), а диспетчер отвечает 400 ещё до контроллера, когда
      // обязательное поле не пришло (v1.cgi:1692-1698). Этот инструмент по
      // умолчанию перечисляет ВСЕ услуги клиента и второй id передать не может,
      // поэтому там был гарантированный 400 на каждом вызове, молча уезжавший
      // в degraded: массив `spool` каждой услуги был вечно пуст. `/admin/spool`
      // — та же таблица, и `user_id` сужает её на стороне сервера
      // (Sql/Data.pm:750-754 кладёт его в where для админских вызовов).
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/spool', {
          user_id: shm_user_id,
          limit: 200,
        }),
      ),
    ]);

    // items наружу (§6.4): «такой услуги у клиента нет» и «услуга не попала в
    // окно из 200 строк» — разные утверждения, и путать их нельзя, потому что
    // на первом строится проверка владения в мутаторах.
    const spoolList = listOut(take(spool, 'shm', degraded, EMPTY_LIST), warnings, 'spool');
    const serviceList = listOut(take(services, 'shm', degraded, EMPTY_LIST), warnings, 'services');
    const spoolRows = spoolList.data;
    const rows = serviceList.data.filter(
      (row) => user_service_id === null || num(row.user_service_id) === user_service_id,
    );

    const result = rows.map((row) => {
      const id = num(row.user_service_id);
      const next = row.next === null || row.next === undefined ? null : num(row.next);
      return {
        user_service_id: id,
        service_id: num(row.service_id, 0),
        name: str(row.name),
        status: str(row.status),
        expire: str(row.expire),
        next,
        cost: row.cost === undefined ? null : num(row.cost),
        auto_bill: row.auto_bill === undefined ? null : num(row.auto_bill),
        // Через settings, а не через колонку: колонка `spool.user_service_id`
        // на задачах провижининга всегда NULL — см. spoolUserServiceId в kit.
        // Строки очереди отдаются наружу СЫРЫМИ, поэтому через общий фильтр:
        // у провалившейся задачи рассылки в `response.request.url` лежит токен
        // бота, а редакция его не видит — она маскирует по имени поля. См.
        // withoutSpoolSecrets в kit.
        spool: spoolRows
          .filter((task) => spoolUserServiceId(task) === id)
          .map(withoutSpoolSecrets),
      };
    });

    if (result.some((service) => service.next === -1)) {
      warnings.push(
        warn(
          'next_deletes_service',
          'A service carries next=-1: when the period ends the service is deleted, not renewed.',
        ),
      );
    }
    if (result.some((service) => (service.status ?? '').toUpperCase().includes('PROGRESS'))) {
      warnings.push(
        warn(
          'service_in_progress',
          'A service is in PROGRESS: change/touch/activate on it answer 200 with an empty result ' +
            'and do nothing. Wait for the spool task to finish before acting.',
        ),
      );
    }
    // Безусловно: GET /admin/user/service никогда здесь не сужается до одной
    // строки на стороне SHM (фильтр по user_service_id — клиентский, ниже по
    // файлу), поэтому UserService::list_for_api каждый раз применяет свои
    // умолчания where.parent=NULL и where.status!=REMOVED (UserService.pm:
    // 440-441). «Услуг у клиента нет» без этой строки — недоказанное
    // утверждение: composite-дети и удалённые услуги просто не приехали.
    warnings.push(
      warn(
        'excludes_children_and_removed',
        'This listing never includes child services of composite tariffs (parent != NULL) or ' +
          'removed services (status=REMOVED) — SHM applies that filter by default and this tool ' +
          'has no way to override it. Absence here is not proof the client never had such a service.',
      ),
    );
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the systems did not answer (see `degraded`); the fields it owns — spool tasks ' +
            'or the service list itself — are empty rather than wrong.',
        ),
      );
    }

    return {
      services: result,
      items: serviceList.items,
      limit: serviceList.limit,
      offset: serviceList.offset,
      warnings,
      degraded,
    };
  },
});
