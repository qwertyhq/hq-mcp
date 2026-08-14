import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeTool, listVisibleTools } from '@hq/exec';
import type { ToolOutcome } from '@hq/exec';
import { REFUSAL_INSTRUCTIONS } from '@hq/registry';
import type { Registry } from '@hq/registry';
import type { ToolContext } from '@hq/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  /**
   * Наблюдатель за исходом вызова. Существует ради `/metrics` HTTP-контура:
   * ворота там уже считают аутентификацию для `/mcp`, и сервер, у которого
   * `auth.ok` растёт, а `totals.calls` стоит на нуле, читается как поломка.
   * Ровно наблюдатель, а не гейт: он не может ни отменить вызов, ни изменить
   * ответ, поэтому два транспорта не могут разойтись через него в поведении.
   *
   * ДВА ИСХОДА ЧЕРЕЗ НЕГО НЕ ПРОХОДЯТ И НЕ МОГУТ. `not_found` и
   * `invalid_input` SDK отвечает САМ, до колбэка инструмента (см. оговорку
   * ниже), поэтому здесь видны только `ok` и `handler_failed`. Это та же
   * асимметрия stdio и REST, что описана ниже, — просто увиденная со стороны
   * счётчиков.
   */
  onCall?: (tool: string, outcome: ToolOutcome) => void;
}

/**
 * Публикация реестра как MCP-сервера — ОДНА на все транспорты.
 *
 * Живёт в @hq/runtime по той же причине, по которой здесь живёт `buildRuntime`:
 * её зовут и `apps/stdio`, и `apps/http`, а второй экземпляр этого цикла
 * означал бы два транспорта, показывающих модели разные наборы инструментов и
 * разные их описания. Раньше функция лежала в `apps/stdio/src/server.ts`, и до
 * `/mcp` дотянуться до неё было нечем: у приложения нет `exports`, а
 * зависимость app→app потребовала бы объявить один бинарник библиотекой
 * другого.
 *
 * Редакцию ответа эта функция НЕ делает и делать не должна: её делает
 * `executeTool` по профилю (`redact(value, ctx.profile)`). Второй слой поверх
 * — как `redactBotStrict` в REST-фасаде — здесь означал бы, что один и тот же
 * инструмент в одном и том же профиле отвечает по stdio и по `/mcp` по-разному.
 */
export function createServer(
  registry: Registry,
  ctx: ToolContext,
  opts: McpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: opts.name ?? 'hq-mcp', version: opts.version ?? '0.1.0' },
    {
      capabilities: { tools: {} },
      // Модель должна видеть, почему запрещённых операций нет, ДО того как
      // начнёт искать их обходным путём (§8).
      instructions: [
        'hq-mcp exposes scenario tools over the SHM billing and the Remnawave panel.',
        'Run platform_probe first when anything behaves oddly: the OpenAPI specs lag production.',
        '',
        REFUSAL_INSTRUCTIONS,
      ].join('\n'),
    },
  );

  // Реестр уже отфильтрован по mode, profile и probe: в режиме ro мутаторы
  // сюда не попадают вовсе, модель их не видит и вызвать не может.
  for (const def of listVisibleTools({ registry, ctx })) {
    server.registerTool(
      def.name,
      {
        title: def.name,
        description: `${def.description} [access=${def.access}, risk=${def.risk}]`,
        // ЦЕЛИКОМ, а не .shape. Пустой вход тут ни при чём: getZodSchemaObject
        // (dist/esm/server/mcp.js:861-872) через isZodRawShapeCompat (:850-853,
        // «Empty objects are valid raw shapes») отдаёт для {} готовый
        // z4mini.object({}), так что z.object({}).shape работал бы наравне.
        // Разница в другом: objectFromShape (dist/esm/server/zod-compat.js:14-24)
        // пересобирает поля в СВОЙ zod-mini объект, теряя всё, что объявлено на
        // уровне объекта — .strict(), .catchall(), объектный .refine(). Схема
        // публикуется без этих ограничений, а вход разбирается по пересобранной
        // копии, а не по схеме самого инструмента.
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.access === 'ro',
          destructiveHint: def.access === 'rw',
          openWorldHint: true,
        },
      },
      // `args` — именно unknown, а не Record<string, unknown>: registerTool
      // выводит тип аргумента из схемы, а def.input объявлен как
      // ZodType<unknown> (дженерики стёр defineTool), поэтому SDK ждёт колбэк,
      // принимающий unknown. Сузить параметр здесь нельзя — контравариантность
      // отвергнет такой колбэк на компиляции. Разбор всё равно делает не этот
      // файл, а def.input.parse внутри executeTool, чей вход тоже unknown.
      async (args: unknown) => {
        // Исполнение — только через @hq/exec: редакция, гейт по probe, коды
        // исходов и стрижка тел бэкенда живут там, и копия этого цикла в
        // транспорте разошлась бы с оригиналом молча.
        //
        // ОДНА оговорка, которую здесь надо знать: разбор входа к моменту
        // вызова уже произошёл. SDK зовёт validateToolInput ДО хендлера
        // (dist/esm/server/mcp.js:129-131) и сам отвечает McpError(-32602) на
        // плохой вход (:172-184 → :141-149), поэтому `args` приходит сюда уже
        // разобранным, с применёнными defaults, а `def.input.parse` внутри
        // executeTool — второй, идемпотентный для этих шестнадцати схем проход.
        // Следствие: исход invalid_input на этом транспорте недостижим. Он
        // остаётся достижимым на REST-маршруте плана 3, где вход разбирает
        // только @hq/exec, — это известная асимметрия stdio и REST, и её обязан
        // учитывать тест паритета транспортов.
        const result = await executeTool(def.name, args, { registry, ctx });
        opts.onCall?.(def.name, result.ok ? 'ok' : result.code);
        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${def.name} failed (${result.code}): ${result.message}`,
              },
            ],
          };
        }
        // Читается ТОЛЬКО result.value. Предупреждения исполнителя (сегодня
        // одно — capability_unverified) он уже вложил внутрь значения, когда
        // значение объект; печатать вдобавок конверт result.warnings значило бы
        // показать модели одно и то же предупреждение дважды.
        const text = JSON.stringify(result.value, null, 2);
        return isPlainObject(result.value)
          ? { content: [{ type: 'text' as const, text }], structuredContent: result.value }
          : { content: [{ type: 'text' as const, text }] };
      },
    );
  }

  return server;
}
