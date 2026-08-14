import { describe, expect, it } from 'vitest';
import { ConfigError } from '@hq/env';
import { authenticate, MIN_TOKEN_LENGTH, parseTokens } from './auth.js';

const BOT = 'bot-token-0123456789abcdefgh';
const PANEL = 'panel-token-0123456789abcdefgh';

describe('parseTokens', () => {
  it('разбирает список "label:token"', () => {
    expect(parseTokens(`bot:${BOT}, panel:${PANEL}`)).toEqual([
      { label: 'bot', token: BOT },
      { label: 'panel', token: PANEL },
    ]);
  });

  it('отказывается работать без токенов', () => {
    expect(() => parseTokens(undefined)).toThrow(/refusing to start/i);
    expect(() => parseTokens('   ')).toThrow(/refusing to start/i);
    expect(() => parseTokens(' , ,')).toThrow(/refusing to start/i);
  });

  it('требует метку и достаточно длинный токен', () => {
    expect(() => parseTokens(BOT)).toThrow(/<label>:<token>/);
    expect(() => parseTokens('bot:')).toThrow(/<label>:<token>/);
    expect(() => parseTokens('bot:tiny')).toThrow(new RegExp(String(MIN_TOKEN_LENGTH)));
  });

  it('не выводит сам токен в текст ошибки', () => {
    // Значение токена выбрано так, чтобы не быть подстрокой самого сообщения об ошибке:
    // 'short' внутри 'shorter than 24 characters' дал бы ложное срабатывание ассерта.
    try {
      parseTokens('bot:tiny');
      throw new Error('expected parseTokens to throw');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      expect(message).not.toContain('tiny');
      expect(message).toContain('bot');
    }
  });

  /**
   * Тот же ConfigError, что и в config.ts: всё, что здесь падает, падает из-за
   * одной переменной, и точка входа обязана уметь назвать её оператору.
   */
  it('падает ConfigError с именем переменной', () => {
    try {
      parseTokens(undefined);
      throw new Error('expected parseTokens to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe('HQ_MCP_HTTP_TOKENS');
    }
  });

  /**
   * Один и тот же токен под двумя метками — не «две записи», а одна с двумя именами:
   * authenticate вернул бы последнюю совпавшую, и весь разрез byClient (ради которого
   * метки и заведены) молча приписывал бы вызовы бота панели. Отзыв тоже ломается:
   * оператор убирает строку "bot:", уверен, что закрыл боту доступ, а токен продолжает
   * работать под второй меткой.
   */
  it('отвергает один и тот же токен под двумя метками', () => {
    expect(() => parseTokens(`bot:${BOT},panel:${BOT}`)).toThrow(/duplicate token/i);
  });

  it('отвергает повторяющуюся метку', () => {
    expect(() => parseTokens(`bot:${BOT},bot:${PANEL}`)).toThrow(/duplicate label/i);
  });

  it('дубликат не проговаривается значением токена', () => {
    try {
      parseTokens(`bot:${BOT},panel:${BOT}`);
      throw new Error('expected parseTokens to throw');
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').not.toContain(BOT);
    }
  });
});

describe('authenticate', () => {
  const tokens = parseTokens(`bot:${BOT},panel:${PANEL}`);

  it('нет заголовка — missing', () => {
    expect(authenticate(undefined, tokens)).toEqual({ ok: false, reason: 'missing' });
    expect(authenticate('   ', tokens)).toEqual({ ok: false, reason: 'missing' });
  });

  it('не Bearer — malformed', () => {
    expect(authenticate('Basic abcdef', tokens)).toEqual({ ok: false, reason: 'malformed' });
    expect(authenticate('Bearer', tokens)).toEqual({ ok: false, reason: 'malformed' });
    expect(authenticate('Bearer a b', tokens)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('чужой токен — unknown', () => {
    expect(authenticate(`Bearer ${BOT}x`, tokens)).toEqual({ ok: false, reason: 'unknown' });
    // Префикс своего токена — тоже чужой: сравнение по дайджестам, а не по началу строки.
    expect(authenticate(`Bearer ${BOT.slice(0, -1)}`, tokens)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(authenticate('Bearer ', tokens)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('свой токен — ok с меткой клиента', () => {
    expect(authenticate(`Bearer ${BOT}`, tokens)).toEqual({ ok: true, label: 'bot' });
    expect(authenticate(`bearer ${PANEL}`, tokens)).toEqual({ ok: true, label: 'panel' });
  });

  it('пустой список токенов никого не пускает', () => {
    // parseTokens такого списка не отдаст, но authenticate — чистая функция, и её
    // контракт не должен зависеть от того, кто её позвал.
    expect(authenticate(`Bearer ${BOT}`, [])).toEqual({ ok: false, reason: 'unknown' });
  });
});
