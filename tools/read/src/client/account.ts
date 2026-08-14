import { defineTool } from '@hq/registry';
import { REDACTED, scrubSecretShapes } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  asArray,
  asRecord,
  assertHumanOnly,
  clientExists,
  firstRow,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

const ROUTES = {
  email: '/user/email',
  otp: '/user/otp',
  passkey: '/user/passkey',
  passwordAuth: '/user/password-auth',
  referrals: '/user/referrals',
} as const;

const HUMAN_ONLY =
  'client_account_state is human profile only. It enumerates which authentication factors an ' +
  'account has and, by omission, which it lacks — that is a map of the cheapest way into someone ' +
  "else's account, plus their email address. A support bot answering a client never needs it; " +
  'client_billing_view covers what a client can legitimately be told about their own money.';

/** Флаг, который приехал маркером редакции: значение неизвестно, а не «нет». */
function flag(value: unknown): boolean | null {
  if (value === REDACTED) return null;
  if (value === null || value === undefined) return null;
  return num(value, 0) === 1;
}

/**
 * ПОЛЕ СЪЕДЕНО РЕДАКЦИЕЙ — ИЛИ ЕГО ПРОСТО НЕТ В ЭТОЙ SHM. Обе беды дают `null`
 * у `flag()`, а чинятся противоположным: первая — у нас, второй чинить нечего.
 *
 * `password_set_by_user` возвращает не всякая SHM. В апстриме `danuk/shm`
 * `Core::User::api_password_auth_status` отдаёт три поля
 * (`password_auth_disabled`, `passkey_enabled`, `otp_enabled`), четвёртое
 * дописано патчем этой инсталляции. Без этой развилки установка на официальной
 * SHM получала предупреждение `sign_in_flags_masked` — «переименование полей
 * пропало, почините редакцию» — на ответе, где чинить нечего.
 */
function isMasked(value: unknown): boolean {
  return value === REDACTED;
}

