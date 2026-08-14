import { describe, expect, it } from 'vitest';
import { CREDENTIAL_KEYS, maskTail, redact, redactField } from './index.js';

const remnaUser = {
  uuid: '2f0c4a1e-0000-4000-8000-000000000001',
  username: 'tg900001',
  status: 'ACTIVE',
  telegramId: 900001,
  email: 'client@example.com',
  trojanPassword: 'trojan-plaintext',
  ssPassword: 'ss-plaintext',
  vlessUuid: '9d8b7a6c-0000-4000-8000-000000000002',
  subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP',
  shortUuid: 'aBcDeFgHiJkLmNoP',
  happ: { cryptoLink: 'happ://crypto/QQQ' },
  userTraffic: { usedTrafficBytes: 123, onlineAt: '2026-08-08T10:00:00.000Z' },
};

describe('maskTail', () => {
  it('keeps the head and hides the tail', () => {
    expect(maskTail('https://sub.example.com/aBcDeFgHiJkLmNoP', 24)).toBe(
      'https://sub.example.com/********',
    );
  });

  it('hides everything when the value is shorter than the kept head', () => {
    expect(maskTail('abc', 6)).toBe('***');
  });
});

describe('redact', () => {
  it('kills connection credentials for the human profile but keeps identifiers', () => {
    const safe = redact(remnaUser, 'human');
    expect(safe.trojanPassword).toBe('<redacted>');
    expect(safe.ssPassword).toBe('<redacted>');
    expect(safe.vlessUuid).toBe('<redacted>');
    expect(safe.happ.cryptoLink).toBe('<redacted>');
    expect(safe.uuid).toBe(remnaUser.uuid);
    expect(safe.username).toBe('tg900001');
    expect(safe.telegramId).toBe(900001);
    expect(safe.userTraffic.usedTrafficBytes).toBe(123);
  });

  it('masks the subscription tail for human and removes it for bot', () => {
    expect(redact(remnaUser, 'human').subscriptionUrl).toBe(
      'https://sub.example.com/********',
    );
    expect(redact(remnaUser, 'bot').subscriptionUrl).toBe('<redacted>');
    expect(redact(remnaUser, 'bot').shortUuid).toBe('<redacted>');
  });

  it('removes PII for the bot profile only', () => {
    expect(redact(remnaUser, 'human').email).toBe('client@example.com');
    expect(redact(remnaUser, 'bot').email).toBe('<redacted>');
    const row = { login2: 'a@b.c', phone: '+79990000000', full_name: 'Ivan', ip: '1.2.3.4' };
    expect(redact(row, 'bot')).toEqual({
      login2: '<redacted>',
      phone: '<redacted>',
      full_name: '<redacted>',
      ip: '<redacted>',
    });
    expect(redact(row, 'human')).toEqual(row);
  });

  it('masks platform secrets by key name in both profiles', () => {
    const config = {
      name: 'telegram_bot',
      value: { token: '123:AAA', webhook_secret: 'xxx', publicKey: 'pk', apiKeyId: 7 },
      rawInbound: { realityPrivateKey: 'priv' },
    };
    const safe = redact(config, 'human');
    expect(safe.value.token).toBe('<redacted>');
    expect(safe.value.webhook_secret).toBe('<redacted>');
    expect(safe.value.publicKey).toBe('<redacted>');
    expect(safe.value.apiKeyId).toBe('<redacted>');
    expect(safe.rawInbound).toBe('<redacted>');
    expect(safe.name).toBe('telegram_bot');
  });

  it('walks arrays, keeps primitives and survives cycles', () => {
    const list = [{ trojanPassword: 'a' }, { trojanPassword: 'b' }];
    expect(redact(list, 'human')).toEqual([
      { trojanPassword: '<redacted>' },
      { trojanPassword: '<redacted>' },
    ]);
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    expect(redact(cyclic, 'human')).toEqual({ id: 1, self: '<circular>' });
    expect(redact('plain', 'bot')).toBe('plain');
    expect(redact(42, 'bot')).toBe(42);
    expect(redact(null, 'bot')).toBeNull();
  });

  it('does not mistake a shared sub-object for a cycle', () => {
    // Ответ инструмента собирается в JS, а не приходит из JSON.parse, поэтому
    // одна и та же ссылка вполне может лежать в двух местах. Пометить второе
    // вхождение как '<circular>' — значит молча потерять кусок ответа.
    const shared = { hwid: 'h1', trojanPassword: 'plain' };
    const dag = { primary: shared, mirror: shared, list: [shared] };
    expect(redact(dag, 'human')).toEqual({
      primary: { hwid: 'h1', trojanPassword: '<redacted>' },
      mirror: { hwid: 'h1', trojanPassword: '<redacted>' },
      list: [{ hwid: 'h1', trojanPassword: '<redacted>' }],
    });
  });

  it('exports the credential key list used by the transport layer', () => {
    expect(CREDENTIAL_KEYS).toContain('trojanPassword');
    expect(CREDENTIAL_KEYS).toContain('ssConfLinks');
  });
});

