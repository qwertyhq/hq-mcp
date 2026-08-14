import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, Profile, RemnaClient, ToolContext, ToolWarning } from '@hq/types';
import { asArray, asRecord, capLimit, num, settle, sleep, str, take, warn } from '../kit.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/**
 * Расписание опроса задачи. Первый опрос идёт СРАЗУ после постановки, дальше —
 * с нарастающими паузами; сумма ниже — потолок ожидания ≈ 8 с.
 *
 * Числа не с потолка, а замерены на работающей панели 3.2.3: задача by-node
 * была готова уже на нулевом опросе, а by-user не досчитывала последнюю ноду
 * на нулевом и досчитывала её на первом — то есть счёт идёт на сотни
 * миллисекунд, и фиксированная секундная пауза была бы чистой потерей времени.
 * Длинный хвост оставлен на случай, когда часть нод не отвечает: у by-user
 * `progress.total` — это ЧИСЛО НОД, которые панель обходит, и один зависший
 * агент растягивает всю задачу.
 *
 * Количество опросов ограничено и бюджетом тоже: каждый опрос — это отдельный
 * `budget.take` по ключу вида `remna:GET:/api/connections/by-user/:id` (все
 * опросы схлопываются в ОДИН ключ, потому что jobId — число), а общий потолок
 * ведра 30 запросов в минуту. Одиннадцать опросов оставляют место второму
 * вызову инструмента в том же окне; полсотни — не оставляли бы.
 */
const POLL_DELAYS_MS: readonly number[] = [200, 250, 300, 400, 500, 700, 900, 1200, 1500, 2000];

/**
 * Что панель ЗНАЕТ про адрес клиента, и чего она не знает. Стоит в каждом
 * ответе, потому что оба неверных прочтения одинаково дороги.
 *
 * `lastSeen` — это «нода последний раз видела трафик с этого адреса», а НЕ
 * «сессия началась тогда-то»: в ответе панели у адреса ровно два поля, `ip` и
 * `lastSeen` (выверено на работающей 3.2.3), никакого времени подключения там
 * нет вовсе. Вопрос «с какого времени клиент сидит» этой ручкой не отвечается, и
 * подставлять вместо него lastSeen — значит отвечать не на тот вопрос.
 *
 * Сам адрес — тот, который увидел инбаунд НОДЫ. Там, где перед нодой стоит
 * релей, это адрес релея ровно в той мере, в какой релей не передаёт исходный
 * (HAProxy в режиме passthrough с PROXY v2 передаёт, голый forward — нет), и
 * различить два случая по этому ответу нельзя.
 */
export const CONNECTION_IP_WARNING: ToolWarning = {
  code: 'connection_ip_is_what_the_node_saw',
  message:
    'Each address here is what the node inbound recorded, and `lastSeen` is the last moment that ' +
    'node saw traffic from it — not when the session started. The panel carries no session start ' +
    'at all on this route, so "connected since ..." cannot be answered from it. Where a relay ' +
    'fronts the node, the address is the relay unless that relay forwards the original one ' +
    '(HAProxy passthrough with PROXY v2 does, a plain forward does not), and nothing in this ' +
    'answer separates the two cases.',
};

interface JobPoll {
  /** Тело последнего опроса; null — опросить не удалось вовсе. */
  body: Record<string, unknown> | null;
  attempts: number;
  waitedMs: number;
  completed: boolean;
  failed: boolean;
  error: string | null;
}

/**
 * Ставит задачу и опрашивает её до готовности.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Ручка connections — не GET, а пара «поставить задачу
 * POST → забрать результат GET по jobId». Промежуточный опрос отвечает 200 с
 * `isCompleted: false` и `result: null` — то есть инструмент, читающий первый
 * же ответ, получил бы пустоту и выдал её за «клиент никуда не подключён».
 * Проверено на бою: нулевой опрос by-user показал `progress 5/6` и
 * `result: null`, готовый ответ приехал следующим.
 */
