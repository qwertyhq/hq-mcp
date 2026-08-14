import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import {
  PANEL_PREFIXES_VAR,
  asRecord,
  assertHumanOnly,
  capLimit,
  matchesKnownPrefix,
  noteOnce,
  num,
  prefixSourcePhrase,
  readRemnaUserWindow,
  readShmRows,
  resolvePanelNaming,
  settle,
  str,
  warn,
} from '../kit.js';
import type { PagedRows, PanelNaming } from '../kit.js';
import { normalizeShmUser } from '../client/resolve.js';

/**
 * Потолок строк на источник. Сверка, которая не может дочитать то, что
 * сверяет, — это честный и бесполезный ответ, поэтому обе стороны читаются
 * ДО КОНЦА, а не первым окном: на большой установке это тысячи клиентов и
 * тысячи услуг, то есть десятки страниц по 500 строк на таблицу.
 *
 * Стоимость в запросах покрыта отдельным потолком маршрута
 * (BATCH_LIST_LIMITS в @hq/budget): общий гейт в 30 запросов в минуту
 * рассчитан на поштучные чтения и батчевой вычитке запрещает даже начать.
 *
 * DEFAULT_ROWS с запасом перекрывает сегодняшнюю базу, MAX_ROWS — предохранитель
 * от чтения, которое не закончится: 50 000 строк это ~100 страниц SHM.
 */
const MAX_ROWS = 50_000;
const DEFAULT_ROWS = 20_000;

/**
 * Строк на корзину в ответе. Это ВЫБОРКА, а не находки целиком: полная длина
 * всегда есть в `counts`, а разбираться по одному клиенту — работа
 * client_overview и provisioning_diagnose. Полное покрытие не должно
 * превращать сводку в дамп таблицы.
 */
const SAMPLE_CAP = 20;

/**
 * Сколько кандидатов «услуга есть, пользователя панели нет» проверяется
 * точечно, когда окно панели неполно. Каждый кандидат стоит до трёх чтений
 * `by-username` (по одному на префикс), то есть 15 запросов из 30 доступных в
 * этом ведре.
 */
const CONFIRM_CAP = 5;

/**
 * Доля нечитаемых строк панели, начиная с которой корзины, построенные на
 * разности множеств, не выдаются вовсе. Ниже порога это отдельные испорченные
 * строки: находка теряет право на «полноту», но остаётся посчитанной с
 * поштучным подтверждением. На пороге и выше речь уже не о строках, а о том,
 * что схема ответа панели разошлась с тем, что читает инструмент, — и тогда
 * «в панели такого нет» невозможно отличить от «мы не сумели прочитать».
 *
 * 5% — заведомо выше нуля, который даёт исправно читаемая панель, и заведомо
 * ниже 100%, которые дала смена схемы 3.x. Точное значение внутри этого
 * коридора роли не играет: обе стороны отстоят от него на порядки.
 */
const UNUSABLE_SUSPECT_RATIO = 0.05;

/**
 * Словарь статусов панели — CreateUserRequestDto/GetAllUsersResponseDto:
 * ACTIVE, DISABLED, LIMITED, EXPIRED. Незнакомое значение здесь означает, что
 * панель обновилась, а этот инструмент — нет, и молчать об этом нельзя: любой
 * новый статус по умолчанию не попадёт ни в одну корзину.
 */
const PANEL_STATUSES: readonly string[] = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'];

const PANEL_ACTIVE = 'ACTIVE';
/**
 * Единственный статус, который SHM пишет сам и который противоречит активной
 * услуге: remnawave.tpl:645-646 ждёт ровно `"DISABLED"` после
 * `POST /api/users/{uuid}/actions/disable`.
 */
const PANEL_DISABLED = 'DISABLED';
/**
 * Месячный лимит трафика исчерпан. Это ШТАТНОЕ состояние, а не рассинхрон:
 * SHM сама провижинит `trafficLimitBytes` (по умолчанию 500 ГБ) и
 * `trafficLimitStrategy: MONTH` (remnawave.tpl:141-147, :354), а целые шаблоны
 * существуют, чтобы этот статус обслуживать (tempaltes/traffic_reset.tpl).
 * Услуга в SHM при этом законно ACTIVE.
 */
const PANEL_LIMITED = 'LIMITED';
/**
 * Против активной услуги — расхождение: панель ставится на `expire + 1260`
 * секунд (remnawave.tpl:216-217), то есть истекает на 21 минуту ПОЗЖЕ SHM, и
 * штатно такая пара возникнуть не может.
 */
const PANEL_EXPIRED = 'EXPIRED';

/** Core/Const.pm:46-54. Пользователя панели ждут только от активной услуги. */
const SHM_ACTIVE = 'ACTIVE';

/** `US_ID: <user_id>` из описания — remnawave.tpl:332 (это user.id, не us.id). */
const DESCRIPTION_USER_ID_RE = /US_ID:\s*(\d+)/;
/**
 * Первое поле описания — это `user.login`, а у зарегистрированного через
 * Telegram клиента логин выглядит как `@<chat_id>`. Форма строки целиком
 * (remnawave.tpl:332, разбор — ai-bot/src/services/remnaApi.ts:189):
 * `SHM_info- @<chat_id>, <full_name>, https://t.me/<handle>, US_ID: <user_id>`.
 * Границы обязательны: без них `@` из почтового логина вида
 * `user@123mail.com` дал бы выдуманный chat_id.
 */
const DESCRIPTION_CHAT_ID_RE = /(?:^|[\s,])@(\d+)(?=[\s,]|$)/;

interface ServiceRow {
  usi: number;
  userId: number | null;
  status: string;
}

interface PanelRow {
  /**
   * Первичный ключ пользователя панели. В Remnawave 3.x это ЧИСЛО (`id`), а
   * не uuid: поля `uuid` у объекта пользователя нет вовсе (проверено на
   * работающей 3.2.3 — 24 поля, uuid среди них отсутствует). 0 означает
   * «строка не адресуема» и выбрасывает её из сверки.
   */
  id: number;
  username: string | null;
  telegramId: number | null;
  status: string | null;
  /** user_service_id из имени пользователя панели — первичный ключ связи. */
  usi: number | null;
  /** user_id из `US_ID:` в описании — вторичный ключ. */
  descriptionUserId: number | null;
  /** chat_id из `@…` в описании — вместе с telegramId третий ключ. */
  descriptionChatId: number | null;
}

