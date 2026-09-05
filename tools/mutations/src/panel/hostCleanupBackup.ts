import { z } from 'zod';
import { hashInput } from '@hq/confirm';
import { readBackup, sha256Of, writeBackup } from '../backups.js';
import type { BackupRecord } from '../backups.js';

export const cleanupBackupRefSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

type CleanupBackupRef = z.infer<typeof cleanupBackupRefSchema>;

function targetOf(uuids: readonly string[]): string {
  return hashInput({ uuids: [...uuids].sort() });
}

/** Полный raw JSON, включая mapper и любые неизвестные поля, без вывода значений. */
export function cleanupHostsFingerprint(hosts: readonly Record<string, unknown>[]): string {
  const sorted = [...hosts].sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
  return hashInput({ hosts: sorted });
}

export function selectCleanupHosts(
  hosts: readonly Record<string, unknown>[],
  uuids: readonly string[],
): Record<string, unknown>[] {
  return uuids.map((uuid) => {
    const matches = hosts.filter((host) => host.uuid === uuid);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Error('host_cleanup: выбранный хост отсутствует или повторяется в ответе панели; план устарел.');
    }
    return matches[0];
  });
}

export async function saveCleanupBackup(
  dir: string,
  hosts: Record<string, unknown>[],
  now: Date,
): Promise<CleanupBackupRef> {
  const payload = { hosts };
  // JSON.stringify не переписывает свободные объекты (в том числе __proto__).
  const text = JSON.stringify(payload);
  const sha256 = sha256Of(text);
  try {
    const path = await writeBackup(dir, {
      kind: 'host_cleanup', target: targetOf(hosts.map((host) => String(host.uuid))),
      savedAt: now.toISOString(), bytes: Buffer.byteLength(text, 'utf8'), sha256, payload,
    });
    return { path, sha256 };
  } catch {
    throw new Error('host_cleanup: закрытый backup не записан; удаление запрещено.');
  }
}

/** Проверка восстановления ДО первого необратимого DELETE; наружу raw hosts не возвращаются. */
export async function verifyCleanupBackup(
  dir: string,
  ref: CleanupBackupRef,
  uuids: readonly string[],
  expectedFingerprint: unknown,
): Promise<void> {
  let snapshot: BackupRecord;
  try {
    snapshot = await readBackup(dir, ref.path, { kind: 'host_cleanup', target: targetOf(uuids) });
  } catch {
    // readBackup/JSON.parse могут включить содержимое повреждённого файла в error.message.
    throw new Error('host_cleanup: backup недоступен, повреждён или относится к другому списку хостов.');
  }
  const payload = snapshot.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || !('hosts' in payload) || !Array.isArray(payload.hosts) ||
      payload.hosts.length !== uuids.length || payload.hosts.some(
        (host: unknown) => host === null || typeof host !== 'object' || Array.isArray(host),
      )) {
    throw new Error('host_cleanup: backup не содержит полный снимок выбранных хостов.');
  }
  const text = JSON.stringify(payload);
  const hosts = payload.hosts as Record<string, unknown>[];
  const selected = selectCleanupHosts(hosts, uuids);
  if (snapshot.sha256 !== ref.sha256 || sha256Of(text) !== ref.sha256 ||
      snapshot.bytes !== Buffer.byteLength(text, 'utf8') ||
      cleanupHostsFingerprint(selected) !== expectedFingerprint) {
    throw new Error('host_cleanup: целостность backup (sha256/bytes/raw fingerprint) не совпадает с планом.');
  }
}
