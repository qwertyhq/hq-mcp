import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  PANEL_PREFIXES_VAR,
  asArray,
  asRecord,
  num,
  prefixSourcePhrase,
  settle,
  shmUserExistsParams,
  str,
  take,
  telegramIdOf,
  warn,
} from '../kit.js';
import type { PanelNaming } from '../kit.js';
import { resolveServicePanel } from '../provisioning/diagnose.js';

export interface ShmUserMatch {
  user_id: number;
  login: string | null;
  email: string | null;
  full_name: string | null;
  telegram_id: number | null;
  balance: number | null;
  blocked: boolean;
}

/**
 * Идентификатор пользователя панели в Remnawave 3.x — ЧИСЛО. Поля `uuid` у
 * объекта пользователя больше нет вовсе (проверено на работающей 3.2.3: 24 поля,
 * uuid среди них нет), и все адресуемые ручки — /api/users/{id},
 * /api/hwid/devices/{id}, /api/users/{id}/subscription-request-history —
 * ходят по нему.
 *
 * `shortUuid` наружу НЕ отдаётся, хотя в ответе панели он есть: это секретная
 * часть ссылки подписки, и @hq/redact режет её по §7.2 (TAIL_MASK_KEYS,
 * maskTail с keep=24 по 16-символьному значению даёт сплошные звёздочки).
 * Поле из шестнадцати звёздочек не идентификатор, а приглашение «сверьте
 * shortUuid с клиентом», которое выполнить нельзя. Сверяются по `id`.
 */
export interface RemnaUserMatch {
  id: number;
  username: string | null;
  telegramId: number | null;
  status: string | null;
  /**
   * Каким путём аккаунт найден. Не украшение: `telegram_id` и `service` — это
   * два РАЗНЫХ множества, и разница между ними и есть содержание дефекта,
   * ради которого поле появилось (см. PANEL_PATHS ниже).
   */
  via: PanelPathName;
  /** Для `via: 'service'` — услуга SHM, через которую аккаунт найден. */
  user_service_id: number | null;
  /**
   * ЧЕЙ ЭТО АККАУНТ — по версии обхода услуг, а не по догадке.
   *
   * Текстовый запрос возвращает до 25 клиентов SHM, и обход услуг идёт по
   * первым из них, поэтому на коротком числовом запросе в `remna.matches`
   * оказываются панельные аккаунты нескольких РАЗНЫХ посторонних клиентов,
   * подписанные общим «эти аккаунты настоящие, не заводите дубль». Без имени
   * владельца такой список читается как «аккаунты того, кого искали», и
   * оператор отвечает не тому человеку.
   *
   * `null` у пути по идентификатору — намеренно: панель нашла аккаунт по своему
   * полю, и связать его с клиентом SHM можно только предположением. Подставить
   * сюда единственного найденного клиента значило бы выдать догадку за факт.
   */
  shm_user_id: number | null;
}

/**
 * НАСКОЛЬКО ТОЧНО СТРОКА SHM ОТВЕЧАЕТ НА ЗАПРОС. Меньше — точнее.
 *
 * `/admin/user/search` — подстрочный поиск с сортировкой по ключу таблицы вниз,
 * и точное совпадение в его выдаче не всплывает никуда: владелец искомого
 * логина оказывается последним среди тех, кто содержит его подстрокой, а
 * короткий числовой запрос выносит из окна вовсе — там всякий, в чьём id или
 * телеграм-логине встречаются эти цифры. Последствие тяжелее косметики: обход
 * панели идёт по ПЕРВЫМ MAX_CLIENTS_WALKED строкам, то есть панельная половина
 * ответа собирается по чужим людям.
 */
function exactness(match: ShmUserMatch, q: string, numeric: boolean): number {
  const wanted = q.toLowerCase();
  const login = match.login?.toLowerCase() ?? null;
  const email = match.email?.toLowerCase() ?? null;
  if (numeric && match.user_id === Number(q)) return 0;
  if (numeric && match.telegram_id === Number(q)) return 1;
  // `@<telegram id>` в колонке login против того же числа в запросе — одна и
  // та же строка, записанная так, как её пишет телеграм-регистрация SHM.
  if (login === wanted || email === wanted || login === `@${wanted}`) return 2;
  return 3;
}

