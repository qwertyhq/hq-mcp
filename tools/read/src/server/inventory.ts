import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asArray,
  asRecord,
  assertHumanOnly,
  num,
  parseSettings,
  safeEndpoint,
  settle,
  str,
  take,
  warn,
} from '../kit.js';
import type { SafeEndpoint } from '../kit.js';

const SERVERS = '/admin/server';
const GROUPS = '/admin/server/group';
const SQUADS = '/api/internal-squads';
const PAGE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Дыра, которую НЕ посчитали, и почему. Отсутствие находки ≠ отсутствие проблемы. */
interface Suppression {
  gap: string;
  reason: string;
}

interface ServerRow {
  serverId: number;
  groupId: number | null;
  name: string | null;
  transport: string | null;
  enabled: boolean;
  weight: number;
  servicesCount: number;
  /** null — потолка нет: Perl считает 0 и undef одинаково ложными (см. ниже). */
  maxServices: number | null;
  templateId: string | null;
  endpoint: SafeEndpoint;
  ip: string | null;
  usesSshIdentity: boolean;
  panelSquads: string[];
  /** ИМЕНА полей settings, а не значения: там живут пароли и заголовки. */
  settingsFields: string[];
}

interface GroupRow {
  groupId: number;
  name: string | null;
  transport: string | null;
  selection: string | null;
  members: number;
  enabledMembers: number;
  usableMembers: number;
}

/**
 * UUID сквадов панели, на которые ссылается конфигурация сервера. Ключей два и
 * они в разных написаниях (`remnawave_squads` — массив Internal Squads для
 * новых пользователей, `remnawave_external_squad` — один External Squad;
 * tempaltes/remnawave.tpl:164-192), поэтому берутся ВСЕ ключи, в имени которых
 * есть `squad`, а из значений — только строки формы uuid. Читать один ключ —
 * тот же класс ошибки, что ловили на `subscription_id`/`subscriptionid`.
 */
function squadUuids(settings: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(settings)) {
    if (!/squad/i.test(key)) continue;
    for (const item of asArray(value)) {
      const text = str(item);
      if (text !== null && UUID_RE.test(text)) out.add(text);
    }
  }
  return [...out];
}

function toServer(row: Record<string, unknown>): ServerRow {
  const settings = parseSettings(row.settings);
  // `max_services` проверяется в Perl как `if ( $_->{settings}->{max_services} )`
  // (Core/ServerGroups.pm:60-65) — то есть 0 там означает НЕТ ПОТОЛКА, а не
  // «мест нет». Прочитать 0 как предел — значит объявить переполненным каждый
  // сервер: на работающей установке это поле у всех серверов 0 или пусто.
  const cap = num(settings.max_services, 0);
  const gid = num(row.server_gid, Number.NaN);
  return {
    serverId: num(row.server_id, 0),
    groupId: Number.isFinite(gid) ? gid : null,
    name: str(row.name),
    transport: str(row.transport),
    enabled: num(row.enabled, 0) === 1,
    weight: num(row.weight),
    servicesCount: num(row.services_count),
    maxServices: cap > 0 ? cap : null,
    templateId: str(settings.template_id),
    endpoint: safeEndpoint(row.host),
    ip: str(row.ip),
    // Ключ приезжает сюда уже маркером — `key_id` матчит SECRET_KEY_RE в
    // @hq/redact, — поэтому наружу идёт только факт «сервер ходит по ключу».
    usesSshIdentity: settings.key_id !== undefined && settings.key_id !== null,
    panelSquads: squadUuids(settings),
    settingsFields: Object.keys(settings).sort(),
  };
}

