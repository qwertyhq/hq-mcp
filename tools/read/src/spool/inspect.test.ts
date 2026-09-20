import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { spoolInspect } from './inspect.js';

interface SpoolTask {
  id: number;
  user_id: number;
  user_service_id: number | null;
  scope: 'service' | 'account' | 'job';
  event_kind: string | null;
  event_title: string | null;
  event_name: string | null;
  status: string | null;
  minutes: number | null;
  runs_again: boolean;
}

interface TasksByScope {
  services: SpoolTask[];
  accounts: SpoolTask[];
  jobs: SpoolTask[];
}

interface SpoolOut {
  byStatus: Record<string, number>;
  wholeQueueByStatus?: Record<string, number>;
  stuck: TasksByScope;
  failed: TasksByScope;
  paused: TasksByScope;
  queue: { items: number; limit: number; offset: number };
  history: unknown[];
  historyItems: number;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string }>;
}

const ids = (tasks: SpoolTask[]): number[] => tasks.map((task) => task.id);

/**
 * `now` — дефолт testkit: 12:00 UTC, то есть 15:00 в Москве. Все `created`
 * ниже записаны ровно так, как их пишет SHM: Core::Utils::now — это
 * strftime("%Y-%m-%d %H:%M:%S", localtime) (Utils.pm:133-141), локальное время
 * сервера без офсета и без `Z`, а сервер живёт в Europe/Moscow (TZ в
 * docker-compose.staging.yml:27, docker-compose.test.yml:24,
 * contributing/docker-compose.yml:25, helm/k8s-shm/values.yaml).
 * Статусы — из Core::Const.pm:78-83, других spool не выдаёт вовсе.
 */
const now = new Date('2026-08-08T12:00:00.000Z');

/**
 * Провижининг конкретной услуги: `settings.user_service_id` (USObject.pm:463)
 * — единственное, что делает строку спула задачей КЛИЕНТСКОЙ УСЛУГИ. Все семь
 * базовых строк несут его намеренно: тесты ниже написаны про провижининг, и
 * без этого ключа они проверяли бы совсем другую популяцию очереди.
 */
const provisioning = (id: number, status: string, created: string): Record<string, unknown> => ({
  id,
  status,
  created,
  user_id: 3073,
  event: { kind: 'UserService', name: 'CREATE', title: 'remnawave' },
  settings: { user_service_id: 51 },
});

const NEW_30_MIN = provisioning(1, 'NEW', '2026-08-08 14:30:00');
const NEW_5_MIN = provisioning(2, 'NEW', '2026-08-08 14:55:00');
const DELAYED_300_MIN = provisioning(3, 'DELAYED', '2026-08-08 10:00:00');
const PAUSED_300_MIN = provisioning(4, 'PAUSED', '2026-08-08 10:00:00');
const FAIL_1_MIN = provisioning(5, 'FAIL', '2026-08-08 14:59:00');
const STUCK_240_MIN = provisioning(6, 'STUCK', '2026-08-08 11:00:00');
const SUCCESS_360_MIN = provisioning(7, 'SUCCESS', '2026-08-08 09:00:00');

const tasks = [
  NEW_30_MIN,
  NEW_5_MIN,
  DELAYED_300_MIN,
  PAUSED_300_MIN,
  FAIL_1_MIN,
  STUCK_240_MIN,
  SUCCESS_360_MIN,
];

/**
 * Строки очереди, скопированные из настоящей выдачи как есть.
 *
 * FREEKASSA — три такие задачи стояли STUCK третьи сутки, и инструмент
 * показывал их в `stuck` с `user_service_id: 0`, то есть предлагал искать
 * клиента, которого не существует. HWID_BLOCKER — PAUSED с декабря: контроль
 * лимита устройств выключен, и об этом не говорило ничего.
 */
const FREEKASSA_STUCK = {
  id: 455827,
  status: 'STUCK',
  created: '2026-08-08 10:00:00',
  user_id: 1,
  event: {
    kind: 'Cloud::Jobs',
    method: 'job_download_paystem',
    name: 'SYSTEM',
    title: 'download pay system: freekassa',
  },
  settings: { arch: 'x86_64', ps_name: 'freekassa' },
};