/** Сортировка устойчивая: внутри одной точности порядок SHM сохраняется. */
function byExactness(matches: ShmUserMatch[], q: string, numeric: boolean): ShmUserMatch[] {
  return matches
    .map((match, index) => ({ match, index, rank: exactness(match, q, numeric) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((one) => one.match);
}

/**
 * Пути поиска в панели. Отдаются НАРУЖУ вместе с ответом, потому что
 * `count: 0` без них — это утверждение «аккаунта нет», которого никто не
 * делал: у него всегда есть невысказанная оговорка «там, где мы искали».
 */
export type PanelPathName = 'telegram_id' | 'email' | 'username' | 'service';

export interface PanelPathReport {
  path: PanelPathName;
  /** Путь пройден. `false` — не проходили вовсе, причина в `note`. */
  tried: boolean;
  /** Сколько аккаунтов нашёл ИМЕННО этот путь (пересечения не вычитаются). */
  found: number;
  /** Чего путь не покрывает или почему не пройден. `null` — прошёл начисто. */
  note: string | null;
}

/** Сколько строк просим у stream за раз: один telegram id держит единицы юзеров. */
const STREAM_PAGE = 100;

/**
 * Сколько клиентов SHM обходим по услугам. Резолв точного идентификатора
 * возвращает одного; широкий текстовый запрос — до 25, и обход услуг для
 * каждого превратил бы резолвер в обход биллинга. Больше этого числа — путь
 * НЕ проходится, и об этом говорится вслух, а не молча.
 */
const MAX_CLIENTS_WALKED = 3;

/**
 * Потолок проверок «услуга → аккаунт панели» на один вызов. Каждая стоит два
 * запроса (чтение снапшота в SHM и карточка в панели), а общий гейт — 30
 * запросов в минуту на ключ ведра (packages/env: HQ_MCP_BUDGET_LIMIT), причём
 * все эти чтения схлопываются в ДВА ключа (`shm:GET:/admin/storage/manage/*`
 * и `remna:GET:/api/users/:id`). Восемь оставляют резолверу запас на
 * повторные вызовы в том же окне.
 */
const SERVICE_PROBE_BUDGET = 8;

/** Окно списка услуг клиента. */
const SERVICES_PAGE = 25;

/**
 * Чего НЕ видит обход по услугам, при любом исходе. Живёт одной строкой,
 * потому что повторяется и в отчёте о пути, и в предупреждении о пустом
 * ответе — а разъехавшись, эти две формулировки стали бы двумя разными
 * обещаниями об одном и том же.
 */
const SERVICE_PATH_BLIND_SPOT =
  'GET /admin/user/service never lists child services of composite tariffs (parent != NULL) or ' +
  'removed ones (status=REMOVED) — SHM applies that filter itself — so a panel account left ' +
  'behind by a removed service is invisible to this path';

/** Строка SHM разнородна: settings то объект, то JSON-строка; email лежит в login2. */
export function normalizeShmUser(row: Record<string, unknown>): ShmUserMatch {
  const balance = num(row.balance, Number.NaN);
  return {
    user_id: num(row.user_id ?? row.id, 0),
    login: str(row.login),
    email: str(row.login2 ?? row.email),
    full_name: str(row.full_name),
    telegram_id: telegramIdOf(row),
    balance: Number.isFinite(balance) ? balance : null,
    blocked: row.block === 1 || row.block === true || row.block === '1',
  };
}

function normalizeRemnaUser(row: Record<string, unknown>, via: PanelPathName): RemnaUserMatch {
  const telegramId = num(row.telegramId, Number.NaN);
  const id = num(row.id, Number.NaN);
  return {
    id: Number.isFinite(id) && id > 0 ? id : 0,
    username: str(row.username),
    telegramId: Number.isFinite(telegramId) ? telegramId : null,
    status: str(row.status),
    via,
    user_service_id: null,
    shm_user_id: null,
  };
}

/**
 * ЧЕГО ИМЕННО НЕ ВИДИТ ПУТЬ ПО ИДЕНТИФИКАТОРУ — по каждому пути своя правда.
 *
 * Раньше здесь стояла одна фраза на все три: «обычная причина — пустой
 * `telegramId` на панельном аккаунте». Для email-пути она неверна: `telegramId`
 * у такого аккаунта бывает заполнен, и поиск ПО НЕМУ его находит — не срабатывает
 * именно email, потому что провижининг не пишет его в панель.
 */
function identifierBlindSpot(via: PanelPathName): string {
  if (via === 'telegram_id') {
    return 'the panel writes `telegramId` at creation only and only when Telegram was already ' +
      'linked, so an account created before the client linked it carries null there and this ' +
      'lookup cannot see it';
  }
  if (via === 'email') {
    return 'the panel has its own `email` field and SHM provisioning does not fill it — on this ' +
      'installation panel accounts carry null there, so an email lookup misses accounts that a ' +
      'telegram-id lookup finds';
  }
  return 'panel usernames are built from the user_service_id (<prefix><usi>), not from the SHM ' +
    'login or email, so a by-username lookup only matches when the caller already typed the ' +
    'panel name';
}

export const clientResolve = defineTool({
  name: 'client_resolve',
  description:
    'Turn any identifier (telegram id, email, SHM login, user_id, Remnawave username) into the ' +
    'canonical ids of both systems. Returns every match — one telegram id can carry several ' +
    'Remnawave users, and picking the first one silently is how support answers the wrong person. ' +
    'The panel is searched twice: by the identifier itself and through the SHM services of every ' +
    'client matched, because an account whose `telegramId` the panel never recorded is invisible ' +
    'to the first path. `remna.paths` names every lookup that ran and what it cannot see, so ' +
    '`count: 0` is never mistaken for "this client has no panel account".',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('telegram id, email, SHM login, SHM user_id or Remnawave username'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  // Только SHM. Панельные пути объявлены отдельно (`panelPaths`) и на
  // установке без панели помечаются непройденными с причиной — то есть
  // `count: 0` по ним не утверждается никогда.
  backends: ['shm'],
  handler: async ({ query }, ctx) => {
    const q = query.trim();
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const numeric = /^\d+$/.test(q);
    const looksLikeEmail = q.includes('@') && !q.startsWith('@');
    /**
     * Есть ли в этом развёртывании панель вообще. Когда её нет, ни один из двух
     * панельных путей НЕ ПРОХОДИТСЯ — не «проходится и не находит»: обход услуг
     * стоит двух запросов к SHM на услугу и искал бы аккаунты в системе,
     * которой здесь не существует. Пути честно помечаются непройденными с
     * причиной, и `count: 0` по ним не утверждает ничего.
     */
    const panelOn = ctx.backends.remna;

    /**
     * Маршрут поиска в панели, выверенный на работающей 3.2.3.
     * by-telegram-id и by-email УДАЛЕНЫ — они отвечают роутерным 404, который
     * @hq/remna теперь громко бросает, а не выдаёт за отсутствие. Их замена —
     * /api/users/stream с ТОЧНЫМИ фильтрами: `telegramId=1` возвращает ноль
     * строк, а не всех, чей id начинается с единицы, — проверено.
     *
     * by-username остался живым и остаётся ТОЧНЫМ совпадением, поэтому имя
     * ищется им, а не `stream?username=`: последний фильтрует ПОДСТРОКОЙ (на
     * работающей панели одно имя вернуло два десятка разных строк), и «резолв»
     * имени превратился бы в поиск.
     */
    const remnaCall = numeric
      ? { via: 'telegram_id' as const, path: '/api/users/stream', params: { telegramId: q, size: STREAM_PAGE } }
      : looksLikeEmail
        ? { via: 'email' as const, path: '/api/users/stream', params: { email: q, size: STREAM_PAGE } }
        : {
            via: 'username' as const,
            path: `/api/users/by-username/${encodeURIComponent(q.replace(/^@/, ''))}`,
            params: undefined,
          };

    // user_id в поиск не передаём: для админа он переключает контекст исполнения
    // на этого клиента и поиск вернёт одного человека вместо результатов.
    const [shmResult, remnaResult] = await Promise.all([
      settle(ctx.shm.list<Record<string, unknown>>('/admin/user/search', { text: q, limit: 25 })),
      panelOn
        ? settle(ctx.remna.get<unknown>(remnaCall.path, remnaCall.params))
        : Promise.resolve<{ ok: true; value: unknown }>({ ok: true, value: [] }),
    ]);

    let rows = take(shmResult, 'shm', degraded, EMPTY_LIST).data;

    /**
     * ТОЧНЫЙ user_id ДОБИРАЕТСЯ ВСЕГДА, А НЕ ТОЛЬКО НА ПУСТОМ ПОИСКЕ.
     *
     * `/admin/user/search` ищет ПОДСТРОКОЙ и отдаёт окно в 25 строк, отсортиро-
     * ванное по ключу таблицы вниз. Для короткого числового запроса это значит,
     * что искомый клиент в окно просто не попадает: оно целиком забивается
     * посторонними, в чьих идентификаторах встречаются те же цифры, — при том
     * что клиент существует и не заблокирован. Прежнее условие
     * `rows.length === 0` такой случай не ловило вовсе: строки были, просто не те.
     *
     * Спрашивается через `filter`, а не `?user_id=`: вторая форма на
     * несуществующем id бросает исключение вместо пустого ответа (см.
     * shmUserExistsParams в kit), то есть добор превращался бы в запись
     * «SHM не ответил» на каждом числовом запросе без такого клиента.
     */
    const wantedId = numeric ? Number(q) : null;
    const alreadyHasExact =
      wantedId === null ||
      rows.map(asRecord).some((row) => num(row.user_id ?? row.id, Number.NaN) === wantedId);
    if (wantedId !== null && !alreadyHasExact && shmResult.ok) {
      const direct = await settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user', shmUserExistsParams(wantedId)),
      );
      const directRows = take(direct, 'shm', degraded, EMPTY_LIST).data;
      if (directRows.length > 0) {
        // В начало, а не вместо: текстовые совпадения тоже ответ на запрос, и
        // терять их нельзя — теряется только их первое место.
        rows = [...directRows, ...rows];
        warnings.push(
          warn(
            'shm_found_via_user_id',
            `The exact user_id ${String(wantedId)} was not in what /admin/user/search returned, ` +
              'and was added here by a direct lookup. Two different reasons produce that, and ' +
              'this warning does not distinguish them: the search hides blocked clients (SHM ' +
              'appends block=0 whenever the where-clause carries no user_id), and it matches as a ' +
              'SUBSTRING with a 25-row window, so a short numeric query returns whoever else ' +
              'contains those digits. The exact match is first in `shm.matches`; the rest are ' +
              'substring hits on other people.',
          ),
        );
      }
    }

    if (rows.length === 0 && shmResult.ok) {
      warnings.push(
        warn(
          'shm_blocked_invisible',
          'SHM search hides blocked clients, so an empty result does not prove the client is ' +
            'absent. Retry with client_search include_blocked=true.',
        ),
      );
    }

    // stream отдаёт КОНВЕРТ `{users, nextCursor, hasMore}`, by-username —
    // голый объект. asArray по конверту дал бы одну мусорную строку, поэтому
    // список берётся по имени ключа, когда он есть.
    const remnaValue = take(remnaResult, 'remna', degraded, []);
    const remnaBox = asRecord(remnaValue);
    const remnaRows = asArray(Array.isArray(remnaValue) ? remnaValue : (remnaBox.users ?? remnaValue))
      .map(asRecord);
    // Отбор по id, а не по uuid: у объекта пользователя 3.x поля uuid нет
    // вовсе, и прежний фильтр `uuid !== ''` выбрасывал КАЖДУЮ строку — живой
    // клиент читался как отсутствующий даже там, где панель отвечала 200.
    const identifierMatches = remnaRows
      .map((row) => normalizeRemnaUser(row, remnaCall.via))
      .filter((m) => m.id > 0);
    if (remnaBox.hasMore === true) {
      warnings.push(
        warn(
          'remna_more_matches',
          `Remnawave has more users behind this identifier than the ${String(STREAM_PAGE)} ` +
            'returned here — `hasMore` is set. This list is a page, not the whole answer: do not ' +
            'conclude anything about which account the client uses from it.',
        ),
      );
    }
    if (identifierMatches.length > 1) {
      warnings.push(
        warn(
          // Код называет ИДЕНТИФИКАТОР, а не telegram id: этот же путь ходит по
          // email и по имени панели, и код, называющий одно из трёх, врал о
          // происхождении находки в двух случаях из трёх.
          'remna_ambiguous_identifier',
          `Remnawave returned ${String(identifierMatches.length)} users for this ${remnaCall.via}. ` +
            'There is no rule for picking one — confirm the id with the client before acting on ' +
            'it. This is not rare: one telegram id can carry several panel users, and the ' +
            'accounts behind one identifier routinely differ in status — an ACTIVE one next to ' +
            'DISABLED leftovers of removed services.',
        ),
      );
    }

    // Точное совпадение — первым. Это же решает, ЧЬИ услуги пойдут в обход
    // панели ниже: он берёт первые MAX_CLIENTS_WALKED строк.
    //
    // Дедупликация по user_id обязательна именно из-за добора: строку, которую
    // вернул точечный запрос, поиск мог отдать и сам (числовой запрос — это то
    // telegram id, то user_id, и на одном клиенте они совпадут), а два
    // одинаковых клиента в ответе — это ещё и два прохода обхода услуг по нему.
    const seen = new Set<number>();
    const shmMatches = byExactness(
      rows
        .map(asRecord)
        .map(normalizeShmUser)
        .filter((match) => {
          if (match.user_id > 0 && seen.has(match.user_id)) return false;
          if (match.user_id > 0) seen.add(match.user_id);
          return true;
        }),
      q,
      numeric,
    );

    /**
     * ВТОРОЙ путь в панель — через услуги клиента, тот самый, которым ходит
     * provisioning_diagnose (общая функция resolveServicePanel).
     *
     * Зачем он вообще: путь по идентификатору спрашивает панель про
     * `telegramId`, а панель пишет это поле ТОЛЬКО при создании пользователя и
     * только если Telegram к тому моменту был привязан. В работающей панели поле
     * пустое у заметной доли аккаунтов, и для каждого из них резолв отвечал
     * `count: 0` — без предупреждения, без degraded,
     * то есть «аккаунта в панели нет». Естественное следствие такого ответа —
     * завести аккаунт заново, то есть сделать клиенту дубль.
     *
     * Аккаунт панели заводится на КАЖДЫЙ user_service_id (remnawave.tpl:352),
     * поэтому услуги клиента — это и есть полный список его аккаунтов, и
     * ходить в панель по имени `<префикс><usi>` умеет ровно та функция,
     * которой это делает диагностика.
     */
    const panelPaths: PanelPathReport[] = [
      {
        path: remnaCall.via,
        tried: panelOn && remnaResult.ok,
        found: identifierMatches.length,
        note: !panelOn
          ? 'this deployment has no Remnawave panel configured, so the panel was never asked'
          : !remnaResult.ok
            ? 'the panel did not answer — see `degraded`'
            : identifierBlindSpot(remnaCall.via),
      },
    ];

    const walkable = panelOn ? shmMatches.slice(0, MAX_CLIENTS_WALKED) : [];
    const serviceMatches: RemnaUserMatch[] = [];
    let probes = 0;
    // `panelOn &&` обязателен: без панели `walkable` пуст по решению, а не по
    // потолку, и предупреждение `panel_lookup_capped` («обход остановился на
    // своей границе, список может быть коротким») звало бы уточнять обход,
    // которого не было.
    let capped = panelOn && shmMatches.length > walkable.length;
    let servicesTried = false;
    let servicesOk = true;
    /** Услуги, по которым имя гадали и не угадали — см. panel.guessed. */
    let guessedAndMissed = 0;
    /**
     * Чем именовали. Заполняется первым же обходом услуги: список префиксов
     * приезжает из самой SHM, поэтому назвать его в оговорке можно только
     * оттуда, а не из константы этого файла.
     */
    let naming: PanelNaming | null = null;

    for (const client of walkable) {
      if (client.user_id <= 0) continue;
      servicesTried = true;
      const services = await settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
          user_id: client.user_id,
          limit: SERVICES_PAGE,
        }),
      );
      if (!services.ok) {
        servicesOk = false;
        take(services, 'shm', degraded, EMPTY_LIST);
        continue;
      }
      // Строка без user_service_id непригодна: имя аккаунта панели строится
      // именно из него, а подставленный ноль спросил бы панель про чужую
      // услугу и выдал бы ответ про неё за ответ про эту.
      const usis = services.value.data
        .map(asRecord)
        .map((row) => num(row.user_service_id, 0))
        .filter((usi) => usi > 0);
      for (const usi of usis) {
        if (probes >= SERVICE_PROBE_BUDGET) {
          capped = true;
          break;
        }
        probes += 1;
        const resolved = await resolveServicePanel(ctx, client.user_id, usi, degraded);
        const { panel } = resolved;
        naming = resolved.naming;
        if (!panel.ok) {
          servicesOk = false;
          continue;
        }
        // Снапшота не было — имя аккаунта пришлось гадать по префиксам, и
        // промах здесь неотличим от панели с собственным name_prefix. Считаем
        // такие промахи отдельно: молча они превращают «мы не смогли
        // построить имя» в «аккаунта нет».
        if (!panel.found && panel.guessed) guessedAndMissed += 1;
        if (!panel.found || panel.id === null) continue;
        serviceMatches.push({
          id: panel.id,
          username: panel.username,
          // Карточку панели этот путь не читает целиком: он отвечает на вопрос
          // «аккаунт существует», а не «что у него внутри». telegramId здесь
          // намеренно null — подставить сюда telegram_id клиента SHM значило бы
          // выдать наше предположение за то, что записано в панели.
          telegramId: null,
          status: null,
          via: 'service',
          user_service_id: usi,
          // Единственное место, где принадлежность аккаунта ИЗВЕСТНА: мы сами
          // пришли сюда от услуги этого клиента.
          shm_user_id: client.user_id,
        });
      }
      if (probes >= SERVICE_PROBE_BUDGET) break;
    }

    const walkNotes: string[] = [];
    if (capped) {
      walkNotes.push(
        `only the first ${String(probes)} services of the first ${String(walkable.length)} ` +
          `matched clients were probed (ceiling ${String(SERVICE_PROBE_BUDGET)} probes, ` +
          `${String(MAX_CLIENTS_WALKED)} clients)`,
      );
    }
    if (guessedAndMissed > 0) {
      const prefixes = naming?.usernamePrefixes ?? [];
      walkNotes.push(
        `${String(guessedAndMissed)} service(s) had no storage snapshot, so the panel was asked ` +
          `by a username built from the known prefixes (${prefixes.join(', ')} — ` +
          `${prefixSourcePhrase(naming?.usernamePrefixesFrom ?? 'default', PANEL_PREFIXES_VAR)}) ` +
          '— a deployment with its own `config.remnawave.name_prefix` is indistinguishable from ' +
          'an absent account there',
      );
    }
    walkNotes.push(SERVICE_PATH_BLIND_SPOT);

    panelPaths.push({
      path: 'service',
      tried: servicesTried,
      found: serviceMatches.length,
      note: !panelOn
        ? 'this deployment has no Remnawave panel configured, so the service walk was skipped ' +
          'entirely — it exists to look accounts up in a panel that is not here'
        : servicesTried
          ? walkNotes.join('; ')
          : shmMatches.length === 0
            ? 'no SHM client matched, so there is no service list to walk'
            : 'no SHM client carried a usable user_id',
    });

    // Объединение по id панели: один и тот же аккаунт находят оба пути, и
    // побеждает тот, что несёт БОЛЬШЕ — привязку к услуге. Обратный порядок
    // стёр бы `user_service_id`, ради которого второй путь и заводился.
    const byPanelId = new Map<number, RemnaUserMatch>();
    for (const match of identifierMatches) byPanelId.set(match.id, match);
    for (const match of serviceMatches) {
      const known = byPanelId.get(match.id);
      byPanelId.set(
        match.id,
        known === undefined
          ? match
          : {
              ...known,
              via: 'service',
              user_service_id: match.user_service_id,
              shm_user_id: match.shm_user_id,
            },
      );
    }
    const remnaMatches = [...byPanelId.values()];

    const identifierIds = new Set(identifierMatches.map((m) => m.id));
    const missedByIdentifier = serviceMatches.filter((m) => !identifierIds.has(m.id));
    if (missedByIdentifier.length > 0) {
      warnings.push(
        warn(
          'remna_found_via_services',
          `${String(missedByIdentifier.length)} panel account(s) exist that the ${remnaCall.via} ` +
            'lookup did not return — they were found through the client services instead: ' +
            `${missedByIdentifier
              .map(
                (m) =>
                  `${m.username ?? '?'} (id ${String(m.id)}, service ${String(m.user_service_id)}, ` +
                  `SHM client ${m.shm_user_id === null ? 'unknown' : String(m.shm_user_id)})`,
              )
              .join(', ')}. ` +
            // Владелец назван у КАЖДОГО аккаунта, потому что это разные люди:
            // на текстовом запросе обход идёт по нескольким клиентам сразу, и
            // безымянный список читается как «аккаунты того, кого искали».
            `Why the ${remnaCall.via} lookup missed them: ${identifierBlindSpot(remnaCall.via)}. ` +
            'These accounts are real. Check the `SHM client` on each one before acting — a text ' +
            'query matches several clients, and the walk covers the first few of them, so this ' +
            'list can name accounts belonging to different people. Do not provision a ' +
            'replacement — that is how a client ends up with two.',
        ),
      );
    }

    if (capped) {
      warnings.push(
        warn(
          'panel_lookup_capped',
          'The service walk into the panel stopped at its own ceiling, so the account list here ' +
            'may be short one. Resolve a single client (exact telegram id, email or user_id) to ' +
            'get the full walk, or run provisioning_diagnose per client for the complete picture.',
        ),
      );
    }

    if (!panelOn) {
      warnings.push(
        warn(
          // Тот же код, что у client_overview: факт один — «панели в этой
          // установке нет», — и два имени на него означали бы, что вызывающий,
          // ключующийся на код одного инструмента, у второго его не узнаёт.
          'remna_absent',
          'This deployment has no Remnawave panel configured, so `remna.matches` is empty ' +
            'because nothing was asked — not because the client has no panel account. Neither ' +
            'panel path was walked; see `remna.paths`. Everything under `shm` is the complete ' +
            'answer this server can give.',
        ),
      );
    } else if (remnaMatches.length === 0) {
      warnings.push(
        warn(
          'remna_absence_unproven',
          'No panel account was found, and that is NOT the same as the client not having one. ' +
            `Paths tried: ${panelPaths
              .map(
                (p) =>
                  `${p.path}=${p.tried ? `${String(p.found)} found` : 'not tried'}${p.note === null ? '' : ` (${p.note})`}`,
              )
              .join('; ')}. ` +
            (servicesOk
              ? ''
              : 'At least one lookup failed outright — see `degraded`. ') +
            'Before concluding the client has no panel account, check provisioning_diagnose for ' +
            'the same client. Re-provisioning on the strength of this answer is how duplicates ' +
            'are made.',
        ),
      );
    }

    return {
      query: q,
      shm: { matches: shmMatches, count: shmMatches.length },
      remna: {
        matches: remnaMatches,
        count: remnaMatches.length,
        ambiguous: remnaMatches.length > 1,
        /** Что именно спрашивали у панели — см. PanelPathReport. */
        paths: panelPaths,
      },
      warnings,
      degraded,
    };
  },
});
