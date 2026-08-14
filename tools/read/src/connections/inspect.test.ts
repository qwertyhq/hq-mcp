import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { CONNECTION_IP_WARNING, connectionsInspect } from './inspect.js';

interface Address {
  ip: string | null;
  lastSeen: string | null;
  secondsAgo: number | null;
}

interface Out {
  scope: string;
  found: boolean;
  user?: { id: number; username: string | null; status: string | null } | null;
  node?: { uuid: string; name: string | null; isConnected: boolean } | null;
  job: {
    id: string | null;
    completed: boolean;
    failed: boolean;
    attempts: number;
    waitedMs: number;
    nodesPolled?: number | null;
    nodesInPanel?: number | null;
  };
  totals: Record<string, number | null | boolean>;
  connections?: Array<{
    nodeUuid: string | null;
    nodeName: string | null;
    countryCode: string | null;
    lastSeen: string | null;
    ips: Address[];
  }>;
  clients?: Array<{ userId: number | null; lastSeen: string | null; ips: Address[] }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * Формы сняты прогоном по работающей панели 3.2.3, а не взяты из контракта
 * (адреса выдуманы). Здесь важны две вещи, которых в контракте нет:
 *
 *  - `jobId` — это МАЛЕНЬКОЕ ЧИСЛО в строке ('12', '13'), общий счётчик на оба
 *    направления, а не uuid;
 *  - у by-node в ответе нет `progress` вовсе, у by-user он есть и `total` в нём
 *    — это число нод, которые панель обходит.
 */
const NODE_UUID = '0fd1f977-4167-47c9-8352-f123b7d6db0c';
const OTHER_UUID = '7c39c520-87ed-4c64-aaf0-5246bdbffb36';

const NODES = [
  { uuid: NODE_UUID, name: 'Poland', countryCode: 'PL', isConnected: true, isDisabled: false },
  { uuid: OTHER_UUID, name: 'Finland', countryCode: 'FI', isConnected: true, isDisabled: false },
];

const USER_CARD = { id: 6, username: 'HQVPN_51', status: 'ACTIVE' };

const BY_USER_DONE = {
  isCompleted: true,
  isFailed: false,
  progress: { total: 2, completed: 2, percent: 100 },
  result: {
    success: true,
    userId: 6,
    nodes: [
      {
        nodeUuid: NODE_UUID,
        nodeName: 'Poland',
        countryCode: 'PL',
        ips: [
          { ip: '203.0.113.7', lastSeen: '2026-08-08T11:59:00.000Z' },
          { ip: '203.0.113.7', lastSeen: '2026-08-08T11:58:00.000Z' },
        ],
      },
      {
        nodeUuid: OTHER_UUID,
        nodeName: 'Finland',
        countryCode: 'FI',
        ips: [{ ip: '198.51.100.9', lastSeen: '2026-08-08T11:55:00.000Z' }],
      },
    ],
  },
};

/** Промежуточный опрос: 200, но результата ещё нет. Именно он и есть ловушка. */
const BY_USER_PENDING = {
  isCompleted: false,
  isFailed: false,
  progress: { total: 2, completed: 1, percent: 50 },
  result: null,
};

const BY_NODE_DONE = {
  isCompleted: true,
  isFailed: false,
  result: {
    success: true,
    nodeUuid: NODE_UUID,
    users: [
      { userId: 6, ips: [{ ip: '203.0.113.7', lastSeen: '2026-08-08T11:50:00.000Z' }] },
      { userId: 9, ips: [{ ip: '198.51.100.9', lastSeen: '2026-08-08T11:59:00.000Z' }] },
      { userId: 38, ips: [{ ip: '198.51.100.9', lastSeen: '2026-08-08T11:55:00.000Z' }] },
    ],
  },
};

interface Wiring {
  polls?: unknown[];
  card?: unknown;
  cardThrows?: boolean;
  nodes?: unknown;
  nodesThrow?: boolean;
  postThrows?: string | null;
  pollThrowsAfter?: number;
  calls?: StubCall[];
  profile?: 'human' | 'bot';
}

function ctxFor(wiring: Wiring = {}): ReturnType<typeof makeCtx> {
  let poll = 0;
  const polls = wiring.polls ?? [BY_USER_DONE];
  return makeCtx({
    calls: wiring.calls ?? [],
    profile: wiring.profile ?? 'human',
    remnaGet: (path) => {
      if (path === '/api/nodes') {
        if (wiring.nodesThrow === true) throw new Error('nodes unavailable');
        return wiring.nodes ?? NODES;
      }
      if (path.startsWith('/api/users/')) {
        if (wiring.cardThrows === true) throw new Error('card unavailable');
        return wiring.card === undefined ? USER_CARD : wiring.card;
      }
      if (path.startsWith('/api/connections/')) {
        if (wiring.pollThrowsAfter !== undefined && poll >= wiring.pollThrowsAfter) {
          throw new Error('poll refused');
        }
        const body = polls[Math.min(poll, polls.length - 1)];
        poll += 1;
        return body;
      }
      throw new Error(`unexpected remna GET ${path}`);
    },
    remnaSend: (path) => {
      if (wiring.postThrows != null) throw new Error(wiring.postThrows);
      if (path.startsWith('/api/connections/')) return { jobId: '12' };
      throw new Error(`unexpected remna POST ${path}`);
    },
  });
}

/**
 * Опрос спит между попытками, и суммарное ожидание — восемь с лишним секунд:
 * с настоящими таймерами тест на исчерпанное окно упирался бы в таймаут
 * vitest. Часы двигаются вручную, поэтому проверяется поведение, а не терпение.
 */
async function withClock<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const pending = run();
  await vi.advanceTimersByTimeAsync(60_000);
  return await pending;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connections_inspect: the job, not the first answer', () => {
  it('keeps polling past an unfinished result instead of reporting an idle client', async () => {
    const calls: StubCall[] = [];
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ polls: [BY_USER_PENDING, BY_USER_PENDING, BY_USER_DONE], calls }),
      ),
    )) as Out;

    expect(out.job.completed).toBe(true);
    expect(out.job.attempts).toBe(3);
    expect(out.connections).toHaveLength(2);
    // Первый ответ панели был `result: null` — ровно та пустота, которую
    // инструмент обязан НЕ выдать за «клиент не подключён».
    expect(out.warnings.map((one) => one.code)).not.toContain('connections_job_unfinished');
    const polls = calls.filter((one) => one.path.startsWith('/api/connections/by-user/12'));
    expect(polls).toHaveLength(3);
    expect(calls.some((one) => one.method === 'POST' && one.path.endsWith('/by-user/6'))).toBe(true);
  });

  it('says it stopped asking when the job never finishes, and reports how far it got', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ polls: [BY_USER_PENDING] }),
      ),
    )) as Out;

    expect(out.job.completed).toBe(false);
    expect(out.job.attempts).toBe(11);
    expect(out.job.waitedMs).toBeGreaterThan(0);
    expect(out.connections).toEqual([]);
    const unfinished = out.warnings.find((one) => one.code === 'connections_job_unfinished');
    expect(unfinished?.message).toContain('1 of 2 nodes answered');
  });

  it('refuses a finished result of the wrong kind instead of reading an empty list out of it', async () => {
    // Проверено на работающей панели: маршрут by-user РЕЗУЛЬТАТА отдаёт
    // задачу by-node дословно — идентификаторы задач это один маленький общий
    // счётчик, и панель не проверяет, того ли рода задачу спрашивают. У такого тела нет
    // `result.nodes`, то есть наивное чтение дало бы уверенное «нигде».
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ polls: [BY_NODE_DONE] }),
      ),
    )) as Out;

    expect(out.connections).toEqual([]);
    expect(out.warnings.map((one) => one.code)).toContain('connections_result_not_ours');
  });

  it('reports a failed job as a failure, not as an offline client', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ polls: [{ isCompleted: false, isFailed: true, result: null }] }),
      ),
    )) as Out;

    expect(out.job.failed).toBe(true);
    expect(out.warnings.map((one) => one.code)).toContain('connections_job_failed');
    expect(out.warnings.map((one) => one.code)).not.toContain('connections_job_unfinished');
  });

  it('degrades instead of throwing when the job cannot even be posted', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ postThrows: 'Remnawave POST /api/connections/by-user/6: User not found' }),
      ),
    )) as Out;

    expect(out.degraded).toHaveLength(1);
    expect(out.connections).toEqual([]);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('keeps the rows it already read when a later poll is refused', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ polls: [BY_USER_PENDING], pollThrowsAfter: 1 }),
      ),
    )) as Out;

    expect(out.degraded.map((one) => one.error)).toContain('poll refused');
    expect(out.job.attempts).toBe(2);
  });
});

