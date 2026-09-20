import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { SEND_CALL_THRESHOLD_SECONDS, notifyHistory, scrubBackendMessage } from './history.js';

interface NotifyRow {
  id: number;
  user_id: number | null;
  task_status: string | null;
  event: { name: string | null; title: string | null; kind: string | null };
  template_id: string | null;
  template_source: string | null;
  verdict: string;
  verdict_source: string;
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

interface NotifyOut {
  summary: Record<string, number>;
  window: {
    items: number;
    limit: number;
    offset: number;
    scanned: number;
    notifications: number;
    returned: number;
  };
  rows: NotifyRow[];
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const USER = 4242;
const USER_ROW = { user_id: USER, login: 'client' };

/**
 * Строки повторяют форму настоящего ответа /admin/spool/history (идентификаторы
 * и адреса подменены, форма как есть). `response.request` и `response.response`
 * оставлены в фикстурах НАМЕРЕННО: они и есть то, что инструмент обязан не
 * отдать наружу, и без них проверка утечки была бы вакуумной.
 */
const BOT_URL = 'https://api.telegram.org/bot1111111111:AAref-not-a-real-token/sendMessage';
const MESSAGE_TEXT = 'Списано 300 ₽ по автоплатежу';

/** Доставлено: записанный вердикт плюс строка статуса. */
const DELIVERED = {
  id: 810601,
  spool_id: 470410,
  user_id: USER,
  user_service_id: null,
  created: '2026-08-13 09:10:00',
  executed: '2026-08-13 09:10:01',
  status: 'SUCCESS',
  prio: 100,
  event: {
    id: 60,
    kind: 'UserService',
    name: 'AUTOPAY_CHARGE',
    title: 'tg_autopay_charge',
    settings: { category: '%', template_id: 'tg_autopay_charge' },
  },
  settings: { pay_id: 4684, subscription_id: 'sub-1', charges_count: 1 },
  response: {
    delivered: true,
    delivery: { code: '200', status: 'DELIVERED', template_id: 'tg_autopay_charge' },
    message: 'successful',
    request: {
      content: JSON.stringify({ chat_id: -1000000000001, text: MESSAGE_TEXT }),
      content_type: 'application/json',
      headers: null,
      method: 'POST',
      timeout: 10,
      url: BOT_URL,
      verify_hostname: 1,
    },
    response: { ok: true, result: { chat: { id: -1000000000001, title: 'notifications-channel' } } },
    spool: { duration: 0.09806, finished: 1, pid: 8, started: 1 },
    status: { code: '200', line: '200 OK' },
  },
};

/** Записанный пропуск: шаблон отрендерился пустым, отправки не было. */
const SKIPPED = {
  id: 810602,
  spool_id: 470411,
  user_id: USER,
  user_service_id: null,
  created: '2026-08-13 09:11:00',
  executed: '2026-08-13 09:11:00',
  status: 'SUCCESS',
  event: {
    kind: 'UserService',
    name: 'AUTOPAY_CHARGE',
    title: 'brevo_autopay_charge',
    settings: { category: '%', template_id: 'brevo_autopay_charge' },
  },
  settings: { pay_id: 4684 },
  response: {
    delivered: false,
    delivery: { reason: 'EMPTY_RENDER', status: 'SKIPPED', template_id: 'brevo_autopay_charge' },
    message: 'skipped: template rendered empty content',
    spool: { duration: 0.01025, finished: 1, pid: 8, started: 1 },
  },
};

/**
 * ДО ИНСТРУМЕНТОВКИ. Тот же пропуск, но `response.delivery` ещё не писали:
 * блок появился недавно, поэтому в окне истории он есть только у свежих строк,
 * а у более старых от того же пропуска остаётся одно лишь текстовое
 * «skipped: template rendered empty content».
 */
const SKIPPED_LEGACY = {
  id: 810603,
  spool_id: 470412,
  user_id: USER,
  user_service_id: null,
  created: '2026-08-12 21:59:14',
  executed: '2026-08-12 21:59:14',
  status: 'SUCCESS',
  event: {
    kind: 'UserService',
    name: 'AUTOPAY_CHARGE',
    title: 'brevo_autopay_charge',
    settings: { category: '%', template_id: 'brevo_autopay_charge' },
  },
  settings: { pay_id: 4684, charges_count: 1, subscription_id: 'sub-1' },
  response: {
    message: 'skipped: template rendered empty content',
    spool: { duration: 0.0147, finished: 1, pid: 8, started: 1 },
  },
};

/** Ни вердикта, ни сообщения, ни кода: сказать про доставку нечего. */
const NO_VERDICT = {
  id: 810604,
  spool_id: 470413,
  user_id: USER,
  user_service_id: 51,
  created: '2026-07-28 22:59:52',
  executed: '2026-07-28 22:59:52',
  status: 'SUCCESS',
  event: {
    kind: 'UserService',
    name: 'PROLONGATE',
    title: 'brevo_prolongate',
    settings: { category: '%', template_id: 'brevo_service_prolonged' },
  },
  settings: { server_id: 20, user_service_id: 51 },
  response: { spool: { duration: 0.12169, finished: 1, pid: 8, started: 1 } },
};

/** Не рассылка вовсе: ssh-пайплайн провижининга. Шаблон в response, а не в event. */
const PIPELINE = {
  id: 810605,
  spool_id: 470414,
  user_id: USER,
  user_service_id: 51,
  created: '2026-08-12 17:46:38',
  executed: '2026-08-12 17:46:38',
  status: 'FAIL',
  event: { kind: 'UserService', name: 'ACTIVATE', title: 'vpn activate', server_gid: 13 },
  settings: { server_id: 18, user_service_id: 51 },
  response: {
    error: 'Transport error',
    pipeline_id: 314596,
    ret_code: '0',
    server: { host: '192.0.2.10', id: 18, key_id: '<redacted>', port: '22' },
    spool: { duration: 0.72721, finished: 1, pid: 8, started: 1 },
    template_id: 'remna-3',
  },
};

/** Пользовательская задача-рассылка: шаблон на строке, а не в событии. */
const TASK = {
  id: 810606,
  spool_id: 470415,
  user_id: USER,
  user_service_id: null,
  created: '2026-08-12 17:41:57',
  executed: '2026-08-12 17:41:57',
  status: 'SUCCESS',
  event: { kind: 'Task', task_id: 42, title: 'Autopay broadcast' },
  settings: { template_id: 'recurrent' },
  response: { result: '', spool: { duration: 0.14532, finished: 1, pid: 8, started: 1 } },
};

function stub(rows: unknown[], user: unknown[] = [USER_ROW]) {
  return (path: string): unknown => {
    if (path === '/admin/user') return user;
    if (path === '/admin/spool/history') return rows;
    throw new Error(`unexpected path ${path}`);
  };
}

async function run(
  rows: unknown[],
  input: Partial<{
    shm_user_id: number | null;
    status: string | null;
    only_notifications: boolean;
    limit: number;
  }> = {},
  user: unknown[] = [USER_ROW],
): Promise<NotifyOut> {
  const ctx = makeCtx({ shmList: stub(rows, user) });
  return (await notifyHistory.handler(
    {
      shm_user_id: USER,
      status: null,
      only_notifications: true,
      limit: 50,
      ...input,
    },
    ctx,
  )) as NotifyOut;
}

describe('notify_history: what never leaves the tool', () => {
  /**
   * САМАЯ ВАЖНАЯ ПРОВЕРКА ФАЙЛА. Тело запроса несёт текст сообщения и chat_id,
   * а url — токен бота прямо в пути; `response.response` — эхо доставленного
   * сообщения от принимающей стороны; `response.server` — внутренний адрес.
   * Проверяется по СЕРИАЛИЗОВАННОМУ ответу целиком, а не по известным полям:
   * поле, добавленное завтра и протащившее тело с собой, обязано уронить тест.
   */
  it('never returns the request body, the request url, the remote echo or the server address', async () => {
    const result = await run([DELIVERED, PIPELINE], { only_notifications: false });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('api.telegram.org');
    expect(serialized).not.toContain('AAref-not-a-real-token');
    expect(serialized).not.toContain(MESSAGE_TEXT);
    expect(serialized).not.toContain('chat_id');
    expect(serialized).not.toContain('-1000000000001');
    expect(serialized).not.toContain('notifications-channel');
    expect(serialized).not.toContain('192.0.2.10');
    // …и при этом вердикт на месте: отказ от тела не должен стоить ответа.
    expect(result.rows[0]?.verdict).toBe('DELIVERED');
  });

  it('strips a url out of a backend error message, where redaction by field name cannot reach', () => {
    expect(scrubBackendMessage(`failed to POST ${BOT_URL}`)).toBe('failed to POST <url>');
    expect(scrubBackendMessage('Transport error')).toBe('Transport error');
    expect(scrubBackendMessage(undefined)).toBeNull();
    expect(scrubBackendMessage('x'.repeat(500))?.length).toBe(300);
  });

  it('reports the pipeline error without its server block', async () => {
    const result = await run([PIPELINE], { only_notifications: false });
    expect(result.rows[0]?.error).toBe('Transport error');
    expect(result.rows[0]?.template_id).toBeNull();
  });
});

describe('notify_history: the delivery verdict and where it came from', () => {
  it('uses the recorded verdict when there is one', async () => {
    const result = await run([DELIVERED, SKIPPED]);
    expect(result.rows.map((row) => [row.verdict, row.verdict_source])).toEqual([
      ['DELIVERED', 'delivery'],
      ['SKIPPED', 'delivery'],
    ]);
    expect(result.rows[0]?.http).toEqual({ code: '200', line: '200 OK' });
    expect(result.rows[1]?.delivery).toEqual({
      status: 'SKIPPED',
      code: null,
      reason: 'EMPTY_RENDER',
    });
  });

  /**
   * Строка старше инструментовки. Без отката на сообщение она читалась бы как
   * «не доставлено» — то есть отсутствие прибора выдавалось бы за отсутствие
   * доставки на всей истории, записанной до появления блока `delivery`.
   */
  it('falls back to the message on rows written before the delivery block existed', async () => {
    const result = await run([SKIPPED_LEGACY]);
    expect(result.rows[0]?.verdict).toBe('SKIPPED');
    expect(result.rows[0]?.verdict_source).toBe('message');
    expect(result.rows[0]?.delivery).toBeNull();
    expect(result.rows[0]?.rendered_empty).toBe(true);
  });

  it('calls a row with nothing recorded NOT_RECORDED, not undelivered', async () => {
    const result = await run([NO_VERDICT]);
    expect(result.rows[0]?.verdict).toBe('NOT_RECORDED');
    expect(result.rows[0]?.verdict_source).toBe('none');
    expect(result.rows[0]?.rendered_empty).toBeNull();
    expect(result.summary.UNDELIVERED).toBe(0);
    const warning = result.warnings.find((w) => w.code === 'delivery_verdict_not_recorded');
    expect(warning?.message).toContain('not a synonym for undelivered');
  });

  it('derives the verdict from the http status when only that is there', async () => {
    const httpOnly = {
      ...NO_VERDICT,
      id: 810607,
      response: { spool: { duration: 0.09 }, status: { code: '400', line: '400 Bad Request' } },
    };
    const result = await run([httpOnly]);
    expect(result.rows[0]?.verdict).toBe('UNDELIVERED');
    expect(result.rows[0]?.verdict_source).toBe('http_status');
  });

  it('keeps an unknown recorded verdict visible instead of translating it', async () => {
    const odd = {
      ...DELIVERED,
      id: 810608,
      response: { delivery: { status: 'QUEUED' }, spool: { duration: 0.09 } },
    };
    const result = await run([odd]);
    expect(result.rows[0]?.verdict).toBe('NOT_RECORDED');
    expect(result.rows[0]?.verdict_source).toBe('delivery');
    expect(result.rows[0]?.delivery?.status).toBe('QUEUED');
  });

  it('summarises the window by verdict', async () => {
    const result = await run([DELIVERED, SKIPPED, NO_VERDICT]);
    expect(result.summary).toEqual({
      DELIVERED: 1,
      SKIPPED: 1,
      UNDELIVERED: 0,
      NOT_RECORDED: 1,
    });
  });
});

describe('notify_history: timing as evidence', () => {
  it('reports the duration and whether the send function can have run at all', async () => {
    const result = await run([DELIVERED, SKIPPED]);
    expect(result.rows[0]?.duration_seconds).toBe(0.09806);
    expect(result.rows[0]?.send_ran).toBe(true);
    expect(result.rows[1]?.send_ran).toBe(false);
    expect(SEND_CALL_THRESHOLD_SECONDS).toBeGreaterThan(0.015);
    expect(SEND_CALL_THRESHOLD_SECONDS).toBeLessThan(0.068);
  });

  it('warns about a success that returned too fast to have sent anything', async () => {
    const silent = {
      ...NO_VERDICT,
      id: 810609,
      response: { spool: { duration: 0.004, finished: 1, pid: 8, started: 1 } },
    };
    const result = await run([silent]);
    const warning = result.warnings.find((w) => w.code === 'send_never_ran');
    expect(warning?.message).toContain('heuristic');
  });

  it('does not repeat the empty-render rows as a second silent-send finding', async () => {
    const result = await run([SKIPPED]);
    expect(result.warnings.map((w) => w.code)).toContain('empty_render');
    expect(result.warnings.map((w) => w.code)).not.toContain('send_never_ran');
  });

  it('leaves send_ran null on rows that were never a message', async () => {
    const result = await run([PIPELINE], { only_notifications: false });
    expect(result.rows[0]?.send_ran).toBeNull();
  });

  it('names the templates that rendered empty', async () => {
    const result = await run([SKIPPED, SKIPPED_LEGACY]);
    const warning = result.warnings.find((w) => w.code === 'empty_render');
    expect(warning?.message).toContain('brevo_autopay_charge');
  });

  it('reports an empty task result as a signal of its own, not as a rendered-empty verdict', async () => {
    const result = await run([TASK]);
    expect(result.rows[0]?.template_id).toBe('recurrent');
    expect(result.rows[0]?.template_source).toBe('task');
    expect(result.rows[0]?.result_empty).toBe(true);
    expect(result.rows[0]?.rendered_empty).toBeNull();
  });
});

describe('notify_history: narrowing, and whether it was honoured', () => {
  it('narrows through filter, the only parameter SHM actually applies', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ shmList: stub([DELIVERED]), calls });
    await notifyHistory.handler(
      { shm_user_id: USER, status: 'FAIL', only_notifications: true, limit: 50 },
      ctx,
    );
    const call = calls.find((one) => one.path === '/admin/spool/history');
    expect(call?.params?.filter).toBe(JSON.stringify({ user_id: USER, status: 'FAIL' }));
    expect(call?.params?.status).toBeUndefined();
    expect(call?.params?.user_id).toBeUndefined();
  });

