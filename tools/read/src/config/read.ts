import { defineTool } from '@hq/registry';
import { REDACTED, redact } from '@hq/redact';
import { z } from 'zod';
import type { ToolWarning } from '@hq/types';
import { asArray, asRecord, assertHumanOnly, warn } from '../kit.js';

/**
 * Читаемые ключи. Это КЛЮЧИ таблицы `config`, а не пути внутри значения:
 * первичный ключ там — колонка `key` (app/sql/shm/shm_structure.sql:329-333),
 * и реально существующие ключи это `_shm`, `acme`, `api`, `app_settings`,
 * `billing`, `cli`, `company`, `mail`, `pay_systems`, `server`, `telegram`,
 * `translation_overrides` (сверено с работающей установкой и с
 * app/sql/shm/shm_data.sql:27-36).
 * `cli.url` ключом НЕ является: это ключ `cli`, поле `url`
 * (app/public_html/shm/user/auth.cgi:33) — запрос по «cli.url» возвращает
 * пустой объект всегда, а не значение.
 *
 * Дампа /admin/config целиком нет и не будет: он отдаёт telegram.token и
 * ключи всех платёжных систем без маскирования (§8, FORBIDDEN_RULES).
 * Расширять список — осознанно и по одному.
 *
 * `pay_systems` исключён НАМЕРЕННО, и это не осторожность вообще, а разбор
 * конкретного значения: `secret`, `api_key`, `secret_word_1` маскируются по
 * имени поля, а `account` (номер кошелька ЮMoney), `shop_id` и `merchant_id`
 * — нет, потому что в SECRET_KEY_RE их нет и быть не должно.
 *
 * `project` и `passkey` в наблюдавшейся таблице отсутствовали, но код их
 * читает (Core/User/Passkey.pm:147, Core/User/OTP.pm:126 —
 * `data_by_name('project')`), то есть на другой инсталляции они законны; там,
 * где их нет, ответ по ним — «пусто».
 */
export const ALLOWED_CONFIG_NAMES: readonly string[] = [
  'cli',
  'api',
  'company',
  'billing',
  'mail',
  'project',
  'passkey',
  'telegram',
  '_shm',
];

/**
 * Ключи, которые Perl считает ложью. `Core::Config::data_by_name` начинается с
 * `my $key = shift || return $self->all_data_by_name()`
 * (app/lib/Core/Config.pm:92), поэтому `GET /admin/config/0` — это не «ключ 0»,
 * а ВЕСЬ конфиг разом, включая секреты платёжных систем. Запрет §8 на
 * /admin/config объявлен как `match: 'exact'` (packages/registry/src/forbidden.ts:78),
 * и такой путь под него не попадает: единственная защита — эта проверка.
 * Отдельно от allowlist и ДО него, чтобы причина осталась написанной, даже
 * если однажды allowlist подменят на «любой ключ».
 */
const PERL_FALSY_NAMES: readonly string[] = ['', '0'];

/**
 * Имена полей, которые редакция заменила на `<redacted>` — включая ту, что
 * уже сделал HTTP-клиент. Диффом «до/после» их не найти: `ShmClient.get`
 * редактирует ответ сам (packages/shm/src/client.ts:197), поэтому в рабочем
 * тракте повторный `redact` не меняет ничего, и предупреждение о маскировании,
 * построенное на сравнении, не появилось бы никогда.
 */
