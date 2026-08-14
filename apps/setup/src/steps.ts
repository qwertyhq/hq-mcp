import { isAccess, isProfile } from '@hq/types';
import type { Access, BackendPresence, Profile } from '@hq/types';
import { checkRemna, checkShm } from './checks.js';
import { SetupAbortedError } from './errors.js';
import { maskAuth, maskSecret } from './mask.js';
import { askAfterFailure, askValue, confirm } from './prompts.js';
import type { CheckDeps, CheckOutcome } from './checks.js';
import type { SetupIo } from './io.js';
import type { ToolCounts } from './tools.js';

export interface StepContext {
  readonly io: SetupIo;
  /** Значения из уже лежащего рядом `.env`; Enter оставляет их. */
  readonly existing: Record<string, string>;
  /** Проверка формы значения ТЕМ ЖЕ загрузчиком, которым её проверит сервер. */
  readonly validate: (key: string, value: string) => string | null;
  readonly check: CheckDeps;
}

/** `{ current }` только когда значение есть: exactOptionalPropertyTypes. */
function currentOf(existing: Record<string, string>, key: string): { current?: string } {
  const value = existing[key];
  return value === undefined || value.trim() === '' ? {} : { current: value };
}

/**
 * Общий цикл «спроси — проверь на живом бэкенде — реши, что делать с отказом».
 *
 * Один на оба бэкенда, потому что решение после неудачи одно и то же, а два
 * почти одинаковых цикла — это два места, где однажды разойдётся ответ на
 * вопрос «а можно ли всё-таки записать непроверенное».
 */
async function askVerified<T>(
  ctx: StepContext,
  ask: () => Promise<T>,
  verify: (value: T) => Promise<CheckOutcome>,
): Promise<T> {
  for (;;) {
    const value = await ask();
    ctx.io.say('  checking it against the live system…');
    const outcome = await verify(value);
    ctx.io.say(`  ${outcome.message}`);
    if (outcome.status === 'ok') return value;

    const next = await askAfterFailure(ctx.io);
    if (next === 'abort') {
      throw new SetupAbortedError('aborted at the credential check; nothing was written');
    }
    if (next === 'keep') {
      ctx.io.say('  keeping the unverified value — the server will fail on the first tool call if it is wrong');
      return value;
    }
  }
}

/**
 * КАКИЕ СИСТЕМЫ У ЭТОЙ УСТАНОВКИ ЕСТЬ — ПЕРВЫЙ ВОПРОС И САМЫЙ ВАЖНЫЙ.
 *
 * До него мастер спрашивал креды обеих подряд, и человеку без SHM (а это
 * большинство: панель Remnawave стоит у всех её операторов, SHM — нишевый
 * биллинг) деваться было некуда — сервер без всех четырёх переменных не
 * стартовал вовсе. Теперь обязательна ОДНА пара, и решает это здесь человек, а
 * не молчаливое требование загрузчика.
 *
 * Дефолта у вопроса нет, пока рядом нет прежнего `.env`: угаданный за человека
 * набор систем — это либо лишние вопросы про то, чего у него нет, либо тихо
 * пропущенная половина инструментов. С прежним файлом дефолт есть, и он
 * прочитан, а не угадан: какие пары в нём заполнены.
 */
export async function askBackends(
  ctx: StepContext,
  current: BackendPresence | null,
): Promise<BackendPresence> {
  const asWord = (value: BackendPresence): string =>
    value.shm && value.remna ? 'both' : value.shm ? 'shm' : 'remna';
  for (;;) {
    ctx.io.say('');
    ctx.io.say('Which of the two systems does this installation have?');
    ctx.io.say('  remna  Remnawave panel only — nodes, hosts, subscribers, traffic');
    ctx.io.say('  shm    SHM billing only — clients, services, money, provisioning');
    ctx.io.say('  both   both, joined together — also the cross-system tools');
    ctx.io.say('  Tools that need a system you do not have are not published at all,');
    ctx.io.say('  so an answer here is a decision about what the agent can see.');
    if (current !== null) ctx.io.say(`  Enter keeps: ${asWord(current)}`);
    const typed = (await ctx.io.ask('  > ')).trim().toLowerCase();
    const chosen = typed === '' && current !== null ? asWord(current) : typed;
    if (chosen === 'both') return { shm: true, remna: true };
    if (chosen === 'shm') return { shm: true, remna: false };
    if (chosen === 'remna' || chosen === 'remnawave') return { shm: false, remna: true };
    ctx.io.say('  answer remna, shm or both');
  }
}

