import type { Degraded, ToolContext, ToolWarning } from '@hq/types';
import { asRecord, warn } from '../kit.js';
import { partial, readCatalog, referenceExists, SHARED_LIST_NAME, SHARED_LISTS_PATH } from './sources.js';
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

interface ScanState {
  names: Set<string>;
  visited: number;
  complete: boolean;
  seen: WeakSet<object>;
}

function collectReference(value: string, state: ScanState): void {
  if (value.includes('<redacted') || value === '<circular>') state.complete = false;
  if (!value.startsWith('ext:')) return;
  const name = value.slice(4);
  if (SHARED_LIST_NAME.test(name) && (state.names.has(name) || state.names.size < 100)) {
    state.names.add(name);
  } else {
    state.complete = false;
  }
}

function visitArray(values: unknown[], depth: number, state: ScanState): void {
  for (const value of values) {
    if (state.visited >= 10_000) { state.complete = false; break; }
    visit(value, depth, state);
  }
}

function visitRecord(
  record: Record<string, unknown>, depth: number, state: ScanState, skipEmbeddedCatalog = false,
): void {
  for (const key in record) {
    if (!Object.hasOwn(record, key) || (skipEmbeddedCatalog && key === 'sharedLists')) continue;
    if (state.visited >= 10_000) { state.complete = false; break; }
    visit(record[key], depth, state);
  }
}

function visit(value: unknown, depth: number, state: ScanState): void {
  state.visited += 1;
  if (state.visited > 10_000 || depth > 32) { state.complete = false; return; }
  if (typeof value === 'string') {
    collectReference(value, state);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) { state.complete = false; return; }
  state.seen.add(value);
  if (Array.isArray(value)) visitArray(value, depth + 1, state);
  else visitRecord(asRecord(value), depth + 1, state);
  state.seen.delete(value);
}

/** Mirrors injectSharedLists at 3.3.2: discard the root embedded catalog, then scan values. */
export function scanReferences(config: unknown): ReferenceScan {
  const state: ScanState = {
    names: new Set<string>(),
    visited: 0,
    complete: config !== null && typeof config === 'object' && !Array.isArray(config),
    seen: new WeakSet<object>(),
  };
  visitRecord(asRecord(config), 0, state, true);
  return { names: [...state.names], complete: state.complete };
}

export function resolveReferences(scan: ReferenceScan, catalog: Catalog | null): SharedListReference[] {
  const known = new Set(catalog?.rows.map((one) => one.name) ?? []);
  return scan.names.map((name) => ({
    name, reference: `ext:${name}`,
    exists: referenceExists(known.has(name), catalog?.complete === true),
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
