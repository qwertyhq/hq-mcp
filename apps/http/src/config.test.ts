import { describe, expect, it } from 'vitest';
import { ConfigError } from '@hq/env';
import { DEFAULT_HTTP_PORT, loadHttpConfig } from './config.js';

const base = { HQ_MCP_HTTP_TOKENS: 'example:0123456789abcdef01234567' } as NodeJS.ProcessEnv;

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
    expect(Object.keys(cfg).sort()).toEqual(['host', 'port', 'rawTokens']);
    expect(JSON.stringify(cfg)).not.toContain('9999');
  });
});
