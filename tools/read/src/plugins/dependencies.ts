import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import { asRecord, warn } from '../kit.js';
import { partial, readCatalog, SHARED_LIST_NAME, SHARED_LISTS_PATH } from './sources.js';
import type { Catalog } from './sources.js';

export interface ReferenceScan {
  names: string[];
  complete: boolean;
}

export interface SharedListReference {
  name: string;
  reference: string;
  exists: boolean | null;
}

/** Mirrors injectSharedLists at 3.3.2: discard the root embedded catalog, then scan values. */
export function scanReferences(config: unknown): ReferenceScan {
  const names = new Set<string>();
  let visited = 0;
  let complete = config !== null && typeof config === 'object' && !Array.isArray(config);
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): void {
    visited += 1;
    if (visited > 10_000 || depth > 32) { complete = false; return; }
    if (typeof value === 'string') {
      if (value.includes('<redacted') || value === '<circular>') complete = false;
      if (value.startsWith('ext:')) {
        const name = value.slice(4);
        if (SHARED_LIST_NAME.test(name) && (names.has(name) || names.size < 100)) names.add(name);
        else complete = false;
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) { complete = false; return; }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const nested of value) {
        if (visited >= 10_000) { complete = false; break; }
        visit(nested, depth + 1);
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (visited >= 10_000) { complete = false; break; }
        visit(asRecord(value)[key], depth + 1);
      }
    }
    seen.delete(value);
  }
  const record = asRecord(config);
  for (const key in record) {
    if (!Object.hasOwn(record, key) || key === 'sharedLists') continue;
    if (visited >= 10_000) { complete = false; break; }
    visit(record[key], 0);
  }
  return { names: [...names], complete };
}

export function resolveReferences(scan: ReferenceScan, catalog: Catalog | null): SharedListReference[] {
  const known = new Set(catalog?.rows.map((one) => one.name) ?? []);
  return scan.names.map((name) => ({
    name, reference: `ext:${name}`,
    exists: known.has(name) ? true : catalog?.complete === true ? false : null,
  }));
}

export function referenceWarnings(
  scans: ReferenceScan[], catalog: Catalog | null, warnings: ToolWarning[],
): void {
  const missing = new Set(scans.flatMap((scan) => resolveReferences(scan, catalog))
    .filter((one) => one.exists === false).map((one) => one.reference));
  if (missing.size > 0) warnings.push(warn(
    'shared_list_reference_missing',
    `${String(missing.size)} external shared-list reference(s) are absent from the complete catalog: ${[...missing].join(', ')}. Embedded sharedLists do not satisfy these references on Remnawave 3.3.`,
  ));
  if (scans.some((scan) => !scan.complete)) partial(warnings, 'External references were only partly scanned; the remaining dependencies are unknown.');
}

/** Existing diagnostics probe the optional 3.3 route only when a live config references it. */
export async function diagnoseReferences(
  ctx: ToolContext, scans: ReferenceScan[], degraded: Degraded[], warnings: ToolWarning[],
): Promise<Catalog | null> {
  const catalog = scans.some((scan) => scan.names.length > 0)
    ? await readCatalog(ctx, SHARED_LISTS_PATH, 'sharedLists', 'name', degraded, warnings)
    : null;
  referenceWarnings(scans, catalog, warnings);
  return catalog;
}
