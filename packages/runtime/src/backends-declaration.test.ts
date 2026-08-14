import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@hq/env';
import type { Backend, ToolDef } from '@hq/types';
import { buildRuntime } from './index.js';

/**
 * ОБЪЯВЛЕНИЕ `backends` СВЕРЯЕТСЯ С КОДОМ, А НЕ С ЧЬЕЙ-ТО ПАМЯТЬЮ.
 *
 * Поле решает, показывать инструмент или нет, и ошибка в нём молчалива по обе
 * стороны: недообъявил — инструмент виден там, где его бэкенда нет, и падает на
 * живом вызове; перебрал — инструмент исчез у людей, у которых он работал бы.
 * Ни то, ни другое не увидит ни один тест самого инструмента: у них обоих
 * настроены обе системы.
 *
 * Поэтому проверка идёт ПО ИСХОДНИКАМ и с двух сторон:
 *
 *  - НИЖНЯЯ ГРАНИЦА — всё, к чему инструмент обращается в СВОЁМ файле
 *    (`ctx.shm` / `ctx.remna`), обязано быть объявлено. Это и есть защита от
 *    инструмента, который ходит в систему молча.
 *  - ВЕРХНЯЯ ГРАНИЦА — объявить можно только то, до чего инструмент
 *    дотягивается хотя бы транзитивно, через свои же импорты. Она грубее
 *    нижней намеренно: часть импортов — чистые функции (`normalizeShmUser`), и
 *    требовать точного равенства значило бы запретить `client_search` объявлять
 *    один только биллинг.
 *
 * Между границами остаётся ровно один вид решения — «эта система нужна или
 * достаточно сказать вслух, что её нет», — и он принимается человеком, у
 * инструмента, комментарием рядом с полем.
 */
const SOURCE_ROOTS = ['tools/read/src', 'tools/mutations/src'];

/** Инструменты, которым не нужна НИ ОДНА система. Список закрыт и объясним. */
const NO_BACKEND_TOOLS = new Set([
  // Рассказывает, какие системы настроены; исчезнув вместе с одной из них, он
  // не смог бы ответить на этот вопрос по построению.
  'platform_probe',
  // Ходит в БАЗЫ через ssh-туннель, а не в API, и отказывает осмысленно всегда.
  'sql_query',
  // Служебные: журнал мутаций и применение сохранённого плана. Свой бэкенд у
  // них тот, который назвал план, и проверяет его ops_confirm по месту.
  'ops_audit',
  'ops_confirm',
]);

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('testkit.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Комментарии выброшены: `ctx.remna` в объяснении — это не обращение к панели. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const ALL_FILES = SOURCE_ROOTS.flatMap((root) => sourceFiles(root));

/**
 * Файл, в котором объявлен инструмент с этим именем. Два написания, потому что
 * два и есть в дереве: обычное `name: 'client_overview'` и вынесенное в
 * константу `const NAME = 'billing_adjust'` там, где имя нужно ещё и в текстах
 * отказов. Ни одно из них не совпадает со случайным упоминанием имени в
 * описании соседа — совпадение только с началом строки.
 */
function fileOf(name: string): string {
  const patterns = [
    new RegExp(`^\\s*name: '${name}',`, 'm'),
    new RegExp(`^const NAME = '${name}';`, 'm'),
  ];
  const found = ALL_FILES.filter((file) => {
    const source = readFileSync(file, 'utf8');
    return patterns.some((pattern) => pattern.test(source));
  });
  expect({ tool: name, declaringFiles: found.length }).toEqual({ tool: name, declaringFiles: 1 });
  return found[0] ?? '';
}

function usedIn(file: string): Set<Backend> {
  const source = code(file);
  const used = new Set<Backend>();
  if (/\bctx\.shm\b/.test(source)) used.add('shm');
  if (/\bctx\.remna\b/.test(source)) used.add('remna');
  return used;
}

/** То же, но следуя относительным импортам: до чего инструмент дотягивается вообще. */
function reachableFrom(entry: string): Set<Backend> {
  const seen = new Set<string>();
  const used = new Set<Backend>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    for (const backend of usedIn(file)) used.add(backend);
    for (const match of code(file).matchAll(/from\s+'(\.[^']+)'/g)) {
      stack.push(resolve(dirname(file), (match[1] ?? '').replace(/\.js$/, '.ts')));
    }
  }
  return used;
}

