import { beforeEach, describe, expect, it } from 'vitest';
import type { MakeCtxOptions, StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { resetPanelNamingCache } from '../kit.js';
import { provisioningDiagnose } from './diagnose.js';

interface SpoolLine {
  id: number;
  status: string | null;
  minutes: number | null;
  event: string | null;
  periodic: boolean;
}

interface ServiceDiagnosis {
  user_service_id: number;
  service_id: number;
  status: string | null;
  verdict: string;
  storage: { name: string; present: boolean; checked: boolean };
  panel: { username: string | null; id: number | null; found: boolean; checked: boolean };
  spool: {
    total: number;
    stuck: number;
    failed: number;
    pending: number;
    paused: number;
    succeeded: number;
    tasks: SpoolLine[];
  };
  history: { total: number; success: number; tasks: SpoolLine[] };
}

interface DiagnoseOut {
  verdict: string;
  services: { items: number; limit: number; offset: number; diagnosed: ServiceDiagnosis[] };
  spool: { items: number; limit: number; offset: number };
  history: { items: number; limit: number; offset: number };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * `now` — дефолт testkit: 12:00 UTC, то есть 15:00 в Москве. Все `created`
 * записаны ровно так, как их пишет SHM: Core::Utils::now — это
 * strftime("%Y-%m-%d %H:%M:%S", localtime) (Utils.pm:133-141), локальное время
 * сервера без офсета и без `Z`, а сервер живёт в Europe/Moscow.
 */
const now = new Date('2026-08-08T12:00:00.000Z');

const ACTIVE_51 = {
  user_service_id: 51,
  service_id: 21,
  name: 'HQ VPN',
  status: 'ACTIVE',
  expire: '2026-09-01 00:00:00',
};
const ACTIVE_52 = {
  user_service_id: 52,
  service_id: 21,
  name: 'HQ VPN',
  status: 'ACTIVE',
  expire: '2026-09-01 00:00:00',
};
const PROGRESS_52 = {
  user_service_id: 52,
  service_id: 21,
  name: 'HQ VPN',
  status: 'PROGRESS',
  expire: null,
};
const UNPAID_53 = {
  user_service_id: 53,
  service_id: 21,
  name: 'HQ VPN',
  status: 'NOT PAID',
  expire: null,
};

/**
 * Задача провижининга. Колонка `spool.user_service_id` существует
 * (shm_structure.sql:176), но её никто не заполняет: USObject::
 * make_commands_by_event кладёт id услуги в settings (USObject.pm:463), а
 * Core::Base::_add_or_set (Base.pm:332-374) ключи settings в колонки не
 * переносит. Ровно поэтому /admin/user/service/spool ищет задачи через
 * list_by_settings, то есть по `settings.user_service_id` (USObject.pm:558,
 * Base.pm:497). Фикстура повторяет это: колонка NULL, id — в settings.
 */
const task = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 900,
  user_id: 3073,
  user_service_id: null,
  status: 'NEW',
  created: '2026-08-08 14:55:00',
  event: { name: 'CREATE', title: 'create user' },
  settings: { user_service_id: 51 },
  ...over,
});

const SUB_TAIL = 'aBcDeFgHiJkLmNoP';

/**
 * Снапшот, который remnawave.tpl кладёт в storage: это НЕразвёрнутый ответ
 * панели (`{response: {...}}`) плюс дописанные конфиги (remnawave.tpl:295-322,
 * :455-473). Ключ — `vpn_mrzb_<us.id>`, то есть user_service_id.
 */
const snapshot = (usi: number, username = `HQVPN_${String(usi)}`): Record<string, unknown> => ({
  response: {
    // Real snapshots carry BOTH: `id` (what 3.x addresses users by)
    // and a legacy `uuid` left over from when the snapshot was written. The
    // uuid is dead weight — /api/users/{uuid} answers 400 on 3.x — so the id
    // is the one that must be used.
    id: 9000 + usi,
    uuid: `u-${String(usi)}`,
    username,
    status: 'ACTIVE',
    subscriptionUrl: `https://sub.example.com/${SUB_TAIL}`,
  },
  configs: ['vless://secret-config@node:443'],
  subscription_url: `https://sub.example.com/${SUB_TAIL}`,
});

const panelUser = (usi: number, username = `HQVPN_${String(usi)}`): Record<string, unknown> => ({
  id: 9000 + usi,
  username,
  status: 'ACTIVE',
});

