import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import { asRecord, warn } from '../kit.js';

/** These 3.3 catalog routes have no pagination; bound processing and subsequent card reads. */
export const MAX_SOURCE_ROWS = 500;
export const MAX_DETAILS = 5;
export const SHARED_LISTS_PATH = '/api/node-plugins/shared-lists';
export const SHARED_LIST_NAME = /^[A-Za-z0-9_-]{2,255}$/;

export interface Catalog {
  rows: Record<string, unknown>[];
  declaredTotal: number | null;
  read: boolean;
  complete: boolean;
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function referenceExists(found: boolean, catalogComplete: boolean): boolean | null {
  if (found) return true;
  return catalogComplete ? false : null;
}

/** Never copy an upstream error body: it can echo the private configuration that failed. */
export async function readSource(
  ctx: ToolContext,
  path: string,
  degraded: Degraded[],
): Promise<unknown> {
  try {
    const body = await ctx.remna.get<unknown>(path);
    if (body === null || body === undefined) {
      degraded.push({ system: 'remna', error: `GET ${path}: empty response body` });
      return null;
    }
    return body;
  } catch (error: unknown) {
    const status = asRecord(error).status;
    const message = error instanceof Error ? error.message : '';
    const httpStatus = typeof status === 'number' ? status : Number(/\b(401|403|404)\b/.exec(message)?.[1]);
    let reason = 'request failed';
    if (httpStatus === 401 || httpStatus === 403) reason = 'access denied; check the route scope';
    else if (httpStatus === 404) reason = 'route or object unavailable';
    degraded.push({ system: 'remna', error: `GET ${path}: ${reason}` });
    return null;
  }
}

export function parseCatalog(body: unknown, key: string, identity: string): Catalog {
  const record = asRecord(body);
  const raw = key === 'nodes' && Array.isArray(body) ? body : record[key];
  const declaredTotal = key === 'nodes' && Array.isArray(body) ? body.length : count(record.total);
  const read = Array.isArray(raw);
  const items: unknown[] = read ? raw : [];
  const rows = items.slice(0, MAX_SOURCE_ROWS).map(asRecord)
    .filter((row) => typeof row[identity] === 'string' && String(row[identity]).length > 0);
  const distinct = new Set(rows.map((row) => row[identity]));
  return {
    rows, declaredTotal, read,
    complete: read && declaredTotal !== null && rows.length === items.length &&
      rows.length === declaredTotal && distinct.size === rows.length,
  };
}

export async function readCatalog(
  ctx: ToolContext, path: string, key: string, identity: string,
  degraded: Degraded[], warnings: ToolWarning[],
): Promise<Catalog> {
  const body = await readSource(ctx, path, degraded);
  const catalog = parseCatalog(body, key, identity);
  if (body !== null && !catalog.read) degraded.push({ system: 'remna', error: `GET ${path}: malformed catalog` });
  if (!catalog.complete) partial(warnings, `${key} was unavailable or incomplete; absent references and complete usage cannot be established.`);
  return catalog;
}

export function partial(warnings: ToolWarning[], message: string): void {
  if (!warnings.some((one) => one.code === 'partial_result')) warnings.push(warn('partial_result', message));
}

export function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((one) => typeof one === 'string') ? value : null;
}

export function pluginNodeCoverage(catalog: Catalog): boolean {
  return catalog.complete && catalog.rows.every((row) => row.activePluginUuid === null ||
    (typeof row.activePluginUuid === 'string' && row.activePluginUuid.length > 0));
}
