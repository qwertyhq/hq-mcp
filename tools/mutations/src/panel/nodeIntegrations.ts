import { z } from 'zod';
import type { ToolContext } from '@hq/types';
import { panelMutationError } from './panelMutationError.js';

const integrationUuidSchema = z.string().uuid().toLowerCase();
export const nodeIntegrationUuidsSchema = z.array(integrationUuidSchema).max(20);

export function integrationBindings(value: unknown): string[] | null {
  if (value === undefined) return null;
  const parsed = nodeIntegrationUuidsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('node_manage: панель вернула некорректный integrationUuids; состояние связей неизвестно.');
  }
  return parsed.data;
}

const catalogSchema = z.object({
  total: z.number().int().min(0),
  nodeIntegrations: z.array(z.object({ uuid: integrationUuidSchema })).max(5_000),
});

/** Каталог читается только при явной правке связей, на плане и перед записью. */
export async function assertNodeIntegrations(ctx: ToolContext, uuids: string[] | undefined): Promise<void> {
  if (uuids === undefined) return;
  const raw = await ctx.remna.get<unknown>('/api/node-integrations').catch((error: unknown) => {
    throw panelMutationError('GET /api/node-integrations', error);
  });
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success || parsed.data.total !== parsed.data.nodeIntegrations.length) {
    throw new Error('node_manage: каталог интеграций неполон или имеет неизвестную форму; проверить ссылки нельзя.');
  }
  const known = new Set(parsed.data.nodeIntegrations.map((one) => one.uuid));
  if (known.size !== parsed.data.total) {
    throw new Error('node_manage: каталог интеграций содержит повторные UUID; проверить ссылки нельзя.');
  }
  const missing = uuids.filter((uuid) => !known.has(uuid));
  if (missing.length > 0) {
    throw new Error(`node_manage: интеграции ${missing.join(', ')} отсутствуют в полном каталоге панели.`);
  }
}
