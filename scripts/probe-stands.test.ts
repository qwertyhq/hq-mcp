import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_HOSTS_VAR,
  assertNotProduction,
  assertRedactedIsSafe,
  isEntryPoint,
  parseForbiddenHosts,
  redactForFixture,
} from './probe-stands.js';

// Не входит в vitest.config.ts include (packages/**, tools/**, apps/**), поэтому
// pnpm test/CI его не подхватывают — ровно как требует бриф ("в CI не ходит и
// в pnpm test не участвует"). Запуск вручную, committed-команда:
//   pnpm test:guards
// (см. vitest.guards.config.ts в корне репозитория). Ничего здесь не бьёт по
// сети и не пишет на диск — проверяются только чистые функции-гейты,
// вынесенные из харнесса специально для этого.

// Адреса рабочего развёртывания в исходнике больше не живут (репозиторий
// публичный) — они приходят из HQ_STAND_FORBIDDEN_HOSTS. Здесь это обычные
// example.com-имена: тест проверяет ПОВЕДЕНИЕ гейта, а не конкретный список.
const FORBIDDEN = 'admin.billing.example.com, bill.example.com,panel.example.com';
const STAND_SHM = 'http://127.0.0.1:8080/shm/v1';
const STAND_REMNA = 'https://192.0.2.10';

