import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  SPOOL_FAILED_STATUS,
  SPOOL_PAUSED_STATUS,
  SPOOL_STATUSES,
  SPOOL_STUCK_STATUS,
  SPOOL_STUCK_STATUSES,
  asArray,
  asRecord,
  capLimit,
  listOut,
  minutesSince,
  num,
  parseSettings,
  settle,
  spoolStatusName,
  spoolUserServiceId,
  str,
  take,
  warn,
  withoutSpoolSecrets,
} from '../kit.js';

const MAX_LIMIT = 200;

/** Ниже этого возраста в минусе расхождение уже нельзя списать на дрожь часов. */
const SKEW_TOLERANCE_MINUTES = 2;

/**
 * Контроллеры обслуживающих задач. `event.kind` — это ИМЯ СЕРВИСА, которому
 * воркер отдаёт задачу на исполнение: Task.pm:46-48 делает
 * `get_service( $self->event->{kind} )` и зовёт на нём `event.method`.
 * Core::Jobs и Cloud::Jobs — обслуживание самой установки (job_cleanup,
 * job_make_forecasts, job_prolongate, job_download_paystem), а не провижининг
 * чьей-то услуги.
 *
 * Список закрытый и короткий намеренно: всё остальное, что приезжает в kind
 * (UserService, Transport::*), — контроллеры, работающие по клиенту.
 */
const JOB_KINDS: readonly string[] = ['Jobs', 'Cloud::Jobs'];

/**
 * Два статуса, при которых строка в очереди ЕСТЬ, а поедет она никогда:
 * выборка на исполнение исключает их обоих (Spool.pm:130-133,
 * `status => { -not_in => [ TASK_STUCK, TASK_PAUSED ] }`). Собирается из
 * констант kit, а не пишется литералами: пара уже описана там одним
 * докстрингом, и вторая копия — это то, как один инструмент начинает считать
 * PAUSED ожиданием.
 */
const NEVER_RUNS_AGAIN: readonly string[] = [SPOOL_STUCK_STATUS, SPOOL_PAUSED_STATUS];

/**
 * Кому принадлежит задача — и, значит, что означает её поломка.
 *
 * `service` — привязана к КОНКРЕТНОЙ услуге через `settings.user_service_id`
 *   (USObject.pm:463). Это и есть провижининг: застряла — у клиента нет
 *   рабочего конфига. Ровно по этому ключу задачи ищет и сам SHM
 *   (USObject.pm:558 → list_by_settings), и по нему же их читает
 *   provisioning_diagnose.
 * `account` — услуги нет, контроллер клиентский (UserService и прочие):
 *   активация услуг после платежа, уведомления, автоплатёжные события. Бьёт по
 *   ОДНОМУ клиенту, но ни одной услуги за собой не тянет.
 * `job` — услуги нет, контроллер из JOB_KINDS: обслуживание установки.
 *
 * Порядок проверок обязателен, и это не вкусовщина: kind сам по себе НЕ
 * разделяет популяции. Jobs.pm:31-44 ставит `job_prolongate_event` с
 * `kind => 'Jobs'` И `settings.user_service_id` — в настоящей истории такие
 * строки встречаются, и по одному kind они уехали бы в «инфраструктуру», хотя
 * трогают конкретную услугу (Jobs.pm:50-65 её лочит и touch'ит). Обратное
 * тоже верно: `kind=UserService` без user_service_id — это заметная часть
 * очереди (PAYMENT, BONUS, AUTOPAY_*, REGISTERED), и по одному отсутствию
 * user_service_id они уехали бы в «системные задачи», хотя за каждой стоит
 * конкретный клиент.
 */
export type SpoolScope = 'service' | 'account' | 'job';

interface SpoolTask {
  id: number;
  user_id: number;
  /**
   * `null`, а не `0`: ноль выглядит идентификатором, и «user_service_id: 0»
   * заставляет искать услугу, которой не существует. Это и была настоящая
   * жалоба: три застрявшие системные задачи с нулём в этом поле.
   */
  user_service_id: number | null;
  scope: SpoolScope;
  /** Контроллер-исполнитель; см. JOB_KINDS. */
  event_kind: string | null;
  /**
   * Человеческое имя задачи — «download pay system: freekassa», «hwid check
   * block/unblock». Единственное поле, из которого видно, ЧТО именно сломано:
   * по одному id задачи это не восстанавливается ничем.
   */
  event_title: string | null;
  /** CREATE / BLOCK / PAYMENT / SYSTEM / TASK — какое событие породило строку. */
  event_name: string | null;
  status: string | null;
  minutes: number | null;
  /**
   * Возьмёт ли воркер эту строку когда-нибудь снова — по его собственному
   * правилу отбора и только по нему (Spool.pm:130-133). Существует ради пары
   * PAUSED/DELAYED: в выдаче они выглядят одинаково («не выполняется»), а
   * означают противоположное — DELAYED это штатный покой периодической задачи
   * между запусками (Spool.pm:93-97, 277-285), PAUSED — остановка навсегда.
   */
  runs_again: boolean;
}

