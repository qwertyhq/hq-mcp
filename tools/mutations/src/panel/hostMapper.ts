import { z } from 'zod';
import { hashInput } from '@hq/confirm';
import type { MutationDeps } from '../kit.js';

const FORMATS = ['xrayJson', 'mihomo', 'base64', 'singbox'] as const;
const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function safeJson(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes('<redacted');
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(safeJson);
  return Object.entries(value).every(([key, item]) =>
    !PROTOTYPE_SEGMENTS.has(key) && !key.includes('<redacted') && safeJson(item),
  );
}

const mapperPath = z.string().min(1).max(512).refine(
  (path) => !path.split(/[.\[\]'"\s]+/).some((part) => PROTOTYPE_SEGMENTS.has(part)) &&
    !path.includes('<redacted'),
  'mapper path содержит запрещённый prototype-сегмент или маскированное значение.',
);

// set.value в 3.3.2 допускает JSON, кроме null на верхнем уровне.
// Проверка ДО Zod record/json: их разбор удаляет __proto__, теряя точность значения.
const mapperValue = z.unknown()
  .refine(safeJson, 'mapper value содержит prototype key или маскированное значение; нужен getRaw.')
  .pipe(z.union([
    z.string(), z.number(), z.boolean(), z.array(z.json()), z.record(z.string(), z.json()),
  ]))
  .describe('JSON: строка, число, boolean, массив или объект; null допустим только внутри массива/объекта.');

const operation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('copy'), from: mapperPath, to: mapperPath }),
  z.strictObject({ op: z.literal('set'), to: mapperPath, value: mapperValue }),
  z.strictObject({ op: z.literal('unset'), to: mapperPath }),
]);

export const hostMapperSchema = z.strictObject({
  xrayJson: z.array(operation).optional(),
  mihomo: z.array(operation).optional(),
  base64: z.array(operation).optional(),
  singbox: z.array(operation).optional(),
});

export function mapperHash(mapper: unknown): string {
  // Обёртка сохраняет даже вложенные plan_id/confirm_token; порядок операций значим.
  return hashInput({ mapper });
}

/** Только счётчики: paths и value могут содержать произвольные credentials. */
export function mapperSummary(mapper: unknown): Record<string, unknown> {
  const source = mapper !== null && typeof mapper === 'object' && !Array.isArray(mapper)
    ? mapper as Record<string, unknown> : {};
  const formats: Record<string, { total: number; copy: number; set: number; unset: number }> = {};
  let total = 0;
  for (const format of FORMATS) {
    const operations = source[format];
    if (!Array.isArray(operations)) continue;
    const counts = { total: operations.length, copy: 0, set: 0, unset: 0 };
    for (const item of operations as unknown[]) {
      if (item === null || typeof item !== 'object') continue;
      const op = (item as Record<string, unknown>).op;
      if (op === 'copy' || op === 'set' || op === 'unset') counts[op] += 1;
    }
    formats[format] = counts;
    total += counts.total;
  }
  return { present: mapper !== undefined, total, formats };
}

/** Каркас пишет input в audit: скрываем свободные values до записи в журнал. */
export function hostMapperAuditDeps(deps: MutationDeps): MutationDeps {
  return {
    ...deps,
    audit: {
      search: (query) => deps.audit.search(query),
      write: (entry) => {
        const input = entry.input;
        if (input === null || typeof input !== 'object' || !('mapper' in input)) {
          return deps.audit.write(entry);
        }
        const { mapper, ...rest } = input as Record<string, unknown>;
        return deps.audit.write({ ...entry, input: { ...rest, mapper: mapperSummary(mapper), mapperHash: mapperHash(mapper) } });
      },
    },
  };
}
