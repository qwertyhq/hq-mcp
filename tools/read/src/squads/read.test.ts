import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@hq/types';
import { makeCtx } from '../testkit.js';
import type { StubCall } from '../testkit.js';
import { squadsRead } from './read.js';

type Params = Record<string, string | number | undefined>;

interface SquadsOut {
  internal: {
    total: number;
    returned: number;
    checked: boolean;
    squads: {
      uuid: string;
      name: string | null;
      membersCount: number | null;
      inboundsCount: number | null;
      inbounds: { uuid: string | null; tag: string | null; type: string | null; port: number | null }[];
      accessibleNodes: { checked: boolean; nodes: { nodeName: string | null; countryCode: string | null; activeInbounds: string[] }[] };
    }[];
  };
  external: {
    total: number;
    returned: number;
    checked: boolean;
    squads: {
      uuid: string;
      name: string | null;
      membersCount: number | null;
      templateTypes: string[];
      hasHostOverrides: boolean;
    }[];
  };
  warnings: { code: string; message: string }[];
  degraded: { system: string; error: string }[];
}

const MAIN = 'bacc4949-1111-4222-8333-444455556666';
const BRIDGE = '90af39ad-1111-4222-8333-444455556666';
const EXTERNAL = 'd2e2e317-1111-4222-8333-444455556666';

/**
 * Формы сняты с работающей панели 3.2.3 и обрезаны до полей, которые
 * инструмент читает. `rawInbound` оставлен НАРОЧНО, со строкой, похожей на
 * реальный Reality-ключ: тест ниже требует, чтобы он не покидал инструмент.
 * Идентификаторы вымышленные.
 */
const remnaRoutes = (path: string, _params?: Params): unknown => {
  if (path === '/api/internal-squads') {
    return {
      total: 2,
      internalSquads: [
        {
          uuid: MAIN,
          viewPosition: 1,
          name: 'Main Squad',
          info: { membersCount: 1120, inboundsCount: 2 },
          inbounds: [
            {
              uuid: 'i-1',
              tag: 'NL_VLESS_VISION_REALITY',
              type: 'vless',
              port: 443,
              network: 'tcp',
              security: 'reality',
              profileUuid: 'p-1',
              rawInbound: { streamSettings: { realitySettings: { privateKey: 'PRIVATE-KEY-VALUE' } } },
            },
          ],
        },
        {
          uuid: BRIDGE,
          viewPosition: 5,
          name: 'Bride_de_in',
          info: { membersCount: 2, inboundsCount: 2 },
          inbounds: [
            { uuid: 'i-9', tag: 'BRIDGE_DE_IN', type: 'vless', port: 8444 },
            { uuid: 'i-10', tag: 'BRIDGE_DE_IN_2', type: 'vless', port: 8445 },
          ],
        },
      ],
    };
  }
  if (path === '/api/external-squads') {
    return {
      total: 1,
      externalSquads: [
        {
          uuid: EXTERNAL,
          viewPosition: 1,
          name: 'Special',
          info: { membersCount: 0 },
          templates: [{ templateUuid: 't-1', templateType: 'STASH' }],
          subscriptionSettings: null,
          hostOverrides: null,
          hwidSettings: null,
          subpageConfigUuid: null,
        },
      ],
    };
  }
  if (path === `/api/internal-squads/${MAIN}/accessible-nodes`) {
    return {
      squadUuid: MAIN,
      accessibleNodes: [
        {
          uuid: 'n-1',
          nodeName: 'Netherlands',
          countryCode: 'NL',
          configProfileUuid: 'p-1',
          configProfileName: 'main',
          activeInbounds: ['NL_VLESS_VISION_REALITY'],
        },
      ],
    };
  }
  if (path === `/api/internal-squads/${BRIDGE}/accessible-nodes`) {
    // Живой прод: у сквада есть инбаунды и участники, а нод — ноль.
    return { squadUuid: BRIDGE, accessibleNodes: [] };
  }
  throw new Error(`unexpected remna path ${path}`);
};

const run = async (
  input: { uuid?: string; accessible_nodes?: boolean } = {},
  ctx?: ToolContext,
): Promise<SquadsOut> =>
  (await squadsRead.handler(
    { accessible_nodes: input.accessible_nodes ?? true, ...(input.uuid === undefined ? {} : { uuid: input.uuid }) },
    ctx ?? makeCtx({ remnaGet: remnaRoutes }),
  )) as SquadsOut;