describe('connections_inspect: by client', () => {
  it('groups addresses per node and counts distinct addresses, not rows', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler({ user_id: 6, node_uuid: null, limit: 50 }, ctxFor()),
    )) as Out;

    expect(out.found).toBe(true);
    expect(out.user).toEqual({ id: 6, username: 'HQVPN_51', status: 'ACTIVE' });
    expect(out.totals).toMatchObject({ nodes: 2, addresses: 3, distinctAddresses: 2 });
    // Свежайший штамп ноды поднимается в `lastSeen` строки.
    expect(out.connections?.[0]?.lastSeen).toBe('2026-08-08T11:59:00.000Z');
    expect(out.connections?.[0]?.ips[0]?.secondsAgo).toBe(60);
    expect(out.warnings).toContainEqual(CONNECTION_IP_WARNING);
  });

  it('says how much of the fleet the job actually polled', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ nodes: [...NODES, { uuid: 'third', name: 'DE', isConnected: true }] }),
      ),
    )) as Out;

    expect(out.job.nodesPolled).toBe(2);
    expect(out.job.nodesInPanel).toBe(3);
    expect(out.warnings.map((one) => one.code)).toContain('connections_nodes_not_polled');
  });

  it('does not claim an unpolled node when the node listing itself failed', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ nodesThrow: true }),
      ),
    )) as Out;

    expect(out.job.nodesInPanel).toBeNull();
    expect(out.warnings.map((one) => one.code)).not.toContain('connections_nodes_not_polled');
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('separates "the panel has no such user" from "the panel did not answer"', async () => {
    // @hq/remna превращает прикладной 404 (errorCode A063) в null, а сбой — в
    // исключение. Два разных ответа, и оба не «клиент офлайн».
    const absent = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ card: null }),
      ),
    )) as Out;
    expect(absent.found).toBe(false);
    expect(absent.warnings.map((one) => one.code)).toContain('user_not_found');

    const broken = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ cardThrows: true }),
      ),
    )) as Out;
    expect(broken.found).toBe(false);
    expect(broken.warnings.map((one) => one.code)).toContain('card_unavailable');
    expect(broken.warnings.map((one) => one.code)).not.toContain('user_not_found');
  });

  it('refuses to count distinct addresses for the bot profile instead of answering 1', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: 6, node_uuid: null, limit: 50 },
        ctxFor({ profile: 'bot' }),
      ),
    )) as Out;

    expect(out.totals.distinctAddresses).toBeNull();
    expect(out.totals.addresses).toBe(3);
    expect(out.warnings.map((one) => one.code)).toContain('addresses_masked');
  });
});

