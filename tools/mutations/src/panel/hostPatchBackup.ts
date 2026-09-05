import { readBackup, sha256Of, stableStringify, writeBackup } from '../backups.js';
import type { BackupRecord } from '../backups.js';
import type { HostPatchBody } from './hostEdit.js';

export interface HostBodyRef {
  path: string;
  sha256: string;
}

export async function saveHostPatchBackup(
  dir: string,
  body: HostPatchBody,
  rollbackBody: HostPatchBody,
  now: Date,
): Promise<HostBodyRef> {
  const payload = { body, rollbackBody };
  const text = stableStringify(payload);
  const sha256 = sha256Of(text);
  const path = await writeBackup(dir, {
    kind: 'host', target: body.uuid, savedAt: now.toISOString(),
    bytes: Buffer.byteLength(text, 'utf8'), sha256, payload,
  });
  return { path, sha256 };
}

export async function loadHostPatchBackup(
  dir: string,
  path: string,
  uuid: string,
  expectedHash?: string,
): Promise<unknown> {
  // Сообщение JSON.parse или чужой metadata может содержать секрет из файла.
  let snapshot: BackupRecord;
  try {
    snapshot = await readBackup(dir, path, { kind: 'host', target: uuid });
  } catch {
    throw new Error('host_edit: backup недоступен, повреждён или принадлежит другому хосту.');
  }
  const text = stableStringify(snapshot.payload);
  if (snapshot.sha256 !== sha256Of(text) ||
      snapshot.bytes !== Buffer.byteLength(text, 'utf8') ||
      (expectedHash !== undefined && expectedHash !== snapshot.sha256)) {
    throw new Error('host_edit: нарушена целостность backup (sha256/bytes); постройте план заново.');
  }
  return snapshot.payload;
}
