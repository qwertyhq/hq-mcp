/**
 * ТОПОЛОГИЯ ПАНЕЛИ: ноды × инбаунды × хосты и разрывы между ними.
 *
 * Живёт в пакете клиента, а не рядом с одним из потребителей, потому что
 * потребителей ДВА и они в разных рабочих областях: читающий `infra_map`
 * (`tools/read/src/infra/map.ts`) показывает разрывы оператору, а мутатор
 * `host_cleanup` (`tools/mutations/src/panel/hostCleanup.ts`) обязан по тем же
 * правилам решить, что удаление хоста не гасит страну. Две копии этой
 * арифметики разъехались бы на первом же уточнении, и разъехались бы молча:
 * инструмент удаления продолжал бы ВЫГЛЯДЕТЬ согласованным с картой.
 *
 * Модуль чистый: ни одного запроса, ни одного клиента. На вход — строки
 * листингов панели как они приехали (`/api/nodes`, `/api/hosts`,
 * `/api/config-profiles`, `/api/config-profiles/inbounds`), на выход — карта
 * и функции разрывов. Решение «полон ли листинг и можно ли вообще считать
 * разрыв» остаётся у вызывающего: у читающего инструмента это `suppressed`
 * с причиной, у мутатора — отказ строить план. Здесь его быть не может —
 * модуль не знает, ответила ручка или нет.
 */

/** Строки листингов панели. Пустой массив — «ручка не дала строк», не «их нет». */
export interface TopologyRows {
  nodes: readonly unknown[];
  hosts: readonly unknown[];
  /** Плоский `/api/config-profiles/inbounds`. */
  inbounds: readonly unknown[];
  /** `/api/config-profiles` — у каждого профиля свой вложенный `inbounds[]`. */
  profiles: readonly unknown[];
}

export interface TopologyInbound {
  uuid: string;
  tag: string | null;
}

export interface TopologyNode {
  uuid: string;
  name: string | null;
  countryCode: string | null;
  isConnected: boolean;
  isDisabled: boolean;
  profileUuid: string | null;
  /**
   * Только состав. `activeInbounds` в ответе панели несут `rawInbound` — полный
   * xray-конфиг с Reality privateKey инлайном, и наружу он уезжать не должен.
   */
  activeInbounds: TopologyInbound[];
}

export interface TopologyHost {
  uuid: string;
  remark: string | null;
  inboundUuid: string | null;
  isDisabled: boolean;
  isHidden: boolean;
  nodes: string[];
}

export interface TopologyProfile {
  uuid: string;
  name: string | null;
  inbounds: Array<{ uuid: string; tag: string | null; type: string | null }>;
}

export interface Topology {
  nodes: TopologyNode[];
  hosts: TopologyHost[];
  profiles: TopologyProfile[];
  /** Все инбаунды, про которые панель хоть где-то сказала, что они существуют. */
  knownInbounds: ReadonlySet<string>;
  tagByInbound: ReadonlyMap<string, string>;
  /** Инбаунд → ноды, на которых он реально включён. */
  servedBy: ReadonlyMap<string, readonly string[]>;
  /** Инбаунд опубликован хоть каким-то хостом (включая выключенный). */
  publishedByAny: ReadonlySet<string>;
  /** Инбаунд опубликован ВКЛЮЧЁННЫМ хостом, то есть доезжает до клиента. */
  publishedByEnabled: ReadonlySet<string>;
}

export interface HostGap {
  uuid: string;
  remark: string | null;
  inboundUuid: string | null;
}

export interface InboundGap {
  uuid: string;
  tag: string | null;
  activeOnNodes: string[];
}

/** Инбаунд без живого хоста. Ноды здесь не при чём — см. комментарий у функции. */
export interface DarkInbound {
  uuid: string;
  tag: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function uuidsOf(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => str(row.uuid)).filter((one): one is string => one !== null);
}

function mapNode(row: Record<string, unknown>): TopologyNode {
  const profile = asRecord(row.configProfile);
  return {
    uuid: str(row.uuid) ?? '',
    name: str(row.name),
    countryCode: str(row.countryCode),
    isConnected: row.isConnected === true,
    isDisabled: row.isDisabled === true,
    profileUuid: str(profile.activeConfigProfileUuid ?? row.activeConfigProfileUuid),
    activeInbounds: asArray(profile.activeInbounds)
      .map(asRecord)
      .map((one) => ({ uuid: str(one.uuid) ?? '', tag: str(one.tag) })),
  };
}

function mapHost(row: Record<string, unknown>): TopologyHost {
  return {
    uuid: str(row.uuid) ?? '',
    remark: str(row.remark),
    inboundUuid: str(asRecord(row.inbound).configProfileInboundUuid ?? row.inboundUuid),
    isDisabled: row.isDisabled === true,
    isHidden: row.isHidden === true,
    nodes: asArray(row.nodes)
      .map((one) => str(one))
      .filter((one): one is string => one !== null),
  };
}

