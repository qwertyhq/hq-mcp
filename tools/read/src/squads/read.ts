import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, assertHumanOnly, envelope, num, settle, str, warn } from '../kit.js';

/**
 * Потолок на число сквадов, у которых спрашиваются доступные ноды. Ответ по
 * одному скваду — отдельный запрос, и без потолка инсталляция с сотней сквадов
 * превратила бы один вызов инструмента в сотню обращений к панели. На обычной
 * установке внутренних сквадов единицы, то есть потолок там не срабатывает
 * вовсе; он существует ради разросшейся панели, а не ради типичной.
 */
const NODE_LOOKUP_CAP = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InternalSquad {
  uuid: string;
  name: string | null;
  viewPosition: number | null;
  membersCount: number | null;
  inboundsCount: number | null;
  inbounds: { uuid: string | null; tag: string | null; type: string | null; port: number | null }[];
  accessibleNodes: {
    checked: boolean;
    nodes: {
      uuid: string | null;
      nodeName: string | null;
      countryCode: string | null;
      configProfileName: string | null;
      activeInbounds: string[];
    }[];
  };
}

interface ExternalSquad {
  uuid: string;
  name: string | null;
  viewPosition: number | null;
  membersCount: number | null;
  templateTypes: string[];
  hasSubscriptionSettings: boolean;
  hasHostOverrides: boolean;
  hasHwidSettings: boolean;
  subpageConfigUuid: string | null;
}

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Поля внешнего сквада объявлены nullable и на работающей панели действительно приходят null. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export const squadsRead = defineTool({
  name: 'squads_read',
  description:
    'Both squad families of Remnawave, read only. Internal squads decide REACH: each carries a ' +
    'set of inbounds, and the panel is asked per squad which nodes are actually serving them — ' +
    'that is the answer to "why does this client see fewer servers than that one", which nothing ' +
    'else here could answer. External squads decide PRESENTATION of the subscription (templates, ' +
    'host overrides, hwid settings, response headers); they carry no inbounds at all, so moving a ' +
    'client into one grants no access. Membership is the panel\'s own count, not a list: neither ' +
    'route returns members. Raw xray configs are never returned — squad inbounds carry ' +
    'rawInbound inline with the Reality private key in it, and only tag, type and port leave ' +
    'here. Deliberately absent, because they are mutations: bulk add/remove of users (both ' +
    'families), reordering, and create/update/delete of a squad. This tool cannot change who is ' +
    'in a squad.',
  input: z.object({
    uuid: z
      .string()
      .optional()
      .describe('Narrow to a single squad by uuid; matches an internal or an external one'),
    accessible_nodes: z
      .boolean()
      .default(true)
      .describe(
        'Ask the panel which nodes each internal squad actually reaches (one extra call per ' +
          'squad). Turn off for a cheap listing.',
      ),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * Только human — по той же причине, что infra_map: ответ раскрывает топологию
   * (имена нод, страны, имена конфиг-профилей и теги инбаундов), а это знание
   * оператора, а не ответ на вопрос клиента (§7.2). Имя сквада боту и так
   * доступно — его отдаёт subscription_inspect, — и именно поэтому граница
   * проведена здесь, а не там: разница между «клиент в скваде X» и «сквад X
   * ведёт на эти шесть нод в этих странах» и есть та самая топология.
   */
  profiles: ['human'],
  backends: ['remna'],
  handler: async ({ uuid, accessible_nodes }, ctx) => {
    assertHumanOnly(
      ctx,
      'squads_read is available to the human profile only: a squad answer names nodes, ' +
        'countries, config profiles and inbound tags — the topology, not an answer to a client ' +
        'question (§7.2). subscription_inspect already tells a bot which squads a client is in.',
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const wanted = str(uuid);
    if (wanted !== null && !UUID_RE.test(wanted)) {
      // Панель отвергает не-uuid на валидации (400), и это был бы отказ
      // источника вместо «такого сквада нет». Отвечаем сами.
      warnings.push(
        warn(
          'squad_uuid_malformed',
          `"${wanted}" is not a uuid, so it cannot name a squad. Both families are addressed by ` +
            'uuid only — there is no by-name route. Call without `uuid` to list every squad and ' +
            'pick from the names there.',
        ),
      );
    }

    const [internalRaw, externalRaw] = await Promise.all([
      settle(ctx.remna.get<unknown>('/api/internal-squads')),
      settle(ctx.remna.get<unknown>('/api/external-squads')),
    ]);

    if (!internalRaw.ok) degraded.push({ system: 'remna', error: internalRaw.error });
    if (!externalRaw.ok) degraded.push({ system: 'remna', error: externalRaw.error });

    // `total` берётся из конверта панели, а не из длины массива: подмена одного
    // другим превращает «показано 5 из 40» в «сквадов пять» (§6.4).
    const internalBox = envelope(internalRaw.ok ? internalRaw.value : null, 'internalSquads');
    const externalBox = envelope(externalRaw.ok ? externalRaw.value : null, 'externalSquads');

    const matches = (row: Record<string, unknown>): boolean =>
      wanted === null || str(row.uuid)?.toLowerCase() === wanted.toLowerCase();

    const internalRows = internalBox.rows.filter(matches);
    const externalRows = externalBox.rows.filter(matches);

    /**
     * Доступные ноды спрашиваются ТОЛЬКО у внутренних сквадов, и это не
     * упущение: маршрута accessible-nodes у внешних не существует вовсе
     * (EXTERNAL_SQUADS_ROUTES 3.2.3 — get/create/update/delete, bulk-actions и
     * reorder, и ничего больше). Внешний сквад не раздаёт инбаунды в принципе,
     * поэтому «сколько нод он открывает» — вопрос без предмета, а не без ответа.
     */
    const lookedUp = accessible_nodes ? internalRows.slice(0, NODE_LOOKUP_CAP) : [];
    const nodeAnswers = await Promise.all(
      lookedUp.map(async (row) => {
        const squadUuid = str(row.uuid);
        if (squadUuid === null) return { uuid: null, result: null };
        return {
          uuid: squadUuid,
          result: await settle(
            ctx.remna.get<unknown>(`/api/internal-squads/${encodeURIComponent(squadUuid)}/accessible-nodes`),
          ),
        };
      }),
    );

    const nodesBySquad = new Map<string, InternalSquad['accessibleNodes']>();
    for (const answer of nodeAnswers) {
      const outcome = answer.result;
      if (answer.uuid === null || outcome === null) continue;
      if (!outcome.ok) {
        // Одна и та же недоступность на каждом скваде — один факт: в degraded
        // она пишется один раз, а несчитанность видна по `checked: false`.
        if (!degraded.some((one) => one.error === outcome.error)) {
          degraded.push({ system: 'remna', error: outcome.error });
        }
        nodesBySquad.set(answer.uuid, { checked: false, nodes: [] });
        continue;
      }
      const nodes = asArray(asRecord(outcome.value).accessibleNodes)
        .map(asRecord)
        .map((node) => ({
          uuid: str(node.uuid),
          nodeName: str(node.nodeName),
          countryCode: str(node.countryCode),
          configProfileName: str(node.configProfileName),
          activeInbounds: asArray(node.activeInbounds)
            .map((tag) => str(tag))
            .filter((tag): tag is string => tag !== null),
        }));
      nodesBySquad.set(answer.uuid, { checked: true, nodes });
    }

    const internal: InternalSquad[] = internalRows.map((row) => {
      const squadUuid = str(row.uuid) ?? '';
      const info = asRecord(row.info);
      return {
        uuid: squadUuid,
        name: str(row.name),
        viewPosition: optionalNumber(row.viewPosition),
        membersCount: optionalNumber(info.membersCount ?? row.membersCount),
        inboundsCount: optionalNumber(info.inboundsCount ?? row.inboundsCount),
        // Только состав. `rawInbound` — полный xray-конфиг инбаунда с Reality
        // privateKey, shortIds, serverNames и clients внутри; @hq/redact режет
        // его по имени поля, но проекция надёжнее маркера редакции, и infra_map
        // проводит ту же границу по той же причине.
        inbounds: asArray(row.inbounds)
          .map(asRecord)
          .map((one) => ({
            uuid: str(one.uuid),
            tag: str(one.tag),
            type: str(one.type),
            port: optionalNumber(one.port),
          })),
        accessibleNodes: nodesBySquad.get(squadUuid) ?? { checked: false, nodes: [] },
      };
    });

    const external: ExternalSquad[] = externalRows.map((row) => {
      const info = asRecord(row.info);
      return {
        uuid: str(row.uuid) ?? '',
        name: str(row.name),
        viewPosition: optionalNumber(row.viewPosition),
        membersCount: optionalNumber(info.membersCount ?? row.membersCount),
        templateTypes: asArray(row.templates)
          .map((one) => str(asRecord(one).templateType))
          .filter((one): one is string => one !== null),
        // Только «настроено или нет». Сами переопределения хостов и настройки
        // подписки — это содержимое, которое внешний сквад подставляет в выдачу
        // клиенту, и вываливать его целиком инструмент чтения сквадов не обязан.
        hasSubscriptionSettings: present(row.subscriptionSettings),
        hasHostOverrides: present(row.hostOverrides),
        hasHwidSettings: present(row.hwidSettings),
        subpageConfigUuid: str(row.subpageConfigUuid),
      };
    });

    if (wanted !== null && internal.length === 0 && external.length === 0 && internalRaw.ok && externalRaw.ok) {
      warnings.push(
        warn(
          'squad_not_found',
          `No squad with uuid ${wanted} in either family. Both listings answered, so this is the ` +
            'panel speaking, not a failed call — but a squad deleted between two operations looks ' +
            'exactly the same as one that never existed.',
        ),
      );
    }

    for (const [label, box, shown] of [
      ['internal squads', internalBox, internalBox.rows.length],
      ['external squads', externalBox, externalBox.rows.length],
    ] satisfies Array<[string, { total: number }, number]>) {
      if (box.total > shown) {
        warnings.push(
          warn(
            'truncated',
            `The panel reported ${String(box.total)} ${label} and returned ${String(shown)}. ` +
              'Neither squad route takes pagination, so a short listing is the panel holding rows ' +
              'back, not a window: "this client is in every squad there is" cannot be concluded ' +
              'from this slice.',
          ),
        );
      }
    }

    /**
     * Сквад с участниками, который не ведёт НИ НА ОДНУ ноду. Это не гипотеза:
     * на работающей панели такой сквад находился — мостовые инбаунды, живые
     * участники и ноль доступных нод, то есть подписка выдаётся, а идти по ней
     * некуда. Считается только по успешно прочитанным ответам: `checked: false`
     * — это «не спросили», и превращать его в находку значило бы объявлять
     * аварией недоступность панели.
     */
    const unreachable = internal.filter(
      (squad) =>
        squad.accessibleNodes.checked &&
        squad.accessibleNodes.nodes.length === 0 &&
        (squad.membersCount ?? 0) > 0,
    );
    if (unreachable.length > 0) {
      warnings.push(
        warn(
          'squad_reaches_no_node',
          `${String(unreachable.length)} internal squad(s) have members and reach zero nodes: ` +
            `${unreachable
              .map((one) => `${one.name ?? one.uuid} (${String(one.membersCount ?? 0)} members, ${String(one.inbounds.length)} inbounds)`)
              .join(', ')}. Their inbounds are not active on any node, so those clients get a ` +
            'subscription that leads nowhere. Expected for a squad built out of bridge or relay ' +
            'inbounds — those take traffic from another node by design — so read the tags before ' +
            'calling it an outage.',
        ),
      );
    }

    const notLookedUp = accessible_nodes ? internalRows.length - lookedUp.length : internalRows.length;
    if (notLookedUp > 0) {
      warnings.push(
        warn(
          'accessible_nodes_not_read',
          accessible_nodes
            ? `Accessible nodes were read for the first ${String(NODE_LOOKUP_CAP)} internal ` +
              `squads only; ${String(notLookedUp)} more carry checked=false. Narrow with \`uuid\` ` +
              'to ask about a specific squad rather than reading an empty node list as reach.'
            : 'accessible_nodes=false, so every internal squad carries checked=false and an empty ' +
              'node list. That is "not asked", not "reaches nothing" — the inbound list alone does ' +
              'not say which nodes serve it.',
        ),
      );
    }

    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A panel call did not answer (see `degraded`). The family it owns comes back empty ' +
            'rather than wrong, and an empty list here is not evidence that the install has no ' +
            'squads of that kind — external squads in particular are commonly a single row or ' +
            'none at all, so absence and failure look identical without this note.',
        ),
      );
    }

    return {
      internal: {
        // Серверный счёт и показанный — разные числа, и оба нужны (§6.4).
        total: internalBox.total,
        returned: internal.length,
        checked: internalRaw.ok,
        squads: internal,
      },
      external: {
        total: externalBox.total,
        returned: external.length,
        checked: externalRaw.ok,
        squads: external,
      },
      warnings,
      degraded,
    };
  },
});