const HWID_BLOCKER_PAUSED = {
  id: 158431,
  status: 'PAUSED',
  created: '2026-08-08 10:00:00',
  user_id: 1,
  event: {
    kind: 'Jobs',
    method: 'job_users',
    name: 'TASK',
    period: 30,
    title: 'hwid check block/unblock',
  },
  settings: { template_id: 'hwid_blocker', user_id: 1 },
};

/**
 * Периодическая задача в покое: DELAYED — это НЕ остановка. Spool.pm:277-285
 * возвращает успешную периодическую задачу в DELAYED вместо удаления, поэтому
 * такая строка живёт годами и поедет снова.
 */
const CLEANUP_DELAYED = {
  id: 158327,
  status: 'DELAYED',
  created: '2026-08-08 10:00:00',
  user_id: 1,
  event: { kind: 'Jobs', method: 'job_cleanup', period: '86400', title: 'cleanup services' },
  settings: null,
};

/**
 * Событие аккаунта: контроллер клиентский (UserService), а услуги за строкой
 * нет вовсе. В работающей очереди такие события составляют заметную долю всех
 * строк — PAYMENT, BONUS, AUTOPAY_*, REGISTERED. Ни «инфраструктура», ни
 * «провижининг»: клиент один, услуг ноль.
 */
const PAYMENT_STUCK = {
  id: 470800,
  status: 'STUCK',
  created: '2026-08-08 10:00:00',
  user_id: 10163,
  event: {
    kind: 'UserService',
    method: 'activate_services',
    name: 'PAYMENT',
    title: 'user payment',
  },
};

/**
 * kind=Jobs И settings.user_service_id одновременно: Jobs.pm:31-44 ставит
 * job_prolongate_event именно так, и в работающей очереди такие строки лежат
 * постоянно, не единичными исключениями.
 * Ровно та строка, на которой классификация «kind=Jobs, значит система»
 * оказалась бы неправдой.
 */
const PROLONGATE_EVENT_STUCK = {
  id: 470801,
  status: 'STUCK',
  created: '2026-08-08 10:00:00',
  user_id: 4238,
  event: {
    kind: 'Jobs',
    method: 'job_prolongate_event',
    name: 'SYSTEM',
    title: 'user service prolongate event',
  },
  settings: { user_service_id: 9001 },
};

// GET /admin/spool/statuses — это SELECT status, COUNT(status) AS cnt ... GROUP BY
// status (Spool.pm:426-435). Ключ называется `status`, поля `name` в ответе нет.
const statuses = [
  { status: 'NEW', cnt: 2 },
  { status: 'STUCK', cnt: 1 },
];

const history = [{ id: 99, spool_id: 1, status: 'SUCCESS' }];

const stand = (rows: unknown[]) => ({
  now,
  shmGet: () => statuses,
  shmList: (path: string) => (path === '/admin/spool' ? rows : history),
});

