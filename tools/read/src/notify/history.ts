import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  SPOOL_STATUSES,
  asRecord,
  capLimit,
  listOut,
  num,
  settle,
  shmUserExistsParams,
  str,
  take,
  warn,
} from '../kit.js';

const MAX_LIMIT = 200;

/** Максимум сообщения бэкенда, уезжающего наружу дословно. */
const ERROR_CHARS = 300;

/**
 * Порог, ниже которого функция отправки НЕ ВЫЗЫВАЛАСЬ. Откалиброван по срезу
 * настоящей истории спула, а не по спецификации: строки с
 * delivery.status=SKIPPED (шаблон отрендерился пустым, send не звали) держатся
 * в 0.010–0.015 с, а доставленный телеграм — 0.068–0.120 с. Тот же разрыв
 * записан в истории проекта как способ, которым молчащую рассылку поймали в
 * первый раз: 0.007 с — вызова не было, десятая доли секунды — ушло по сети.
 *
 * Это ЭВРИСТИКА, и она никогда не переспоривает записанный вердикт: при
 * наличии `response.delivery` решает он, а `send_ran` остаётся подсказкой.
 */
export const SEND_CALL_THRESHOLD_SECONDS = 0.05;

/** Что пишет SHM в `response.message`. Словарь закрытый: на большой выборке истории — два значения. */
const SKIPPED_MESSAGE_PREFIX = 'skipped';

export type DeliveryVerdict = 'DELIVERED' | 'SKIPPED' | 'UNDELIVERED' | 'NOT_RECORDED';
export type VerdictSource = 'delivery' | 'message' | 'http_status' | 'none';

/**
 * URL внутри свободного текста. Единственная известная утечка через `error`:
 * адрес Telegram Bot API несёт токен бота прямо в пути
 * (`https://api.telegram.org/bot<id>:<token>/sendMessage`), а редакция
 * @hq/redact смотрит на ИМЕНА полей и внутрь строки не заглядывает вовсе.
 */
const URL_RE = /https?:\/\/\S+/g;

export function scrubBackendMessage(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  return text.replace(URL_RE, '<url>').slice(0, ERROR_CHARS);
}

function httpVerdict(code: number | null): DeliveryVerdict | null {
  if (code === null) return null;
  if (code >= 200 && code < 400) return 'DELIVERED';
  if (code >= 400) return 'UNDELIVERED';
  return null;
}

export interface Verdict {
  verdict: DeliveryVerdict;
  source: VerdictSource;
}

/**
 * ВЕРДИКТ ДОСТАВКИ И ЕГО ПРОИСХОЖДЕНИЕ.
 *
 * `response.delivery` — новая инструментовка, и это главный факт про неё:
 * в срезе свежей истории поле есть у небольшой части строк, и все они
 * датированы последними днями — прибор появился недавно. У подавляющего
 * большинства строк того же окна его нет вовсе. Инструмент, читающий только
 * `delivery`, ответил бы «не доставлено» на всей истории до дня появления
 * поля — то есть превратил бы отсутствие прибора в отсутствие доставки.
 *
 * Поэтому вердикт собирается по убыванию надёжности источника, и источник
 * возвращается вместе с ним:
 *  - `delivery`    — записанный вердикт, единственный авторитетный;
 *  - `message`     — «skipped: template rendered empty content»: ровно тот
 *                    инцидент, ради которого этот инструмент существует, и до
 *                    появления delivery он виден ТОЛЬКО здесь (на одном и том
 *                    же срезе таких строк кратно больше, чем записанных
 *                    SKIPPED);
 *  - `http_status` — код ответа принимающей стороны;
 *  - `none`        — ничего из перечисленного, и тогда это NOT_RECORDED, а не
 *                    «не доставлено».
 */
