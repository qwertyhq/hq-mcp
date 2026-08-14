/**
 * Ключи идемпотентности SHM.
 *
 * ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ ПРО ЭТОТ ПАКЕТ: `uniq_key` — НЕ общий механизм
 * идемпотентности денежных операций. Он существует ровно для одной таблицы и
 * ровно для одной ручки.
 *
 * Проверено по схеме и по роутеру, а не по документации:
 * - `pays_history` — единственная таблица с колонкой `uniq_key` и уникальным
 *   индексом `UNIQUE KEY (user_id, uniq_key)` (`shm_structure.sql:102-112`);
 * - `bonus_history` (`:354-362`) и `withdraw_history` (`:256-275`) не имеют ни
 *   колонки, ни индекса;
 * - дедуп написан в одном месте — `Core::User::payment` (`User.pm:1006-1015`):
 *   при совпадении `(user_id, uniq_key)` возвращается СУЩЕСТВУЮЩИЙ платёж,
 *   баланс не меняется и события в спул не ставятся (это же закреплено тестом
 *   самой SHM: `app/t/integration/pay/pay.t:63-97`);
 * - единственный маршрут, доходящий до этого метода, — `PUT /admin/user/payment`
 *   (`v1.cgi:728-735`). `PUT /admin/user/bonus` идёт в `Core::Bonus` и про
 *   `uniq_key` не знает вовсе.
 *
 * Хуже того: `Core::Sql::Data::clean_query_args` (`:503-521`) МОЛЧА выбрасывает
 * любой аргумент, которого нет в `structure` таблицы. То есть `uniq_key`,
 * отправленный в `PUT /admin/user/bonus`, не вызовет ошибки — он просто
 * исчезнет, ручка вернёт 200, а в `bonus_history` ляжет вторая строка и бонус
 * клиента удвоится. Ключ будет ВЫГЛЯДЕТЬ защитой в теле запроса и не быть ею.
 *
 * Поэтому {@link IdempotentOp} — закрытый перечень: операция, которая физически
 * не ходит в `PUT /admin/user/payment`, не может получить ключ ни на типах, ни в
 * рантайме. Чем защищаться вместо ключа — см. {@link NON_IDEMPOTENT_WRITES} и
 * {@link stampComment}.
 *
 * Ключ выводится ИЗ ТОКЕНА ПЛАНА, а не из окна времени. Оконный ключ
 * (`floor(now/5min)`) неверен в обе стороны сразу: две намеренно одинаковые
 * операции внутри окна он склеивает (вторая молча не проводится, а инструмент
 * рапортует успех), а ретрай через границу окна получает ДРУГОЙ ключ — то есть
 * второй платёж ровно там, где ключ и был нужен. Токен плана уже уникален, уже
 * одноразовый и уже переживает ретраи, потому что вычисляется один раз в
 * `put` и хранится в снимке (`MutationPlan.idempotencyKey`).
 */

/**
 * Ширина колонки `pays_history.uniq_key` — `char(255)`.
 *
 * Не косметика: MySQL вне strict-режима обрежет более длинное значение молча, и
 * два ключа, различающиеся после 255-го символа, схлопнутся в один. Это дало бы
 * ЛОЖНЫЙ дедуп — платёж, который не прошёл и выглядит прошедшим.
 */
export const SHM_UNIQ_KEY_MAX = 255;

/**
 * Операции, которые физически применяются через `PUT /admin/user/payment` —
 * единственную ручку SHM, где `uniq_key` действует.
 *
 * `billing_adjust:balance` — движение денег (`User::payment`).
 * `billing_refund_service` — возврат: компенсирующий платёж на фактический
 * `money_back` из `dry_run`, тоже `PUT /admin/user/payment`.
 *
 * `billing_adjust:bonus` в перечень НЕ входит и входить не может.
 */
export const IDEMPOTENT_OPS = ['billing_adjust:balance', 'billing_refund_service'] as const;

export type IdempotentOp = (typeof IDEMPOTENT_OPS)[number];

/**
 * Пишущие ручки SHM, у которых идемпотентности НЕТ ВООБЩЕ, и что это значит для
 * мутатора. Текст отсюда уходит в отказ {@link assertIdempotentOp}, чтобы автор
 * узнал об этом от компилятора, а не от клиента с удвоенным бонусом.
 */
export const NON_IDEMPOTENT_WRITES: Readonly<Record<string, string>> = {
  'PUT /admin/user/bonus':
    'у таблицы bonus_history нет колонки uniq_key и нет уникального индекса (shm_structure.sql:354-362), ' +
    'а Core::Sql::Data::clean_query_args молча выбрасывает неизвестное поле из запроса. ' +
    'Повторный вызов запишет ВТОРУЮ строку и удвоит бонус клиента, вернув 200.',
  'PUT /admin/user/service/withdraw':
    'у таблицы withdraw_history нет колонки uniq_key (shm_structure.sql:256-275). ' +
    'Повторный вызов создаст второе списание.',
};

