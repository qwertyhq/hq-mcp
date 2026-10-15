import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asRecord, assertHumanOnly, capLimit, errMessage, httpStatus, num, str, warn } from '../kit.js';

export const API_LOG_PATH = '/admin/logs/api';

const MAX_LIMIT = 1000;

/**
 * ЖУРНАЛ ВЫЗОВОВ API SHM — ДАННЫЕ, КОТОРЫХ ДО 3.0 НЕ БЫЛО ВОВСЕ.
 *
 * С 3.0.36 (миграция 3.0.14) диспетчер v1.cgi пишет КАЖДЫЙ вызов в таблицу `logs_api`
 * (`_log_api_call`, отдельной транзакцией — Core::Logs::Api, `dbh_auto_commit`):
 * кто (`user_id`, `ip`), что (`method`, `url`, `args`), чем кончилось
 * (`response_code`, `response_error`) и сколько шло (`duration`). Это первый
 * ответ на вопросы поддержки «что клиент делал в кабинете перед жалобой» и
 * «почему у него 400» — до сих пор их можно было только угадывать по спулу.
 *
 * Аргументы SHM маскирует сама ДО записи (`_mask_sensitive_args`: password,
 * token, session_id, code, captcha_* и прочее → `***`), но почта, телефон и
 * логин в них остаются открытыми — поэтому инструмент только для профиля human.
 *
 * Клиент задаётся через `filter`, а НЕ через `?user_id=`: на админском маршруте
 * второй вызывает switch_user (v1.cgi), то есть журнал прочитался бы ОТ ИМЕНИ
 * клиента. Это общее правило SHM в этом проекте (см. kit.ts, shmUserExistsParams).
 *
 * Глубина журнала — `billing.cleanup.ApiLogs` дней (по умолчанию 30,
 * Logs::Api::cleanup): «ничего не нашлось» за пределами этого окна не значит
 * «ничего не было».
 */
interface ApiCall {
  date: string | null;
  user_id: number | null;
  ip: string | null;
  method: string | null;
  url: string | null;
  response_code: number | null;
  response_error: string | null;
  duration_ms: number | null;
  descr: string | null;
  args: unknown;
}

function toCall(row: Record<string, unknown>): ApiCall {
  const userId = num(row.user_id, Number.NaN);
  const code = num(row.response_code, Number.NaN);
  const duration = num(row.duration, Number.NaN);
  return {
    date: str(row.date),
    // 0 SHM пишет за анонимный вызов (Logs::Api::add) — это «не вошёл», а не клиент №0.
    user_id: Number.isFinite(userId) && userId > 0 ? userId : null,
    ip: str(row.ip),
    method: str(row.method),
    url: str(row.url),
    response_code: Number.isFinite(code) ? code : null,
    response_error: str(row.response_error),
    duration_ms: Number.isFinite(duration) ? duration : null,
    descr: str(row.descr),
    args: row.args ?? null,
  };
}

export const apiLog = defineTool({
  name: 'api_log',
  description:
    'SHM 3.0.36+: the audit log of SHM API calls (table logs_api) — who called which route, with ' +
    'which arguments, from which IP, and what came back (HTTP code, error text, duration). The ' +
    'answer to "what did this client do in the cabinet before complaining" and "why does the ' +
    'cabinet get a 400". Newest first. SHM masks secret arguments (password, token, codes) ' +
    'itself before writing, but e-mails, phones and logins in arguments stay readable, hence ' +
    'human profile only. The log is pruned after billing.cleanup.ApiLogs days (30 by default): ' +
    'an empty answer older than that proves nothing. On SHM below 3.0.36 the route does not ' +
    'exist and the tool says so instead of returning an empty log.',
  input: z.object({
    shm_user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Only calls made by this SHM client (and admin calls made in their context).'),
    response_code: z
      .number()
      .int()
      .min(0)
      .nullable()
      .default(null)
      .describe('Exact HTTP code, e.g. 400 to see only rejected calls.'),
    url: z
      .string()
      .nullable()
      .default(null)
      .describe('Exact route as logged, e.g. "/shm/v1/user/passwd". Exact match, not a substring.'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE'])
      .nullable()
      .default(null)
      .describe('HTTP method.'),
    limit: z.number().int().default(100).describe('Rows, newest first; capped at 1000.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  backends: ['shm'],
  handler: async ({ shm_user_id, response_code, url, method, limit }, ctx) => {
    assertHumanOnly(
      ctx,
      'api_log is available to the human profile only: logged call arguments carry client e-mails, phones and logins in clear',
    );
    const cap = capLimit(limit, 100, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const filter: Record<string, string | number> = {};
    if (shm_user_id !== null) filter.user_id = shm_user_id;
    if (response_code !== null) filter.response_code = response_code;
    if (url !== null && url.trim() !== '') filter.url = url.trim();
    if (method !== null) filter.method = method;

    try {
      const page = await ctx.shm.list<Record<string, unknown>>(API_LOG_PATH, {
        ...(Object.keys(filter).length > 0 ? { filter: JSON.stringify(filter) } : {}),
        sort_field: 'date',
        sort_direction: 'desc',
        limit: cap,
        offset: 0,
      });
      const calls = page.data.map((row) => toCall(asRecord(row)));
      if (page.items > calls.length) {
        warnings.push(
          warn(
            'truncated',
            `"${API_LOG_PATH}" holds ${String(page.items)} matching calls; the ${String(calls.length)} ` +
              'newest are shown. Narrow by shm_user_id / response_code / url, or raise limit.',
          ),
        );
      }
      return { available: true, items: page.items, returned: calls.length, calls, warnings, degraded };
    } catch (caught: unknown) {
      if (httpStatus(caught) === 404) {
        warnings.push(
          warn(
            'shm_route_absent',
            `SHM has no ${API_LOG_PATH}: the API audit log appeared in SHM 3.0.36 (migration 3.0.14). This is the ` +
              'version of the billing, not an empty log.',
          ),
        );
        return { available: false, items: null, returned: 0, calls: [], warnings, degraded };
      }
      degraded.push({ system: 'shm', error: errMessage(caught) });
      return { available: null, items: null, returned: 0, calls: [], warnings, degraded };
    }
  },
});