/** Три популяции очереди раздельно; см. SpoolScope. */
interface TasksByScope {
  services: SpoolTask[];
  accounts: SpoolTask[];
  jobs: SpoolTask[];
}

function byScope(tasks: SpoolTask[]): TasksByScope {
  return {
    services: tasks.filter((task) => task.scope === 'service'),
    accounts: tasks.filter((task) => task.scope === 'account'),
    jobs: tasks.filter((task) => task.scope === 'job'),
  };
}

/** «455827 "download pay system: freekassa"» — id без названия бесполезен. */
function titled(tasks: SpoolTask[]): string {
  return tasks
    .map((task) => `${String(task.id)}${task.event_title === null ? '' : ` "${task.event_title}"`}`)
    .join(', ');
}

export const spoolInspect = defineTool({
  name: 'spool_inspect',
  description:
    'Provisioning queue: task counts per status, the tasks that are stuck (NEW past the age ' +
    'threshold, or STUCK), the failed ones (FAIL, reported at any age), the paused ones and the ' +
    'recent history. Use it when a service is ACTIVE in billing but the client has no working ' +
    'config. `stuck`, `failed` and `paused` are each split by what the row belongs to, because ' +
    'the three populations need different reactions: `services` are one client\'s provisioning ' +
    '(the task carries settings.user_service_id), `accounts` are events on an account with no ' +
    'service attached, and `jobs` are the installation\'s own maintenance (event.kind Jobs / ' +
    'Cloud::Jobs) — a stuck job is an infrastructure problem and belongs to no client at all. ' +
    '`event_title` names the work each row does. `runs_again: false` marks the rows the worker ' +
    'will never pick up again: STUCK and PAUSED, where PAUSED looks like DELAYED and means the ' +
    'opposite. `byStatus` counts the rows in this window; `wholeQueueByStatus` is the ' +
    'server-side count over the entire table and ignores both the window and the status filter.',
  input: z.object({
    // Закрытый список, а не свободная строка. Значение уезжает в
    // filter={"status":...}, где -like на неизвестном статусе просто не находит
    // ничего: ответ был бы пустым и здоровым на вид, а status_filter_not_applied
    // на пустом массиве не срабатывает (rows.some === false). Enum заодно
    // исключает wildcard-ы % и _ из -like.
    status: z
      .enum(SPOOL_STATUSES)
      .nullable()
      .default(null)
      .describe('Filter by spool status; these six are the entire vocabulary SHM emits'),
    limit: z.number().int().default(50).describe('Rows, capped at 200'),
    stuck_minutes: z
      .number()
      .int()
      .positive()
      .default(15)
      .describe('A NEW task older than this is reported as stuck'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ status, limit, stuck_minutes }, ctx) => {
    const cap = capLimit(limit, 50, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const now = ctx.now();

    const [queue, statuses, history] = await Promise.all([
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/spool', {
          // Единственный работающий способ сузить выборку: обычный query-параметр
          // `status` до WHERE не доезжает вовсе — Sql::Data::list_for_api строит
          // where только из filter, args.where и ключа таблицы (Data.pm:728-806),
          // а всё остальное в _list не попадает. То есть ?status=FAIL вернул бы
          // ВСЮ очередь под видом отфильтрованной.
          ...(status === null ? {} : { filter: JSON.stringify({ status }) }),
          limit: cap,
        }),
      ),
      settle(ctx.shm.get<unknown>('/admin/spool/statuses')),
      settle(ctx.shm.list<Record<string, unknown>>('/admin/spool/history', { limit: cap })),
    ]);

    // items наружу (§6.4): «в очереди 50 задач» и «мы посмотрели первые 50 из
    // 12 000» — принципиально разные ответы на «почему провижининг встал».
    const queueList = listOut(take(queue, 'shm', degraded, EMPTY_LIST), warnings, 'spool queue');
    const historyList = listOut(
      take(history, 'shm', degraded, EMPTY_LIST),
      warnings,
      'spool history',
    );
    const rows = queueList.data;
    // Разворачивается ЗДЕСЬ, а не в возвращаемом литерале: take() наполняет
    // degraded, а проверка partial_result идёт ниже — отложенный take не попал
    // бы в неё, и ответ оказался бы частичным без единого слова об этом.
    const statusRows = asArray(take(statuses, 'shm', degraded, []));
    // COUNT(status) по ВСЕЙ таблице (Spool.pm:426): единственное число в ответе,
    // не зависящее ни от окна, ни от фильтра. При отказе ручки поле не
    // появляется вовсе — нули читались бы как «в очереди пусто».
    const wholeQueueByStatus: Record<string, number> = {};
    for (const row of statusRows) {
      const name = spoolStatusName(row);
      // Ключ ставится только когда cnt действительно пришёл числом. Иначе
      // получилось бы {FAIL: 0} — то самое «в очереди ноль FAIL» вместо
      // «спросить не удалось», которое поле целиком и убирает при отказе ручки.
      const raw = asRecord(row).cnt;
      const count = typeof raw === 'number' ? raw : Number(raw);
      if (name !== null && Number.isFinite(count)) wholeQueueByStatus[name] = count;
    }

    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      const key = str(row.status) ?? 'UNKNOWN';
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }

    const tasks: SpoolTask[] = rows.map((row) => {
      // Через общий помощник: колонка spool.user_service_id провижинингом НЕ
      // заполняется (USObject.pm:463 кладёт id в settings), и правило чтения
      // обязано жить в одном месте — его же читает provisioning_diagnose.
      const usi = spoolUserServiceId(row);
      // `event` приезжает то объектом, то JSON-строкой — как и `settings`.
      const event = parseSettings(row.event);
      const kind = str(event.kind);
      const state = (str(row.status) ?? '').toUpperCase();
      return {
        id: num(row.id),
        user_id: num(row.user_id, 0),
        user_service_id: usi,
        scope: usi !== null ? 'service' : kind !== null && JOB_KINDS.includes(kind) ? 'job' : 'account',
        event_kind: kind,
        event_title: str(event.title),
        event_name: str(event.name),
        status: str(row.status),
        // `created` — единственная колонка со временем постановки задачи
        // (app/sql/shm/shm_structure.sql:174-188); `executed` означает другое.
        minutes: minutesSince(now, row.created, ctx.shmTz),
        runs_again: !NEVER_RUNS_AGAIN.includes(state),
      };
    });
    const stateOf = (task: SpoolTask): string => (task.status ?? '').toUpperCase();

    // Порог возраста — только для NEW. STUCK воркер уже пометил сам, и выборка
    // на исполнение исключает его навсегда (Spool.pm:132, `-not_in => [TASK_STUCK,
    // TASK_PAUSED]`), так что ждать пятнадцать минут значит объявлять очередь
    // здоровой в первые пятнадцать минут после терминального провала. Ровно то
    // же правило записано в докстринге SPOOL_STUCK_STATUSES.
    const stuckTasks = tasks.filter((task) => {
      const state = stateOf(task);
      if (state === SPOOL_STUCK_STATUS) return true;
      if (!SPOOL_STUCK_STATUSES.includes(state)) return false;
      return task.minutes !== null && task.minutes >= stuck_minutes;
    });
    // FAIL — находка в момент появления: ждать порога, чтобы упомянуть уже
    // провалившийся провижининг, не помогает никому.
    const failedTasks = tasks.filter((task) => stateOf(task) === SPOOL_FAILED_STATUS);
    // PAUSED в находки по возрасту не попадает и попасть не может: возраст к
    // ней неприменим вовсе. Раньше её не было в ответе НИГДЕ, кроме
    // счётчика byStatus, — на работающей очереди это означало три остановленные
    // навсегда задачи (в том числе «hwid check block/unblock», то есть
    // выключенный контроль лимита устройств), о которых инструмент молчал.
    const pausedTasks = tasks.filter((task) => stateOf(task) === SPOOL_PAUSED_STATUS);

    const stuck = byScope(stuckTasks);
    const failed = byScope(failedTasks);
    const paused = byScope(pausedTasks);
    // Находки, за которыми не стоит ни одной услуги: обслуживание установки и
    // события аккаунта. Разбираются они одинаково — см. предупреждение ниже.
    const serviceless = [...stuck.jobs, ...stuck.accounts, ...failed.jobs, ...failed.accounts];

    const future = tasks.filter(
      (task) => task.minutes !== null && task.minutes < -SKEW_TOLERANCE_MINUTES,
    );
    if (future.length > 0) {
      const ahead = Math.abs(Math.min(...future.map((task) => task.minutes ?? 0)));
      warnings.push(
        warn(
          'clock_skew',
          `Task timestamps read up to ${String(ahead)} minutes in the future in zone ` +
            `"${ctx.shmTz}". SHM writes dates as the server's local time with no offset, so this ` +
            'means HQ_MCP_SHM_TZ does not match the timezone the SHM container runs in. The ' +
            'stuck list cannot be trusted until that is corrected: every fresh task looks ' +
            'future-dated and silently drops out of the age filter.',
        ),
      );
    }

    // Сравнение с приведением регистра — на стороне строк: enum уже гарантирует
    // канонический ввод, а вот чужой статус в ответе (иной регистр из другой
    // сборки SHM) не должен выдаваться за неработающий фильтр.
    if (status !== null && rows.some((row) => (str(row.status) ?? '').toUpperCase() !== status)) {
      warnings.push(
        warn(
          'status_filter_not_applied',
          `The answer contains statuses other than "${status}", so the server-side filter did ` +
            'not narrow it. Treat these rows as the whole queue, not as the requested status.',
        ),
      );
    }

    // ГРАНИЦА ЭТОГО ПРЕДУПРЕЖДЕНИЯ — НЕ КОСМЕТИКА. Вред, который оно называет
    // («штампует SUCCESS и двигает статус услуги»), в Spool.pm:352-364 прямо
    // обусловлен наличием услуги: api_success двигает статус ТОЛЬКО внутри
    // `if ( $args{settings}->{user_service_id} && $args{event}->{name} )`. На
    // строке без user_service_id этой ветки не существует, то есть на тех самых
    // трёх застрявших системных задачах предупреждение описывало последствие,
    // наступить которое не может. Отсюда и жалоба: оно срабатывало всегда,
    // когда что-то застряло, и приучало читать себя как шум. Своя опасность у
    // строк без услуги есть — она в следующем предупреждении, и она другая.
    if (stuck.services.length > 0 || failed.services.length > 0) {
      warnings.push(
        warn(
          'manual_success_forbidden',
          'There are stuck or failed tasks attached to a service. Do not clear them by marking a ' +
            'task successful: that route does not execute the task, it only stamps SUCCESS and ' +
            'moves the service status, leaving the service ACTIVE in billing with no user in the ' +
            'panel. Use provisioning_repair (retry/resume) instead.',
        ),
      );
    }

    if (serviceless.length > 0) {
      warnings.push(
        warn(
          'task_without_service_is_not_provisioning',
          `Queue findings that carry no user_service_id: ${titled(serviceless)}. None of them is ` +
            "any client's provisioning, and provisioning_diagnose is right to answer `ok` for " +
            'the user they are filed under while they sit here — nothing about them attaches to ' +
            'a service. Rows with `scope: "job"` are the installation\'s own maintenance ' +
            '(event.kind Jobs / Cloud::Jobs, run by Task.pm:46-48): a stuck one is an ' +
            'infrastructure failure, and `event_title` says which piece of work stopped. Rows ' +
            'with `scope: "account"` act on the account itself — activation after a payment, ' +
            'notifications — so one client is affected and no service is. The repair for both is ' +
            'retry: api_retry puts the row back to NEW with delayed=0 (Spool.pm:377-384). ' +
            'Marking one successful by hand is not the trap described in ' +
            'manual_success_forbidden — there is no service status to move — but it is not ' +
            'harmless either: finish_task deletes a non-periodic row outright and re-arms a ' +
            'periodic one as DELAYED (Spool.pm:262-285), so the work is dropped and the queue ' +
            'looks clean.',
        ),
      );
    }

    if (pausedTasks.length > 0) {
      warnings.push(
        warn(
          'spool_task_paused',
          `PAUSED in the queue: ${titled(pausedTasks)}. PAUSED is not a slow DELAYED, it is the ` +
            'opposite of it: the worker excludes PAUSED from its execution query permanently ' +
            '(Spool.pm:130-133, the same clause that excludes STUCK), so these rows will never ' +
            'run again on their own, no matter how long anyone waits — that is what ' +
            '`runs_again: false` means on them. DELAYED rows in the same queue are the normal ' +
            'resting state of a periodic task between runs (Spool.pm:93-97, 277-285) and will ' +
            'run. A paused row is therefore a feature switched off silently: whatever its ' +
            '`event_title` names — device-limit enforcement, notifications, a report — has not ' +
            'happened since `executed` and will not happen. Resume it (api_resume is api_retry: ' +
            'status back to NEW, delayed=0, Spool.pm:375-384); queueing the same work afresh ' +
            'leaves the paused row behind it.',
        ),
      );
    }

    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the calls did not answer (see `degraded`); the part it owns — the queue, the ' +
            'status list or the history — is empty rather than wrong. An empty stuck list here ' +
            'is not evidence that the queue is healthy.',
        ),
      );
    }

    return {
      byStatus,
      ...(statuses.ok ? { wholeQueueByStatus } : {}),
      stuck,
      failed,
      paused,
      queue: { items: queueList.items, limit: queueList.limit, offset: queueList.offset },
      history: historyList.data.map(withoutSpoolSecrets),
      historyItems: historyList.items,
      warnings,
      degraded,
    };
  },
});