async function runJob(
  remna: RemnaClient,
  startPath: string,
  resultPath: (jobId: string) => string,
): Promise<{ jobId: string | null; poll: JobPoll; error: string | null }> {
  const started = await settle(remna.send<unknown>('POST', startPath));
  if (!started.ok) {
    return {
      jobId: null,
      poll: { body: null, attempts: 0, waitedMs: 0, completed: false, failed: false, error: null },
      error: started.error,
    };
  }
  const jobId = str(asRecord(started.value).jobId);
  if (jobId === null) {
    return {
      jobId: null,
      poll: { body: null, attempts: 0, waitedMs: 0, completed: false, failed: false, error: null },
      error: 'the panel accepted the request but returned no jobId',
    };
  }

  let waitedMs = 0;
  let last: Record<string, unknown> | null = null;
  let error: string | null = null;
  for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const pause = POLL_DELAYS_MS[attempt - 1] ?? 0;
      await sleep(pause);
      waitedMs += pause;
    }
    const polled = await settle(remna.get<unknown>(resultPath(jobId)));
    if (!polled.ok) {
      // Опрос оборвался. Всё, что успели прочитать до него, остаётся: панель
      // могла отдать готовый результат и упасть на лишнем опросе, которого мы
      // уже не делаем.
      error = polled.error;
      return {
        jobId,
        poll: {
          body: last,
          attempts: attempt + 1,
          waitedMs,
          completed: last?.isCompleted === true,
          failed: last?.isFailed === true,
          error,
        },
        error: null,
      };
    }
    last = asRecord(polled.value);
    if (last.isCompleted === true || last.isFailed === true) {
      return {
        jobId,
        poll: {
          body: last,
          attempts: attempt + 1,
          waitedMs,
          completed: last.isCompleted === true,
          failed: last.isFailed === true,
          error: null,
        },
        error: null,
      };
    }
  }
  return {
    jobId,
    poll: {
      body: last,
      attempts: POLL_DELAYS_MS.length + 1,
      waitedMs,
      completed: false,
      failed: false,
      error: null,
    },
    error: null,
  };
}

function addressesOf(row: Record<string, unknown>, now: Date): {
  ips: { ip: string | null; lastSeen: string | null; secondsAgo: number | null }[];
  lastSeen: string | null;
} {
  let newest: number | null = null;
  const ips = asArray(row.ips).map(asRecord).map((one) => {
    const lastSeen = str(one.lastSeen);
    const at = lastSeen === null ? Number.NaN : Date.parse(lastSeen);
    const seconds = Number.isNaN(at) ? null : Math.floor((now.getTime() - at) / 1000);
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
    return {
      // Имя поля — `ip` намеренно: @hq/redact маскирует PII ПО ИМЕНИ КЛЮЧА, и
      // список адресов, отданный массивом строк под ключом `ips`, уехал бы
      // боту в открытую — ровно тот способ утечки, каким токен бота ушёл в
      // значении строки спула.
      ip: str(one.ip),
      lastSeen,
      secondsAgo: seconds,
    };
  });
  return { ips, lastSeen: newest === null ? null : new Date(newest).toISOString() };
}

/**
 * Число РАЗНЫХ адресов; счёт по строкам завышал бы его на каждой ноде — один
 * клиент с одного адреса на трёх нодах даёт три строки и один адрес.
 *
 * Для профиля bot считать НЕЧЕГО, и это не педантизм: @hq/remna редактирует
 * тело ДО того, как его увидит инструмент (packages/remna/src/index.ts), то
 * есть все адреса приезжают сюда одним и тем же маркером. Наивный счёт по
 * множеству вернул бы ровно 1 на любом входе — то есть уверенное «клиент
 * сидит с одного адреса» на клиенте, раздающем аккаунт на десяток. Поэтому
 * боту отдаётся null, а не число, которое нельзя получить.
 */
function distinct(values: (string | null)[], profile: Profile): number | null {
  if (profile === 'bot') return null;
  return new Set(values.filter((one): one is string => one !== null)).size;
}

