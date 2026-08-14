import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntrypoint, noTtyMessage, repoRootFrom } from './index.js';

describe('repoRootFrom', () => {
  it('finds the root from both the source and the built layout', () => {
    expect(repoRootFrom('/repo/apps/setup/src')).toBe('/repo');
    expect(repoRootFrom('/repo/apps/setup/dist')).toBe('/repo');
  });
});

describe('noTtyMessage', () => {
  it('refuses with the way out instead of waiting for input nobody can give', () => {
    const message = noTtyMessage('/repo');

    expect(message).toContain('needs an interactive terminal');
    // Обе причины названы: клиент MCP и труба/CI.
    expect(message).toContain('/repo/apps/stdio/dist/index.js');
    // Именно `pnpm run setup`: `pnpm setup` — встроенная команда самого pnpm.
    expect(message).toContain('cd /repo && pnpm run setup');
    // И запасной путь для того, у кого терминала нет вовсе.
    expect(message).toContain('chmod 600 /repo/.env');
  });
});

describe('isEntrypoint', () => {
  it('is false when the module is merely imported', () => {
    expect(isEntrypoint('file:///repo/apps/setup/dist/index.js', undefined)).toBe(false);
    expect(isEntrypoint('file:///repo/apps/setup/dist/index.js', '/usr/bin/vitest')).toBe(false);
  });

  it('is true when it is the program being run', () => {
    const path = '/repo/apps/setup/dist/index.js';
    expect(isEntrypoint(pathToFileURL(path).href, path)).toBe(true);
  });
});

/**
 * ГЛАВНОЕ СВОЙСТВО МАСТЕРА — ЕГО ОТСУТСТВИЕ В СЕРВЕРЕ.
 *
 * Проверяется тестом, а не намерением: импорт, добавленный «чтобы подсказать
 * человеку, что конфиг не заполнен», превращает сервер в процесс, который
 * умеет ждать ввода. Ждать он будет в трубе JSON-RPC, где никто не читает и
 * никто не отвечает, а клиент покажет «connection closed» без причины.
 */
function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the transports do not carry the wizard', () => {
  for (const app of ['apps/stdio', 'apps/http']) {
    it(`${app} references neither @hq/setup nor apps/setup`, () => {
      const files = sourceFiles(`${app}/src`);
      expect(files.length).toBeGreaterThan(1);
      const offenders = files.filter((file) => /@hq\/setup|apps\/setup/.test(readFileSync(file, 'utf8')));
      expect(offenders).toEqual([]);
    });

    it(`${app} does not depend on it in package.json either`, () => {
      const manifest = readFileSync(`${app}/package.json`, 'utf8');
      expect(manifest).not.toContain('@hq/setup');
    });
  }
});
