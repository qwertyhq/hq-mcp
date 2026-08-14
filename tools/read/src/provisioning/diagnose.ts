import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  PANEL_PREFIXES_VAR,
  SPOOL_DELAYED_STATUS,
  SPOOL_FAILED_STATUS,
  SPOOL_PAUSED_STATUS,
  SPOOL_PENDING_STATUSES,
  SPOOL_NEW_STATUS,
  SPOOL_STUCK_STATUS,
  SPOOL_SUCCESS_STATUS,
  asRecord,
  listOut,
  matchesKnownPrefix,
  minutesSince,
  noteOnce,
  num,
  parseSettings,
  prefixSourcePhrase,
  resolvePanelNaming,
  settle,
  spoolUserServiceId,
  str,
  take,
  warn,
} from '../kit.js';
import type { PanelNaming } from '../kit.js';

/**
 * Ключ снапшота конфигов в SHM storage именуется по **user_service_id**, а не
 * по user_id: все записи идут по `{{ us.id }}` (remnawave.tpl:310, :319, :472,
 * :661). То же самое независимо подтверждают tempaltes/traffic_reset.tpl:153
 * (`vpn_storage_key = "vpn_mrzb_" _ user_service_id`),
 * tempaltes/telegram_bot-fix.tpl:491 и фронтенд-клиент
 * wbap/src/lib/api/api.ts:770. Ключа `<префикс><user_id>` не существует
 * никогда — диагноз «снапшота нет» по нему был бы вечным и для всех.
 *
 * САМ ПРЕФИКС ЗДЕСЬ НЕ ЗАШИТ: шаблон берёт его из `config.remnawave`
 * (`STORAGE_PREFIX = config.remnawave.storage_prefix || "vpn_mrzb_"`), и
 * resolvePanelNaming спрашивает ровно эту строку у самой SHM. Прибитая сюда
 * `vpn_mrzb_` работала бы только на том развёртывании, где её измерили.
 *
 * Гадание по имени пользователя панели — ЗАПАСНОЙ путь: когда снапшот на
 * месте, числовой id берётся прямо из него (remnawave.tpl:208 читает
 * `storage.read(...)`) и перебирать префиксы не приходится вовсе.
 */
const SERVICES_LIMIT = 50;
const SPOOL_LIMIT = 100;
/** Больше этого числа услуг на клиента — это не диагностика, а обход панели. */
const MAX_DIAGNOSED = 10;

/** Ниже этого возраста в минусе расхождение уже нельзя списать на дрожь часов. */
const SKEW_TOLERANCE_MINUTES = 2;

/**
 * Статусы услуги — app/lib/Core/Const.pm:46-54: INIT, NOT PAID, PROGRESS,
 * ACTIVE, BLOCK, REMOVED, ERROR. В этих трёх рабочего конфига не ждут вовсе:
 * услуга либо ещё не оплачена, либо заблокирована. Отсутствие конфига здесь —
 * состояние биллинга, а не сбой провижининга.
 *
 * ERROR сюда осознанно НЕ входит: в отличие от BLOCK/NOT PAID/INIT он не
 * означает «конфига и не должно быть», поэтому такая услуга разбирается по
 * уликам наравне с ACTIVE.
 */
const INACTIVE_STATUSES: readonly string[] = ['BLOCK', 'NOT PAID', 'INIT'];

/**
 * Из INACTIVE_STATUSES — те, что провижининга ещё не видели вовсе.
 * Доказательство — USObject.pm:460-462: make_commands_by_event сперва
 * переводит услугу в STATUS_PROGRESS и только ПОТОМ ставит задачи в спул.
 * Значит услуга, НАБЛЮДАЕМАЯ в 'NOT PAID' или 'INIT', ни одного CREATE ни в
 * работе, ни завершённым не имеет — иначе её статус был бы уже другим. Ни
 * снапшота, ни пользователя в панели у неё быть и НЕ ДОЛЖНО.
 *
 * Ссылаться здесь на allow_event_by_status (USObject.pm:430-436) НЕЛЬЗЯ, хотя
 * соблазн есть: там ровно обратное — `(EVENT_CREATE) => [STATUS_WAIT_FOR_PAY,
 * STATUS_INIT]`, а STATUS_WAIT_FOR_PAY — это и есть 'NOT PAID' (Const.pm:48).
 * То есть это статусы, из которых CREATE как раз РАЗРЕШЁН. BLOCK сюда не входит: заблокированная услуга
 * когда-то была активной, и remnawave.tpl перезаписывает снапшот в том числе
 * на BLOCK (:650-663) — пустой ключ там настоящая аномалия. Оговорки про
 * пустой storage и угаданное имя на этих статусах — чистый шум: их выдал бы
 * каждый клиент с неоплаченным заказом.
 */
const PRE_PROVISION_STATUSES: readonly string[] = ['NOT PAID', 'INIT'];

