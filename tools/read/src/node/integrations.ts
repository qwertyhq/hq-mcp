import { defineTool } from '@hq/registry';
import { scrubSecretShapesDeep } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asRecord, assertHumanOnly, capLimit, str, warn } from '../kit.js';
import { partial, readCatalog, readSource, referenceExists, strings } from '../plugins/sources.js';

const PATH = '/api/node-integrations';

export const nodeIntegrationsRead = defineTool({
  name: 'node_integrations_read',
  description:
    'Read Remnawave 3.3 node integrations, structural config summaries and ordered node bindings. ' +
    'Later bindings override earlier top-level values. Integrations are sent separately from the ' +
    'computed Xray profile. Never returns configuration values. Missing references are only ' +
    'asserted after a complete catalog read; source failures remain unknown. Requires the ' +
    'node-integrations:list scope and node-integrations:get for an explicitly selected card.',
  input: z.object({
    integration_uuid: z.string().uuid().nullable().default(null),
    node_uuid: z.string().uuid().nullable().default(null),
    limit: z.number().int().default(20).describe('Integration and node rows returned, capped at 40'),
  }),
  access: 'ro', risk: 'none', profiles: ['human'], backends: ['remna'],
  handler: async ({ integration_uuid, node_uuid, limit }, ctx) => {
    assertHumanOnly(ctx, 'node_integrations_read is available to the human profile only: it exposes fleet integration bindings.');
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, 20, 40);
    const [catalog, nodes] = await Promise.all([
      readCatalog(ctx, PATH, 'nodeIntegrations', 'uuid', degraded, warnings),
      readCatalog(ctx, '/api/nodes', 'nodes', 'uuid', degraded, warnings),
    ]);
    let selected = catalog.rows;
    if (integration_uuid !== null) {
      const body = await readSource(ctx, `${PATH}/${integration_uuid}`, degraded);
      const card = asRecord(body);
      selected = catalog.rows.filter((one) => one.uuid === integration_uuid);
      if (card.uuid === integration_uuid) selected = [card];
      else if (body !== null) degraded.push({ system: 'remna', error: 'The selected integration card was malformed.' });
    }
    const known = new Set([...catalog.rows, ...selected].map((one) => one.uuid));
    const selectedNodes = node_uuid === null ? nodes.rows : nodes.rows.filter((one) => one.uuid === node_uuid);
    const nodeItems = selectedNodes.slice(0, cap).map((row) => {
      const ids = strings(row.integrationUuids);
      if (ids === null) partial(warnings, 'Some node integration bindings were omitted or malformed; an empty binding list cannot be assumed.');
      if (ids !== null && ids.length > 20) partial(warnings, 'A node exceeds the 20 integration binding limit; its returned bindings are truncated.');
      return {
        uuid: str(row.uuid), name: str(row.name), isDisabled: typeof row.isDisabled === 'boolean' ? row.isDisabled : null,
        integrationUuids: ids?.slice(0, 20) ?? null,
        bindings: (ids ?? []).slice(0, 20).map((uuid, position) => ({
          uuid, position, exists: referenceExists(known.has(uuid), catalog.complete),
        })),
      };
    });
    const usageComplete = nodes.complete && nodes.rows.every((row) => {
      const ids = strings(row.integrationUuids);
      return ids !== null && ids.length <= 20;
    });
    if (!usageComplete) partial(warnings, 'Node bindings could not be enumerated completely; integration usage is unknown.');
    const items = selected.slice(0, cap).map((row) => {
      const config = asRecord(row.config);
      const configRead = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config);
      if (!configRead) partial(warnings, 'An integration configuration was unreadable; its structural summary is unknown.');
      return {
        uuid: str(row.uuid), name: str(row.name),
        configRead, configSections: Object.keys(config).slice(0, 50),
        configSectionCount: configRead ? Object.keys(config).length : null,
        nodesUsing: usageComplete ? nodes.rows.flatMap((node) => (strings(node.integrationUuids) ?? [])
          .flatMap((uuid, position) => uuid === row.uuid ? [{ uuid: str(node.uuid), name: str(node.name), position }] : [])) : null,
      };
    });
    const missing = nodeItems.flatMap((one) => one.bindings).filter((one) => one.exists === false);
    if (missing.length > 0) warnings.push(warn('node_integration_missing', `${String(missing.length)} displayed node binding(s) refer to integrations absent from the complete catalog.`));
    if (catalog.complete && catalog.rows.length === 0) warnings.push(warn('node_integrations_unused', 'The integration catalog is available and empty.'));
    if (selected.length > cap || selectedNodes.length > cap) warnings.push(warn('truncated', 'Only the requested window of integrations and nodes is returned; reference checks use the bounded source catalogs.'));
    if (degraded.length > 0) partial(warnings, 'Some sources were unavailable; retain unknown states when assessing integration coverage.');
    return scrubSecretShapesDeep({
      integrations: { read: catalog.read, declaredTotal: catalog.declaredTotal, complete: catalog.complete, returned: items.length, items },
      nodes: { read: nodes.read, complete: nodes.complete, returned: nodeItems.length, items: nodeItems },
      warnings, degraded,
    }).value;
  },
});
