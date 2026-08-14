import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import { asArray, asRecord, capLimit, num, settle, str, take, warn, ymd } from '../kit.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Окно по умолчанию и потолок. Обе границы включительно, как у панели. */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;

/**
 * `topNodesLimit` у /api/bandwidth-stats/users/{id} — и что он на самом деле
 * режет.
 *
 * В 3.2.3 он режет ТОЛЬКО `topNodes`, а `series` приезжает по всем нодам, где у
 * клиента вообще есть байты. Проверено на работающей панели: при
 * `topNodesLimit: 1` ответ содержал `topNodes` из одной строки, а `series` — по
 * всем нодам с байтами, и `sparklineData` посуточно совпала с суммой всех рядов.
 * (Ровно по этой причине `series` здесь — единственный источник цифр, а
 * `topNodes` не читается вовсе.)
 *
 * Просим всё равно с запасом на весь флот и всё равно сверяем: обещание
 * «series не режется» не записано ни в одном контракте, а урок country_health
 * — что предел такого параметра меняется молча и превращает работающую ноду в
 * «ноль байт».
 */
const TOP_NODES = 100;

/** Сквадов у клиента единицы; предел стоит от панели, которая однажды отдаст сотню. */
const SQUAD_FANOUT = 10;

const DEFAULT_ROWS = 250;
const MAX_ROWS = 1000;

/**
 * Граница с subscription_inspect, произнесённая вслух в обоих инструментах.
 * Карта пользователя несёт ДВА счётчика (`usedTrafficBytes` с последнего
 * сброса и `lifetimeUsedTrafficBytes` за всё время) и ни одного ряда по дням;
 * здесь — наоборот. У давнего клиента счётчик за всё время идёт на тысячи
 * гигабайт, а недельное окно — на сотни: числа не сходятся и не должны, и
 * вычитать одно из другого нельзя.
 */
export const TRAFFIC_SCOPE_WARNING: ToolWarning = {
  code: 'traffic_window_is_not_lifetime',
  message:
    'These are per-day sums inside the requested window, taken from the panel usage tables. ' +
    'They are a different measurement from the two counters on the user card that ' +
    'subscription_inspect reports (`usedBytes` since the last reset, `lifetimeBytes` since ever), ' +
    'and the three will not add up: the window is a slice, the counters are running totals with ' +
    'their own reset schedule. Use this tool for "where and when did the traffic go" and ' +
    'subscription_inspect for "how much has this subscriber used against the limit".',
};

interface Window {
  start: string;
  end: string;
  days: number;
}

function windowOf(now: Date, back: number): Window {
  return {
    // Даты — YYYY-MM-DD в UTC: панель хранит трафик в UTC, а ctx.shmTz
    // существует для наивных штампов SHM и здесь неприменим (§6.17).
    start: ymd(new Date(now.getTime() - back * DAY_MS)),
    end: ymd(now),
    days: back + 1,
  };
}

/** Ряд графика панели: {uuid, name, countryCode, total, data[]}. */
function seriesRows(chart: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(chart.series).map(asRecord);
}