describe('redact — key normalization (case and separator insensitivity)', () => {
  it('treats subscriptionURL, subscription_url and SubscriptionUrl the same as subscriptionUrl', () => {
    const variants = ['subscriptionURL', 'subscription_url', 'SubscriptionUrl'] as const;
    for (const key of variants) {
      const payload: Record<string, unknown> = {
        [key]: 'https://sub.example.com/aBcDeFgHiJkLmNoP',
      };
      expect(redact(payload, 'human')[key]).toBe('https://sub.example.com/********');
      expect(redact(payload, 'bot')[key]).toBe('<redacted>');
    }
  });

  it('treats Email, EMAIL and e_mail the same as email', () => {
    const variants = ['Email', 'EMAIL', 'e_mail'] as const;
    for (const key of variants) {
      const payload: Record<string, unknown> = { [key]: 'client@example.com' };
      expect(redact(payload, 'human')[key]).toBe('client@example.com');
      expect(redact(payload, 'bot')[key]).toBe('<redacted>');
    }
  });

  it('masks trojan_password and TrojanPassword like trojanPassword', () => {
    // Эти два конкретных варианта уже попадали под SECRET_KEY_RE (подстрока
    // "password"), поэтому одни они дыру в CREDENTIAL_KEYS не показывают —
    // ниже добавлен vlessUuid-вариант, у которого такого пересечения нет.
    const variants = ['trojan_password', 'TrojanPassword'] as const;
    for (const key of variants) {
      const payload: Record<string, unknown> = { [key]: 'plain' };
      expect(redact(payload, 'human')[key]).toBe('<redacted>');
      expect(redact(payload, 'bot')[key]).toBe('<redacted>');
    }
  });

  it('masks vless_uuid and VlessUuid like vlessUuid (no SECRET_KEY_RE overlap — the real CREDENTIAL_KEYS gap)', () => {
    const variants = ['vless_uuid', 'VlessUuid'] as const;
    for (const key of variants) {
      const payload: Record<string, unknown> = { [key]: 'plain-uuid' };
      expect(redact(payload, 'human')[key]).toBe('<redacted>');
      expect(redact(payload, 'bot')[key]).toBe('<redacted>');
    }
  });

  it('leaves a benign field whose normalized form is not in any list untouched', () => {
    const payload = { emailVerifiedAt: '2026-08-08T10:00:00.000Z' };
    expect(redact(payload, 'human')).toEqual(payload);
    expect(redact(payload, 'bot')).toEqual(payload);
  });
});

