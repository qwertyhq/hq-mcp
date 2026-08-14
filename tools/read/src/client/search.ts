import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { EMPTY_LIST, capLimit, listOut, settle, take, warn } from '../kit.js';
import { normalizeShmUser } from './resolve.js';
import type { ShmUserMatch } from './resolve.js';

const MAX_LIMIT = 200;

function matchesText(row: ShmUserMatch, needle: string): boolean {
  const hay = [row.login, row.email, row.full_name, String(row.user_id), String(row.telegram_id)]
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
    const byId = new Map<number, ShmUserMatch>();
    for (const row of primaryOut.data.map(normalizeShmUser)) {
      byId.set(row.user_id, row);
    }

    let items = primaryOut.items;

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
      const blockedPage = blockedOut.data.map(normalizeShmUser);
      const blockedRows = blockedPage.filter((row) => matchesText(row, text));
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
