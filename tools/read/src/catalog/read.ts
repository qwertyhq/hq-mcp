import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { EMPTY_LIST, asRecord, capLimit, settle, take, warn } from '../kit.js';

const MAX_LIMIT = 500;

const ROUTES = {
  services: '/admin/service',
  order: '/admin/service/order',
  children: '/admin/service/children',
  events: '/admin/service/event',
  categories: '/admin/user/service/categories',
} as const;

/** v1.cgi:653-660 — GET /admin/service/children несёт required => ['service_id']. */
const REQUIRES_SERVICE_ID: readonly string[] = ['children'];

/**
 * Секции, где SHM действительно фильтрует по service_id:
 * - children — обязательный параметр ручки;
 * - services — Core::Service::list_for_api сужает where до одного тарифа
 *   (app/lib/Core/Service.pm:224-247).
 * Остальные три его игнорируют: price_list фильтрует по category и filter
 * (Service.pm:253-...), Events::list_for_api собирает where только из id и
 * kind (Events.pm:104-120) — в таблице events колонки service_id нет вовсе
 * (app/sql/shm/shm_structure.sql:163-171), — а categories вообще не берёт
 * аргументов (Service.pm:337-347). Отправить туда service_id — значит отдать
 * ГЛОБАЛЬНЫЙ список под видом списка одной услуги.
 */
const HONOURS_SERVICE_ID: readonly string[] = ['children', 'services'];

export const catalogRead = defineTool({
  name: 'catalog_read',
  description:
    'Read the service catalogue: tariffs, the order price list, child services, the event map ' +
    'and categories. This is the source of valid service_id values for any lifecycle work. ' +
    'Only "services" and "children" can be narrowed to one service_id; "order", "events" and ' +
    '"categories" are global lists and say so when a service_id is passed.',
  input: z.object({
    section: z
      .enum(['services', 'order', 'children', 'events', 'categories'])
      .default('order')
      .describe('Which slice of the catalogue to read'),
    service_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Required for section "children"; narrows "services"; ignored elsewhere'),
    limit: z
      .number()
      .int()
      .default(100)
      .describe(
        'Rows, capped at 500. Section "order" ignores it — SHM builds that price list without ' +
          'a LIMIT and returns every orderable service',
      ),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ section, service_id, limit }, ctx) => {
    if (REQUIRES_SERVICE_ID.includes(section) && service_id === null) {
      throw new Error(`catalog_read section "${section}" requires service_id`);
    }
    const cap = capLimit(limit, 100, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const params: Record<string, string | number | undefined> = { limit: cap };
    if (service_id !== null) {
      if (HONOURS_SERVICE_ID.includes(section)) {
        params.service_id = service_id;
      } else {
        warnings.push(
          warn(
            'service_id_ignored',
            `Section "${section}" is a global listing: SHM has no service_id filter on it, so the ` +
              'parameter was not sent and the rows below are not scoped to that service.',
          ),
        );
      }
    }

    const result = await settle(ctx.shm.list<unknown>(ROUTES[section], params));
    const list = take(result, 'shm', degraded, EMPTY_LIST);

    // Тот же тест, что в listOut (§6.4), но встроенный: сам listOut здесь
    // применить нельзя — он гонит строки через asRecord и стёр бы категории,
    // которые приезжают голыми строками. Проверка обрезания от формы строк не
    // зависит. /admin/service уходит в Sql::Data::list_for_api с calc => 1
    // (Data.pm:728-806), так что items — настоящий FOUND_ROWS(), и каталог
    // больше окна обязан сказать об этом вслух: «такого тарифа нет» иначе
    // опирается на необъявленное окно.
    // ...кроме "order". Там items — не FOUND_ROWS() этого перечня: v1.cgi:1760
    // отдаёт FOUND_ROWS() последнего выполненного SELECT, а api_price_list зовёт
    // list() без calc и потом на каждой позиции was_ever_provided (wd->list с
    // limit => 1) и cost_composite (->id()), каждый из которых сбрасывает счётчик
    // до ≤1 (Service.pm:255-327). Обычно это молча занижает; но если
    // order_only_once опустошит перечень, а последний SELECT строку нашёл, то
    // 1 > 0 поднимет truncated с советом «поднимите лимит» — на разделе, про
    // который двумя строками выше сказано, что лимит там не действует.
    const itemsIsRowCount = section !== 'order';
    if (itemsIsRowCount && list.items > list.data.length + list.offset) {
      warnings.push(
        warn(
          'truncated',
          `Section "${section}" returned ${String(list.data.length)} of ${String(list.items)} ` +
            `rows (limit ${String(list.limit)}, offset ${String(list.offset)}). "There is no ` +
            'such tariff, category or event" is a statement about this window, not about the ' +
            'catalogue. Raise the limit before concluding.',
        ),
      );
    }

    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'SHM did not answer (see `degraded`), so the catalogue came back empty rather than ' +
            'wrong. Nothing here proves a tariff, category or event does not exist.',
        ),
      );
    }

    return {
      section,
      items: list.items,
      limit: list.limit,
      offset: list.offset,
      // Не `.map(asRecord)`: categories приезжает голым списком строк
      // (selectcol_arrayref, Service.pm:337-347), и запись через asRecord
      // превратила бы каждую категорию в {} — «5 категорий» без единого имени.
      rows: list.data.map((row) => (row !== null && typeof row === 'object' ? asRecord(row) : row)),
      warnings,
      degraded,
    };
  },
});
