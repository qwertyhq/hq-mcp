import { describe, expect, it } from 'vitest';
import { buildDiff, flatten, redactDiff } from './diff.js';

describe('flatten', () => {
  it('spreads nested objects into dot paths and keeps arrays whole', () => {
    const flat = flatten({ a: 1, b: { c: 'x', d: { e: true } }, list: [1, 2] });
    expect([...flat.entries()].sort()).toEqual([
      ['a', 1],
      ['b.c', 'x'],
      ['b.d.e', true],
      ['list', [1, 2]],
    ]);
  });

  it('puts a bare scalar under $', () => {
    expect([...flatten(42).entries()]).toEqual([['$', 42]]);
    expect([...flatten(null).entries()]).toEqual([['$', null]]);
  });

  it('keeps an empty object as a leaf, but not at the top level', () => {
    expect([...flatten({ a: {} }).entries()]).toEqual([['a', {}]]);
    // Пустой объект наверху не даёт ни одного пути: иначе buildDiff({}, {a: 1})
    // выдал бы лишнюю строку '$' рядом с настоящей 'a'.
    expect([...flatten({}).entries()]).toEqual([]);
  });

  it('treats a Date as a leaf instead of an object with no keys', () => {
    const at = new Date('2026-08-08T12:00:00.000Z');
    expect([...flatten({ at }).entries()]).toEqual([['at', at]]);
  });

  it('does not hang on a cycle and does not mistake a repeated reference for one', () => {
    const shared = { id: 7 };
    const root: Record<string, unknown> = { left: shared, right: shared };
    root['self'] = root;
    expect([...flatten(root).entries()].sort()).toEqual([
      ['left.id', 7],
      ['right.id', 7],
      ['self', '<circular>'],
    ]);
  });
});

describe('buildDiff', () => {
  it('shows only the changed paths, sorted by name', () => {
    const diff = buildDiff(
      { balance: 500, block: 0, settings: { lang: 'ru' } },
      { balance: 400, block: 0, settings: { lang: 'en' } },
      'human',
    );
    expect(diff).toEqual([
      { path: 'balance', from: 500, to: 400 },
      { path: 'settings.lang', from: 'ru', to: 'en' },
    ]);
  });

  it('sees fields appear and disappear', () => {
    expect(buildDiff({ a: 1 }, { b: 2 }, 'human')).toEqual([
      { path: 'a', from: 1, to: undefined },
      { path: 'b', from: undefined, to: 2 },
    ]);
  });

  it('does not call equal arrays a change, and does call a different one', () => {
    expect(buildDiff({ tags: ['a', 'b'] }, { tags: ['a', 'b'] }, 'human')).toEqual([]);
    expect(buildDiff({ tags: ['a'] }, { tags: ['a', 'b'] }, 'human')).toEqual([
      { path: 'tags', from: ['a'], to: ['a', 'b'] },
    ]);
  });

  it('does not confuse a missing key with a null value in either direction', () => {
    // Ровно тот случай, ради которого сравнение presence отделено от сравнения
    // значений: снапшот поля не вернул, мутатор ставит null, чтобы поле очистить.
    // При сравнении `from ?? null` с `to ?? null` обе стороны дают "null", строки
    // в diff нет вовсе, а запись поле стирает.
    expect(buildDiff({}, { description: null }, 'human')).toEqual([
      { path: 'description', from: undefined, to: null },
    ]);
    expect(buildDiff({ telegramId: null }, {}, 'human')).toEqual([
      { path: 'telegramId', from: null, to: undefined },
    ]);
    // А одинаковые null'ы по-прежнему не изменение.
    expect(buildDiff({ x: null }, { x: null }, 'human')).toEqual([]);
  });

  it('counts an explicitly undefined value as different from a real one', () => {
    expect(buildDiff({ description: 'old' }, { description: undefined }, 'human')).toEqual([
      { path: 'description', from: 'old', to: undefined },
    ]);
  });
});