/** STATUS_PROGRESS: USObject.pm:460-461 ставит его и ТОЛЬКО потом кладёт задачу в спул. */
const PROGRESS_STATUS = 'PROGRESS';

export type ProvisioningVerdict =
  | 'ok'
  | 'storage_missing'
  | 'panel_user_missing'
  | 'provisioning_stuck'
  | 'provisioning_in_progress'
  | 'fake_success'
  | 'provisioning_paused'
  | 'provisioning_never_succeeded'
  | 'no_spool_task'
  | 'service_inactive'
  | 'no_active_service'
  | 'indeterminate';

/**
 * От худшего к лучшему. Заголовок ответа — САМЫЙ ТЯЖЁЛЫЙ вердикт среди услуг:
 * у клиента с двумя услугами ключи хранилища, пользователи панели и задачи
 * разные, и схлопывание их в один благополучный вердикт — ровно то, как
 * сломанная услуга остаётся невидимой. `indeterminate` стоит ниже доказанных
 * поломок и выше всех благополучных исходов: непроверенное не должно
 * перевешивать доказанное, но и читаться как «всё хорошо» не должно.
 */
const SEVERITY: readonly ProvisioningVerdict[] = [
  'fake_success',
  'provisioning_stuck',
  'provisioning_paused',
  'provisioning_never_succeeded',
  'panel_user_missing',
  'storage_missing',
  'no_spool_task',
  'indeterminate',
  'provisioning_in_progress',
  'service_inactive',
  'ok',
];

interface SpoolLine {
  id: number;
  status: string | null;
  minutes: number | null;
  event: string | null;
  /** `event.period > 0` — задача повторяющаяся; см. isPeriodicRest. */
  periodic: boolean;
}

