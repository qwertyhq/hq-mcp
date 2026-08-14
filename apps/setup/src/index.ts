#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SetupAbortedError } from './errors.js';
import { InputClosedError, createTtyIo, hasTty } from './io.js';
import { runWizard } from './wizard.js';

/**
 * ОТДЕЛЬНАЯ ТОЧКА ВХОДА, А НЕ ФЛАГ СЕРВЕРА.
 *
 * Сервер запускает MCP-клиент, и запускает его без терминала: stdin занят
 * JSON-RPC, stdout — тоже, а любой байт, напечатанный туда не по протоколу,
 * рвёт сессию. Мастер, который умеет включиться внутри такого процесса —
 * хоть по флагу, хоть по «а вдруг конфига нет» — однажды включится и будет
 * ждать ответа на вопрос, которого никто не видит: клиент покажет «connection
 * closed», и причину не найдёт никто.
 *
 * Поэтому у мастера свой бинарник, а `apps/stdio` о нём не знает вовсе (это
 * проверено тестом, а не намерением).
 */

/** `<repo>/apps/setup/{src,dist}` → `<repo>`. Оба варианта ровно на три уровня. */
export function repoRootFrom(moduleDir: string): string {
  return resolve(moduleDir, '..', '..', '..');
}

export function noTtyMessage(repoRoot: string): string {
  return [
    'hq-mcp setup needs an interactive terminal, and this process does not have one.',
    '',
    'It refuses instead of waiting, because waiting here looks exactly like a hang:',
    'the question goes to a stdout nobody is reading, and the answer never comes.',
    '',
    'Two ways this usually happens:',
    '  * An MCP client started it. Clients run the SERVER, never this wizard —',
    `    the command they need is: node ${join(repoRoot, 'apps/stdio/dist/index.js')}`,
    '  * It was piped, or run from a script or CI. Run it from a terminal:',
    // `pnpm run setup`, а не `pnpm setup`: у самого pnpm есть встроенная
    // команда `setup`, она перехватывает вызов и вместо мастера правит
    // ~/.zshrc. Пропущенное `run` здесь стоит не «команда не найдена», а
    // молчаливо выполненного чужого действия.
    `      cd ${repoRoot} && pnpm run setup`,
    '',
    'If no terminal is available at all, write the file by hand instead:',
    `      cp ${join(repoRoot, '.env.example')} ${join(repoRoot, '.env')} && chmod 600 ${join(repoRoot, '.env')}`,
    '    every variable is documented in that file.',
  ].join('\n');
}

export async function main(): Promise<number> {
  const repoRoot = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
  if (!hasTty(process)) {
    console.error(noTtyMessage(repoRoot));
    return 1;
  }

  const io = createTtyIo();
  try {
    await runWizard({
      io,
      envPath: join(repoRoot, '.env'),
      serverPath: join(repoRoot, 'apps', 'stdio', 'dist', 'index.js'),
      now: () => new Date(),
    });
    return 0;
  } catch (error: unknown) {
    // Намеренная остановка и оборванный ввод — не аварии, и трассы им не
    // положено: она бы прятала единственную содержательную строку.
    if (error instanceof SetupAbortedError || error instanceof InputClosedError) {
      console.error(`\n${error.message}`);
      return 1;
    }
    console.error(`\nfatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    io.close();
  }
}

/**
 * Сравнение по РЕАЛЬНОМУ пути — тот же дефект, что чинил commit 71ce1c1 в
 * apps/stdio: node кладёт в `import.meta.url` путь с разрешёнными симлинками,
 * а в `argv[1]` — тот, которым позвали. Через симлинк (`node_modules/.bin`,
 * объявленный `bin`) строки не совпадают, main() не зовётся, и процесс молча
 * выходит с кодом 0, не задав ни одного вопроса и не написав ни одной строки.
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
  process.exitCode = await main();
}