export interface ShmAnswer {
  readonly baseUrl: string;
  readonly auth: string;
  /** Зона, которой SHM подписала свой ответ, если проверка дошла до успеха. */
  readonly serverTz: string | null;
}

/**
 * `SHM_ADMIN_AUTH` — это НЕ пара полей и не одно поле, а либо то, либо другое:
 * загрузчик принимает и `login:password`, и готовый `Basic <base64>`.
 * Спрашивать его одной строкой значило бы просить человека собрать пару руками
 * (и получить пароль, напечатанный на экране в открытом виде, потому что
 * строку целиком не замаскируешь по частям). Поэтому логин спрашивается
 * видимо, пароль — скрыто, а готовый заголовок распознаётся на месте логина и
 * отменяет второй вопрос.
 */
async function askShmAuth(ctx: StepContext): Promise<string> {
  const raw = ctx.existing.SHM_ADMIN_AUTH?.trim() ?? '';
  const ready = /^basic\s+/i.test(raw);
  const colon = raw.indexOf(':');
  const login = ready ? raw : colon > 0 ? raw.slice(0, colon) : raw;
  const password = !ready && colon > 0 ? raw.slice(colon + 1) : '';

  const typedLogin = await askValue(ctx.io, {
    key: 'SHM_ADMIN_AUTH (login)',
    description:
      'the billing admin login. A ready "Basic <base64>" header is accepted here too and skips the password question',
    // Логин показывается КАК ЕСТЬ: он не секрет, а единственное, по чему
    // человек узнаёт, та ли это запись. Под маску уходит только готовый
    // заголовок — в нём пароль лежит целиком, пусть и в base64.
    maskWith: (value: string): string => (/^basic\s+/i.test(value) ? maskAuth(value) : value),
    ...(login === '' ? {} : { current: login }),
  });
  if (/^basic\s+/i.test(typedLogin)) return typedLogin;

  const typedPassword = await askValue(ctx.io, {
    key: 'SHM_ADMIN_AUTH (password)',
    description: 'its password — typed blind, never echoed, never printed back',
    secret: true,
    maskWith: (): string => '•'.repeat(8),
    ...(password === '' ? {} : { current: password }),
  });
  return `${typedLogin}:${typedPassword}`;
}

export async function askShm(ctx: StepContext): Promise<ShmAnswer> {
  let serverTz: string | null = null;
  const answer = await askVerified(
    ctx,
    async (): Promise<{ baseUrl: string; auth: string }> => {
      const baseUrl = await askValue(ctx.io, {
        key: 'SHM_BASE_URL',
        description: 'the SHM billing API root, including the version segment',
        example: 'https://billing.example.com/shm/v1',
        validate: (value: string): string | null => ctx.validate('SHM_BASE_URL', value),
        ...currentOf(ctx.existing, 'SHM_BASE_URL'),
      });
      return { baseUrl, auth: await askShmAuth(ctx) };
    },
    async (value): Promise<CheckOutcome> => {
      const outcome = await checkShm(value, ctx.check);
      serverTz = outcome.serverTz;
      return outcome;
    },
  );
  return { ...answer, serverTz };
}

export async function askRemna(ctx: StepContext): Promise<{ baseUrl: string; token: string }> {
  return askVerified(
    ctx,
    async (): Promise<{ baseUrl: string; token: string }> => {
      const baseUrl = await askValue(ctx.io, {
        key: 'REMNA_BASE_URL',
        description: 'the Remnawave panel root, with no path after the host',
        example: 'https://panel.example.com',
        validate: (value: string): string | null => ctx.validate('REMNA_BASE_URL', value),
        ...currentOf(ctx.existing, 'REMNA_BASE_URL'),
      });
      const token = await askValue(ctx.io, {
        key: 'REMNA_API_TOKEN',
        description: 'a panel token with the API role (a JWT) — typed blind, never printed back',
        secret: true,
        maskWith: maskSecret,
        ...currentOf(ctx.existing, 'REMNA_API_TOKEN'),
      });
      return { baseUrl, token };
    },
    (value): Promise<CheckOutcome> => checkRemna(value, ctx.check),
  );
}