export const trafficStats = defineTool({
  name: 'traffic_stats',
  description:
    'Where a client\'s traffic actually went: per-day bytes over a window, broken down by node ' +
    'and by internal squad, or the other way round — the traffic leaderboard of one squad or one ' +
    'node. This is the time series; subscription_inspect reports the running counters on the ' +
    'user card (used since reset, used lifetime), and the two measure different things and will ' +
    'not reconcile. Squad rows are NOT a partition of the total: the panel scopes them by the ' +
    'nodes a squad reaches, two squads reaching the same node both count that node\'s bytes, and ' +
    'the answer says so whenever the squads it returns overlap. Every list carries what the ' +
    'server said about its own size and warns when a top-N or a page limit could have hidden ' +
    'rows, because a client outside the cut looks exactly like a client with no traffic.',
  input: z
    .object({
      user_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe('Remnawave numeric user id (3.x has no user uuid): one client across the fleet'),
      squad_uuid: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe('Internal squad uuid: who inside that squad moved bytes in the window'),
      node_uuid: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe('Node uuid: who moved bytes through that node in the window'),
      days: z
        .number()
        .int()
        .default(DEFAULT_DAYS)
        .describe('Days back from today, both ends inclusive; capped at 31'),
      limit: z
        .number()
        .int()
        .default(DEFAULT_ROWS)
        .describe('Squad/node scope: rows to request, capped at 1000'),
    })
    // `.refine`, не `.transform`: реестр требует живой `.shape` у input
    // (packages/registry:76), иначе публиковать в MCP нечего.
    .refine(
      (one) =>
        [one.user_id, one.squad_uuid, one.node_uuid].filter((value) => value !== null).length === 1,
      {
        message: 'Pass exactly one of `user_id`, `squad_uuid` or `node_uuid`.',
        path: ['user_id'],
      },
    ),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ user_id, squad_uuid, node_uuid, days, limit }, ctx) => {
    const warnings: ToolWarning[] = [TRAFFIC_SCOPE_WARNING];
    const degraded: Degraded[] = [];
    const win = windowOf(ctx.now(), capLimit(days, DEFAULT_DAYS, MAX_DAYS));
    const rows = capLimit(limit, DEFAULT_ROWS, MAX_ROWS);
    const shared: Shared = { warnings, degraded, win, rows };

    if (user_id !== null) return await forUser(user_id, shared, ctx);
    if (squad_uuid !== null) return await forSquad(squad_uuid, shared, ctx);
    return await forNode(node_uuid ?? '', shared, ctx);
  },
});

interface Shared {
  warnings: ToolWarning[];
  degraded: Degraded[];
  win: Window;
  rows: number;
}

function notePartial(shared: Shared, emptyMeans: string): void {
  if (shared.degraded.length === 0) return;
  shared.warnings.push(
    warn(
      'partial_result',
      `A panel call did not answer (see \`degraded\`); the part it owns is empty rather than ` +
        `wrong. Zero bytes here is not evidence that ${emptyMeans}.`,
    ),
  );
}