describe('buildDiff redaction', () => {
  it('masks a credential named by the path, in both directions', () => {
    // §7.2: имя поля здесь — ЗНАЧЕНИЕ строки path, поэтому страховочная редакция
    // executeTool (она смотрит на имена ключей: path/from/to) его не видит.
    expect(buildDiff({ trojanPassword: 'old' }, { trojanPassword: 'new' }, 'human')).toEqual([
      { path: 'trojanPassword', from: '<redacted>', to: '<redacted>' },
    ]);
  });

  it('masks by the last segment of a nested path', () => {
    expect(buildDiff({ a: { password: 'x' } }, { a: { password: 'y' } }, 'human')).toEqual([
      { path: 'a.password', from: '<redacted>', to: '<redacted>' },
    ]);
  });

  it('masks by ANY segment, because redact masks a whole subtree under a secret key', () => {
    // redact({apiToken: {value: 'x'}}) режет весь объект apiToken целиком. Если
    // здесь смотреть только на последний сегмент ('value'), diff покажет тот же
    // секрет открытым текстом рядом с замаскированным снапшотом.
    expect(buildDiff({ apiToken: { value: 'old' } }, { apiToken: { value: 'new' } }, 'human')).toEqual(
      [{ path: 'apiToken.value', from: '<redacted>', to: '<redacted>' }],
    );
  });

  it('masks credentials hiding inside an array leaf', () => {
    expect(
      buildDiff({ inbounds: [{ tag: 'a', trojanPassword: 'p' }] }, { inbounds: [] }, 'human'),
    ).toEqual([
      { path: 'inbounds', from: [{ tag: 'a', trojanPassword: '<redacted>' }], to: [] },
    ]);
  });

  it('follows the profile: PII goes to the bot masked and to the human as is', () => {
    expect(buildDiff({ email: 'a@example.com' }, { email: 'b@example.com' }, 'human')).toEqual([
      { path: 'email', from: 'a@example.com', to: 'b@example.com' },
    ]);
    expect(buildDiff({ email: 'a@example.com' }, { email: 'b@example.com' }, 'bot')).toEqual([
      { path: 'email', from: '<redacted>', to: '<redacted>' },
    ]);
  });

  it('tail-masks a subscription link for the human and kills it for the bot', () => {
    const before = { subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP' };
    const after = { subscriptionUrl: 'https://sub.example.com/zZzZzZzZzZzZzZzZ' };
    expect(buildDiff(before, after, 'human')).toEqual([
      {
        path: 'subscriptionUrl',
        from: 'https://sub.example.com/********',
        to: 'https://sub.example.com/********',
      },
    ]);
    expect(buildDiff(before, after, 'bot')).toEqual([
      { path: 'subscriptionUrl', from: '<redacted>', to: '<redacted>' },
    ]);
  });

  it('compares the raw values, so a masked change is still reported as a change', () => {
    // Маскировать ДО сравнения нельзя: обе стороны стали бы '<redacted>',
    // строка исчезла бы из diff, и оператор подтвердил бы пустой план,
    // который меняет пароль.
    expect(buildDiff({ password: 'aaa' }, { password: 'bbb' }, 'human')).toHaveLength(1);
    expect(buildDiff({ password: 'aaa' }, { password: 'aaa' }, 'human')).toEqual([]);
  });

  it('leaves null and undefined alone: masking them would hide creation and clearing', () => {
    expect(buildDiff({}, { trojanPassword: 'new' }, 'human')).toEqual([
      { path: 'trojanPassword', from: undefined, to: '<redacted>' },
    ]);
    expect(buildDiff({ password: 'old' }, { password: null }, 'human')).toEqual([
      { path: 'password', from: '<redacted>', to: null },
    ]);
  });
});

describe('redactDiff', () => {
  it('masks entries built by hand, which never went through buildDiff', () => {
    // Мутаторы плана 5 собирают часть diff руками; для них это единственная защита.
    expect(
      redactDiff(
        [
          { path: 'settings.telegram.token', from: 'old-token', to: 'new-token' },
          { path: 'balance', from: 500, to: 400 },
        ],
        'human',
      ),
    ).toEqual([
      { path: 'settings.telegram.token', from: '<redacted>', to: '<redacted>' },
      { path: 'balance', from: 500, to: 400 },
    ]);
  });

  it('is idempotent: a second pass does not mangle already masked values', () => {
    const once = redactDiff([{ path: 'trojanPassword', from: 'a', to: 'b' }], 'human');
    expect(redactDiff(once, 'human')).toEqual(once);
  });
});
