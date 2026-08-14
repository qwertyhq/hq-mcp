import type { ZodType } from 'zod';

export type Access = 'ro' | 'rw';
export type Risk = 'none' | 'low' | 'medium' | 'high';
export type Profile = 'human' | 'bot';

/**
 * Одна из двух живых систем, поверх которых работает сервер. Обе НЕОБЯЗАТЕЛЬНЫ
 * по отдельности и обязательна хотя бы одна: панель Remnawave стоит у всех, кто
 * вообще держит Remnawave, а SHM — нишевый Perl-биллинг, и требовать вторую
 * систему ради первой означало не пускать на порог большинство операторов.
 */
export type Backend = 'shm' | 'remna';

export const BACKENDS: readonly Backend[] = ['shm', 'remna'] as const;

export function isBackend(value: unknown): value is Backend {
  return value === 'shm' || value === 'remna';
}

/** Какие бэкенды настроены В ЭТОМ развёртывании. Считается один раз, при старте. */
export type BackendPresence = Readonly<Record<Backend, boolean>>;

/**
 * Обращение к бэкенду, которого в этом развёртывании НЕТ.
 *
 * Существует ради одного: чтобы такое обращение было ГРОМКИМ. Инструменты,
 * чей единственный бэкенд не настроен, до реестра не доезжают вовсе, и в
 * норме этот класс не встречается никогда. Он для второй линии — для
 * инструмента, который дотянулся до второй системы мимо объявленного
 * `backends` (забыл дописать её в объявление, добрался через общий помощник).
 * Без него отсутствующий клиент пришлось бы делать «пустым», и тогда такой
 * инструмент отвечал бы «ничего не найдено» — уверенно неверным ответом
 * вместо отказа.
 */
export class BackendNotConfiguredError extends Error {
  readonly backend: Backend;
  /** Переменные окружения, которых не хватает. Печатаются дословно. */
  readonly variables: readonly string[];

  constructor(backend: Backend, variables: readonly string[]) {
    super(
      `${backend === 'shm' ? 'SHM' : 'Remnawave'} is not configured in this deployment ` +
        `(${variables.join(', ')} are unset), so this call cannot be made at all. This is not an ` +
        'outage and retrying will not help: the server was started against the other system ' +
        'only. Run platform_probe to see which backends this deployment has.',
    );
    this.name = 'BackendNotConfiguredError';
    this.backend = backend;
    this.variables = variables;
  }
}

/**
 * Живая возможность бэкенда, которую невозможно узнать из спеки: спеки врут (§3),
 * поэтому platform_probe проверяет их на месте, а реестр гейтит инструменты,
 * чьи requires заведомо не выполняются (§9, §11).
 */
export type Capability =
  | 'shm.filter'
  | 'shm.dry_run'
  /**
   * Ведёт ли панель журнал обращений за подпиской. Настройка панели
   * (`SERVICE_DISABLE_SRH_RECORDS`), а не свойство маршрута: при выключенной
   * записи ручка истории существует и отвечает 200 с пустым списком, то есть
   * «клиент ни разу не подключался» и «панель этого не пишет» выглядят
   * ОДИНАКОВО. Единственный источник ответа — GET конфигурации панели
   * (появился в 3.2.0), поэтому это возможность, а не поле ответа.
   */
  | 'remna.subscriptionRequestHistory'
  | 'remna.realtimeBandwidth'
  | 'tunnel.mysql'
  | 'tunnel.postgres'
  | 'tunnel.abuse';

export const PROFILES: readonly Profile[] = ['human', 'bot'] as const;
export const ACCESS_LEVELS: readonly Access[] = ['ro', 'rw'] as const;
export const CAPABILITIES: readonly Capability[] = [
  'shm.filter',
  'shm.dry_run',
  'remna.subscriptionRequestHistory',
  'remna.realtimeBandwidth',
  'tunnel.mysql',
  'tunnel.postgres',
  'tunnel.abuse',
] as const;

export function isProfile(value: unknown): value is Profile {
  return value === 'human' || value === 'bot';
}