interface Stand {
  services?: unknown;
  queue?: unknown[];
  history?: unknown[];
  /** Ключ хранилища → тело. Отсутствующий ключ = 200 + пустое тело (§6.18). */
  storage?: Record<string, unknown>;
  /** Путь панели → тело. Отсутствующий путь = 404, который клиент отдаёт как null (§6.16). */
  panel?: Record<string, unknown>;
}

const stand = (spec: Stand, extra: MakeCtxOptions = {}) =>
  makeCtx({
    now,
    shmList: (path) => {
      if (path === '/admin/user/service') return spec.services ?? [];
      if (path === '/admin/spool') return spec.queue ?? [];
      if (path === '/admin/spool/history') return spec.history ?? [];
      throw new Error(`unexpected shm list ${path}`);
    },
    shmGet: (path) => (spec.storage ?? {})[path],
    remnaGet: (path) => (spec.panel ?? {})[path] ?? null,
    ...extra,
  });

type Input = { shm_user_id: number; user_service_id: number | null; stuck_minutes: number };

const input = (over: Partial<Input> = {}): Input => ({
  shm_user_id: 3073,
  user_service_id: null,
  stuck_minutes: 15,
  ...over,
});

const HEALTHY: Stand = {
  services: [ACTIVE_51],
  queue: [],
  history: [
    {
      id: 1,
      spool_id: 900,
      user_id: 3073,
      status: 'SUCCESS',
      created: '2026-08-08 14:00:00',
      event: { name: 'CREATE' },
      settings: { user_service_id: 51 },
    },
  ],
  storage: { '/admin/storage/manage/vpn_mrzb_51': snapshot(51) },
  panel: { '/api/users/9051': panelUser(51) },
};