/**
 * ВТОРАЯ ПОЛОВИНА МЕХАНИЗМА: ФОРМА ЗНАЧЕНИЯ.
 *
 * Всё, что выше, — маскирование по ИМЕНИ поля. Оно по построению слепо к
 * секрету, лежащему ВНУТРИ значения, и 2026-08-13 это стоило трёх живых
 * утечек одного класса: токен бота в `response.request.url` строки спула, он
 * же в колонке `host` пяти серверов SHM, креденшлы голыми подстроками в телах
 * шаблонов. Каждую чинили отдельно, у своего инструмента, — то есть класс
 * оставался открытым для всех остальных.
 *
 * Проход по форме встроен ЗДЕСЬ, а не у инструментов: `redact` зовут и оба
 * клиента, и исполнитель, поэтому одна правка закрывает все три точки сразу.
 */
describe('redact — a secret inside a value, where the field name promises nothing', () => {
  const telegramToken = (): string =>
    ['1088', '9977', '01:'].join('') + ['AAF', 'q7x2Kd0Lm9', 'Zt4Rv1Ns6Wb', '3Yc8Hj5Pg2Q'].join('');

  it('cuts the bot token out of a spool row, where it hid in response.request.url', () => {
    const row = {
      id: 88,
      status: 'FINISHED',
      response: {
        request: { url: `https://api.telegram.org/bot${telegramToken()}/sendMessage` },
      },
    };
    for (const profile of ['human', 'bot'] as const) {
      const safe = redact(row, profile);
      expect(JSON.stringify(safe)).not.toContain(telegramToken());
      expect(safe.response.request.url).toContain('api.telegram.org');
      expect(safe.status).toBe('FINISHED');
    }
  });

  it('cuts the bot token out of the host column of an SHM server row', () => {
    // Часть строк /admin/server выглядит ровно так, и
    // `host` — самое обычное имя поля: ни одно правило по именам его не видит.
    const rows = [
      { server_id: 4, name: 'telegram-http', host: `https://api.telegram.org/bot${telegramToken()}/sendMessage` },
    ];
    const safe = redact(rows, 'human');
    expect(JSON.stringify(safe)).not.toContain(telegramToken());
    expect(safe[0]?.name).toBe('telegram-http');
  });

  it('cuts a credential out of a template body, which is one long string', () => {
    const jwt =
      ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join('') +
      '.' +
      ['eyJ', 'zdWIiOiJyZW1uYSIsIm5hbWUiOiJIUSJ9'].join('') +
      '.' +
      'Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB';
    const safe = redact({ id: 'hwid_blocker', data: `{{ REMNA_TOKEN = "${jwt}" }}` }, 'human');
    expect(safe.data).not.toContain(jwt);
    // Имя переменной остаётся — иначе вырезали бы логику вместо секрета.
    expect(safe.data).toContain('REMNA_TOKEN');
  });

  it('reaches into array elements and nested objects, not only the top level', () => {
    const safe = redact({ rows: [{ note: `see ${telegramToken()}` }] }, 'bot');
    expect(JSON.stringify(safe)).not.toContain(telegramToken());
  });

  it('is idempotent — the second pass has nothing left to cut', () => {
    const once = redact({ host: `https://api.telegram.org/bot${telegramToken()}/sendMessage` }, 'human');
    expect(redact(once, 'human')).toEqual(once);
  });
});

/**
 * ОБРАТНОЕ НАПРАВЛЕНИЕ, И ОНО НЕ МЕНЕЕ ВАЖНО.
 *
 * Ложное срабатывание здесь молча гасит поле, ради которого инструмент и
 * писали, — этот проект выкатывал такую потерю дважды (`uniq_key` у платежей,
 * `showConnectionKeys` в конфиге страницы подписки), и во второй раз её нашёл
 * только живой прогон. Поэтому у обоих правил есть закрытый список того, что
 * они обязаны пропустить, и он проверяется наравне с самой маскировкой.
 */