function mapProfile(row: Record<string, unknown>): TopologyProfile {
  return {
    uuid: str(row.uuid) ?? '',
    name: str(row.name),
    inbounds: asArray(row.inbounds)
      .map(asRecord)
      .map((one) => ({ uuid: str(one.uuid) ?? '', tag: str(one.tag), type: str(one.type) })),
  };
}

export function buildTopology(rows: TopologyRows): Topology {
  const nodeRows = rows.nodes.map(asRecord);
  const hostRows = rows.hosts.map(asRecord);
  const inboundRows = rows.inbounds.map(asRecord);
  const profileRows = rows.profiles.map(asRecord);

  const nodes = nodeRows.map(mapNode);
  const hosts = hostRows.map(mapHost);
  const profiles = profileRows.map(mapProfile);

  /**
   * Известные инбаунды берутся из ОБОИХ листингов. Плоский
   * `/api/config-profiles/inbounds` и вложенный `inbounds[]` каждого профиля
   * описывают одно и то же множество, поэтому одной уцелевшей ручки достаточно,
   * чтобы утверждение «такого инбаунда нет» осталось обоснованным.
   */
  const profileInbounds = profileRows.flatMap((row) => asArray(row.inbounds).map(asRecord));
  const activeInbounds = nodeRows.flatMap((row) =>
    asArray(asRecord(row.configProfile).activeInbounds).map(asRecord),
  );
  const knownInbounds = new Set<string>([...uuidsOf(inboundRows), ...uuidsOf(profileInbounds)]);

  const tagByInbound = new Map<string, string>();
  for (const row of [...inboundRows, ...profileInbounds, ...activeInbounds]) {
    const uuid = str(row.uuid);
    const tag = str(row.tag);
    if (uuid !== null && tag !== null && !tagByInbound.has(uuid)) tagByInbound.set(uuid, tag);
  }

  const servedBy = new Map<string, string[]>();
  for (const node of nodes) {
    for (const active of node.activeInbounds) {
      if (active.uuid === '') continue;
      servedBy.set(active.uuid, [...(servedBy.get(active.uuid) ?? []), node.uuid]);
    }
  }

  const publishedByAny = new Set<string>();
  const publishedByEnabled = new Set<string>();
  for (const host of hosts) {
    if (host.inboundUuid === null) continue;
    publishedByAny.add(host.inboundUuid);
    if (!host.isDisabled) publishedByEnabled.add(host.inboundUuid);
  }

  return {
    nodes,
    hosts,
    profiles,
    knownInbounds,
    tagByInbound,
    servedBy,
    publishedByAny,
    publishedByEnabled,
  };
}

function inboundGap(topology: Topology, uuid: string): InboundGap {
  return {
    uuid,
    tag: topology.tagByInbound.get(uuid) ?? null,
    activeOnNodes: [...(topology.servedBy.get(uuid) ?? [])],
  };
}

/**
 * Хосты-зомби: указывают на инбаунд, которого в панели больше нет. Так
 * выглядят хосты, осиротевшие после удаления профиля или инбаунда.
 *
 * СЧИТАТЬ ЭТО МОЖНО ТОЛЬКО ПРИ НЕПУСТОМ `knownInbounds`. Против пустого
 * множества известных инбаундов зомби — КАЖДЫЙ хост (66 и 21 ложная находка на
 * снятых панелях), поэтому вызывающий обязан сначала убедиться, что листинг
 * инбаундов или профилей приехал целиком. Здесь этой проверки нет намеренно:
 * модуль не видит, ответила ручка или нет, а проверка, притворяющаяся
 * работающей, хуже её отсутствия.
 */
export function hostsWithUnknownInbound(topology: Topology): HostGap[] {
  return topology.hosts
    .filter((host) => host.inboundUuid === null || !topology.knownInbounds.has(host.inboundUuid))
    .map((host) => ({ uuid: host.uuid, remark: host.remark, inboundUuid: host.inboundUuid }));
}

/**
 * Инбаунды, которые нода обслуживает, а хостом их не публикует НИКТО.
 *
 * ЭТО НЕ ОБЯЗАТЕЛЬНО ПОЛОМКА, И ЭТО ГЛАВНОЕ, ЧТО ПРО НЕЁ НАДО ЗНАТЬ. Мост и
 * релейный хоп принимают трафик с ДРУГОЙ ноды, а не от клиента, и скрипт
 * настройки моста (`remna-configs/fix-bridge.sh`) хоста для них не создаёт
 * намеренно. На здоровых панелях так выглядит заметная часть инбаундов, включая
 * BRIDGE_DE_IN и BRIDGE_RU_IN. Опубликовать такой инбаунд клиентам — это выдать
 * им внутренний хоп, то есть регрессия безопасности под видом починки.
 *
 * Оговорка «нода его обслуживает» обязательна: без неё дырой объявляется любой
 * инбаунд из каталога, который просто никому не назначен.
 */