interface ServiceDiagnosis {
  user_service_id: number;
  service_id: number;
  name: string | null;
  status: string | null;
  expire: string | null;
  verdict: ProvisioningVerdict;
  /** `checked: false` — прочитать не удалось, и `present` тогда ничего не утверждает. */
  storage: { name: string; present: boolean; checked: boolean };
  /** `checked: false` — спросить не удалось, и `found` тогда ничего не утверждает. */
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

interface AnnotatedTask {
  usi: number | null;
  state: string;
  line: SpoolLine;
}

interface ServiceEvidence {
  storagePresent: boolean;
  storageOk: boolean;
  panelFound: boolean;
  panelOk: boolean;
  spoolOk: boolean;
  total: number;
  stuck: number;
  failed: number;
  pending: number;
  paused: number;
  /**
   * Строки очереди со статусом SUCCESS. Отдельно, потому что ни в одну другую
   * корзину они не попадают: finish_task на успехе непериодической задачи
   * УДАЛЯЕТ строку (Spool.pm:274-285), поэтому выживший SUCCESS в очереди —
   * состояние аномальное, и выборка на исполнение его не исключает
   * (Spool.pm:130-133 отсеивает только STUCK и PAUSED).
   */
  succeeded: number;
  historyTotal: number;
  historySuccess: number;
}

function stateOf(row: Record<string, unknown>): string {
  return (str(row.status) ?? '').toUpperCase();
}

function toLine(row: Record<string, unknown>, now: Date, zone: string): SpoolLine {
  const event = parseSettings(row.event);
  return {
    id: num(row.id),
    status: str(row.status),
    // Ровно то, что читает Core::Spool::is_periodic (Spool.pm:289-291):
    // `event->{period} && event->{period} > 0`. Значение приезжает и строкой
    // ("600"), и числом (36000) — в работающей установке встречаются оба
    // варианта, поэтому num().
    periodic: num(event.period, 0) > 0,
    // `created` — единственная колонка со временем постановки задачи
    // (app/sql/shm/shm_structure.sql:174-188); `executed` означает другое.
    minutes: minutesSince(now, row.created, zone),
    event: str(event.name),
  };
}

/**
 * Чтение несуществующего ключа — это 200 и пустое тело, а не 404
 * (Storage.pm:180-190, v1.cgi:1836-1845, §6.18), а пустое тело клиент SHM
 * отдаёт как `undefined`. Поэтому «пусто» здесь означает «ключа нет», и
 * отличать это надо от «запрос не удался» — последнее живёт в degraded.
 */
function snapshotOf(value: unknown): Record<string, unknown> | null {
  const body = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  return Object.keys(body).length === 0 ? null : body;
}

export interface PanelProbe {
  username: string | null;
  /** Числовой `id` пользователя панели — единственный адрес в Remnawave 3.x. */
  id: number | null;
  found: boolean;
  ok: boolean;
  /** Снапшот старше, чем `id`: адресовать по нему нечем, имя пришлось гадать. */
  legacySnapshot: boolean;
  /** Имя угадывали по префиксам, снапшота не было. Ложное found=false живёт тут. */
  guessed: boolean;
}

async function probePanel(
  ctx: ToolContext,
  usi: number,
  snapshot: Record<string, unknown> | null,
  degraded: Degraded[],
  naming: PanelNaming,
): Promise<PanelProbe> {
  // Снапшот хранит НЕразвёрнутый ответ панели (`{response: {...}}`), см.
  // remnawave.tpl:295-322 и :455-473.
  //
  // Читается ИМЕННО `id`. Настоящий снапшот несёт и его, и наследный `uuid`
  // (проверено на работающей установке, а не по спецификации), но uuid мёртв:
  // панель 3.x объявляет параметр пути как `userId: number` и отвечает на uuid
  // 400 «Validation failed», а не 404. То есть прежний путь по uuid не просто
  // перестал находить пользователя — он вообще перестал быть адресом, и
  // каждая такая проверка уезжала в degraded как сбой панели.
  const stored = asRecord(asRecord(snapshot ?? {}).response);
  const storedIdRaw = num(stored.id, Number.NaN);
  const storedId = Number.isFinite(storedIdRaw) && storedIdRaw > 0 ? storedIdRaw : null;
  const storedName = str(stored.username);
  // Снапшот есть, но `id` в нём нет — он старше самого поля. Адресовать нечем.
  const legacySnapshot = snapshot !== null && storedId === null;

  if (storedId !== null) {
    const result = await settle(ctx.remna.get<unknown>(`/api/users/${String(storedId)}`));
    if (!result.ok) {
      noteOnce(degraded, 'remna', result.error);
      return {
        username: storedName,
        id: storedId,
        found: false,
        ok: false,
        legacySnapshot,
        guessed: false,
      };
    }
    // Прикладной 404 на объектной ручке — это ответ «такого пользователя
    // нет», а не сбой; клиент отдаёт его как null.
    const row = asRecord(result.value);
    const foundId = num(row.id, Number.NaN);
    return {
      username: str(row.username) ?? storedName,
      id: Number.isFinite(foundId) && foundId > 0 ? foundId : storedId,
      found: Number.isFinite(foundId) && foundId > 0,
      ok: true,
      legacySnapshot,
      guessed: false,
    };
  }

  for (const prefix of naming.usernamePrefixes) {
    const username = `${prefix}${String(usi)}`;
    const result = await settle(
      ctx.remna.get<unknown>(`/api/users/by-username/${encodeURIComponent(username)}`),
    );
    if (!result.ok) {
      noteOnce(degraded, 'remna', result.error);
      return {
        username: null,
        id: null,
        found: false,
        ok: false,
        legacySnapshot,
        guessed: true,
      };
    }
    const row = asRecord(result.value);
    const foundId = num(row.id, Number.NaN);
    if (Number.isFinite(foundId) && foundId > 0) {
      return {
        username: str(row.username) ?? username,
        id: foundId,
        found: true,
        ok: true,
        legacySnapshot,
        guessed: true,
      };
    }
  }
  return { username: null, id: null, found: false, ok: true, legacySnapshot, guessed: true };
}

/**
 * Пользователь панели ОДНОЙ услуги: снапшот из хранилища SHM плюс проверка в
 * панели. Ровно тот путь, которым provisioning_diagnose отвечает на вопрос
 * «есть ли у этой услуги аккаунт в панели», вынесенный в отдельную функцию
 * ради ВТОРОГО вызывающего — client_resolve.
 *
 * Вынесено, а не скопировано, по той же причине, по которой в kit.ts живёт
 * resolvePanelNaming: две копии этого пути означают, что однажды один из
 * инструментов перестанет находить живого клиента, а второй будет находить —
 * и оператор поверит тому, который ответил первым. Именно так и появился
 * дефект, ради которого функция здесь: client_resolve искал в панели ТОЛЬКО
 * по telegramId, а у заметной доли аккаунтов это поле пустое (панель пишет его
 * при создании и только если Telegram уже был привязан), поэтому существующий
 * аккаунт вида `remnawave_<user_service_id>` читался как `count: 0`.
 */
export interface ServicePanel {
  /** Ключ снапшота и его судьба: `ok:false` — прочитать не удалось. */
  storage: { name: string; snapshot: Record<string, unknown> | null; ok: boolean };
  panel: PanelProbe;
  /** Чем именовали, чтобы вызывающий мог сказать это вслух в предупреждении. */
  naming: PanelNaming;
}

export async function resolveServicePanel(
  ctx: ToolContext,
  shmUserId: number,
  usi: number,
  degraded: Degraded[],
): Promise<ServicePanel> {
  // Спрашивается у самой SHM и кэшируется на процесс, поэтому вызов в цикле по
  // услугам стоит одного чтения, а не одного на услугу.
  const naming = await resolvePanelNaming(ctx);
  const name = `${naming.storagePrefix}${String(usi)}`;
  // user_id ОБЯЗАТЕЛЕН: GET /admin/storage/manage/* объявлен с
  // required => ['user_id'] (v1.cgi:1109-1116), и без него диспетчер
  // отвечает 400 ещё до контроллера (v1.cgi:1692-1698). Он же переключает
  // контекст исполнения на этого клиента (v1.cgi:1686-1690), а Storage
  // ищет ключ во where с user_id текущего пользователя (Storage.pm:158-166).
  const storage = await settle(
    ctx.shm.get<unknown>(`/admin/storage/manage/${encodeURIComponent(name)}`, {
      user_id: shmUserId,
    }),
  );
  if (!storage.ok) noteOnce(degraded, 'shm', storage.error);
  const snapshot = storage.ok ? snapshotOf(storage.value) : null;
  const panel = await probePanel(ctx, usi, snapshot, degraded, naming);
  return { storage: { name, snapshot, ok: storage.ok }, panel, naming };
}

/**
 * Порядок ветвей — это и есть контракт инструмента. Каждая ветка, опирающаяся
 * на источник, который не ответил, заменяется на `indeterminate`: вердикт,
 * посчитанный по половине улик, хуже отсутствия вердикта.
 */
/**
 * Что говорят очередь и история, когда работающего результата нет. ОДНА
 * функция на оба пути — и на PROGRESS, и на хвост после проверок панели и
 * снапшота: раньше ветка PROGRESS решала по `ev.total > 0`, то есть по числу
 * СТРОК, мимо всех корзин. Задача, исключённая из `pending` охранником
 * периодичности, всё равно попадала в `total`, и услуга в PROGRESS с одной
 * покоящейся периодической строкой вечно читалась как «идёт провижининг» —
 * ровно то состояние, которое охранник и заводился закрыть, на ветке с самым
 * вредным сообщением: «подождите».
 *
 * Разбор по статусам, которые сюда вообще доходят (STUCK, FAIL и PAUSED
 * отсеяны выше):
 * - NEW моложе порога и непериодический DELAYED — `pending`, работа
 *   действительно в полёте;
 * - периодический DELAYED — покой повторяющейся задачи, не провижининг;
 * - SUCCESS — строка, которой в очереди быть не должно (finish_task её
 *   удаляет), и означает она то же, что SUCCESS в истории: успех записан, а
 *   работы, за которую он отвечает, нет;
 * - всё прочее — незнакомый статус: в `pending` не идёт, но и «записей нет»
 *   про него сказать нельзя, поэтому он остаётся в `total`.
 */
function queueVerdict(ev: ServiceEvidence): ProvisioningVerdict {
  if (ev.pending > 0) return 'provisioning_in_progress';
  if (ev.succeeded > 0 || ev.historySuccess > 0) return 'fake_success';
  if (ev.total > 0 || ev.historyTotal > 0) return 'provisioning_never_succeeded';
  return 'no_spool_task';
}

function verdictFor(status: string, ev: ServiceEvidence): ProvisioningVerdict {
  if (ev.spoolOk && (ev.stuck > 0 || ev.failed > 0)) return 'provisioning_stuck';
  // PAUSED исключён из выборки на исполнение навсегда, ровно как STUCK
  // (Spool.pm:130-133). Задача есть и не поедет: правильное действие — resume,
  // а не «поставить провижининг заново», поэтому проверка стоит ВЫШЕ ветки
  // PROGRESS. Услуга с приостановленной задачей не «в процессе»: ждать её
  // можно бесконечно.
  if (ev.spoolOk && ev.paused > 0) return 'provisioning_paused';
  if (status === PROGRESS_STATUS) {
    if (!ev.spoolOk) return 'indeterminate';
    // Услуга в PROGRESS не сдвинется сама: пока в очереди нет строки, которая
    // её двигает, статус останется таким навсегда. Что там есть на самом деле,
    // отвечает queueVerdict — одинаково с хвостом.
    return queueVerdict(ev);
  }
  if (INACTIVE_STATUSES.includes(status)) return 'service_inactive';
  if (!ev.panelOk || !ev.storageOk) return 'indeterminate';
  if (ev.panelFound && ev.storagePresent) return 'ok';
  if (ev.panelFound) return 'storage_missing';
  if (ev.storagePresent) return 'panel_user_missing';
  if (!ev.spoolOk) return 'indeterminate';
  // Очередь пуста, история говорит SUCCESS, пользователя в панели нет — это
  // подпись ручного `manual/success` (§6.10): api_success зовёт finish_task,
  // тот на непериодической задаче строку УДАЛЯЕТ (Spool.pm:340-350, :274-285),
  // и от подделанного провижининга остаётся ровно эта пара — пустая очередь и
  // SUCCESS в архиве.
  return queueVerdict(ev);
}

export const provisioningDiagnose = defineTool({
  name: 'provisioning_diagnose',
  description:
    'Answers "the service is paid but there is no config". SHM provisions a SERVICE, not a ' +
    'client: the storage snapshot, the panel user and the spool tasks are all keyed by ' +
    'user_service_id, so every service of the client gets its own verdict instead of one ' +
    'collapsed answer. Compares the billing status, the queue, the archived task history, the ' +
    'SHM storage snapshot and the actual user in the panel, and returns a verdict rather than ' +
    'five raw dumps. The snapshot body itself is never returned — only whether the key exists.',
  input: z.object({
    shm_user_id: z.number().int().positive().describe('SHM user_id from client_resolve'),
    user_service_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Diagnose one service; null diagnoses every service of the client'),
    stuck_minutes: z
      .number()
      .int()
      .positive()
      .default(15)
      .describe('A NEW task older than this counts as stuck; STUCK and FAIL count at any age'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  // ОБЕ. Вопрос инструмента — «доехал ли провижининг SHM до панели»; без
  // панели каждый ответ был бы `ok: false`, то есть отказ, выданный
  // тридцатью запросами к биллингу.
  backends: ['shm', 'remna'],
  handler: async ({ shm_user_id, user_service_id, stuck_minutes }, ctx) => {
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const now = ctx.now();

    const [services, queue, history] = await Promise.all([
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
          user_id: shm_user_id,
          limit: SERVICES_LIMIT,
        }),
      ),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/spool', {
          user_id: shm_user_id,
          limit: SPOOL_LIMIT,
        }),
      ),
      // Обязательный второй источник, а не украшение: Spool::finish_task на
      // успехе непериодической задачи вызывает $self->delete (Spool.pm:263-285)
      // после write_history. То есть у здорового клиента очередь ПУСТА, и без
      // истории это неотличимо от «задачу никто никогда не ставил» — а на
      // инциденте, ради которого инструмент существует (задачу пометили
      // успешной руками, §6.10), пустая очередь увела бы оператора ровно в
      // противоположную сторону.
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/spool/history', {
          user_id: shm_user_id,
          limit: SPOOL_LIMIT,
        }),
      ),
    ]);

    // items наружу (§6.4): «услуг у клиента нет» и «мы посмотрели первые 50
    // строк» — разные утверждения, и на первом строится весь вердикт.
    const serviceList = listOut(take(services, 'shm', degraded, EMPTY_LIST), warnings, 'services');
    const queueList = listOut(take(queue, 'shm', degraded, EMPTY_LIST), warnings, 'spool queue');
    const historyList = listOut(
      take(history, 'shm', degraded, EMPTY_LIST),
      warnings,
      'spool history',
    );

    const annotate = (row: Record<string, unknown>): AnnotatedTask => ({
      usi: spoolUserServiceId(row),
      state: stateOf(row),
      line: toLine(row, now, ctx.shmTz),
    });
    const queueLines = queueList.data.map(annotate);
    const historyLines = historyList.data.map(annotate);

    /**
     * «Стоит в очереди дольше, чем должна». Отдельно от STUCK, потому что
     * правило по возрасту у них разное: NEW ждёт порога, а STUCK воркер уже
     * сам признал терминально провалившейся (Spool.pm:132 исключает её из
     * выборки навсегда) и ждать нечего.
     */
    /**
     * Периодическая задача в DELAYED — это НЕ ожидание работы, а состояние
     * покоя: finish_task на успехе такой задачи не удаляет её, а переводит
     * обратно в DELAYED с delayed=event.period (Spool.pm:274-285). `created` у
     * неё остаётся датой первой постановки, поэтому «свежесть» по возрасту для
     * неё не считается вовсе, и засчитанная в pending она давала бы
     * `provisioning_in_progress` НАВСЕГДА.
     *
     * На практике это состояние обычно недостижимо: в наблюдавшейся установке
     * SHM ни одна строка events не несла `period`, а все периодические задачи
     * спула были глобальными kind=Jobs без settings.user_service_id, то есть
     * ни к какой услуге не привязаны. Но events — таблица конфигурации: один
     * добавленный оператором `period` включает это состояние, ничего не меняя
     * в коде, и отказ был бы молчаливым и вечным. Поэтому проверка есть, и
     * поэтому она НЕ переклассифицирует вердикт молча — срабатывание называет
     * себя и id задачи в предупреждении.
     */
    const isPeriodicRest = (task: AnnotatedTask): boolean =>
      task.state === SPOOL_DELAYED_STATUS && task.line.periodic;

    const isStale = (task: AnnotatedTask): boolean =>
      task.state === SPOOL_NEW_STATUS &&
      task.line.minutes !== null &&
      task.line.minutes >= stuck_minutes;

    const rows = serviceList.data
      .filter((row) => user_service_id === null || num(row.user_service_id) === user_service_id)
      // Строка без user_service_id диагностике не поддаётся вовсе: и ключ
      // хранилища, и имя пользователя панели строятся именно из него, а
      // подставленный ноль дал бы уверенный вердикт о несуществующей услуге.
      .filter((row) => num(row.user_service_id, 0) > 0);
    const diagnosable = rows.slice(0, MAX_DIAGNOSED);

    const diagnosed: ServiceDiagnosis[] = [];
    let sawEmptyStorage = false;
    let guessedAndMissed = false;
    let sawLegacySnapshot = false;
    /**
     * Имя, которое аккаунт В ПАНЕЛИ действительно носит и которое не
     * собирается ни одним известным префиксом. Снапшот пишет сам провижининг,
     * поэтому такое имя — прямая улика: список префиксов не описывает эту
     * инсталляцию.
     */
    const offPrefixNames: string[] = [];
    /**
     * Резолвится один раз на ответ: внутри цикла эта же функция зовётся из
     * resolveServicePanel и берёт кэш. Нужна здесь, чтобы предупреждения могли
     * назвать и сам список префиксов, и то, откуда он взялся.
     */
    const naming = await resolvePanelNaming(ctx);
    /** id задачи вместе с услугой: без неё два id в одном сообщении не разложить. */
    const periodicRest: { usi: number; id: number }[] = [];
    for (const row of diagnosable) {
      const usi = num(row.user_service_id);
      // Снапшот и пользователь панели читаются ТОЙ ЖЕ функцией, которой их
      // читает client_resolve: разъехавшиеся копии этого пути и есть механизм,
      // которым один инструмент начинает отвечать «аккаунта нет» там, где
      // второй его находит.
      const { storage, panel } = await resolveServicePanel(ctx, shm_user_id, usi, degraded);
      const { name, snapshot, ok: storageOk } = storage;
      // Пустой ответ на успешном чтении — это «ключа нет», и сказать это вслух
      // надо ровно тогда, когда чтение действительно состоялось.
      // Только для услуг, до провижининга доживших: у NOT PAID и INIT пустой
      // ключ — это norma, и обе оговорки ниже были бы шумом на каждом
      // неоплаченном заказе.
      const provisioningExpected = !PRE_PROVISION_STATUSES.includes(stateOf(row));
      sawEmptyStorage = sawEmptyStorage || (provisioningExpected && storageOk && snapshot === null);

      guessedAndMissed =
        guessedAndMissed || (provisioningExpected && snapshot === null && panel.ok && !panel.found);
      sawLegacySnapshot = sawLegacySnapshot || panel.legacySnapshot;
      // Имя из снапшота писал САМ провижининг этой инсталляции, поэтому оно —
      // образец её именования, а не догадка. Не собирается ни одним известным
      // префиксом → список префиксов эту инсталляцию не описывает, и «в панели
      // пользователя нет» на соседней услуге пришлось бы читать как «искали не
      // тем именем». Отличать это от честной пустоты и есть смысл проверки.
      if (snapshot !== null && !matchesKnownPrefix(panel.username, naming.usernamePrefixes)) {
        const seen = str(panel.username);
        if (seen !== null) offPrefixNames.push(seen);
      }

      const tasks = queueLines.filter((task) => task.usi === usi);
      periodicRest.push(...tasks.filter(isPeriodicRest).map((task) => ({ usi, id: task.line.id })));
      const archived = historyLines.filter((task) => task.usi === usi);
      const ev: ServiceEvidence = {
        storagePresent: snapshot !== null,
        storageOk,
        panelFound: panel.found,
        panelOk: panel.ok,
        spoolOk: queue.ok && history.ok,
        total: tasks.length,
        // STUCK — терминальный провал воркера, порога возраста не требует;
        // NEW — требует. DELAYED и PAUSED не «застряли» никогда.
        stuck: tasks.filter((task) => task.state === SPOOL_STUCK_STATUS || isStale(task)).length,
        failed: tasks.filter((task) => task.state === SPOOL_FAILED_STATUS).length,
        pending: tasks.filter(
          (task) =>
            SPOOL_PENDING_STATUSES.includes(task.state) && !isStale(task) && !isPeriodicRest(task),
        ).length,
        paused: tasks.filter((task) => task.state === SPOOL_PAUSED_STATUS).length,
        succeeded: tasks.filter((task) => task.state === SPOOL_SUCCESS_STATUS).length,
        historyTotal: archived.length,
        historySuccess: archived.filter((task) => task.state === SPOOL_SUCCESS_STATUS).length,
      };

      diagnosed.push({
        user_service_id: usi,
        service_id: num(row.service_id, 0),
        name: str(row.name),
        status: str(row.status),
        expire: str(row.expire),
        verdict: verdictFor(stateOf(row), ev),
        // Только факт наличия ключа и id. Содержимое vpn_mrzb_* приравнено
        // к ссылке подписки (§7.2): готовые конфиги наружу не уезжают.
        storage: { name, present: ev.storagePresent, checked: storageOk },
        panel: {
          username: panel.username,
          id: panel.id,
          found: panel.found,
          checked: panel.ok,
        },
        spool: {
          total: ev.total,
          stuck: ev.stuck,
          failed: ev.failed,
          pending: ev.pending,
          paused: ev.paused,
          // Наружу, потому что иначе fake_success читается как total: 1 при всех
          // нулевых корзинах, и причину приходится восстанавливать из tasks[].status.
          succeeded: ev.succeeded,
          tasks: tasks.map((task) => task.line),
        },
        history: {
          total: ev.historyTotal,
          success: ev.historySuccess,
          tasks: archived.map((task) => task.line),
        },
      });
    }

    let verdict: ProvisioningVerdict;
    if (diagnosed.length > 0) {
      verdict =
        SEVERITY.find((candidate) => diagnosed.some((one) => one.verdict === candidate)) ?? 'ok';
    } else if (services.ok && serviceList.items === 0 && user_service_id === null) {
      verdict = 'no_active_service';
    } else {
      // Услуг в ответе нет, но их отсутствие не доказано: список мог не
      // ответить, окно могло закончиться, или запрошенной услуги нет среди
      // видимых строк (см. excludes_children_and_removed).
      verdict = 'indeterminate';
    }

    if (diagnosed.some((one) => one.verdict === 'fake_success')) {
      warnings.push(
        warn(
          'possible_fake_success',
          'A service carries a SUCCESS — either in the task history, or as a queue row that ' +
            'should not have survived — while the work that SUCCESS stands for is not there: no ' +
            'user in the panel, or a service still sitting in PROGRESS. Both forms are the ' +
            'signature of marking a spool task successful by hand (§6.10): the status moves, the ' +
            'work never runs. A surviving SUCCESS row is the louder of the two, because ' +
            'finish_task deletes a non-periodic task on success (Spool.pm:277-286), so its ' +
            'presence is itself an anomaly. Check `spool.succeeded` and `history.success` to see ' +
            'which one fired, then repair with retry/resume — never with another manual success.',
        ),
      );
    }
    if (periodicRest.length > 0) {
      warnings.push(
        warn(
          'periodic_task_not_progress',
          'Queue rows left out of `pending` as periodic: ' +
            `${periodicRest.map((one) => `${String(one.id)} (service ${String(one.usi)})`).join(', ')}. ` +
            'Each carries event.period > 0, so finish_task re-arms it as DELAYED instead of ' +
            'deleting it (Spool.pm:274-285) and its `created` stays the date it was first ' +
            'queued. Their age therefore says nothing about provisioning being in flight, and ' +
            'no verdict here treats them as work in progress — read them as recurring jobs at ' +
            'rest.',
        ),
      );
    }
    if (diagnosed.some((one) => one.verdict === 'provisioning_paused')) {
      warnings.push(
        warn(
          'spool_task_paused',
          'A service has a PAUSED task in the queue. The worker excludes PAUSED from execution ' +
            'permanently (Spool.pm:130-133), exactly as it excludes STUCK, so waiting will not ' +
            'help: the task is there and will never run on its own. Resume that task — queueing ' +
            'the provisioning again leaves the paused one behind it.',
        ),
      );
    }
    if (diagnosed.some((one) => one.verdict === 'provisioning_never_succeeded')) {
      warnings.push(
        warn(
          'attempts_recorded_none_succeeded',
          'A service has spool records — a queue row, task history, or both — and not one ' +
            'SUCCESS among them, with nothing waiting to run. The provisioning was attempted and ' +
            'never completed: the recorded failure says why, and reading it beats queueing ' +
            'another attempt into the same error.',
        ),
      );
    }
    if (sawEmptyStorage) {
      warnings.push(
        warn(
          'storage_empty_is_not_404',
          'A storage key came back empty. SHM answers 200 with an empty body for a missing key, ' +
            'never 404, so "empty" here means the snapshot is absent — not that the read broke.',
        ),
      );
    }
    if (sawLegacySnapshot) {
      warnings.push(
        warn(
          'snapshot_predates_numeric_id',
          'A storage snapshot exists but carries no numeric `id`, only the legacy `uuid` that ' +
            'Remnawave 3.x no longer accepts as an address — /api/users/{uuid} answers 400, not ' +
            '404. The panel user was therefore looked up by guessing the username from the ' +
            'known prefixes, so found=false here carries the same caveat as a missing snapshot: ' +
            'a custom `config.remnawave.name_prefix` is indistinguishable from an absent user.',
        ),
      );
    }
    if (guessedAndMissed) {
      warnings.push(
        warn(
          'panel_username_guessed',
          'With no storage snapshot to read the numeric id from, the panel user was looked up by the ' +
            `known username prefixes (${naming.usernamePrefixes.join(', ')} — ` +
            `${prefixSourcePhrase(naming.usernamePrefixesFrom, PANEL_PREFIXES_VAR)}) plus the ` +
            'user_service_id, and none matched. A deployment that sets its own ' +
            '`config.remnawave.name_prefix` looks exactly like a missing user from here — check ' +
            'the prefix before acting on found=false.',
        ),
      );
    }
    if (offPrefixNames.length > 0) {
      warnings.push(
        warn(
          'prefix_unverified',
          'This client has a panel account none of the known prefixes builds: ' +
            `${[...new Set(offPrefixNames)].join(', ')} against ` +
            `${naming.usernamePrefixes.join(', ')} ` +
            `(${prefixSourcePhrase(naming.usernamePrefixesFrom, PANEL_PREFIXES_VAR)}). The name ` +
            "was read out of the storage snapshot SHM's own provisioning wrote, so it is what " +
            'this install really did, not a guess. Two causes, and they need different actions: ' +
            'the account was renamed in the panel (nothing to fix — but every tool that looks a ' +
            'user up BY NAME will miss it, which is why sync_audit reports such a service as ' +
            'missingPanelUser), or this deployment names all its users some other way and the ' +
            `configured prefixes are simply wrong — then set ${PANEL_PREFIXES_VAR}, or ` +
            'config.remnawave.name_prefix in SHM, which is where this tool reads it from. Either ' +
            'way, "no panel user" elsewhere means "not found under the names we tried", not ' +
            '"the account does not exist".',
        ),
      );
    }
    if (diagnosed.some((one) => (one.status ?? '').toUpperCase() === PROGRESS_STATUS)) {
      warnings.push(
        warn(
          'service_in_progress',
          'A service is in PROGRESS: change/touch/activate on it answer 200 with an empty result ' +
            'and do nothing. Wait for the spool task to finish before acting.',
        ),
      );
    }
    if (rows.length > diagnosable.length) {
      warnings.push(
        warn(
          'services_not_all_diagnosed',
          `The client has ${String(rows.length)} services in this window and only the first ` +
            `${String(MAX_DIAGNOSED)} were diagnosed — each one costs a storage read and a panel ` +
            'lookup. Narrow the answer with user_service_id for the rest.',
        ),
      );
    }
    if (user_service_id !== null && diagnosed.length === 0) {
      warnings.push(
        warn(
          'service_not_found',
          `Service ${String(user_service_id)} is not among the services SHM listed for client ` +
            `${String(shm_user_id)}. That is not proof it does not exist — see ` +
            'excludes_children_and_removed.',
        ),
      );
    }

    const skewed = [...queueLines, ...historyLines].filter(
      (task) => task.line.minutes !== null && task.line.minutes < -SKEW_TOLERANCE_MINUTES,
    );
    if (skewed.length > 0) {
      const ahead = Math.abs(Math.min(...skewed.map((task) => task.line.minutes ?? 0)));
      warnings.push(
        warn(
          'clock_skew',
          `Task timestamps read up to ${String(ahead)} minutes in the future in zone ` +
            `"${ctx.shmTz}". SHM writes dates as the server's local time with no offset, so this ` +
            'means HQ_MCP_SHM_TZ does not match the timezone the SHM container runs in. No ' +
            'verdict that depends on task age can be trusted until that is corrected: every ' +
            'fresh task looks future-dated and silently drops out of the age filter.',
        ),
      );
    }

    // Безусловно: GET /admin/user/service никогда здесь не сужается до одной
    // строки на стороне SHM (фильтр по user_service_id — клиентский), поэтому
    // UserService::list_for_api каждый раз применяет свои умолчания
    // where.parent=NULL и where.status!=REMOVED (UserService.pm:440-441).
    warnings.push(
      warn(
        'excludes_children_and_removed',
        'This listing never includes child services of composite tariffs (parent != NULL) or ' +
          'removed services (status=REMOVED) — SHM applies that filter by default and this tool ' +
          'has no way to override it. Absence here is not proof the client never had such a service.',
      ),
    );
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the sources did not answer (see `degraded`). Every verdict that depended on it ' +
            'reads `indeterminate` instead of being computed from half the evidence, and the ' +
            'field it owns carries `checked: false`: `storage.present` and `panel.found` are ' +
            'only claims where `checked` is true. Nothing here asserts that a snapshot or a ' +
            'panel user is absent — only that it was not confirmed present.',
        ),
      );
    }

    return {
      verdict,
      services: {
        items: serviceList.items,
        limit: serviceList.limit,
        offset: serviceList.offset,
        diagnosed,
      },
      spool: { items: queueList.items, limit: queueList.limit, offset: queueList.offset },
      history: {
        items: historyList.items,
        limit: historyList.limit,
        offset: historyList.offset,
      },
      warnings,
      degraded,
    };
  },
});