/**
 * `ro` — не «безопасный дефолт из вежливости», а разница в том, что агент
 * может сделать с чужими деньгами и чужими подписками. Поэтому `rw`
 * включается двумя действиями: словом `rw` и отдельным «да» после того, как
 * названо число пишущих инструментов.
 */
export async function askMode(
  ctx: StepContext,
  counts: ToolCounts | null,
  current: Access,
): Promise<Access> {
  for (;;) {
    ctx.io.say('');
    ctx.io.say('HQ_MCP_MODE — what the agent is allowed to do with the two live systems');
    if (counts === null) {
      ctx.io.say('  ro   read only');
      ctx.io.say('  rw   read and write: also publishes tools that change live data');
    } else {
      ctx.io.say(`  ro   read only — ${String(counts.ro)} tools, not one of which writes anything`);
      ctx.io.say(
        `  rw   read and write — ${String(counts.rw)} tools, of which ${String(counts.writers)} change live billing and the live panel`,
      );
    }
    ctx.io.say(`  Enter keeps: ${current}`);
    const typed = (await ctx.io.ask('  > ')).toLowerCase();
    const chosen = typed === '' ? current : typed;
    if (!isAccess(chosen)) {
      ctx.io.say('  answer ro or rw');
      continue;
    }
    if (chosen === 'ro') return 'ro';

    ctx.io.say('');
    ctx.io.say('  rw is production write access, not a preference:');
    ctx.io.say('  money moves on real accounts, services are blocked and unblocked,');
    ctx.io.say('  panel users and provisioning tasks are changed for real people.');
    ctx.io.say('  Every mutation still needs an explicit confirm step and lands in the');
    ctx.io.say('  audit journal — but the tools are there, and the model can reach them.');
    if (await confirm(ctx.io, '  Enable rw?', false)) return 'rw';
    ctx.io.say('  staying on ro');
    return 'ro';
  }
}

export interface AdvancedDefaults {
  readonly profile: Profile;
  readonly shmTz: string;
  readonly budgetLimit: number;
  readonly budgetWindowMs: number;
  readonly maxOpAmount: number;
  /** Отсутствует, если у загрузчика этой переменной ещё нет. */
  readonly maxBulkUsers?: number;
  readonly tunnelHost: string;
  readonly tunnelAbuseUrl: string;
  readonly tunnelPgPort: number;
  readonly tunnelSsh: string;
}

/**
 * Необязательные переменные. Спрашиваются за ОДНИМ «настроить дополнительно?»
 * и только те, что на что-то влияют: потолки мутаций — лишь в `rw`, где им
 * есть что останавливать.
 *
 * Возвращает только то, что человек назвал ЯВНО. Значение, равное дефолту, в
 * файл не попадает: `.env`, забитый повторением дефолтов, читается как список
 * осознанных решений, и следующий человек будет обходить их стороной, думая,
 * что за каждым числом что-то стоит.
 */
