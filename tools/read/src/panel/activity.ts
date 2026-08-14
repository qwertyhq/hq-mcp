import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  asArray,
  asRecord,
  assertHumanOnly,
  capLimit,
  declaredTotal,
  envelope,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

/**
 * Пять читающих ручек, отвечающих на один вопрос — «что вообще происходит с
 * панелью»:
 *   system/stats/recap    — итог с момента установки: клиенты, ноды, трафик;
 *   system/stats/digest   — что изменилось за ОКНО (заводится, истекает, трафик);
 *   system/stats/http     — по каким маршрутам панель бьют и сколько раз;
 *   subscription-request-history        — кто дёргал подписку, чем и когда;
 *   subscription-request-history/stats  — разрез по приложениям и по часам.
 *
 * ДВА ОКНА, КОТОРЫЕ НЕЛЬЗЯ СКЛАДЫВАТЬ, и это причина, по которой они собраны
 * в одном инструменте, а не в трёх: digest берёт границы от вызывающего,
 * почасовая статистика обращений — своё собственное окно (на работающей панели
 * оно оказалось в 49 часов), а http-счётчики не называют период вовсе. Три
 * числа про «активность», посчитанные за три разных отрезка, в одном ответе
 * обязаны быть подписаны своими отрезками — иначе первое же сравнение будет
 * неправдой.
 *
 * DIGEST ТРЕБУЕТ ГРАНИЦ. Проверено на работающей панели 3.2.3, а не в схеме: без
 * `start` и `end` ручка отвечает 400 «Invalid input: expected string, received
 * undefined» по обоим полям. Отсутствие окна — не «весь период», а отказ.
 */
const RECAP_PATH = '/api/system/stats/recap';
const DIGEST_PATH = '/api/system/stats/digest';
const HTTP_PATH = '/api/system/stats/http';
const HISTORY_PATH = '/api/subscription-request-history';
const HISTORY_STATS_PATH = '/api/subscription-request-history/stats';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const MAX_ROUTES = 100;
const MAX_DAYS = 365;

interface RequestRecord {
  id: number | null;
  userId: number | null;
  requestAt: string | null;
  /** Имя выбрано под редакцию профиля bot: панель зовёт его `requestIp` (см. device_inventory). */
  ip: string | null;
  userAgent: string | null;
  srrRuleName: string | null;
  srrResponseType: string | null;
}

