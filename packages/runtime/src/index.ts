import { createAuditLog } from '@hq/audit';
import { BATCH_LIST_LIMITS, Budget, SHM_PER_KEY_LIMITS } from '@hq/budget';
import { createConfirmStore } from '@hq/confirm';
import { backendPresence } from '@hq/env';
import { backendsOfEndpoints, createProbeStore, createRegistry } from '@hq/registry';
import { createRemnaClient, createUnconfiguredRemnaClient } from '@hq/remna';
import { createShmClient, createUnconfiguredShmClient } from '@hq/shm';
import { createMutationTools, opsAudit, opsConfirm } from '@hq/tools-mutations';
import { createReadTools } from '@hq/tools-read';
import type { AuditLog } from '@hq/audit';
import type { ConfirmStore } from '@hq/confirm';
import type { HqMcpConfig } from '@hq/env';
import type { Registry } from '@hq/registry';
import type { MutationDeps } from '@hq/tools-mutations';
import type { ProbeStore, TcpProbe, ToolContext } from '@hq/types';

// Вторая вещь, которую обязаны делить оба транспорта, — публикация реестра как
// MCP-сервера. См. доккомментарий createServer о том, почему она здесь, а не в
// apps/stdio, где лежала до появления маршрута /mcp.
export { createServer } from './mcpServer.js';
export type { McpServerOptions } from './mcpServer.js';

/**
 * Заглушка журнала мутаций. Существует, чтобы `Runtime.audit` НЕ был nullable
 * с самого начала: иначе каждый потребитель пишет `runtime.audit?.write(...)`
 * и молча не журналирует, когда журнала нет.
 *
 * ЗАГЛУШКОЙ ЭТО БОЛЬШЕ НЕ РАБОТАЕТ, И ЭТО НАМЕРЕННО. `buildRuntime` собирает
 * настоящие `createAuditLog(cfg.auditPath)` и `createConfirmStore(cfg.snapshotDir)`;
 * обе функции ниже остались экспортом пакета ровно для двух случаев — тестов,
 * которым не нужен диск, и честного дефолта, если пакет когда-нибудь соберут
 * вообще без мутаций. Форма у них совпадает с настоящими интерфейсами
 * (`write`/`search`, `put`/`take(token, profile)`), поэтому подстановка через
 * `deps` продолжает работать.
 */