/** Прямое применение или компенсирующая операция того же плана. */
export type KeyVariant = 'apply' | 'rollback';

export interface UniqKeyInput {
  userId: number;
  op: IdempotentOp;
  /**
   * Токен плана из `MutationPlan.token`. Именно он делает ключ устойчивым к
   * ретраям и одновременно уникальным для каждой намеренной операции.
   */
  token: string;
  /** По умолчанию `apply`. */
  variant?: KeyVariant;
}

/**
 * Формат токена плана: `randomUUID()`, которым `createConfirmStore.put` метит
 * снимок. Проверка строгая намеренно — см. {@link assertPlanToken}.
 */
const PLAN_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IDEMPOTENT_OP_SET: ReadonlySet<string> = new Set<string>(IDEMPOTENT_OPS);

/**
 * Токен обязан быть настоящим токеном плана.
 *
 * Пустая строка или заглушка дали бы ОДИН ключ на все платежи клиента по этой
 * операции: первый прошёл бы, а каждый следующий молча вернул бы первый платёж.
 * Это тише обычного дубля и потому опаснее — оператор видит `applied` и уходит.
 */
function assertPlanToken(token: string): string {
  if (!PLAN_TOKEN_RE.test(token)) {
    throw new Error(
      `uniq_key строится из токена плана, а получено ${JSON.stringify(token)}. ` +
        'Ключ обязан приходить из MutationPlan.token (uuid в нижнем регистре): ключ, не привязанный ' +
        'к плану, склеивает разные операции в одну и молча не проводит вторую.',
    );
  }
  return token;
}

function assertUserId(userId: number): number {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(
      `uniq_key: user_id должен быть целым положительным числом, получено ${String(userId)}`,
    );
  }
  return userId;
}

export function isIdempotentOp(op: string): op is IdempotentOp {
  return IDEMPOTENT_OP_SET.has(op);
}

/**
 * Пропускает только операции, которые физически идут в `PUT /admin/user/payment`.
 *
 * Нужна там, где имя операции собрано из строк (`billing_adjust:${kind}`) и
 * типы уже не спасают. Отказ подробный: он должен не просто запретить, а
 * сказать, чем защищаться вместо ключа.
 */
export function assertIdempotentOp(op: string): IdempotentOp {
  if (isIdempotentOp(op)) return op;
  const routes = Object.entries(NON_IDEMPOTENT_WRITES)
    .map(([route, why]) => `  ${route} — ${why}`)
    .join('\n');
  throw new Error(
    `операция ${JSON.stringify(op)} не может получить uniq_key: он действует ТОЛЬКО в ` +
      `PUT /admin/user/payment (Core::User::payment, User.pm:1006-1015). Идемпотентны: ` +
      `${IDEMPOTENT_OPS.join(', ')}.\n${routes}\n` +
      'Защиты для таких операций ровно две, и обе на стороне мутатора: (1) проверка состояния ' +
      'перед применением и (2) поиск уже созданной строки ДО записи — проштампуйте комментарий ' +
      'маркером плана (stampComment) и ищите его findMarkedRow, тогда повтор виден точно, а не по ' +
      'совпадению суммы и времени.',
  );
}

/**
 * `uniq_key` для SHM из личности плана: `hq:${op}:${userId}:${token}`.
 *
 * Один и тот же план на любой попытке даёт один и тот же ключ — ретрай после
 * таймаута не станет вторым платежом. Разные планы дают разные ключи — две
 * намеренно одинаковые операции обе пройдут.
 *
 * `variant: 'rollback'` — для компенсирующей операции того же плана. Она обязана
 * нести ДРУГОЙ ключ: с ключом отменяемого платежа SHM вернула бы исходную строку,
 * деньги остались бы на месте, а откат выглядел бы выполненным.
 */
export function makeUniqKey(input: UniqKeyInput): string {
  const op = assertIdempotentOp(input.op);
  const userId = assertUserId(input.userId);
  const token = assertPlanToken(input.token);
  const suffix = input.variant === 'rollback' ? ':rollback' : '';
  const key = `hq:${op}:${userId}:${token}${suffix}`;
  if (key.length > SHM_UNIQ_KEY_MAX) {
    // Недостижимо при закрытом перечне операций — и ровно поэтому проверка
    // стоит здесь: она сторожит будущее пополнение перечня, а не сегодняшний вход.
    throw new Error(
      `uniq_key длиной ${key.length} не влезает в pays_history.uniq_key char(${SHM_UNIQ_KEY_MAX}): ` +
        'MySQL обрежет его молча, и два разных ключа схлопнутся в один',
    );
  }
  return key;
}