/** Услуга SHM и пользователь панели, связанные по user_service_id. */
interface Pair {
  service: ServiceRow;
  panel: PanelRow;
}

/** Корзина, которую не посчитали, и почему. Отсутствие ≠ пустота. */
interface Suppression {
  bucket: string;
  reason: string;
}

function usiFromUsername(username: string | null, prefixes: readonly string[]): number | null {
  if (username === null) return null;
  for (const prefix of prefixes) {
    if (!username.startsWith(prefix)) continue;
    const tail = username.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const usi = Number(tail);
    if (Number.isSafeInteger(usi) && usi > 0) return usi;
  }
  return null;
}

function matchedNumber(text: string | null, re: RegExp): number | null {
  if (text === null) return null;
  const found = re.exec(text);
  if (found === null) return null;
  const value = Number(found[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function toPanelRow(row: Record<string, unknown>, prefixes: readonly string[]): PanelRow {
  const username = str(row.username);
  const description = str(row.description);
  const telegramId = num(row.telegramId, Number.NaN);
  const id = num(row.id, Number.NaN);
  return {
    id: Number.isFinite(id) && id > 0 ? id : 0,
    username,
    telegramId: Number.isFinite(telegramId) ? telegramId : null,
    status: str(row.status),
    usi: usiFromUsername(username, prefixes),
    descriptionUserId: matchedNumber(description, DESCRIPTION_USER_ID_RE),
    descriptionChatId: matchedNumber(description, DESCRIPTION_CHAT_ID_RE),
  };
}

/**
 * Точечная проверка «пользователя панели действительно нет» — тем же способом,
 * которым его ищет provisioning_diagnose: по имени, собранному из известных
 * префиксов и user_service_id. 404 на by-username — это ответ «нет такого», а
 * не сбой (§6.16), и клиент отдаёт его как null.
 *
 * `true` — не найден ни под одним префиксом, `false` — найден (значит просто не
 * попал в окно), `null` — спросить не удалось.
 */
async function panelUserAbsent(
  ctx: ToolContext,
  usi: number,
  degraded: Degraded[],
  prefixes: readonly string[],
): Promise<boolean | null> {
  for (const prefix of prefixes) {
    const username = `${prefix}${String(usi)}`;
    const result = await settle(
      ctx.remna.get<unknown>(`/api/users/by-username/${encodeURIComponent(username)}`),
    );
    if (!result.ok) {
      noteOnce(degraded, 'remna', result.error);
      return null;
    }
    if (num(asRecord(result.value).id, 0) > 0) return false;
  }
  return true;
}

export const syncAudit = defineTool({
  name: 'sync_audit',
  description:
    'Batch reconciliation of SHM against the Remnawave panel. Both sides are paged to ' +
    'completeness, not sampled: `coverage` reports what each source said it holds, how much was ' +
    'read and whether that is all of it, including the panel page size the tool measured rather ' +
    'than assumed. The unit is the SERVICE, not the client: SHM creates one panel user per ' +
    'user_service_id, so a client with two services has two panel users. The join key is the ' +
    'panel username (HQVPN_<user_service_id>), with the US_ID in the description and the telegram ' +
    'id as fallbacks — telegramId alone is not a key, the provisioning template writes it only on ' +
    'CREATE and only when Telegram was already linked. Buckets are omitted, not emptied, when the ' +
    'data behind them is incomplete: an empty array means "looked and found none", an entry in ' +
    '`suppressed` means "could not look". Each bucket is a capped sample with the full size in ' +
    '`counts` — drill into one client with client_overview or provisioning_diagnose. Panel users ' +
    'that carry no identity at all land in `unlinkable`: a list to investigate, not to delete. ' +
    'The SHM storage snapshots (vpn_mrzb_*) are deliberately NOT read: that route is one GET per ' +
    'service with no batch form, i.e. one request per row of the population, so provisioning_' +
    'diagnose reads it for a single client and this tool does not read it at all.',
  input: z.object({
    limit: z
      .number()
      .int()
      .default(DEFAULT_ROWS)
      .describe('Safety ceiling on rows read per system; the default covers the whole install'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human'],
  // ОБЕ, и это не осторожность. Инструмент СВЕРЯЕТ две системы: без одной
  // из сторон сверять нечего, а «расхождений не найдено» на половине данных
  // — ровно тот уверенно неверный ответ, ради запрета которого он написан.
  backends: ['shm', 'remna'],
  handler: async ({ limit }, ctx) => {
    assertHumanOnly(
      ctx,
      'sync_audit is available to the human profile only: it reads the whole SHM install and ' +
        'the whole panel — every client, every service, every panel account — and hands back ' +
        'buckets whose recommendation is "delete this account". That is a bulk export and an ' +
        'operator decision, not an answer to one client question (§7.2).',
    );
    const cap = capLimit(limit, DEFAULT_ROWS, MAX_ROWS);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const suppressed: Suppression[] = [];

    /**
     * Ключ связи двух систем строится ИЗ ЭТОГО, поэтому спрашивается до чтения
     * обеих сторон, а не зашит: `<префикс><user_service_id>` — единственное,
     * чем услуга SHM и учётка панели соединяются, и неверный префикс превращает
     * всю сверку в «в панели нет никого».
     */
    const naming: PanelNaming = await resolvePanelNaming(ctx);
    const prefixes = naming.usernamePrefixes;

    const [servicePage, clientPage, blockedPage, panel] = await Promise.all([
      // Население сверки берётся ЗДЕСЬ, а не в /admin/user: провижинится
      // услуга, а не клиент, и у этого маршрута нет фильтра по block —
      // UserService::list_for_api (UserService.pm:437-442) добавляет только
      // parent=NULL и status!=REMOVED.
      readShmRows(ctx.shm, '/admin/user/service', {}, cap),
      readShmRows(ctx.shm, '/admin/user', {}, cap),
      // Второй половиной клиентов приходится спрашивать отдельно: User::_list
      // дописывает block=>0 во всякую выборку, где во where нет user_id
      // (User.pm:1205-1219), а user_id сюда передать нельзя — маршрутизатор
      // превращает его в switch_user (v1.cgi:1686). Тот же приём, что в
      // client_search.
      readShmRows(ctx.shm, '/admin/user', { filter: JSON.stringify({ block: 1 }) }, cap),
      readRemnaUserWindow(ctx.remna, cap),
    ]);

    for (const [system, page] of [
      ['shm', servicePage],
      ['shm', clientPage],
      ['shm', blockedPage],
      ['remna', panel],
    ] satisfies Array<[Degraded['system'], PagedRows]>) {
      if (page.error !== null) noteOnce(degraded, system, page.error);
    }

    /**
     * «С этим источником можно работать»: либо чтение прошло без ошибки, либо
     * оборвалось, но что-то успело приехать. Ноль строк ПОСЛЕ ошибки — это не
     * «ничего не нашлось», и пустая корзина на таком источнике соврала бы.
     */
    const usable = (page: PagedRows): boolean => page.error === null || page.rows.length > 0;

    const servicesOk = usable(servicePage);
    const panelOk = panel.error === null;
    const panelComplete = panel.complete;
    const shmComplete = servicePage.complete && clientPage.complete && blockedPage.complete;

    const serviceByUsi = new Map<number, ServiceRow>();
    for (const row of servicePage.rows) {
      // Number.NaN, а не 0: num() по умолчанию отдаёт ноль, и строка без
      // user_service_id склеилась бы с любой другой такой же в услугу №0.
      const usi = num(row.user_service_id, Number.NaN);
      if (!Number.isFinite(usi) || usi <= 0) continue;
      const userId = num(row.user_id, Number.NaN);
      serviceByUsi.set(usi, {
        usi,
        userId: Number.isFinite(userId) && userId > 0 ? userId : null,
        status: (str(row.status) ?? '').toUpperCase(),
      });
    }
    const services = [...serviceByUsi.values()];

    const knownUserIds = new Set<number>();
    const clientByTelegram = new Map<number, number>();
    const blockedUserIds = new Set<number>();
    for (const row of [...clientPage.rows, ...blockedPage.rows]) {
      const client = normalizeShmUser(row);
      if (client.user_id <= 0) continue;
      knownUserIds.add(client.user_id);
      if (client.telegram_id !== null) clientByTelegram.set(client.telegram_id, client.user_id);
      if (client.blocked) blockedUserIds.add(client.user_id);
    }
    // Услуга доказывает существование клиента даже там, где сам клиент в окно
    // не попал: без этого его пользователь панели уехал бы в сироты.
    for (const service of services) {
      if (service.userId !== null) knownUserIds.add(service.userId);
    }

    // Фильтр по block применяется сервером — но эта возможность не подтверждена
    // ни на одной настоящей строке клиента (§9.1). Если в «списке
    // заблокированных» есть незаблокированные, фильтр не сработал, и его
    // items — размер всей таблицы пользователей, а не число блокировок.
    const blockedFilterApplied = blockedPage.rows.every(
      (row) => normalizeShmUser(row).blocked === true,
    );

    // По id, а не как приехало: страница могла повториться при пагинации
    // (offset по меняющейся таблице), а строка без id не адресуема ничем и в
    // сверке участвовать не может. Схлопывание по id безопасно — это
    // первичный ключ панели, — но обе потери всё равно считаются поимённо:
    // `coverage.panelUsers.read` показывает СЫРОЕ число прочитанных строк, и
    // расхождение с ним не должно остаться без объяснения.
    const byId = new Map<number, PanelRow>();
    let unusablePanelRows = 0;
    let repeatedPanelRows = 0;
    for (const raw of panel.rows) {
      const row = toPanelRow(raw, prefixes);
      if (row.id === 0) {
        unusablePanelRows += 1;
        continue;
      }
      if (byId.has(row.id)) {
        repeatedPanelRows += 1;
        continue;
      }
      byId.set(row.id, row);
    }
    const panelRows = [...byId.values()];

    /**
     * Доля строк панели, которые сверка не смогла прочитать. Это и есть та
     * величина, из-за которой инструмент однажды выдал сотни уверенных
     * «перепровижинить клиента»: после смены схемы в Remnawave 3.x НИ ОДНА
     * строка панели не разобралась, `panelRows` оказался пуст, и каждая
     * активная услуга стала кандидатом на отсутствие пользователя панели.
     * Проверенные вручную аккаунты при этом отвечали 200.
     *
     * Здоровая панель даёт здесь ноль: `id` есть у каждой строки. Заметная
     * доля означает не грязь в данных, а РАСХОЖДЕНИЕ СХЕМ — мы читаем не то,
     * что панель отдаёт, — и разность множеств поверх остатка тогда не
     * доказательство отсутствия, а артефакт разбора.
     */
    const unusableRatio = panel.rows.length === 0 ? 0 : unusablePanelRows / panel.rows.length;
    const panelSchemaSuspect = unusableRatio >= UNUSABLE_SUSPECT_RATIO;

    /**
     * НИ ОДНО ИМЯ В ПАНЕЛИ НЕ СОБИРАЕТСЯ ИЗВЕСТНЫМ ПРЕФИКСОМ, ХОТЯ СОБИРАТЬСЯ
     * ДОЛЖНО.
     *
     * Ровно тот дефект, из-за которого зашитые префиксы отсюда и уехали: на
     * чужой инсталляции сверка не падала, а отвечала уверенно и неправильно.
     * `<префикс><user_service_id>` — единственный ключ связи услуги с учёткой,
     * поэтому промах по префиксу оставляет `pairs` пустым, и КАЖДАЯ активная
     * услуга становится кандидатом в missingPanelUser — список «перепровижинить
     * этого клиента», по форме не отличимый от настоящих находок. Механизм тот
     * же, что дал те самые сотни ложных находок, только причина другая: там
     * разъехалась схема ответа, здесь — соглашение об именах.
     *
     * Два условия, и второе не менее важно первого. Ноль совпадений — а не
     * доля: на работающей инсталляции совпадает подавляющее большинство (не
     * совпадают единицы — заведённые руками аккаунты, и это норма), поэтому
     * «не совпало НИ ОДНО» ложно сработать не может, а любой процентный порог
     * пришлось бы выдумывать. И при этом в SHM должна быть хоть одна АКТИВНАЯ
     * услуга: панель, где все учётки сделаны руками, про наши префиксы не
     * говорит ничего — ей просто нечего было именовать, — и обвинять настройку
     * там не в чем.
     *
     * `panelOk` обязателен по той же логике: на оборвавшемся чтении совпадающие
     * имена могли остаться в непрочитанной части, и обвинять настройку не в
     * чем — там уже стоит своё объяснение про недочитанную панель.
     */
    const prefixUnverified =
      panelOk &&
      panelRows.length > 0 &&
      services.some((service) => service.status === SHM_ACTIVE) &&
      !panelRows.some((row) => matchesKnownPrefix(row.username, prefixes));

    /**
     * Право заявлять отсутствие по разности множеств. Полнота ЧТЕНИЯ для этого
     * необходима, но недостаточна: она говорит, что панель отдала все строки, а
     * не что мы их поняли. Прежний код спрашивал только `panel.complete` — и
     * пропускал подтверждение ИМЕННО потому, что чтение удалось.
     */
    const panelAuthoritative = panelComplete && unusablePanelRows === 0;

    const orphans: PanelRow[] = [];
    const unlinkable: PanelRow[] = [];
    const unlistedService: PanelRow[] = [];
    const duplicatePanelUsers: PanelRow[] = [];
    const linkedOwner = new Map<number, number>();
    const pairByUsi = new Map<number, Pair>();

    /**
     * Владелец строки панели по вторичным ключам. Вынесено из веток, потому что
     * нужно ОБЕИМ: и той, что связывает строку без usi, и той, что откладывает
     * строку с невидимой услугой. Пока это жило только во второй половине
     * цикла, `continue` в ветке unlistedService выбрасывал владельца, и
     * blockedButActiveInPanel — самая острая находка инструмента, «клиент
     * заблокирован, а VPN работает» — молча переставала видеть ровно тех
     * клиентов, чью услугу листинг скрывает.
     */
    const ownerOf = (row: PanelRow): number | null => {
      if (row.descriptionUserId !== null && knownUserIds.has(row.descriptionUserId)) {
        return row.descriptionUserId;
      }
      // Оба chat_id, а не первый попавшийся: поле telegramId и `@…` в описании
      // заполняются в разные моменты и расходятся при смене аккаунта Telegram,
      // так что непопадание одного не отменяет второго.
      const byTelegram = [row.telegramId, row.descriptionChatId]
        .filter((chatId): chatId is number => chatId !== null)
        .map((chatId) => clientByTelegram.get(chatId))
        .find((userId) => userId !== undefined);
      return byTelegram ?? null;
    };

    /** Насколько имя каноничное: 0 — текущий префикс, дальше — наследные. */
    const prefixRank = (username: string | null): number => {
      if (username === null) return prefixes.length;
      const index = prefixes.findIndex((prefix) => username.startsWith(prefix));
      return index === -1 ? prefixes.length : index;
    };

    for (const row of panelRows) {
      const usi = row.usi;
      const service = usi === null ? undefined : serviceByUsi.get(usi);
      if (service !== undefined && usi !== null) {
        // Строка услуги без user_id тоже не должна стоить владельца: у неё есть
        // те же вторичные ключи, что и у непарной строки, и молчание здесь
        // выключило бы blockedButActiveInPanel ровно так же.
        const owner = service.userId ?? ownerOf(row);
        if (owner !== null) linkedOwner.set(row.id, owner);
        // Одна услуга — одна пара. Два пользователя панели на один
        // user_service_id (HQVPN_51 рядом с наследным us_51) — сам по себе
        // повод разобраться, но в статусные корзины услуга обязана попасть
        // один раз, иначе одна поломка выглядит как две. Выбор — по
        // каноничности имени, а не по порядку страниц: иначе при расхождении
        // статусов находка меняется от прогона к прогону.
        const existing = pairByUsi.get(usi);
        if (existing === undefined) {
          pairByUsi.set(usi, { service, panel: row });
          continue;
        }
        const replaces = prefixRank(row.username) < prefixRank(existing.panel.username);
        pairByUsi.set(usi, { service, panel: replaces ? row : existing.panel });
        duplicatePanelUsers.push(replaces ? existing.panel : row);
        continue;
      }
      const owner = ownerOf(row);
      if (owner !== null) linkedOwner.set(row.id, owner);
      if (usi !== null) {
        /**
         * Имя несёт id услуги, но услуги в листинге нет. Это НЕ «аккаунт без
         * владельца»: UserService::list_for_api по умолчанию скрывает детей
         * составных тарифов (parent != NULL) и удалённые услуги
         * (status = REMOVED) — фильтр живёт в SQL и в `items` не виден, поэтому
         * даже полностью вычитанный листинг про такую услугу молчит.
         *
         * Раньше такая строка проваливалась в orphanPanelUser, и клиент с
         * ребёнком составного тарифа получал «удалить этот аккаунт» РЯДОМ с
         * «перепровижинить эту услугу» — ровно то раздвоение, ради которого
         * ключом связи сделали username. Ветка ловит ВСЕ строки с разобранным
         * usi, а не только этот случай, поэтому дорога в сироты для них закрыта
         * целиком.
         */
        unlistedService.push(row);
        continue;
      }
      if (owner !== null) continue;
      // usi здесь заведомо null — строки с ним ушли выше.
      const hasAnyKey =
        row.descriptionUserId !== null ||
        row.telegramId !== null ||
        row.descriptionChatId !== null;
      if (hasAnyKey) orphans.push(row);
      else unlinkable.push(row);
    }
    const pairs = [...pairByUsi.values()];

    const statusOf = (row: PanelRow): string => (row.status ?? '').toUpperCase();
    const activePairs = pairs.filter((pair) => pair.service.status === SHM_ACTIVE);

    const statusMismatch = activePairs
      .filter((pair) => [PANEL_DISABLED, PANEL_EXPIRED].includes(statusOf(pair.panel)))
      .map((pair) => ({
        user_service_id: pair.service.usi,
        id: pair.panel.id,
        username: pair.panel.username,
        shmStatus: SHM_ACTIVE,
        panelStatus: pair.panel.status,
      }));

    const quotaExhausted = activePairs
      .filter((pair) => statusOf(pair.panel) === PANEL_LIMITED)
      .map((pair) => ({
        user_service_id: pair.service.usi,
        id: pair.panel.id,
        username: pair.panel.username,
      }));

    const blockedButActiveInPanel = panelRows
      .filter((row) => statusOf(row) === PANEL_ACTIVE)
      .map((row) => ({ row, owner: linkedOwner.get(row.id) }))
      .filter(
        (one): one is { row: PanelRow; owner: number } =>
          one.owner !== undefined && blockedUserIds.has(one.owner),
      )
      .map((one) => ({
        user_id: one.owner,
        // Только когда за именем действительно стоит строка услуги. Для
        // hand-made или переименованного аккаунта вроде us_2024 число — это
        // разбор имени и ничего больше, а предупреждение про unlistedService
        // ровно это и оговаривает. Действовать всё равно по id.
        user_service_id:
          one.row.usi !== null && serviceByUsi.has(one.row.usi) ? one.row.usi : null,
        id: one.row.id,
        username: one.row.username,
      }));

    // Пользователя панели ждут только от активной услуги: у BLOCK/NOT PAID/INIT
    // конфига и не должно быть, а PROGRESS — это работа в процессе.
    const withPanelUser = new Set(pairs.map((pair) => pair.service.usi));
    const candidates = services.filter(
      (service) => service.status === SHM_ACTIVE && !withPanelUser.has(service.usi),
    );

    let missingPanelUser: ServiceRow[] = [];
    let unverifiedCandidates = 0;
    if (panelAuthoritative) {
      missingPanelUser = candidates;
    } else if (panelOk) {
      // Окно панели неполно, поэтому «в окне нет» ещё не значит «в панели нет»:
      // каждый кандидат проверяется точечно, и находкой становится только
      // подтверждённый. Непроверенные не превращаются в рекомендацию
      // «перепровижинить» — они считаются отдельно.
      const head = candidates.slice(0, CONFIRM_CAP);
      unverifiedCandidates = candidates.length - head.length;
      for (const [index, service] of head.entries()) {
        const absent = await panelUserAbsent(ctx, service.usi, degraded, prefixes);
        // Отказ на подтверждении — это почти всегда исчерпанный бюджет или 429,
        // то есть состояние, из которого следующие четыре чтения выйдут так же.
        // Досиживать его до конца значит жечь ведро ради тех же «не знаю».
        if (absent === null) {
          unverifiedCandidates += head.length - index;
          break;
        }
        if (absent) missingPanelUser.push(service);
      }
    }

    const suppress = (bucket: string, reason: string): void => {
      suppressed.push({ bucket, reason });
    };
    /**
     * Обе корзины ниже — разность множеств поверх строк панели, и обе несут
     * необратимую рекомендацию: «перепровижинить клиента» и «удалить аккаунт».
     * Если строки панели массово не разобрались, остаток — не множество, с
     * которым можно вычитать: ровно это однажды дало сотни ложных
     * «перепровижинить» на пустом наборе строк.
     */
    const schemaReason =
      `${String(unusablePanelRows)} of ${String(panel.rows.length)} panel rows could not be ` +
      'read (no usable `id`), which is a schema mismatch rather than dirty data — a set ' +
      'difference over the rows that survived would report absence that is really a parsing ' +
      'failure, and its remedy is destructive. Fix the panel row mapping before trusting this ' +
      'bucket; the individual answer is still available from provisioning_diagnose.';
    /**
     * Тот же довод, что и у schemaReason: строки прочитаны и разобраны, но
     * ключ связи к ним не подходит, поэтому разность множеств измеряет наше
     * незнание имён, а не состояние систем.
     *
     * Гасит она ОДНУ корзину — missingPanelUser, — и это не осторожность
     * наполовину. Сирота определяется вторичными ключами (US_ID в описании,
     * telegram id), которых префикс не касается вовсе; учётка, которую он
     * спас бы, вторичных ключей как раз не несёт и попадает в `unlinkable` —
     * корзину, которая и без того говорит «выяснить, а не удалять».
     */
    const prefixReason =
      `not one of the ${String(panelRows.length)} panel accounts has a username built from any ` +
      `known prefix (${prefixes.join(', ')} — ` +
      `${prefixSourcePhrase(naming.usernamePrefixesFrom, PANEL_PREFIXES_VAR)}), while SHM does ` +
      'list active services that provisioning would have named. The join key of this audit is ' +
      '`<prefix><user_service_id>`, so with the wrong prefix every one of those services looks ' +
      'unprovisioned. That is a configuration answer, not a finding: set ' +
      `${PANEL_PREFIXES_VAR} to the prefixes this panel actually uses, or set ` +
      'config.remnawave.name_prefix in SHM, which is where this tool reads it from.';
    const showMissing = servicesOk && panelOk && !panelSchemaSuspect && !prefixUnverified;
    if (!showMissing) {
      suppress(
        'missingPanelUser',
        !servicesOk
          ? 'the SHM service listing did not answer, so there is nothing to look for'
          : panelSchemaSuspect
            ? schemaReason
            : prefixUnverified
              ? prefixReason
              : 'the panel read did not finish, and "no panel user" cannot be claimed from a read ' +
                'that broke — nor confirmed one by one, since the lookups would hit the same refusal',
      );
    }
    const showOrphans = panelOk && shmComplete && !panelSchemaSuspect;
    if (!showOrphans) {
      suppress(
        'orphanPanelUser',
        panelSchemaSuspect
          ? schemaReason
          : !panelOk
          ? // «Оборвалось на середине» и «не ответило вовсе» — разные состояния
            // с разными действиями, и называть второе первым значит послать
            // читателя искать половину ответа, которой нет.
            panel.rows.length > 0
            ? `the panel read broke after ${String(panel.rows.length)} rows, and a half-read ` +
              'panel cannot show who owns what'
            : 'the panel did not answer at all, so there is nothing to compare against'
          : 'the SHM side is incomplete (a failed call or a partial read), so a panel user whose ' +
            'owner is simply outside the covered range would be reported as owned by nobody',
      );
    }
    // Требует ПОЛНОСТЬЮ прочитанного листинга услуг: на частичном чтении «услуги
    // нет в листинге» означало бы всего лишь «мы до неё не дошли».
    const showUnlisted = servicePage.complete && usable(panel);
    if (!showUnlisted) {
      suppress(
        'unlistedService',
        'the service listing was not read in full, so "the listing does not show this service" ' +
          'cannot be told apart from "we did not get that far"',
      );
    }
    const showPairs = servicesOk && panelOk;
    if (!showPairs) {
      suppress(
        'statusMismatch',
        'a service and its panel user must both be read before their statuses can be compared',
      );
      suppress('quotaExhausted', 'the same pair of sources is missing');
    }
    // Единственная корзина без зависимости от полноты: она про саму строку
    // панели, поэтому её видно и на наполовину прочитанной панели.
    const showUnlinkable = panelOk || panel.rows.length > 0;
    const showBlocked = usable(blockedPage) && panelOk;
    if (!showBlocked) {
      suppress(
        'blockedButActiveInPanel',
        'the blocked-client listing or the panel did not answer, so "blocked but still connected" ' +
          'cannot be established',
      );
    }

    /**
     * «Прочитано частично» и «не ответило вовсе» — разные состояния с разными
     * действиями, и одно общее «read only in part» на три источника называет
     * вторым первое. `items === null` при ошибке означает, что не удалась ПЕРВАЯ
     * страница, то есть источник не сказал ничего; `items === null` без ошибки —
     * что счётчика не прислали и полноту не установить ни в одну сторону.
     */
    const readPhrase = (label: string, page: PagedRows): string => {
      if (page.items !== null) return `${label}: ${String(page.rows.length)} of ${String(page.items)}`;
      return page.error === null
        ? `${label}: ${String(page.rows.length)} rows, no count reported`
        : `${label}: did not answer`;
    };
    const coveredPhrase = [
      readPhrase('services', servicePage),
      readPhrase('clients', clientPage),
      readPhrase('blocked clients', blockedPage),
    ];

    if (!shmComplete && servicePage.error === null) {
      warnings.push(
        warn(
          'shm_not_fully_read',
          `The SHM side is not fully covered — ${coveredPhrase.join('; ')}. ` +
            'Listings are paged newest-first (SHM orders by the table key ' +
            'descending), so what is covered is the newest rows and what is missing is the oldest. ' +
            'The orphan bucket is suppressed rather than computed from a slice — outside the ' +
            'covered range every panel user looks unowned.',
        ),
      );
    }
    if (!panelComplete && usable(panel)) {
      warnings.push(
        warn(
          'panel_not_fully_read',
          panel.items === null
            ? `The panel returned ${String(panel.rows.length)} users at ` +
              `${String(panel.pageSize)} rows per request but did not report a total, so whether ` +
              'that is all of them cannot be established either way. A panel that silently caps a ' +
              'page looks identical to one that ran out of rows, so completeness is not assumed: ' +
              'findings that need the whole panel are confirmed one by one or suppressed.'
            : `The panel was read only in part: ${String(panel.rows.length)} of ` +
              `${String(panel.items)} users, at ${String(panel.pageSize)} rows per request. ` +
              'Findings that need the whole panel are confirmed one by one or suppressed.',
        ),
      );
    }
    if (prefixUnverified) {
      warnings.push(
        warn(
          'prefix_unverified',
          'The panel was read and understood, and ' +
            `${prefixReason} This is the difference between "we looked and found none" and "we ` +
            'looked under the wrong names", and it is why `missingPanelUser` is suppressed rather ' +
            'than returned. Read the surviving buckets the same way: everything in `unlinkable` ' +
            'is an account whose name this tool could not parse, which is a statement about the ' +
            'configured prefixes and not about the account.',
        ),
      );
    }
    if (unverifiedCandidates > 0) {
      warnings.push(
        warn(
          'missing_panel_user_unverified',
          `${String(unverifiedCandidates)} services look like they have no panel user, but that ` +
            'was not verified — only the first ' +
            `${String(CONFIRM_CAP)} candidates get a targeted lookup, and the rest are absent ` +
            'from `missingPanelUser` on purpose. Re-provisioning on an unverified candidate ' +
            'creates a duplicate; run provisioning_diagnose on the specific service instead.',
        ),
      );
    }
    const sampled = (
      [
        ['missingPanelUser', showMissing ? missingPanelUser.length : 0],
        ['orphanPanelUser', showOrphans ? orphans.length : 0],
        ['unlinkable', showUnlinkable ? unlinkable.length : 0],
        ['unlistedService', showUnlisted ? unlistedService.length : 0],
        ['statusMismatch', showPairs ? statusMismatch.length : 0],
        ['quotaExhausted', showPairs ? quotaExhausted.length : 0],
        ['blockedButActiveInPanel', showBlocked ? blockedButActiveInPanel.length : 0],
      ] satisfies Array<[string, number]>
    ).filter(([, size]) => size > SAMPLE_CAP);
    if (sampled.length > 0) {
      warnings.push(
        warn(
          'findings_sampled',
          `Some buckets hold more findings than this summary prints: ` +
            `${sampled.map(([name, size]) => `${name} ${String(size)}`).join(', ')}. ` +
            `Each list is the first ${String(SAMPLE_CAP)} rows; \`counts\` carries the full ` +
            'length. This tool answers "how much and of what kind" — drill into a specific ' +
            'client with client_overview or provisioning_diagnose rather than expecting the ' +
            'whole set here.',
        ),
      );
    }
    if (duplicatePanelUsers.length > 0) {
      warnings.push(
        warn(
          'duplicate_panel_users',
          `${String(duplicatePanelUsers.length)} panel users name a service that another panel ` +
            'user already claims — the same user_service_id under two usernames, e.g. HQVPN_51 ' +
            'beside a legacy us_51. Each service is compared once, against the canonically-named ' +
            `account (the earliest of ${prefixes.join(', ')} its name matches), ` +
            'whatever order the pages arrived in — so one desync is not reported as two, and the ' +
            'status above came from that account rather than from whichever the panel listed ' +
            'first. The other accounts are real and still work: confirm which one the client ' +
            'actually uses before touching either.',
        ),
      );
    }
    if (repeatedPanelRows > 0) {
      warnings.push(
        warn(
          'panel_rows_repeated',
          `${String(repeatedPanelRows)} panel rows repeated an id already seen and were counted ` +
            'once. Offset paging over a live table re-reads rows when the set shifts underneath, ' +
            'so this is expected rather than alarming; id is the panel primary key, so ' +
            'collapsing on it cannot merge two different accounts.',
        ),
      );
    }
    if (unusablePanelRows > 0) {
      warnings.push(
        warn(
          'panel_rows_unusable',
          `${String(unusablePanelRows)} of ${String(panel.rows.length)} panel rows arrived ` +
            'without a usable `id` and take no part in this audit — they cannot be addressed, ' +
            'matched or acted on. They are still counted in coverage.panelUsers.read, which is ' +
            'the raw number of rows read; coverage.panelUsers.usable is what survived. A healthy ' +
            'panel loses none of them, so a large share here means the response schema moved ' +
            'and this tool is reading the wrong field, not that the accounts are malformed.',
        ),
      );
    }
    if (unlistedService.length > 0 && showUnlisted) {
      warnings.push(
        warn(
          'panel_users_for_unlisted_services',
          `${String(unlistedService.length)} panel users name a service the SHM listing does not ` +
            'show, so these are NOT orphans and must never be deleted on that basis. Three causes ' +
            'produce it and they need opposite actions: a child of a composite tariff (leave it ' +
            'alone), a REMOVED service whose panel user outlived it (a real leftover), or an ' +
            'account whose name merely parses under a legacy prefix — us_2024 reads as service ' +
            '2024 — which may be hand-made or renamed and belong to no service at all. Check with ' +
            'GET /admin/user/service?filter={"user_service_id":N}: naming the table key in the ' +
            'filter is what makes SHM skip its own parent/status defaults, so that call returns ' +
            'the row with its real status and parent. A plain listing — including service_inspect, ' +
            'which reads one — applies those defaults and answers with silence, which is exactly ' +
            'the "no such service, delete the account" conclusion this bucket exists to prevent.',
        ),
      );
    }
    if (unlinkable.length > 0) {
      warnings.push(
        warn(
          'unlinkable_is_not_orphan',
          `${String(unlinkable.length)} panel users carry no username with a service id, no ` +
            'telegram id and no US_ID in their description, so this audit cannot say who owns ' +
            'them. That is not evidence that nobody does — hand-made and test accounts look ' +
            'exactly like this. Identify them before deleting anything.',
        ),
      );
    }
    if (quotaExhausted.length > 0) {
      warnings.push(
        warn(
          'quota_exhausted_is_not_desync',
          `${String(quotaExhausted.length)} panel users are LIMITED, i.e. they used up the ` +
            'monthly traffic allowance SHM itself provisions (500 GB by default, strategy ' +
            'MONTH). Their services are legitimately ACTIVE and they are reported apart from ' +
            'statusMismatch so that ordinary quota exhaustion does not drown the real desync.',
        ),
      );
    }
    const unknownStatuses = [
      ...new Set(
        panelRows.map(statusOf).filter((status) => status !== '' && !PANEL_STATUSES.includes(status)),
      ),
    ];
    if (unknownStatuses.length > 0) {
      warnings.push(
        warn(
          'unknown_panel_status',
          `The panel returned statuses this tool does not know: ${unknownStatuses.join(', ')}. ` +
            'They fall into no bucket at all, so treat the status findings as incomplete until ' +
            'the vocabulary here is updated.',
        ),
      );
    }
    if (!blockedFilterApplied) {
      warnings.push(
        warn(
          'blocked_filter_not_applied',
          'The blocked-client listing came back containing unblocked clients, so ' +
            'filter={"block":1} did not narrow it on this SHM build. Only the rows that carry ' +
            'block=1 themselves were counted as blocked, which means the blocked half of this ' +
            'audit covers the head of the users table rather than every blocked client.',
        ),
      );
    }
    // Безусловно: этот листинг никогда не сужается до одной услуги на стороне
    // SHM, поэтому UserService::list_for_api каждый раз применяет свои
    // умолчания where.parent=NULL и where.status!=REMOVED (UserService.pm:
    // 440-441). Здесь эта слепота искажает не одну карточку, а заголовочные
    // числа сверки.
    warnings.push(
      warn(
        'excludes_children_and_removed',
        'The service listing never includes child services of composite tariffs (parent != NULL) ' +
          'or removed services (status=REMOVED) — SHM applies that filter by default and this ' +
          'tool has no way to override it. A panel user belonging to a child or removed service ' +
          'therefore has no counterpart here, and totals.services undercounts by the same rows.',
      ),
    );
    warnings.push(
      warn(
        // НЕ `blocked_hidden`: тем кодом client_search говорит ровно
        // противоположное — «заблокированных в этом ответе НЕТ». Здесь они
        // есть, просто приехали вторым запросом, и один код на два
        // несовместимых смысла учит модель неправде в одном из двух мест.
        'blocked_read_separately',
        'SHM appends block=0 to any listing whose where has no user_id, so /admin/user shows ' +
          'unblocked clients only and blocked ones are read by a second, filtered call — they ' +
          'ARE part of this audit. Blocking a client cascades neither to their services nor to ' +
          'the panel, which is why `blockedButActiveInPanel` exists at all.',
      ),
    );
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A source did not answer (see `degraded`). Every bucket that depended on it is listed ' +
            'in `suppressed` and absent from `findings` rather than returned empty: an empty ' +
            'array here means the audit looked and found nothing, and neither "delete this panel ' +
            'account" nor "re-provision this client" is ever inferred from a source that stayed ' +
            'silent.',
        ),
      );
    }

    const missingRows = missingPanelUser.map((service) => ({
      user_service_id: service.usi,
      user_id: service.userId,
      status: service.status,
      expectedUsername: `${prefixes[0] ?? ''}${String(service.usi)}`,
    }));
    const orphanRows = orphans.map((row) => ({
      id: row.id,
      username: row.username,
      telegramId: row.telegramId,
      status: row.status,
      /**
       * Имя поля — НЕ `key`. Страховочная редакция маскирует по имени
       * (@hq/redact: /token|secret|key|password|auth/i), слово `key` матчится
       * буквально, и в каждом настоящем ответе здесь лежал бы '<redacted>' —
       * ровно в той корзине, чья рекомендация «удалить этот аккаунт», и ровно
       * в поле, которое одно и объясняет, ПОЧЕМУ строка сочтена сиротой.
       *
       * Ветки `user_service_id` тут быть не может: строку с разобранным usi
       * забирает `unlistedService` выше по циклу и делает `continue`, так что
       * до сирот доезжают только строки с usi === null.
       */
      matchedBy: row.descriptionUserId !== null ? 'user_id' : 'telegram_id',
    }));
    const unlistedRows = unlistedService.map((row) => ({
      user_service_id: row.usi,
      // Владелец обязателен: без него проверку, которую называет предупреждение,
      // не с чем запустить, а сама строка не соотносится ни с одним клиентом.
      user_id: linkedOwner.get(row.id) ?? null,
      id: row.id,
      username: row.username,
      telegramId: row.telegramId,
      // Статус в ПАНЕЛИ, а не в биллинге: он отличает живой остаток от
      // REMOVED-услуги от инертного, и прописанная в предупреждении проверка
      // его не заменяет — она возвращает статус услуги, а не аккаунта.
      status: row.status,
    }));
    const unlinkableRows = unlinkable.map((row) => ({
      id: row.id,
      username: row.username,
      telegramId: row.telegramId,
      status: row.status,
    }));

    // `items: null` — «сервер не сказал», а не ноль: на источнике, чьё первое
    // чтение не удалось, `0` читалось бы как «услуг нет».
    const cover = (page: PagedRows): { items: number | null; read: number; complete: boolean } => ({
      items: page.items,
      read: page.rows.length,
      complete: page.complete,
    });

    return {
      coverage: {
        services: cover(servicePage),
        unblockedClients: cover(clientPage),
        blockedClients: {
          ...cover(blockedPage),
          // Число заблокированных имеет смысл только если фильтр действительно
          // сузил выборку; иначе items — размер всей таблицы пользователей.
          ...(blockedFilterApplied ? {} : { items: null }),
        },
        panelUsers: {
          ...cover(panel),
          /**
           * Сколько строк сверка смогла прочитать. `read` — сырое число
           * приехавших строк, и оно честное; но полное чтение, из которого не
           * разобралась ни одна строка, — это `read: N, usable: 0`, и без
           * второго числа `complete: true` рядом с корзиной, посчитанной по
           * нулю строк, было бы тем же завышением уровнем выше.
           */
          usable: panelRows.length,
          /** Измеренный, а не заданный: сколько строк панель отдаёт за запрос. */
          pageSize: panel.pageSize,
        },
      },
      /**
       * `panel` здесь — право на разность множеств, а не факт дочитанности:
       * прочитанные, но неразобранные строки полноту не дают. Сырая полнота
       * чтения осталась в `coverage.panelUsers.complete`.
       */
      complete: { shm: shmComplete, panel: panelAuthoritative },
      findings: {
        ...(showMissing ? { missingPanelUser: missingRows.slice(0, SAMPLE_CAP) } : {}),
        ...(showOrphans ? { orphanPanelUser: orphanRows.slice(0, SAMPLE_CAP) } : {}),
        // Не гейтится ничем со стороны SHM: «в имени нет id услуги, telegram id
        // пуст и описание пусто» — свойство самой строки панели, а не разницы
        // множеств, и половина панели не делает это утверждение ложным.
        ...(showUnlinkable ? { unlinkable: unlinkableRows.slice(0, SAMPLE_CAP) } : {}),
        ...(showUnlisted ? { unlistedService: unlistedRows.slice(0, SAMPLE_CAP) } : {}),
        ...(showPairs
          ? {
              statusMismatch: statusMismatch.slice(0, SAMPLE_CAP),
              quotaExhausted: quotaExhausted.slice(0, SAMPLE_CAP),
            }
          : {}),
        ...(showBlocked
          ? { blockedButActiveInPanel: blockedButActiveInPanel.slice(0, SAMPLE_CAP) }
          : {}),
      },
      counts: {
        ...(showMissing ? { missingPanelUser: missingRows.length } : {}),
        ...(unverifiedCandidates > 0 ? { unverifiedMissingCandidates: unverifiedCandidates } : {}),
        ...(showOrphans ? { orphanPanelUser: orphanRows.length } : {}),
        ...(showUnlinkable ? { unlinkable: unlinkableRows.length } : {}),
        ...(showUnlisted ? { unlistedService: unlistedRows.length } : {}),
        ...(showPairs
          ? { statusMismatch: statusMismatch.length, quotaExhausted: quotaExhausted.length }
          : {}),
        ...(showBlocked ? { blockedButActiveInPanel: blockedButActiveInPanel.length } : {}),
      },
      suppressed,
      warnings,
      degraded,
    };
  },
});
