import { defineTool } from '@hq/registry';
import { scrubSecretShapesDeep } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asRecord, assertHumanOnly, capLimit, str, warn } from '../kit.js';
import { referenceWarnings, resolveReferences, scanReferences } from './dependencies.js';
import type { ReferenceScan } from './dependencies.js';
import { count, MAX_DETAILS, partial, pluginNodeCoverage, readCatalog, readSource, referenceExists, SHARED_LIST_NAME, SHARED_LISTS_PATH } from './sources.js';

export const sharedListsRead = defineTool({
  name: 'shared_lists_read',
  description:
    'Read Remnawave 3.3 external shared lists and their plugin/node dependencies. API names ' +
    'exclude ext:, while plugin references use ext:name. The catalog contains only previews; ' +
    'up to five selected list cards and five plugin cards are read per call. Returns types and ' +
    'item counts, never list values or raw plugin configuration. Unknown or incomplete usage ' +
    'is null. Requires node-plugins:shared-lists-list, node-plugins:shared-lists-get for details, ' +
    'and plugin/node read scopes for dependency coverage.',
  input: z.object({
    name: z.string().regex(SHARED_LIST_NAME).nullable().default(null).describe('API list name, without ext:'),
    include_details: z.boolean().default(true).describe('Read bounded list cards for actual type and item count'),
    limit: z.number().int().default(20).describe('List previews returned, capped at 40'),
  }),
  access: 'ro', risk: 'none', profiles: ['human'], backends: ['remna'],
  handler: async ({ name, include_details, limit }, ctx) => {
    assertHumanOnly(ctx, 'shared_lists_read is available to the human profile only: it exposes fleet plugin and shared-list dependencies.');
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, 20, 40);
    const [catalog, plugins, nodes] = await Promise.all([
      readCatalog(ctx, SHARED_LISTS_PATH, 'sharedLists', 'name', degraded, warnings),
      readCatalog(ctx, '/api/node-plugins', 'nodePlugins', 'uuid', degraded, warnings),
      readCatalog(ctx, '/api/nodes', 'nodes', 'uuid', degraded, warnings),
    ]);
    const pluginCards = await Promise.all(plugins.rows.slice(0, MAX_DETAILS).map(async (row) => {
      const body = await readSource(ctx, `/api/node-plugins/${encodeURIComponent(String(row.uuid))}`, degraded);
      const config = asRecord(body).pluginConfig;
      const configRead = config !== null && typeof config === 'object' && !Array.isArray(config);
      const scan = configRead ? scanReferences(config) : null;
      if (body !== null && !configRead) {
        degraded.push({ system: 'remna', error: 'A plugin card did not contain a readable configuration.' });
      }
      return { row, scan };
    }));
    const pluginComplete = plugins.complete && pluginCards.length === plugins.rows.length &&
      pluginCards.every((one) => one.scan?.complete === true);
    if (!pluginComplete) partial(warnings, 'Plugin dependencies are incomplete because catalog, detail or scan limits were reached; full list usage is unknown.');
    const scans = pluginCards.map((one) => one.scan).filter((one): one is ReferenceScan => one !== null);
    referenceWarnings(scans, catalog, warnings);
    const nodeCoverageComplete = pluginNodeCoverage(nodes);
    if (!nodeCoverageComplete) partial(warnings, 'Node plugin bindings are incomplete; full list usage by nodes is unknown.');

    const selected = name === null ? catalog.rows : [catalog.rows.find((row) => row.name === name) ?? { name }];
    const shown = selected.slice(0, cap);
    const items = await Promise.all(shown.map(async (row, index) => {
      const listName = String(row.name);
      const body = include_details && index < MAX_DETAILS && SHARED_LIST_NAME.test(listName)
        ? await readSource(ctx, `${SHARED_LISTS_PATH}/${encodeURIComponent(listName)}`, degraded) : null;
      const config = asRecord(asRecord(body).config);
      const detailValid = body !== null && asRecord(body).name === listName &&
        (config.type === 'ipList' || config.type === 'asList') && Array.isArray(config.items);
      if (body !== null && !detailValid) degraded.push({ system: 'remna', error: 'A shared-list card was malformed; its preview was retained.' });
      const users = pluginCards.filter((one) => one.scan?.names.includes(listName) === true);
      const pluginIds = new Set(users.map((one) => one.row.uuid));
      return {
        name: listName, reference: `ext:${listName}`,
        exists: referenceExists(detailValid || catalog.rows.some((listed) => listed.name === listName), catalog.complete),
        type: str(row.type), itemsCount: count(row.itemsCount),
        detailRead: detailValid,
        detail: detailValid ? { type: str(config.type), itemsCount: (config.items as unknown[]).length } : null,
        pluginsUsing: pluginComplete ? users.map((one) => ({ uuid: str(one.row.uuid), name: str(one.row.name) })) : null,
        nodesUsing: pluginComplete && nodeCoverageComplete ? nodes.rows
          .filter((one) => pluginIds.has(one.activePluginUuid))
          .map((one) => ({ uuid: str(one.uuid), name: str(one.name) })) : null,
      };
    }));
    if (include_details && shown.length > MAX_DETAILS) partial(warnings, `Only ${String(MAX_DETAILS)} selected list details were read; remaining counts are catalog previews.`);
    if (selected.length > cap) warnings.push(warn('truncated', `Shared-list previews were limited to ${String(cap)}; dependency checks use the bounded catalog.`));
    if (catalog.complete && catalog.rows.length === 0) warnings.push(warn('shared_lists_unused', 'The external shared-list catalog is available and empty.'));
    if (degraded.length > 0) partial(warnings, 'Some list or plugin details were unavailable; previews and unknown usage are retained.');
    return scrubSecretShapesDeep({
      lists: { read: catalog.read, complete: catalog.complete, declaredTotal: catalog.declaredTotal, returned: items.length, items },
      plugins: {
        complete: pluginComplete, declaredTotal: plugins.declaredTotal,
        items: pluginCards.map(({ row, scan }) => ({
          uuid: str(row.uuid), name: str(row.name),
          references: scan === null ? null : resolveReferences(scan, catalog),
          referencesComplete: scan?.complete ?? false,
        })),
      },
      nodesRead: nodes.read, nodeCoverageComplete,
      warnings, degraded,
    }).value;
  },
});
