import { defineTool } from '@hq/registry';
import {
  buildTopology,
  hostsWithUnknownInbound,
  inboundsActiveWithoutHost,
  inboundsPublishedOnlyByDisabledHosts,
} from '@hq/remna';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, assertHumanOnly, num, settle, str, take, warn } from '../kit.js';

/** Дыра, которую НЕ посчитали, и почему. Отсутствие находки ≠ отсутствие проблемы. */
interface Suppression {
  gap: string;
  reason: string;
}

/** Список панели: приехал ли он и не короче ли он собственного total. */
interface Listing {
  rows: Record<string, unknown>[];
  ok: boolean;
  reported: number | null;
  short: boolean;
}

function listing(value: unknown, ok: boolean, key: string): Listing {
  const body = asRecord(value);
  const rows = asArray(body[key] ?? value).map(asRecord);
  const reported = num(body.total, Number.NaN);
  const known = Number.isFinite(reported) ? reported : null;
  return { rows, ok, reported: known, short: known !== null && known > rows.length };
}

function mapperSummary(value: unknown): {
  configured: boolean; operations: Record<string, number>;
} | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const mapper = asRecord(value);
  const operations: Record<string, number> = {};
  for (const format of ['xrayJson', 'mihomo', 'base64', 'singbox']) {
    const rows = mapper[format];
    if (rows !== undefined && !Array.isArray(rows)) return null;
    operations[format] = Array.isArray(rows) ? rows.length : 0;
  }
  return { configured: Object.values(operations).some((count) => count > 0), operations };
}

