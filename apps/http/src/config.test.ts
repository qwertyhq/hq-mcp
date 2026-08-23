import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@hq/env';
import { DEFAULT_HTTP_PORT, loadHttpConfig } from './config.js';

const base = { HQ_MCP_HTTP_TOKENS: 'example:0123456789abcdef01234567' } as NodeJS.ProcessEnv;
const imageRevision = '0000000000000000000000000000000000000000';
const deploymentConfigRevision = '11111111-1111-4111-8111-111111111111';

const bot = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...base,
  HQ_MCP_PROFILE: 'bot',
  HQ_MCP_IMAGE_REVISION: imageRevision,
  HQ_MCP_DEPLOYMENT_CONFIG_REVISION: deploymentConfigRevision,
  ...over,
});

describe('loadHttpConfig', () => {
  it('падает без токенов: сервер без аутентификации не поднимаем', () => {
    expect(() => loadHttpConfig({} as NodeJS.ProcessEnv)).toThrow(/HQ_MCP_HTTP_TOKENS/);
    expect(() =>
      loadHttpConfig({ HQ_MCP_HTTP_TOKENS: '   ' } as NodeJS.ProcessEnv),
    ).toThrow(/HQ_MCP_HTTP_TOKENS/);
  });

  it('дефолты: слушаем только loopback', () => {
    const cfg = loadHttpConfig(base);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(DEFAULT_HTTP_PORT);
    expect(cfg.rawTokens).toBe('example:0123456789abcdef01234567');
    expect(cfg.imageRevision).toBeNull();
    expect(cfg.deploymentConfigRevision).toBeNull();
  });

  it('читает HTTP-токены из защищённого файла и не допускает двух источников', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-mcp-http-secret-'));
    try {
      const path = join(dir, 'http_tokens');
      writeFileSync(path, 'ai-bot:example-file-token-0123456789abcdef\n', { mode: 0o600 });
      expect(
        loadHttpConfig({ HQ_MCP_HTTP_TOKENS_FILE: path } as NodeJS.ProcessEnv).rawTokens,
      ).toBe('ai-bot:example-file-token-0123456789abcdef');

      const error = (() => {
        try {
          loadHttpConfig({ ...base, HQ_MCP_HTTP_TOKENS_FILE: path });
        } catch (caught: unknown) {
          return caught;
        }
        throw new Error('expected conflicting token sources to fail');
      })();
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe('HQ_MCP_HTTP_TOKENS');
      expect((error as Error).message).not.toContain(path);
      expect((error as Error).message).not.toContain('example-file-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bot-профиль требует обе канонические revision до старта', () => {
    expect(loadHttpConfig(bot())).toMatchObject({ imageRevision, deploymentConfigRevision });

    for (const [name, value] of [
      ['HQ_MCP_IMAGE_REVISION', undefined],
      ['HQ_MCP_IMAGE_REVISION', 'ABCDEF0000000000000000000000000000000000'],
      ['HQ_MCP_DEPLOYMENT_CONFIG_REVISION', undefined],
      ['HQ_MCP_DEPLOYMENT_CONFIG_REVISION', '11111111-1111-4111-8111-11111111111A'],
    ] as const) {
      const broken = bot();
      if (value === undefined) delete broken[name];
      else broken[name] = value;
      try {
        loadHttpConfig(broken);
        throw new Error(`expected ${name} to fail`);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variable).toBe(name);
      }
    }
  });

  it('читает переопределения из окружения', () => {
    const cfg = loadHttpConfig({
      ...base,
      HQ_MCP_HTTP_HOST: '0.0.0.0',
      HQ_MCP_HTTP_PORT: '9001',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      host: '0.0.0.0',
      port: 9001,
      rawTokens: 'example:0123456789abcdef01234567',
      imageRevision: null,
      deploymentConfigRevision: null,
    });
  });

  it('отвергает мусор в числовых переменных', () => {
    expect(() =>
      loadHttpConfig({ ...base, HQ_MCP_HTTP_PORT: 'abc' } as NodeJS.ProcessEnv),
    ).toThrow(/HQ_MCP_HTTP_PORT/);
    expect(() =>
      loadHttpConfig({ ...base, HQ_MCP_HTTP_PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow(/HQ_MCP_HTTP_PORT/);
    expect(() =>
      loadHttpConfig({ ...base, HQ_MCP_HTTP_PORT: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/HQ_MCP_HTTP_PORT/);
  });

  /**
   * Тот же класс ошибки, что и у @hq/env: apps/stdio печатает по нему подсказку
   * «set <VAR>=... в env-блоке клиента» (startupErrorMessage), и точка входа
   * apps/http обязана уметь то же самое. Голый Error назвал бы переменную только
   * внутри текста, откуда её пришлось бы выковыривать регуляркой.
   */
  it('несёт имя переменной машиночитаемо, а не только в тексте', () => {
    for (const [env, variable] of [
      [{}, 'HQ_MCP_HTTP_TOKENS'],
      [{ ...base, HQ_MCP_HTTP_PORT: 'abc' }, 'HQ_MCP_HTTP_PORT'],
    ] as Array<[NodeJS.ProcessEnv, string]>) {
      try {
        loadHttpConfig(env);
        throw new Error(`expected loadHttpConfig to throw for ${variable}`);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variable).toBe(variable);
      }
    }
  });

  it('своего бюджета у HTTP-слоя нет: ведро одно на процесс (§6.14)', () => {
    const cfg = loadHttpConfig({
      ...base,
      HQ_MCP_HTTP_BUDGET_LIMIT: '9999',
      HQ_MCP_HTTP_BUDGET_WINDOW_MS: '1',
    } as NodeJS.ProcessEnv);
    expect(Object.keys(cfg).sort()).toEqual([
      'deploymentConfigRevision',
      'host',
      'imageRevision',
      'port',
      'rawTokens',
    ]);
    expect(JSON.stringify(cfg)).not.toContain('9999');
  });
});