export function inboundsActiveWithoutHost(topology: Topology): InboundGap[] {
  return [...topology.servedBy.keys()]
    .filter((uuid) => !topology.publishedByAny.has(uuid))
    .map((uuid) => inboundGap(topology, uuid));
}

/**
 * Инбаунды, у которых все хосты выключены. Наивная проверка считает их
 * опубликованными — множество «использованных» инбаундов строится по ВСЕМ
 * хостам. Таких инбаундов у панели единицы: то самое «страна
 * погасла, и никто не заметил», потому что голое число выключенных хостов
 * никогда не говорит, какие точки входа ушли вместе с ними.
 */
export function inboundsPublishedOnlyByDisabledHosts(topology: Topology): DarkInbound[] {
  const orphaned = new Set<string>();
  for (const host of topology.hosts) {
    const uuid = host.inboundUuid;
    if (!host.isDisabled || uuid === null) continue;
    if (topology.publishedByEnabled.has(uuid)) continue;
    orphaned.add(uuid);
  }
  // Без `activeOnNodes` намеренно: этот разрыв утверждает «живого хоста нет», и
  // он верен независимо от того, обслуживает ли инбаунд хоть одна нода, — то
  // есть единственный из трёх, который считается по листингу хостов в
  // одиночку. Приписать сюда ноды значило бы намекнуть, что листинг нод тоже
  // участвовал, и разрыв стало бы нельзя показывать без него.
  return [...orphaned].map((uuid) => ({ uuid, tag: topology.tagByInbound.get(uuid) ?? null }));
}

/** Что станет с инбаундами, если удалить перечисленные хосты. */
export interface OrphanForecast {
  /**
   * Инбаунд останется без единого ВКЛЮЧЁННОГО хоста, хотя нода его
   * обслуживает: клиенты теряют точку входа немедленно. Это «страна гаснет».
   */
  losingLastLiveHost: InboundGap[];
  /**
   * Инбаунд останется вообще без хостов и с этого момента будет неотличим от
   * моста в `inboundsActiveWithoutHost`. Клиентам он уже не светил (иначе
   * попал бы в предыдущий список), но карта перестанет отличать его от
   * релейного хопа — и следующий оператор либо починит несуществующее, либо
   * опубликует мост.
   */
  losingLastHost: InboundGap[];
}

/**
 * Прогноз ПО ТЕМ ЖЕ ПРАВИЛАМ, что и разрывы карты: «после удаления этих хостов
 * какие обслуживаемые инбаунды останутся без публикации». Отдельная функция, а
 * не пересборка топологии из отфильтрованного списка хостов, потому что
 * вызывающему нужны обе картины сразу — до и после — и он обязан показать их
 * оператору рядом.
 *
 * Ограничено инбаундами, которые кто-то обслуживает (`servedBy`), по той же
 * причине, что и `inboundsActiveWithoutHost`: инбаунд, не назначенный ни одной
 * ноде, сиротой не становится — он им уже был.
 */
export function forecastOrphans(
  topology: Topology,
  doomedHostUuids: Iterable<string>,
): OrphanForecast {
  const doomed = new Set(doomedHostUuids);
  const survivors = topology.hosts.filter((host) => !doomed.has(host.uuid));
  const leftAny = new Set<string>();
  const leftEnabled = new Set<string>();
  for (const host of survivors) {
    if (host.inboundUuid === null) continue;
    leftAny.add(host.inboundUuid);
    if (!host.isDisabled) leftEnabled.add(host.inboundUuid);
  }

  const touched = new Set<string>();
  for (const host of topology.hosts) {
    if (doomed.has(host.uuid) && host.inboundUuid !== null) touched.add(host.inboundUuid);
  }

  const losingLastLiveHost: InboundGap[] = [];
  const losingLastHost: InboundGap[] = [];
  for (const uuid of touched) {
    if (!topology.servedBy.has(uuid)) continue;
    if (topology.publishedByEnabled.has(uuid) && !leftEnabled.has(uuid)) {
      losingLastLiveHost.push(inboundGap(topology, uuid));
    }
    if (topology.publishedByAny.has(uuid) && !leftAny.has(uuid)) {
      losingLastHost.push(inboundGap(topology, uuid));
    }
  }
  return { losingLastLiveHost, losingLastHost };
}
