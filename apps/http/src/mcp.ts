import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '@hq/runtime';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppDeps, AppEnv } from './app.js';
import { MAX_BODY_BYTES } from './app.js';

/**
 * Конверт ошибки в том же виде, в каком его отдаёт сам транспорт SDK
 * (`createJsonErrorResponse`): клиент MCP разбирает тело как JSON-RPC ещё до
 * того, как посмотрит на код HTTP, и общий для приложения конверт
 * `{ error: { code, message } }` он прочитать не может. Поэтому на ЭТОМ
 * маршруте — и только на нём — форма ответа диктуется протоколом, а не REST-ом.
 */
function rpcError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status, headers);
}

/**
 * ЗАЩИТА ОТ DNS REBINDING.
 *
 * Сервер по умолчанию слушает петлю, а петля доступна не только тому, кто сидит
 * за машиной: страница в браузере оператора может увести собственный домен на
 * 127.0.0.1 и ходить сюда от его имени. Атака по построению браузерная, а
 * браузер на POST кросс-происхождения ВСЕГДА проставляет `Origin` (Fetch:
 * заголовок ставится для всех методов, кроме GET и HEAD, — а MCP по streamable
 * HTTP говорит именно POST-ом). Настоящий клиент MCP — node, CLI, расширение
 * редактора — не проставляет его никогда.
 *
 * Отсюда правило: любой запрос с `Origin` на этом маршруте отбивается. Оно
 * ничего не ломает и сегодня, потому что браузерного клиента у нас нет и быть
 * не может — сервер не отдаёт ни одного заголовка CORS, так что прочитать ответ
 * странице всё равно нечем.
 *
 * ПОЧЕМУ НЕ ОПЦИЯМИ ТРАНСПОРТА (`enableDnsRebindingProtection`, `allowedHosts`,
 * `allowedOrigins`). Три причины, каждая самостоятельная:
 *
 *  1. В этой же версии SDK все три помечены `@deprecated` с текстом «use
 *     external middleware instead» — то есть здесь и предлагается их держать.
 *  2. `allowedOrigins` не умеет сказать «никакой Origin не годится»: пустой
 *     список у него означает «проверка выключена» (webStandardStreamableHttp.js,
 *     `validateRequestHeaders`), а непустой пропускает перечисленные. Нужного
 *     нам правила там не выразить вовсе.
 *  3. `allowedHosts` пришлось бы заполнить публичным именем обратного прокси —
 *     данными развёртывания, которых у сервера нет. Ошибка в них даёт 403,
 *     неотличимый от поломки, а защиты сверх проверки Origin не добавляет:
 *     подменить Host в браузере нечем, это делает сам браузер.
 *
 * Ворота bearer стоят РАНЬШЕ (app.ts), поэтому страница без токена и так
 * получает 401. Эта проверка — второй рубеж на случай, если токен куда-то
 * утечёт: она отсекает браузер как класс, а не конкретный запрос.
 */
function refuseBrowserOrigin(c: Context<AppEnv>): Response | null {
  const origin = c.req.header('origin');
  if (origin === undefined || origin.trim() === '') return null;
  return rpcError(c, 403, -32000, 'Origin header is not accepted on this endpoint');
}

/**
 * MCP поверх streamable HTTP. Соседний `/v1/tools` — это внутренний REST-фасад
 * ai-bot, а НЕ протокол; настоящий клиент MCP подключается сюда.
 *
 * БЕЗ СЕССИЙ (`sessionIdGenerator` не задан), и это проверено живым клиентом,
 * а не выведено из спеки: `Client` + `StreamableHTTPClientTransport` из того же
 * SDK проходят `initialize` → `tools/list` → `tools/call` по этому маршруту (см.
 * mcp.test.ts). Сессии нужны серверу, который сам инициирует сообщения —
 * подписки, уведомления, progress; здесь каждый вызов самодостаточен, а
 * серверных сообщений нет ни одного. Взамен сессии потребовали бы карты живых
 * транспортов в памяти процесса, то есть липкости соединений: вторая копия
 * сервера за тем же прокси начала бы отвечать «Session not found» на запросы,
 * которые инициализировала первая, — и молча, потому что для клиента это
 * выглядит как обычный 404.
 *
 * `enableJsonResponse: true` — следствие того же: без server-initiated сообщений
 * SSE-поток на каждый вызов даёт один-единственный кадр с ответом и держит
 * соединение. Обычный JSON проще и для прокси, и для отладки curl-ом.
 *
 * СЕРВЕР И ТРАНСПОРТ — СВЕЖИЕ НА КАЖДЫЙ ЗАПРОС. Это требование самого SDK:
 * бессессионный транспорт бросает «Stateless transport cannot be reused across
 * requests» на втором вызове (`handleRequest`, проверка `_hasHandledRequest`),
 * потому что идентификаторы сообщений разных клиентов иначе сталкиваются.
 * Цена измерена на полном реестре: `createServer` + `connect` + `close` — около
 * 0.1 мс на 34 видимых инструмента, против десятков и сотен миллисекунд на
 * поход в SHM или в панель. Считать тут нечего.
 *
 * ПРЕДПОЛЁТНОГО СЛОТА БЮДЖЕТА ЗДЕСЬ НЕТ — в отличие от REST-фасада, и намеренно.
 * Там он взят затем, чтобы перебор имён инструментов стоил слота; в MCP перебирать
 * нечего — `tools/list` отдаёт весь видимый набор по протоколу, это его контракт.
 * Ведро при этом не обходится: слоты берут клиенты SHM и панели внутри вызова,
 * ровно как на stdio.
 */