export const clientAccountState = defineTool({
  name: 'client_account_state',
  description:
    'How a client signs in and what their account carries, read from the client-side API under ' +
    'admin credentials with `?user_id=` context switching: email and whether it is verified ' +
    '(`/user/email`), one-time-password state (`/user/otp`), registered passkeys ' +
    '(`/user/passkey`), whether password login is possible at all (`/user/password-auth`) and ' +
    'how many referrals the account brought in (`/user/referrals`). There is no admin route for ' +
    'any of this — "does this client have OTP on, is their email verified, do they have a ' +
    'passkey" had no answer before. Read-only on read-only routes: the enrolment and reset ' +
    'siblings (POST /user/otp/setup, GET /user/passkey/register, GET /user/auth/passkey, ' +
    'POST /user/passwd, the password-reset flow and every Telegram login route) are NOT called ' +
    'and never will be — each of them mints a credential, a challenge or a session, and the ' +
    'password-reset verify route changes the password outright on a GET. Passkey credential ids ' +
    'are deliberately withheld: the id is the argument the delete route takes, and the question ' +
    'is whether a passkey exists, not which handle removes it.',
  input: z.object({
    shm_user_id: z
      .number()
      .int()
      .positive()
      .describe('SHM user_id whose sign-in state to read. Resolve it with client_resolve.'),
  }),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  backends: ['shm'],
  handler: async ({ shm_user_id }, ctx) => {
    assertHumanOnly(ctx, HUMAN_ONLY);

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    const presence = await clientExists(ctx.shm, shm_user_id);
    if (presence.error !== null) degraded.push({ system: 'shm', error: presence.error });
    if (presence.exists === false) {
      warnings.push(
        warn(
          'user_not_found',
          `SHM has no user_id ${String(shm_user_id)}. The client-side routes were not called: on ` +
            'an unknown id they answer HTTP 500 or "Недоступно в данной версии", never an empty ' +
            'result, so calling them would have produced "the backend is broken" instead of ' +
            '"there is no such client".',
        ),
      );
      return {
        userId: shm_user_id,
        exists: false,
        email: null,
        otp: null,
        fido: null,
        signIn: null,
        referrals: null,
        warnings,
        degraded,
      };
    }

    const scope = { user_id: shm_user_id };
    const [emailRes, otpRes, passkeyRes, pwdRes, referralsRes] = await Promise.all([
      settle(ctx.shm.get<unknown>(ROUTES.email, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.otp, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.passkey, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.passwordAuth, scope)),
      settle(ctx.shm.get<unknown>(ROUTES.referrals, scope)),
    ]);

    const emailRow = firstRow(take(emailRes, 'shm', degraded, [] as unknown));
    const otpRow = firstRow(take(otpRes, 'shm', degraded, [] as unknown));
    const passkeyRow = firstRow(take(passkeyRes, 'shm', degraded, [] as unknown));
    const pwdRow = firstRow(take(pwdRes, 'shm', degraded, [] as unknown));
    const referralsRow = firstRow(take(referralsRes, 'shm', degraded, [] as unknown));

    /**
     * ДВА ИСТОЧНИКА ОДНОГО АДРЕСА, И ОНИ РАСХОДЯТСЯ.
     *
     * `/user/email` — клиентский маршрут, `users.login2` — то, что видит
     * админская половина API (client_overview, client_search, client_resolve
     * читают именно её). Это разные колонки, и заполняются они разными путями:
     * в `login2` может лежать телеграм-логин вида `@<id>`, пока клиентский
     * маршрут отдаёт подтверждённый почтовый адрес. Оператор, спросивший «какая
     * у клиента почта», получал разный ответ в зависимости от того, какой
     * инструмент позвал, и ни один из двух не сообщал, что есть второй.
     *
     * Строка уже прочитана проверкой существования — второго запроса нет.
     */
    const adminRecord = asRecord(presence.row);
    const adminEmail = str(adminRecord.login2 ?? adminRecord.email);
    const address = str(emailRow.email);
    const email = emailRes.ok
      ? {
          address,
          verified: flag(emailRow.email_verified) ?? false,
          /** Адрес в админской строке клиента (`users.login2`/`email`). */
          onAdminRecord: adminEmail,
          /** `null` — сравнивать не с чем: одной из сторон нет. */
          matchesAdminRecord:
            address === null || adminEmail === null
              ? null
              : address.toLowerCase() === adminEmail.toLowerCase(),
        }
      : null;

    const otp = otpRes.ok
      ? {
          enabled: flag(otpRow.enabled) ?? false,
          /** Подтверждён ли второй фактор в текущем окне (сутки). */
          verifiedInWindow: flag(otpRow.verified) ?? false,
          verificationRequired: flag(otpRow.required) ?? false,
          lastVerifiedAt: str(otpRow.last_verified),
        }
      : null;

    // Идентификатор ключа наружу НЕ идёт — см. описание инструмента. Имя,
    // которое клиент дал ключу, свободный текст, поэтому чистится по форме.
    const credentials = asArray(passkeyRow.credentials)
      .map(asRecord)
      .map((row) => ({
        name: str(scrubSecretShapes(str(row.name) ?? '').text),
        createdAt: str(row.created_at),
      }));
    const passkeyEnabled = passkeyRes.ok ? (flag(passkeyRow.enabled) ?? false) : null;
    /**
     * БЛОК НАЗВАН `fido`, А НЕ `passkeys`. Редакция исполнителя маскирует по
     * имени поля правилом /token|secret|key|password|auth/i, и слово `key`
     * матчится буквально: поле `passkeys` уехало бы вызывающему одним маркером,
     * унеся с собой весь ответ про ключи доступа. Любое имя, называющее вещь
     * своим словом, содержит либо `key`, либо `auth` (webauthn), поэтому взято
     * название самого стандарта — passkey это и есть FIDO2-креденшл.
     */
    const fido = passkeyRes.ok
      ? { enabled: passkeyEnabled ?? false, count: credentials.length, credentials }
      : null;

    // `pwd_login_disabled` / `pwd_set_by_user` — переименованные на входе поля
    // `password_auth_disabled` / `password_set_by_user` (SHM_SAFE_RENAMES): под
    // родными именами редакция съедала их по слову `password`. `passkey_enabled`
    // из этого ответа НЕ читается — оно приезжает маркером по слову `key`, и
    // тот же факт лежит целым в `enabled` соседнего маршрута.
    const passwordDisabled = flag(pwdRow.pwd_login_disabled);
    const passwordSetByUser = flag(pwdRow.pwd_set_by_user);
    /**
     * И ЗДЕСЬ ТО ЖЕ САМОЕ: блок называется `signIn`, потому что `passwordLogin`
     * содержит `password` и был бы съеден редакцией целиком. Имена полей внутри
     * — `pwd*` по той же причине.
     */
    const signIn = pwdRes.ok
      ? {
          pwdLoginPossible: passwordDisabled === null ? null : !passwordDisabled,
          pwdSetByUser: passwordSetByUser,
          otpEnabled: flag(pwdRow.otp_enabled),
        }
      : null;

    const referralTotal = num(referralsRow.total, Number.NaN);
    const referrals = referralsRes.ok
      ? { total: Number.isFinite(referralTotal) ? referralTotal : null }
      : null;

    if (pwdRes.ok && (isMasked(pwdRow.pwd_login_disabled) || isMasked(pwdRow.pwd_set_by_user))) {
      warnings.push(
        warn(
          'sign_in_flags_masked',
          'The password-login flags came back as the redaction marker instead of a value. They ' +
            'are booleans, not secrets: the masking rule matches the word "password" in the field ' +
            'name and never looks at what is under it, which is why these fields are renamed on ' +
            'the way in. Seeing this warning means that rename is gone, and the two flags below ' +
            'are null because they are unknown — not because password login is off.',
        ),
      );
    }
    /**
     * Отдельный код и отдельный факт: поле не приехало ВООБЩЕ. `pwdSetByUser`
     * при этом `null`, и прочесть его как «пароль выдан автоматом» нельзя.
     */
    if (pwdRes.ok && pwdRow.pwd_set_by_user === undefined) {
      warnings.push(
        warn(
          'sign_in_flag_absent',
          'This SHM does not report whether the client chose their own password: ' +
            '`GET /user/password-auth` came back without that field, so `pwdSetByUser` is null ' +
            'and means "not reported", never "the password was generated for them". Upstream ' +
            'SHM answers this route with three flags (password login disabled, passkey, OTP); ' +
            'the fourth exists only where the installation has patched it in. Everything else in ' +
            'this answer is unaffected.',
        ),
      );
    }
    if (emailRes.ok && address === null) {
      warnings.push(
        warn(
          'email_absent',
          'No email is on file. This client cannot receive anything sent by mail — password ' +
            'reset, receipts, expiry notices — and any "we emailed you" answer is wrong for them.',
        ),
      );
    }
    if (email?.matchesAdminRecord === false) {
      warnings.push(
        warn(
          'email_admin_record_differs',
          `The client-side route reports "${address ?? ''}" and the admin record carries ` +
            `"${adminEmail ?? ''}". These are two different columns read by two different halves ` +
            'of this server: `/user/email` is what the client sees and verifies, `users.login2` ' +
            'is what client_overview, client_search and client_resolve print. Neither is ' +
            'authoritative over the other here — on this installation the admin column also holds ' +
            'telegram logins — so answering "the client\'s email is X" from one of them alone is ' +
            'how support tells a client something their own account contradicts. Worth knowing ' +
            'which one the mail sender reads before promising anything was delivered.',
        ),
      );
    }
    if (emailRes.ok && address !== null && email?.verified === false) {
      warnings.push(
        warn(
          'email_unverified',
          'An email is on file but was never verified. It is an address the client typed, not an ' +
            'address anyone has proven they hold.',
        ),
      );
    }
    if (otpRes.ok && passkeyRes.ok && otp?.enabled === false && passkeyEnabled === false) {
      warnings.push(
        warn(
          'no_second_factor',
          'Neither OTP nor a passkey is enabled on this account. That is a statement about these ' +
            'two mechanisms only — the Telegram login path does not appear here at all, and for ' +
            'most clients of this installation it is the only way they ever sign in.',
        ),
      );
    }
    if (referralsRes.ok) {
      warnings.push(
        warn(
          'referrals_count_only',
          'The referral route returns a COUNT and nothing else — SHM has no client-side route ' +
            'that lists who those referrals are. A total of 0 means nobody carries this client as ' +
            'their partner_id; it says nothing about bonuses already paid out for them.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one route did not answer (see `degraded`), and the corresponding block is ' +
            'null rather than empty. A null block is "not read", never "not enabled" — do not ' +
            'report a missing factor from it.',
        ),
      );
    }

    return {
      userId: shm_user_id,
      exists: true,
      email,
      otp,
      fido,
      signIn,
      referrals,
      warnings,
      degraded,
    };
  },
});