/**
 * Тот же ключ, но отложенный до рождения токена.
 *
 * `MutationDraft.idempotencyKey` принимает функцию от токена именно потому, что
 * токен минтится внутри `put`. Аргументы проверяются здесь, на построении
 * черновика, а не в момент вызова из хранилища: иначе отказ прилетел бы из чужого
 * стека посреди записи снимка.
 */
export function uniqKeyFor(
  op: IdempotentOp,
  userId: number,
  variant: KeyVariant = 'apply',
): (token: string) => string {
  assertIdempotentOp(op);
  assertUserId(userId);
  return (token: string): string => makeUniqKey({ op, userId, token, variant });
}

/** Поле комментария, в котором едет маркер плана. */
const MARKER_FIELD = 'hq_plan';
const MARKER_PREFIX = 'hq-plan:';

/**
 * Маркер плана для таблиц, где `uniq_key` не существует.
 *
 * Это не идемпотентность: SHM всё равно запишет вторую строку, если её попросить.
 * Это возможность УЗНАТЬ свою строку до записи — точным совпадением, а не
 * гаданием по `(user_id, date, amount, comment)`, которое ошибается в обе стороны
 * (одинаковые начисления неразличимы, а разошедшиеся часы ломают сравнение дат).
 */
export function makePlanMarker(token: string): string {
  return `${MARKER_PREFIX}${assertPlanToken(token)}`;
}

/**
 * Комментарий с маркером плана. `msg` — то, что увидит человек в истории и в
 * уведомлении; `hq_plan` — то, по чему повтор находит собственную строку.
 */
export function stampComment(text: string, token: string): { msg: string; hq_plan: string } {
  return { msg: text, [MARKER_FIELD]: makePlanMarker(token) };
}

function carriesMarker(row: unknown, marker: string): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const comment = (row as { comment?: unknown }).comment;
  if (typeof comment === 'string') return comment.includes(marker);
  if (typeof comment !== 'object' || comment === null) return false;
  return (comment as Record<string, unknown>)[MARKER_FIELD] === marker;
}

/**
 * Ищет среди уже прочитанных строк ту, которую записал ЭТОТ план.
 *
 * Комментарий приходит то разобранным объектом, то сырой JSON-строкой (колонка
 * json, а обёртки у SHM разные), поэтому смотрим оба вида. Находка означает
 * «операция уже выполнена», а не «пропустить и молчать»: решение принимает
 * вызывающий и обязан доложить `already_applied`.
 */
export function findMarkedRow<T>(rows: readonly T[], token: string): T | undefined {
  const marker = makePlanMarker(token);
  return rows.find((row) => carriesMarker(row, marker));
}

export type PaymentOutcome = 'applied' | 'already_applied';

export interface PaymentResultInput {
  /** `id` платежа из ответа `PUT /admin/user/payment`. */
  returnedPayId: number;
  /**
   * Наибольший `id` платежа этого клиента на момент построения плана. Ноль —
   * законное значение: у клиента ещё не было платежей.
   */
  lastPayIdAtPlan: number;
}

/**
 * Отличает дедуп-попадание от нового платежа.
 *
 * `User.pm:1014` возвращает СУЩЕСТВУЮЩИЙ платёж в ответе, неотличимом по форме
 * от свежего: `dataTruthyGuard` видит непустой объект и пропускает, инструмент
 * рапортует `applied`, оператор считает, что прошли обе операции. При ключе от
 * токена плана попадание возможно ровно в одном случае — повторное применение
 * того же плана, и правильный ответ на него `already_applied`.
 *
 * Сравнение идёт по `id`, а не по `date`. `pays_history.date` — datetime с
 * секундной гранулярностью на ЧУЖИХ часах: сравнение «дата старше момента
 * вызова» ошибается при любом расхождении времени между агентом и биллингом.
 * `id` — AUTO_INCREMENT, поэтому новая строка всегда строго больше любой
 * существовавшей, и вердикт точен без часов вовсе.
 *
 * Сумма для этого не годится: SHM возвращает первый платёж целиком, включая его
 * `money`, даже если во втором вызове просили другую сумму (`pay.t:80-89`).
 */
export function classifyPaymentResult(input: PaymentResultInput): PaymentOutcome {
  if (!Number.isSafeInteger(input.returnedPayId) || input.returnedPayId <= 0) {
    throw new Error(
      `не разобрать id платежа из ответа SHM: ${String(input.returnedPayId)}. ` +
        'Без него дедуп-попадание не отличить от нового платежа, а молчаливое «applied» здесь — ' +
        'это отчёт об операции, которой не было.',
    );
  }
  if (!Number.isSafeInteger(input.lastPayIdAtPlan) || input.lastPayIdAtPlan < 0) {
    throw new Error(
      `водяной знак lastPayIdAtPlan должен быть целым неотрицательным, получено ` +
        `${String(input.lastPayIdAtPlan)} (0 = у клиента не было платежей на момент плана)`,
    );
  }
  return input.returnedPayId > input.lastPayIdAtPlan ? 'applied' : 'already_applied';
}
