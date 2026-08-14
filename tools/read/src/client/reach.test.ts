import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { clientReach } from './reach.js';

interface Answer {
  reach: {
    userId: number;
    nodeCount: number;
    countries: string[];
    squadNames: string[];
    nodes: { nodeName: string | null; squads: { squadName: string | null; inboundCount: number }[] }[];
  } | null;
  tags: { count: number; catalogue: string[] } | null;
  warnings: { code: string; message: string }[];
}

type Handler = typeof clientReach.handler;
type Input = Parameters<Handler>[0];

async function run(input: unknown, ctx: Parameters<Handler>[1]): Promise<Answer> {
  return (await clientReach.handler(clientReach.input.parse(input) as Input, ctx)) as Answer;
}

const REACH = {
  userId: 6,
  activeNodes: [
    {
      uuid: 'n-1',
      nodeName: 'Poland',
      countryCode: 'PL',
      configProfileUuid: 'p-1',
      configProfileName: 'PL',
      activeSquads: [
        { squadName: 'Main Squad', activeInbounds: ['PL_VLESS_XHTTP_REALITY', 'HA-CLONE PL'] },
        { squadName: 'Hysteria2', activeInbounds: ['HY2_PL'] },
      ],
    },
    {
      uuid: 'n-2',
      nodeName: 'Estonia',
      countryCode: 'EE',
      configProfileUuid: 'p-2',
      configProfileName: 'EST',
      activeSquads: [{ squadName: 'Main Squad', activeInbounds: ['EST_VLESS_VISION_REALITY'] }],
    },
  ],
};

function ctxWith(reach: unknown = REACH, tags: unknown = { tags: ['BRIDGE_RELAY', 'SHM'] }) {
  return makeCtx({
    remnaGet: (path) => {
      if (path === '/api/users/tags') return tags;
      if (path.endsWith('/accessible-nodes')) {
        if (reach instanceof Error) throw reach;
        return reach;
      }
      throw new Error(`unexpected path ${path}`);
    },
  });
}

describe('client_reach', () => {
  it('answers which nodes, countries and squads a client actually reaches', async () => {
    const result = await run({ user_id: 6 }, ctxWith());
    expect(result.reach?.nodeCount).toBe(2);
    expect(result.reach?.countries).toEqual(['EE', 'PL']);
    expect(result.reach?.squadNames).toEqual(['Hysteria2', 'Main Squad']);
    expect(result.reach?.nodes[0]?.squads[0]?.inboundCount).toBe(2);
  });

  /**
   * Живой аккаунт, которому некуда подключаться, — это находка, а не пустой
   * ответ. Ровно тот случай, ради которого маршрут и читается.
   */
  it('calls out an existing client that reaches nothing', async () => {
    const result = await run({ user_id: 6 }, ctxWith({ userId: 6, activeNodes: [] }));
    expect(result.reach?.nodeCount).toBe(0);
    const warning = result.warnings.find((one) => one.code === 'client_reaches_no_node');
    expect(warning?.message).toMatch(/exists and reaches ZERO nodes/);
  });

  it('separates a missing client from a client without access', async () => {
    const result = await run({ user_id: 99999999 }, ctxWith(new Error('Remnawave GET: User not found')));
    expect(result.reach).toBeNull();
    const codes = result.warnings.map((one) => one.code);
    expect(codes).toContain('user_not_found');
    expect(codes).not.toContain('client_reaches_no_node');
  });

  /**
   * Панель молчит — вывода нет. Пустой список тут не имеет права выглядеть как
   * «клиент никуда не достаёт»: это тот же класс ошибки, что четырежды
   * встречался в этом репозитории.
   */
  it('reads a failed call as unknown, never as "reaches nothing"', async () => {
    const result = await run({ user_id: 6 }, ctxWith(new Error('panel down')));
    expect(result.reach).toBeNull();
    const codes = result.warnings.map((one) => one.code);
    expect(codes).toContain('partial_result');
    expect(codes).not.toContain('client_reaches_no_node');
    expect(codes).not.toContain('user_not_found');
  });

  it('flags a reachable node that grants no inbound at all', async () => {
    const result = await run(
      { user_id: 6 },
      ctxWith({
        userId: 6,
        activeNodes: [{ uuid: 'n-3', nodeName: 'Finland', countryCode: 'FI', activeSquads: [] }],
      }),
    );
    const warning = result.warnings.find((one) => one.code === 'reachable_node_grants_no_inbound');
    expect(warning?.message).toContain('Finland');
  });

  it('returns the tag catalogue and distinguishes empty from unread', async () => {
    const withTags = await run({ user_id: null }, ctxWith(REACH));
    expect(withTags.tags?.catalogue).toEqual(['BRIDGE_RELAY', 'SHM']);
    expect(withTags.reach).toBeNull();

    const empty = await run({ user_id: null }, ctxWith(REACH, { tags: [] }));
    expect(empty.warnings.map((one) => one.code)).toContain('feature_present_but_unused');
  });

  it('refuses the bot profile with a reason about topology, not a generic denial', async () => {
    const ctx = makeCtx({ profile: 'bot', remnaGet: () => REACH });
    await expect(run({ user_id: 6 }, ctx)).rejects.toThrow(/human profile only/);
  });
});