export const connectionsInspect = defineTool({
  name: 'connections_inspect',
  description:
    'Who is connected to the fleet right now, by client or by node, as the nodes themselves ' +
    'report it. The panel answers this with a job, not a value: the request posts a job and the ' +
    'answer arrives on a second route by job id, and an unfinished poll returns an empty result ' +
    'that reads exactly like "nobody is connected" — this tool owns the polling and says so ' +
    'whenever it stopped before the job finished. Every address is the one the node inbound saw, ' +
    'and `lastSeen` is the last traffic from it, NOT a session start: "connected since ..." is ' +
    'not a question this route can answer. Dropping a connection (DROP_CONNECTIONS) is ' +
    'deliberately absent — it is a mutation that kicks live subscribers off the fleet with no ' +
    'confirmation step, no per-user list to review and nothing to roll back, and this server ' +
    'registers no mutator that does it.',
  input: z
    .object({
      user_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe('Remnawave numeric user id (3.x has no user uuid); pass this or node_uuid'),
      node_uuid: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe('Node uuid, for the other direction: everyone connected to that node'),
      limit: z
        .number()
        .int()
        .default(DEFAULT_LIMIT)
        .describe('Node scope only: clients to return, newest activity first, capped at 500'),
    })
    // `.refine`, не `.transform`: реестр требует живой `.shape` у input, иначе
    // MCP нечего опубликовать как схему (packages/registry:76).
    .refine((one) => (one.user_id === null) !== (one.node_uuid === null), {
      message: 'Pass exactly one of `user_id` (one client across the fleet) or `node_uuid`.',
      path: ['user_id'],
    }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ user_id, node_uuid, limit }, ctx) => {
    const warnings: ToolWarning[] = [CONNECTION_IP_WARNING];
    const degraded: Degraded[] = [];
    const now = ctx.now();
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);

    // Список нод нужен обоим направлениям и по разным причинам: by-user
    // сверяет с ним, сколько нод панель вообще обошла, by-node — существует ли
    // такая нода и жив ли её агент.
    const nodes = await settle(ctx.remna.get<unknown>('/api/nodes'));
    const nodeValue = take(nodes, 'remna', degraded, null);
    const nodeRows = asArray(asRecord(nodeValue).nodes ?? nodeValue)
      .map(asRecord)
      .filter((row) => str(row.uuid) !== null);
    const shared: Shared = { warnings, degraded, now, nodes: nodeRows, fleetKnown: nodes.ok };

    if (user_id !== null) return await byUser(user_id, shared, ctx);
    return await byNode(str(node_uuid) ?? '', cap, shared, ctx);
  },
});

interface Shared {
  warnings: ToolWarning[];
  degraded: Degraded[];
  now: Date;
  nodes: Record<string, unknown>[];
  fleetKnown: boolean;
}

/**
 * Общая часть обоих направлений: перевести исход задачи в предупреждения.
 * Отдельной функцией, потому что «мы перестали спрашивать» и «панель сказала
 * нет» обязаны звучать одинаково в обоих ответах — разъехавшиеся тексты учат
 * вызывающего, что у одного направления пустота значит не то же, что у другого.
 */
function noteJob(
  poll: JobPoll,
  startError: string | null,
  shared: Shared,
  emptyMeans: string,
): void {
  if (startError !== null) {
    shared.degraded.push({ system: 'remna', error: startError });
    return;
  }
  if (poll.error !== null) shared.degraded.push({ system: 'remna', error: poll.error });
  if (poll.failed) {
    shared.warnings.push(
      warn(
        'connections_job_failed',
        'The panel marked the connections job failed. Nothing was collected, so the empty list ' +
          `below is the job dying, not ${emptyMeans}.`,
      ),
    );
    return;
  }
  if (!poll.completed) {
    const progress = asRecord(poll.body?.progress);
    const total = num(progress.total, Number.NaN);
    const done = num(progress.completed, Number.NaN);
    const seen =
      Number.isFinite(total) && Number.isFinite(done)
        ? ` The last poll reported ${String(done)} of ${String(total)} nodes answered.`
        : '';
    shared.warnings.push(
      warn(
        'connections_job_unfinished',
        `The job had not finished after ${String(poll.attempts)} polls over ` +
          `${String(poll.waitedMs)} ms, so this tool stopped asking.${seen} The list below is ` +
          `empty because the answer was not ready — not because ${emptyMeans}. Call again; the ` +
          'panel collects this per node and one slow agent holds up the whole job.',
      ),
    );
  }
}

/** Ответ задачи не той формы, что мы просили. */
function noteShape(shared: Shared, expected: string): void {
  shared.warnings.push(
    warn(
      'connections_result_not_ours',
      `The finished job carried a result without \`${expected}\`, so it is not the answer to the ` +
        'question that was asked. This is checked because the panel does not check it: job ids ' +
        'are a small shared counter and the by-user result route serves a by-node job verbatim ' +
        '(verified on 3.2.3) — reading such a payload for the wrong shape yields an empty list ' +
        'that looks like a confident "nobody is connected".',
    ),
  );
}