export async function askAdvanced(
  ctx: StepContext,
  defaults: AdvancedDefaults,
  mode: Access,
  serverTz: string | null,
  backends: BackendPresence = { shm: true, remna: true },
): Promise<Record<string, string>> {
  const picked: Record<string, string> = {};
  const ask = async (
    key: string,
    description: string,
    fallback: string,
    extra: {
      secret?: boolean;
      optional?: boolean;
      maskWith?: (value: string) => string;
      /**
       * Значение, при котором переменную писать НЕ НАДО, — то есть дефолт
       * САМОГО ЗАГРУЗЧИКА. Обычно совпадает с показанным, но не всегда: зону
       * мастер предлагает ту, что назвал живой сервер, и если она отличается
       * от встроенной, её как раз и надо записать, а не выбросить как «то же
       * самое, что по умолчанию».
       */
      omitWhen?: string;
    } = {},
  ): Promise<void> => {
    const value = await askValue(ctx.io, {
      key,
      description,
      validate: (candidate: string): string | null => ctx.validate(key, candidate),
      ...(extra.secret === true ? { secret: true } : {}),
      ...(extra.optional === true ? { optional: true } : {}),
      ...(extra.maskWith === undefined ? {} : { maskWith: extra.maskWith }),
      ...currentOf(ctx.existing, key),
      ...(fallback === '' ? {} : { fallback }),
    });
    if (value !== '' && value !== (extra.omitWhen ?? fallback)) picked[key] = value;
  };

  if (!(await confirm(ctx.io, '\nConfigure the optional settings (profile, timezone, request budget, tunnel)?', false))) {
    // Зона, прочитанная у живого сервера, — единственное, что пишется и без
    // «дополнительно». Дефолт HQ_MCP_SHM_TZ угадывает её, а SHM пишет даты
    // локальным временем сервера без офсета: не совпало — и каждый возраст
    // задачи уезжает ровно на разницу, ни в одном ответе об этом не сказано.
    if (serverTz !== null && serverTz !== defaults.shmTz) {
      picked.HQ_MCP_SHM_TZ = serverTz;
      ctx.io.say(
        `  (writing HQ_MCP_SHM_TZ=${serverTz} — the value SHM itself reported, not the built-in default ${defaults.shmTz})`,
      );
    }
    return picked;
  }

  await ask(
    'HQ_MCP_PROFILE',
    'human is a trusted operator at a terminal and gets specific refusals; bot is an untrusted channel and gets one uniform "not found"',
    defaults.profile,
  );
  // Зона существует ради «голых» штампов SHM. Без SHM вопрос был бы про
  // настройку, которая в этой установке не влияет ни на один ответ.
  if (backends.shm) {
    await ask(
      'HQ_MCP_SHM_TZ',
      serverTz === null
        ? 'the timezone SHM writes its dates in (it writes them with no offset, so a wrong zone shifts every age silently)'
        : `the timezone SHM writes its dates in — the live server just reported ${serverTz}`,
      serverTz ?? defaults.shmTz,
      { omitWhen: defaults.shmTz },
    );
  }
  await ask(
    'HQ_MCP_BUDGET_LIMIT',
    'local request gate: how many calls per window, shared by every tool. The default is half of what SHM throttles at, because other clients share that bucket',
    String(defaults.budgetLimit),
  );
  await ask('HQ_MCP_BUDGET_WINDOW_MS', 'the window for that gate, in milliseconds', String(defaults.budgetWindowMs));

  if (mode === 'rw') {
    // Деньги двигает только биллинг, массовые операции — только панель.
    // Спрашивать потолок для системы, которой здесь нет, значит предлагать
    // настроить предохранитель, которому нечего останавливать.
    if (backends.shm) {
      await ask(
        'HQ_MCP_MAX_OP_AMOUNT',
        'ceiling on a single money operation, in the billing currency; above it the mutation is refused before a plan is built',
        String(defaults.maxOpAmount),
      );
    }
    if (backends.remna && defaults.maxBulkUsers !== undefined) {
      await ask(
        'HQ_MCP_MAX_BULK_USERS',
        'ceiling on how many clients ONE bulk panel operation may touch',
        String(defaults.maxBulkUsers),
      );
    }
  }

  if (
    await confirm(
      ctx.io,
      '\nConfigure the ssh tunnel that abuse_report and sql_query need? (they stay visible and refuse with the exact command without it)',
      false,
    )
  ) {
    await ask('HQ_MCP_TUNNEL_HOST', 'the local address the tunnel forwards to', defaults.tunnelHost);
    await ask('HQ_MCP_TUNNEL_ABUSE_URL', 'the forwarded anti-abuse hook', defaults.tunnelAbuseUrl);
    await ask(
      'HQ_MCP_GUARD_HOOK_TOKEN',
      'the shared secret the hook checks (X-Guard-Token); without it every call gets 403 and the tool blames the tunnel',
      '',
      { secret: true, optional: true, maskWith: maskSecret },
    );
    await ask('HQ_MCP_TUNNEL_PG_PORT', 'the forwarded PostgreSQL port', String(defaults.tunnelPgPort));
    await ask(
      'HQ_MCP_TUNNEL_MYSQL_PORT',
      'the forwarded MySQL port, if you forward one — SHM does not publish 3306 at all',
      '',
      { optional: true },
    );
    await ask(
      'HQ_MCP_TUNNEL_SSH',
      'the command printed verbatim when a tunnel is closed, so it can be copied',
      defaults.tunnelSsh,
    );
  }

  return picked;
}