  /**
   * SKIPPED — НАСТОЯЩИЙ СТАТУС ЗАДАЧИ, А НЕ ОПЕЧАТКА ВЫЗЫВАЮЩЕГО.
   *
   * Он появился в 3.0 (Core::Const) и на боевой 3.1.0 лежит в истории живьём.
   * Прежний enum знал шесть статусов, и фильтр по седьмому отвечал
   * invalid_input — то есть инструмент, обещавший «весь словарь», отказывался
   * искать то, что сам же и показывает в выдаче.
   */
  it('narrows by SKIPPED — a status the queue really emits since 3.0', () => {
    for (const status of ['SKIPPED', 'DELETED']) {
      expect(() =>
        notifyHistory.input.parse({ shm_user_id: USER, status, limit: 50 }),
      ).not.toThrow();
    }
    expect(() => notifyHistory.input.parse({ status: 'PROCESSING' })).toThrow();
  });

  it('sends no filter at all when nothing was asked for', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ shmList: stub([DELIVERED]), calls });
    await notifyHistory.handler(
      { shm_user_id: null, status: null, only_notifications: true, limit: 50 },
      ctx,
    );
    const call = calls.find((one) => one.path === '/admin/spool/history');
    expect(call?.params?.filter).toBeUndefined();
    // Без клиента проверять его существование незачем — и запроса быть не должно.
    expect(calls.some((one) => one.path === '/admin/user')).toBe(false);
  });

  /**
   * Проверено на работающей SHM 2.19.4: `?user_id=<нет такого>` на /admin/user
   * БРОСАЕТ, а `?filter={"user_id":...}` отдаёт items: 0.
   */
  it('checks existence through filter, because ?user_id= throws on an absent client', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ shmList: stub([DELIVERED]), calls });
    await notifyHistory.handler(
      { shm_user_id: USER, status: null, only_notifications: true, limit: 50 },
      ctx,
    );
    const lookup = calls.find((one) => one.path === '/admin/user');
    expect(lookup?.params?.filter).toBe(JSON.stringify({ user_id: USER }));
    expect(lookup?.params?.user_id).toBeUndefined();
  });

  it('says so when the server ignored the status filter', async () => {
    const result = await run([DELIVERED], { status: 'FAIL' });
    expect(result.warnings.map((w) => w.code)).toContain('status_filter_not_applied');
  });

  it('says so when the server ignored the user filter', async () => {
    const other = { ...DELIVERED, id: 810610, user_id: 9999 };
    const result = await run([other]);
    const warning = result.warnings.find((w) => w.code === 'user_filter_not_applied');
    expect(warning?.message).toContain('service-wide log');
  });

  it('keeps only rows meant for a human by default, and counts what it dropped', async () => {
    const result = await run([DELIVERED, PIPELINE]);
    expect(result.window.scanned).toBe(2);
    expect(result.window.notifications).toBe(1);
    expect(result.window.returned).toBe(1);
    const all = await run([DELIVERED, PIPELINE], { only_notifications: false });
    expect(all.window.returned).toBe(2);
  });

  it('refuses to let a window of pipelines read as "nothing was sent"', async () => {
    const result = await run([PIPELINE, PIPELINE]);
    expect(result.rows).toEqual([]);
    const warning = result.warnings.find((w) => w.code === 'notifications_absent_in_window');
    expect(warning?.message).toContain('not evidence');
  });

  it('surfaces the server-side items count and warns when the window is short', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') return [USER_ROW];
        return { items: 41374, limit: 1, offset: 0, data: [DELIVERED] };
      },
    });
    const result = (await notifyHistory.handler(
      { shm_user_id: USER, status: null, only_notifications: true, limit: 1 },
      ctx,
    )) as NotifyOut;
    expect(result.window.items).toBe(41374);
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });
});