async function byUser(
  userId: number,
  shared: Shared,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const id = String(userId);
  // Карта пользователя ПЕРВОЙ и отдельно: @hq/remna превращает прикладной 404
  // (errorCode A063) на /api/users/{id} в null, то есть «в панели такого нет»
  // отличимо от «панель не ответила». Без этого шага удалённый пользователь и
  // живой, но отключившийся, дают один и тот же пустой список.
  const card = await settle(ctx.remna.get<unknown>(`/api/users/${id}`));
  const raw = take(card, 'remna', shared.degraded, null);
  const safe = asRecord(raw);
  const foundId = num(safe.id, Number.NaN);
  const found = card.ok && Number.isFinite(foundId) && foundId > 0;

  const job = await runJob(
    ctx.remna,
    `/api/connections/by-user/${id}`,
    (jobId) => `/api/connections/by-user/${jobId}`,
  );
  noteJob(job.poll, job.error, shared, 'the client is offline');

  const result = asRecord(job.poll.body?.result);
  const hasShape = job.poll.completed && !job.poll.failed && result.userId !== undefined;
  if (job.poll.completed && !job.poll.failed && !hasShape && job.poll.body?.result !== null) {
    noteShape(shared, 'userId');
  }

  const rows = hasShape
    ? asArray(result.nodes).map(asRecord).map((row) => {
        const { ips, lastSeen } = addressesOf(row, shared.now);
        return {
          nodeUuid: str(row.nodeUuid),
          nodeName: str(row.nodeName),
          countryCode: str(row.countryCode),
          lastSeen,
          ips,
        };
      })
    : [];

  const progress = asRecord(job.poll.body?.progress);
  const polled = num(progress.total, Number.NaN);
  const fleet = shared.nodes.length;
  /**
   * Тот же урок, что и у country_health, только предел здесь другой: панель
   * обходит ноды сама, и `progress.total` — это сколько нод она вообще решила
   * спросить. Нода, которую не спросили, не может дать ни одного соединения, и
   * без этой сверки её молчание неотличимо от «клиента там нет».
   */
  if (shared.fleetKnown && Number.isFinite(polled) && fleet > 0 && polled < fleet) {
    shared.warnings.push(
      warn(
        'connections_nodes_not_polled',
        `The job polled ${String(polled)} nodes out of ${String(fleet)} in the panel. A node it ` +
          'never asked cannot report a connection, so this answer is about the polled subset. Do ' +
          'not read a missing country here as "the client is not on it".',
      ),
    );
  }
  // Два отдельных вызова warn с ЛИТЕРАЛЬНЫМ кодом, а не один с тернарником:
  // словарь кодов (warning-codes.test.ts) собирается регуляркой по исходнику и
  // видит только литерал сразу за `warn(`. Код, спрятанный за тернарником, в
  // словарь не попадает — то есть проверка «один код — один факт» его молча не
  // касается.
  if (!found && card.ok) {
    shared.warnings.push(
      warn(
        'user_not_found',
        `Remnawave has no user with id ${id} — the panel answered its application 404 ` +
          '(errorCode A063), which is the panel speaking, not a failed request. Re-resolve ' +
          'with client_resolve: the numeric id changes when the panel user is recreated.',
      ),
    );
  }
  if (!found && !card.ok) {
    shared.warnings.push(
      warn(
        'card_unavailable',
        'The user card call failed (see `degraded`), so nothing here confirms the id exists. An ' +
          'empty connection list on an id the panel may not know is not evidence of an offline ' +
          'client.',
      ),
    );
  }
  if (ctx.profile === 'bot') {
    shared.warnings.push(
      warn(
        'addresses_masked',
        'This profile does not receive client addresses: every `ip` arrives masked, and ' +
          '`distinctAddresses` is null rather than 1, which is what counting a column of ' +
          'identical markers would have produced. Row counts (`totals.addresses`) and timings ' +
          'are unaffected; "how many different addresses" cannot be answered here.',
      ),
    );
  }
  if (shared.degraded.length > 0) {
    shared.warnings.push(
      warn(
        'partial_result',
        'A panel call did not answer (see `degraded`); the part it owns is empty rather than ' +
          'wrong. An empty connection list here is not evidence that the client is offline.',
      ),
    );
  }

  return {
    scope: 'user',
    found,
    user: found
      ? { id: foundId, username: str(safe.username), status: str(safe.status) }
      : null,
    job: {
      id: job.jobId,
      completed: job.poll.completed,
      failed: job.poll.failed,
      attempts: job.poll.attempts,
      waitedMs: job.poll.waitedMs,
      nodesPolled: Number.isFinite(polled) ? polled : null,
      nodesInPanel: shared.fleetKnown ? fleet : null,
    },
    totals: {
      nodes: rows.length,
      addresses: rows.reduce((sum, row) => sum + row.ips.length, 0),
      distinctAddresses: distinct(rows.flatMap((row) => row.ips.map((one) => one.ip)), ctx.profile),
    },
    connections: rows,
    warnings: shared.warnings,
    degraded: shared.degraded,
  };
}

