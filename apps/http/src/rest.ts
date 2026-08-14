import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { BudgetExceededError } from '@hq/budget';
import { executeTool, listVisibleTools } from '@hq/exec';
import type { ToolOutcome } from '@hq/exec';
import type { AppDeps, AppEnv } from './app.js';
import { MAX_BODY_BYTES } from './app.js';
import { redactBotStrict, redactMessage } from './redactBot.js';
import { toJsonSchema } from './schema.js';

export type RestOutcome = 'ok' | 'not_found' | 'invalid_input' | 'budget' | 'failed';

export const STATUS_BY_OUTCOME: Readonly<Record<RestOutcome, ContentfulStatusCode>> = {
  ok: 200,
  invalid_input: 400,
  not_found: 404,
  budget: 429,
  failed: 502,
};

/**
 * ОДИН ключ ведра на весь HTTP-контур, а не ключ на имя инструмента.
 *
 * Ведро в SHM одно на сервис (считается по IP, §6.14), поэтому и здесь потолок общий:
 * ключ вида `http:<name>` дал бы каждому имени собственный нетронутый лимит, то есть
 * перебор имён стал бы БЕСПЛАТНЫМ — ровно то, что §6.14 запрещает, — а заодно превратил
 * бы «30 запросов в минуту на процесс» в «30 на каждый инструмент и на каждую опечатку».
 */
export const BUDGET_KEY = 'http:tool_call';

/** Коды @hq/exec → исходы транспорта. handler_failed — это всегда «апстрим или инструмент упал». */
function outcomeOf(code: Exclude<ToolOutcome, 'ok'>): RestOutcome {
  return code === 'handler_failed' ? 'failed' : code;
}

function fail(
  c: Context<AppEnv>,
  tool: string,
  outcome: RestOutcome,
  message: string,
  durationMs: number,
): Response {
  return c.json(
    { tool, outcome, error: { code: outcome, message: redactMessage(message) }, durationMs },
    STATUS_BY_OUTCOME[outcome],
  );
}

/**
 * Внутренний REST-контракт ai-bot, а НЕ MCP-протокол: настоящий MCP живёт на /mcp.
 * Оба слоя обязаны спрашивать про видимость одну и ту же listVisibleTools из @hq/exec и
 * выполнять один и тот же executeTool — свой цикл «найти → распарсить → вызвать →
 * отредактировать» разошёлся бы с исполнителем молча, и разницу между транспортами не
 * поймал бы ни один тест.
 */
export function registerRestRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const execDeps = { registry: deps.registry, ctx: deps.ctx };

  app.get('/v1/tools', (c) =>
    c.json({
      profile: deps.ctx.profile,
      mode: deps.ctx.mode,
      transport: 'rest-facade',
      tools: listVisibleTools(execDeps).map((def) => ({
        name: def.name,
        description: def.description,
        access: def.access,
        risk: def.risk,
        inputSchema: toJsonSchema(def.input),
      })),
    }),
  );

  app.post('/v1/tools/:name', async (c) => {
    const name = c.req.param('name');
    const client = c.get('clientLabel');
    const startedAt = deps.ctx.now().getTime();
    const elapsed = (): number => Math.max(0, deps.ctx.now().getTime() - startedAt);

    const raw = await c.req.text();
    // Заголовка content-length может не быть (chunked) — считаем по факту прочитанного.
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
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

    // Разбор тела идёт ДО обращения к реестру и ответ на него одинаков для любого имени:
    // иначе «битый JSON» стал бы вторым каналом, по которому видно, существует ли имя.
    let input: unknown = {};
    if (raw.trim() !== '') {
      try {
        input = JSON.parse(raw);
      } catch {
        deps.metrics.noteCall(name, 'invalid_input', client);
        return fail(c, name, 'invalid_input', 'request body is not valid JSON', elapsed());
      }
    }

    // Предполётный слот из единственного на процесс ведра — ДО обращения к реестру.
    // Во-первых, §7.6 требует держаться ниже порога самим, а не узнавать о нём из 429
    // апстрима. Во-вторых, перебор имён обязан стоить слота (§6.14). В-третьих, порядок
    // держит отказы единообразными: спроси мы сначала реестр, исчерпанное ведро стало бы
    // оракулом — «существует» отвечало бы 429, «не существует» 404.
    //
    // Отдельным исключением, а не веткой ExecResult, потому что executeTool по контракту
    // ловит ЛЮБУЮ ошибку хендлера и отдаёт handler_failed: BudgetExceededError изнутри до
    // транспорта не доезжает и отличить его там было бы нечем, кроме текста.
    try {
      deps.budget.take(BUDGET_KEY);
    } catch (err: unknown) {
      if (!(err instanceof BudgetExceededError)) throw err;
      deps.metrics.noteCall(name, 'budget', client);
      const retryAfterMs = Math.max(1, err.resetAt.getTime() - deps.ctx.now().getTime());
      // Retry-After информационный: ретраить 429 запрещено (§6.14) — счётчики SHM не
      // самозатухают, и повторная попытка бьёт по живым клиентам, а не по нам.
      return c.json(
        {
          tool: name,
          outcome: 'budget',
          error: { code: 'budget', message: redactMessage(err.message), retryAfterMs },
          durationMs: elapsed(),
        },
        STATUS_BY_OUTCOME.budget,
        { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      );
    }

    const result = await executeTool(name, input, execDeps);
    if (!result.ok) {
      // В метрики уходит КОД исполнителя (ToolOutcome), в HTTP-ответ — транспортный исход.
      deps.metrics.noteCall(name, result.code, client);
      return fail(c, name, outcomeOf(result.code), result.message, elapsed());
    }

    deps.metrics.noteCall(name, 'ok', client);
    // Второй слой редакции поверх транспортного redact(value, 'bot'), который уже отработал
    // внутри клиентов и внутри исполнителя. Конверт result.warnings наружу НЕ дублируется:
    // исполнитель уже вложил предупреждения внутрь значения, и stdio читает ровно так же —
    // разъехавшись здесь, транспорты показали бы модели разное на одном инструменте.
    const { value, report } = redactBotStrict(result.value);
    return c.json(
      { tool: name, outcome: 'ok', data: value, redaction: report, durationMs: elapsed() },
      200,
    );
  });
}