async function forUser(
  userId: number,
  shared: Shared,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const id = String(userId);
  const { start, end } = shared.win;

  // Карта читается ПЕРВОЙ и не ради украшения: ручка трафика на неизвестном id
  // отвечает 200 с пустыми series (проверено на работающей панели — id 99999999
  // вернул categories и sparkline из нулей), то есть «такого клиента нет» и
  // «клиент ничего не качал» без неё неотличимы.
  const [card, chart, nodes] = await Promise.all([
    settle(ctx.remna.get<unknown>(`/api/users/${id}`)),
    settle(
      ctx.remna.get<unknown>(`/api/bandwidth-stats/users/${id}`, {
        start,
        end,
        topNodesLimit: TOP_NODES,
      }),
    ),
    settle(ctx.remna.get<unknown>('/api/nodes')),
  ]);

  const safe = asRecord(take(card, 'remna', shared.degraded, null));
  const chartValue = asRecord(take(chart, 'remna', shared.degraded, null));
  const nodeValue = take(nodes, 'remna', shared.degraded, null);
  const fleet = asArray(asRecord(nodeValue).nodes ?? nodeValue)
    .map(asRecord)
    .filter((row) => str(row.uuid) !== null);

  const foundId = num(safe.id, Number.NaN);
  const found = card.ok && Number.isFinite(foundId) && foundId > 0;

  const categories = asArray(chartValue.categories)
    .map((one) => str(one))
    .filter((one): one is string => one !== null);
  const series = seriesRows(chartValue);
  const topNodes = asArray(chartValue.topNodes).map(asRecord);
  const byNode = series.map((row) => ({
    nodeUuid: str(row.uuid),
    name: str(row.name),
    countryCode: str(row.countryCode)?.toUpperCase() ?? null,
    totalBytes: num(row.total),
    // Ряд по дням отдаётся целиком: за восемь суток шестичасовой провал — это
    // ~3% суммы, то есть в total его не видно вовсе (тот же довод, что и в
    // country_health).
    daily: asArray(row.data).map((one) => num(one)),
  }));
  const totalBytes = byNode.reduce((sum, row) => sum + row.totalBytes, 0);

  // Сквады клиента — из его же карты: `activeInternalSquads` несёт uuid и имя
  // (выверено на работающей 3.2.3), поэтому отдельного списка сквадов не нужно.
  const squads = asArray(safe.activeInternalSquads).map(asRecord).slice(0, SQUAD_FANOUT);
  const bySquad: Record<string, unknown>[] = [];
  for (const squad of squads) {
    const uuid = str(squad.uuid);
    if (uuid === null) continue;
    const usage = await settle(
      ctx.remna.get<unknown>(
        `/api/bandwidth-stats/internal-squads/${uuid}/users/${id}/usage`,
        { start, end },
      ),
    );
    if (!usage.ok) {
      shared.degraded.push({ system: 'remna', error: usage.error });
      continue;
    }
    const dayRows = asArray(asRecord(usage.value).days).map(asRecord);
    const nodeTotals = new Map<string, number>();
    const daily = dayRows.map((day) => {
      const perNode = asArray(day.nodes).map(asRecord);
      let sum = 0;
      for (const one of perNode) {
        const nodeUuid = str(one.uuid);
        const bytes = num(one.totalBytes);
        sum += bytes;
        if (nodeUuid !== null) nodeTotals.set(nodeUuid, (nodeTotals.get(nodeUuid) ?? 0) + bytes);
      }
      return { date: str(day.date), totalBytes: sum };
    });
    bySquad.push({
      uuid,
      name: str(squad.name),
      totalBytes: daily.reduce((sum, one) => sum + one.totalBytes, 0),
      nodeUuids: [...nodeTotals.keys()],
      daily,
    });
  }

  /**
   * Сквады НЕ делят трафик между собой. Панель считает «байты этого клиента на
   * нодах, до которых дотягиваются инбаунды сквада», а не «байты, принесённые
   * членством в скваде»: на работающей панели один и тот же клиент показал
   * ОДИН И ТОТ ЖЕ объём сразу в двух сквадах — оба достают до одних и тех же
   * нод, — а по скваду, в котором он вообще НЕ состоит, ручка честно вернула
   * ненулевые байты на единственной его ноде. Сумма по сквадам поэтому не равна
   * `totalBytes` и в общем случае больше его.
   */
  const seen = new Map<string, number>();
  for (const squad of bySquad) {
    for (const uuid of asArray(squad.nodeUuids).map((one) => String(one))) {
      seen.set(uuid, (seen.get(uuid) ?? 0) + 1);
    }
  }
  if ([...seen.values()].some((count) => count > 1)) {
    shared.warnings.push(
      warn(
        'squad_totals_overlap',
        'Two or more of these squads reach the same node, and the panel counts that node\'s bytes ' +
          'for each of them. `bySquad` totals therefore overlap: adding them up double-counts, ' +
          'and none of them is "the traffic this squad caused" — the scoping is by node reach, ' +
          'not by membership. `totalBytes` and `byNode` are the figures that sum correctly.',
      ),
    );
  }
  if (chart.ok && chartValue.series === undefined) {
    shared.warnings.push(
      warn(
        'bandwidth_shape_unrecognised',
        'The per-user traffic route answered without a `series` array, so no figure could be ' +
          'read from it. `byNode` is empty because the shape was not understood — not because ' +
          'the client moved no bytes.',
      ),
    );
  } else if (chart.ok && (topNodes.length >= TOP_NODES || series.length < topNodes.length)) {
    shared.warnings.push(
      warn(
        'bandwidth_top_n',
        `The request asked for ${String(TOP_NODES)} node rows and got ${String(series.length)} ` +
          `series against ${String(topNodes.length)} top-N entries. On 3.2.3 the limit caps ` +
          '`topNodes` only and `series` carries every node with bytes — these numbers say that ' +
          'stopped being true here, so a node this client used may be missing from `byNode`.',
      ),
    );
  }
  if (!found && card.ok) {
    shared.warnings.push(
      warn(
        'user_not_found',
        `Remnawave has no user with id ${id}: the panel answered its application 404 (errorCode ` +
          'A063) on the user card. The traffic route does NOT 404 for an unknown id — it answers ' +
          '200 with an empty series and a sparkline of zeroes — so without this check the answer ' +
          'would read as a real subscriber who used nothing.',
      ),
    );
  }
  if (!found && !card.ok) {
    shared.warnings.push(
      warn(
        'card_unavailable',
        'The user card call failed (see `degraded`), so the id is unconfirmed and the squad ' +
          'breakdown is empty by refusal: squads are read off that card. Zero bytes here is not ' +
          'evidence about this subscriber.',
      ),
    );
  }
  notePartial(shared, 'this client was idle');

  return {
    scope: 'user',
    found,
    user: found ? { id: foundId, username: str(safe.username), status: str(safe.status) } : null,
    window: shared.win,
    /** Метки дней: `daily[i]` каждой строки `byNode` — это `days[i]`. */
    days: categories,
    totalBytes,
    nodes: {
      // Ноды без строки — это ноды БЕЗ БАЙТОВ у этого клиента, а не срезанные
      // лимитом (см. bandwidth_top_n). Оба числа отдаются, чтобы разницу было
      // видно, а не выводить её из длины массива.
      inPanel: nodes.ok ? fleet.length : null,
      withTraffic: byNode.length,
    },
    byNode,
    bySquad,
    warnings: shared.warnings,
    degraded: shared.degraded,
  };
}

