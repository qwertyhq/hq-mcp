import { z } from 'zod';
import { hashInput, redactDiff } from '@hq/confirm';
import { MUTATING_GET_PATHS, assertNotForbidden } from '@hq/registry';
import { ShmError } from '@hq/shm';
import type { AuditEntry, AuditLog, AuditOutcome, AuditRecord, AuditTarget } from '@hq/audit';
import type { ConfirmStore, DiffEntry, MutationPlan, PlanRollback } from '@hq/confirm';
import type { Capability, Profile, Risk, ToolContext, ToolDef, ToolWarning } from '@hq/types';

/**
 * ИМЯ ПОЛЯ — `plan_id`, А НЕ `confirm_token`, И ЭТО НЕ ВКУСОВЩИНА.
 *
 * `SECRET_KEY_RE` в @hq/redact — это /token|secret|key|password|auth/i, и она
 * сравнивается с ИМЕНЕМ ключа. `executeTool` прогоняет через `redact` ВЕСЬ ответ
 * хендлера, поэтому поле, названное `confirm_token`, доезжает до модели как
 * '<redacted>' — то есть подтвердить план становится нечем. Одновременно тот же
 * токен уезжает открытым текстом внутри строки `hint`, которую редакция не
 * разбирает: поле было бы и замаскировано, и утекло. `plan_id` под правило не
 * попадает, секретом не является (одноразовый идентификатор снимка, привязанный
 * к профилю, инструменту и хешу аргументов) и потому назван честно.
 *
 * Второе имя закреплено в `hashInput` (@hq/confirm): из отпечатка аргументов
 * выбрасываются оба — и `confirm_token`, и `plan_id`.
 */
export const PLAN_ID_FIELD = 'plan_id';

export const planIdField = {
  plan_id: z
    .string()
    .optional()
    .describe(
      'Идентификатор плана, полученный в предыдущем вызове этого же инструмента с теми же ' +
        'аргументами. Без него инструмент только строит план и НИЧЕГО не меняет.',
    ),
};

/** Вход мутатора: поле идентификатора плана обязано быть в схеме (см. 5.14). */
export interface PlanIdInput {
  plan_id?: string | undefined;
}

/**
 * Схема входа, у которой есть `shape`. Тип сужен намеренно: `Registry.register`
 * требует `z.object()` (иначе MCP нечего публиковать как схему), и мутатор,
 * собранный на `.refine()`, ронял бы `buildRuntime` при старте процесса — то
 * есть весь сервер, а не свой вызов.
 */
export type MutationInput<I> = z.ZodType<I> & { readonly shape: Record<string, unknown> };

export interface MutationLimits {
  /** Потолок суммы одной денежной операции, `HQ_MCP_MAX_OP_AMOUNT` (§5.2). */
  maxOpAmount: number;
  /**
   * Потолок числа клиентов, затронутых одной массовой операцией,
   * `HQ_MCP_MAX_BULK_USERS`. Проверяется каркасом по `PlanDraft.affectedUsers`
   * — по той же причине, по какой каркас проверяет и сумму: потолок, который
   * каждый автор проверяет сам, однажды не проверит никто.
   */
  maxBulkUsers: number;
}

