import { z } from 'zod';
import type { ZodType } from 'zod';

/**
 * Единственное место в приложении, знающее версию zod. Канон репозитория — zod 4.4.3,
 * zod-to-json-schema не ставится (peer у MCP SDK 1.30 — "^3.25 || ^4.0").
 *
 * io: 'input'          — публикуем схему ВХОДА: с .default() поле необязательно на входе,
 *                        хотя на выходе парсера оно всегда есть.
 * unrepresentable:'any'— по умолчанию z.toJSONSchema БРОСАЕТ на z.date()/z.bigint(); тогда
 *                        catch ниже отдал бы { type: 'object' }, и бот увидел бы инструмент
 *                        вообще без полей — то есть /v1/tools начал бы врать. С 'any'
 *                        непредставимым остаётся одно поле, а не вся схема.
 *
 * catch остаётся только на случай «в input лежит не zod-схема» — это дефект реестра,
 * но валить из-за него весь список инструментов не стоит.
 */
export function toJsonSchema(input: ZodType<unknown>): Record<string, unknown> {
  try {
    return z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: 'object' };
  }
}