async function forSquad(
  squadUuid: string,
  shared: Shared,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { start, end } = shared.win;
  const [list, usage] = await Promise.all([
    settle(ctx.remna.get<unknown>('/api/internal-squads')),
    settle(
      ctx.remna.get<unknown>(`/api/bandwidth-stats/internal-squads/${squadUuid}/usage`, {
        start,
        end,
        limit: shared.rows,
      }),
    ),
  ]);

  const listValue = take(list, 'remna', shared.degraded, null);
  const squads = asArray(asRecord(listValue).internalSquads ?? listValue).map(asRecord);
  const known = squads.find((row) => str(row.uuid) === squadUuid);

  const body = asRecord(take(usage, 'remna', shared.degraded, null));
  const users = asArray(body.users)
    .map(asRecord)
    .map((row) => ({ userId: num(row.id, Number.NaN), totalBytes: num(row.totalBytes) }))
    .filter((row) => Number.isFinite(row.userId));
  const hasMore = body.hasMore === true;

  if (hasMore) {
    shared.warnings.push(
      warn(
        'truncated',
        `The squad usage route returned ${String(users.length)} rows for a requested limit of ` +
          `${String(shared.rows)} and says there are more (\`hasMore\`). It publishes no total at ` +
          'all — only a cursor — so the number of clients with traffic in this squad is NOT ' +
          'known from this answer, and neither the sum below nor "who used the most" is final. ' +
          'The members count next to it is a different number: membership, not usage.',
      ),
    );
  }
  if (known === undefined && list.ok) {
    shared.warnings.push(
      warn(
        'squad_not_in_panel',
        `The panel lists ${String(squads.length)} internal squads and none of them is ` +
          `${squadUuid}. Check the uuid: the usage route answers on uuids it does not know the ` +
          'same way it answers on an empty squad.',
      ),
    );
  }
  notePartial(shared, 'this squad was idle');

  return {
    scope: 'squad',
    found: known !== undefined,
    squad:
      known === undefined
        ? null
        : {
            uuid: squadUuid,
            name: str(known.name),
            // Членство, а НЕ число строк расхода: клиент без байтов в окне
            // сюда входит, а клиент с байтами на нодах сквада может в нём не
            // состоять вовсе (проверено на бою).
            membersCount: num(asRecord(known.info).membersCount, Number.NaN) || null,
          },
    window: shared.win,
    totals: {
      returned: users.length,
      limit: shared.rows,
      hasMore,
      bytesInReturnedRows: users.reduce((sum, row) => sum + row.totalBytes, 0),
    },
    users: [...users].sort((a, b) => b.totalBytes - a.totalBytes),
    warnings: shared.warnings,
    degraded: shared.degraded,
  };
}

