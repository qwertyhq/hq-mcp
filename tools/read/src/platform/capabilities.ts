import type { ToolWarning } from '@hq/types';
import { asRecord, warn } from '../kit.js';

type CatalogReply =
  | { ok: true; value: unknown }
  | { ok: false; status: number | undefined };

/** Catalog access is independent of the metadata scope and of installed version. */
export function catalogCapability(
  configured: boolean,
  path: string,
  field: 'nodeIntegrations' | 'sharedLists',
  reply: CatalogReply,
): { capability: boolean | 'unknown'; warnings: ToolWarning[] } {
  if (!configured) return { capability: 'unknown', warnings: [] };
  if (reply.ok) {
    const body = asRecord(reply.value);
    if (Array.isArray(body[field]) && typeof body.total === 'number' &&
        Number.isSafeInteger(body.total) && body.total >= 0) {
      return { capability: true, warnings: [] };
    }
    return {
      capability: 'unknown',
      warnings: [warn('extension_probe_failed', `${path} returned an unrecognized catalog shape. ` +
        'Availability remains unknown; an empty catalog has not been established.')],
    };
  }
  if (reply.status === 404) {
    return {
      capability: false,
      warnings: [warn('extension_api_unavailable', `${path} returned 404. This optional Remnawave ` +
        '3.3 API is unavailable on this deployment; existing 3.0 tools remain usable.')],
    };
  }
  if (reply.status === 401 || reply.status === 403) {
    return {
      capability: 'unknown',
      warnings: [warn('extension_scope_denied', `${path} refused access (HTTP ${reply.status}). ` +
        'Check the token scope for this resource; a successful metadata read does not grant it. ' +
        'This does not establish that the optional API is absent.')],
    };
  }
  return {
    capability: 'unknown',
    warnings: [warn('extension_probe_failed', `${path} could not be verified` +
      (reply.status ? ` (HTTP ${reply.status})` : '') +
      '. Availability remains unknown; retry after the backend or request budget recovers.')],
  };
}
