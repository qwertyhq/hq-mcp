import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { nodeConfigAudit } from './config.js';

interface Verdict {
  compared: boolean;
  identical: boolean | null;
  onlyDeclared: string[];
  onlyComputed: string[];
  changedSections: string[];
}

interface Answer {
  profiles: {
    declared_total: number | null;
    returned: number;
    compared: number;
    orphanCount: number;
    items: {
      name: string | null;
      inbounds: Record<string, unknown>[];
      nodeCount: number;
      computed: Verdict;
    }[];
  };
  nodeTags: string[] | null;
  plugins: {
    installed: number | null;
    items: { configRead: boolean; configSections: string[]; nodesUsing: string[] | null }[];
  } | null;
  node: unknown;
  warnings: { code: string; message: string }[];
}

type Handler = typeof nodeConfigAudit.handler;
type Input = Parameters<Handler>[0];

async function run(input: unknown, ctx: Parameters<Handler>[1]): Promise<Answer> {
  return (await nodeConfigAudit.handler(nodeConfigAudit.input.parse(input) as Input, ctx)) as Answer;
}

const PROFILE_UUID = '6410d334-fb9c-4eb3-83c2-80385ffe5c7d';
const ORPHAN_UUID = '73c485ae-2d13-4ccc-9170-dd0cf50f00fb';

/**
 * Форма снята с работающей панели 3.2.3: приватный ключ Reality лежит внутри
 * `streamSettings.realitySettings`, а рядом — `seed` и `shortIds`, которых не
 * видит ни редакция по имени, ни скруббер по форме.
 */
const INBOUND = {
  tag: 'PL_VLESS_XHTTP_REALITY',
  port: 443,
  listen: '0.0.0.0',
  protocol: 'vless',
  settings: { seed: 'xhttp-r3mna-s33d-7k2pQ', clients: [], decryption: 'none' },
  streamSettings: {
    network: 'xhttp',
    security: 'reality',
    realitySettings: {
      dest: '127.0.0.1:9443',
      shortIds: ['a1b2c3d4e5f60789'],
      privateKey: 'ZmFrZVJlYWxpdHlLZXlGb3JUZXN0c09ubHlfMDAwMDA',
      serverNames: ['neth.example.test'],
    },
  },
};

const PROFILES = {
  total: 2,
  configProfiles: [
    {
      uuid: PROFILE_UUID,
      name: 'PL',
      viewPosition: 1,
      config: { log: { loglevel: 'warning' }, inbounds: [INBOUND], outbounds: [], routing: {} },
      inbounds: [{ uuid: 'i-1', tag: INBOUND.tag }],
      nodes: [{ uuid: 'n-1', name: 'Poland' }],
    },
    {
      uuid: ORPHAN_UUID,
      name: 'Old Main',
      viewPosition: 2,
      config: { log: {}, inbounds: [], outbounds: [], routing: {} },
      inbounds: [],
      nodes: [],
    },
  ],
};

function ctxWith(computed?: Record<string, unknown>) {
  return makeCtx({
    remnaGet: (path) => {
      if (path === '/api/config-profiles') return PROFILES;
      if (path.endsWith('/computed-config')) {
        const uuid = path.split('/')[3] ?? '';
        const declared = PROFILES.configProfiles.find((one) => one.uuid === uuid);
        return { uuid, config: computed ?? declared?.config };
      }
      if (path === '/api/nodes/tags') return { tags: [] };
      if (path === '/api/nodes') return [{ uuid: 'n-1', name: 'Poland', activePluginUuid: 'p-1' }];
      if (path === '/api/node-plugins') {
        return { total: 1, nodePlugins: [{ uuid: 'p-1', name: 'Torrent block', pluginConfig: null }] };
      }
      if (path === '/api/node-plugins/p-1') {
        return { uuid: 'p-1', pluginConfig: { torrentBlocker: { enabled: true } } };
      }
      throw new Error(`unexpected path ${path}`);
    },
  });
}

