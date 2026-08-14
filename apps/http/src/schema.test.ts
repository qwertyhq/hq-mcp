import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { toJsonSchema } from './schema.js';

describe('toJsonSchema', () => {
  it('конвертирует zod-схему инструмента в JSON Schema входа', () => {
    const input: ZodType<unknown> = z.object({
      query: z.string().describe('telegram id / email / login'),
      limit: z.number().int().min(1).max(100).default(25),
    });
    const schema = toJsonSchema(input);
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.query?.type).toBe('string');
    expect(properties.query?.description).toBe('telegram id / email / login');
    expect(properties.limit?.default).toBe(25);
    expect(schema.required).toEqual(['query']);
  });

  it('непредставимый тип во входе не сносит схему целиком', () => {
    // В zod 4 z.toJSONSchema по умолчанию БРОСАЕТ на z.date()/z.bigint(). Глушить исключение
    // в { type: 'object' } нельзя: бот получит инструмент без единого поля и начнёт слать мусор.
    // Поэтому unrepresentable: 'any' — непредставимое поле становится {}, остальные живут.
    const input: ZodType<unknown> = z.object({
      user_id: z.number().int().positive(),
      since: z.date(),
    });
    const schema = toJsonSchema(input);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    // zod 4 отдаёт для .int() именно 'integer', а не 'number' — это контракт схемы,
    // который уезжает боту, и его стоит зафиксировать таким, какой он есть.
    expect(properties.user_id?.type).toBe('integer');
    expect(properties.since).toBeDefined();
    expect(schema.required).toEqual(['user_id', 'since']);
  });

  it('не роняет ручку, если объект вообще не zod-схема', () => {
    const weird = { safeParse: () => ({ success: true, data: {} }) } as unknown as ZodType<unknown>;
    expect(toJsonSchema(weird)).toEqual({ type: 'object' });
  });
});
