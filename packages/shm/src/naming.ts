import type { ToolContext } from '@hq/types';

/**
 * ИМЕНОВАНИЕ ЗАДАЁТ ИНСТАЛЛЯЦИЯ, А НЕ ЭТОТ РЕПОЗИТОРИЙ.
 *
 * SHM провижинит одного пользователя панели на КАЖДЫЙ user_service_id и рядом
 * кладёт снапшот его конфигурации в собственный storage. Оба имени строятся из
 * префикса и `us.id`, и оба префикса шаблон провижининга ВЫЧИСЛЯЕТ, а не
 * зашивает:
 *
 *     {{ STORAGE_PREFIX = config.remnawave.storage_prefix || "vpn_mrzb_" }}
 *     {{ NAME_PREFIX    = config.remnawave.name_prefix    || "HQVPN_"    }}
 *
 * (снято с РАБОТАЮЩЕГО тела шаблона `remna-3` — строки 432 и 469 — и с
 * `remnawave-2`:114/:151; ключ снапшота — `{{ STORAGE_PREFIX }}{{ us.id }}`,
 * имя пользователя — `{{ NAME_PREFIX }}{{ us.id }}`).
 *
 * Значит источник истины — строка `remnawave` таблицы config РАБОТАЮЩЕЙ
 * инсталляции, и спрашивается она ровно так же, как её читает сама SHM.
 * Константы ниже — не «наши значения», а те же умолчания, что стоят в шаблоне:
 * там, где ключа `remnawave` в конфиге нет вовсе (проверено на работающей SHM:
 * `items: 0`, `data: [{}]`), работают именно они.
 *
 * ПОЧЕМУ ЭТО ЖИВЁТ В @hq/shm, А НЕ В КИТЕ ЧИТАЮЩИХ ИНСТРУМЕНТОВ, ГДЕ РОДИЛОСЬ.
 * Пока префиксы были нужны только чтениям (`provisioning_diagnose` их
 * СОБИРАЕТ, `sync_audit` РАЗБИРАЕТ), их дом был там. Как только по тому же
 * имени начал ПИСАТЬ мутатор (`storage_edit` держит на нём разрешительный
 * список ключей), пакетов-потребителей стало два, и «одно место» перестало
 * быть местом внутри одного из них: `@hq/tools-mutations` не зависит и не
 * должен зависеть от `@hq/tools-read`. Дом выбран по источнику истины —
 * значение читается из таблицы config САМОЙ SHM, тем же клиентом, что рядом.
 * Читающий кит эти же имена ре-экспортирует, поэтому у реализации по-прежнему
 * ровно один экземпляр, а вместе с ним — один процессный кэш.
 */
export const DEFAULT_STORAGE_PREFIX = 'vpn_mrzb_';
export const DEFAULT_PANEL_USERNAME_PREFIX = 'HQVPN_';

/**
 * Не умолчания, а ИСТОРИЯ конкретной инсталляции. Их собирают шаблоны прошлых
 * поколений, до сих пор лежащие рядом с действующим: `remnawave`:19,41 строит
 * `by-username/us_{{ us.id }}` и `username = "remnawave_" _ us.id`,
 * `remnawave_old`:45 — то же. На работающей панели под этими префиксами
 * остаются десятки учёток против основной массы под каноничным, и один зашитый
 * префикс объявил бы каждую такую услугу «в панели пользователя нет».
 *
 * Прицепляются ТОЛЬКО к дефолтному каноничному имени — см. resolvePanelNaming.
 */
export const LEGACY_PANEL_USERNAME_PREFIXES: readonly string[] = ['remnawave_', 'us_'];

/**
 * Полный список по умолчанию: каноничный первым, наследные за ним. Порядок —
 * часть контракта: sync_audit выбирает по нему, какой из двух аккаунтов на одну
 * услугу считать каноничным (prefixRank), а provisioning_diagnose в этом же
 * порядке перебирает имена в панели.
 */
export const DEFAULT_PANEL_USERNAME_PREFIXES: readonly string[] = [
  DEFAULT_PANEL_USERNAME_PREFIX,
  ...LEGACY_PANEL_USERNAME_PREFIXES,
];