export const infraMap = defineTool({
  name: 'infra_map',
  description:
    'Nodes x config profiles x inbounds x hosts x squads with the breaks highlighted: hosts that ' +
    'point at an inbound that no longer exists, inbounds a node serves but no host publishes, ' +
    'inbounds whose only host is switched off, and nodes without a profile. An unhosted inbound ' +
    'is reported only when some node actually serves it — bridge and relay inbounds take traffic ' +
    'from another node and are meant to have no host, so publishing one would hand clients an ' +
    'internal hop. Every gap is computed only from listings that answered in full: when a source ' +
    'is missing the gap comes back null with a reason in `suppressed`, never as a list. Raw xray ' +
    'configs are deliberately not returned — profiles and inbounds carry them inline, Reality ' +
    'private keys included. Hosts include mapper operation counts by client format; nodes ' +
    'include ordered integration bindings when the panel exposes them (Remnawave 3.3+).',
  input: z.object({}),
  access: 'ro',
  risk: 'none',
  // Только human: карта раскрывает топологию — теги хостов, привязку инбаундов
  // к профилям и составы сквадов. Боту этого знать незачем (§7.2).
  profiles: ['human'],
  backends: ['remna'],
  handler: async (_input, ctx) => {
    assertHumanOnly(
      ctx,
      'infra_map is available to the human profile only: the map lays out the topology — host ' +
        'tags, which inbound belongs to which config profile and who is in which squad — and ' +
        'that is operator knowledge, not an answer to a client question (§7.2).',
    );
    const degraded: Degraded[] = [];
    const warnings: ToolWarning[] = [];
    const suppressed: Suppression[] = [];

    const [nodes, profiles, inbounds, hosts, squads] = await Promise.all([
      settle(ctx.remna.get<unknown>('/api/nodes')),
      settle(ctx.remna.get<unknown>('/api/config-profiles')),
      settle(ctx.remna.get<unknown>('/api/config-profiles/inbounds')),
      settle(ctx.remna.get<unknown>('/api/hosts')),
      settle(ctx.remna.get<unknown>('/api/internal-squads')),
    ]);

    // ВСЕ take() — до подсчёта предупреждений (тот же порядок, что в
    // client_overview): иначе часть деградаций осталась бы немаркированной.
    const nodeValue = take(nodes, 'remna', degraded, null);
    const profileValue = take(profiles, 'remna', degraded, null);
    const inboundValue = take(inbounds, 'remna', degraded, null);
    const hostValue = take(hosts, 'remna', degraded, null);
    const squadValue = take(squads, 'remna', degraded, null);

    // /api/nodes и /api/hosts отдают голый массив без total; остальные три —
    // конверт со своим числом строк, которое и есть серверный счёт по §6.4.
    const nodeList = listing(nodeValue, nodes.ok, 'nodes');
    const profileList = listing(profileValue, profiles.ok, 'configProfiles');
    const inboundList = listing(inboundValue, inbounds.ok, 'inbounds');
    const hostList = listing(hostValue, hosts.ok, 'hosts');
    const squadList = listing(squadValue, squads.ok, 'internalSquads');

    /**
     * Карта и три разрыва считаются ОДНИМ модулем на двоих с `host_cleanup`
     * (`buildTopology` в @hq/remna). Мутатор удаления обязан решать «не гаснет
     * ли страна» ровно по этим правилам, а две копии арифметики разъехались бы
     * молча: инструмент удаления продолжал бы выглядеть согласованным с картой.
     * Здесь остаётся только то, чего чистый модуль знать не может, — приехал ли
     * листинг и можно ли вообще считать разрыв.
     */
    const topology = buildTopology({
      nodes: nodeList.rows,
      hosts: hostList.rows,
      inbounds: inboundList.rows,
      profiles: profileList.rows,
    });
    const rawNodes = new Map(nodeList.rows.map((row) => [str(row.uuid), row]));
    const rawHosts = new Map(hostList.rows.map((row) => [str(row.uuid), row]));
    const mappedNodes = topology.nodes.map((node) => {
      const bindings = rawNodes.get(node.uuid)?.integrationUuids;
      return {
        ...node,
        integrationUuids: Array.isArray(bindings) && bindings.every((item) => typeof item === 'string')
          ? bindings as string[] : null,
      };
    });
    const mappedProfiles = topology.profiles;
    const mappedHosts = topology.hosts.map((host) => ({
      ...host, mapper: mapperSummary(rawHosts.get(host.uuid)?.mapper),
    }));

    /**
     * Если ни один листинг инбаундов не приехал целиком, дыра не считается
     * вовсе: пустое множество известных инбаундов объявило бы зомби КАЖДЫЙ
     * хост — на проверенных панелях это десятки ложных находок разом.
     *
     * «Ответил целиком» проверяется ВМЕСТЕ с «назвал хоть один инбаунд»: пустой
     * `{total: 0, configProfiles: []}` или профили без вложенного inbounds[]
     * формально полны, а множество после них пусто — и та же инверсия
     * возвращается через дверь поуже.
     */
    const complete = (one: Listing): boolean => one.ok && !one.short;
    const knownInbounds = topology.knownInbounds;
    const inboundsUsable =
      (complete(inboundList) || complete(profileList)) && knownInbounds.size > 0;

    const suppress = (gap: string, reason: string): null => {
      suppressed.push({ gap, reason });
      return null;
    };

    const hostsUnknownInbound =
      hostList.ok && inboundsUsable
        ? hostsWithUnknownInbound(topology)
        : suppress(
            'hostsWithUnknownInbound',
            !hostList.ok
              ? 'the host listing did not answer, so there is nothing to check'
              : 'no inbound listing came back both complete and non-empty, and against an empty ' +
                'set of known inbounds every host looks like it points at one that no longer exists',
          );

    /**
     * «Инбаунд, который никто не публикует» без этой оговорки срабатывает на
     * заметной части инбаундов вполне здоровых панелей, включая мостовые:
     * мосты и релейные хопы принимают трафик с ДРУГОЙ ноды, и
     * скрипт настройки моста хоста для них не создаёт намеренно. Дырой это
     * становится только там, где инбаунд кто-то обслуживает.
     */
    const activeWithoutHost =
      nodeList.ok && hostList.ok
        ? inboundsActiveWithoutHost(topology)
        : suppress(
            'inboundsActiveWithoutHost',
            !nodeList.ok
              ? 'the node listing did not answer, and without it "some node serves this inbound" ' +
                'cannot be established — the remaining half would report bridges as breaks'
              : 'the host listing did not answer, and against an empty set of hosts every inbound ' +
                'looks unpublished',
          );

    /**
     * Инбаунд, у которого все хосты выключены, наивная проверка считает
     * опубликованным: usedInbounds строится по ВСЕМ хостам. На работающих
     * панелях такие инбаунды находятся по нескольку штук на панель — то самое
     * «страна погасла, и никто не заметил».
     */
    const publishedOnlyByDisabledHosts = hostList.ok
      ? inboundsPublishedOnlyByDisabledHosts(topology)
      : suppress(
          'inboundsPublishedOnlyByDisabledHosts',
          'the host listing did not answer, so which inbounds are left without a live host is ' +
            'unknown',
        );

    const nodesWithoutProfile = nodeList.ok
      ? mappedNodes
          .filter((node) => node.profileUuid === null)
          .map((node) => ({ uuid: node.uuid, name: node.name }))
      : suppress('nodesWithoutProfile', 'the node listing did not answer');

    const disabledHosts = hostList.ok
      ? mappedHosts.filter((host) => host.isDisabled).length
      : suppress('disabledHosts', 'the host listing did not answer');

    const shortLists = (
      [
        ['profiles', profileList],
        ['inbounds', inboundList],
        ['squads', squadList],
      ] satisfies Array<[string, Listing]>
    ).filter(([, one]) => one.short);
    if (shortLists.length > 0) {
      warnings.push(
        warn(
          'truncated',
          `The panel reported more rows than it returned: ` +
            `${shortLists
              .map(([name, one]) => `${name} ${String(one.rows.length)} of ${String(one.reported ?? 0)}`)
              .join(', ')}. Anything counted from a short listing is about the slice, not about ` +
            'the install, so the gaps that depend on it are suppressed rather than computed.',
        ),
      );
    }
    if (activeWithoutHost !== null && activeWithoutHost.length > 0) {
      warnings.push(
        warn(
          'unhosted_inbound_may_be_a_relay',
          `${String(activeWithoutHost.length)} inbounds are active on a node with no host ` +
            'publishing them. That is expected for relay and bridge hops — they take traffic from ' +
            'another node, not from clients, and the setup scripts create no host for them on ' +
            'purpose. It is a break only for a client-facing inbound. Publishing a bridge to ' +
            'clients is a security regression, not a repair: identify each tag before acting.',
        ),
      );
    }
    if (
      publishedOnlyByDisabledHosts !== null &&
      publishedOnlyByDisabledHosts.length > 0
    ) {
      warnings.push(
        warn(
          'inbounds_left_without_a_live_host',
          `${String(publishedOnlyByDisabledHosts.length)} inbounds are published only by ` +
            'hosts that are disabled, so no subscriber receives them any more while the nodes and ' +
            'the config stay in place. This is how a country goes dark without anything looking ' +
            'broken — the bare count of disabled hosts never says which entry points went with them.',
        ),
      );
    }
    // Считается ПОСЛЕ всех пяти take() выше.
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A panel listing did not answer (see `degraded`). Every gap that depended on it is null ' +
            'with a reason in `suppressed` rather than computed from what is left: on a half-read ' +
            'panel the gap lists invert, reporting every host and every inbound as broken.',
        ),
      );
    }

    return {
      counts: {
        nodes: mappedNodes.length,
        profiles: mappedProfiles.length,
        inbounds: knownInbounds.size,
        hosts: mappedHosts.length,
        squads: squadList.rows.length,
        // Серверный счёт там, где панель его называет (§6.4); null — не назвала.
        reported: {
          profiles: profileList.reported,
          inbounds: inboundList.reported,
          squads: squadList.reported,
        },
      },
      nodes: mappedNodes,
      profiles: mappedProfiles,
      hosts: mappedHosts,
      squads: squadList.rows.map((row) => ({
        uuid: str(row.uuid) ?? '',
        name: str(row.name),
        membersCount: num(asRecord(row.info).membersCount ?? row.membersCount),
      })),
      gaps: {
        hostsWithUnknownInbound: hostsUnknownInbound,
        inboundsActiveWithoutHost: activeWithoutHost,
        inboundsPublishedOnlyByDisabledHosts: publishedOnlyByDisabledHosts,
        nodesWithoutProfile,
        disabledHosts,
      },
      suppressed,
      warnings,
      degraded,
    };
  },
});