async function forNode(
  nodeUuid: string,
  shared: Shared,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { start, end } = shared.win;
  const [nodes, chart] = await Promise.all([
    settle(ctx.remna.get<unknown>('/api/nodes')),
    settle(
      ctx.remna.get<unknown>(`/api/bandwidth-stats/nodes/${nodeUuid}/users`, {
        start,
        end,
        topUsersLimit: shared.rows,
      }),
    ),
  ]);

  const nodeValue = take(nodes, 'remna', shared.degraded, null);
  const known = asArray(asRecord(nodeValue).nodes ?? nodeValue)
    .map(asRecord)
    .find((row) => str(row.uuid) === nodeUuid);

  const body = asRecord(take(chart, 'remna', shared.degraded, null));
  const categories = asArray(body.categories)
    .map((one) => str(one))
    .filter((one): one is string => one !== null);
  const users = asArray(body.topUsers)
    .map(asRecord)
    .map((row) => ({
      // `userId` в контракте 3.2.3 не объявлен, а работающая панель его отдаёт —
      // без него строка не связывается ни с одним клиентом, поэтому берётся,
      // но и без него имя остаётся.
      userId: (() => {
        const parsed = num(row.userId, Number.NaN);
        return Number.isFinite(parsed) ? parsed : null;
      })(),
      username: str(row.username),
      totalBytes: num(row.total),
    }));

  /**
   * Тот самый предел из урока country_health, только здесь он режет по-честному
   * и без всякого признака в ответе: `topUsersLimit` ограничивает `topUsers`
   * (на работающей панели запрос на 5 отдал ровно 5 строк, а запрос на 1000 —
   * меньше тысячи, то есть список кончился), а никакого total ручка не
   * публикует. То есть ровно заполненный список — единственный различимый
   * признак того, что за срезом кто-то остался.
   */
  if (chart.ok && users.length >= shared.rows) {
    shared.warnings.push(
      warn(
        'truncated',
        `The node leaderboard returned exactly the ${String(shared.rows)} rows it was asked for ` +
          'and publishes no total, so it is unknown how many clients used this node in the ' +
          'window. Everyone below the cut is missing, and this list must not be read as "these ' +
          'are the clients on this node". Raise `limit` (up to 1000) until fewer rows come back ' +
          'than were requested.',
      ),
    );
  }
  if (known === undefined && nodes.ok) {
    shared.warnings.push(
      warn(
        'node_not_in_panel',
        `The panel lists nodes and none of them is ${nodeUuid}; the traffic route was still ` +
          'asked, because the two are different sources. Check the uuid before reading an empty ' +
          'leaderboard as an idle node.',
      ),
    );
  }
  notePartial(shared, 'this node was idle');

  return {
    scope: 'node',
    found: known !== undefined,
    node:
      known === undefined
        ? null
        : {
            uuid: nodeUuid,
            name: str(known.name),
            countryCode: str(known.countryCode),
            isConnected: known.isConnected === true,
            isDisabled: known.isDisabled === true,
          },
    window: shared.win,
    /** Метки дней для `daily` ниже. */
    days: categories,
    /** Суточные суммы ВСЕЙ ноды, а не только показанных строк. */
    daily: asArray(body.sparklineData).map((one) => num(one)),
    totals: {
      returned: users.length,
      limit: shared.rows,
      bytesInReturnedRows: users.reduce((sum, row) => sum + row.totalBytes, 0),
    },
    users,
    warnings: shared.warnings,
    degraded: shared.degraded,
  };
}