export function registerMcpRoute(app: Hono<AppEnv>, deps: AppDeps): void {
  app.all('/mcp', async (c) => {
    const browserRefusal = refuseBrowserOrigin(c);
    if (browserRefusal !== null) return browserRefusal;

    // GET (SSE-поток серверных сообщений) и DELETE (закрытие сессии) этому
    // серверу нечем обслуживать: сессий нет, серверных сообщений нет. 405 —
    // это предусмотренный протоколом ответ, и клиент SDK понимает его как «SSE
    // тут не предлагают» и спокойно идёт дальше (client/streamableHttp.js,
    // `_startOrAuthSse` и `terminateSession`). Ответить 404 из notFound было бы
    // хуже: клиент считает его ошибкой и шумит в onerror.
    if (c.req.method !== 'POST') {
      return rpcError(c, 405, -32000, 'Method not allowed.', { Allow: 'POST' });
    }

    // Тот же контроль по факту прочитанных байт, что и в rest.ts: заголовка
    // content-length может не быть вовсе (chunked), и потолок в app.ts,
    // считающий по нему, такое тело пропускает.
    const raw = await c.req.text();
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_BODY_BYTES) {
      return c.json(
        {
          error: {
            code: 'payload_too_large',
            message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
          },
        },
        413,
      );
    }

    // Тело уже вычитано, поэтому исходный Request отдавать транспорту нельзя —
    // его поток разобран. Пересобирается ровно он же: тот же URL, те же
    // заголовки, то же тело. Разбор (Accept, Content-Type, JSON, схема
    // JSON-RPC) остаётся ЦЕЛИКОМ внутри SDK — иначе форму каждого его отказа
    // пришлось бы повторить здесь и потом сверять при обновлении SDK.
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-length', String(bytes));
    const request = new Request(c.req.url, { method: 'POST', headers, body: raw });

    const client = c.get('clientLabel');
    const server = createServer(deps.registry, deps.ctx, {
      version: deps.version,
      onCall: (tool, outcome) => {
        deps.metrics.noteCall(tool, outcome, client);
      },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      // `sessionIdGenerator` НЕ ПЕРЕДАЁТСЯ — это и есть бессессионный режим.
      // Пример в SDK пишет `sessionIdGenerator: undefined`, но под
      // exactOptionalPropertyTypes такая запись не компилируется: поле объявлено
      // необязательным, а не «принимающим undefined». Отсутствие поля даёт ровно
      // то же значение (конструктор читает options.sessionIdGenerator).
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // В режиме JSON-ответа этот промис разрешается уже ГОТОВЫМ ответом, а не
      // потоком, который дописывается позже, — поэтому закрывать сервер сразу
      // после него безопасно.
      return await transport.handleRequest(request);
    } finally {
      try {
        // Закрывает и транспорт: Protocol.close() дёргает transport.close().
        await server.close();
      } catch (err: unknown) {
        // Уборка одноразового сервера не имеет права подменить собой уже
        // собранный ответ клиенту — поэтому здесь ловится всё. Наружу такая
        // ошибка не уходит, в stderr уходит: stdout зарезервирован под
        // JSON-RPC stdio-сервера, и привычка одна на оба приложения.
        console.error(
          '[hq-mcp-http] mcp server close failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  });
}
