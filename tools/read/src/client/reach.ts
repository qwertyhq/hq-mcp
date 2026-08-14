import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, assertHumanOnly, num, settle, str, take, warn } from '../kit.js';

/**
 * `GET /api/users/{id}/accessible-nodes` — ЕДИНСТВЕННЫЙ маршрут панели,
 * отвечающий на «до каких серверов этот клиент реально достаёт». Всё остальное
 * отвечает на соседние вопросы и подменять его не может:
 *   squads_read       — какие ноды обслуживают СКВАД (а клиент может быть в
 *                       нескольких, и пересечение считать пришлось бы нам);
 *   infra_map         — какие ноды есть вообще;
 *   country_health    — жива ли страна.
 * Панель складывает это сама, по своим правилам, и её ответ — единственный,
 * который не расходится с тем, что клиент увидит в приложении.
 *
 * ОТСУТСТВУЮЩИЙ КЛИЕНТ ОТЛИЧИМ ОТ ПУСТОГО ОТВЕТА, и это проверено запросом к
 * работающей панели 3.2.3, а не вычитано в контракте: несуществующий id даёт
 * 404 с телом `{"message":"User not found","errorCode":"A025"}`, то есть
 * приложение подписывается `errorCode`, и клиент @hq/remna по нему отличает его
 * от роутерного 404. Пустой `activeNodes` у СУЩЕСТВУЮЩЕГО клиента — совсем
 * другой факт: он есть, и ему некуда подключаться.
 */
const REACH_PATH = (userId: number): string => `/api/users/${String(userId)}/accessible-nodes`;
const USER_TAGS_PATH = '/api/users/tags';

interface ReachSquad {
  squadName: string | null;
  inboundCount: number;
  inbounds: string[];
}

interface ReachNode {
  uuid: string | null;
  nodeName: string | null;
  countryCode: string | null;
  configProfileName: string | null;
  squads: ReachSquad[];
}

