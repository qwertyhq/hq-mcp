import { beforeEach, describe, expect, it } from 'vitest';
import { REDACTED, redact } from '@hq/redact';
import { ShmError, renameSafeShmKeys } from '@hq/shm';
import { assertNotForbidden } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ACCOUNTS_PATH, resetIdentitySchemaCache } from '../kit.js';
import { clientAccountState } from './account.js';

const USER = 4242;

/**
 * Настоящие ИМЕНА полей клиентских маршрутов безопасности, снятые с работающей
 * SHM 2.19.4. Три из четырёх полей `/user/password-auth` сталкиваются с
 * маскированием по имени (`password`, `key`) — стабы ниже прогоняют ответ через
 * тот же конвейер, что и рабочий клиент (переименование, затем redact), поэтому
 * столкновение здесь настоящее, а не описанное словами.
 */
const SOURCE = {
  '/user/email': [{ email: 'client@example.test', email_verified: 1 }],
  '/user/otp': [{ enabled: 0, verified: 0, required: 0, last_verified: null }],
  '/user/passkey': [{ credentials: [], enabled: 0 }],
  '/user/password-auth': [
    {
      password_auth_disabled: 0,
      password_set_by_user: 1,
      passkey_enabled: 0,
      otp_enabled: 0,
    },
  ],
  '/user/referrals': [{ total: 3 }],
} as const;

interface Options {
  exists?: boolean;
  /** Строка админской карточки клиента — источник второго адреса. */
  adminRow?: Record<string, unknown>;
  override?: Partial<Record<keyof typeof SOURCE, unknown>>;
  fail?: string[];
  calls?: StubCall[];
  /** Прогонять ли ответ через настоящую редакцию (по умолчанию — да). */
  live?: boolean;
}

function ctxFor(opts: Options = {}): Parameters<typeof clientAccountState.handler>[1] {
  const fail = opts.fail ?? [];
  const clean = (value: unknown): unknown =>
    opts.live === false ? value : redact(renameSafeShmKeys(value), 'human');
  return makeCtx({
    ...(opts.calls === undefined ? {} : { calls: opts.calls }),
    shmList: (path) => {
      /**
       * Установка ДО 3.0: маршрута `accounts` в роутере нет, и SHM отвечает
       * собственным 404. Раньше этого стаба здесь не было, потому что запрос
       * туда вообще не уходил — инструмент решал по ключу `login2` в строке.
       * Решение по строке снято (оно вырождалось на 3.1.0, где колонка жива),
       * схема спрашивается у SHM, и «старая схема» в тестах теперь обязана
       * выглядеть так, как она выглядит в бою.
       */
      if (path === ACCOUNTS_PATH) throw new ShmError('Method not found', 404);
      if (path === '/admin/user') {
        return (opts.exists ?? true) ? [opts.adminRow ?? { user_id: USER }] : [];
      }
      return [];
    },
    shmGet: (path) => {
      if (fail.includes(path)) throw new Error(`SHM GET ${path}: HTTP 500: Internal Server Error`);
      const key = path as keyof typeof SOURCE;
      const value = opts.override?.[key] ?? SOURCE[key] ?? [];
      return clean(value);
    },
  });
}

async function run(opts: Options = {}): Promise<Record<string, unknown>> {
  const input = clientAccountState.input.parse({ shm_user_id: USER });
  return (await clientAccountState.handler(input, ctxFor(opts))) as Record<string, unknown>;
}

function codes(result: Record<string, unknown>): string[] {
  return (result.warnings as Array<{ code: string }>).map((one) => one.code);
}

