import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { listVisibleTools } from '@hq/exec';
import type { Budget } from '@hq/budget';
import type { Registry } from '@hq/registry';
import type { ToolContext } from '@hq/types';
import { authenticate } from './auth.js';
import type { HttpToken } from './auth.js';
import type { Metrics } from './metrics.js';
import { registerMcpRoute } from './mcp.js';
import { registerRestRoutes } from './rest.js';

/**
 * Потолок тела запроса. Ручка торчит в docker-сеть ai-bot; без потолка любой клиент
 * (или ошибка в нём) кладёт процесс телом на сотни мегабайт. 256 КиБ с запасом хватает
 * на любой вход инструмента: самые толстые — это списки uuid, а массовых операций нет (§8).
 */
export const MAX_BODY_BYTES = 262_144;

export interface AppDeps {
  registry: Registry;
  ctx: ToolContext;
  /** Единственный на процесс бюджет из buildRuntime (§6.14). */
  budget: Budget;
  tokens: readonly HttpToken[];
  metrics: Metrics;
  version: string;
}

export type AppEnv = { Variables: { clientLabel: string } };

function createGuard(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = authenticate(c.req.header('authorization'), deps.tokens);
    deps.metrics.noteAuth(result.ok);
    if (!result.ok) {
      // Причина отказа (нет заголовка / не Bearer / чужой токен) наружу НЕ едет: она
      // подсказывает перебирающему, на каком шаге он ошибся. Внутри она видна в счётчиках.
      return c.json(
        { error: { code: 'unauthorized', message: 'valid Bearer token required' } },
        401,
        { 'WWW-Authenticate': 'Bearer' },
      );
    }
    c.set('clientLabel', result.label);
    await next();
  };
}

/**
 * Отбой по Content-Length — до чтения потока. Точный контроль по факту прочитанных байт
 * делает rest.ts: заголовка может не быть вовсе (chunked).
 */
const bodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
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
  await next();
};

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Публичная ручка: контейнерный healthcheck ходит без токена. Отдаёт признак жизни и
  // ЧИСЛО видимых инструментов — не их имена: количество перебрать реестр не помогает,
  // а имя помогает, и именно его прячет единообразный отказ в @hq/exec.
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'hq-mcp-http',
      version: deps.version,
      profile: deps.ctx.profile,
      mode: deps.ctx.mode,
      tools: listVisibleTools({ registry: deps.registry, ctx: deps.ctx }).length,
    }),
  );

  // Гейты регистрируются ДО обработчиков — иначе Hono выполнит обработчик без middleware.
  // /metrics стоит ЗА гейтом намеренно: byTool назван именами инструментов, которые бот
  // реально может звать, то есть открытый /metrics отдаёт инвентарь allowlist-а — ровно
  // то, что единообразный отказ `Tool <name> not found` закрывает с другой стороны.
  const guard = createGuard(deps);
  app.use('/metrics', guard);
  app.use('/v1/tools', guard);
  app.use('/v1/tools/:name', guard);
  app.use('/mcp', guard);
  // Потолок тела — ПОСЛЕ гейта: неаутентифицированному клиенту незачем узнавать по коду
  // ответа ни размер потолка, ни то, что за этим путём вообще есть ручка.
  app.use('/v1/tools/:name', bodyLimit);
  app.use('/mcp', bodyLimit);

  app.get('/metrics', (c) => c.json(deps.metrics.snapshot()));

  registerRestRoutes(app, deps);
  registerMcpRoute(app, deps);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'unknown route' } }, 404));
  app.onError((err, c) => {
    // Наружу не уходит ни стек, ни текст исключения: там могут быть URL с секретом shm-all.
    // В stderr — только сообщение: stdout зарезервирован под JSON-RPC stdio-сервера, и
    // привычка одна на оба приложения.
    console.error(
      '[hq-mcp-http] unhandled error:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: { code: 'error', message: 'internal error' } }, 500);
  });

  return app;
}
