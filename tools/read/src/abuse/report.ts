import { Budget, BudgetExceededError } from '@hq/budget';
import { defineTool } from '@hq/registry';
import { redact } from '@hq/redact';
import { z } from 'zod';
import type { KeyLimit } from '@hq/budget';
import type { Degraded, ToolDef, ToolWarning, TunnelConfig } from '@hq/types';
import { asArray, asRecord, assertHumanOnly, errMessage, settle, take, warn } from '../kit.js';

/**
 * Хук пересобирает отчёт НА КАЖДЫЙ запрос: `build_report()` делает
 * `exec_module` ~1300-строчного детектора и гоняет неограниченные сканы прямо
 * по биллинговой MySQL — `guard_hwid_log JOIN users` с коррелированной
 * `SUM(pays_history)` на строку (guard-hook.py:66-71), `user_services JOIN
 * users` с двумя коррелированными подзапросами на строку
 * (trial-abuse-guard.py:172-180) и ещё три выборки нарушителей. Кэша нет ни
 * одной строки. 120 секунд — не «щедрый таймаут», а порядок величины самой
 * сборки (сам хук даёт своей проверке ровно столько, guard-hook.py:41).
 */
const TIMEOUT_MS = 120_000;

/**
 * Собственный потолок вызовов, а не общий бюджет процесса. Общий бюджет
 * считает запросы к SHM и панели по ключу маршрута, а этот вызов идёт мимо
 * обоих клиентов — прямым fetch в туннель, — и поэтому не виден ни одному
 * счётчику. Цена одного вызова измеряется полными сканами биллинговой базы,
 * и «модель позвала инструмент в цикле» здесь стоит не трафика, а времени
 * той самой MySQL, на которой работает биллинг.
 *
 * Слот тратится ДО запроса, то есть и на отказ в соединении, который хуку
 * ничего не стоил. Иначе гейт бесполезен: узнать цену можно только после того,
 * как она уже заплачена. Отсюда и величина окна — она рассчитана на то, что
 * оператор с закрытым туннелем потратит пару попыток впустую.
 *
 * Бюджет создаётся модулем, а не приходит в deps, сознательно: сигнатура
 * фабрики — `{ fetchImpl }`, и необязательная зависимость означала бы гейт,
 * который забыли подключить в сборке рантайма и никто не заметил. Модульное
 * состояние здесь того же рода, что кэш platform_probe.
 */
export const ABUSE_BUDGET: KeyLimit = { limit: 5, windowMs: 5 * 60 * 1000 };
const BUDGET_KEY = 'tunnel:GET:/report';

let budget = new Budget(ABUSE_BUDGET);

/** Обнуляет счётчик вызовов (тесты; в проде окно истекает само). */
export function resetAbuseBudget(): void {
  budget = new Budget(ABUSE_BUDGET);
}

function errorNamed(error: unknown, name: string): boolean {
  const nameOf = (value: unknown): string =>
    typeof value === 'object' && value !== null && 'name' in value
      ? String((value as { name: unknown }).name)
      : '';
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause: unknown }).cause
      : undefined;
  return nameOf(error) === name || nameOf(cause) === name;
}

/**
 * Таймаут `AbortSignal.timeout` приезжает как DOMException с именем
 * 'TimeoutError' (у части рантаймов — завёрнутый в `cause`). Отличать
 * обязательно: «не успел» и «некуда стучаться» требуют от оператора
 * противоположных действий.
 */
const isTimeout = (error: unknown): boolean => errorNamed(error, 'TimeoutError');

/**
 * Внешняя отмена — 'AbortError'. Своя ветка, а не «считаем таймаутом»: отмена
 * не доказывает ни того, что хук медленный, ни того, что туннель закрыт, и
 * приписать её любой из двух готовых причин — та же ошибка атрибуции, ради
 * устранения которой эти причины и разведены. Сегодня внешний сигнал сюда
 * никто не передаёт; ветка существует затем, чтобы первый, кто начнёт, не
 * получил бесплатно неверный диагноз.
 */
const isCancelled = (error: unknown): boolean => errorNamed(error, 'AbortError');

/**
 * Хук shm-abuse-guard живёт во внутренней сети, наружу не опубликован и
 * закрыт общим секретом, поэтому у инструмента ТРИ разных отказа, и путать их
 * нельзя: закрытый туннель лечится ssh-командой, 403 — токеном, медленный
 * ответ — терпением. Один общий текст «хук недоступен, откройте туннель»
 * отправляет оператора чинить исправное.
 */
