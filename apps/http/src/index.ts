#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { ConfigError, loadConfig } from '@hq/env';
import { listVisibleTools } from '@hq/exec';
import { buildRuntime } from '@hq/runtime';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import type { AppDeps, AppEnv } from './app.js';
import { parseTokens } from './auth.js';
import { loadHttpConfig } from './config.js';
import type { HttpServerConfig } from './config.js';
import { Metrics } from './metrics.js';

/**
 * Сколько ждать закрытия соединений на SIGTERM, прежде чем выйти всё равно.
 * Супервизор (systemd, docker stop) даёт на остановку свои 10 секунд и после
 * них шлёт SIGKILL — то есть процесс, честно ждущий вечно, всё равно будет
 * убит, только грубее и без строчки в журнале о том, что он вообще пытался.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Подхватывает `.env`, лежащий рядом с репозиторием сервера, если переменную
 * ещё не задали снаружи.
 *
 * ЭТО КОПИЯ `loadDotEnv` ИЗ `apps/stdio/src/index.ts`, И ЭТО ВРЕМЕННО. Общее
 * место у двух точек входа одно — `packages/env`, — но переносить туда сейчас
 * нельзя: пакет правит соседняя ветка (независимые бэкенды). Как только она
 * приедет, функция обязана переехать в `@hq/env` ОДНОЙ копией, а оба
 * приложения — импортировать её оттуда.
 *
 * Ищет ВВЕРХ от собственного файла, а не от cwd: рабочий каталог задаёт тот,
 * кто запускает (клиент MCP у stdio, юнит супервизора у этого сервера), и он
 * произвольный. Уже заданная переменная окружения имеет приоритет — иначе файл
 * молча переопределял бы то, что человек передал осознанно.
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

/** Код errno у ошибки сокета, если он там есть. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Единственное, что видит человек, у которого сервер не поднялся. Стек трассы
 * здесь бесполезен: и отказ конфигурации, и занятый порт описываются целиком
 * именем переменной и способом её задать, а трасса лишь прячет их за собой.
 *
 * Подсказка отличается от stdio-шной намеренно: этот бинарник запускает не
 * клиент MCP со своим env-блоком, а супервизор — systemd, docker, руки
 * оператора в шелле.
 */