function maskedFields(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => maskedFields(item, `${prefix}[${String(index)}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (item === REDACTED) out.push(path);
    else out.push(...maskedFields(item, path));
  }
  return out;
}

export const configRead = defineTool({
  name: 'config_read',
  description:
    'Read one SHM configuration key from a fixed allowlist, with secret-looking fields masked. ' +
    'The argument is a KEY of the config table (cli, api, telegram, …), not a dotted path: ' +
    '"cli.url" is key "cli", field "url", and asking for the dotted form always answers empty. ' +
    'Reading the configuration wholesale is not available at all, and pay_systems is not on the ' +
    'allowlist: its secret fields are masked but the wallet account, shop_id and merchant_id ' +
    'are not.',
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(`Configuration key. Allowed: ${ALLOWED_CONFIG_NAMES.join(', ')}`),
  }),
  access: 'ro',
  risk: 'medium',
  profiles: ['human'],
  backends: ['shm'],
  handler: async ({ name }, ctx) => {
    // Защита второго слоя, не гейт: до хендлера бот не доходит вовсе —
    // исполнитель выбирает инструмент из listVisibleTools. Почему она всё же
    // стоит и почему у всех пяти человеческих инструментов — в assertHumanOnly.
    assertHumanOnly(
      ctx,
      'config_read is available to the human profile only: platform configuration carries ' +
        'bot tokens and payment-system credentials, and masking by field name is a filter, ' +
        'not a boundary.',
    );
    if (PERL_FALSY_NAMES.includes(name)) {
      throw new Error(
        `Configuration key "${name}" is refused before the allowlist is even consulted. Perl ` +
          'reads it as false, and Core::Config::data_by_name falls through to ' +
          'all_data_by_name() on a false key (app/lib/Core/Config.pm:92), so ' +
          `GET /admin/config/${name} returns the ENTIRE config — the telegram bot token and ` +
          'every payment-system secret. The forbidden-operation rule for /admin/config is an ' +
          'exact-match rule and does not cover that path.',
      );
    }
    if (!ALLOWED_CONFIG_NAMES.includes(name)) {
      throw new Error(
        `Configuration key "${name}" is not in the MCP allowlist. Allowed keys: ` +
          `${ALLOWED_CONFIG_NAMES.join(', ')}. These are keys of the config table, not dotted ` +
          'paths — "cli.url" is key "cli", field "url". Reading /admin/config as a whole is not ' +
          'offered: it dumps the telegram bot token and every payment-system secret in clear ' +
          'text. pay_systems is excluded for the same reason at key level: its wallet account, ' +
          'shop_id and merchant_id are not masked by field name.',
      );
    }

    const body = await ctx.shm.get<unknown>(`/admin/config/${encodeURIComponent(name)}`);
    // `api_data_by_name` возвращает САМО значение ключа
    // (`sub get_data { shift->get->{value} || {} }`, app/lib/Core/Config.pm:127),
    // а v1.cgi:1753-1760 заворачивает его в `{data:[<value>], items, limit,
    // offset}`. Полей `name`/`key`/`value` в строке нет — строка И ЕСТЬ
    // значение, поэтому никакого `row.value` здесь быть не должно: у ключа
    // `billing` есть собственное поле `currency`, а был бы там `value` —
    // ответ молча ужался бы до него.
    const row = asRecord(asArray(body)[0]);

    if (Object.keys(row).length === 0) {
      return {
        name,
        found: false,
        value: null,
        warnings: [
          warn(
            'empty_or_absent',
            `"${name}" came back as an empty object. This route cannot tell "no such key" from ` +
              '"key exists with an empty value": get_data returns {} for both ' +
              '(app/lib/Core/Config.pm:97,127). Do not conclude the key is missing — check the ' +
              'admin panel if the difference matters.',
          ),
        ] as ToolWarning[],
      };
    }

    const value = redact(row, ctx.profile);
    const masked = maskedFields(value);

    return {
      name,
      found: true,
      value,
      warnings:
        masked.length === 0
          ? ([] as ToolWarning[])
          : ([
              warn(
                'masked',
                `Masked before returning: ${masked.join(', ')}. Masking is by FIELD NAME — ` +
                  'anything matching /token|secret|key|password|auth/i becomes <redacted>. ' +
                  'Everything else in this answer is the real value. Ask a human to read the ' +
                  'raw value in the admin panel if it is really needed.',
              ),
            ] as ToolWarning[]),
    };
  },
});
