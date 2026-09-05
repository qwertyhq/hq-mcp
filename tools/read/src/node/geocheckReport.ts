import { isIP } from 'node:net';
import { scrubSecretShapes } from '@hq/redact';
import type { ToolWarning } from '@hq/types';
import { asRecord, warn } from '../kit.js';

// Source: https://github.com/remnawave/geocheck/blob/581444c009cbb90f07a8a383fdb92f101eabafeb/internal/render/json.go
// The node contract describes rawReport as an open object. Only schema 1 fields
// from this serializer are projected; unknown fields and image data are never walked.
const MAX_ITEMS = 20;
const MAX_TEXT = 160;
type FieldKind = 'text' | 'number' | 'boolean' | 'ip' | 'country';
type Fields = Readonly<Record<string, FieldKind>>;

const IDENTITY: Fields = { ipv4: 'ip', ipv6: 'ip', asn: 'number', as_name: 'text', as_country: 'country' };
const CONSENSUS: Fields = { code: 'country', country: 'text', count: 'number', total: 'number', percent: 'number' };
const FINDING: Fields = { id: 'text', title: 'text', severity: 'text' };
const CONNECTIVITY: Fields = {
  icmp_available: 'boolean', privileged: 'boolean', score: 'number', latency_floor_ms: 'number',
};
const BREAKDOWN: Fields = {
  direct: 'number', peered: 'number', transit: 'number', detour: 'number', intercepted: 'number', failed: 'number',
};
const TARGET: Fields = {
  id: 'text', name: 'text', method: 'text', verdict: 'text', score: 'number',
  rtt_ms: 'number', excess_ms: 'number', jitter_ms: 'number', loss: 'number',
};
const PORTAL: Fields = {
  clean: 'boolean', plain_http_blocked: 'boolean', ok: 'number', captive_portal: 'number',
  altered: 'number', unreachable: 'number',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validScalar(value: unknown, kind: FieldKind): value is string | number | boolean {
  switch (kind) {
    case 'number': return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'boolean': return typeof value === 'boolean';
    case 'ip': return typeof value === 'string' && isIP(value) !== 0;
    case 'country': return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
    case 'text': return false;
  }
}

function reportText(value: string): string | null {
  // These labels are plain display text, never assignments, URLs, markup or
  // JSON. Drop those shapes even when a short secret evades the shared scrubber.
  if (value.length > 4096 || /[<>{}=]|:\/\/|data:/i.test(value)) return null;
  return scrubSecretShapes(value).text.slice(0, MAX_TEXT).replace(/[\x00-\x1f\x7f]/g, ' ');
}

export function summarizeGeocheckReport(value: unknown, warnings: ToolWarning[]): Record<string, unknown> | null {
  const source = asRecord(value);
  if (source.schema !== 1) {
    warnings.push(warn('geocheck_report_unavailable',
      'The node job succeeded, but its report is absent or uses an unsupported schema. No diagnostic summary is available.'));
    return null;
  }

  let truncated = false;
  let malformed = false;
  function scalar(value: unknown, kind: FieldKind): string | number | boolean | null {
    if (value === undefined || value === null) return null;
    if (kind === 'text' && typeof value === 'string') {
      if (value.length > MAX_TEXT) truncated = true;
      return reportText(value);
    }
    if (validScalar(value, kind)) return value;
    malformed = true;
    return null;
  }

  function fields(value: unknown, allowlist: Fields): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) { malformed = true; return null; }
    return Object.fromEntries(Object.entries(allowlist).map(([key, kind]) => [key, scalar(value[key], kind)]));
  }

  function list(value: unknown, allowlist: Fields): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) { malformed = true; return null; }
    if (value.length > MAX_ITEMS) truncated = true;
    const items = value.slice(0, MAX_ITEMS).map((item) => fields(item, allowlist));
    return { total: value.length, returned: items.length, items };
  }

  const connectivity = fields(source.connectivity, CONNECTIVITY);
  if (connectivity !== null) {
    const raw = asRecord(source.connectivity);
    connectivity.breakdown = fields(raw.breakdown, BREAKDOWN);
    connectivity.targets = list(raw.targets, TARGET);
  }
  const consensus = isRecord(source.consensus) ? source.consensus : null;
  if (source.consensus !== undefined && source.consensus !== null && consensus === null) malformed = true;
  const summary = {
    schema: 1,
    tool: scalar(source.tool, 'text'),
    timestamp: scalar(source.timestamp, 'text'),
    duration_ms: scalar(source.duration_ms, 'number'),
    identity: fields(source.identity, IDENTITY),
    findings: list(source.findings, FINDING),
    consensus: consensus === null ? null : {
      ipv4: list(consensus.ipv4, CONSENSUS), ipv6: list(consensus.ipv6, CONSENSUS),
    },
    connectivity,
    connectivity_checks: fields(source.connectivity_checks, PORTAL),
  };
  if (truncated) warnings.push(warn('geocheck_report_truncated',
    `Report lists are capped at ${MAX_ITEMS} rows and text at ${MAX_TEXT} characters; the summary is truncated.`));
  if (malformed) warnings.push(warn('geocheck_report_invalid_fields',
    'Some diagnostic fields have unexpected types or values and were omitted; null does not mean a healthy check.'));
  warnings.push(warn('geocheck_report_summary',
    'Only allowlisted diagnostic facts are shown. Images, raw payloads, transport credentials, ' +
    'hop arrays, response bodies and free-form details are omitted. Null sections contain no usable reported data.'));
  return summary;
}