describe('squads_read', () => {
  it('is a read-only human tool that gates on nothing', () => {
    expect(squadsRead.name).toBe('squads_read');
    expect(squadsRead.access).toBe('ro');
    expect(squadsRead.risk).toBe('none');
    expect(squadsRead.profiles).toEqual(['human']);
    expect(squadsRead.requires).toBeUndefined();
  });

  it('refuses the bot profile, because the answer is topology', async () => {
    await expect(
      run({}, makeCtx({ profile: 'bot', remnaGet: remnaRoutes })),
    ).rejects.toThrow(/human profile only/);
  });

  it('names the mutations it deliberately does not implement', () => {
    for (const phrase of ['bulk add/remove', 'reorder', 'create/update/delete']) {
      expect(squadsRead.description.toLowerCase()).toContain(phrase);
    }
  });

  it('reports membership and the nodes each internal squad actually reaches', async () => {
    const result = await run();
    expect(result.internal.total).toBe(2);
    expect(result.internal.returned).toBe(2);
    const main = result.internal.squads.find((one) => one.uuid === MAIN);
    expect(main?.membersCount).toBe(1120);
    expect(main?.accessibleNodes).toEqual({
      checked: true,
      nodes: [
        {
          uuid: 'n-1',
          nodeName: 'Netherlands',
          countryCode: 'NL',
          configProfileName: 'main',
          activeInbounds: ['NL_VLESS_VISION_REALITY'],
        },
      ],
    });
    expect(result.external.total).toBe(1);
    expect(result.external.squads[0]?.membersCount).toBe(0);
    expect(result.external.squads[0]?.templateTypes).toEqual(['STASH']);
    expect(result.external.squads[0]?.hasHostOverrides).toBe(false);
  });

  /**
   * Инбаунды сквада приезжают с полным xray-конфигом внутри, а в нём — приватный
   * ключ Reality. @hq/redact режет `rawInbound` по имени поля, но проверяется
   * здесь именно ВЫВОД инструмента: проекция не должна зависеть от того, что
   * список редакции когда-нибудь не переименуют.
   */
  it('never lets a raw inbound config out, private key and all', async () => {
    const result = await run();
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('rawInbound');
    expect(serialised).not.toContain('PRIVATE-KEY-VALUE');
    expect(result.internal.squads[0]?.inbounds[0]).toEqual({
      uuid: 'i-1',
      tag: 'NL_VLESS_VISION_REALITY',
      type: 'vless',
      port: 443,
    });
  });

  it('flags a squad that has members and reaches nothing', async () => {
    const result = await run();
    const found = result.warnings.find((one) => one.code === 'squad_reaches_no_node');
    expect(found?.message).toContain('Bride_de_in');
    expect(found?.message).toContain('2 members');
    // Мосты — законный случай такого сквада, и об этом сказано вслух: иначе
    // находка читается как авария и чинится «публикацией» внутреннего хопа.
    expect(found?.message).toMatch(/bridge or relay/);
  });

  it('does not read "not asked" as "reaches nothing"', async () => {
    const result = await run({ accessible_nodes: false });
    expect(result.internal.squads.every((one) => !one.accessibleNodes.checked)).toBe(true);
    // Ноль нод при checked=false не имеет права стать находкой.
    expect(result.warnings.map((one) => one.code)).not.toContain('squad_reaches_no_node');
    expect(result.warnings.map((one) => one.code)).toContain('accessible_nodes_not_read');
  });

  it('narrows to one squad by uuid across both families', async () => {
    const external = await run({ uuid: EXTERNAL });
    expect(external.internal.returned).toBe(0);
    expect(external.external.returned).toBe(1);
    // Серверный счёт остаётся полным: сужение сделано у нас, а не панелью.
    expect(external.internal.total).toBe(2);
  });

  it('says "no such squad" only when both listings actually answered', async () => {
    const missing = await run({ uuid: '00000000-0000-4000-8000-000000000000' });
    expect(missing.warnings.map((one) => one.code)).toContain('squad_not_found');

    const broken = await run(
      { uuid: '00000000-0000-4000-8000-000000000000' },
      makeCtx({
        remnaGet: (path: string) => {
          if (path === '/api/internal-squads') throw new Error('panel 502');
          return remnaRoutes(path);
        },
      }),
    );
    // Панель не ответила — «такого сквада нет» это не утверждение, а догадка.
    expect(broken.warnings.map((one) => one.code)).not.toContain('squad_not_found');
    expect(broken.warnings.map((one) => one.code)).toContain('partial_result');
  });

  it('answers a malformed uuid itself instead of letting the panel 400', async () => {
    const calls: StubCall[] = [];
    const result = await run({ uuid: 'Main Squad' }, makeCtx({ remnaGet: remnaRoutes, calls }));
    expect(result.warnings.map((one) => one.code)).toContain('squad_uuid_malformed');
    expect(calls.some((one) => one.path.includes('Main%20Squad'))).toBe(false);
  });

  it('degrades softly: one family failing does not empty the other', async () => {
    const result = await run(
      {},
      makeCtx({
        remnaGet: (path: string) => {
          if (path === '/api/external-squads') throw new Error('panel 500');
          return remnaRoutes(path);
        },
      }),
    );
    expect(result.internal.returned).toBe(2);
    expect(result.external.checked).toBe(false);
    expect(result.external.squads).toEqual([]);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'panel 500' }]);
    expect(result.warnings.find((one) => one.code === 'partial_result')?.message).toMatch(
      /not evidence that the install has no squads/,
    );
  });

  it('reports the panel count, not the array length, and warns when they differ', async () => {
    const result = await run(
      {},
      makeCtx({
        remnaGet: (path: string) => {
          if (path === '/api/internal-squads') {
            return { total: 40, internalSquads: [{ uuid: MAIN, name: 'Main Squad', info: { membersCount: 1 } }] };
          }
          if (path.endsWith('/accessible-nodes')) return { accessibleNodes: [{ uuid: 'n-1' }] };
          return remnaRoutes(path);
        },
      }),
    );
    expect(result.internal.total).toBe(40);
    expect(result.internal.returned).toBe(1);
    expect(result.warnings.find((one) => one.code === 'truncated')?.message).toContain('40');
  });

  it('marks a squad whose node lookup failed as unchecked rather than unreachable', async () => {
    const result = await run(
      {},
      makeCtx({
        remnaGet: (path: string) => {
          if (path.endsWith('/accessible-nodes')) throw new Error('panel 503');
          return remnaRoutes(path);
        },
      }),
    );
    expect(result.internal.squads.every((one) => !one.accessibleNodes.checked)).toBe(true);
    expect(result.warnings.map((one) => one.code)).not.toContain('squad_reaches_no_node');
    // Одна и та же ошибка на двух сквадах — один факт, не два.
    expect(result.degraded).toEqual([{ system: 'remna', error: 'panel 503' }]);
  });
});