describe('redact — fields that only look secret', () => {
  it('keeps the four fields whose names carry the word key but no key material', () => {
    // Все четыре — настоящие: списки ИМЁН ключей и булев переключатель. Каждое
    // уезжало маркером, и каждое пришлось переименовывать у своего инструмента.
    const payload = {
      changedKeys: ['limit', 'expire'],
      svgLibraryKeys: ['Happ', 'Streisand'],
      translationKeys: 12,
      showConnectionKeys: false,
    };
    for (const profile of ['human', 'bot'] as const) {
      expect(redact(payload, profile)).toEqual(payload);
    }
  });

  it('still masks a field that carries key material, however it is spelled', () => {
    // Без этой половины список выше становится дырой: `connectionKeys` тоже
    // кончается на Keys, и он — креды подключения.
    const payload = { connectionKeys: ['vless://x'], apiKey: 'abc', realityPrivateKey: 'priv' };
    expect(redact(payload, 'human')).toEqual({
      connectionKeys: '<redacted>',
      apiKey: '<redacted>',
      realityPrivateKey: '<redacted>',
    });
  });

  it('keeps opaque identifiers the value-shape pass must not mistake for secrets', () => {
    // `uniq_id` — идентификатор платежа у провайдера, ровно то поле, ради
    // которого читают билинговую строку, и он бывает 32-символьным hex.
    // `svgLibrary` несёт data-URI. Оба перешагивают порог непрозрачного
    // прогона, поэтому сквозной проход этот прогон и не включает.
    const payload = {
      uniq_id: '9f8e7d6c5b4a392817065f4e3d2c1b0a',
      uuid: '2f0c4a1e-0000-4000-8000-000000000001',
      shortIds: ['a1b2c3d4e5f60789'],
      svgLibrary: {
        Happ: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4',
      },
      сообщение: 'Оплата прошла, услуга продлена до 2026-09-13',
    };
    for (const profile of ['human', 'bot'] as const) {
      expect(redact(payload, profile)).toEqual(payload);
    }
  });
});

describe('redact — prototype pollution guard', () => {
  it('does not let a literal "__proto__" key hijack the prototype of the result', () => {
    // JSON.parse creates an OWN enumerable "__proto__" property (unlike an
    // object literal, where `{ __proto__: x }` sets the real prototype at
    // construction time) — this is the actual attack vector for payloads
    // coming off the wire.
    const payload = JSON.parse('{"id":1,"__proto__":{"isAdmin":true}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);

    const result = redact(payload, 'human') as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).not.toEqual({ isAdmin: true });
    expect(result.isAdmin).toBeUndefined();
  });
});

describe('redactField', () => {
  it('masks a single value by the field name with the rules redact itself uses', () => {
    expect(redactField('trojanPassword', 'trojan-plaintext', 'human')).toBe('<redacted>');
    expect(redactField('apiToken', 'abc', 'human')).toBe('<redacted>');
    // Нормализация имени та же, что и внутри redact: регистр и разделители не важны.
    expect(redactField('vless_uuid', 'plain-uuid', 'bot')).toBe('<redacted>');
  });

  it('follows the profile for PII and for the subscription link', () => {
    expect(redactField('email', 'client@example.com', 'human')).toBe('client@example.com');
    expect(redactField('email', 'client@example.com', 'bot')).toBe('<redacted>');
    expect(redactField('subscriptionUrl', 'https://sub.example.com/aBcDeFgHiJkLmNoP', 'human')).toBe(
      'https://sub.example.com/********',
    );
    expect(redactField('subscriptionUrl', 'https://sub.example.com/aBcDeFgHiJkLmNoP', 'bot')).toBe(
      '<redacted>',
    );
  });

  it('walks into the value when the name itself is harmless', () => {
    expect(redactField('note', 'plain', 'human')).toBe('plain');
    expect(redactField('inbounds', [{ tag: 'a', ssPassword: 'p' }], 'human')).toEqual([
      { tag: 'a', ssPassword: '<redacted>' },
    ]);
  });

  it('does not need a shared traversal state between calls', () => {
    // Отдельный вызов — отдельный стек: один и тот же объект, поданный дважды,
    // не должен со второго раза превратиться в '<circular>'.
    const shared = { ssPassword: 'p' };
    expect(redactField('a', shared, 'human')).toEqual({ ssPassword: '<redacted>' });
    expect(redactField('b', shared, 'human')).toEqual({ ssPassword: '<redacted>' });
  });
});