describe('node_config_audit', () => {
  it('never lets the raw xray config out, in declared or computed form', async () => {
    const result = await run({}, ctxWith());
    const text = JSON.stringify(result);
    // Приватный ключ — тот, что редакция по имени поймала бы.
    expect(text).not.toContain('ZmFrZVJlYWxpdHlLZXlGb3JUZXN0c09ubHlfMDAwMDA');
    // А эти два — те, что НЕ ловит ни имя, ни форма, и ради которых ответ
    // строится белым списком, а не чисткой.
    expect(text).not.toContain('xhttp-r3mna-s33d-7k2pQ');
    expect(text).not.toContain('a1b2c3d4e5f60789');
    expect(text).not.toContain('realitySettings');
  });

  it('keeps the facts an operator needs from the inbound it stripped', async () => {
    const result = await run({}, ctxWith());
    expect(result.profiles.items[0]?.inbounds[0]).toEqual({
      tag: 'PL_VLESS_XHTTP_REALITY',
      protocol: 'vless',
      network: 'xhttp',
      security: 'reality',
      port: 443,
      listen: '0.0.0.0',
    });
  });

  it('reports identical computed configs as identical, not as "nothing to see"', async () => {
    const result = await run({}, ctxWith());
    expect(result.profiles.items[0]?.computed.identical).toBe(true);
    expect(result.warnings.map((one) => one.code)).toContain('computed_config_identical');
    expect(result.warnings.map((one) => one.code)).not.toContain('computed_config_differs');
  });

  it('names the inbound tags when the computed config disagrees with the declaration', async () => {
    const result = await run(
      { profile_uuid: PROFILE_UUID },
      ctxWith({ log: { loglevel: 'warning' }, inbounds: [{ ...INBOUND, tag: 'SOMETHING_ELSE' }], outbounds: [], routing: {} }),
    );
    const verdict = result.profiles.items[0]?.computed;
    expect(verdict?.identical).toBe(false);
    expect(verdict?.onlyDeclared).toEqual(['PL_VLESS_XHTTP_REALITY']);
    expect(verdict?.onlyComputed).toEqual(['SOMETHING_ELSE']);
    expect(result.warnings.map((one) => one.code)).toContain('computed_config_differs');
  });

  /**
   * Самое опасное состояние этого инструмента: сверка НЕ ПРОВОДИЛАСЬ, а ответ
   * выглядит как «расхождений нет». `compared: false` и `identical: null`
   * обязаны стоять раздельно, и предупреждение — прозвучать.
   */
  it('never lets an unasked comparison look like agreement', async () => {
    const result = await run({ compare_computed: false }, ctxWith());
    expect(result.profiles.items[0]?.computed).toEqual({
      compared: false,
      identical: null,
      onlyDeclared: [],
      onlyComputed: [],
      changedSections: [],
    });
    expect(result.warnings.map((one) => one.code)).toContain('computed_config_not_compared');
    expect(result.warnings.map((one) => one.code)).not.toContain('computed_config_identical');
  });

  it('finds config profiles that serve no node and says why that matters', async () => {
    const result = await run({}, ctxWith());
    expect(result.profiles.orphanCount).toBe(1);
    const warning = result.warnings.find((one) => one.code === 'config_profile_without_nodes');
    expect(warning?.message).toContain('Old Main');
    expect(warning?.message).toMatch(/still holds live Reality keys/);
  });

  it('distinguishes an empty tag list from an unread one', async () => {
    const result = await run({}, ctxWith());
    expect(result.nodeTags).toEqual([]);
    expect(result.warnings.map((one) => one.code)).toContain('feature_present_but_unused');

    const failing = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/nodes/tags') throw new Error('panel down');
        if (path === '/api/config-profiles') return { total: 0, configProfiles: [] };
        if (path === '/api/nodes') return [];
        if (path === '/api/node-plugins') return { total: 0, nodePlugins: [] };
        throw new Error(`unexpected path ${path}`);
      },
    });
    const degradedResult = await run({}, failing);
    // Не пустой массив: «не прочитали» и «тегов нет» — разные ответы.
    expect(degradedResult.nodeTags).toBeNull();
    expect(degradedResult.warnings.map((one) => one.code)).not.toContain('feature_present_but_unused');
  });

  it('reads plugin config sections from the card, since the listing always says null', async () => {
    const result = await run({}, ctxWith());
    expect(result.plugins?.items[0]?.configRead).toBe(true);
    expect(result.plugins?.items[0]?.configSections).toEqual(['torrentBlocker']);
    expect(result.plugins?.items[0]?.nodesUsing).toEqual(['Poland']);
  });
});
