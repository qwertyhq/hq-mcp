import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { EMPTY_LIST, capLimit, listOut, lookupAccountsFor, settle, take, warn } from '../kit.js';
import type { IdentitySchema } from '../kit.js';
import { normalizeShmUser } from './resolve.js';
import type { ShmUserMatch } from './resolve.js';

const MAX_LIMIT = 200;

/**
 * Совпадение ищется и по СЫРОЙ строке тоже, а не только по напечатанным полям.
 *
 * С 3.0 почта клиента в строке не живёт, и `normalizeShmUser` на такой
 * установке её оттуда не берёт (`users.login2` там мёртвый остаток с
 * довоенными значениями). Но искать по ней всё ещё осмысленно: оператор,
 * который ввёл старый адрес, ищет человека, а не подтверждает адрес. Поэтому
 * колонка участвует в ОТБОРЕ и не участвует в ОТВЕТЕ.
 */
function matchesText(row: ShmUserMatch, needle: string, raw?: Record<string, unknown>): boolean {
  const legacy = raw === undefined ? null : raw.login2;
  const hay = [
    row.login,
    row.email,
    row.full_name,
    String(row.user_id),
    String(row.telegram_id),
    typeof legacy === 'string' ? legacy : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle.toLowerCase());
}

export const clientSearch = defineTool({
  name: 'client_search',
  description:
    'Search SHM clients by login, email, name, phone or id. Blocked clients are invisible to the ' +
    'SHM search route — pass include_blocked=true to also scan the blocked list. The full match ' +
    'count is returned as `items`, so paging is not guessed.',
  input: z
    .object({
      text: z
        .string()
        .min(1)
        .optional()
        .describe('Substring: login, email, full name, phone or user_id'),
      /**
       * Псевдоним `text`. Существует не для красоты: соседний client_resolve
       * принимает тот же по смыслу аргумент под именем `query`, и вызывающий,
       * только что сделавший resolve, тянется за `query` здесь — получая
       * invalid_input на совершенно разумном вызове. Это дефект СХЕМЫ, а не
       * вызова: два инструмента одного семейства, применяемые подряд, назвали
       * одну и ту же строку по-разному и нигде об этом не предупредили.
       * Принимаем оба написания, но ровно одно за раз — молча выбрать из двух
       * разных строк значило бы искать не то, что просили.
       */
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Alias of `text`, spelled as in client_resolve; pass one or the other'),
      include_blocked: z
        .boolean()
        .default(false)
        .describe('Also scan blocked clients (a second, client-side filtered request)'),
      limit: z.number().int().default(25).describe('Max rows, capped at 200'),
    })
    // `.refine`, а НЕ `.transform`: реестр требует, чтобы `input` оставался
    // z.object() с живым `.shape` — иначе MCP нечего опубликовать как схему
    // инструмента, и регистрация падает целиком (packages/registry:76).
    // Нормализация двух написаний в одно поэтому живёт в хендлере, а здесь
    // остаётся только проверка.
    .refine((one) => one.text !== undefined || one.query !== undefined, {
      message: 'Pass the search string as `text` (or `query`, its alias).',
      path: ['text'],
    })
    .refine((one) => one.text === undefined || one.query === undefined || one.text === one.query, {
      message: '`text` and `query` are the same field and were given different values. Pass one.',
      path: ['text'],
    }),
  access: 'ro',
  risk: 'low',
  // Бот поиск видит: оператору в панели поддержки он нужен, а PII в строках
  // режет redact по профилю (email/login2/full_name/phone → <redacted>).
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async (input, ctx) => {
    const { include_blocked, limit } = input;
    // Схема уже гарантировала, что ровно одно из двух написаний задано (и что
    // при обоих они совпадают), поэтому здесь остаётся только выбрать.
    const text = input.text ?? (input.query as string);
    const cap = capLimit(limit, 25, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    // Никакого user_id: для админа он делает switch_user и ломает поиск.
    const primary = await settle(
      ctx.shm.list<Record<string, unknown>>('/admin/user/search', { text, limit: cap }),
    );
    // listOut, а не голый .data: items — это FOUND_ROWS(), а не длина страницы,
    // и её нельзя терять; если сама SHM обрезала выдачу лимитом, "truncated"
    // предупреждение об этом скажет прямо.
    const primaryOut = listOut(take(primary, 'shm', degraded, EMPTY_LIST), warnings, 'client_search');

    /**
     * ГДЕ У ЭТОЙ SHM ЛЕЖИТ ПОЧТА — СПРАШИВАЕТСЯ ОДИН РАЗ НА ВЕСЬ ПОИСК.
     *
     * С 3.0 адрес переехал в таблицу `accounts`, а колонка `users.login2`
     * осталась в базе физически, с тем, что было записано ДО переезда:
     * миграция её не дропает, а `/admin/user` отдаёт физические колонки
     * целиком (`fields => '*'`, Sql/Data.pm:906). Напечатанная как `email`,
     * она даёт устаревший адрес, а на телеграм-регистрации — хендл `@<id>`.
     *
     * Запрос ОДИН и обязательно сужённый (голый список `accounts` — это
     * выгрузка почт и телефонов всей базы), поэтому он идёт по первому
     * найденному клиенту: схема у базы одна на всех. Добирать сами адреса
     * здесь нельзя — это был бы запрос на КАЖДУЮ строку выдачи; для одного
     * клиента их читают client_resolve и client_account_state.
     */
    const probeId = primaryOut.data
      .map((row) => normalizeShmUser(row).user_id)
      .find((id) => id > 0);
    let schema: IdentitySchema = 'unknown';
    if (probeId !== undefined) {
      const identity = await settle(lookupAccountsFor(ctx, { user_id: probeId }));
      if (identity.ok) {
        schema = identity.value.schema;
        if (identity.value.error !== null) degraded.push({ system: 'shm', error: identity.value.error });
      } else {
        degraded.push({ system: 'shm', error: identity.error });
      }
    }

    const byId = new Map<number, ShmUserMatch>();
    for (const row of primaryOut.data.map((one) => normalizeShmUser(one, schema))) {
      byId.set(row.user_id, row);
    }

    if (schema === 'accounts') {
      warnings.push(
        warn(
          'identity_not_in_row',
          'From SHM 3.0 the email of a client is a row of the `accounts` table, not a column of ' +
            'the client row this search returns, and filling it in would cost one request per ' +
            'result — so `email` is null here for everyone. That is "not in this answer", never ' +
            '"the client has no email". The dead `users.login2` column does still arrive and ' +
            'still holds pre-migration values, which is why it is searched but never printed as ' +
            'an email. `phones` is unaffected: SHM itself joins the accounts rows into the row ' +
            'it returns. For an address, resolve one client at a time (client_resolve, ' +
            'client_account_state).',
        ),
      );
    }

    let items = primaryOut.items;

    /**
     * SHM 3.0 БОЛЬШЕ НЕ ПРИНИМАЕТ НАШ `limit` НА ЭТОМ МАРШРУТЕ.
     *
     * `/admin/user/search` объявлен в v1.cgi 3.0.43 как
     * `params => { text }` с `method => 'api_search_for_admins'` и без
     * `common_params`, а общие списочные параметры (`limit`, `offset`,
     * `filter`, `sort_*`) впрыскиваются ТОЛЬКО в GET без собственного
     * `method`. Незадекларированный аргумент при этом не отвергается — он
     * молча выбрасывается, и ответ 200. То есть `limit=200` уезжает в
     * никуда, `api_search_for_admins` берёт свой умолчательный 25, и
     * инструмент, пообещавший двести строк, отдаёт двадцать пять, не
     * заметив разницы. Пагинации на этом маршруте после 3.0 нет вовсе:
     * `offset` выбрасывается ровно так же.
     *
     * Устанавливается ПО ОТВЕТУ, а не по номеру версии: ровно 25 строк при
     * запрошенном большем окне и сервером объявленном большем total — это
     * подпись выброшенного параметра, и она же верна на установке, где
     * маршрут пропатчен обратно (там страница будет длиннее).
     */
    const SEARCH_DEFAULT_LIMIT = 25;
    if (
      cap > SEARCH_DEFAULT_LIMIT &&
      primaryOut.data.length === SEARCH_DEFAULT_LIMIT &&
      primaryOut.items > SEARCH_DEFAULT_LIMIT
    ) {
      warnings.push(
        warn(
          'search_limit_ignored',
          `A limit of ${String(cap)} was asked for and exactly ${String(SEARCH_DEFAULT_LIMIT)} ` +
            `rows came back out of ${String(primaryOut.items)} the server says match. From SHM ` +
            '3.0 the search route declares `text` as its only argument, and v1.cgi drops every ' +
            'undeclared one silently with a 200 — so `limit` and `offset` no longer reach it and ' +
            'this window cannot be widened or paged from here. Narrow the query text instead, or ' +
            'resolve the client directly with client_resolve.',
        ),
      );
    }

    if (include_blocked) {
      // /admin/user?filter={"block":1} — единственный способ увидеть заблокированных,
      // но текстового поиска там нет, поэтому фильтруем на своей стороне.
      const blocked = await settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user', {
          filter: JSON.stringify({ block: 1 }),
          limit: MAX_LIMIT,
        }),
      );
      const blockedOut = listOut(
        take(blocked, 'shm', degraded, EMPTY_LIST),
        warnings,
        'client_search blocked',
      );
      // Флаг берётся из СТРОКИ, а не из того, по какой ручке она приехала.
      // Безусловное `blocked: true` — это утверждение о клиенте, выведенное из
      // маршрута запроса: когда filter={"block":1} не сужает выборку (а именно
      // это и проверяется ниже), «список заблокированных» состоит из обычных
      // клиентов, и каждый из них уезжал бы помеченным как заблокированный.
      const blockedPage = blockedOut.data.map((one) => normalizeShmUser(one, schema));
      const blockedRows = blockedPage.filter((row, index) =>
        matchesText(row, text, blockedOut.data[index]),
      );
      for (const row of blockedRows) {
        if (!byId.has(row.user_id)) items += 1;
        byId.set(row.user_id, row);
      }
      if (byId.size > cap) {
        // primaryOut/blockedOut each already warn about THEIR OWN truncation
        // (listOut, per call). The union of two untruncated calls can still
        // overflow `cap` right here at the merge — that loss belongs to
        // neither call individually, so neither listOut warning names it.
        // §6.4: existing client applications lose pagination exactly this way.
        warnings.push(
          warn(
            'truncated',
            `The merged result has ${String(byId.size)} distinct matches (primary search plus ` +
              `blocked list) but the response is capped at ${String(cap)} — raise limit before ` +
              'concluding a specific client is not among them.',
          ),
        );
      }
      warnings.push(
        warn(
          'blocked_filtered_client_side',
          'Blocked clients come from /admin/user?filter={"block":1}, which has no text search — ' +
            'they were filtered locally over the first 200 blocked rows and may be incomplete.',
        ),
      );
      /**
       * Сработал ли server-side filter — устанавливается ИЗ ОТВЕТА, тем же
       * способом, что и у соседа (sync/audit.ts:317). Прежняя версия
       * спрашивала только `ctx.probe`, а он в обычной сессии пуст: хранилище
       * создаётся на рантайм (packages/runtime/src/index.ts:122) и пишет в
       * него один platform_probe, поэтому без его вызова `get()` — null, `?.`
       * коротит, и предупреждение не появлялось НИКОГДА. Данные для честной
       * проверки при этом лежали рядом, в `blockedOut.data`.
       *
       * Пустая страница проверку проходит: возражений нет — это не то же
       * самое, что доказательство работающего фильтра, поэтому пустой ответ
       * не поднимает тревогу и не гасит сигнал probe ниже.
       */
      const filterNarrowed = blockedPage.every((row) => row.blocked);
      const probeSaysBroken = ctx.probe.get()?.capabilities['shm.filter'] === false;
      // ОДИН код на один факт «фильтр не сузил выборку»; чем факт установлен —
      // говорит текст, а не второе имя кода.
      if (!filterNarrowed) {
        warnings.push(
          warn(
            'blocked_filter_not_applied',
            'The blocked listing came back containing unblocked clients, so filter={"block":1} ' +
              'did not narrow it on this SHM build. The blocked half of this answer is therefore ' +
              'the head of the users table filtered locally, not a real blocked-client search — ' +
              'each row carries the block flag it has itself, not the one the route implies. ' +
              'Verify a specific client with client_resolve by user_id before concluding anything.',
          ),
        );
      } else if (probeSaysBroken) {
        warnings.push(
          warn(
            'blocked_filter_not_applied',
            'platform_probe found that server-side filter does not narrow results on this SHM ' +
              'build. Nothing in this particular answer contradicts it — the blocked listing came ' +
              'back all-blocked or empty — but treat its blocked half as unreliable and verify a ' +
              'specific client with client_resolve by user_id before concluding anything.',
          ),
        );
      }
    } else {
      warnings.push(
        warn(
          'blocked_hidden',
          'Blocked clients are not in this result: SHM appends block=0 to any listing whose ' +
            'where has no user_id. Pass include_blocked=true before concluding a client does not exist.',
        ),
      );
    }

    const matches = [...byId.values()].slice(0, cap);
    return { items, limit: cap, matches, warnings, degraded };
  },
});