export const serverInventory = defineTool({
  name: 'server_inventory',
  description:
    'The server list SHM itself provisions through: transports (ssh/http/mail/telegram/local), ' +
    'their groups and the selection rules, with the breaks that stop provisioning silently — ' +
    'a group with no server it can pick, a server pointing at a group that no longer exists, a ' +
    'server at its max_services cap, a group whose declared transport differs from its members. ' +
    'This is NOT the Remnawave node list and is not reconciled against it: SHM servers here are ' +
    'notification and provisioning endpoints, not VPN nodes, so pairing the two lists would ' +
    'report every SHM transport and every panel node as missing. The one real crossing is ' +
    'checked: the internal-squad uuids the provisioning server assigns to new users are looked ' +
    'up in the panel. Server rows are never returned whole — `host` keeps scheme, host and port ' +
    'only, and `settings` is reduced to a few operational fields plus the NAMES of the rest, ' +
    'because credentials live inside values here (an SMTP password, an api-key header, and a ' +
    'live bot token inside a host URL). SSH identities (/admin/server/identity) are not read at ' +
    'all: that route returns private keys and is refused by this server.',
  input: z.object({}),
  access: 'ro',
  risk: 'none',
  // Только human: это карта того, как биллинг дотягивается до мира — SMTP-хосты,
  // адреса вебхуков, ёмкость провижининга и перечень того, какие креды у какого
  // транспорта заведены. Ни на один вопрос клиента это не отвечает (§7.2).
  profiles: ['human'],
  // Список серверов ведёт SHM, и это и есть ответ; сквады панели —
  // перекрёстная ссылка, без которой инвентаризация остаётся полной.
  backends: ['shm'],
  handler: async (_input, ctx) => {
    assertHumanOnly(
      ctx,
      'server_inventory is available to the human profile only: it maps how billing reaches the ' +
        'outside world — mail hosts, webhook endpoints, provisioning capacity and which ' +
        'credentials each transport carries. That is operator knowledge, not an answer to a ' +
        'client question (§7.2).',
    );
    const degraded: Degraded[] = [];
    const warnings: ToolWarning[] = [];
    const suppressed: Suppression[] = [];

    const [serverList, groupList, squadList] = await Promise.all([
      settle(ctx.shm.list<Record<string, unknown>>(SERVERS, { limit: PAGE })),
      settle(ctx.shm.list<Record<string, unknown>>(GROUPS, { limit: PAGE })),
      // Панель здесь — перекрёстная ссылка, а не источник ответа. Без неё
      // вопрос не задаётся вовсе: запись в `degraded` означала бы «панель не
      // ответила», а она и не спрашивалась.
      ctx.backends.remna
        ? settle(ctx.remna.get<unknown>(SQUADS))
        : Promise.resolve<{ ok: true; value: unknown }>({ ok: true, value: null }),
    ]);

    // ВСЕ take() — до подсчёта предупреждений, тем же порядком, что в infra_map:
    // иначе часть деградаций осталась бы немаркированной.
    const serverValue = take(serverList, 'shm', degraded, EMPTY_LIST);
    const groupValue = take(groupList, 'shm', degraded, EMPTY_LIST);
    const squadValue = take(squadList, 'remna', degraded, null);

    const servers = serverValue.data.map(asRecord).map(toServer);
    const groupRows = groupValue.data.map(asRecord);
    const panelSquads = new Set(
      asArray(asRecord(squadValue).internalSquads ?? squadValue)
        .map((one) => str(asRecord(one).uuid))
        .filter((one): one is string => one !== null),
    );

    const serversShort = serverValue.items > servers.length + serverValue.offset;
    const groupsShort = groupValue.items > groupRows.length + groupValue.offset;
    const serversUsable = serverList.ok && !serversShort;
    const groupsUsable = groupList.ok && !groupsShort;

    const atCapacity = (one: ServerRow): boolean =>
      one.maxServices !== null && one.servicesCount >= one.maxServices;

    const groups: GroupRow[] = groupRows.map((row) => {
      const groupId = num(row.group_id, 0);
      const members = servers.filter((one) => one.groupId === groupId);
      const enabled = members.filter((one) => one.enabled);
      return {
        groupId,
        name: str(row.name),
        transport: str(row.transport),
        selection: str(row.type),
        members: members.length,
        enabledMembers: enabled.length,
        usableMembers: enabled.filter((one) => !atCapacity(one)).length,
      };
    });

    const suppress = (gap: string, reason: string): null => {
      suppressed.push({ gap, reason });
      return null;
    };

    /**
     * Группа, из которой Core::ServerGroups::get_servers не сможет выбрать
     * ничего: он берёт ТОЛЬКО enabled=1 (Core/Server.pm:66-77) и пропускает
     * заполненные, а на пустом наборе логирует 'No servers found in the group'
     * и возвращает undef. Событие, маршрутизированное в такую группу, не
     * выполняется — молча, без строки об отказе у клиента.
     */
    const groupsWithoutUsableServer =
      serversUsable && groupsUsable
        ? groups
            .filter((one) => one.usableMembers === 0)
            .map((one) => ({
              groupId: one.groupId,
              name: one.name,
              transport: one.transport,
              members: one.members,
              enabledMembers: one.enabledMembers,
              reason:
                one.members === 0
                  ? 'no server belongs to this group'
                  : one.enabledMembers === 0
                    ? 'every server in the group is disabled'
                    : 'every enabled server in the group is at its max_services cap',
            }))
        : suppress(
            'groupsWithoutUsableServer',
            !serversUsable
              ? 'the server listing did not arrive in full, and against a partial list every ' +
                'group looks empty'
              : 'the group listing did not arrive in full',
          );

    const serversInMissingGroup = groupsUsable
      ? servers
          .filter((one) => !groups.some((group) => group.groupId === one.groupId))
          .map((one) => ({ serverId: one.serverId, name: one.name, groupId: one.groupId }))
      : suppress(
          'serversInMissingGroup',
          'the group listing did not arrive in full, and against a partial list of groups every ' +
            'server looks orphaned',
        );

    const serversAtCapacity = serverList.ok
      ? servers.filter(atCapacity).map((one) => ({
          serverId: one.serverId,
          name: one.name,
          servicesCount: one.servicesCount,
          maxServices: one.maxServices,
        }))
      : suppress('serversAtCapacity', 'the server listing did not answer');

    /**
     * Транспорт задаёт ГРУППА (Core/Task.pm:175-181 берёт transport из
     * server_gid), а сервер внутри группы выбирается без оглядки на его
     * собственный transport. Расхождение означает, что Transport::Ssh получит
     * строку http-сервера — с чужими settings и чужим host.
     */
    const groupTransportMismatch =
      serversUsable && groupsUsable
        ? groups.flatMap((group) =>
            servers
              .filter(
                (one) =>
                  one.groupId === group.groupId &&
                  one.transport !== null &&
                  group.transport !== null &&
                  one.transport !== group.transport,
              )
              .map((one) => ({
                groupId: group.groupId,
                groupTransport: group.transport,
                serverId: one.serverId,
                serverTransport: one.transport,
              })),
          )
        : suppress(
            'groupTransportMismatch',
            'one of the two listings did not arrive in full, so group and server transports ' +
              'cannot be compared',
          );

    /**
     * Единственная настоящая сверка SHM с панелью на этих данных: провижининг
     * кладёт новому пользователю сквады из settings, и сквад, снесённый в
     * панели, означает клиента без доступа при внешне успешной задаче.
     * Считается только по НЕПУСТОМУ списку панели — пустое множество объявило
     * бы отсутствующим каждый сквад, ровно как в infra_map.
     */
    const referencedSquads = [...new Set(servers.flatMap((one) => one.panelSquads))];
    const panelSquadsMissing =
      squadList.ok && panelSquads.size > 0
        ? referencedSquads
            .filter((uuid) => !panelSquads.has(uuid))
            .map((uuid) => ({
              uuid,
              servers: servers.filter((one) => one.panelSquads.includes(uuid)).map((one) => one.serverId),
            }))
        : suppress(
            'panelSquadsMissing',
            !ctx.backends.remna
              ? 'this deployment has no Remnawave panel configured, so there is no squad list to ' +
                'check SHM references against — the check was not run, and no squad is being ' +
                'called missing'
              : !squadList.ok
                ? 'the panel squad listing did not answer'
                : 'the panel returned no squads at all, and against an empty set every squad SHM ' +
                  'references would look deleted',
          );

    if (serversShort || groupsShort) {
      warnings.push(
        warn(
          'truncated',
          `SHM reported more rows than it returned: ` +
            `${serversShort ? `servers ${String(servers.length)} of ${String(serverValue.items)}; ` : ''}` +
            `${groupsShort ? `groups ${String(groups.length)} of ${String(groupValue.items)}; ` : ''}` +
            'every gap that depends on the short listing is suppressed rather than computed from ' +
            'the slice.',
        ),
      );
    }
    if (groupsWithoutUsableServer !== null && groupsWithoutUsableServer.length > 0) {
      warnings.push(
        warn(
          'group_cannot_yield_a_server',
          `${String(groupsWithoutUsableServer.length)} of ${String(groups.length)} server groups ` +
            'cannot yield a server: SHM picks only enabled, non-full members, and on an empty set ' +
            'it logs "No servers found in the group" and gives up. Any event routed to such a ' +
            'group does not run, and nothing in the client-facing history says so. An empty group ' +
            'is not automatically a fault — a transport nobody uses any more looks exactly the ' +
            'same; check whether events still route there before changing anything.',
        ),
      );
    }
    const stripped = servers.filter(
      (one) =>
        one.endpoint.droppedPathSegments > 0 ||
        one.endpoint.droppedQuery ||
        one.endpoint.droppedCredentials,
    );
    if (stripped.length > 0) {
      warnings.push(
        warn(
          'endpoint_path_stripped',
          `${String(stripped.length)} server addresses had their path, query or user:password ` +
            'part removed before returning. This is not cosmetic: on this deployment those paths ' +
            'contain a live Telegram bot token, and field-name redaction cannot see it because ' +
            'the secret sits inside the value of an ordinary `host` column. Scheme, host and port ' +
            'are what identifies the endpoint; the rest is in the SHM admin UI.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A listing did not answer (see `degraded`). Every gap that depended on it is null with ' +
            'a reason in `suppressed` rather than computed from what is left: on a half-read ' +
            'inventory the gap lists invert and report every group as empty and every server as ' +
            'orphaned.',
        ),
      );
    }

    return {
      counts: {
        servers: servers.length,
        groups: groups.length,
        enabledServers: servers.filter((one) => one.enabled).length,
        // Серверный счёт (§6.4): SHM отдаёт FOUND_ROWS() в `items`.
        reported: { servers: serverValue.items, groups: groupValue.items },
      },
      servers,
      groups,
      gaps: {
        groupsWithoutUsableServer,
        serversInMissingGroup,
        serversAtCapacity,
        groupTransportMismatch,
        panelSquadsMissing,
      },
      suppressed,
      warnings,
      degraded,
    };
  },
});