export interface MutationDeps {
  audit: AuditLog;
  confirm: ConfirmStore;
  /**
   * Единственный источник потолка — `cfg.mutations.maxOpAmount` из @hq/env.
   * Второго дефолта здесь нет и быть не должно: два потолка с разными
   * значениями — это ровно тот класс, где один молча перестаёт действовать.
   */
  limits: MutationLimits;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Сверка мира между построением плана и его применением (§7.4).
 *
 * ЖИВЁТ НА СПЕЦИФИКАЦИИ, А НЕ В ЧЕРНОВИКЕ ПЛАНА. Черновик уезжает на диск через
 * `JSON.stringify`, а функция этого не переживает; вторая беда — на применении
 * `spec.plan` не зовётся вовсе, поэтому замыкания, созданного при планировании,
 * в этот момент уже не существует. Единственное место, доступное обоим
 * вызывающим (сам мутатор и `ops_confirm`, который диспетчеризует по
 * `plan.tool`), — определение инструмента.
 *
 * `read` получает план: адрес читаемого объекта берётся из снимка `before`
 * (uuid хоста, id услуги), потому что аргументов вызова у `ops_confirm` нет.
 */
export interface PlanGuard {
  /**
   * Поля, расхождение которых означает «мир уехал». Пустым быть не может:
   * пустой список — это сверка, которая всегда молчит, и выглядит она как
   * работающая защита.
   */
  keys: string[];
  read: (plan: MutationPlan, ctx: ToolContext) => Promise<unknown>;
}

export interface PlanDraft {
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
  sideEffects: string[];
  rollback?: PlanRollback | undefined;
  /**
   * Ключ идемпотентности бэкенда. Функция, а не строка, потому что канонический
   * `uniq_key` SHM содержит токен плана, а токен рождается внутри `confirm.put`
   * (@hq/idempotency, `uniqKeyFor`). Пересчитывать ключ на применении нельзя —
   * это ровно тот пересчёт, против которого поле и заведено.
   */
  idempotencyKey?: string | ((token: string) => string) | undefined;
  /**
   * Сумма операции, если она становится известна только при планировании
   * (`money_back` из `dry_run`, стоимость тарифа по каталогу). Обязательна
   * всякий раз, когда `amountOf` вернул `null`, — иначе потолок не проверяется
   * вовсе. Не заполнить её — это ОТКАЗ, а не проход: незнание суммы не делает
   * операцию бесплатной.
   */
  amount?: number | undefined;
  /**
   * СКОЛЬКО КЛИЕНТОВ ЗАДЕНЕТ ЭТА ОПЕРАЦИЯ — число, УСТАНОВЛЕННОЕ У ПАНЕЛИ, а не
   * длина списка, который назвал вызывающий, и не «все».
   *
   * Аналога `amountOf` здесь нет намеренно: из аргументов это число не
   * выводится НИКОГДА. Список из ста id — это сто имён, а не сто существующих
   * учёток (`getUsersByUserIds` и `validateUserIds` панели молча выбрасывают
   * незнакомые), а у ручек `bulk/all/*` списка нет вовсе. Единственный способ
   * узнать его — спросить панель при планировании, и потому поле живёт здесь.
   *
   * Обязательно для инструмента, объявившего массовую ручку (см.
   * `BULK_ENDPOINT_PATHS`): без него потолок `HQ_MCP_MAX_BULK_USERS` не
   * применялся бы к нему вовсе.
   */
  affectedUsers?: number | undefined;
}

export type MutationApplier = (plan: MutationPlan, ctx: ToolContext) => Promise<unknown>;

export interface MutationSpec<I extends PlanIdInput> {
  name: string;
  description: string;
  input: MutationInput<I>;
  risk: Risk;
  profiles: Profile[];
  /** Возможности, без которых инструмент бессмыслен (К11). Реестр гейтит по probe. */
  requires?: Capability[];
  /** Объявленные эндпоинты в формате `METHOD /path`; проверяются при объявлении. */
  endpoints: string[];
  guard: PlanGuard;
  /**
   * Сумма денежной операции из аргументов вызова. Три ответа, и все три разные:
   *
   *  - число — сумма известна прямо на входе, потолок проверяется до плана;
   *  - `null` — «из аргументов не выводится, план сообщит её сам через
   *    `PlanDraft.amount`»; не сообщил — отказ;
   *  - {@link NO_MONEY} — «ЭТОТ вызов денег не двигает вовсе».
   *
   * Третий ответ существует потому, что денежность — свойство ДЕЙСТВИЯ, а не
   * инструмента. `service_lifecycle` объявляет одним инструментом и заказ
   * услуги (списание с баланса), и плановую смену тарифа (не двигает ничего):
   * без `NO_MONEY` пришлось бы либо требовать сумму у `stop`, который её не
   * имеет, либо не требовать её у `give`, который списывает.
   *
   * Обязателен для инструмента, объявившего денежную ручку реестра ИЛИ ручку,
   * тратящую баланс клиента: потолок, который каждый автор проверяет сам,
   * однажды не проверит никто.
   */
  amountOf?: (input: I) => DeclaredAmount;
  /** Пустой diff разрешён явно (снятие блокировки, перевыпуск без изменений). */
  allowEmptyDiff?: boolean;
  /** Кого правим — чтобы «что делали клиенту 3073» искалось не грепом по input. */
  target?: (input: I) => AuditTarget | undefined;
  plan: (input: I, ctx: ToolContext) => Promise<PlanDraft>;
  apply: MutationApplier;
}

/** Всё, что нужно, чтобы применить план: и мутатору, и `ops_confirm`. */
export interface MutationRunner {
  apply: MutationApplier;
  guard: PlanGuard;
  endpoints: readonly string[];
}

export interface MutationTool extends MutationRunner {
  def: ToolDef;
  name: string;
  endpoints: string[];
}

export interface PlanResult {
  status: 'plan';
  tool: string;
  plan_id: string;
  expiresAt: string;
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
  sideEffects: string[];
  rollback?: PlanRollback;
  hint: string;
}

export interface AppliedResult {
  status: 'applied';
  tool: string;
  plan_id: string;
  result: unknown;
  rollback?: PlanRollback;
  /** Непустое только там, где что-то пошло не так ПОСЛЕ успешной мутации. */
  warnings?: ToolWarning[];
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Ретрай ТОЛЬКО на локе услуги: HTTP 408, `FOR UPDATE SKIP LOCKED` (§6.19).
 *
 * Сравнивается `status === 408`, а НЕ флаг `retryable`. Клиент SHM ставит
 * `retryable: true` любому таймауту и обрыву соединения
 * (`new ShmError(..., 0, timedOut)`, дефолт 10 секунд): ответ на
 * `PUT /admin/user/payment` мог не успеть в окно, платёж при этом УЖЕ прошёл, и
 * повтор по флагу превращает одно списание в три. 408 — единственный статус,
 * про который бэкенд сказал, что не сделал ничего.
 */
export async function retryOn408<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const locked = error instanceof ShmError && error.status === 408;
      if (!locked || attempt === attempts - 1) throw error;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw lastError;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Идемпотентности у Remnawave нет вовсе, у SHM она есть ровно на одной ручке
 * (§7.4), поэтому перед применением сверяется состояние. Расхождение — отказ, а
 * не повторное применение: план держит ЦЕЛЫЙ объект в `after` (read-merge-write),
 * и применённый поверх чужой правки он эту правку стирает молча.
 */
export function assertUnchanged(
  before: unknown,
  current: unknown,
  keys: string[],
  what: string,
): void {
  const left = asRecord(before);
  const right = asRecord(current);
  for (const key of keys) {
    const from = left[key];
    const to = right[key];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
    throw new Error(
      `${what}: состояние изменилось после построения плана (${key}: ${JSON.stringify(from)} -> ` +
        `${JSON.stringify(to)}). Постройте план заново, повторное применение запрещено (§7.4)`,
    );
  }
}

/**
 * Ручки SHM, движущие деньги. Инструмент, объявивший любую из них, обязан
 * сообщать сумму — иначе потолок §5.2 не применяется к нему вообще, и автор
 * узнаёт об этом от клиента с лишним нулём, а не от компилятора.
 */
export const MONEY_ENDPOINT_PATHS: readonly string[] = [
  '/admin/user/payment',
  '/admin/user/bonus',
  '/admin/user/service/withdraw',
];

/**
 * Ручки SHM, которые ТРАТЯТ БАЛАНС КЛИЕНТА, не будучи денежными ручками
 * реестра. Разница между этим списком и {@link MONEY_ENDPOINT_PATHS} — не в
 * размере суммы, а в том, кто её называет: там сумму передаёт вызывающий, здесь
 * её считает биллинг по каталогу, и потому она обязана быть прочитана планом.
 *
 * Каждая строка — прочитанный код SHM, а не догадка по имени маршрута:
 *
 *  - `PUT /admin/service/order` → `USObject::create_for_api` → `create` →
 *    `Billing::create_service`; при `auto_bill` (структура `us`, default 1)
 *    сразу идёт `process_service_recursive(EVENT_CREATE)` → `Billing::create` →
 *    `is_pay` → `user->set_balance(-total)` (Billing.pm:38-46, 337-352, 279-320).
 *  - `POST /admin/user/service/touch` → `touch_api` → `touch(EVENT_PROLONGATE)`
 *    → `process_service` → `create`/`prolongate` → тот же `is_pay`
 *    (USObject.pm:364-382, Billing.pm:122-166).
 *  - `POST /admin/user/service/change` → `USObject::change`: из BLOCK/NOT PAID
 *    сразу `switch_to_next_service` (новое списание), из ACTIVE при
 *    `finish_active=1` — `finish` (возврат остатка) и следом тот же
 *    `touch(EVENT_PROLONGATE)` (USObject.pm:906-937).
 *  - `POST /admin/user/service/activate` → `activate_force`: у истёкшей услуги
 *    зовёт `Billing::prolongate(force => 1)` (USObject.pm:753-774).
 *
 * Чего здесь НЕТ и почему:
 *
 *  - `POST /admin/user/service` (плановая смена тарифа) — это `USObject::api_set`
 *    с whitelist `admin|auto_bill|next|settings` (USObject.pm:886-899). Запись
 *    поля `next` и ничего больше: ни списания, ни события, ни спула.
 *  - `POST /admin/user/service/stop` — `block_force` → `touch(EVENT_BLOCK_FORCE)`
 *    → `Billing::block`, который возвращает событие и не трогает баланс;
 *    возврат остатка сделал бы `USObject::finish`, но `block_force` его не
 *    зовёт (USObject.pm:736-750, Billing.pm:475-479).
 *  - `DELETE /admin/user/service` — `Billing::remove` → `money_back`: деньги
 *    ВОЗВРАЩАЮТСЯ клиенту, а не тратятся. Сумму возврата считает SHM по
 *    остатку периода, и заранее её не знает никто: потолок на ней означал бы
 *    запрет удалять услуги вообще.
 *
 * Список закрытый и его придётся пополнять руками — как и денежный. Префикса
 * здесь быть не может: `/admin/service` (чтение каталога) и
 * `/admin/service/order` (заказ) различаются ровно хвостом, и правило по
 * префиксу либо не поймало бы заказ, либо объявило бы денежным чтение.
 */
export const BALANCE_SPEND_ENDPOINT_PATHS: readonly string[] = [
  '/admin/service/order',
  '/admin/user/service/touch',
  '/admin/user/service/change',
  '/admin/user/service/activate',
];

/**
 * Ответ `amountOf`, означающий «этот вызов денег не двигает». Строка, а не
 * `undefined` и не `0`: `undefined` неотличим от «автор забыл», а `0` — это
 * законная сумма (бесплатный тариф стоит ровно ноль, и списание на ноль
 * происходит по-настоящему).
 */
export const NO_MONEY = 'no_money';

/** Что `amountOf` вправе ответить. См. {@link MutationSpec.amountOf}. */
export type DeclaredAmount = number | null | typeof NO_MONEY;

/**
 * Ручки панели, задевающие НЕИЗВЕСТНОЕ ЧИСЛО КЛИЕНТОВ ОДНИМ ВЫЗОВОМ. Инструмент,
 * объявивший любую из них, обязан сообщать это число планом — иначе потолок
 * §5.2-родственник (`HQ_MCP_MAX_BULK_USERS`) не применяется к нему вообще, и
 * автор узнаёт об этом от оператора, который задел 1125 учёток вместо девяти.
 *
 * Префикс, а не перечисление семи путей: и `bulk/update`, и `bulk/all/update`,
 * и любая ручка, которую Remnawave добавит под этим корнем завтра, попадают под
 * требование сами. Обратный порядок (список известных имён) означал бы, что
 * новая массовая ручка проезжает без счёта до тех пор, пока кто-нибудь не
 * вспомнит дописать её сюда.
 */
export const BULK_ENDPOINT_PATHS: readonly string[] = ['/api/users/bulk'];

const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;

interface ParsedEndpoint {
  method: string;
  path: string;
}

function parseEndpoint(tool: string, raw: string): ParsedEndpoint {
  const found = ENDPOINT_RE.exec(raw.trim());
  if (found === null) {
    throw new Error(
      `${tool}: эндпоинт ${JSON.stringify(raw)} не разбирается. Ожидается "METHOD /path", ` +
        'напр. "PUT /admin/user/payment" — по этой строке работают и запрет §8, и журнал.',
    );
  }
  return { method: found[1] as string, path: found[2] as string };
}

/**
 * Проверки, которые обязаны сработать при СБОРКЕ реестра, а не при первом
 * вызове: инструмент с запрещённым эндпоинтом иначе спокойно доезжает до прода
 * и ждёт там своего первого вызова.
 */
function assertEndpoints(tool: string, endpoints: string[]): ParsedEndpoint[] {
  if (endpoints.length === 0) {
    throw new Error(
      `${tool}: не объявлено ни одного эндпоинта. Список нужен запрету §8 и журналу мутаций ` +
        '(поле calls записи applying — единственный след того, куда мы собирались писать).',
    );
  }
  const parsed = endpoints.map((raw) => parseEndpoint(tool, raw));
  for (const one of parsed) {
    // Метод передаётся явно: часть правил сужена до конкретных методов, и без
    // метода они не совпадают вовсе (PUT /admin/spool, DELETE /admin/user/pay).
    assertNotForbidden(one.path, one.method);
    // §6.15: риск классифицируется по имени ручки, никогда по HTTP-методу.
    // Такой GET оба клиента отвергают в `raw()` — и на get, и на getRaw, — то
    // есть объявленный здесь эндпоинт был бы неисполним. Пусть автор узнает об
    // этом при старте, а не из отказа посреди денежной операции.
    if (
      one.method === 'GET' &&
      MUTATING_GET_PATHS.some((bad) => one.path.startsWith(bad))
    ) {
      throw new Error(
        `${tool}: ${one.method} ${one.path} — мутирующий GET (§6.15). Клиенты SHM и панели ` +
          'отказывают на нём в обоих каналах (get и getRaw), поэтому объявить его инструментом ' +
          'нельзя: сначала нужен явный канал для мутирующих GET в @hq/shm, иначе инструмент ' +
          'соберётся и не сможет сделать ничего.',
      );
    }
  }
  return parsed;
}

function isMoneyEndpoint(one: ParsedEndpoint): boolean {
  return MONEY_ENDPOINT_PATHS.some((money) => one.path.includes(money));
}

/**
 * Совпадение ТОЧНОЕ, и метод обязан быть пишущим. `GET /admin/service` — это
 * чтение каталога, и объявить инструмент денежным по нему значило бы требовать
 * сумму у всякого, кто заглянул в прайс.
 */
function isSpendEndpoint(one: ParsedEndpoint): boolean {
  return one.method !== 'GET' && BALANCE_SPEND_ENDPOINT_PATHS.includes(one.path);
}

function isBulkEndpoint(one: ParsedEndpoint): boolean {
  return one.method !== 'GET' && BULK_ENDPOINT_PATHS.some((bulk) => one.path.startsWith(bulk));
}

function ceilingMessage(tool: string, amount: number, limit: number): string {
  return (
    `${tool}: |${amount}| превышает потолок MAX_OP_AMOUNT=${limit}. Операция такого размера ` +
    'делается руками в админке, а не инструментом.'
  );
}

function assertWithinCeiling(
  tool: string,
  amount: number,
  limits: MutationLimits,
): void {
  if (!Number.isFinite(amount)) {
    throw new Error(`${tool}: сумма операции не число (${String(amount)}) — потолок не проверить`);
  }
  if (Math.abs(amount) > limits.maxOpAmount) {
    throw new Error(ceilingMessage(tool, amount, limits.maxOpAmount));
  }
}

/**
 * Потолок массовой операции. Отказ формулируется числами оператора («затронуто
 * 1125, разрешено 100»), а не именем переменной: тот, кто читает отказ, обычно
 * не знает, сколько стоит в `.env`, и обязан узнать оба числа сразу.
 */
function assertWithinBulkCap(tool: string, affected: number, limits: MutationLimits): void {
  if (!Number.isInteger(affected) || affected < 0) {
    throw new Error(
      `${tool}: число затронутых клиентов не установлено (${String(affected)}). Массовая ` +
        'операция без счёта не применяется: план обязан спросить его у панели.',
    );
  }
  if (affected > limits.maxBulkUsers) {
    throw new Error(
      `${tool}: операция затронет ${String(affected)} клиентов, а потолок ` +
        `HQ_MCP_MAX_BULK_USERS=${String(limits.maxBulkUsers)}. Это отказ, а не усечение: ` +
        'применить к части списка молча было бы хуже, чем не применять вовсе. Сузьте набор или ' +
        'поднимите потолок осознанно — он на то и настраиваемый.',
    );
  }
}

interface WriteContext {
  deps: MutationDeps;
  tool: string;
  ctx: ToolContext;
  input: unknown;
  calls: readonly string[];
  target?: AuditTarget | undefined;
}

async function note(
  where: WriteContext,
  outcome: AuditOutcome,
  extra: Omit<AuditEntry, 'tool' | 'profile' | 'mode' | 'outcome' | 'input'>,
): Promise<AuditRecord> {
  return where.deps.audit.write({
    tool: where.tool,
    profile: where.ctx.profile,
    // 5.19: `mode` обязателен. Запись без него не отличает прогон с реальной
    // записью от прогона в ro-сборке, где мутация и не должна была случиться.
    mode: where.ctx.mode,
    outcome,
    input: where.input,
    calls: where.calls,
    target: where.target,
    ...extra,
  });
}

/** Отказ, зафиксированный в журнале (§7.5: отказы журналируются наравне с успехами). */
async function noteRejected(
  where: WriteContext,
  error: unknown,
  snapshot: { before: unknown; after: unknown; token?: string | undefined } = {
    before: null,
    after: null,
  },
): Promise<void> {
  await note(where, 'rejected', {
    before: snapshot.before,
    after: snapshot.after,
    token: snapshot.token,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * ЕДИНАЯ точка применения плана: и из самого мутатора, и из `ops_confirm`.
 *
 * Порядок шагов — не стиль, а требования по одному:
 *  1. `guard.read` + `assertUnchanged` — мир мог уехать за десять минут жизни
 *     плана, и применённый поверх чужой правки план стирает её молча (§7.4).
 *  2. запись `applying` ДО обращения к бэкенду — единственный след процесса,
 *     умершего на середине: снимок к этому моменту уже удалён `take`,
 *     а деньги ушли (§7.5, `unclosedAttempts`).
 *  3. `retryOn408` вокруг применения — здесь, а не у каждого автора: половина
 *     авторов забудет, вторая половина повторит таймаут.
 *  4. успех фиксируется ДО того, как о нём пишут: провал записи в журнал
 *     не имеет права превратить прошедшую мутацию в `failed` — оператор на
 *     такой ответ повторяет операцию.
 */
export async function applyPlan(opts: {
  plan: MutationPlan;
  runner: MutationRunner;
  ctx: ToolContext;
  deps: MutationDeps;
  input: unknown;
  target?: AuditTarget | undefined;
}): Promise<AppliedResult> {
  const { plan, runner, ctx, deps, input } = opts;
  const where: WriteContext = {
    deps,
    tool: plan.tool,
    ctx,
    input,
    calls: runner.endpoints,
    target: opts.target,
  };
  const snapshot = { before: plan.before, after: plan.after, token: plan.token };

  try {
    const current = await runner.guard.read(plan, ctx);
    assertUnchanged(plan.before, current, runner.guard.keys, plan.tool);
  } catch (error: unknown) {
    await noteRejected(where, error, snapshot);
    throw error;
  }

  const started = await note(where, 'applying', {
    before: plan.before,
    after: plan.after,
    token: plan.token,
  });

  let result: unknown;
  try {
    result = await retryOn408(() => runner.apply(plan, ctx), {
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } catch (error: unknown) {
    try {
      await note(where, 'failed', {
        before: plan.before,
        after: plan.after,
        token: plan.token,
        attempt: started.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      /* причина отказа важнее неудачи журнала: наружу уходит исходная ошибка */
    }
    throw error;
  }

  const applied: AppliedResult = {
    status: 'applied',
    tool: plan.tool,
    plan_id: plan.token,
    result,
    ...(plan.rollback === undefined ? {} : { rollback: plan.rollback }),
  };

  try {
    await note(where, 'applied', {
      before: plan.before,
      after: plan.after,
      token: plan.token,
      attempt: started.id,
      result,
    });
  } catch (error: unknown) {
    // Мутация ПРОШЛА. Превратить её в `failed` из-за журнала значит показать
    // оператору ошибку на успешной операции — а естественный ответ на ошибку
    // денежной ручки это повтор.
    applied.warnings = [
      {
        code: 'audit_write_failed',
        message:
          `Операция выполнена, но записать её в журнал мутаций не удалось: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `В журнале осталась незакрытая запись applying (${started.id}) — закройте её руками. ` +
          'НЕ ПОВТОРЯЙТЕ операцию: она уже применена.',
      },
    ];
  }

  return applied;
}

/**
 * Каркас мутатора (§7.3): без `plan_id` — только план (снимок «до», diff,
 * побочные эффекты, данные отката) и запись `planned`; с `plan_id` — применение
 * ровно того плана, что лежит на диске, ровно теми же аргументами.
 *
 * Отказы на КАЖДОМ этапе (потолок суммы, пустой diff, чужой план, уехавший мир)
 * журналируются как `rejected`: §7.5 требует писать каждую попытку, а не только
 * удачные — иначе журнал показывает историю, которой не было.
 */
export function defineMutation<I extends PlanIdInput>(
  spec: MutationSpec<I>,
  deps: MutationDeps,
): MutationTool {
  const endpoints = assertEndpoints(spec.name, spec.endpoints);
  const isMoney = endpoints.some(isMoneyEndpoint);
  const isSpend = endpoints.some(isSpendEndpoint);
  /** Хоть один объявленный маршрут двигает деньги — значит сумму придётся называть. */
  const movesMoney = isMoney || isSpend;
  const isBulk = endpoints.some(isBulkEndpoint);

  if (isBulk && !spec.profiles.every((profile) => profile === 'human')) {
    throw new Error(
      `${spec.name}: инструмент объявил массовую ручку (${endpoints
        .filter(isBulkEndpoint)
        .map((one) => `${one.method} ${one.path}`)
        .join(', ')}) и при этом доступен профилю ${spec.profiles
        .filter((profile) => profile !== 'human')
        .join(', ')}. Массовая операция необратима и задевает клиентов, которых бот не видел ` +
        'ни одного: это отказ при сборке реестра, а не решение автора инструмента.',
    );
  }

  if (movesMoney && spec.amountOf === undefined) {
    throw new Error(
      `${spec.name}: инструмент объявил ручку, двигающую деньги (${endpoints
        .filter((one) => isMoneyEndpoint(one) || isSpendEndpoint(one))
        .map((one) => `${one.method} ${one.path}`)
        .join(', ')}), но не объявил amountOf. Потолок MAX_OP_AMOUNT (§5.2) применяется ` +
        'каркасом и только по нему; верните null, если сумма известна лишь при планировании — ' +
        'тогда её обязан сообщить PlanDraft.amount, а для действий, которые денег не двигают, ' +
        'есть NO_MONEY.',
    );
  }

  if (spec.guard.keys.length === 0) {
    throw new Error(
      `${spec.name}: guard.keys пуст — такая сверка молчит всегда и выглядит работающей. ` +
        'Назовите поля, расхождение которых означает, что мир уехал между планом и применением ' +
        '(status, expireAt, id последней строки — что угодно, что читается заново).',
    );
  }

  const shape = (spec.input as { shape?: unknown }).shape;
  if (typeof (spec.input as { parse?: unknown }).parse !== 'function' || typeof shape !== 'object' || shape === null) {
    throw new Error(
      `${spec.name}: input обязан быть z.object() — Registry.register требует shape, чтобы MCP ` +
        'опубликовал схему, и мутатор на .refine() уронил бы сборку рантайма целиком.',
    );
  }
  if (!(PLAN_ID_FIELD in (shape as Record<string, unknown>))) {
    throw new Error(
      `${spec.name}: в схеме нет поля ${PLAN_ID_FIELD} (добавьте ...planIdField). Без него zod ` +
        'вырезает пришедшее значение, поле всегда undefined, и инструмент навсегда остаётся в ' +
        'режиме плана: подтвердить его нельзя, а выглядит он работающим.',
    );
  }

  const runner: MutationRunner = {
    apply: spec.apply,
    guard: spec.guard,
    endpoints: spec.endpoints,
  };

  const def: ToolDef<I, unknown> = {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    access: 'rw',
    risk: spec.risk,
    profiles: spec.profiles,
    ...(spec.requires === undefined ? {} : { requires: spec.requires }),
    handler: async (input: I, ctx: ToolContext): Promise<PlanResult | AppliedResult> => {
      // Вторая линия к фильтру реестра: реестр не показывает rw-инструменты в
      // режиме ro, но резолв по имени в обход listVisibleTools однажды появится.
      if (ctx.mode !== 'rw') {
        throw new Error(`${spec.name}: сервер запущен в режиме ro, мутации запрещены`);
      }

      const target = spec.target?.(input);
      const where: WriteContext = {
        deps,
        tool: spec.name,
        ctx,
        input,
        calls: spec.endpoints,
        target,
      };

      const planId = input[PLAN_ID_FIELD];
      if (planId === undefined) {
        let draft: PlanDraft;
        try {
          const declared = spec.amountOf === undefined ? null : spec.amountOf(input);

          // Отказаться от суммы вправе только инструмент, у которого денежным
          // является ДЕЙСТВИЕ, а не сам инструмент. У денежных ручек реестра
          // сумму передаёт вызывающий — «этот вызов денег не двигает» там
          // означало бы, что потолок отключается по просьбе автора.
          if (declared === NO_MONEY && isMoney) {
            throw new Error(
              `${spec.name}: amountOf вернул NO_MONEY, но инструмент объявил денежную ручку ` +
                `реестра (${endpoints
                  .filter(isMoneyEndpoint)
                  .map((one) => `${one.method} ${one.path}`)
                  .join(', ')}). Там денег не двигает ни один вызов — такого не бывает: сумму ` +
                'туда передаёт вызывающий, и отказ её назвать выключил бы потолок совсем.',
            );
          }

          const declaredAmount = declared === NO_MONEY ? null : declared;
          if (declaredAmount !== null) assertWithinCeiling(spec.name, declaredAmount, deps.limits);

          draft = await spec.plan(input, ctx);

          const amount = draft.amount ?? declaredAmount;
          if (movesMoney && declared !== NO_MONEY && (amount === null || amount === undefined)) {
            throw new Error(
              `${spec.name}: операция двигает деньги клиента, но план не сообщил сумму ` +
                '(amountOf вернул null, PlanDraft.amount не заполнен) — потолок MAX_OP_AMOUNT ' +
                'проверить нечем. Это отказ, а не пропуск: незнание суммы не делает операцию ' +
                'бесплатной.',
            );
          }
          if (amount !== null && amount !== undefined) {
            assertWithinCeiling(spec.name, amount, deps.limits);
          }

          // Массовая ручка без установленного числа затронутых — это план,
          // который нельзя подтвердить осознанно: оператор подтверждал бы
          // «применить ко всем», не зная, сколько их. Отказ здесь, а не
          // вежливость автора инструмента.
          if (isBulk) {
            if (draft.affectedUsers === undefined) {
              throw new Error(
                `${spec.name}: инструмент объявил массовую ручку, но план не сообщил, скольких ` +
                  'клиентов она затронет (PlanDraft.affectedUsers пуст). Это число берётся у ' +
                  'панели при планировании и не выводится из аргументов: список id — это имена, ' +
                  'а не существующие учётки. Без него потолок HQ_MCP_MAX_BULK_USERS не ' +
                  'применяется вовсе.',
              );
            }
            assertWithinBulkCap(spec.name, draft.affectedUsers, deps.limits);
          }

          if (draft.diff.length === 0 && spec.allowEmptyDiff !== true) {
            throw new Error(
              `${spec.name}: план ничего не меняет (diff пуст). Подтверждать пустой план нельзя: ` +
                'запись всё равно уйдёт и упадёт уже на бэкенде. Если пустота законна — ' +
                'объявите allowEmptyDiff.',
            );
          }
        } catch (error: unknown) {
          await noteRejected(where, error);
          throw error;
        }

        // 5.15: diff маскируется ВСЕГДА, а не только когда автор вспомнил про
        // buildDiff. Собранный руками `{path:'trojanPassword', from, to}` иначе
        // уезжает в контекст модели открытым текстом: `redact` видит там только
        // имена ключей path/from/to.
        const diff = redactDiff(draft.diff, ctx.profile);

        const plan = await deps.confirm.put({
          tool: spec.name,
          profile: ctx.profile,
          inputHash: hashInput(input),
          before: draft.before,
          after: draft.after,
          diff,
          sideEffects: draft.sideEffects,
          rollback: draft.rollback,
          idempotencyKey: draft.idempotencyKey,
        });

        await note(where, 'planned', {
          before: draft.before,
          after: draft.after,
          token: plan.token,
        });

        return {
          status: 'plan',
          tool: spec.name,
          plan_id: plan.token,
          expiresAt: plan.expiresAt,
          before: plan.before,
          after: plan.after,
          diff: plan.diff,
          sideEffects: plan.sideEffects,
          ...(plan.rollback === undefined ? {} : { rollback: plan.rollback }),
          hint:
            `Ничего не изменено. Применить: ops_confirm { "plan_id": "${plan.token}" } ` +
            `или повторить ${spec.name} с ТЕМИ ЖЕ аргументами и этим plan_id.`,
        };
      }

      // `take` сам сверяет профиль (К8), имя инструмента и отпечаток аргументов,
      // и делает это ДО удаления снимка: отказ не сжигает чужой план. Своей
      // проверки `plan.tool` здесь нет намеренно — она переехала внутрь.
      let plan: MutationPlan;
      try {
        plan = await deps.confirm.take(planId, ctx.profile, spec.name, hashInput(input));
      } catch (error: unknown) {
        await noteRejected(where, error);
        throw error;
      }

      return applyPlan({ plan, runner, ctx, deps, input, target });
    },
  };

  return {
    def: def as unknown as ToolDef,
    name: spec.name,
    apply: spec.apply,
    guard: spec.guard,
    endpoints: spec.endpoints,
  };
}