describe('client_account_state', () => {
  /**
   * `/user/email` отдаёт подтверждённый почтовый адрес, а админская колонка
   * `login2`, которую печатают client_overview/client_search/client_resolve,
   * может нести телеграм-логин. Два инструмента отвечали на «какая у клиента
   * почта» по-разному, и ни один не сообщал, что есть второй ответ.
   */
  it('names the admin-side address too, and flags it when the two disagree', async () => {
    const result = await run({
      adminRow: { user_id: USER, login: 'tg100000001', login2: '@100000001' },
    });
    expect(result.email).toEqual({
      address: 'client@example.test',
      allAddresses: ['client@example.test'],
      verified: true,
      onAdminRecord: '@100000001',
      onAdminRecordFrom: 'login2',
      matchesAdminRecord: false,
    });
    expect(codes(result)).toContain('email_admin_record_differs');
  });

  it('stays quiet when both sides carry the same address', async () => {
    const result = await run({
      adminRow: { user_id: USER, login: 'tg100000001', login2: 'Client@Example.test' },
    });
    // Регистр — не расхождение: адреса сравниваются нечувствительно к нему.
    expect((result.email as { matchesAdminRecord: boolean | null }).matchesAdminRecord).toBe(true);
    expect(codes(result)).not.toContain('email_admin_record_differs');
  });

  it('answers the questions that have no admin route at all', async () => {
    const result = await run();
    expect(result.email).toEqual({
      address: 'client@example.test',
      allAddresses: ['client@example.test'],
      verified: true,
      onAdminRecord: null,
      onAdminRecordFrom: null,
      matchesAdminRecord: null,
    });
    expect(result.otp).toEqual({
      enabled: false,
      verifiedInWindow: false,
      verificationRequired: false,
      lastVerifiedAt: null,
    });
    expect(result.referrals).toEqual({ total: 3 });
  });

  it('reads the password-login flags through the live redaction pipeline, not around it', async () => {
    // Эта проверка — весь смысл переименования на входе. Без него оба флага
    // приезжают маркером, и инструмент отвечает «неизвестно» на свой главный
    // вопрос при полностью исправном бэкенде.
    const result = await run();
    expect(result.signIn).toEqual({ pwdLoginPossible: true, pwdSetByUser: true, otpEnabled: false });
    expect(codes(result)).not.toContain('sign_in_flags_masked');
    expect(JSON.stringify(result)).not.toContain(REDACTED);
  });

  it('calls the masked flags unknown instead of calling them false', async () => {
    const result = await run({
      override: {
        '/user/password-auth': [
          { pwd_login_disabled: REDACTED, pwd_set_by_user: REDACTED, otp_enabled: 0 },
        ],
      },
      live: false,
    });
    expect(result.signIn).toEqual({ pwdLoginPossible: null, pwdSetByUser: null, otpEnabled: false });
    expect(codes(result)).toContain('sign_in_flags_masked');
  });

  /**
   * АПСТРИМНАЯ SHM НЕ ОТДАЁТ `password_set_by_user` ВОВСЕ:
   * `Core::User::api_password_auth_status` в `danuk/shm` возвращает три поля,
   * четвёртое дописано патчем конкретной инсталляции. Раньше отсутствие поля
   * было неотличимо от съеденного редакцией, и такая установка получала совет
   * чинить переименование полей, которое работает.
   */
  it('does not blame the redaction when the field simply is not in this SHM', async () => {
    const result = await run({
      override: {
        '/user/password-auth': [
          { password_auth_disabled: 0, passkey_enabled: 0, otp_enabled: 0 },
        ],
      },
    });
    expect(result.signIn).toEqual({ pwdLoginPossible: true, pwdSetByUser: null, otpEnabled: false });
    expect(codes(result)).not.toContain('sign_in_flags_masked');
    expect(codes(result)).toContain('sign_in_flag_absent');
    const absent = (result.warnings as Array<{ code: string; message: string }>).find(
      (one) => one.code === 'sign_in_flag_absent',
    );
    // null здесь означает «не сообщается», а не «пароль выдан автоматом».
    expect(absent?.message).toContain('never "the password was generated for them"');
  });

  it('reports that a passkey exists without handing over the id that deletes it', async () => {
    const result = await run({
      override: {
        '/user/passkey': [
          {
            enabled: 1,
            credentials: [
              { id: 'Y3JlZGVudGlhbC1pZC0x', name: 'iPhone', created_at: '2026-07-01 10:00:00' },
            ],
          },
        ],
      },
    });
    const fido = result.fido as {
      enabled: boolean;
      count: number;
      credentials: Array<Record<string, unknown>>;
    };
    expect(fido.enabled).toBe(true);
    expect(fido.count).toBe(1);
    expect(fido.credentials[0]).toEqual({ name: 'iPhone', createdAt: '2026-07-01 10:00:00' });
    expect(JSON.stringify(result)).not.toContain('Y3JlZGVudGlhbC1pZC0x');
    expect(codes(result)).not.toContain('no_second_factor');
  });

  it('names a missing email and an unverified one as different facts', async () => {
    expect(codes(await run({ override: { '/user/email': [{ email: null, email_verified: 0 }] } }))).toContain(
      'email_absent',
    );
    const unverified = await run({
      override: { '/user/email': [{ email: 'client@example.test', email_verified: 0 }] },
    });
    expect(codes(unverified)).toContain('email_unverified');
    expect(codes(unverified)).not.toContain('email_absent');
  });

  it('qualifies "no second factor" instead of stating it flatly', async () => {
    const result = await run();
    expect(codes(result)).toContain('no_second_factor');
    const message = (result.warnings as Array<{ code: string; message: string }>).find(
      (one) => one.code === 'no_second_factor',
    )?.message;
    expect(message).toMatch(/Telegram/);
  });

  it('never calls a client route for a user_id SHM does not have', async () => {
    const calls: StubCall[] = [];
    const result = await run({ exists: false, calls });
    expect(result.exists).toBe(false);
    expect(codes(result)).toContain('user_not_found');
    expect(calls.filter((one) => !one.path.startsWith('/admin/'))).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it('leaves an unread block null rather than reporting an absent factor', async () => {
    const result = await run({ fail: ['/user/otp'] });
    expect(result.otp).toBeNull();
    expect(result.fido).not.toBeNull();
    expect(codes(result)).toContain('partial_result');
    // «Второго фактора нет» — утверждение о ДВУХ прочитанных маршрутах; на
    // непрочитанном OTP его делать нельзя.
    expect(codes(result)).not.toContain('no_second_factor');
  });

  it('refuses the bot profile in its own handler', async () => {
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const ctx = makeCtx({ profile: 'bot', shmGet: () => [], shmList: () => [] });
    await expect(clientAccountState.handler(input, ctx)).rejects.toThrow(/human profile only/);
    expect(clientAccountState.profiles).toEqual(['human']);
  });

  it('reaches for no route the mutating-GET list closes', () => {
    for (const path of ['/user/email', '/user/otp', '/user/passkey', '/user/password-auth', '/user/referrals']) {
      expect(() => assertNotForbidden(path, 'GET')).not.toThrow();
    }
  });
});

/**
 * SHM 3.0 УБРАЛА `users.login2`, И ВМЕСТЕ С НЕЙ — ВТОРУЮ ПОЛОВИНУ СРАВНЕНИЯ.
 *
 * Весь смысл блока `email` здесь в том, что источников адреса ДВА и они
 * расходятся. На 3.0 вторая половина не «пустая», а переехала в таблицу
 * `accounts`: инструмент, продолжающий читать `login2`, получает `null`,
 * `matchesAdminRecord` становится `null`, и предупреждение о расхождении не
 * срабатывает никогда. Со стороны это выглядит как «расхождений нет».
 */
describe('client_account_state × SHM 3.0 accounts', () => {
  const ACCOUNTS = [
    { login: 'tg4242', type: 'login', user_id: USER, primary: 1 },
    {
      login: 'other@example.test',
      type: 'email',
      user_id: USER,
      settings: { email: { verified: 1 } },
      primary: 0,
    },
  ];

  function ctx30(calls: StubCall[] = []): Parameters<typeof clientAccountState.handler>[1] {
    return makeCtx({
      calls,
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) return ACCOUNTS;
        /**
         * Строка клиента на 3.1.0, какой её отдаёт `/admin/user`: колонка
         * `login2` НА МЕСТЕ (миграция её не дропает, а запрос идёт
         * `fields => '*'`), и лежит в ней довоенное значение — здесь
         * телеграм-хендл, как его пишет телеграм-регистрация.
         */
        if (path === '/admin/user') {
          return [{ user_id: USER, login: 'tg4242', login2: '@4242' }];
        }
        return [];
      },
      shmGet: (path) => {
        if (path === '/user/email') {
          // get_emails: МАССИВ, отсортированный primary-первым.
          return [
            { email: 'client@example.test', email_verified: 1, is_primary: 1 },
            { email: 'other@example.test', email_verified: 1, is_primary: 0 },
          ];
        }
        return (SOURCE[path as keyof typeof SOURCE] as unknown) ?? [];
      },
    });
  }

  beforeEach(() => {
    resetIdentitySchemaCache();
  });

  it('finds the admin-side address where 3.0 moved it, instead of reporting none', async () => {
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const result = (await clientAccountState.handler(input, ctx30())) as Record<string, unknown>;
    const email = result.email as {
      onAdminRecord: string | null;
      onAdminRecordFrom: string | null;
      matchesAdminRecord: boolean | null;
      allAddresses: string[];
    };
    expect(result.identitySchema).toBe('accounts');
    expect(email.onAdminRecord).toBe('other@example.test');
    expect(email.onAdminRecordFrom).toBe('accounts');
    // Сравнение СОСТОЯЛОСЬ и разошлось — вместо молчаливого null.
    expect(email.matchesAdminRecord).toBe(false);
    expect(codes(result)).toContain('email_admin_record_differs');
  });

  it('reports every address on file, not just the primary one', async () => {
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const result = (await clientAccountState.handler(input, ctx30())) as Record<string, unknown>;
    const email = result.email as { address: string | null; allAddresses: string[] };
    expect(email.address).toBe('client@example.test');
    expect(email.allAddresses).toEqual(['client@example.test', 'other@example.test']);
    expect(codes(result)).toContain('email_several_on_file');
  });

  /**
   * РЕГРЕССИЯ НА ГЛАВНУЮ ПОЛОМКУ: раньше здесь стоял тест «не тратим запрос на
   * accounts, когда в строке есть login2». Он проходил — и ровно поэтому на
   * боевой 3.1.0 инструмент в accounts не ходил НИКОГДА: колонка `login2`
   * физически осталась в таблице, а `/admin/user` отдаёт её как обычное поле.
   */
  it('asks SHM where identity lives even when the row still carries login2', async () => {
    const calls: StubCall[] = [];
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const result = (await clientAccountState.handler(input, ctx30(calls))) as Record<
      string,
      unknown
    >;
    expect(calls.some((one) => one.path === ACCOUNTS_PATH)).toBe(true);
    expect(result.identitySchema).toBe('accounts');
  });

  it('never prints the pre-migration login2 as the admin-side address', async () => {
    // Живой случай с прода: в `login2` остался телеграм-хендл, а почта клиента
    // с 3.0 лежит в accounts. Подставленный сюда хендл давал расхождение с
    // клиентским маршрутом — предупреждение о конфликте, которого нет.
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const result = (await clientAccountState.handler(input, ctx30())) as Record<string, unknown>;
    const email = result.email as { onAdminRecord: string | null; onAdminRecordFrom: string | null };
    expect(email.onAdminRecord).not.toBe('@4242');
    expect(email.onAdminRecordFrom).toBe('accounts');
  });

  /**
   * «Основной» адрес SHM определяет сравнением с `users.login`, а логин этой
   * установки почти всегда телеграмный — значит основного нет ни у кого, и
   * первая строка ответа основной не является. Молча взять её — это выдать
   * порядок выдачи базы за выбор клиента.
   */
  it('does not call the first of several addresses primary when none of them is', async () => {
    const input = clientAccountState.input.parse({ shm_user_id: USER });
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) return ACCOUNTS;
        if (path === '/admin/user') return [{ user_id: USER, login: 'tg4242', login2: '@4242' }];
        return [];
      },
      shmGet: (path) => {
        if (path === '/user/email') {
          return [
            { email: 'first@example.test', email_verified: 1, is_primary: 0 },
            { email: 'second@example.test', email_verified: 1, is_primary: 0 },
          ];
        }
        return (SOURCE[path as keyof typeof SOURCE] as unknown) ?? [];
      },
    });
    const result = (await clientAccountState.handler(input, ctx)) as Record<string, unknown>;
    expect(codes(result)).toContain('email_primary_unset');
  });
});