describe('provisioning_diagnose', () => {
  // Именование кэшируется на процесс (пять минут, как результат
  // platform_probe): без сброса первый тест файла решал бы, чем ищут все
  // остальные, и порядок тестов становился бы частью условия.
  beforeEach(() => {
    resetPanelNamingCache();
  });

  it('keys the snapshot by user_service_id and sends the required user_id', async () => {
    // D1: vpn_mrzb_* именуется по user_service_id (remnawave.tpl:114 + записи
    // :310/:319/:472/:661 через {{ us.id }}, traffic_reset.tpl:153). Ключ по
    // user_id не существует никогда — вердикт «снапшота нет» был бы вечным.
    // D2: GET /admin/storage/manage/* объявлен с required => ['user_id']
    // (v1.cgi:1109-1116); без него диспетчер отвечает 400 ещё до контроллера
    // (v1.cgi:1692-1698), то есть каждый вызов уходил бы в degraded.
    const calls: StubCall[] = [];
    await provisioningDiagnose.handler(input(), stand(HEALTHY, { calls }));

    const read = calls.find((call) => call.path.startsWith('/admin/storage/manage/'));
    expect(read?.path).toBe('/admin/storage/manage/vpn_mrzb_51');
    expect(read?.params).toEqual({ user_id: 3073 });
    expect(calls.some((call) => call.path.includes('vpn_mrzb_3073'))).toBe(false);
  });

  it('says ok when the queue is empty because the successful task was deleted', async () => {
    // D4: Spool::finish_task на успехе непериодической задачи вызывает delete
    // (Spool.pm:263-285) — строка остаётся только в spool_history. Пустая
    // очередь у здорового клиента это НОРМА, а не «задачу никто не ставил».
    const result = (await provisioningDiagnose.handler(input(), stand(HEALTHY))) as DiagnoseOut;

    expect(result.verdict).toBe('ok');
    const service = result.services.diagnosed[0];
    expect(service?.user_service_id).toBe(51);
    expect(service?.verdict).toBe('ok');
    expect(service?.storage).toEqual({ name: 'vpn_mrzb_51', present: true, checked: true });
    expect(service?.panel).toEqual({
      username: 'HQVPN_51',
      id: 9051,
      found: true,
      checked: true,
    });
    expect(service?.history.success).toBe(1);
    expect(result.warnings.map((w) => w.code)).not.toContain('possible_fake_success');
  });

  it('never echoes the storage snapshot body', async () => {
    // §7.2 таблицы классов данных: содержимое vpn_mrzb_* приравнено к ссылке
    // подписки — для бота запрет, для человека маскирование. Инструменту нужен
    // только факт наличия ключа и id, а не готовые конфиги.
    const result = await provisioningDiagnose.handler(input(), stand(HEALTHY));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SUB_TAIL);
    expect(serialized).not.toContain('vless://');
  });

  it('treats an empty storage answer as a missing key, not as an error', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        storage: {},
        panel: { '/api/users/by-username/HQVPN_51': panelUser(51) },
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('storage_missing');
    expect(result.services.diagnosed[0]?.storage.present).toBe(false);
    expect(result.services.diagnosed[0]?.panel.found).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('storage_empty_is_not_404');
  });

  it('finds a panel user that still carries the older username prefix', async () => {
    // Прод несёт оба префикса: remnawave.tpl:148 ставит HQVPN_, а исторические
    // услуги живут под remnawave_ (wbap vpnCategories.ts:19 — дефолт
    // 'remnawave_,HQVPN_'). Один зашитый префикс объявил бы половину живых
    // услуг «в панели пользователя нет».
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        storage: {},
        panel: { '/api/users/by-username/remnawave_51': panelUser(51, 'remnawave_51') },
      }),
    )) as DiagnoseOut;

    expect(result.services.diagnosed[0]?.panel).toEqual({
      username: 'remnawave_51',
      id: 9051,
      found: true,
      checked: true,
    });
    expect(result.verdict).toBe('storage_missing');
  });

  it('names a hand-stamped success instead of blaming an empty queue', async () => {
    // §6.10 / D4: manual/success не выполняет задачу — ставит SUCCESS и двигает
    // статус услуги. Итог: услуга ACTIVE, история со SUCCESS, задачи нет,
    // пользователя в панели нет. Ровно то, ради чего инструмент существует.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({ ...HEALTHY, storage: {}, panel: {} }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('fake_success');
    expect(result.warnings.map((w) => w.code)).toContain('possible_fake_success');
  });

  it('reports no_spool_task only when both the queue and the history are empty', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({ services: [ACTIVE_51], queue: [], history: [], storage: {}, panel: {} }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('no_spool_task');
    expect(result.warnings.map((w) => w.code)).not.toContain('possible_fake_success');
  });

  it('does not call recorded failed attempts "nothing was ever queued"', async () => {
    // D4 требует, чтобы ПУСТЫ были обе — очередь и история. Ветка на
    // `historySuccess > 0` вместо «история пуста» отправляла оператора ставить
    // задачу заново ровно тому клиенту, которому провижининг УЖЕ пытались
    // сделать и записали, почему не смогли.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51],
        queue: [],
        history: [
          {
            id: 7,
            spool_id: 900,
            user_id: 3073,
            status: 'STUCK',
            created: '2026-08-08 14:00:00',
            event: { name: 'CREATE' },
            settings: { user_service_id: 51 },
            response: { error: 'Server not exists: 12' },
          },
        ],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('provisioning_never_succeeded');
    expect(result.services.diagnosed[0]?.history.total).toBe(1);
    expect(result.services.diagnosed[0]?.history.success).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('attempts_recorded_none_succeeded');
    expect(result.warnings.map((w) => w.code)).not.toContain('possible_fake_success');
  });

  it('consults the history before calling a PROGRESS service unqueued', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [],
        history: [
          {
            id: 8,
            spool_id: 901,
            user_id: 3073,
            status: 'FAIL',
            created: '2026-08-08 14:00:00',
            event: { name: 'CREATE' },
            settings: { user_service_id: 52 },
          },
        ],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('provisioning_never_succeeded');
  });

  it('does not read a re-armed periodic task as provisioning in flight', async () => {
    // Structural guard, unreachable in today's config and deliberately kept.
    // Дамп работающей SHM показывает: ни одна строка events не несёт
    // `period`, а все периодические задачи спула — глобальные kind=Jobs без
    // settings.user_service_id, то есть ни к одной услуге не привязаны. Но
    // events — таблица КОНФИГУРАЦИИ: добавленный оператором `period` включает
    // это состояние, не меняя ни строки кода. finish_task тогда не удаляет
    // успешную задачу, а возвращает её в DELAYED с delayed=event.period
    // (Spool.pm:274-285), `created` остаётся датой первой постановки — и
    // засчитанная в pending она давала бы «идёт провижининг» ВЕЧНО на услуге,
    // где провижининга нет вовсе.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51],
        queue: [
          task({
            id: 911,
            status: 'DELAYED',
            created: '2026-08-08 10:00:00',
            // Прод несёт и строку ("600"), и число (36000); is_periodic
            // (Spool.pm:289-291) читает одинаково.
            event: { name: 'PROLONGATE', period: '3600' },
          }),
        ],
        history: [],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.services.diagnosed[0]?.spool.tasks[0]?.periodic).toBe(true);
    expect(result.services.diagnosed[0]?.spool.pending).toBe(0);
    expect(result.verdict).not.toBe('provisioning_in_progress');

    // Молча переклассифицировать нельзя: следующий читатель обязан понять,
    // какая ветка сработала и почему возраст задачи ничего не значит.
    const said = result.warnings.find((w) => w.code === 'periodic_task_not_progress');
    expect(said?.message).toContain('911');
    expect(said?.message).toContain('period');
  });

  it('does not read a periodic task as work in flight on a PROGRESS service either', async () => {
    // Ветка PROGRESS решала по `ev.total > 0` — по числу СТРОК, мимо всех
    // корзин, поэтому исключённая охранником периодическая задача всё равно
    // давала «идёт провижининг», причём ВЕЧНО и на самой вредной ветке: она
    // говорит оператору ждать. Оба периодических теста стояли на ACTIVE и
    // ровно этого не видели.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [
          task({
            id: 913,
            status: 'DELAYED',
            created: '2026-08-08 10:00:00',
            event: { name: 'PROLONGATE', period: 3600 },
            settings: { user_service_id: 52 },
          }),
        ],
        history: [],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.verdict).not.toBe('provisioning_in_progress');
    expect(result.services.diagnosed[0]?.spool.pending).toBe(0);
    // Ответ, спорящий сам с собой, — сильнейший признак пропущенной ветки:
    // предупреждение говорило «в pending не учтено, это не работа в полёте»,
    // а заголовок в тот же момент говорил «идёт провижининг».
    expect(result.warnings.map((w) => w.code)).toContain('periodic_task_not_progress');
  });

  it('maps each periodic task to the service it belongs to', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51, ACTIVE_52],
        queue: [
          task({ id: 914, status: 'DELAYED', event: { name: 'PROLONGATE', period: 3600 } }),
          task({
            id: 915,
            status: 'DELAYED',
            event: { name: 'PROLONGATE', period: 3600 },
            settings: { user_service_id: 52 },
          }),
        ],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    // Два id в одном сообщении без имени услуги читателю не разложить.
    const said = result.warnings.find((w) => w.code === 'periodic_task_not_progress');
    expect(said?.message).toContain('914 (service 51)');
    expect(said?.message).toContain('915 (service 52)');
  });

  it('reads a SUCCESS row left in the queue as a success whose work is absent', async () => {
    // finish_task на успехе непериодической задачи строку УДАЛЯЕТ
    // (Spool.pm:274-285), и api_success — ручной manual/success — идёт через
    // него же (Spool.pm:340-350). Значит выживший в очереди SUCCESS означает
    // то же, что SUCCESS в архиве: успех записан, а работы за ним нет. В
    // `pending` он не входит, поэтому подмена предиката на `ev.pending > 0`
    // обязана была решить его судьбу явно, а не уронить в «ничего не ставили».
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [
          task({ id: 916, status: 'SUCCESS', settings: { user_service_id: 52 } }),
        ],
        history: [],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('fake_success');
    expect(result.services.diagnosed[0]?.spool.pending).toBe(0);
    // Счётчик обязан быть В ОТВЕТЕ, а не только в вычислении: иначе читатель
    // видит total: 1 при всех нулевых корзинах и восстанавливает причину из
    // tasks[].status.
    expect(result.services.diagnosed[0]?.spool.succeeded).toBe(1);
    const fake = result.warnings.find((w) => w.code === 'possible_fake_success');
    expect(fake).toBeDefined();
    // История здесь ПУСТА, поэтому текст не имеет права отсылать к записи в
    // истории как к единственной форме находки — иначе предупреждение
    // противоречит собственному payload'у ровно так же, как это делал заголовок
    // provisioning_in_progress до прошлого раунда.
    expect(fake?.message).not.toContain('with an empty queue');
    expect(fake?.message).toContain('spool.succeeded');
  });

  it('puts a paused task ahead of an otherwise healthy service, on purpose', async () => {
    // Осознанное старшинство, а не случайность: проверка paused стоит до всех
    // проверок улик, зеркально provisioning_stuck. Услуга работает, но в
    // очереди висит задача, которая не поедет никогда (Spool.pm:130-133), и
    // заголовок `ok` про неё промолчал бы.
    const alone = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        queue: [task({ id: 917, status: 'PAUSED', created: '2026-08-08 10:00:00' })],
      }),
    )) as DiagnoseOut;
    expect(alone.services.diagnosed[0]?.panel.found).toBe(true);
    expect(alone.services.diagnosed[0]?.storage.present).toBe(true);
    expect(alone.verdict).toBe('provisioning_paused');

    // И между услугами: paused перевешивает storage_missing.
    const across = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51, ACTIVE_52],
        queue: [task({ id: 918, status: 'PAUSED', created: '2026-08-08 10:00:00' })],
        history: [],
        storage: {},
        panel: { '/api/users/by-username/HQVPN_52': panelUser(52) },
      }),
    )) as DiagnoseOut;
    expect(across.services.diagnosed.map((one) => one.verdict)).toEqual([
      'provisioning_paused',
      'storage_missing',
    ]);
    expect(across.verdict).toBe('provisioning_paused');
  });

  it('still counts an ordinary DELAYED task as work waiting to run', async () => {
    // Контроль к предыдущему тесту: без `period` DELAYED остаётся ожиданием,
    // и охранник не должен глушить обычную отложенную задачу.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51],
        queue: [task({ id: 912, status: 'DELAYED', created: '2026-08-08 14:55:00' })],
        history: [],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.services.diagnosed[0]?.spool.tasks[0]?.periodic).toBe(false);
    expect(result.services.diagnosed[0]?.spool.pending).toBe(1);
    expect(result.verdict).toBe('provisioning_in_progress');
    expect(result.warnings.map((w) => w.code)).not.toContain('periodic_task_not_progress');
  });

  it('names a paused task instead of reporting nothing was ever queued', async () => {
    // Spool.pm:130-133 исключает PAUSED из выборки на исполнение навсегда,
    // ровно как STUCK. Задача есть и не поедет — правильное действие resume, а
    // не «поставить провижининг заново», и вердикт обязан это различать.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51],
        queue: [task({ id: 909, status: 'PAUSED', created: '2026-08-08 10:00:00' })],
        history: [],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('provisioning_paused');
    expect(result.services.diagnosed[0]?.spool.paused).toBe(1);
    const said = result.warnings.find((w) => w.code === 'spool_task_paused');
    expect(said?.message).toContain('Resume');
  });

  it('does not read a paused task on a PROGRESS service as work in flight', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [
          task({
            id: 910,
            status: 'PAUSED',
            created: '2026-08-08 14:55:00',
            settings: { user_service_id: 52 },
          }),
        ],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;

    // «Подождите, идёт провижининг» про задачу, которая не поедет никогда, —
    // худший вариант: ждать можно бесконечно.
    expect(result.verdict).toBe('provisioning_paused');
  });

  it('counts STUCK as a failure at any age and DELAYED as never stuck', async () => {
    // D3/D7: словарь статусов — NEW, SUCCESS, FAIL, DELAYED, STUCK, PAUSED
    // (Const.pm:78-83), колонка char(8). STUCK воркер ставит на терминальном
    // провале и исключает из выборки навсегда (Spool.pm:132), а DELAYED — это
    // штатное состояние отложенной и периодической задачи (Spool.pm:93-97,
    // :277-283).
    const stuckNow = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        queue: [task({ id: 901, status: 'STUCK', created: '2026-08-08 14:59:00' })],
      }),
    )) as DiagnoseOut;
    expect(stuckNow.verdict).toBe('provisioning_stuck');
    expect(stuckNow.services.diagnosed[0]?.spool.stuck).toBe(1);
    expect(stuckNow.services.diagnosed[0]?.spool.tasks[0]?.minutes).toBe(1);

    const delayedForever = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        queue: [task({ id: 902, status: 'DELAYED', created: '2026-08-08 10:00:00' })],
      }),
    )) as DiagnoseOut;
    expect(delayedForever.verdict).toBe('ok');
    expect(delayedForever.services.diagnosed[0]?.spool.pending).toBe(1);
    expect(delayedForever.services.diagnosed[0]?.spool.stuck).toBe(0);
  });

  it('waits out a fresh task and reports the old one as stuck', async () => {
    const fresh = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [task({ id: 903, created: '2026-08-08 14:55:00', settings: { user_service_id: 52 } })],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;
    expect(fresh.verdict).toBe('provisioning_in_progress');
    expect(fresh.warnings.map((w) => w.code)).toContain('service_in_progress');

    const stale = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [PROGRESS_52],
        queue: [task({ id: 904, created: '2026-08-08 14:30:00', settings: { user_service_id: 52 } })],
        storage: {},
        panel: {},
      }),
    )) as DiagnoseOut;
    expect(stale.verdict).toBe('provisioning_stuck');
    expect(stale.services.diagnosed[0]?.spool.stuck).toBe(1);
  });

  it('does not call a PROGRESS or NOT PAID service a client without services', async () => {
    // D6: USObject.pm:460-461 ставит STATUS_PROGRESS и ТОЛЬКО потом ставит
    // задачу в спул — весь провижининг услуга проводит в PROGRESS. Заголовок
    // «услуг нет» в этот момент противоречит остальному телу ответа.
    const unpaid = (await provisioningDiagnose.handler(
      input(),
      stand({ services: [UNPAID_53], storage: {}, panel: {} }),
    )) as DiagnoseOut;
    expect(unpaid.verdict).toBe('service_inactive');
    expect(unpaid.services.diagnosed[0]?.status).toBe('NOT PAID');
    // У наблюдаемой в NOT PAID услуги CREATE не запускался: make_commands_by_event
    // переводит услугу в PROGRESS ДО постановки задачи (USObject.pm:460-462),
    // поэтому ни снапшота, ни пользователя в панели у неё быть и не должно.
    // (Не ссылаться сюда на USObject.pm:430-436 — там сказано ОБРАТНОЕ:
    // (EVENT_CREATE) => [STATUS_WAIT_FOR_PAY, STATUS_INIT], то есть NOT PAID —
    // статус, ИЗ которого CREATE разрешён.) Обе оговорки здесь были бы шумом
    // на каждом неоплаченном заказе.
    const codes = unpaid.warnings.map((w) => w.code);
    expect(codes).not.toContain('storage_empty_is_not_404');
    expect(codes).not.toContain('panel_username_guessed');
  });

  it('says no_active_service only when the client genuinely has none', async () => {
    const empty = (await provisioningDiagnose.handler(
      input(),
      stand({ services: [], storage: {}, panel: {} }),
    )) as DiagnoseOut;
    expect(empty.verdict).toBe('no_active_service');
    expect(empty.services.diagnosed).toEqual([]);
  });

  it('does not pass off a filled window as "the client has no services"', async () => {
    const ctx = makeCtx({
      now,
      shmList: (path, params) =>
        path === '/admin/user/service'
          ? { items: 300, limit: Number(params?.limit ?? 50), offset: 0, data: [] }
          : [],
      shmGet: () => undefined,
      remnaGet: () => null,
    });
    const result = (await provisioningDiagnose.handler(input(), ctx)) as DiagnoseOut;

    expect(result.services.items).toBe(300);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
    expect(result.verdict).toBe('indeterminate');
  });

  it('diagnoses every service on its own key and headlines the worst one', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51, ACTIVE_52],
        queue: [],
        history: [],
        storage: { '/admin/storage/manage/vpn_mrzb_51': snapshot(51) },
        panel: { '/api/users/9051': panelUser(51) },
      }),
    )) as DiagnoseOut;

    expect(result.services.diagnosed.map((s) => [s.user_service_id, s.verdict])).toEqual([
      [51, 'ok'],
      [52, 'no_spool_task'],
    ]);
    // Схлопывание двух услуг в один вердикт — это ровно то, как сломанная
    // услуга становится невидимой; заголовок обязан показывать худшую.
    expect(result.verdict).toBe('no_spool_task');
  });

  it('attaches spool tasks through settings, not through the empty column', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        ...HEALTHY,
        queue: [
          task({ id: 905, status: 'FAIL', created: '2026-08-08 14:59:00' }),
          task({ id: 906, status: 'NEW', settings: { user_service_id: 52 } }),
          task({ id: 907, status: 'NEW', settings: { to: 'mail@example.com' } }),
        ],
      }),
    )) as DiagnoseOut;

    const service = result.services.diagnosed[0];
    expect(service?.spool.tasks.map((t) => t.id)).toEqual([905]);
    expect(service?.spool.failed).toBe(1);
    expect(service?.spool.tasks[0]?.event).toBe('CREATE');
  });

  it('narrows to one service when asked', async () => {
    const result = (await provisioningDiagnose.handler(
      input({ user_service_id: 52 }),
      stand({
        services: [ACTIVE_51, ACTIVE_52],
        storage: { '/admin/storage/manage/vpn_mrzb_52': snapshot(52) },
        panel: { '/api/users/9052': panelUser(52) },
      }),
    )) as DiagnoseOut;

    expect(result.services.diagnosed.map((s) => s.user_service_id)).toEqual([52]);
    expect(result.verdict).toBe('ok');
  });

  it('suppresses the storage verdict when the storage read itself failed', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand(HEALTHY, {
        shmGet: () => {
          throw new Error('SHM 500');
        },
      }),
    )) as DiagnoseOut;

    expect(result.verdict).toBe('indeterminate');
    expect(result.services.diagnosed[0]?.verdict).toBe('indeterminate');
    expect(result.degraded).toEqual([{ system: 'shm', error: 'SHM 500' }]);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
    expect(result.warnings.map((w) => w.code)).not.toContain('storage_empty_is_not_404');
    // `present: false` рядом с `checked: false` — это «не прочитали», а не
    // «снапшота нет»; поле, отвечающее за неотвеченный источник, обязано
    // отличать одно от другого.
    expect(result.services.diagnosed[0]?.storage.checked).toBe(false);
  });

  it('admits when found=false rests on a guessed username', async () => {
    // Префикс имени настраивается (`config.remnawave.name_prefix`,
    // remnawave.tpl:148). Панель с чужим префиксом отсюда неотличима от панели
    // без пользователя, и вердикт об этом обязан сказать вслух.
    const guessed = (await provisioningDiagnose.handler(
      input(),
      stand({ ...HEALTHY, storage: {}, panel: {} }),
    )) as DiagnoseOut;
    const said = guessed.warnings.find((w) => w.code === 'panel_username_guessed');
    expect(said?.message).toContain('config.remnawave.name_prefix');

    // Снапшот на месте — id взят из него, гадать не пришлось.
    const exact = (await provisioningDiagnose.handler(input(), stand(HEALTHY))) as DiagnoseOut;
    expect(exact.warnings.map((w) => w.code)).not.toContain('panel_username_guessed');
  });

  it('addresses the panel by the id in the snapshot, never by its legacy uuid', async () => {
    // Verified against a running system: a real vpn_mrzb_* snapshot carries BOTH
    // `id` and a legacy `uuid`, and the uuid is dead — /api/users/{uuid}
    // answers 400 "Validation failed" (path ["userId"]) on 3.x. The stored id
    // addresses the panel and agrees with by-username for the same service.
    const calls: StubCall[] = [];
    await provisioningDiagnose.handler(input(), stand(HEALTHY, { calls }));

    expect(calls.some((c) => c.path === '/api/users/9051')).toBe(true);
    expect(calls.some((c) => c.path.includes('u-51'))).toBe(false);
  });

  it('falls back to the username when a pre-3.x snapshot carries no id', async () => {
    // The oldest snapshots predate `id` entirely. A uuid alone cannot address
    // the panel any more, so guessing the username is the only route left —
    // and the answer has to admit that it guessed.
    const legacy = {
      response: { uuid: 'u-51', username: 'HQVPN_51', status: 'ACTIVE' },
    };
    const calls: StubCall[] = [];
    const result = (await provisioningDiagnose.handler(
      input(),
      stand(
        { ...HEALTHY, storage: { '/admin/storage/manage/vpn_mrzb_51': legacy } },
        { calls },
      ),
    )) as DiagnoseOut;

    expect(calls.some((c) => c.path.includes('u-51'))).toBe(false);
    expect(calls.some((c) => c.path === '/api/users/by-username/HQVPN_51')).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('snapshot_predates_numeric_id');
  });

  it('records one unreachable source once, not once per service', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand(
        { services: [ACTIVE_51, ACTIVE_52] },
        {
          shmGet: () => {
            throw new Error('SHM 500');
          },
        },
      ),
    )) as DiagnoseOut;

    expect(result.degraded).toEqual([{ system: 'shm', error: 'SHM 500' }]);
    expect(result.services.diagnosed.map((s) => s.verdict)).toEqual([
      'indeterminate',
      'indeterminate',
    ]);
  });

  it('announces a clock skew instead of silently missing a stuck task', async () => {
    // Неверный HQ_MCP_SHM_TZ читает московский штамп как UTC: задача «создана»
    // на три часа в будущем, возраст уходит в минус и порог не срабатывает.
    const result = (await provisioningDiagnose.handler(
      input(),
      stand(
        { ...HEALTHY, queue: [task({ id: 908, created: '2026-08-08 14:30:00' })] },
        { shmTz: 'UTC' },
      ),
    )) as DiagnoseOut;

    const skew = result.warnings.find((w) => w.code === 'clock_skew');
    expect(skew).toBeDefined();
    expect(skew?.message).toContain('UTC');
    expect(skew?.message).toContain('HQ_MCP_SHM_TZ');
  });

  it('states that the listing hides composite children and removed services', async () => {
    const result = (await provisioningDiagnose.handler(input(), stand(HEALTHY))) as DiagnoseOut;
    expect(result.warnings.map((w) => w.code)).toContain('excludes_children_and_removed');
  });

  it('takes no telegram id and defaults the age gate', async () => {
    // D5/D8: панель проверяется по услуге, а не по клиенту — один
    // пользователь панели существует на КАЖДЫЙ user_service_id
    // (remnawave.tpl:148, :352). Вход с telegram_id делал вердикт `ok`
    // недостижимым при значении по умолчанию null.
    const parsed = provisioningDiagnose.input.parse({ shm_user_id: 3073 }) as Record<string, unknown>;
    expect(parsed).toEqual({ shm_user_id: 3073, user_service_id: null, stuck_minutes: 15 });
    expect('telegram_id' in parsed).toBe(false);
  });
});

