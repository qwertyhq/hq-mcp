import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/read/src → корень репозитория три уровня вверх.
export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'fixtures',
);

const SAFE_ENDPOINT = /^[a-z0-9][a-z0-9._-]*$/i;

function pathFor(system: 'shm' | 'remna', endpoint: string): string {
  if (!SAFE_ENDPOINT.test(endpoint)) {
    throw new Error(
      `invalid fixture endpoint "${endpoint}": use the flattened route name, e.g. admin-user-search`,
    );
  }
  return join(FIXTURES_DIR, system, `${endpoint}.json`);
}

export function hasFixture(system: 'shm' | 'remna', endpoint: string): boolean {
  return existsSync(pathFor(system, endpoint));
}

export function loadFixture<T>(system: 'shm' | 'remna', endpoint: string): T {
  const file = pathFor(system, endpoint);
  if (!existsSync(file)) {
    throw new Error(
      `fixture ${system}/${endpoint}.json is missing. Capture it from the stands first: ` +
        'pnpm tsx scripts/probe-stands.ts',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/**
 * Форма ответа берётся из снятой со стенда фикстуры, если она есть, и из
 * рукописного стаба, если её ещё нет. Так тест не падает без стендов, но
 * немедленно ловит расхождение, как только фикстура появилась.
 *
 * `probe:stands` пишет файл не атомарно, и запись прерываема (Ctrl+C,
 * убитый процесс) — усечённый/пустой JSON на диске это реальный, а не
 * гипотетический артефакт. Если `loadFixture` не смог его распарсить, это
 * трактуется РОВНО как отсутствие фикстуры: тест деградирует к стабу вместо
 * падения. `console.error`, никогда не stdout — этот файл тянется в
 * apps/stdio, где stdout — протокольный канал MCP.
 */
export function fixtureOr<T>(system: 'shm' | 'remna', endpoint: string, fallback: T): T {
  if (!hasFixture(system, endpoint)) return fallback;
  try {
    return loadFixture<T>(system, endpoint);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `fixture ${system}/${endpoint}.json failed to parse, falling back to the stub: ${message}`,
    );
    return fallback;
  }
}
