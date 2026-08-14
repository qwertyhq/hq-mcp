import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '@hq/redact';
import { renameSafeShmKeys } from '@hq/shm';
import { assertNotForbidden } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
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
      verified: true,
      onAdminRecord: '@100000001',
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
      verified: true,
      onAdminRecord: null,
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
