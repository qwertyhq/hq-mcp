import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanForbiddenLiterals } from '@hq/registry';

/**
 * Скан существует с Task 5, но до сих пор его никто не звал ни по одному
 * настоящему исходнику — он был библиотечной функцией с юнит-тестами на
 * выдуманных строках. Предохранитель, который не запущен, не предохраняет:
 * §8-нарушение доехало бы до ветки, и поймал бы его только человек на ревью.
 *
 * Проходит по исходникам инструментов (тесты не в счёт: фикстуре положено
 * называть запрещённый путь, чтобы проверять отказ) и требует пустоты.
 */
function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('forbidden literal sweep', () => {
  it('no tool source hardcodes a forbidden path', () => {
    const offenders = sourceFiles('tools/read/src')
      .map((file) => ({ file, hits: scanForbiddenLiterals(readFileSync(file, 'utf8')) }))
      .filter((one) => one.hits.length > 0)
      .map((one) => `${one.file}: ${one.hits.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('actually reads files — an empty sweep would pass vacuously', () => {
    // Без этого тест зеленел бы и при опечатке в пути каталога.
    expect(sourceFiles('tools/read/src').length).toBeGreaterThan(15);
  });
});
