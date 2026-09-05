import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export const sharedListName = z.string().min(2).max(255).regex(/^[A-Za-z0-9_-]+$/);

export function syncRefuse(message: string): never {
  throw new Error(`panel_sync: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Neither raw configuration values nor parser errors may enter a plan or its audit. */
export function configFacts(config: unknown): { fingerprint: string; sharedLists: string[] } {
  const references = new Set<string>();
  let visited = 0;
  let textSize = 0;
  const canonical = (value: unknown, depth: number): unknown => {
    visited += 1;
    if (visited > 100_000 || depth > 64 || textSize > 2_000_000) {
      syncRefuse('конфигурация превышает лимит безопасного обхода; частичный хеш запрещён.');
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      textSize += value.length;
      if (textSize > 2_000_000) syncRefuse('конфигурация превышает лимит размера.');
      if (/^(?:<redacted>|<masked>|\[REDACTED\])$/i.test(value)) {
        syncRefuse('источник конфигурации содержит маски вместо значений; полный хеш неизвестен.');
      }
      if (value.startsWith('ext:')) {
        const name = sharedListName.safeParse(value.slice(4));
        if (!name.success) syncRefuse('источник содержит некорректную ссылку на общий список.');
        references.add(name.data);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
    if (isRecord(value)) {
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value).sort()) {
        textSize += key.length;
        out[key] = canonical(value[key], depth + 1);
      }
      return out;
    }
    syncRefuse('источник конфигурации содержит некорректные JSON-данные.');
  };
  const encoded = JSON.stringify(canonical(config, 0));
  return {
    fingerprint: createHash('sha256').update(encoded).digest('hex'),
    sharedLists: [...references].sort(),
  };
}

export function fingerprint(value: unknown): string {
  return configFacts(value).fingerprint;
}

function ipOrCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

export function sharedListFacts(config: unknown): {
  fingerprint: string; type: string; itemsCount: number;
} {
  if (!isRecord(config) || !Array.isArray(config.items)) {
    syncRefuse('источник общего списка не содержит полной конфигурации и элементов.');
  }
  // Hash first so the same visit/size/depth bounds protect item validation too.
  const hash = fingerprint(config);
  const valid = config.type === 'ipList'
    ? config.items.every(ipOrCidr)
    : config.type === 'asList' && config.items.every((item) =>
      typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 4_294_967_295);
  if (!valid) syncRefuse('источник общего списка содержит неизвестный тип или некорректные элементы.');
  return { fingerprint: hash, type: config.type as string, itemsCount: config.items.length };
}