/** Переопределение префикса ключа снапшота, когда живое чтение недоступно. */
export const STORAGE_PREFIX_VAR = 'HQ_MCP_STORAGE_PREFIX';
/** Переопределение ВСЕГО списка префиксов имён панели, через запятую. */
export const PANEL_PREFIXES_VAR = 'HQ_MCP_PANEL_PREFIXES';

/** Ключ таблицы config, из которого шаблон провижининга берёт оба префикса. */
const REMNAWAVE_CONFIG_KEY = 'remnawave';

/** Откуда взялось значение. Отдаётся наружу: «дефолт» — это «не проверено». */
export type PrefixSource = 'env' | 'shm_config' | 'default';

export interface PanelNaming {
  /** Ключ снапшота = `${storagePrefix}${user_service_id}`. */
  storagePrefix: string;
  storagePrefixFrom: PrefixSource;
  /** Имена пользователей панели, от каноничного к наследным. */
  usernamePrefixes: readonly string[];
  usernamePrefixesFrom: PrefixSource;
  /**
   * Ошибка чтения `config.remnawave`; null — прочитали (в том числе «такого
   * ключа нет», что законно и означает умолчания шаблона). Не попадает в
   * `degraded` намеренно: провал этого чтения не делает ответ частичным, он
   * возвращает поведение ровно к прежнему — зашитым умолчаниям, — и объявлять
   * это отказом источника значило бы кричать `partial_result` на каждом ответе
   * инсталляции, у которой ключа и не должно быть.
   */
  configError: string | null;
}

interface RemnawaveConfig {
  storagePrefix: string | null;
  namePrefix: string | null;
  error: string | null;
}

/**
 * TTL тот же, что у platform_probe, и по той же причине: это факт о ДЕПЛОЕ, а
 * не о запросе. Без кэша один и тот же ответ стоил бы лишнего чтения на каждую
 * услугу в цикле provisioning_diagnose.
 */
const NAMING_TTL_MS = 5 * 60 * 1000;

let namingCache: { at: number; value: RemnawaveConfig } | null = null;

/** Только для тестов: модульный кэш живёт дольше одного вызова инструмента. */
export function resetPanelNamingCache(): void {
  namingCache = null;
}

/**
 * Локальные крохи вместо импорта из кита читающих инструментов: тянуть сюда
 * `@hq/tools-read` ради двух приведений типа значило бы развернуть зависимость
 * задом наперёд (кит зависит от этого пакета, не наоборот). Ни одна из трёх не
 * несёт решений — только приведение `unknown` к тому, чем оно оказалось.
 */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Первая строка ответа `GET /admin/config/{key}`: `api_data_by_name` отдаёт
 * САМО значение ключа, а v1.cgi заворачивает его в `{data:[<value>]}` — клиент
 * снимает конверт и возвращает массив из одной строки. Ключа нет — приезжает
 * `[{}]`, ровно как на работающей SHM.
 */
function firstConfigRow(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : {};
}

async function readRemnawaveConfig(ctx: ToolContext): Promise<RemnawaveConfig> {
  const nowMs = ctx.now().getTime();
  if (namingCache !== null && nowMs - namingCache.at < NAMING_TTL_MS) return namingCache.value;
  // Ключ `remnawave` — не путь внутри значения, а КЛЮЧ таблицы config
  // (shm_structure.sql:329-333); `api_data_by_name` отдаёт само значение, а
  // v1.cgi заворачивает его в `{data:[<value>]}`, поэтому нужна первая строка.
  let row: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    row = firstConfigRow(await ctx.shm.get<unknown>(`/admin/config/${REMNAWAVE_CONFIG_KEY}`));
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const value: RemnawaveConfig = {
    storagePrefix: text(row.storage_prefix),
    namePrefix: text(row.name_prefix),
    error,
  };
  namingCache = { at: nowMs, value };
  return value;
}

/** `'A_, B_'` → `['A_', 'B_']`; пустые записи и повторы выбрасываются. */
export function parsePrefixList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((one) => one.trim())
        .filter((one) => one !== ''),
    ),
  ];
}

