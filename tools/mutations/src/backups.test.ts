import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBackupDir, readBackup, sha256Of, stableStringify, writeBackup } from './backups.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'hq-bak-'));
}

describe('backups', () => {
  /**
   * ЭТО НЕ ПРО КРАСОТУ JSON, А ПРО ЛОЖНОЕ «МИР УЕХАЛ».
   *
   * Perl рандомизирует порядок ключей хеша на каждый процесс, и `encode_json`
   * печатает их в этом порядке. Два одинаковых чтения одного и того же ключа
   * storage, попавшие в разные воркеры SHM, дали бы разный `JSON.stringify` при
   * полностью одинаковых данных — и сверка мира отвергала бы каждый второй
   * план, объясняя это чужой правкой, которой не было.
   */
  it('хеш значения не зависит от порядка ключей', () => {
    const left = { b: 1, a: { d: [1, 2], c: 'x' } };
    const right = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(sha256Of(stableStringify(left))).toBe(sha256Of(stableStringify(right)));
    // ...и при этом РАЗНЫЕ данные по-прежнему дают разный хеш.
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    // Порядок элементов массива — это данные, а не порядок ключей.
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('снимок ложится на диск с правами 0600 и читается обратно', async () => {
    const where = dir();
    const path = await writeBackup(where, {
      kind: 'template',
      target: 'brevo_payment_received',
      savedAt: '2026-08-13T10:00:00.000Z',
      bytes: 5,
      sha256: sha256Of('hello'),
      payload: 'hello',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).payload).toBe('hello');

    const back = await readBackup(where, path, {
      kind: 'template',
      target: 'brevo_payment_received',
    });
    expect(back.payload).toBe('hello');
    // Путь принимается и относительным — он же уходит в подсказку оператору.
    const relative = path.slice(where.length + 1);
    expect((await readBackup(where, relative, { kind: 'template', target: 'brevo_payment_received' })).bytes).toBe(5);
  });

  it('выход из каталога снимков отвергается, в том числе через ..', async () => {
    const where = dir();
    await expect(
      readBackup(where, join(where, '..', '..', 'etc', 'passwd'), {
        kind: 'template',
        target: 'x',
      }),
    ).rejects.toThrow(/вне каталога снимков/);
  });

  it('дефолтный каталог лежит внутри .hq-mcp/, который уже гитигнорится', () => {
    expect(defaultBackupDir({} as NodeJS.ProcessEnv)).toContain('.hq-mcp');
    expect(defaultBackupDir({ HQ_MCP_BACKUP_DIR: '/srv/backups' } as NodeJS.ProcessEnv)).toBe(
      '/srv/backups',
    );
  });
});