export function deliveryVerdict(response: Record<string, unknown>): Verdict {
  const delivery = asRecord(response.delivery);
  const recorded = str(delivery.status);
  if (recorded !== null) {
    const upper = recorded.toUpperCase();
    if (upper === 'DELIVERED' || upper === 'SKIPPED' || upper === 'UNDELIVERED') {
      return { verdict: upper, source: 'delivery' };
    }
    // Незнакомое значение записанного вердикта: врать «доставлено» нельзя, но
    // и терять его нельзя — оно уезжает наружу в `delivery.status` как есть.
    return { verdict: 'NOT_RECORDED', source: 'delivery' };
  }
  const message = str(response.message);
  if (message !== null && message.toLowerCase().startsWith(SKIPPED_MESSAGE_PREFIX)) {
    return { verdict: 'SKIPPED', source: 'message' };
  }
  const byHttp = httpVerdict(numOrNull(asRecord(response.status).code));
  if (byHttp !== null) return { verdict: byHttp, source: 'http_status' };
  return { verdict: 'NOT_RECORDED', source: 'none' };
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

interface NotifyRow {
  id: number;
  spool_id: number | null;
  user_id: number | null;
  user_service_id: number | null;
  created: string | null;
  executed: string | null;
  task_status: string | null;
  event: { name: string | null; title: string | null; kind: string | null };
  template_id: string | null;
  template_source: 'event' | 'task' | null;
  verdict: DeliveryVerdict;
  verdict_source: VerdictSource;
  delivery: { status: string | null; code: string | null; reason: string | null } | null;
  http: { code: string | null; line: string | null } | null;
  message: string | null;
  error: string | null;
  duration_seconds: number | null;
  send_ran: boolean | null;
  rendered_empty: boolean | null;
  result_empty: boolean | null;
  pay_id: number | null;
}

/**
 * «Шаблон отрендерился пустым, клиенту не ушло ничего» — по ЗАПИСАННОМУ
 * признаку, а не по догадке. Два таких признака, и второй существует потому,
 * что первого в записях старше появления `delivery` не было вовсе:
 * `delivery.reason = EMPTY_RENDER` и сообщение «skipped: template rendered
 * empty content», которое на том же срезе встречается кратно чаще.
 * `null` — не «нет», а «сказать нечем».
 */
function renderedEmpty(
  delivery: Record<string, unknown>,
  message: string | null,
): boolean | null {
  if (str(delivery.reason) === 'EMPTY_RENDER') return true;
  if (message !== null && message.toLowerCase().startsWith(SKIPPED_MESSAGE_PREFIX)) return true;
  if (Object.keys(delivery).length > 0 || message !== null) return false;
  return null;
}

function buildRow(raw: Record<string, unknown>): NotifyRow {
  const event = asRecord(raw.event);
  const eventSettings = asRecord(event.settings);
  const settings = asRecord(raw.settings);
  const response = asRecord(raw.response);
  const delivery = asRecord(response.delivery);
  const http = asRecord(response.status);
  // Шаблон уведомления живёт в event.settings; у задач kind=TASK свой шаблон
  // лежит на строке (settings.template_id). Оба — рассылки клиенту, поэтому
  // оба здесь; `response.template_id` НЕ берётся вовсе: там имя шаблона
  // ПРОВИЖИНИНГА ('remna-3'), и приняв его за уведомление, инструмент объявил
  // бы каждую установку на ноду письмом клиенту.
  const eventTemplate = str(eventSettings.template_id);
  const taskTemplate = str(settings.template_id);
  const templateId = eventTemplate ?? taskTemplate;
  const { verdict, source } = deliveryVerdict(response);
  const duration = numOrNull(asRecord(response.spool).duration);
  const message = str(response.message);
  return {
    id: num(raw.id, 0),
    spool_id: numOrNull(raw.spool_id),
    user_id: numOrNull(raw.user_id),
    user_service_id: numOrNull(raw.user_service_id),
    created: str(raw.created),
    executed: str(raw.executed),
    task_status: str(raw.status),
    event: { name: str(event.name), title: str(event.title), kind: str(event.kind) },
    template_id: templateId,
    template_source: eventTemplate !== null ? 'event' : taskTemplate !== null ? 'task' : null,
    verdict,
    verdict_source: source,
    delivery:
      Object.keys(delivery).length === 0
        ? null
        : { status: str(delivery.status), code: str(delivery.code), reason: str(delivery.reason) },
    http: Object.keys(http).length === 0 ? null : { code: str(http.code), line: str(http.line) },
    message,
    // Сообщение бэкенда как есть, но без URL и усечённое: см. scrubBackendMessage.
    error: scrubBackendMessage(response.error),
    duration_seconds: duration,
    // Только для строк, которые ВООБЩЕ являются рассылкой: у ssh-пайплайна
    // провижининга длительность измеряет установку на ноду, и порог отправки
    // сообщения к ней отношения не имеет.
    send_ran: templateId === null || duration === null ? null : duration >= SEND_CALL_THRESHOLD_SECONDS,
    rendered_empty: renderedEmpty(delivery, message),
    // `response.result` — то, что вернул обработчик пользовательской задачи.
    // Наружу уезжает ПРИЗНАК ПУСТОТЫ, а не значение: в result может лежать
    // ответ принимающей стороны, а редакция смотрит только на имена полей.
    // Отдельно от `rendered_empty` намеренно: пустой result — сигнал слабее
    // записанного EMPTY_RENDER, и складывать их в одно поле значит выдавать
    // догадку за приборный факт.
    result_empty: response.result === undefined ? null : str(response.result) === null,
    pay_id: numOrNull(settings.pay_id),
  };
}

export const notifyHistory = defineTool({
  name: 'notify_history',
  description:
    'Delivery log of the notifications SHM sent — per client or across the service. Answers ' +
    '"did we actually tell the client about this charge, and if not, why not": ' +
    '/admin/spool/history carries a `response.delivery` verdict (DELIVERED / SKIPPED / ' +
    'UNDELIVERED with a reason such as EMPTY_RENDER or CHAT_NOT_FOUND) that nothing else ' +
    'surfaces. That verdict is NEW instrumentation — on a live 2000-row window it exists on 117 ' +
    'rows, all from the last two days — so `verdict_source` says where each verdict came from, ' +
    'and rows with no record are NOT_RECORDED, never "not delivered". Older rows are still ' +
    'readable through `response.message`: a template that renders empty produces a SUCCESS task ' +
    'that sent nothing, which is exactly the incident this tool exists for. ' +
    '`duration_seconds` is reported because it separates the two: a send that really went out ' +
    'takes a tenth of a second, a send function that was never called returns in hundredths. ' +
    'WHAT THIS TOOL DELIBERATELY DOES NOT RETURN: `response.request` (its `content` is the full ' +
    'message text plus chat ids, and its `url` carries the Telegram bot token in the path), ' +
    "`response.response` (the remote's echo of the delivered message, chat and bot identity) " +
    'and `response.server` (internal host addressing). The verdict, the template, the timing ' +
    'and the status line are enough to tell whether a message left the building.',
  input: z.object({
    shm_user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Narrow to one client; omit to read the whole service-wide log'),
    status: z
      .enum(SPOOL_STATUSES)
      .nullable()
      .default(null)
      .describe('Filter by the task status of the history row; these eight are the whole vocabulary of Core::Const. SKIPPED is a task whose handler had nothing to send — not a delivery failure'),
    only_notifications: z
      .boolean()
      .default(true)
      .describe('Keep only rows that carry a template, i.e. rows that were meant to reach a human'),
    limit: z.number().int().default(50).describe('Rows, capped at 200'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, status, only_notifications, limit }, ctx) => {
    const cap = capLimit(limit, 50, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    // Сужение — ТОЛЬКО через filter. Обычный query-параметр до WHERE у
    // Sql::Data::list_for_api не доезжает (Data.pm:728-806 строит where из
    // filter, args.where и ключа таблицы), то есть ?status=FAIL вернул бы всю
    // историю под видом отфильтрованной. Проверено на работающей SHM, а не по
    // спецификации: filter status=FAIL отбирает из всей истории считаные
    // строки, и все они действительно FAIL.
    const where: Record<string, string | number> = {};
    if (shm_user_id !== null) where.user_id = shm_user_id;
    if (status !== null) where.status = status;

    const [user, history] = await Promise.all([
      shm_user_id === null
        ? Promise.resolve(null)
        : // Через filter, а не через ?user_id=: см. shmUserExistsParams.
          settle(
            ctx.shm.list<Record<string, unknown>>('/admin/user', shmUserExistsParams(shm_user_id)),
          ),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/spool/history', {
          ...(Object.keys(where).length === 0 ? {} : { filter: JSON.stringify(where) }),
          limit: cap,
        }),
      ),
    ]);

    const historyList = listOut(
      take(history, 'shm', degraded, EMPTY_LIST),
      warnings,
      'notification history',
    );
    const userRow =
      user === null ? {} : asRecord(take(user, 'shm', degraded, EMPTY_LIST).data[0]);

    const all = historyList.data.map(buildRow);
    const notifications = all.filter((row) => row.template_id !== null);
    const rows = only_notifications ? notifications : all;

    const summary: Record<DeliveryVerdict, number> = {
      DELIVERED: 0,
      SKIPPED: 0,
      UNDELIVERED: 0,
      NOT_RECORDED: 0,
    };
    for (const row of rows) summary[row.verdict] += 1;

    const emptyRender = notifications.filter((row) => row.rendered_empty === true);
    const notRecorded = notifications.filter((row) => row.verdict_source === 'none');
    // Строка, которая НЕ жалуется на пустой рендер и всё равно вернулась
    // быстрее порога: рассылка отчиталась успехом, а отправки не было. Строки
    // с EMPTY_RENDER сюда не входят намеренно — про них уже сказано отдельно,
    // и повторять один факт двумя предупреждениями значит удваивать его вес.
    const silent = notifications.filter(
      (row) => row.send_ran === false && row.rendered_empty !== true,
    );

    if (history.ok && status !== null) {
      const others = rows.filter(
        (row) => (row.task_status ?? '').toUpperCase() !== status,
      );
      if (others.length > 0) {
        warnings.push(
          warn(
            'status_filter_not_applied',
            `The answer contains task statuses other than "${status}", so the server-side filter ` +
              'did not narrow it. Treat these rows as an unfiltered slice of the log, not as the ' +
              'requested status.',
          ),
        );
      }
    }
    if (history.ok && shm_user_id !== null) {
      const others = rows.filter((row) => row.user_id !== null && row.user_id !== shm_user_id);
      if (others.length > 0) {
        warnings.push(
          warn(
            'user_filter_not_applied',
            `The answer contains rows belonging to other clients, so the server-side filter on ` +
              'user_id did not narrow it. These rows are the service-wide log, not this ' +
              "client's — do not read them as messages sent to him.",
          ),
        );
      }
    }
    if (history.ok && notRecorded.length > 0) {
      warnings.push(
        warn(
          'delivery_verdict_not_recorded',
          `${String(notRecorded.length)} of ${String(notifications.length)} notification rows in ` +
            'this window carry no delivery verdict at all — no `response.delivery`, no message, ' +
            'no status line. The delivery block is recent instrumentation (on a live 2000-row, ' +
            'three-day window it appears only on rows from the last two days), so its absence on ' +
            'an older row says nothing about whether the message arrived. These rows are ' +
            'NOT_RECORDED, which is not a synonym for undelivered.',
        ),
      );
    }
    if (history.ok && emptyRender.length > 0) {
      warnings.push(
        warn(
          'empty_render',
          `${String(emptyRender.length)} rows rendered an empty template and sent nothing, while ` +
            'the task itself is recorded SUCCESS. This is the silent-mailer shape: the template ' +
            'file produced no content, the send function had nothing to send, and the queue ' +
            'reported success anyway. Templates in this deployment are FILES, not database rows, ' +
            'so a template that lost its send call leaves no other trace than this. Affected ' +
            `templates: ${[...new Set(emptyRender.map((row) => row.template_id))].join(', ')}.`,
        ),
      );
    }
    if (history.ok && silent.length > 0) {
      warnings.push(
        warn(
          'send_never_ran',
          `${String(silent.length)} notification rows finished faster than ` +
            `${String(SEND_CALL_THRESHOLD_SECONDS)}s without reporting a skip. A real send ` +
            'crosses the network and takes roughly a tenth of a second; hundredths mean the send ' +
            'function returned without being called. This is a timing heuristic, not a recorded ' +
            'verdict — confirm against `verdict`/`verdict_source` before telling anyone the ' +
            'client was not notified.',
        ),
      );
    }
    if (history.ok && historyList.data.length > 0 && notifications.length === 0) {
      warnings.push(
        warn(
          'notifications_absent_in_window',
          `The window held ${String(historyList.data.length)} rows and not one of them was a ` +
            'notification: they are provisioning pipelines and scheduled jobs, which carry no ' +
            'template. This is not evidence that the client was never written to — widen the ' +
            'limit or drop the status filter before concluding anything about delivery.',
        ),
      );
    }
    if (user !== null && user.ok && Object.keys(userRow).length === 0) {
      warnings.push(
        warn(
          'user_not_found',
          `No client with user_id ${String(shm_user_id)} exists in SHM. Whatever this window ` +
            'holds is not about a client that is there.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A system needed for this answer did not respond (see `degraded`). ' +
            (history.ok
              ? 'The log itself was read, so the verdicts stand; only the check that the client ' +
                'exists at all is missing.'
              : 'The delivery log is the only source here, so every list is empty and every ' +
                'count is zero rather than wrong. An empty result is not evidence that nothing ' +
                'was sent.'),
        ),
      );
    }

    return {
      summary,
      window: {
        items: historyList.items,
        limit: historyList.limit,
        offset: historyList.offset,
        scanned: historyList.data.length,
        notifications: notifications.length,
        returned: rows.length,
      },
      rows,
      warnings,
      degraded,
    };
  },
});
