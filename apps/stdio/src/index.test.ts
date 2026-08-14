import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '@hq/env';
import { isEntrypoint, loadDotEnv, startupErrorMessage } from './index.js';

/**
 * Единственное, что видит человек, у которого сервер не поднялся, — эта строка
 * в stderr клиента MCP. Стек трассы здесь бесполезен (падение конфига, а не
 * кода), а имя переменной и способ её задать — единственное, что чинит запуск.
 */
describe('startupErrorMessage', () => {
  it('names the missing variable and how to set it', () => {
    let thrown: unknown;
    try {
      loadConfig({
        SHM_BASE_URL: 'https://admin.example.test/shm/v1',
        SHM_ADMIN_AUTH: 'mcp:secret',
        REMNA_BASE_URL: 'https://panel.example.test',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    const message = startupErrorMessage(thrown);
    expect(message).toContain('fatal: Missing required environment variable REMNA_API_TOKEN');
    // Подсказка из @hq/env — что это за значение вообще.
    expect(message).toContain('Remnawave API token');
    // И способ его задать: без этой строки оператор знает ЧТО не так, но не
    // знает, куда это писать при запуске из клиента MCP.
    expect(message).toContain('REMNA_API_TOKEN=');
  });

  /**
   * Отказ пустой конфигурации — единственный, у которого правильных ответов
   * два. Общая подсказка «задайте SHM_BASE_URL» посылала бы человека с одной
   * панелью настраивать биллинг, которого у него нет.
   */
  it('offers both pairs when nothing at all is configured', () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (error: unknown) {
      thrown = error;
    }

    const message = startupErrorMessage(thrown);
    expect(message).toContain('Neither of the two backends is configured');
    expect(message).toContain('hint: set EITHER SHM_BASE_URL + SHM_ADMIN_AUTH');
    expect(message).toContain('REMNA_BASE_URL + REMNA_API_TOKEN');
    expect(message).toContain('pnpm setup');
    // Общая подсказка сюда не примешивается: одна подсказка на один отказ.
    expect(message).not.toContain('claude mcp add hq-mcp --env');
  });

  it('prints the message of any other failure without a stack trace', () => {
    expect(startupErrorMessage(new Error('boom'))).toBe('fatal: boom');
    expect(startupErrorMessage('not an error')).toBe('fatal: not an error');
  });
});

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'hq-stdio-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Отказ этой проверки не выглядит как отказ: main() просто не зовётся, процесс
 * выходит с кодом 0, не написав ни строки, а клиент MCP показывает «connection
 * closed» без единой подсказки, что чинить. Симлинк здесь не экзотика — это
 * ровно то, что делает объявленный в package.json `bin`.
 */
describe('isEntrypoint', () => {
  const target = join(dir, 'index.js');
  writeFileSync(target, '');
  const link = join(dir, 'hq-mcp-stdio');
  symlinkSync(target, link);
  const moduleUrl = pathToFileURL(target).href;

  it('recognises a direct start', () => {
    expect(isEntrypoint(moduleUrl, target)).toBe(true);
  });

  it('recognises a start through a bin symlink', () => {
    // node подставляет в import.meta.url РАЗРЕШЁННЫЙ путь, а в argv[1] — тот,
    // которым позвали; сравнение строк «как есть» здесь даёт false.
    expect(isEntrypoint(moduleUrl, link)).toBe(true);
  });

  it('stays false when this module is merely imported', () => {
    expect(isEntrypoint(moduleUrl, join(dir, 'vitest.js'))).toBe(false);
    expect(isEntrypoint(moduleUrl, undefined)).toBe(false);
  });
});

describe('loadDotEnv', () => {
  it('находит .env вверх по дереву и не затирает уже заданное', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-dotenv-'));
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, '.env'), 'FROM_FILE=file\nALREADY=fromfile\n# комментарий\nBAD\n');
    const env: NodeJS.ProcessEnv = { ALREADY: 'fromenv' };

    const found = loadDotEnv(nested, env);

    expect(found).toBe(join(dir, '.env'));
    expect(env.FROM_FILE).toBe('file');
    // Уже заданное снаружи ВАЖНЕЕ файла: иначе файл молча переопределял бы то,
    // что человек передал осознанно через конфиг клиента.
    expect(env.ALREADY).toBe('fromenv');
    // Строка без '=' не должна создавать пустую переменную.
    expect('BAD' in env).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('возвращает null, когда .env нигде нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-dotenv-none-'));
    expect(loadDotEnv(dir, {})).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });
});