describe('notify_history: degradation', () => {
  it('degrades instead of throwing, and says an empty log is not proof of silence', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') return [USER_ROW];
        throw new Error('SHM GET /admin/spool/history: HTTP 503');
      },
    });
    const result = (await notifyHistory.handler(
      { shm_user_id: USER, status: null, only_notifications: true, limit: 50 },
      ctx,
    )) as NotifyOut;
    expect(result.rows).toEqual([]);
    expect(result.degraded).toHaveLength(1);
    const partial = result.warnings.find((w) => w.code === 'partial_result');
    expect(partial?.message).toContain('not evidence that nothing');
    // Ни одна находка не считается по выжившему: список пуст, счётчики нулевые,
    // и ни одного вывода о доставке в предупреждениях нет.
    expect(result.warnings.map((w) => w.code)).not.toContain('empty_render');
    expect(result.warnings.map((w) => w.code)).not.toContain('delivery_verdict_not_recorded');
    expect(result.warnings.map((w) => w.code)).not.toContain('notifications_absent_in_window');
  });

  it('keeps the log when only the existence check failed', async () => {
    const ctx = makeCtx({
      shmList: (path: string): unknown => {
        if (path === '/admin/user') throw new Error('SHM GET /admin/user: HTTP 503');
        return [DELIVERED];
      },
    });
    const result = (await notifyHistory.handler(
      { shm_user_id: USER, status: null, only_notifications: true, limit: 50 },
      ctx,
    )) as NotifyOut;
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('says the client does not exist rather than letting an empty log stand for it', async () => {
    const result = await run([], {}, []);
    expect(result.warnings.map((w) => w.code)).toContain('user_not_found');
  });
});