export function createAbuseReportTool(
  cfg: TunnelConfig,
  deps: { fetchImpl: typeof fetch },
): ToolDef {
  return defineTool({
    name: 'abuse_report',
    description:
      'Ready-made trial-abuse detection from the shm-abuse-guard hook plus the panel tops ' +
      '(devices per user, system stats). EXPENSIVE: the hook has no cache and rebuilds the whole ' +
      'report on every call by running unbounded scans over the billing MySQL itself, so a ' +
      'call takes tens of seconds and is limited to ' +
      `${String(ABUSE_BUDGET.limit)} per ${String(ABUSE_BUDGET.windowMs / 60_000)} minutes. ` +
      'Returns personal data (logins, e-mails, IP addresses) and needs both an ssh tunnel to the ' +
      'internal network and the guard hook token.',
    input: z.object({}),
    access: 'ro',
    risk: 'medium',
    // requires: ['tunnel.abuse'] СОЗНАТЕЛЬНО отсутствует. platform_probe
    // ставит эту возможность в жёсткий false, когда TCP-проба не прошла
    // (platform/probe.ts:164-166), а Registry.list выбрасывает инструмент с
    // проверенно-ложной возможностью (packages/registry/src/index.ts:92-97).
    // Закрытый туннель — штатное состояние, то есть инструмент исчезал бы из
    // tools/list ровно тогда, когда весь его смысл — сказать «открой туннель
    // такой-то командой». Исчезнувший инструмент учит модель, что возможности
    // нет вовсе; один потраченный вызов с внятным ответом дешевле.
    profiles: ['human'],
    backends: ['remna'],
    handler: async (_input, ctx) => {
      assertHumanOnly(
        ctx,
        'abuse_report is available to the human profile only: the hook returns logins, ' +
          'gmail addresses and IP addresses of real clients (guard-hook.py:82-89, ' +
          'trial-abuse-guard.py:1064-1076).',
      );

      const token = cfg.abuseToken?.trim() ?? '';
      if (token === '') {
        throw new Error(
          'No abuse-guard hook token is configured, so this call could only ever get 403. Set ' +
            "HQ_MCP_GUARD_HOOK_TOKEN to the contents of the hook's .guard-hook-secret file on the " +
            'SHM host (guard-hook.py:24-31): GET /report is authenticated by the X-Guard-Token header, ' +
            'not by the tunnel.',
        );
      }

      // Своя формулировка вместо родной: текст BudgetExceededError говорит про
      // общее ведро rate-limit и 429 у реальных клиентов, а здесь ни того ни
      // другого нет — цена в полных сканах биллинговой MySQL, и отказ обязан
      // называть её.
      try {
        budget.take(BUDGET_KEY);
      } catch (error: unknown) {
        const resetAt =
          error instanceof BudgetExceededError ? error.resetAt.toISOString() : 'the next window';
        throw new Error(
          `abuse_report has spent its local budget of ${String(ABUSE_BUDGET.limit)} calls per ` +
            `${String(ABUSE_BUDGET.windowMs / 60_000)} minutes and is refused until ${resetAt}. ` +
            'This is not an API rate limit: every call makes the hook rebuild the entire report ' +
            'with unbounded scans over the billing MySQL itself. A refused connection spends ' +
            'a slot too — the gate cannot know in advance whether the tunnel is open.',
        );
      }

      const url = `${cfg.abuseUrl}/report`;
      let response: Response;
      try {
        response = await deps.fetchImpl(url, {
          headers: { 'X-Guard-Token': token, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error: unknown) {
        if (isTimeout(error)) {
          throw new Error(
            `The abuse-guard hook at ${cfg.abuseUrl} did not answer in time ` +
              `(${String(TIMEOUT_MS / 1000)} s). This is not evidence that the tunnel is closed: ` +
              'the hook rebuilds the whole report on every request with unbounded scans over the ' +
              'billing MySQL itself, and a slow answer is its normal behaviour under load. ' +
              'Retry later, or ask an operator to look at the guard-hook logs on the SHM host.',
          );
        }
        if (isCancelled(error)) {
          throw new Error(
            `The request to ${cfg.abuseUrl} was cancelled before an answer arrived. That says ` +
              'nothing about the hook and nothing about the tunnel — do not read it as either ' +
              'being broken. Whoever cancelled it knows why; simply call again if it was not ' +
              'deliberate.',
          );
        }
        throw new Error(
          `The abuse-guard hook at ${cfg.abuseUrl} is unreachable (${errMessage(error)}). ` +
            'It runs inside the internal network and is not published, so ' +
            'the tunnel has to be open first:\n  ' +
            cfg.sshCommand,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `The abuse-guard hook answered ${String(response.status)}, so the tunnel carries ` +
              "traffic — the X-Guard-Token header is missing or wrong. The value is in the hook's " +
              '.guard-hook-secret file on the SHM host; put it in HQ_MCP_GUARD_HOOK_TOKEN ' +
              '(guard-hook.py:260-262).',
          );
        }
        // Тело — ПОСЛЕДНИМ, и это не вкусовщина. Страховочная стрижка
        // исполнителя режет от маркера `HTTP <код>: ` и до конца строки
        // (packages/exec/src/index.ts): тело, стоящее в середине, уносило с
        // собой всю подсказку оператору, написанную после него. Отделить одно
        // от другого стрижка не может — угадывать там нечем, — поэтому порядок
        // выбирает тот, кто пишет сообщение.
        throw new Error(
          `The abuse-guard hook answered ${String(response.status)} — something answered, so the ` +
            'tunnel carries traffic. 500 usually means build_report() itself failed ' +
            '(guard-hook.py:264-267) and its log on the SHM host carries the reason; 404 can also mean ' +
            'something other than the guard hook is listening on that port. Its answer verbatim, ' +
            `HTTP ${String(response.status)}: ${body.slice(0, 300)}`,
        );
      }

      let report: unknown;
      try {
        report = (await response.json()) as unknown;
      } catch {
        // Текст ошибки разбора СЮДА НЕ ПОПАДАЕТ. V8 кладёт в него первые ~10
        // символов тела (`Unexpected token '<', "<!DOCTYPE "... is not valid
        // JSON`), а тело этого хука — логины, gmail-адреса и IP живых
        // клиентов; страховочная стрижка исполнителя такой фрагмент не видит
        // вовсе, потому что маркера в нём нет. Оператору он при этом ничего не
        // добавляет: «ответ не JSON» — уже весь диагноз.
        throw new Error(
          'The abuse-guard hook answered 200 with a body that is not JSON. Check what ' +
            `${url} actually serves — a proxy or a login page on that port would look exactly ` +
            'like this.',
        );
      }

      const degraded: Degraded[] = [];
      const [top, stats] = await Promise.all([
        // Маршрут объявляет `size` и `start` и НЕ объявляет `limit`
        // (схема API Remnawave): лишний параметр просто отбрасывается, и
        // ответ приходит дефолтной страницей — то есть «топ» был бы не топом.
        settle(ctx.remna.get<unknown>('/api/hwid/devices/top-users', { size: 25, start: 0 })),
        // parameters: [] в обоих дампах OpenAPI. topNodesLimit/topUsersLimit —
        // обязательные параметры семейства /api/bandwidth-stats/*, а не этого
        // маршрута; здесь они лишние и рискуют вернуть 400.
        settle(ctx.remna.get<unknown>('/api/system/stats')),
      ]);

      const topValue = take(top, 'remna', degraded, []);
      const statsValue = asRecord(take(stats, 'remna', degraded, {}));

      // `degraded` без предупреждения — частичный ответ, выглядящий полным.
      // Десять остальных инструментов, умеющих деградировать, помечают его
      // partial_result, и вызывающий, ключующийся на этот код, у одиннадцатого
      // не находил ничего.
      const warnings: ToolWarning[] = [];
      if (degraded.length > 0) {
        warnings.push(
          warn(
            'partial_result',
            'A panel route did not answer (see `degraded`); the part it owns — the device top or ' +
              'the system stats — is empty rather than wrong. The hook report itself is ' +
              'unaffected: it either arrived whole or this call would have been refused.',
          ),
        );
      }

      return {
        report: asRecord(redact(report, ctx.profile)),
        topDevices: asArray(asRecord(topValue).users ?? topValue).map(asRecord),
        stats: statsValue,
        warnings,
        degraded,
      };
    },
  });
}