export interface NullAuditLog {
  readonly kind: 'null';
  write(rec: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * Форма ответа — `{ records, corrupt }`, как у настоящего `AuditLog.search`,
   * а не голый массив. Заглушка, отвечающая массивом, компилируется у себя и
   * ломает первого же потребителя, который спросит `corrupt`: «сколько строк
   * журнала прочитать не удалось» — это часть ответа, а не украшение.
   */
  search(opts: {
    tool?: string;
    since?: string;
    limit?: number;
  }): Promise<{ records: Record<string, unknown>[]; corrupt: number }>;
}

export interface NullConfirmStore {
  readonly kind: 'null';
  put(plan: unknown): Promise<{ token: string; expiresAt: string }>;
  take(token: string, profile: string): Promise<unknown>;
}

const NO_MUTATIONS =
  'This is a read-only build: no mutator is registered, so there is no plan to confirm and ' +
  'nothing to journal. Start the server with HQ_MCP_MODE=rw once the mutation tools exist.';

export function createNullAuditLog(): NullAuditLog {
  return {
    kind: 'null',
    // Принимает запись, ничего не пишет и возвращает её же: в ro-сборке мутаций
    // нет вовсе, поэтому журналировать нечего, а бросать на пустом месте — вредно.
    write: async (rec: Record<string, unknown>): Promise<Record<string, unknown>> => rec,
    search: async (): Promise<{ records: Record<string, unknown>[]; corrupt: number }> => ({
      records: [],
      corrupt: 0,
    }),
  };
}

export function createNullConfirmStore(): NullConfirmStore {
  return {
    kind: 'null',
    put: (): Promise<{ token: string; expiresAt: string }> => Promise.reject(new Error(NO_MUTATIONS)),
    take: (): Promise<unknown> => Promise.reject(new Error(NO_MUTATIONS)),
  };
}

export interface RuntimeDeps<A = AuditLog, C = ConfirmStore> {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  probeTcp?: TcpProbe;
  /**
   * Подмена журнала и хранилища планов — ТОЛЬКО для тестов. Транспорты этим не
   * пользуются: списка инструментов снаружи не передаёт никто (параметра
   * extraTools нет), иначе stdio и http собрали бы разные реестры.
   */
  audit?: A;
  confirm?: C;
}

export interface Runtime<A = AuditLog, C = ConfirmStore> {
  registry: Registry;
  ctx: ToolContext;
  budget: Budget;
  probe: ProbeStore;
  audit: A;
  confirm: C;
}

/**
 * Единственная точка сборки. apps/stdio и apps/http зовут ТОЛЬКО её с одними и
 * теми же аргументами: вторая копия сборки немедленно расходится с первой (в
 * одной профиль в клиент передали, в другой забыли — и §7.2 в этом контуре
 * просто нет), а список инструментов, приходящий снаружи, даёт двум транспортам
 * два разных реестра.
 *
 * ЧЕГО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ: она не трогает модульное состояние процесса —
 * кэш platform_probe и потолок вызовов abuse_report (resetProbeCache /
 * resetAbuseBudget в @hq/tools-read). Оба описывают не рантайм, а то, что
 * снаружи: кэш — факты о ДЕПЛОЕ на 5 минут, потолок — сколько раз в окне
 * позволено гонять полные сканы по MySQL биллинга. Бэкенду безразлично, какой по
 * счёту рантайм его позвал, поэтому счётчик, унаследованный вторым рантаймом,
 * — это правильный ответ, а не грязь. Обнуление же на сборке дало бы гейту
 * защиты ключ, который лежит под ковриком: любой повторный buildRuntime
 * (перечитали конфиг, пересобрались после ошибки) молча выдавал бы новые пять
 * сканов, и ни один тест этого не увидел бы. Изоляцию берёт на себя тот, кому
 * она нужна, — тесты зовут reset* явно.
 */
export function buildRuntime<A = AuditLog, C = ConfirmStore>(
  cfg: HqMcpConfig,
  deps: RuntimeDeps<A, C> = {},
): Runtime<A, C> {
  const now = deps.now ?? ((): Date => new Date());
  // Один бюджет на процесс, лимиты из окружения: ведро SHM общее на весь
  // сервис по IP, и его делят stdio, http и ai-bot (§6.14).
  //
  // exactKeyLimits обязателен, а не украшение: общий потолок откалиброван под
  // поштучные чтения «про одного клиента», а sync_audit вычитывает
  // /admin/user/service и /admin/user ЦЕЛИКОМ — на сколько-нибудь крупной
  // установке это десятки запросов подряд каждый, против общих 30/60с.
  // readShmRows глотает BudgetExceededError через settle, поэтому без этой
  // строки инструмент не падает, а тихо отвечает 200
  // с вечно неполным охватом — то есть сверка врёт, не сообщая об этом.
  const budget = new Budget({
    limit: cfg.budget.limit,
    windowMs: cfg.budget.windowMs,
    now,
    // Оба набора — ТОЧНЫЕ ключи, поэтому едут одной картой. Подстрочный
    // perKeyLimits остаётся пустым намеренно: у обоих наборов ключ включает
    // метод, а подстрока '/user' накрыла бы и /user/*, и половину /admin/user*.
    exactKeyLimits: { ...SHM_PER_KEY_LIMITS, ...BATCH_LIST_LIMITS },
  });
  const probe = createProbeStore();

  const clientDeps = {
    budget,
    profile: cfg.profile,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  /**
   * КАКИЕ СИСТЕМЫ У ЭТОЙ УСТАНОВКИ ЕСТЬ — считается ОДИН раз и здесь.
   *
   * Ненастроенный бэкенд получает не «пустой» клиент, а тот, что бросает
   * BackendNotConfiguredError на любой вызов. Инструменты, которым он нужен, в
   * реестре не показываются (`ToolDef.backends` + `Registry.list`), поэтому в
   * норме до этого клиента не доходит никто. Он существует ради того, чтобы
   * инструмент, разошедшийся со своим объявлением, ОТКАЗАЛ, а не ответил
   * «ничего не найдено».
   */
  const backends = backendPresence(cfg);

  const ctx: ToolContext = {
    shm: cfg.shm === null ? createUnconfiguredShmClient() : createShmClient(cfg.shm, clientDeps),
    remna:
      cfg.remna === null
        ? createUnconfiguredRemnaClient()
        : createRemnaClient(cfg.remna, clientDeps),
    backends,
    profile: cfg.profile,
    mode: cfg.mode,
    now,
    // Зона из конфига, а не константа: SHM пишет даты локальным временем
    // СЕРВЕРА без офсета, и прибитая сюда 'Europe/Moscow' сделала бы
    // HQ_MCP_SHM_TZ мёртвой настройкой — на деплое с другой зоной каждый
    // «голый» штамп читался бы с ошибкой ровно в размер офсета, молча.
    shmTz: cfg.shmTz,
    probe,
  };

  const readTools = createReadTools({
    tunnel: cfg.tunnel,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.probeTcp === undefined ? {} : { probeTcp: deps.probeTcp }),
  });

  // `deps.audit ??` обязателен: он единственный способ подставить журнал и
  // хранилище планов в тесте, не трогая диск. Обе фабрики ленивые — каталог и
  // файл создаются первой записью, поэтому сборка в режиме `ro` ничего никуда
  // не пишет, хотя журнал у неё настоящий.
  const audit = deps.audit ?? (createAuditLog(cfg.auditPath, { now }) as unknown as A);
  const confirm = deps.confirm ?? (createConfirmStore(cfg.snapshotDir, { now }) as unknown as C);

  // Мутаторы регистрируются ВСЕГДА и БЕЗУСЛОВНО — не «если cfg.mode === rw».
  // Видимость решает один механизм, `Registry.list({ mode, profile })`: в `ro`
  // инструмент с access: 'rw' не возвращается вовсе, модель его не видит и
  // вызвать не может. Условная регистрация была бы вторым механизмом сокрытия,
  // а из двух однажды обновляют один.
  //
  // Потолки приходят из cfg.mutations и ниоткуда больше: второе место,
  // читающее HQ_MCP_MAX_OP_AMOUNT со своим дефолтом, — это второй потолок, и
  // разъезжаются они молча. Объект передаётся ЦЕЛИКОМ, а не по полю: потолок,
  // добавленный в @hq/env завтра, обязан доехать сюда сам, а не ждать, пока
  // кто-нибудь вспомнит дописать его в этот список.
  const mutationDeps: MutationDeps = {
    audit: audit as unknown as AuditLog,
    confirm: confirm as unknown as ConfirmStore,
    limits: cfg.mutations,
  };
  const mutators = createMutationTools(mutationDeps);

  /**
   * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ КОНТРАКТА, А НЕ ОФОРМЛЕНИЕ.
   *
   * `ops_audit` и `ops_confirm` мутаторами не являются: они не строят планов и
   * не зовут `defineMutation`, поэтому их нет и не может быть в
   * `MUTATION_FACTORIES` — тот список описывает фабрики одной формы
   * `(deps) => MutationTool`. Ровно из-за этого оба доехали до готовых тестов и
   * НЕ доехали до реестра: собранного шва между ними и рантаймом не было вовсе.
   *
   * `opsConfirm` принимает УЖЕ СОБРАННЫЕ мутаторы — не фабрики и не имена: он
   * единственный вызывающий, который не знает заранее, чей план применяет, и
   * ищет исполнителя по `plan.tool` в этом наборе. Значит собрать его раньше
   * мутаторов физически нечем, и `createMutationTools` обязан отработать до
   * него. Список передаётся тот же самый (`mutators`), а не пересобранный
   * вторым вызовом: второй вызов дал бы другие объекты с теми же именами, и
   * `ops_confirm` применял бы планы через исполнителей, которых в реестре нет.
   *
   * `ops_audit` идёт тем же путём по другой причине: журнал мутаций — часть
   * мутационной поверхности (К21), сервер в `ro` не показывает её ни одной
   * ручкой, и прятать его должен ТОТ ЖЕ единственный механизм видимости
   * (`access: 'rw'` + `Registry.list`), что и мутаторов.
   */
  const mutationTools = [
    ...mutators.map((tool) => tool.def),
    opsAudit(mutationDeps),
    opsConfirm(mutationDeps, mutators),
  ];

  return {
    registry: createRegistry([...readTools, ...mutationTools]),
    ctx,
    budget,
    probe,
    audit,
    confirm,
  };
}