export const clientReach = defineTool({
  name: 'client_reach',
  description:
    'Which nodes one client can actually reach, straight from the panel: node, country, config ' +
    'profile, and the squads and inbound tags that grant the access. This is the answer to "why ' +
    'does this client see fewer servers than that one" from the CLIENT side — squads_read ' +
    'answers it from the squad side and cannot, because a client may be in several squads and ' +
    'the union is the panel\'s to compute, not ours. ' +
    'An empty reach list is a finding, not an empty answer: a client who reaches no node has an ' +
    'account and nowhere to connect, and that is reported as its own warning. A client who does ' +
    'not exist is a different answer again — the panel signs that one with an error code and ' +
    'this tool says so rather than returning an empty list. ' +
    'Also returns the panel\'s user tag catalogue, because tags are how clients get grouped and ' +
    'there is no other way to learn which ones exist before filtering on one. ' +
    'The client id here is the panel\'s numeric id, not the SHM user_id and not a uuid — ' +
    'client_resolve maps between them.',
  input: z.object({
    user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Panel user id (numeric). Omit to read only the tag catalogue'),
    include_tags: z.boolean().default(true).describe("Also read the panel's user tag catalogue"),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * Только human, и это следование УЖЕ ПРОВЕДЁННОЙ границе, а не новая
   * осторожность. squads_read объявлен human-only ровно потому, что «сквад X
   * ведёт на эти шесть нод в этих странах» — топология; здесь панель отдаёт то
   * же самое, только отфильтрованное по одному клиенту: nodeName, countryCode,
   * configProfileName и теги инбаундов. Отдать боту тот же состав под другим
   * входным параметром значило бы обойти §7.2 формулировкой вопроса.
   *
   * Чем это НЕ является: запретом отвечать клиенту на «какие у меня страны».
   * На него отвечает subscription_inspect, у которого есть сквады клиента, — и
   * именно в этом разница между «клиент в скваде X» и картой того, из чего
   * сквад собран.
   */
  profiles: ['human'],
  backends: ['remna'],
  handler: async ({ user_id, include_tags }, ctx) => {
    assertHumanOnly(
      ctx,
      'client_reach is available to the human profile only: it names nodes, countries, config ' +
        'profiles and inbound tags for a client — the same topology squads_read is human-only ' +
        'for (§7.2), asked from the other end. subscription_inspect already tells a bot which ' +
        "squads a client is in.",
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const [reach, tags] = await Promise.all([
      user_id === null
        ? Promise.resolve({ ok: true as const, value: null })
        : settle(ctx.remna.get<unknown>(REACH_PATH(user_id))),
      include_tags
        ? settle(ctx.remna.get<unknown>(USER_TAGS_PATH))
        : Promise.resolve({ ok: true as const, value: null }),
    ]);

    // Отказ чтения досягаемости НЕ смешивается с отказом каталога тегов:
    // `take` пишет в degraded оба, но вывод из первого — «про клиента ничего
    // не известно», а из второго — «каталог не прочитан», и путать их нельзя.
    const body = asRecord(take(reach, 'remna', degraded, null));
    const nodes: ReachNode[] = asArray(body.activeNodes)
      .map(asRecord)
      .map((row) => ({
        uuid: str(row.uuid),
        nodeName: str(row.nodeName),
        countryCode: str(row.countryCode),
        configProfileName: str(row.configProfileName),
        squads: asArray(row.activeSquads)
          .map(asRecord)
          .map((squad) => {
            const inbounds = asArray(squad.activeInbounds)
              .map((one) => str(one))
              .filter((one): one is string => one !== null);
            return { squadName: str(squad.squadName), inboundCount: inbounds.length, inbounds };
          }),
      }));

    const countries = [
      ...new Set(nodes.map((one) => one.countryCode).filter((one): one is string => one !== null)),
    ].sort();
    const squadNames = [
      ...new Set(
        nodes.flatMap((one) => one.squads.map((squad) => squad.squadName)).filter((one): one is string => one !== null),
      ),
    ].sort();

    const tagList = asArray(asRecord(take(tags, 'remna', degraded, null)).tags)
      .map((one) => str(one))
      .filter((one): one is string => one !== null);

    if (user_id !== null && !reach.ok && /not found/i.test(reach.error)) {
      warnings.push(
        warn(
          'user_not_found',
          `The panel has no user with id ${String(user_id)}. This is the panel's own answer, ` +
            'signed with its error code, not a read failure and not a client without access. ' +
            'Note the id space: this is the numeric panel id, not the SHM user_id and not a ' +
            'uuid — client_resolve maps between them.',
        ),
      );
    }
    if (user_id !== null && reach.ok && nodes.length === 0) {
      warnings.push(
        warn(
          'client_reaches_no_node',
          `Panel user ${String(user_id)} exists and reaches ZERO nodes. This is a finding, not ` +
            'an empty result: the account is there and has nowhere to connect, so every app on ' +
            'every device will fail for this client no matter what the subscription says. The ' +
            'usual cause is squad membership — the client is in no squad, or in one whose ' +
            'inbounds are active on no node (squads_read names which).',
        ),
      );
    }
    if (user_id !== null && reach.ok && nodes.length > 0) {
      const silent = nodes.filter((one) => one.squads.length === 0).map((one) => one.nodeName ?? '?');
      if (silent.length > 0) {
        warnings.push(
          warn(
            'reachable_node_grants_no_inbound',
            `${String(silent.length)} node(s) are listed as accessible while granting this ` +
              `client no inbound at all (${silent.join(', ')}). The node counts towards "how ` +
              'many servers do I have" and carries no way in, so a client counting entries in ' +
              'their app will see more than they can use.',
          ),
        );
      }
    }
    if (include_tags && tags.ok && tagList.length === 0) {
      warnings.push(
        warn(
          'feature_present_but_unused',
          'The user tag route answered normally and returned no tags: tagging works on this ' +
            'panel and nothing uses it. A search or automation keyed on a user tag matches ' +
            'nothing here because there is nothing to match, not because it is broken.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). If the reach call is the one that ' +
            'failed, the empty node list below says nothing about this client — read it as ' +
            'unknown, never as "reaches nothing".',
        ),
      );
    }

    return {
      reach:
        user_id === null || !reach.ok
          ? null
          : {
              userId: optionalNumber(body.userId) ?? user_id,
              nodeCount: nodes.length,
              countries,
              squadNames,
              nodes,
            },
      tags: include_tags && tags.ok ? { count: tagList.length, catalogue: tagList } : null,
      warnings,
      degraded,
    };
  },
});

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
