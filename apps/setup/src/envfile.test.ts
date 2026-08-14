import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupEnvFile,
  backupPathFor,
  isWritableEnvValue,
  parseEnvText,
  readEnvFile,
  renderEnvFile,
  writeEnvFile,
} from './envfile.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'hq-setup-'));

describe('parseEnvText', () => {
  it('reads the file exactly the way the server does', () => {
    const parsed = parseEnvText(
      ['# a comment', '', 'A=1', 'B = two words ', 'C=has=equals', 'nonsense', '=novalue'].join(
        '\n',
      ),
    );
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'has=equals' });
  });

  it('does not strip quotes, because the server does not strip them either', () => {
    // Разбор щедрее серверного показал бы человеку значение, которого в
    // рантайме не будет, и подтвердил бы то, что не работает.
    expect(parseEnvText('A="quoted"')).toEqual({ A: '"quoted"' });
  });
});

describe('readEnvFile', () => {
  it('reports a missing file as missing instead of as empty', () => {
    expect(readEnvFile(join(dir(), '.env'))).toEqual({ exists: false, values: {} });
  });
});

describe('isWritableEnvValue', () => {
  it('rejects a value with a line break, which .env silently truncates', () => {
    expect(isWritableEnvValue('one line')).toBe(true);
    expect(isWritableEnvValue('two\nlines')).toBe(false);
    expect(isWritableEnvValue('crlf\r\n')).toBe(false);
  });
});

describe('renderEnvFile', () => {
  it('writes sections in order and skips the empty ones', () => {
    const text = renderEnvFile(
      [
        { title: 'Required', entries: [{ key: 'A', value: '1' }] },
        { title: 'Empty', entries: [] },
        { title: 'Later', entries: [{ key: 'B', value: '2', comment: 'why B' }] },
      ],
      new Date('2026-08-13T09:00:00.000Z'),
    );

    expect(text).toContain('# ─── Required ───');
    expect(text).not.toContain('Empty');
    expect(text).toContain('# why B');
    expect(text.indexOf('A=1')).toBeLessThan(text.indexOf('B=2'));
    expect(text).toContain('# Written: 2026-08-13T09:00:00.000Z');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('round-trips through the parser it will be read with', () => {
    const text = renderEnvFile(
      [{ title: 'Required', entries: [{ key: 'SHM_BASE_URL', value: 'https://a.example.com/x' }] }],
      new Date(),
    );
    expect(parseEnvText(text)).toEqual({ SHM_BASE_URL: 'https://a.example.com/x' });
  });
});

describe('writeEnvFile', () => {
  it('creates the file with mode 0600', () => {
    const path = join(dir(), '.env');
    writeEnvFile(path, 'A=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a file that already existed with looser permissions', () => {
    // mode в writeFileSync действует только при СОЗДАНИИ: без отдельного chmod
    // мастер отчитался бы про 0600, не сделав их.
    const path = join(dir(), '.env');
    writeFileSync(path, 'A=old\n', { mode: 0o644 });
    writeEnvFile(path, 'A=new\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('backupEnvFile', () => {
  it('copies the old file, keeps it at 0600 and leaves the original in place', () => {
    const path = join(dir(), '.env');
    writeEnvFile(path, 'A=old\n');
    const backup = backupEnvFile(path, new Date('2026-08-13T09:00:00.000Z'));

    expect(backup).toBe(`${path}.backup-20260813-090000`);
    expect(readFileSync(backup ?? '', 'utf8')).toBe('A=old\n');
    expect(readFileSync(path, 'utf8')).toBe('A=old\n');
    expect(statSync(backup ?? '').mode & 0o777).toBe(0o600);
  });

  it('does not overwrite a backup taken in the same second', () => {
    const path = join(dir(), '.env');
    writeEnvFile(path, 'A=first\n');
    const now = new Date('2026-08-13T09:00:00.000Z');
    const first = backupEnvFile(path, now);
    writeEnvFile(path, 'A=second\n');
    const second = backupEnvFile(path, now);

    expect(second).not.toBe(first);
    expect(readFileSync(first ?? '', 'utf8')).toBe('A=first\n');
    expect(readFileSync(second ?? '', 'utf8')).toBe('A=second\n');
  });

  it('has nothing to back up when there is no file', () => {
    expect(backupEnvFile(join(dir(), '.env'), new Date())).toBeNull();
  });

  it('names backups so .gitignore already covers them', () => {
    // `.env.*` c исключением для `.env.example` — резервная копия обязана
    // попасть под первое правило и не попасть под второе.
    const name = backupPathFor('/repo/.env', new Date('2026-08-13T09:00:00.000Z'));
    expect(name.startsWith('/repo/.env.')).toBe(true);
    expect(name.endsWith('.example')).toBe(false);
  });
});
