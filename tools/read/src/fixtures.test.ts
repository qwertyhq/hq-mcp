import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR, fixtureOr, hasFixture, loadFixture } from './fixtures.js';

// Имя без ведущего подчёркивания: SAFE_ENDPOINT = /^[a-z0-9][a-z0-9._-]*$/i
// отвергает '__selftest' раньше, чем дело дойдёт до файла.
const dir = join(FIXTURES_DIR, 'shm');
const file = join(dir, 'selftest.json');
// selftest*.json — весь префикс в .gitignore (fixtures/*/selftest*.json), на
// случай если afterAll не отработает (краш процесса и т.п.) файл всё равно
// не попадёт в `git add`.
const corruptFile = join(dir, 'selftest-corrupt.json');
const emptyFile = join(dir, 'selftest-empty.json');

afterAll(() => {
  rmSync(file, { force: true });
  rmSync(corruptFile, { force: true });
  rmSync(emptyFile, { force: true });
});

describe('fixtures', () => {
  it('reports a missing fixture instead of throwing', () => {
    expect(hasFixture('shm', 'nothing-here')).toBe(false);
    expect(fixtureOr('shm', 'nothing-here', { fallback: true })).toEqual({ fallback: true });
    expect(() => loadFixture('shm', 'nothing-here')).toThrow(/probe-stands/);
  });

  it('prefers a real captured response over the hand-written stub', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ data: [{ user_id: 3073 }], items: 8123 }), 'utf8');
    expect(hasFixture('shm', 'selftest')).toBe(true);
    expect(fixtureOr('shm', 'selftest', { data: [] })).toEqual({
      data: [{ user_id: 3073 }],
      items: 8123,
    });
  });

  it('refuses an endpoint name that would escape the fixtures directory', () => {
    expect(() => loadFixture('shm', '../../../etc/passwd')).toThrow(/endpoint/);
    // Имя обязано начинаться с буквы или цифры — отсюда 'selftest', а не '__selftest'.
    expect(() => loadFixture('shm', '_selftest')).toThrow(/endpoint/);
  });

  describe('a fixture that exists but does not parse', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('degrades to the stub on malformed JSON instead of throwing', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(corruptFile, '{ "data": [ this is not json', 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      expect(fixtureOr('shm', 'selftest-corrupt', { data: [] })).toEqual({ data: [] });

      // Report goes to console.error, never stdout — this file is pulled into
      // the stdio server, where stdout is the MCP protocol channel.
      expect(errorSpy).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('degrades to the stub on an empty file instead of throwing', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(emptyFile, '', 'utf8');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(fixtureOr('shm', 'selftest-empty', { data: [] })).toEqual({ data: [] });
    });

    it('still loads valid JSON once the fixture is fixed', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(corruptFile, JSON.stringify({ data: [{ user_id: 1 }] }), 'utf8');

      expect(fixtureOr('shm', 'selftest-corrupt', { data: [] })).toEqual({
        data: [{ user_id: 1 }],
      });
    });
  });
});