/**
 * КАК ЭТА ИНСТАЛЛЯЦИЯ ИМЕНУЕТ СВОИ ОБЪЕКТЫ. Три источника, в порядке
 * старшинства: переменная окружения, живое `config.remnawave`, умолчание
 * шаблона. Спрашивать человека при этом обычно НЕ ПРИХОДИТСЯ — значение
 * читается у самой SHM тем же способом, каким его читает её собственный
 * провижининг, и переменная нужна только там, где живого ответа недостаточно.
 *
 * Переменная стоит выше живого чтения намеренно: `config.remnawave` описывает,
 * что шаблон СОБЕРЁТ завтра, а оператор, выставивший переменную, описывает, что
 * в панели лежит СЕГОДНЯ — например, после смены префикса, когда старые учётки
 * никто не переименовывал. Явно заданное человеком не должно молча проигрывать
 * автоматике: иначе переменная выглядит настройкой, которая ничего не делает.
 *
 * Наследные префиксы (`remnawave_`, `us_`) прицепляются ТОЛЬКО когда каноничный
 * пришёл из умолчания. Инсталляция, объявившая свой `name_prefix`, объявила тем
 * самым, что её имена строятся не как наши, и наша история к ней отношения не
 * имеет: `us_2024` в чужой панели — это скорее всего заведённый руками аккаунт,
 * а разобранный по нашему списку он превращается в «услугу 2024» и уезжает в
 * корзину с рекомендацией «удалить этот аккаунт». Свой список наследных имён
 * такая инсталляция задаёт HQ_MCP_PANEL_PREFIXES целиком.
 *
 * Живёт в одном месте, а не по копии на потребителя: provisioning_diagnose из
 * этих префиксов имена СОБИРАЕТ, sync_audit их РАЗБИРАЕТ, storage_edit по ним
 * решает, ПО КАКОМУ КЛЮЧУ ВООБЩЕ ГОТОВ ПИСАТЬ, и разъехавшиеся копии означают
 * ложное «пользователя панели нет» на существующей услуге — или отказ записи по
 * совершенно правильному ключу.
 */
export async function resolvePanelNaming(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PanelNaming> {
  const config = await readRemnawaveConfig(ctx);

  const fromEnvStorage = text(env[STORAGE_PREFIX_VAR]);
  const fromEnvNames = parsePrefixList(env[PANEL_PREFIXES_VAR]);

  const storagePrefixFrom: PrefixSource =
    fromEnvStorage !== null ? 'env' : config.storagePrefix !== null ? 'shm_config' : 'default';
  const usernamePrefixesFrom: PrefixSource =
    fromEnvNames.length > 0 ? 'env' : config.namePrefix !== null ? 'shm_config' : 'default';

  return {
    storagePrefix: fromEnvStorage ?? config.storagePrefix ?? DEFAULT_STORAGE_PREFIX,
    storagePrefixFrom,
    usernamePrefixes:
      usernamePrefixesFrom === 'env'
        ? fromEnvNames
        : usernamePrefixesFrom === 'shm_config'
          ? [config.namePrefix ?? DEFAULT_PANEL_USERNAME_PREFIX]
          : DEFAULT_PANEL_USERNAME_PREFIXES,
    usernamePrefixesFrom,
    configError: config.error,
  };
}

/** Собрано ли имя по одному из известных префиксов. */
export function matchesKnownPrefix(username: string | null, prefixes: readonly string[]): boolean {
  return username !== null && prefixes.some((prefix) => username.startsWith(prefix));
}

/**
 * Как назвать источник префиксов в предупреждении. Существует ради одной
 * разницы, которая и есть смысл всей этой машинерии: «дефолт» означает не
 * «настроено так», а «ни одна работающая система этого не подтверждала».
 */
export function prefixSourcePhrase(source: PrefixSource, variable: string): string {
  if (source === 'env') return `configured in ${variable}`;
  if (source === 'shm_config') return "read live from SHM's own config.remnawave";
  return 'the built-in defaults of the provisioning template, never confirmed against this install';
}