describe('connections_inspect: by node', () => {
  it('returns the most recently active clients first and keeps totals over all of them', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: null, node_uuid: NODE_UUID, limit: 2 },
        ctxFor({ polls: [BY_NODE_DONE] }),
      ),
    )) as Out;

    expect(out.found).toBe(true);
    expect(out.node?.name).toBe('Poland');
    expect(out.clients?.map((one) => one.userId)).toEqual([9, 38]);
    expect(out.totals).toMatchObject({ clients: 3, returned: 2, addresses: 3, distinctAddresses: 2 });
    expect(out.warnings.map((one) => one.code)).toContain('truncated');
  });

  it('warns that a node whose agent is down answers nothing by construction', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: null, node_uuid: NODE_UUID, limit: 50 },
        ctxFor({
          polls: [BY_NODE_DONE],
          nodes: [{ ...NODES[0], isConnected: false }, NODES[1]],
        }),
      ),
    )) as Out;

    expect(out.warnings.map((one) => one.code)).toContain('node_agent_down');
  });

  it('names an unknown node uuid rather than passing it off as an idle node', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: null, node_uuid: 'not-a-node', limit: 50 },
        ctxFor({ polls: [{ isCompleted: true, isFailed: false, result: null }] }),
      ),
    )) as Out;

    expect(out.found).toBe(false);
    expect(out.node).toBeNull();
    expect(out.warnings.map((one) => one.code)).toContain('node_not_in_panel');
  });

  it('refuses the by-node claim entirely when the node listing did not answer', async () => {
    const out = (await withClock(() =>
      connectionsInspect.handler(
        { user_id: null, node_uuid: NODE_UUID, limit: 50 },
        ctxFor({ polls: [BY_NODE_DONE], nodesThrow: true }),
      ),
    )) as Out;

    expect(out.warnings.map((one) => one.code)).toContain('node_listing_unavailable');
  });
});

describe('connections_inspect: input', () => {
  it('demands exactly one direction, because both or neither is a different question', () => {
    expect(() => connectionsInspect.input.parse({})).toThrow();
    expect(() => connectionsInspect.input.parse({ user_id: 6, node_uuid: NODE_UUID })).toThrow();
    expect(connectionsInspect.input.parse({ user_id: 6 })).toMatchObject({
      user_id: 6,
      node_uuid: null,
      limit: 50,
    });
  });

  it('names DROP_CONNECTIONS in the description so asking for it teaches why, not nothing', () => {
    expect(connectionsInspect.description).toContain('DROP_CONNECTIONS');
    expect(connectionsInspect.access).toBe('ro');
    expect(connectionsInspect.profiles).toEqual(['human', 'bot']);
  });
});
