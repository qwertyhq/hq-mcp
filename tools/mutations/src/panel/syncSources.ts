import { z } from 'zod';
import type { ToolContext } from '@hq/types';
import { configFacts, fingerprint, isRecord, sharedListFacts, sharedListName, syncRefuse } from './syncConfig.js';

export const PLUGINS_PATH = '/api/node-plugins';
export const SHARED_LISTS_PATH = `${PLUGINS_PATH}/shared-lists`;
export const MAX_SYNC_AFFECTED_NODES = 20;
const MAX_PLUGIN_DETAILS = 10;
const MAX_LIST_DETAILS = 10;
const MAX_CATALOG = 100;
const MAX_NODES = 500;

const uuid = z.string().uuid().toLowerCase();
export const syncOperation = z.discriminatedUnion('target', [
  z.object({ target: z.literal('plugin'), uuid }).strict(),
  z.object({ target: z.literal('shared_list'), name: sharedListName }).strict(),
]);
export type SyncOperation = z.infer<typeof syncOperation>;

const pluginPreview = z.object({ uuid, name: z.string().min(1).max(255), viewPosition: z.number().int() });
const listPreview = z.object({ name: sharedListName, type: z.string(), itemsCount: z.number().int().nonnegative() });
const nodeSchema = z.object({
  uuid, name: z.string().min(1).max(255), activePluginUuid: uuid.nullable(),
  isDisabled: z.boolean(), isConnected: z.boolean(), isConnecting: z.boolean(),
});

/** Catch only transport errors here: their bodies may contain arbitrary raw config. */
export async function syncRead(ctx: ToolContext, path: string, raw = false): Promise<unknown> {
  try {
    return raw ? await ctx.remna.getRaw<unknown>(path) : await ctx.remna.get<unknown>(path);
  } catch (error) {
    const status = isRecord(error) && Number.isInteger(error.status) ? ` (HTTP ${String(error.status)})` : '';
    syncRefuse(`источник ${path} недоступен${status}; охват не установлен, план запрещён.`);
  }
}

function rows(value: unknown, key: string, max: number, allowArray = false): unknown[] {
  let result: unknown[];
  if (allowArray && Array.isArray(value)) result = value;
  else {
    if (!isRecord(value) || !Array.isArray(value[key]) ||
        !Number.isSafeInteger(value.total) || value.total !== value[key].length ||
        value.truncated === true || value.partial === true || value.hasMore === true) {
      syncRefuse(`источник ${key}: неполный или некорректный каталог; нулевой охват не установлен.`);
    }
    result = value[key];
  }
  if (result.length > max) syncRefuse(`источник ${key} превышает лимит ${String(max)}; обрезать охват нельзя.`);
  return result;
}

function parsedRows<T>(value: unknown[], schema: z.ZodType<T>, id: (row: T) => string, label: string): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) syncRefuse(`источник ${label}: некорректная или неполная запись.`);
  if (new Set(parsed.data.map(id)).size !== parsed.data.length) {
    syncRefuse(`источник ${label}: повторяющиеся идентификаторы; полный состав неизвестен.`);
  }
  return parsed.data.sort((a, b) => id(a).localeCompare(id(b)));
}

interface PluginFacts {
  uuid: string;
  name: string;
  fingerprint: string;
  sharedLists: string[];
}

async function readPlugin(ctx: ToolContext, preview: z.infer<typeof pluginPreview>): Promise<PluginFacts> {
  const detail = await syncRead(ctx, `${PLUGINS_PATH}/${preview.uuid}`, true);
  const parsed = pluginPreview.safeParse(detail);
  if (!parsed.success || parsed.data.uuid !== preview.uuid || parsed.data.name !== preview.name ||
      !isRecord(detail) || !Object.hasOwn(detail, 'pluginConfig') ||
      (detail.pluginConfig !== null && !isRecord(detail.pluginConfig))) {
    syncRefuse('источник карточки плагина неполный или состояние изменилось относительно каталога.');
  }
  return { uuid: preview.uuid, name: preview.name, ...configFacts(detail.pluginConfig) };
}