export const panelActivity = defineTool({
  name: 'panel_activity',
  description:
    'What is happening to the Remnawave panel itself: the all-time recap (clients, nodes, ' +
    'traffic, version, install date), a digest over a window you choose (clients created, ' +
    'clients expired, devices bound, traffic), which HTTP routes are being hit and how often, ' +
    'and the subscription request history — who pulled their subscription, with which app, and ' +
    'which response rule matched. ' +
    'THREE DIFFERENT WINDOWS ARE REPORTED SIDE BY SIDE AND MUST NOT BE ADDED UP: the digest ' +
    'covers exactly the days you ask for, the hourly request stats cover the panel\'s own fixed ' +
    'window, and the HTTP counters name no period at all — the panel does not say whether they ' +
    'count since install or since the last restart. Each is labelled with what it actually ' +
    'covers. ' +
    'The response-rule name on each request row is the useful part for support: it says which ' +
    'SRR rule the client\'s app matched, so "the client gets the wrong config format" becomes a ' +
    'question with an answer. If every request in the window matched the same fallback rule, ' +
    'that is reported — it means the specific rules are matching nobody. ' +
    'Request rows carry the client address under the field name `ip` deliberately, so profile ' +
    'redaction can see it.',
  input: z.object({
    days: z
      .number()
      .int()
      .positive()
      .default(7)
      .describe('Digest window in days, ending now. The panel refuses this call without bounds'),
    limit: z.number().int().default(DEFAULT_LIMIT).describe('Request-history rows, capped at 200'),
    offset: z.number().int().min(0).default(0).describe('Window start inside the request history'),
    top_routes: z.number().int().default(20).describe('HTTP routes returned, busiest first, capped at 100'),
    include_requests: z
      .boolean()
      .default(true)
      .describe('Include the raw request-history window; off returns only aggregates'),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * Только human. Аггрегаты сами по себе безобидны, но request-history — это
   * поток адресов и user-agent'ов всей базы, то есть та же массовая выгрузка
   * PII, за которую human-only объявлен device_inventory, а состав ответа
   * (версия панели, карта её маршрутов, объёмы) — операторская картина, а не
   * ответ клиенту. Дробить инструмент по профилю ради аггрегатов значило бы
   * завести два имени для одного вопроса.
   */
  profiles: ['human'],
  backends: ['remna'],
  handler: async ({ days, limit, offset, top_routes, include_requests }, ctx) => {
    assertHumanOnly(
      ctx,
      'panel_activity is available to the human profile only: the request history is a ' +
        'fleet-wide stream of client addresses and user agents, and the rest is the operator ' +
        "picture of the panel itself — neither is an answer to a client's question (§7.2).",
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);
    const routeCap = capLimit(top_routes, 20, MAX_ROUTES);
    const window = capLimit(days, 7, MAX_DAYS);

    const end = ctx.now();
    const start = new Date(end.getTime() - window * 86_400_000);

    const [recap, digest, http, history, historyStats] = await Promise.all([
      settle(ctx.remna.get<unknown>(RECAP_PATH)),
      settle(
        ctx.remna.get<unknown>(DIGEST_PATH, { start: start.toISOString(), end: end.toISOString() }),
      ),
      settle(ctx.remna.get<unknown>(HTTP_PATH)),
      include_requests
        ? settle(ctx.remna.get<unknown>(HISTORY_PATH, { size: cap, start: offset }))
        : Promise.resolve({ ok: true as const, value: null }),
      settle(ctx.remna.get<unknown>(HISTORY_STATS_PATH)),
    ]);

    const recapBody = asRecord(take(recap, 'remna', degraded, null));
    const digestBody = asRecord(take(digest, 'remna', degraded, null));
    const httpBody = asRecord(take(http, 'remna', degraded, null));
    const allRoutes = asArray(httpBody.routes)
      .map(asRecord)
      .map((row) => ({
        method: str(row.method),
        route: str(row.route),
        count: optionalNumber(row.count),
      }));

    const statsBody = asRecord(take(historyStats, 'remna', degraded, null));
    const byApp = asArray(statsBody.byParsedApp)
      .map(asRecord)
      .map((row) => ({ app: str(row.app), count: optionalNumber(row.count) }));
    const hourly = asArray(statsBody.hourlyRequestStats).map(asRecord);
    const hourlyCounts = hourly.map((row) => optionalNumber(row.requestCount) ?? 0);

    // См. device_inventory: строки берутся из `envelope`, а «сервер назвал
    // число» — из `declaredTotal`, потому что первый подставляет длину среза.
    const historyBody = take(history, 'remna', degraded, null);
    const listing = include_requests ? envelope(historyBody, 'records') : { rows: [], total: 0 };
    const records: RequestRecord[] = listing.rows.map((row) => ({
      id: optionalNumber(row.id),
      userId: optionalNumber(row.userId),
      requestAt: str(row.requestAt),
      ip: str(row.requestIp),
      userAgent: str(row.userAgent),
      srrRuleName: str(row.srrRuleName),
      srrResponseType: str(row.srrResponseType),
    }));
    const serverTotal = include_requests && history.ok ? declaredTotal(historyBody) : null;

    const rules = [...new Set(records.map((one) => one.srrRuleName).filter((one): one is string => one !== null))];
    if (records.length > 0 && rules.length === 1) {
      warnings.push(
        warn(
          'srr_single_rule_matched',
          `Every one of the ${String(records.length)} requests in this window matched the same ` +
            `response rule ("${rules[0] ?? ''}"). If that is a fallback, the specific rules ` +
            'above it are matching nobody, and every client is being served the fallback format ' +
            'regardless of what their app asked for. This window is a slice, so confirm on a ' +
            'wider one before rewriting rules — but a uniform result across a busy window is ' +
            'rarely a coincidence.',
        ),
      );
    }
    if (http.ok && allRoutes.length > 0) {
      warnings.push(
        warn(
          'http_stats_period_unstated',
          'The panel returns HTTP route counters without saying what period they cover — not ' +
            'since install, not since restart, it simply does not say. Use them for the SHAPE ' +
            'of the traffic (which routes dominate, which are never called) and never as a rate ' +
            'or a comparison against the digest window below.',
        ),
      );
    }
    if (digest.ok && historyStats.ok && hourly.length > 0) {
      warnings.push(
        warn(
          'stats_windows_differ',
          `The digest covers the ${String(window)} day(s) you asked for; the hourly request ` +
            `stats cover the panel's own fixed window of ${String(hourly.length)} hour(s), which ` +
            'this tool cannot change. The two numbers describe different stretches of time and ' +
            'must not be compared or added.',
        ),
      );
    }
    if (serverTotal !== null && serverTotal > offset + records.length) {
      warnings.push(
        warn(
          'truncated',
          `The request window holds ${String(records.length)} of ${String(serverTotal)} rows ` +
            `(limit ${String(cap)}, offset ${String(offset)}). Counts taken from this slice are ` +
            'about the slice; `byApp` comes from the panel and covers its whole window.',
        ),
      );
    }
    if (include_requests && history.ok && serverTotal === null) {
      warnings.push(
        warn(
          'server_count_absent',
          'The panel did not return a `total` for the request history, so whether this window is ' +
            'the whole set cannot be checked here.',
        ),
      );
    }
    if (allRoutes.length > routeCap) {
      warnings.push(
        warn(
          'top_list_truncated',
          `${String(routeCap)} of ${String(allRoutes.length)} HTTP routes are shown, busiest ` +
            'first. A route missing below is not one that was never called — raise `top_routes`.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). A missing section is unknown, not ' +
            'zero: an empty request history read as "nobody pulled their subscription" is the ' +
            'exact mistake this warning exists to prevent.',
        ),
      );
    }

    return {
      recap: recap.ok
        ? {
            version: str(recapBody.version),
            initDate: str(recapBody.initDate),
            thisMonth: asRecord(recapBody.thisMonth),
            total: asRecord(recapBody.total),
          }
        : null,
      digest: digest.ok
        ? {
            from: start.toISOString(),
            to: end.toISOString(),
            days: window,
            users: asRecord(digestBody.users),
            traffic: asRecord(digestBody.traffic),
            hwidDevices: asRecord(digestBody.hwidDevices),
          }
        : null,
      http: http.ok
        ? {
            /** Что сказал сервер: сумма по ВСЕМ маршрутам, а не по показанным. */
            declared_total: optionalNumber(httpBody.total),
            routeCount: allRoutes.length,
            /** Период неизвестен — см. предупреждение http_stats_period_unstated. */
            routes: [...allRoutes]
              .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
              .slice(0, routeCap),
          }
        : null,
      requests: {
        byApp,
        hourlyWindowHours: historyStats.ok ? hourly.length : null,
        hourlyTotal: historyStats.ok ? hourlyCounts.reduce((sum, one) => sum + one, 0) : null,
        window: include_requests
          ? { items: serverTotal, limit: cap, offset, returned: records.length, data: records }
          : null,
      },
      warnings,
      degraded,
    };
  },
});

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