const runtime = buildRuntime(
  loadConfig({
    SHM_BASE_URL: 'https://billing.example.test/shm/v1',
    SHM_ADMIN_AUTH: 'mcp:secret',
    REMNA_BASE_URL: 'https://panel.example.test',
    REMNA_API_TOKEN: 'jwt-token',
    HQ_MCP_MODE: 'rw',
  }),
);
const everyTool: ToolDef[] = runtime.registry.list({ mode: 'rw', profile: 'human' }).concat(
  runtime.registry.list({ mode: 'rw', profile: 'bot' }),
);
const TOOLS = [...new Map(everyTool.map((def) => [def.name, def])).values()];

describe('every tool declares the backends it actually uses', () => {
  it('actually found the sources — an empty sweep would pass vacuously', () => {
    expect(ALL_FILES.length).toBeGreaterThan(40);
    expect(TOOLS.length).toBeGreaterThan(40);
  });

  /**
   * СИСТЕМА, К КОТОРОЙ ИНСТРУМЕНТ ОБРАЩАЕТСЯ, ЛИБО ОБЪЯВЛЕНА, ЛИБО СПРОШЕНА.
   *
   * Третьего быть не должно. Объявил — инструмент без этой системы не
   * показывается. Спросил `ctx.backends.<система>` — значит умеет ответить и
   * без неё и обязан сказать про недостающую половину вслух (так живут
   * `client_overview`, `client_resolve`, `server_inventory` и сама проба).
   * А вот необъявленный и непроверенный вызов — это ровно тот дефект, ради
   * которого файл написан: инструмент виден там, где его системы нет, и
   * узнаёт об этом первый живой вызов.
   */
  it('either declares each backend it calls or asks whether that backend exists', () => {
    const gaps = TOOLS.map((def) => {
      const file = fileOf(def.name);
      const declared = new Set(def.backends ?? []);
      const source = code(file);
      const missing = [...usedIn(file)].filter(
        (one) => !declared.has(one) && !new RegExp(`ctx\\.backends\\.${one}\\b`).test(source),
      );
      return { tool: def.name, missing };
    }).filter((row) => row.missing.length > 0);
    expect(gaps).toEqual([]);
  });

  it('declares nothing it cannot even reach through its own imports', () => {
    const extra = TOOLS.map((def) => {
      const reachable = reachableFrom(fileOf(def.name));
      return {
        tool: def.name,
        unreachable: (def.backends ?? []).filter((one) => !reachable.has(one)),
      };
    }).filter((row) => row.unreachable.length > 0);
    expect(extra).toEqual([]);
  });

  /**
   * Пустое объявление — это «показывать всегда», то есть самое сильное из
   * возможных утверждений. Забыть поле у нового инструмента выглядит ровно так
   * же, поэтому список тех, кому оно позволено, закрыт и лежит выше.
   */
  it('keeps the list of tools that need no backend closed', () => {
    const noBackend = TOOLS.filter((def) => (def.backends ?? []).length === 0).map((d) => d.name);
    expect(noBackend.sort()).toEqual([...NO_BACKEND_TOOLS].sort());
  });

  /** Мутатор пишет либо в биллинг, либо в панель. Никуда — это не мутатор. */
  it('gives every mutator a backend', () => {
    const writers = TOOLS.filter(
      (def) => def.access === 'rw' && !NO_BACKEND_TOOLS.has(def.name),
    );
    expect(writers.length).toBeGreaterThan(10);
    expect(writers.filter((def) => (def.backends ?? []).length === 0).map((d) => d.name)).toEqual(
      [],
    );
  });
});
