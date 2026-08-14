import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReadTools } from './index.js';

/**
 * Считает ожидаемое число инструментов ПО ФАЙЛОВОЙ СИСТЕМЕ, а не по константе.
 * Тест на `length === 16` зеленеет и тогда, когда семнадцатый инструмент
 * написан, покрыт своими тестами и просто забыт в барреле: он не попадёт ни в
 * реестр, ни в `tools/list`, и отсутствие будет выглядеть как «такой
 * возможности нет». Здесь добавленный файл ломает сборку барреля сразу.
 */
function toolModules(dir: string): string[] {
  const infrastructure = ['kit.ts', 'testkit.ts', 'fixtures.ts'];
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(toolModules(path));
    else if (
      path.endsWith('.ts') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('index.ts') &&
      !infrastructure.some((name) => path.endsWith(name))
    ) {
      out.push(path);
    }
  }
  return out;
}

const tunnel = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: null,
  sshCommand: 'ssh -L 18099:host:8099 jump-host',
};

describe('barrel completeness', () => {
  it('registers exactly one tool per tool module, with no duplicate names', () => {
    const tools = createReadTools({
      tunnel,
      probeTcp: async () => false,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(toolModules('tools/read/src').length);
  });

  it('actually walks the tree — a typo in the path would pass vacuously', () => {
    expect(toolModules('tools/read/src').length).toBeGreaterThan(10);
  });
});