describe('parseForbiddenHosts', () => {
  it('splits, trims and lowercases the list', () => {
    expect(parseForbiddenHosts(' A.example.com , b.Example.COM ')).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('yields nothing for anything that carries no host', () => {
    // Все эти формы обязаны оказаться неотличимы от «не задано»: значение,
    // состоящее из запятых и пробелов, выглядит настроенным, но не запрещает
    // ни одного хоста.
    expect(parseForbiddenHosts(undefined)).toEqual([]);
    expect(parseForbiddenHosts('')).toEqual([]);
    expect(parseForbiddenHosts('   ')).toEqual([]);
    expect(parseForbiddenHosts(' , ,, ')).toEqual([]);
  });
});

describe('assertNotProduction', () => {
  it('refuses when the SHM URL is a production host', () => {
    expect(() =>
      assertNotProduction('https://admin.billing.example.com/shm/v1', STAND_REMNA, FORBIDDEN),
    ).toThrow(/production/);
  });

  it('refuses when the Remnawave URL is a production host', () => {
    expect(() => assertNotProduction(STAND_SHM, 'https://panel.example.com', FORBIDDEN)).toThrow(
      /production/,
    );
    expect(() => assertNotProduction(STAND_SHM, 'https://bill.example.com', FORBIDDEN)).toThrow(
      /production/,
    );
  });

  it('allows the stands named in §9', () => {
    expect(() => assertNotProduction(STAND_SHM, STAND_REMNA, FORBIDDEN)).not.toThrow();
  });

  it('refuses a production host regardless of case', () => {
    // Hostnames are case-insensitive by RFC; the guard has to be too.
    expect(() =>
      assertNotProduction('https://ADMIN.BILLING.EXAMPLE.COM/shm/v1', STAND_REMNA, FORBIDDEN),
    ).toThrow(/production/);
    expect(() => assertNotProduction(STAND_SHM, 'https://Panel.Example.COM', FORBIDDEN)).toThrow(
      /production/,
    );
  });

  it('refuses a subdomain of a forbidden host', () => {
    // Список задаёт оператор руками, и перечислить каждое имя под доменом он
    // забудет раньше, чем ошибётся хостом. Гейт отказывающий — покрыть ветку
    // дерева целиком безопаснее, чем требовать полного перечисления.
    expect(() =>
      assertNotProduction(STAND_SHM, 'https://backup.panel.example.com', FORBIDDEN),
    ).toThrow(/production/);
  });

  it('refuses a forbidden host even when the URL does not parse', () => {
    // `new URL()` бросает на строке без схемы. Неразобранный URL обязан
    // упереться в отказ, а не проскочить мимо гейта.
    expect(() => assertNotProduction('admin.billing.example.com/shm/v1', STAND_REMNA, FORBIDDEN)).toThrow(
      /production/,
    );
  });

  describe('when the list is not configured', () => {
    // Главное свойство этого гейта. Отсутствие настройки обязано быть ГРОМКИМ
    // отказом: гейт, который при пустом списке пропускает всё, хуже
    // отсутствующего — оператор продолжает считать, что предохранитель на
    // месте, и ошибается ровно тогда, когда он нужен. Сообщение называет
    // переменную, чтобы отказ чинился, а не обходился.
    for (const [label, raw] of [
      ['unset', undefined],
      ['empty', ''],
      ['whitespace only', '   '],
      ['separators only', ' , ,, '],
    ] as const) {
      it(`refuses even a harmless stand URL when the list is ${label}`, () => {
        expect(() => assertNotProduction(STAND_SHM, STAND_REMNA, raw)).toThrow(
          new RegExp(FORBIDDEN_HOSTS_VAR),
        );
      });
    }

    it('names the variable rather than blaming the URLs', () => {
      // Отказ по ненастроенности и отказ по совпадению — разные починки. Если
      // ненастроенный список жалуется на «production hosts», оператор пойдёт
      // менять URL стенда и не найдёт причины.
      expect(() => assertNotProduction(STAND_SHM, STAND_REMNA, undefined)).toThrow(/is not set/);
    });
  });
});

describe('isEntryPoint', () => {
  const script = resolve(import.meta.dirname, 'probe-stands.ts');
  const moduleUrl = pathToFileURL(script).href;

  it('recognises a direct launch', () => {
    expect(isEntryPoint(moduleUrl, script)).toBe(true);
  });

  it('recognises a launch through a symlink to the script', () => {
    // Тот же дефект, что commit 71ce1c1 чинил в apps/stdio: node кладёт в
    // import.meta.url путь с РАЗРЕШЁННЫМИ симлинками, а в argv[1] — тот,
    // которым позвали. Через симлинк строки не совпадают, main() не зовётся, и
    // харнесс молча выходит с кодом 0, не сняв ни одной фикстуры и не сказав
    // ни слова.
    const link = join(mkdtempSync(join(tmpdir(), 'hq-mcp-probe-')), 'probe-stands.ts');
    symlinkSync(script, link);
    expect(isEntryPoint(moduleUrl, link)).toBe(true);
  });

  it('stays false when the module is merely imported by a test', () => {
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
    expect(isEntryPoint(moduleUrl, resolve(import.meta.dirname, 'probe-stands.test.ts'))).toBe(false);
  });
});

// Shape modeled on packages/redact/src/index.test.ts's own `remnaUser` fixture:
// a real Remnawave user response carries trojanPassword/ssPassword/vlessUuid
// directly, plus a benign `uuid` identifier that must NOT be treated as a leak.
const REMNA_USER = {
  uuid: '2f0c4a1e-0000-4000-8000-000000000001',
  username: 'tg900001',
  status: 'ACTIVE',
  telegramId: 900001,
  trojanPassword: 'trojan-plaintext',
  ssPassword: 'ss-plaintext',
  vlessUuid: '9d8b7a6c-0000-4000-8000-000000000002',
};

describe('redactForFixture (full pipeline: real redact() + the leak guard)', () => {
  it('passes a real-shaped Remnawave user once redact() has masked its credential fields', () => {
    // This is the case that was broken before the fix: redact() replaces the
    // VALUE but keeps the KEY, so a bare substring check for "trojanPassword"
    // always found the key name and always aborted the write, even for a
    // correctly-redacted payload. The fix checks whether each credential-named
    // key's VALUE is the redaction sentinel, not whether the key's NAME appears
    // anywhere in the serialized text.
    const serialized = redactForFixture(REMNA_USER, 'users');
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.trojanPassword).toBe('<redacted>');
    expect(parsed.ssPassword).toBe('<redacted>');
    expect(parsed.vlessUuid).toBe('<redacted>');
    expect(parsed.uuid).toBe(REMNA_USER.uuid); // a benign identifier must survive untouched
  });

  it('captures with the profile that masks PII, not the one that masks least', () => {
    // Фикстура «уедет в git навсегда» (докстрока самого харнесса), а репозиторий
    // вот-вот станет публичным. email/login2/full_name/phone/ip/userAgent
    // маскируются ТОЛЬКО профилю 'bot' (packages/redact/src/index.ts), и
    // findLeak их не ловит вовсе — он смотрит на креды, а не на персональные
    // данные. Снимок профилем 'human' складывал их в файл как есть; PII уже
    // дважды просачивалась в закоммиченные фикстуры на этой ветке.
    const serialized = redactForFixture(
      {
        body: {
          data: [
            {
              user_id: 3073,
              login2: 'client@example.test',
              full_name: 'Real Person',
              phone: '+70000000000',
              ip: '203.0.113.7',
              userAgent: 'Happ/1.0',
            },
          ],
        },
      },
      'admin-user',
    );
    expect(serialized).not.toContain('client@example.test');
    expect(serialized).not.toContain('Real Person');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('+70000000000');
    expect(serialized).not.toContain('Happ/1.0');
    const row = (JSON.parse(serialized) as { body: { data: Record<string, unknown>[] } }).body
      .data[0];
    expect(row?.user_id).toBe(3073);
    expect(row?.login2).toBe('<redacted>');
  });

  it('fails on a raw vless:// URL sitting under an unrelated, benign key name', () => {
    // redact() has no key-based rule for "notes", so a scheme link embedded there
    // survives redact() verbatim. The content-pattern check exists precisely to
    // catch this: a leak redact() itself has no rule for.
    expect(() =>
      redactForFixture({ notes: 'raw dump: vless://9d8b7a6c-0000@host:443?type=tcp' }, 'leaky'),
    ).toThrow(/leaky/);
  });

  it('drops the subscription link entirely rather than tail-masking it', () => {
    // Следствие захвата профилем 'bot': ссылка подписки ему не уезжает вовсе,
    // тогда как 'human' оставлял домен и звёздочки. Для файла, который уедет в
    // git публичного репозитория, второе — лишний след, а не удобство.
    const serialized = redactForFixture(
      { subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP' },
      'users',
    );
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.subscriptionUrl).toBe('<redacted>');
  });

  it('serializes a clean captured record with no credential-shaped fields at all', () => {
    const serialized = redactForFixture(
      { status: 200, path: '/admin/user', body: { data: [{ user_id: 3073 }] } },
      'admin-user',
    );
    expect(JSON.parse(serialized)).toEqual({
      status: 200,
      path: '/admin/user',
      body: { data: [{ user_id: 3073 }] },
    });
  });
});

describe('assertRedactedIsSafe (the guard itself, independent of redact())', () => {
  it('accepts an already-correctly-redacted payload', () => {
    expect(() =>
      assertRedactedIsSafe(
        {
          trojanPassword: '<redacted>',
          ssPassword: '<redacted>',
          vlessUuid: '<redacted>',
          uuid: REMNA_USER.uuid,
        },
        'users',
      ),
    ).not.toThrow();
  });

  it('catches a credential-named key that redact() failed to mask', () => {
    // Hand-built "already redacted" payload where trojanPassword was left raw —
    // simulating a future regression inside @hq/redact itself, not a mistake made
    // by this harness. The real redact() always masks a recognized key, so this
    // scenario can only be exercised by calling the guard directly rather than
    // going through redactForFixture. This is exactly what the old bare-substring
    // check could not tell apart from a correctly-masked value: both contain the
    // literal key name "trojanPassword".
    expect(() =>
      assertRedactedIsSafe(
        {
          trojanPassword: 'still-the-plaintext-secret',
          ssPassword: '<redacted>',
          vlessUuid: '<redacted>',
        },
        'users',
      ),
    ).toThrow(/users/);
  });

  describe('array elements', () => {
    // Remnawave returns `links`/`ssConfLinks` as arrays of working vless://
    // URLs. Those two are masked by key name (they're in CREDENTIAL_KEYS), but
    // any array of strings under a key NOT on that list is a plausible real
    // shape too, and the walk has to reach a string sitting there just as
    // readily as one sitting directly on an object property.
    it('fails on a raw vless:// URL sitting as a top-level array element', () => {
      expect(() => assertRedactedIsSafe({ items: ['x', 'vless://uuid@host:443'] }, 'leaky')).toThrow(
        /leaky/,
      );
    });

    it('fails on a raw ss:// URL nested two arrays deep', () => {
      expect(() => assertRedactedIsSafe({ a: { b: [['ss://uuid@host:8388']] } }, 'leaky')).toThrow(
        /leaky/,
      );
    });

    it('passes a payload with only benign strings inside arrays', () => {
      expect(() =>
        assertRedactedIsSafe({ tags: ['prod', 'de'], nested: { list: [['a', 'b'], ['c']] } }, 'clean'),
      ).not.toThrow();
    });
  });
});