export function isAccess(value: unknown): value is Access {
  return value === 'ro' || value === 'rw';
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/** Ответ списочной ручки SHM. `items` — полный total из FOUND_ROWS(), его нельзя терять (§6.4). */
export interface ShmListResult<T> {
  items: number;
  limit: number;
  offset: number;
  data: T[];
}

export type ClientParams = Record<string, string | number | undefined>;

export interface ShmClient {
  get<T>(path: string, params?: ClientParams): Promise<T>;
  list<T>(path: string, params?: ClientParams): Promise<ShmListResult<T>>;
  action<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    params?: ClientParams,
  ): Promise<T>;
  /**
   * НЕредактированное чтение. Только для read-merge-write и снапшота отката:
   * писать в работающую систему маскированное значение — авария. Результат
   * getRaw никогда не уходит в ответ инструмента.
   */
  getRaw<T>(path: string, params?: ClientParams): Promise<T>;
  /** НЕредактированная запись — тем же правилом, что и getRaw. */
  sendRaw<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    params?: ClientParams,
  ): Promise<T>;
}

export interface RemnaClient {
  get<T>(path: string, params?: ClientParams): Promise<T>;
  send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  getRaw<T>(path: string, params?: ClientParams): Promise<T>;
  sendRaw<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

/**
 * Процессные метрики панели из её ручки здоровья. Одна запись на инстанс:
 * панель работает в нескольких процессах, и «сколько их» — это тоже ответ.
 */
export interface RemnaRuntimeHealth {
  instances: number;
  /** Аптайм САМОГО МОЛОДОГО инстанса: перезапуск одного — уже перезапуск. */
  youngestUptimeSeconds: number | null;
  /** Худшая задержка event loop среди инстансов, мс. */
  worstEventLoopDelayMs: number | null;
}

/** Результат platform_probe: что реально работает в развёртывании, а не что обещает спека. */
export interface ProbeResult {
  checkedAt: string;
  cached: boolean;
  shm: {
    /**
     * НАСТРОЕНА ЛИ ЭТА СИСТЕМА В ЭТОМ РАЗВЁРТЫВАНИИ ВООБЩЕ.
     *
     * Первое поле в обеих сводках, потому что оно решает, как читать все
     * остальные: при `configured: false` `reachable: false` не означает «лежит»,
     * а `version: null` — «не прочиталась». Ни один запрос не отправлялся, и
     * инструментов, которым нужна эта система, в реестре нет.
     */
    configured: boolean;
    reachable: boolean;
    error: string | null;
    spoolStatuses: string[];
    version: string | null;
    /**
     * Отвечает ли SHM на НЕавторизованный healthcheck. Отдельно от `reachable`
     * (который доказывается админским вызовом) ровно затем, чтобы «SHM лежит»
     * и «наши креды не те» перестали быть одним ответом: живой healthcheck при
     * `reachable: false` — это второе, а не первое. `null` — не проверяли.
     */
    live: boolean | null;
    /** Бэкенд ОТВЕТИЛ и отверг наши креды (401/403) — это не отказ системы. */
    credentialsRejected: boolean;
  };
  remna: {
    /** См. `shm.configured` — то же поле и та же оговорка. */
    configured: boolean;
    reachable: boolean;
    error: string | null;
    version: string | null;
    /** То же различение, что у SHM. У панели неавторизованной ручки нет вовсе. */
    credentialsRejected: boolean;
    runtime: RemnaRuntimeHealth | null;
  };
  /** 'unknown' — проверить не удалось; инструмент показывается, но с предупреждением. */
  capabilities: Record<Capability, boolean | 'unknown'>;
  warnings: ToolWarning[];
}

/** Разделяемое место, куда probe кладёт результат, а реестр и исполнитель его читают. */
export interface ProbeStore {
  get(): ProbeResult | null;
  set(value: ProbeResult): void;
}

export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface ToolContext {
  /**
   * Клиент SHM. НЕ nullable намеренно: тридцать с лишним инструментов писали бы
   * `ctx.shm?.get(...)` и молча получали `undefined` там, где ждали строки —
   * то есть «ничего не найдено» вместо отказа. Когда SHM не настроена, здесь
   * лежит клиент, который на любой вызов бросает BackendNotConfiguredError, а
   * инструменты, которым SHM нужна, до реестра не доезжают вовсе.
   */
  shm: ShmClient;
  /** То же самое для панели. */
  remna: RemnaClient;
  /**
   * Какие бэкенды настроены. Спрашивается инструментами, которые умеют
   * ответить и половиной (`client_overview` без панели — это всё ещё ответ про
   * биллинг), чтобы сказать про недостающую половину «её здесь нет» вместо
   * «она не ответила».
   */
  backends: BackendPresence;
  profile: Profile;
  mode: Access;
  /** Инъекция времени, чтобы тесты были детерминированными. */
  now: () => Date;
  /**
   * Зона, в которой читаются «голые» даты SHM. Core::Utils::now — это
   * strftime("%Y-%m-%d %H:%M:%S", localtime) (app/lib/Core/Utils.pm:133-141),
   * то есть локальное время СЕРВЕРА без офсета и без `Z`. Прочитать такой
   * штамп как UTC — ошибка ровно в размер офсета, и она молчаливая: возраст
   * задачи уходит в минус и ни одна свежая задача не проходит порог.
   */
  shmTz: string;
  /** Последний результат platform_probe; отсутствует — значит probe ещё не гоняли. */
  probe: ProbeStore;
}

export interface ToolDef<I = unknown, O = unknown> {
  /** '<домен>_<действие>', напр. 'client_overview'. Точка в имени запрещена. */
  name: string;
  description: string;
  input: ZodType<I>;
  access: Access;
  risk: Risk;
  profiles: Profile[];
  /** Возможности бэкенда, без которых инструмент бессмысленен (§K11). */
  requires?: Capability[];
  /**
   * СИСТЕМЫ, БЕЗ КОТОРЫХ У ЭТОГО ИНСТРУМЕНТА НЕТ ОТВЕТА. Не «к каким он ходит»:
   * панельная половина `client_overview` необязательна и её отсутствие
   * называется словами, поэтому там объявлена одна `shm`. А `sync_audit`
   * СВЕРЯЕТ две системы — с одной сверять нечего, и там объявлены обе.
   *
   * Отсутствие поля означает «не нужна ни одна» и верно ровно для трёх
   * инструментов: `platform_probe` (он и рассказывает, какие системы есть),
   * `sql_query` (ходит в базы через ssh-туннель, а не в API) и служебных
   * `ops_audit`/`ops_confirm`.
   *
   * Инструмент, чей объявленный бэкенд не настроен, В РЕЕСТР НЕ ПОПАДАЕТ —
   * см. buildRuntime. Это не то же самое, что закрытый туннель: туннель
   * открывается командой, которую инструмент и печатает, а ненастроенный
   * бэкенд — решение развёртывания на весь срок жизни процесса.
   */
  backends?: readonly Backend[];
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

/** Явное предупреждение в ответе инструмента: ограничение данных, а не ошибка. */
export interface ToolWarning {
  code: string;
  message: string;
}

/** Мягкая деградация: одна из систем не ответила, результат отдан частично. */
export interface Degraded {
  system: 'shm' | 'remna' | 'tunnel';
  error: string;
}

/** Адреса ssh-туннеля для инструментов, у которых публичного пути нет (§4.3). */
export interface TunnelConfig {
  abuseUrl: string;
  postgres: { host: string; port: number };
  mysql: { host: string; port: number } | null;
  sshCommand: string;
  /**
   * Общий секрет abuse-хука: `GET /report` отвечает 403 без заголовка
   * `X-Guard-Token` (services/shm-abuse-guard/guard-hook.py:260-262, секрет
   * лежит в файле `.guard-hook-secret` на хосте SHM). Туннель тут ни при чём:
   * без токена хук отказывает при полностью открытом туннеле, и инструмент,
   * который этого не различает, отправляет оператора чинить исправное.
   * Необязателен ровно потому, что отсутствие — легальное состояние конфига,
   * а не значение: abuse_report обязан отказать по имени переменной, а не
   * послать пустой заголовок и разбираться с 403.
   */
  abuseToken?: string;
}