describe('spool_inspect', () => {
  it('buckets tasks by status and separates stuck from failed', async () => {
    const ctx = makeCtx(stand(tasks));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;

    expect(result.byStatus).toEqual({ NEW: 2, DELAYED: 1, PAUSED: 1, FAIL: 1, STUCK: 1, SUCCESS: 1 });
    // NEW старше порога и STUCK — задачи, которые должны были выполниться и не
    // выполнились. DELAYED отложена по замыслу (Spool.pm:93-97 превращает
    // NEW+delayed в DELAYED и штампует executed=now, поэтому старый created у
    // неё — норма), PAUSED — ручная остановка оператором.
    expect(ids(result.stuck.services)).toEqual([1, 6]);
    expect(result.stuck.services[0]?.minutes).toBe(30);
    expect(result.stuck.services[1]?.minutes).toBe(240);
    // FAIL попадает в находки сразу, без возрастного порога.
    expect(ids(result.failed.services)).toEqual([5]);
    expect(result.failed.services[0]?.minutes).toBe(1);
    // PAUSED — своя находка: не «застряла» и не «провалилась», но и не ждёт.
    expect(ids(result.paused.services)).toEqual([4]);

    // Словарь статусов — это ключи серверной переписи; отдельного поля под него
    // нет намеренно, см. комментарий у wholeQueueByStatus.
    expect(Object.keys(result.wholeQueueByStatus ?? {})).toEqual(['NEW', 'STUCK']);
    expect(result.history).toEqual(history);
    expect(result.historyItems).toBe(1);
    expect(result.queue.items).toBe(7);
    expect(result.warnings.map((w) => w.code)).not.toContain('clock_skew');
  });

  it('reports a STUCK task immediately, without waiting out the age threshold', async () => {
    // Возрастной порог существует для NEW: она ждёт своей очереди и это норма.
    // STUCK воркер пометил сам, и выборка на исполнение исключает его навсегда
    // (Spool.pm:132, -not_in => [TASK_STUCK, TASK_PAUSED]) — задача больше не
    // выполнится никогда, сколько её ни выдерживай. Порог здесь означал бы, что
    // первые пятнадцать минут после терминального провала очередь объявляется
    // здоровой — ровно в то окно, когда клиент пишет «оплатил, конфига нет».
    const ctx = makeCtx(stand([provisioning(9, 'STUCK', '2026-08-08 14:59:00')]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(ids(result.stuck.services)).toEqual([9]);
    expect(result.stuck.services[0]?.minutes).toBe(1);
    // Та же строка отвечает и на «поедет ли она ещё»: STUCK исключён из выборки
    // на исполнение навсегда, ровно как PAUSED (Spool.pm:130-133).
    expect(result.stuck.services[0]?.runs_again).toBe(false);
  });

  it('reads user_service_id out of settings, the only place provisioning writes it', async () => {
    // USObject.pm:463 кладёт id в settings, а не в колонку верхнего уровня, так
    // что чтение одной колонки печатало бы 0 на каждой провижининговой задаче.
    const ctx = makeCtx(
      stand([
        { id: 10, status: 'NEW', created: '2026-08-08 14:00:00', user_id: 3073, settings: { user_service_id: 51 } },
        // settings у SHM приезжает то объектом, то JSON-строкой (kit.ts:81).
        { id: 11, status: 'NEW', created: '2026-08-08 14:00:00', user_id: 3073, settings: '{"user_service_id":52}' },
      ]),
    );
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.stuck.services.map((t) => t.user_service_id)).toEqual([51, 52]);
  });

  it('leaves user_service_id null, not 0, on a task that has no service', async () => {
    // Ноль выглядит идентификатором. Застрявшие системные задачи в работающей
    // очереди отдавались с `user_service_id: 0`, и вопрос «чей провижининг встал»
    // уводил искать клиента, которого нет.
    const ctx = makeCtx(stand([FREEKASSA_STUCK]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.stuck.jobs[0]?.user_service_id).toBeNull();
  });

  it('reports the real queue depth when the window was filled', async () => {
    const ctx = makeCtx({
      now,
      shmGet: () => [],
      shmList: (path, params) =>
        path === '/admin/spool'
          ? { items: 12_000, limit: Number(params?.limit ?? 50), offset: 0, data: tasks }
          : [],
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 4, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.queue.items).toBe(12_000);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  it('warns that manual success must never be used to clear the queue', async () => {
    const ctx = makeCtx(stand(tasks));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    const forbidden = result.warnings.find((w) => w.code === 'manual_success_forbidden');
    expect(forbidden).toBeDefined();
    expect(forbidden?.message).toContain('does not execute the task');
  });

  it('fires the same warning when the only finding is a failed task', async () => {
    const ctx = makeCtx(stand([NEW_5_MIN, FAIL_1_MIN]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.stuck.services).toEqual([]);
    expect(ids(result.failed.services)).toEqual([5]);
    expect(result.warnings.map((w) => w.code)).toContain('manual_success_forbidden');
  });

  it('has no findings and no warning on a healthy queue', async () => {
    // PAUSED здесь больше нет намеренно: остановленная задача — это находка,
    // и её присутствие делало бы «здоровую очередь» неправдой. Что DELAYED и
    // SUCCESS находками не являются, проверяет ровно этот тест.
    const ctx = makeCtx(stand([NEW_5_MIN, DELAYED_300_MIN, SUCCESS_360_MIN, CLEANUP_DELAYED]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.stuck).toEqual({ services: [], accounts: [], jobs: [] });
    expect(result.failed).toEqual({ services: [], accounts: [], jobs: [] });
    expect(result.paused).toEqual({ services: [], accounts: [], jobs: [] });
    expect(result.warnings.map((w) => w.code)).toEqual([]);
  });

  it('honours a stamp that carries its own offset whatever the configured zone is', async () => {
    const ctx = makeCtx({
      ...stand([provisioning(8, 'NEW', '2026-08-08T11:30:00Z')]),
      shmTz: 'Asia/Tokyo',
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.stuck.services.map((t) => t.minutes)).toEqual([30]);
  });

  it('announces a clock skew instead of quietly reporting an empty queue', async () => {
    // Неверный HQ_MCP_SHM_TZ читает московский штамп как UTC: каждая задача
    // «создана» на три часа в будущем, возраст уходит в минус и ни одна не
    // проходит порог. Молчаливый диагностический инструмент хуже сломанного,
    // поэтому расхождение обязано назвать себя и назвать зону.
    const ctx = makeCtx({ ...stand(tasks), shmTz: 'UTC' });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    const skew = result.warnings.find((w) => w.code === 'clock_skew');
    expect(skew).toBeDefined();
    expect(skew?.message).toContain('UTC');
    expect(skew?.message).toContain('HQ_MCP_SHM_TZ');
  });

  it('rejects a status outside the enum instead of answering an empty queue', async () => {
    // Вызывающий, наученный первоначальным брифом, шлёт ERROR или PROCESSING.
    // Свободная строка ушла бы в filter, -like не нашёл бы ничего, и ответ был
    // бы byStatus:{}, stuck:[], failed:[], queue.items:0 БЕЗ единого
    // предупреждения: status_filter_not_applied построен на rows.some(), а на
    // пустом массиве он false. Здоровая с виду пустая диагностика на неверном
    // вводе — ровно тот немой инструмент, против которого написана поправка B.
    // Закрытый enum заодно убирает wildcard-и % и _ из -like.
    for (const bad of ['ERROR', 'PROCESSING', 'FAIL%', '']) {
      expect(() => spoolInspect.input.parse({ status: bad })).toThrow();
    }
    /**
     * SKIPPED и DELETED в этом списке ОБЯЗАТЕЛЬНЫ. Первый спул выдаёт живьём:
     * на боевой 3.1.0 так записана задача 843648 `prolongate services`
     * (обработчик вернул SKIP — «нет задач в данный момент», Jobs.pm:23).
     * Второй объявлен в Core::Const и никем не ставится. Оба отвергались как
     * invalid_input, то есть на настоящем статусе очереди инструмент отвечал
     * упрёком спросившему — при том что описание обещало «весь словарь».
     */
    for (const good of [
      'NEW',
      'SUCCESS',
      'FAIL',
      'DELAYED',
      'STUCK',
      'PAUSED',
      'SKIPPED',
      'DELETED',
    ]) {
      expect(() => spoolInspect.input.parse({ status: good })).not.toThrow();
    }
    expect(spoolInspect.input.parse({})).toEqual({ status: null, limit: 50, stuck_minutes: 15 });
  });

  it('carries the whole-queue census beside the window census', async () => {
    // Spool.pm:426 — это COUNT(status) по всей таблице, без limit и без
    // фильтра инструмента. byStatus считает то, что приехало в окно; спутать
    // их нельзя, поэтому имена разведены.
    const ctx = makeCtx(stand([NEW_5_MIN]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.byStatus).toEqual({ NEW: 1 });
    expect(result.wholeQueueByStatus).toEqual({ NEW: 2, STUCK: 1 });
  });

  it('omits the whole-queue census entirely when that call failed', async () => {
    const ctx = makeCtx({
      now,
      shmGet: () => {
        throw new Error('SHM 500');
      },
      shmList: (path: string) => (path === '/admin/spool' ? [NEW_5_MIN] : history),
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    // Не нули: «в очереди ноль FAIL» и «мы не смогли спросить» — разные ответы.
    expect('wholeQueueByStatus' in result).toBe(false);
  });

  it('narrows by status through filter=, the only parameter SHM honours, and caps the limit', async () => {
    // Обычный query-параметр `status` в WHERE не попадает: Sql::Data::list_for_api
    // собирает where из filter, args.where и ключа таблицы (Data.pm:728-806), а
    // остальные аргументы в _list не уезжают. ?status=FAIL вернул бы всю очередь
    // под видом отфильтрованной.
    const calls: StubCall[] = [];
    const ctx = makeCtx({ ...stand([FAIL_1_MIN]), calls });
    await spoolInspect.handler({ status: 'FAIL', limit: 9999, stuck_minutes: 15 }, ctx);
    const queueCall = calls.find((call) => call.path === '/admin/spool');
    expect(queueCall?.params).toEqual({ filter: '{"status":"FAIL"}', limit: 200 });
  });

  it('says so when the filter did not actually narrow the answer', async () => {
    const ctx = makeCtx(stand(tasks));
    const result = (await spoolInspect.handler(
      { status: 'FAIL', limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.warnings.map((w) => w.code)).toContain('status_filter_not_applied');
  });

  it('keeps a stuck system job out of the provisioning list and names what broke', async () => {
    // Типичная жалоба оператора: «3 stuck» без единого слова о том, что все три —
    // обслуживающие задачи установки. Оператор шёл искать клиентов, которых не
    // существует, а provisioning_diagnose по тому же user_id отвечал `ok` —
    // два инструмента выглядели противоречащими друг другу, будучи оба правы.
    const ctx = makeCtx(stand([FREEKASSA_STUCK, STUCK_240_MIN]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;

    expect(ids(result.stuck.jobs)).toEqual([455827]);
    expect(ids(result.stuck.services)).toEqual([6]);
    expect(result.stuck.accounts).toEqual([]);
    // Название задачи — единственное, из чего видно, ЧТО сломано.
    expect(result.stuck.jobs[0]?.event_title).toBe('download pay system: freekassa');
    expect(result.stuck.jobs[0]?.event_kind).toBe('Cloud::Jobs');
    expect(result.stuck.jobs[0]?.scope).toBe('job');
  });

  it('classifies by the service first and by the controller second, never by kind alone', async () => {
    // Обе строки в работающей очереди лежат постоянно, и каждая ломает свою
    // половину наивного правила: kind=Jobs с user_service_id (Jobs.pm:31-44) —
    // это провижининг услуги, а kind=UserService без него (User.pm:199-206) —
    // событие аккаунта, а не инфраструктура.
    const ctx = makeCtx(stand([PROLONGATE_EVENT_STUCK, PAYMENT_STUCK]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;

    expect(ids(result.stuck.services)).toEqual([470801]);
    expect(result.stuck.services[0]?.event_kind).toBe('Jobs');
    expect(result.stuck.services[0]?.user_service_id).toBe(9001);

    expect(ids(result.stuck.accounts)).toEqual([470800]);
    expect(result.stuck.accounts[0]?.event_kind).toBe('UserService');
    expect(result.stuck.accounts[0]?.user_id).toBe(10163);

    expect(result.stuck.jobs).toEqual([]);
  });

  it('scopes manual_success_forbidden to the rows whose service status it can move', async () => {
    // Spool.pm:352-364 двигает статус услуги ТОЛЬКО внутри
    // `if ( settings.user_service_id && event.name )`. На системной задаче
    // такой ветки нет, то есть названное предупреждением последствие наступить
    // не может — и до этой правки оно всё равно печаталось на каждой находке.
    const ctx = makeCtx(stand([FREEKASSA_STUCK]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;

    expect(result.warnings.map((w) => w.code)).not.toContain('manual_success_forbidden');
    const notMine = result.warnings.find(
      (w) => w.code === 'task_without_service_is_not_provisioning',
    );
    expect(notMine).toBeDefined();
    // Свой вред у ручного SUCCESS здесь есть, и он ДРУГОЙ: строка исчезает.
    expect(notMine?.message).toContain('download pay system: freekassa');
    expect(notMine?.message).toContain('retry');
  });

  it('says a PAUSED job is dead while a DELAYED one beside it is merely scheduled', async () => {
    // Обе строки в выдаче выглядят «не выполняется», а означают
    // противоположное. Без этого различия «hwid check block/unblock» стоит с
    // декабря, контроль лимита устройств выключен, и не говорит об этом ничто.
    const ctx = makeCtx(stand([HWID_BLOCKER_PAUSED, CLEANUP_DELAYED]));
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;

    expect(ids(result.paused.jobs)).toEqual([158431]);
    expect(result.paused.jobs[0]?.runs_again).toBe(false);
    expect(result.paused.jobs[0]?.event_title).toBe('hwid check block/unblock');
    // DELAYED находкой не является и поедет снова — это и есть разница.
    expect(result.stuck.jobs).toEqual([]);
    expect(result.failed.jobs).toEqual([]);

    const paused = result.warnings.find((w) => w.code === 'spool_task_paused');
    expect(paused).toBeDefined();
    expect(paused?.message).toContain('hwid check block/unblock');
    expect(paused?.message).toContain('never run again');
    // Застрявшего здесь нет: остановка не должна выдаваться за провал.
    expect(result.warnings.map((w) => w.code)).not.toContain(
      'task_without_service_is_not_provisioning',
    );
  });

  it('degrades one call at a time instead of losing the whole answer', async () => {
    const ctx = makeCtx({
      now,
      shmGet: () => {
        throw new Error('SHM 500');
      },
      shmList: (path) => (path === '/admin/spool' ? tasks : history),
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect('wholeQueueByStatus' in result).toBe(false);
    expect(result.degraded).toEqual([{ system: 'shm', error: 'SHM 500' }]);
    expect(ids(result.stuck.services)).toEqual([1, 6]);
    // Молчаливый частичный ответ — та же болезнь, что чинили в client_overview
    // и billing_ledger: degraded в теле есть, а в warnings на него никто не
    // показывает, и «статусов нет» читается как факт об очереди.
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });
});

/**
 * Строка истории — это ещё и ЗАПИСЬ ОТПРАВКИ, и раньше инструмент
 * отдавал её целиком. Прогон против работающей системы показал в ответе
 * `api.telegram.org`, путь `/bot<цифры>:<токен>`, `chat_id` и внутренний хост
 * 10.x: редакция @hq/redact их не видит, потому что маскирует по ИМЕНИ поля, а
 * тут секрет лежит внутри ЗНАЧЕНИЯ.
 */
describe('spool_inspect does not carry the delivery request out with the history', () => {
  const LEAKY = {
    id: 810601,
    spool_id: 470410,
    status: 'SUCCESS',
    executed: '2026-08-08 09:10:01',
    event: { name: 'PAYMENT', title: 'TGPay' },
    response: {
      delivered: true,
      delivery: { code: '200', status: 'DELIVERED', template_id: 'tg_pay_admin' },
      message: 'successful',
      request: {
        content: '{"chat_id":-1000000000001,"text":"Списано 300 ₽"}',
        headers: null,
        url: 'https://api.telegram.org/bot1111111111:AAref-not-a-real-token/sendMessage',
      },
      response: { ok: true, result: { chat: { id: -1000000000001, title: 'notifications-channel' } } },
      server: { host: '192.0.2.10', id: 18, port: '22' },
      spool: { duration: 0.09806 },
      status: { code: '200', line: '200 OK' },
    },
  };

  it('strips the request, the remote echo and the server address, and keeps the verdict', async () => {
    const ctx = makeCtx({
      shmList: (path: string) => (path === '/admin/spool' ? [] : [LEAKY]),
      shmGet: () => [],
      now,
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('api.telegram.org');
    expect(serialized).not.toContain('AAref-not-a-real-token');
    expect(serialized).not.toContain('chat_id');
    expect(serialized).not.toContain('notifications-channel');
    expect(serialized).not.toContain('192.0.2.10');
    // Полезное на месте: строка истории по-прежнему отвечает на «что случилось».
    expect(serialized).toContain('DELIVERED');
    expect(serialized).toContain('tg_pay_admin');
    expect(serialized).toContain('0.09806');
  });

  it('leaves a history row without a response block untouched', async () => {
    const plain = { id: 5, spool_id: 1, status: 'SUCCESS' };
    const ctx = makeCtx({
      shmList: (path: string) => (path === '/admin/spool' ? [] : [plain]),
      shmGet: () => [],
      now,
    });
    const result = (await spoolInspect.handler(
      { status: null, limit: 50, stuck_minutes: 15 },
      ctx,
    )) as SpoolOut;
    expect(result.history).toEqual([plain]);
  });
});