export function startupErrorMessage(error: unknown): string {
  if (error instanceof ConfigError) {
    // Своя подсказка бьёт общую: у отказа «не настроена ни одна из двух
    // систем» правильных ответов два, и второй эту переменную не трогает.
    const hint =
      error.hint ??
      `set ${error.variable}=... in the .env file next to the server (it is read on startup, ` +
        'searching upwards from the installed binary) or in the environment of the unit that ' +
        'starts it.';
    return `fatal: ${error.message}\nhint: ${hint}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const hint = {
    EADDRINUSE: 'the port is already taken; pick another one with HQ_MCP_HTTP_PORT=...',
    EACCES:
      'the port is not available to this user (ports below 1024 need privileges); ' +
      'pick a high port with HQ_MCP_HTTP_PORT=...',
    EADDRNOTAVAIL:
      'no interface of this machine carries that address; check HQ_MCP_HTTP_HOST=... ' +
      '(leave it unset to listen on 127.0.0.1)',
  }[errnoOf(error) ?? ''];
  return hint === undefined ? `fatal: ${message}` : `fatal: ${message}\nhint: ${hint}`;
}

/** Адрес в виде, который можно скопировать в curl. IPv6 — в скобках. */
export function listenUrl(host: string, port: number): string {
  const shown = host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${String(port)}`;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Строка предупреждения, когда сервер слушает не только петлю.
 *
 * Он ходит в биллинг и панель рабочими кредами, а наружу отдаёт данные клиентов;
 * единственное, что стоит между ним и сетью, — Bearer-токен. Открыть его в сеть
 * — осознанное действие (`HQ_MCP_HTTP_HOST=0.0.0.0`), и оно обязано быть видно
 * в журнале запуска, а не только в конфиге, который никто больше не откроет.
 */
export function exposureWarning(host: string): string | null {
  if (LOOPBACK.has(host)) return null;
  return (
    `warning: listening on ${host}, not on loopback — this server holds production ` +
    'billing and panel credentials. Put a reverse proxy with TLS in front of it, or unset ' +
    'HQ_MCP_HTTP_HOST to listen on 127.0.0.1 only.'
  );
}

/**
 * Версия из собственного package.json (он лежит на уровень выше и `dist/`, и
 * `src/`, поэтому один и тот же путь работает и в сборке, и под tsx).
 * Читается, а не импортируется: `import ... with { type: 'json' }` под
 * `module: nodenext` затащил бы package.json в `dist/` как артефакт сборки.
 */
export function readVersion(moduleDir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(moduleDir, '..', 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version: unknown = (parsed as { version: unknown }).version;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    // Отсутствующий или битый package.json — не повод не поднимать сервер:
    // версия видна только в /healthz и ни на что не влияет.
  }
  return '0.0.0';
}

export interface Bootstrap {
  app: Hono<AppEnv>;
  deps: AppDeps;
  http: HttpServerConfig;
}

/**
 * Сборка всего, что нужно приложению, из окружения. Вынесена из `main` ровно
 * затем, чтобы её проверял тест: слушающий сокет для этого не нужен, а
 * ошибиться здесь можно молча — например, отдать `createApp` свежий `Budget`
 * вместо того единственного, который держит рантайм.
 *
 * ПОРЯДОК ВАЖЕН. Транспортные настройки читаются ПЕРВЫМИ, до кредов апстримов:
 * сервер без `HQ_MCP_HTTP_TOKENS` пускает кого угодно, поэтому он обязан
 * отказать раньше, чем вообще соберёт клиентов к биллингу и панели. Отказ
 * приходит из `loadHttpConfig`/`parseTokens` тем же `ConfigError`, что и у
 * `@hq/env`, — обработчик на старте один.
 */
export function bootstrap(env: NodeJS.ProcessEnv, moduleDir: string): Bootstrap {
  const http = loadHttpConfig(env);
  const tokens = parseTokens(http.rawTokens);
  const cfg = loadConfig(env);
  // Единственная точка сборки — та же, что у apps/stdio. Второй копии здесь
  // быть не может: разойдясь, два транспорта показали бы разные инструменты.
  const runtime = buildRuntime(cfg);
  const deps: AppDeps = {
    registry: runtime.registry,
    ctx: runtime.ctx,
    // Ведро — то самое, что раздаёт слоты клиентам апстримов, а не второе такое
    // же: SHM считает лимит по IP на весь сервис (§6.14).
    budget: runtime.budget,
    tokens,
    // Часы — общие с рантаймом: uptime в /metrics и durationMs в ответах
    // обязаны мерить одним и тем же временем.
    metrics: new Metrics({ now: runtime.ctx.now }),
    version: readVersion(moduleDir),
    imageRevision: http.imageRevision,
    deploymentConfigRevision: http.deploymentConfigRevision,
  };
  return { app: createApp(deps), deps, http };
}

/**
 * Поднимает сокет и разрешается ТОЛЬКО когда он действительно слушает.
 * `serve()` возвращает сервер синхронно, а `listen` падает асинхронно: без
 * этой обёртки занятый порт прилетел бы необработанным исключением со стеком —
 * то есть ровно тем, что `startupErrorMessage` и существует, чтобы заменить.
 */
export function listen(
  fetch: Hono<AppEnv>['fetch'],
  cfg: Pick<HttpServerConfig, 'host' | 'port'>,
): Promise<ServerType> {
  return new Promise<ServerType>((ok, fail) => {
    const onError = (error: unknown): void => {
      fail(error instanceof Error ? error : new Error(String(error)));
    };
    const server = serve({ fetch, hostname: cfg.host, port: cfg.port }, () => {
      // Снимается сразу: после успешного старта ошибки сокета — это уже не
      // отказ запуска, и отвечать на них должен обработчик из main.
      server.off('error', onError);
      ok(server);
    });
    server.once('error', onError);
  });
}

/**
 * Закрывает сокет и выходит с нулём. `closeIdleConnections` обязателен: без
 * него `close()` ждёт keep-alive соединений ai-bot-а, которые сами не
 * закроются, и «аккуратное завершение» превращается в SIGKILL по таймауту
 * супервизора.
 */
export function shutdown(server: ServerType, signal: string): void {
  console.error(`hq-mcp http: ${signal} received, closing`);
  const forced = setTimeout(() => {
    console.error(
      `hq-mcp http: connections still open after ${String(SHUTDOWN_GRACE_MS)}ms, exiting anyway`,
    );
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  // Таймер не держит цикл событий сам: если закрывать уже нечего, процесс
  // выходит естественно и тоже с нулём.
  forced.unref();
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  server.close(() => {
    clearTimeout(forced);
    process.exit(0);
  });
}

export async function main(): Promise<void> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(moduleDir, process.env);
  const { app, deps, http } = bootstrap(process.env, moduleDir);
  const server = await listen(app.fetch, http);

  // ТОЛЬКО stderr: привычка одна на оба приложения (в stdio что угодно в stdout
  // рвёт JSON-RPC), да и супервизор всё равно читает оба потока одинаково.
  const warning = exposureWarning(http.host);
  if (warning !== null) console.error(warning);
  const backends = Object.entries(deps.ctx.backends)
    .filter(([, present]) => present)
    .map(([name]) => name);
  console.error(
    `hq-mcp http ready: url=${listenUrl(http.host, http.port)} mode=${deps.ctx.mode} ` +
      `profile=${deps.ctx.profile} ` +
      `tools=${String(listVisibleTools({ registry: deps.registry, ctx: deps.ctx }).length)} ` +
      // Метки клиентов, а не токены: по метке видно, кто ходит, и её же
      // показывает разрез byClient в /metrics.
      `backends=${backends.join(',') || 'none'} clients=${deps.tokens.map((t) => t.label).join(',')}`,
  );

  // Уже поднятый сервер не должен падать стеком от ошибки одного соединения.
  server.on('error', (error: unknown) => {
    console.error(
      'hq-mcp http: server error:',
      error instanceof Error ? error.message : String(error),
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(server, signal);
    });
  }
}

/**
 * Запущен ли этот модуль как программа. Сравнение идёт по РЕАЛЬНОМУ пути: node
 * кладёт в import.meta.url путь с разрешёнными симлинками, а в process.argv[1]
 * — тот, которым позвали. Через симлинк (а это ровно то, что делает
 * объявленный в package.json `bin`) две строки не совпадают, main() не
 * зовётся, и процесс молча выходит с кодом 0 — оператор видит юнит, который
 * «стартовал» и сразу закончился, без единой строки о причине.
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