async function byNode(
  nodeUuid: string,
  cap: number,
  shared: Shared,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const known = shared.nodes.find((row) => str(row.uuid) === nodeUuid);
  const found = known !== undefined;

  const job = await runJob(
    ctx.remna,
    `/api/connections/by-node/${nodeUuid}`,
    (jobId) => `/api/connections/by-node/${jobId}`,
  );
  noteJob(job.poll, job.error, shared, 'the node is idle');

  const result = asRecord(job.poll.body?.result);
  const hasShape = job.poll.completed && !job.poll.failed && result.nodeUuid !== undefined;
  if (job.poll.completed && !job.poll.failed && !hasShape && job.poll.body?.result !== null) {
    noteShape(shared, 'nodeUuid');
  }

  const all = hasShape
    ? asArray(result.users).map(asRecord).map((row) => {
        const { ips, lastSeen } = addressesOf(row, shared.now);
        const id = num(row.userId, Number.NaN);
        return {
          userId: Number.isFinite(id) ? id : null,
          lastSeen,
          ips,
        };
      })
    : [];
  // Самые свежие сверху: срез «первые N, как вернула панель» — это не ответ на
  // «кто подключён», а произвольная выборка, поданная как таковая.
  const sorted = [...all].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
  const clients = sorted.slice(0, cap);

  if (all.length > clients.length) {
    shared.warnings.push(
      warn(
        'truncated',
        `The node reported ${String(all.length)} connected clients and ${String(clients.length)} ` +
          'are returned, most recent activity first. Counts below (`totals`) are over all of ' +
          'them; the rows are the slice. Raise `limit` before concluding who is or is not on ' +
          'this node.',
      ),
    );
  }
  if (!found && shared.fleetKnown) {
    shared.warnings.push(
      warn(
        'node_not_in_panel',
        `The panel lists ${String(shared.nodes.length)} nodes and none of them is ${nodeUuid}. ` +
          'The job was still posted, because the node listing and the connections job are ' +
          'different sources — but check the uuid before reading this as an idle node.',
      ),
    );
  }
  if (!found && !shared.fleetKnown) {
    shared.warnings.push(
      warn(
        'node_listing_unavailable',
        'The node listing did not answer (see `degraded`), so nothing here confirms this uuid is ' +
          'a node of this panel, and `node` is null by refusal rather than by absence.',
      ),
    );
  }
  if (known !== undefined && (known.isConnected !== true || known.isDisabled === true)) {
    shared.warnings.push(
      warn(
        'node_agent_down',
        'The panel reports this node as not connected (or disabled), and the connections job is ' +
          'answered BY the node agent. An empty list is what a node with no agent link looks ' +
          'like, and it is not evidence that no client is using it: country_health carries the ' +
          'same caveat for the relay data plane in front of the node.',
      ),
    );
  }
  if (ctx.profile === 'bot') {
    shared.warnings.push(
      warn(
        'addresses_masked',
        'This profile does not receive client addresses: every `ip` arrives masked, and ' +
          '`distinctAddresses` is null rather than 1, which is what counting a column of ' +
          'identical markers would have produced. Row counts (`totals.addresses`) and timings ' +
          'are unaffected; "how many different addresses" cannot be answered here.',
      ),
    );
  }
  if (shared.degraded.length > 0) {
    shared.warnings.push(
      warn(
        'partial_result',
        'A panel call did not answer (see `degraded`); the part it owns is empty rather than ' +
          'wrong. An empty client list here is not evidence that the node is idle.',
      ),
    );
  }

  return {
    scope: 'node',
    found,
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
    job: {
      id: job.jobId,
      completed: job.poll.completed,
      failed: job.poll.failed,
      attempts: job.poll.attempts,
      waitedMs: job.poll.waitedMs,
    },
    totals: {
      clients: all.length,
      returned: clients.length,
      limit: cap,
      addresses: all.reduce((sum, row) => sum + row.ips.length, 0),
      distinctAddresses: distinct(all.flatMap((row) => row.ips.map((one) => one.ip)), ctx.profile),
    },
    clients,
    warnings: shared.warnings,
    degraded: shared.degraded,
  };
}
