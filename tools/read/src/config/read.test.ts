import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ALLOWED_CONFIG_NAMES, configRead } from './read.js';

interface ConfigOut {
  name: string;
  found: boolean;
  value: unknown;
  warnings: Array<{ code: string; message: string }>;
}

describe('config_read', () => {
  it('refuses any key outside the allowlist and explains why', async () => {
    const ctx = makeCtx({ shmGet: () => [] });
    await expect(configRead.handler({ name: 'pay_systems' }, ctx)).rejects.toThrow(/allowlist/);
    await expect(configRead.handler({ name: 'pay_systems' }, ctx)).rejects.toThrow(/telegram/);
  });

  it('refuses the key names Perl reads as false, which dump the whole config', async () => {
    // Core::Config::data_by_name — `my $key = shift || return all_data_by_name()`
    // (app/lib/Core/Config.pm:92): '0' и '' означают «ключ не задан», и ручка
    // отдаёт ВЕСЬ конфиг. Правило запрета на /admin/config — match:'exact',
    // поэтому путь /admin/config/0 оно не ловит.
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmGet: () => [] });
    await expect(configRead.handler({ name: '0' }, ctx)).rejects.toThrow(/entire config/i);
    expect(calls).toEqual([]);
  });

  it('reads exactly one key of the real config table', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmGet: () => [{ url: 'https://portal.example.com' }] });
    const result = (await configRead.handler({ name: 'cli' }, ctx)) as ConfigOut;
    expect(calls.map((c) => c.path)).toEqual(['/admin/config/cli']);
    // api_data_by_name отдаёт САМО значение (Core/Config.pm:127 —
    // `sub get_data { shift->get->{value} || {} }`), а v1.cgi заворачивает его
    // в {data:[<value>]}. Полей name/key/value в строке нет.
    expect(result.value).toEqual({ url: 'https://portal.example.com' });
    expect(result.found).toBe(true);
  });

  it('masks secret-looking fields of an allowed key and names them', async () => {
    const ctx = makeCtx({
      shmGet: () => [{ token: '123:AAAsecret', username: 'hq_bot', webhook_secret: 'shh' }],
    });
    const result = (await configRead.handler({ name: 'telegram' }, ctx)) as ConfigOut;
    const value = result.value as Record<string, unknown>;
    expect(value.token).toBe('<redacted>');
    expect(value.webhook_secret).toBe('<redacted>');
    expect(value.username).toBe('hq_bot');
    const masked = result.warnings.find((w) => w.code === 'masked');
    expect(masked).toBeDefined();
    expect(masked?.message).toContain('token');
    expect(masked?.message).toContain('webhook_secret');
  });

  it('does not claim it masked anything when nothing matched', async () => {
    // Иначе ответ по ключу cli/company/_shm говорит «поля заменены на
    // <redacted>», и модель делает вывод, что значение неполное.
    const ctx = makeCtx({ shmGet: () => [{ name: 'HQ VPN' }] });
    const result = (await configRead.handler({ name: 'company' }, ctx)) as ConfigOut;
    expect(result.warnings.map((w) => w.code)).not.toContain('masked');
  });

  it('treats an empty object as "not found" and says the answer is ambiguous', async () => {
    const ctx = makeCtx({ shmGet: () => [{}] });
    const result = (await configRead.handler({ name: 'project' }, ctx)) as ConfigOut;
    expect(result.found).toBe(false);
    expect(result.value).toBeNull();
    // get_data возвращает `{}` и для отсутствующего ключа, и для ключа с
    // пустым значением — различить их этой ручкой невозможно.
    expect(result.warnings.map((w) => w.code)).toContain('empty_or_absent');
  });

  it('refuses the bot profile in the handler, not only in the listing', async () => {
    const ctx = makeCtx({ profile: 'bot', shmGet: () => [{ url: 'https://portal.example.com' }] });
    await expect(configRead.handler({ name: 'cli' }, ctx)).rejects.toThrow(/human/);
  });

  it('publishes an allowlist of keys that actually exist in the config table', () => {
    // Ключ таблицы config — `key` (shm_structure.sql:329-333), и это 'cli',
    // а не 'cli.url': точечные пути — это ПОЛЯ внутри значения.
    expect(ALLOWED_CONFIG_NAMES).toContain('cli');
    expect(ALLOWED_CONFIG_NAMES).toContain('telegram');
    expect(ALLOWED_CONFIG_NAMES).not.toContain('cli.url');
    expect(ALLOWED_CONFIG_NAMES).not.toContain('api_secret_key');
    // pay_systems маскирует `secret`, но НЕ `account`, `shop_id`, `merchant_id`.
    expect(ALLOWED_CONFIG_NAMES).not.toContain('pay_systems');
    expect(configRead.profiles).toEqual(['human']);
  });
});
