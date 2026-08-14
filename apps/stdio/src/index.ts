#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from '@hq/env';
// createServer приезжает оттуда же, откуда buildRuntime, и это не оформление:
// её зовёт и маршрут /mcp в apps/http, а второй экземпляр этого цикла показал
// бы двум транспортам разные наборы инструментов.
import { buildRuntime, createServer } from '@hq/runtime';
import { listVisibleTools } from '@hq/exec';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Что человек видит в stderr клиента MCP, когда сервер не поднялся. Для
 * ConfigError стек трассы не несёт ничего: падение описано целиком именем
 * переменной и подсказкой из @hq/env, а трасса лишь прячет их за собой.
 * Поэтому здесь печатается имя переменной И способ её задать — оператор
 * запускает этот бинарник не из шелла, а из конфига клиента, где обычного
 * `export VAR=` нет.
 */
export function startupErrorMessage(error: unknown): string {
  if (error instanceof ConfigError) {
    // Своя подсказка бьёт общую. Общая называет ОДНУ переменную, и для отказа
    // «не настроена ни одна из двух систем» это неверно наполовину: правильных
    // ответов там два, и второй эту переменную не трогает вовсе.
    const hint =
      error.hint ??
      `set ${error.variable}=... in the env block of the MCP client entry ` +
        `(claude mcp add hq-mcp --env ${error.variable}=... -- node <path>/apps/stdio/dist/index.js) ` +
        'or in the .env file the server is started with (node --env-file-if-exists=.env).';
    return `fatal: ${error.message}\nhint: ${hint}`;
  }
  return `fatal: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Подхватывает `.env`, лежащий рядом с репозиторием сервера, если переменную
 * ещё не задали снаружи.
 *
 * Нужно потому, что этот бинарник запускает КЛИЕНТ MCP, а не шелл: у Claude
 * Code, Codex и OpenCode свои конфиги, и без этого один и тот же набор
 * секретов пришлось бы вписать в каждый из них — то есть размножить их по
 * файлам, которые никто не считает секретными. Один `.env` с правами 600
 * рядом с сервером лучше трёх копий в конфигах редакторов.
 *
 * Ищет ВВЕРХ от собственного файла, а не от cwd: рабочий каталог задаёт
 * клиент, и он произвольный. Уже заданная переменная окружения имеет
 * приоритет — иначе файл молча переопределял бы то, что человек передал
 * осознанно.
 */
export function loadDotEnv(startDir: string, env: NodeJS.ProcessEnv): string | null {
  let dir = startDir;
  for (let up = 0; up < 6; up += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (env[key] !== undefined) continue;
        env[key] = trimmed.slice(eq + 1).trim();
      }
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function main(): Promise<void> {
  loadDotEnv(dirname(fileURLToPath(import.meta.url)), process.env);
  const cfg = loadConfig();
  // Единственная точка сборки. Мутаторы плана 2 приезжают ВНУТРИ buildRuntime:
  // этот файл при мерже плана 2 не меняется ни на строку.
  const { registry, ctx } = buildRuntime(cfg);
  const server = createServer(registry, ctx);
  await server.connect(new StdioServerTransport());
  // ТОЛЬКО stderr: что угодно в stdout рвёт JSON-RPC.
  const published = listVisibleTools({ registry, ctx }).length;
  console.error(
    `hq-mcp stdio ready: mode=${cfg.mode} profile=${cfg.profile} tools=${String(published)}`,
  );
}

/**
 * Запущен ли этот модуль как программа. Сравнение идёт по РЕАЛЬНОМУ пути:
 * node кладёт в import.meta.url путь с разрешёнными симлинками, а в
 * process.argv[1] — тот, которым позвали. Через симлинк (а это ровно то, что
 * делает объявленный в package.json `bin`: node_modules/.bin/hq-mcp-stdio,
 * npm link) две строки не совпадают, main() не зовётся, и процесс молча
 * выходит с кодом 0 — клиент MCP показывает «connection closed» без единой
 * строки о причине. realpathSync на несуществующем пути бросает, поэтому
 * исходный путь остаётся запасным вариантом: хуже прежнего сравнения не будет.
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    resolved = argv1;
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(startupErrorMessage(error));
    process.exit(1);
  });
}