describe('provisioning_diagnose — naming comes from the installation', () => {
  beforeEach(() => {
    resetPanelNamingCache();
  });

  /** Строка `remnawave` таблицы config, как её отдаёт SHM: значение в `data[0]`. */
  const configured = (value: Record<string, unknown>): Record<string, unknown> => ({
    '/admin/config/remnawave': [value],
  });

  it('builds the storage key and the guessed username from the live SHM config', async () => {
    // Ровно то, что делает сам шаблон провижининга:
    //   STORAGE_PREFIX = config.remnawave.storage_prefix || "vpn_mrzb_"
    //   NAME_PREFIX    = config.remnawave.name_prefix    || "HQVPN_"
    // Инструмент, который спрашивает эту же строку, переезжает на чужую
    // инсталляцию сам; зашитые `vpn_mrzb_`/`HQVPN_` там отвечали бы «снапшота
    // нет, пользователя нет» на каждой живой услуге.
    const calls: StubCall[] = [];
    await provisioningDiagnose.handler(
      input(),
      stand(
        {
          services: [ACTIVE_51],
          storage: configured({ storage_prefix: 'acme_cfg_', name_prefix: 'ACME_' }),
        },
        { calls },
      ),
    );

    expect(calls.some((c) => c.path === '/admin/storage/manage/acme_cfg_51')).toBe(true);
    expect(calls.some((c) => c.path === '/admin/storage/manage/vpn_mrzb_51')).toBe(false);
    expect(calls.some((c) => c.path === '/api/users/by-username/ACME_51')).toBe(true);
    expect(calls.some((c) => c.path === '/api/users/by-username/HQVPN_51')).toBe(false);
  });

  it('names the source of the prefixes it guessed with, not just the prefixes', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({ services: [ACTIVE_51] }),
    )) as DiagnoseOut;

    const said = result.warnings.find((w) => w.code === 'panel_username_guessed');
    // «Дефолт» — это не «настроено так», а «ни одна живая система этого не
    // подтверждала», и читатель обязан видеть разницу до того, как поверит
    // found=false.
    expect(said?.message).toContain('never confirmed against this install');
  });

  it('reports a snapshot name no known prefix builds as a prefix problem', async () => {
    // Имя в снапшоте написал САМ провижининг этой инсталляции — это образец её
    // именования, а не догадка. Не собирается известным префиксом → «в панели
    // пользователя нет» на соседней услуге читается как «искали не тем именем».
    const result = (await provisioningDiagnose.handler(
      input(),
      stand({
        services: [ACTIVE_51],
        storage: { '/admin/storage/manage/vpn_mrzb_51': snapshot(51, 'acme-51') },
        panel: { '/api/users/9051': panelUser(51, 'acme-51') },
      }),
    )) as DiagnoseOut;

    const said = result.warnings.find((w) => w.code === 'prefix_unverified');
    expect(said?.message).toContain('acme-51');
    expect(said?.message).toContain('HQ_MCP_PANEL_PREFIXES');
    // Вердикт при этом остаётся честным: аккаунт нашли по id из снапшота.
    expect(result.services.diagnosed[0]?.verdict).toBe('ok');
  });

  it('stays quiet when the panel name is one the known prefixes build', async () => {
    const result = (await provisioningDiagnose.handler(
      input(),
      stand(HEALTHY),
    )) as DiagnoseOut;

    expect(result.warnings.map((w) => w.code)).not.toContain('prefix_unverified');
  });
});