async function readLists(ctx: ToolContext, names: string[]) {
  if (names.length > MAX_LIST_DETAILS) syncRefuse(`число зависимостей превышает лимит ${String(MAX_LIST_DETAILS)} общих списков.`);
  if (names.length === 0) return { catalog: [], details: [], total: null };
  const catalog = parsedRows(
    rows(await syncRead(ctx, SHARED_LISTS_PATH), 'sharedLists', MAX_CATALOG),
    listPreview, (one) => one.name, 'sharedLists',
  );
  const details: Array<{ name: string; fingerprint: string; type: string; itemsCount: number }> = [];
  for (const name of names) {
    const preview = catalog.find((one) => one.name === name);
    if (preview === undefined) syncRefuse('источник sharedLists не содержит целевой список или зависимость; охват неизвестен.');
    const detail = await syncRead(ctx, `${SHARED_LISTS_PATH}/${encodeURIComponent(name)}`, true);
    if (!isRecord(detail) || detail.name !== name) syncRefuse('источник карточки общего списка неполный или изменилось имя.');
    const facts = sharedListFacts(detail.config);
    if (facts.type !== preview.type || facts.itemsCount !== preview.itemsCount) {
      syncRefuse('источник общего списка: состояние изменилось относительно каталога (тип/число элементов).');
    }
    details.push({ name, ...facts });
  }
  return { catalog, details, total: catalog.length };
}

export async function readSyncState(operation: SyncOperation, ctx: ToolContext) {
  if (ctx.profile !== 'human') syncRefuse('доступен только профилю human.');
  const [pluginBody, nodeBody] = await Promise.all([
    syncRead(ctx, PLUGINS_PATH), syncRead(ctx, '/api/nodes'),
  ]);
  const catalog = parsedRows(rows(pluginBody, 'nodePlugins', MAX_CATALOG), pluginPreview, (one) => one.uuid, 'nodePlugins');
  const nodes = parsedRows(rows(nodeBody, 'nodes', MAX_NODES, true), nodeSchema, (one) => one.uuid, 'nodes');
  const knownPlugins = new Set(catalog.map((one) => one.uuid));
  if (nodes.some((one) => one.activePluginUuid !== null && !knownPlugins.has(one.activePluginUuid))) {
    syncRefuse('источник nodePlugins не содержит привязанный к узлу плагин; каталоги неполны или изменились.');
  }
  const selected = operation.target === 'plugin'
    ? catalog.filter((one) => one.uuid === operation.uuid) : catalog;
  if (operation.target === 'plugin' && selected.length !== 1) syncRefuse('целевого плагина нет в полном каталоге; план не строится.');
  if (selected.length > MAX_PLUGIN_DETAILS) syncRefuse(`полный обход превышает лимит ${String(MAX_PLUGIN_DETAILS)} карточек плагинов.`);
  const reviewed: PluginFacts[] = [];
  // The list API deliberately omits pluginConfig; every possible dependent needs its card.
  for (const preview of selected) reviewed.push(await readPlugin(ctx, preview));
  const plugins = operation.target === 'plugin' ? reviewed
    : reviewed.filter((one) => one.sharedLists.includes(operation.name));
  const names = new Set(plugins.flatMap((one) => one.sharedLists));
  if (operation.target === 'shared_list') names.add(operation.name);
  const lists = await readLists(ctx, [...names].sort());
  const affectedPlugins = new Set(plugins.map((one) => one.uuid));
  const attached = nodes.filter((one) => one.activePluginUuid !== null && affectedPlugins.has(one.activePluginUuid));
  // Remnawave 3.3.2 NodesRepository.getEnabledNodesByPluginUuid, not merely !isDisabled.
  const affected = attached.filter((one) => !one.isDisabled && one.isConnected && !one.isConnecting);
  if (affected.length > MAX_SYNC_AFFECTED_NODES) syncRefuse(`охват превышает лимит ${String(MAX_SYNC_AFFECTED_NODES)} узлов.`);
  return {
    operation,
    configFingerprint: fingerprint({ plugins: reviewed, sharedLists: lists.details }),
    catalogFingerprint: fingerprint({ plugins: catalog, sharedLists: lists.catalog }),
    membershipFingerprint: fingerprint(attached),
    affectedNodeCount: affected.length,
    affectedNodes: affected.map((one) => ({ uuid: one.uuid, name: one.name, pluginUuid: one.activePluginUuid })),
    attachedNodeCount: attached.length,
    excludedNodeCount: attached.length - affected.length,
    plugins: plugins.map(({ uuid: id, name, sharedLists }) => ({ uuid: id, name, sharedLists })),
    sharedLists: lists.details.map(({ name, type, itemsCount }) => ({ name, type, itemsCount })),
    sourceCounts: { plugins: catalog.length, nodes: nodes.length, sharedLists: lists.total },
  };
}
