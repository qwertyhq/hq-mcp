import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProfile } from '@hq/types';
import type { Profile } from '@hq/types';
import type { DiffEntry } from './diff.js';

export type { DiffEntry } from './diff.js';
export { buildDiff, flatten, redactDiff } from './diff.js';

export interface PlanRollback {
  method: string;
  path: string;
  body: unknown;
}

export interface MutationPlan {
  token: string;
  tool: string;
  /** Профиль, который построил план. Применить его может только он же (К8, §4.2). */
  profile: Profile;
  createdAt: string;
  expiresAt: string;
  /**
   * `hashInput` от аргументов, которыми план построен. Применение с другими
   * аргументами — отказ: иначе план, собранный для `{value: 7}`, применяется
   * вызовом `{value: 999}`, а в журнал уезжает вход 999 рядом со снимками от 7.
   */
  inputHash: string;
  /**
   * Ключ идемпотентности бэкенда, вычисленный ОДИН раз на этапе плана (§7.4).
   * Его смысл именно в том, что он не пересчитывается: ключ, посчитанный заново
   * на каждой попытке, разъезжается между ретраями и оплачивает операцию дважды.
   */
  idempotencyKey?: string;
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
  sideEffects: string[];
  rollback?: PlanRollback;
}

/**
 * Вход `put`. Отличается от плана тем, что токен, штампы времени и разрешённый
 * ключ идемпотентности проставляет хранилище. Необязательные поля принимают
 * явный `undefined`, чтобы мутатору не городить условный спред.
 */
export interface MutationDraft {
  tool: string;
  profile: Profile;
  inputHash: string;
  /**
   * Строка — или функция от токена: канонический ключ SHM выглядит как
   * `hq:${op}:${userId}:${token}`, а токен рождается внутри `put`. Без функции
   * ключ пришлось бы досчитывать на применении — ровно тот пересчёт, от
   * которого поле и заведено.
   */
  idempotencyKey?: string | ((token: string) => string) | undefined;
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
  sideEffects: string[];
  rollback?: PlanRollback | undefined;
}

export interface ConfirmStore {
  put(draft: MutationDraft): Promise<MutationPlan>;
  /**
   * Читает план, НЕ забирая его. Существует ровно для одного вызывающего и ровно
   * для одной беды.
   *
   * `ops_confirm` диспетчеризует ПО `plan.tool`: он видит только токен, поэтому
   * узнать имя инструмента может лишь из самого плана — и передать `expectedTool`
   * в `take` не может по построению (для этого `take` и принимает `null`). Но
   * собственные проверки у него всё-таки есть: виден ли `plan.tool` текущему
   * профилю, зарегистрирован ли он в этой сборке вообще. Выполненные ПОСЛЕ
   * `take`, они сжигают план, который был совершенно исправен: снимок к этому
   * моменту уже удалён, и человеку остаётся строить его заново — притом что
   * отказал не план, а конфигурация сервера. `peek` даёт провести их ДО захвата.
   *
   * ЧЕГО `peek` НЕ ДЕЛАЕТ И ЧЕМ НЕ ЯВЛЯЕТСЯ. Он не проверяет ни профиль, ни срок
   * жизни, ни отпечаток аргументов и НЕ даёт права применить план: одноразовость
   * держится атомарным `rename` внутри `take`, и она там и остаётся. Между `peek`
   * и `take` план может забрать соседний вызов — тогда `take` честно ответит
   * `in_flight`/`not_found`, потому что решает захват, а не предварительное
   * чтение. Применять то, что вернул `peek`, нельзя: это копия снимка, а не
   * захваченный план.
   */
  peek(token: string): Promise<MutationPlan>;
  /**
   * Забирает план под применение. Одноразовость держится не удалением файла, а
   * атомарным переименованием: побеждает ровно один вызов, остальные получают
   * ENOENT. Все проверки идут ПОСЛЕ захвата, и на любом отказе план кладётся
   * обратно — чужой (протухший, не тот инструмент, не те аргументы) вызов не
   * сжигает план, но и не может применить его вторым.
   *
   * `expectedTool` — имя инструмента, который применяет план, или `null` для
   * вызывающего, который диспетчеризует ПО `plan.tool` (`ops_confirm`: он видит
   * только токен). `null` пишется руками — забыть параметр нельзя.
   *
   * `inputHash` — `hashInput` от аргументов текущего вызова, или `null` там, где
   * аргументов нет вовсе (тот же `ops_confirm`).
   */
  take(
    token: string,
    profile: Profile,
    expectedTool: string | null,
    inputHash: string | null,
  ): Promise<MutationPlan>;
}

export type ConfirmErrorCode =
  | 'bad_token'
  | 'not_found'
  | 'in_flight'
  | 'corrupt'
  | 'foreign_profile'
  | 'foreign_tool'
  | 'input_mismatch'
  | 'expired'
  | 'rejected';

export class ConfirmError extends Error {
  readonly code: ConfirmErrorCode;

  constructor(message: string, code: ConfirmErrorCode = 'rejected') {
    super(message);
    this.name = 'ConfirmError';
    this.code = code;
  }
}

/** 10 минут (§7.3): столько живёт снимок «до», по которому строится откат. */
const DEFAULT_TTL_MS = 600_000;
/** Снимки держат сырые `trojanPassword`, `vlessUuid` и почты (§1.5, §7.2). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/**
 * Через сколько TTL подметается брошенный снимок. С запасом: протухший план —
 * это улика («что человек собирался сделать»), и стирать её сразу хуже, чем
 * подержать лишний час.
 */
const SWEEP_FACTOR = 10;

/** Строгий нижний регистр: он же закрывает выход из каталога через токен. */
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Своё и только своё: посторонние файлы в каталоге снимков не наши. */
const SWEEPABLE_RE = /\.json(\.taken|\.tmp-[0-9a-f-]+)?$/;

/** Имена, под которыми ходит сам токен плана: в хеш входа они не идут. */
const PLAN_ID_FIELDS = new Set(['confirm_token', 'plan_id']);

const CIRCULAR = '"<circular>"';

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON с ключами в стабильном порядке. `undefined` в объекте не отличается от
 * отсутствия ключа (иначе `{a:1}` и `{a:1, b:undefined}` дали бы разные хеши, а
 * zod отдаёт то одно, то другое), в массиве становится `null` — как в JSON.
 */
function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === undefined) return 'null';
  // JSON.stringify на BigInt БРОСАЕТ. Хеш входа считается на каждой мутации, и
  // падать на нём из-за экзотического литерала — хуже, чем сериализовать его.
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (value instanceof Date) return JSON.stringify(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    }
    const source = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Отпечаток аргументов вызова (§7.3). Считается ОДИНАКОВО на построении плана и
 * на его применении — только так расхождение вообще заметно.
 *
 * `confirm_token`/`plan_id` верхнего уровня выбрасываются: на построении их нет,
 * на применении есть, и без этого хеш не совпал бы никогда. Вложенное поле с тем
 * же именем — обычный аргумент и остаётся в хеше.
 */
export function hashInput(input: unknown): string {
  const stripped = isPlainObject(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => !PLAN_ID_FIELDS.has(key)))
    : input;
  return createHash('sha256').update(canonicalJson(stripped, new Set<object>())).digest('hex');
}

/**
 * Разбор снимка с диска. Файл могли оборвать на середине записи, дописать руками
 * или скопировать под чужим именем — во всех случаях это `ConfirmError`, а не
 * `SyntaxError` из недр `JSON.parse` и не «свежий план» с датой, которую не
 * разобрать (сравнение с `NaN` ложно, и такой файл применялся бы вечно).
 */
function parsePlan(raw: string, token: string): MutationPlan {
  const broken = (why: string): ConfirmError =>
    new ConfirmError(
      `план ${token} повреждён (${why}): применить его нельзя, постройте новый. Файл снимка остаётся на диске для разбора`,
      'corrupt',
    );

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw broken('файл не разбирается как JSON');
  }
  if (!isPlainObject(value)) throw broken('в файле не объект');

  const candidate = value as Partial<MutationPlan>;
  if (candidate.token !== token) throw broken('токен внутри файла не совпадает с именем файла');
  if (typeof candidate.tool !== 'string' || candidate.tool === '') throw broken('нет имени инструмента');
  if (!isProfile(candidate.profile)) throw broken('нет профиля-создателя');
  if (typeof candidate.inputHash !== 'string' || candidate.inputHash === '') {
    throw broken('нет отпечатка аргументов');
  }
  if (typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))) {
    throw broken('срок жизни не разбирается как дата');
  }
  return candidate as MutationPlan;
}

/**
 * Хранилище планов мутаций (§7.3). План — это снимок «до», целевое состояние,
 * diff, побочные эффекты и данные отката. Он и есть основание отката: у
 * Remnawave dry-run нет вовсе, у SHM он частичный, поэтому предпросмотр
 * эмулируется снимком.
 *
 * Каталог общий: его делят stdio и http через один `HQ_MCP_SNAPSHOT_DIR`, а MCP
 * SDK обрабатывает `tools/call` конкурентно — ничто не выстраивает вызовы в
 * очередь. Поэтому одноразовость плана держится атомарным `rename`, а не парой
 * «прочитали — удалили»: между `readFile` и `rm` два `await`, и два вызова с
 * одним токеном оба доходили бы до применения. Для денежной ручки это второе
 * списание.
 */
export function createConfirmStore(
  dir: string,
  deps: { ttlMs?: number; now?: () => Date } = {},
): ConfirmStore {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? ((): Date => new Date());

  const planPath = (token: string): string => join(dir, `${token}.json`);

  /**
   * Уборка брошенного: протухшие планы, захваты процесса, умершего на
   * применении, и обрывки временных файлов. Возраст берётся по mtime, а не по
   * `createdAt` внутри: у обрывка внутренностей нет, а подметать надо и его.
   */
  const sweep = async (): Promise<void> => {
    const cutoff = now().getTime() - ttlMs * SWEEP_FACTOR;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (name) => {
        if (!SWEEPABLE_RE.test(name)) return;
        const file = join(dir, name);
        try {
          if ((await stat(file)).mtimeMs > cutoff) return;
          await rm(file, { force: true });
        } catch {
          /* гонка с соседним процессом: он подмёл — и хорошо */
        }
      }),
    );
  };

  return {
    async put(draft: MutationDraft): Promise<MutationPlan> {
      if (draft.tool === '') {
        throw new ConfirmError('план без имени инструмента применить будет нечем', 'rejected');
      }
      const createdAt = now();
      const token = randomUUID();
      const key =
        typeof draft.idempotencyKey === 'function'
          ? draft.idempotencyKey(token)
          : draft.idempotencyKey;
      const plan: MutationPlan = {
        token,
        tool: draft.tool,
        profile: draft.profile,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
        inputHash: draft.inputHash,
        ...(key === undefined ? {} : { idempotencyKey: key }),
        before: draft.before,
        after: draft.after,
        diff: draft.diff,
        sideEffects: draft.sideEffects,
        ...(draft.rollback === undefined ? {} : { rollback: draft.rollback }),
      };

      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      // Уборка до записи и без права уронить её: не подмести — мусор, не
      // записать план — инструмент, который молча ничего не может.
      try {
        await sweep();
      } catch {
        /* см. выше */
      }
      // Запись под временным именем и `rename`: авария на середине оставляет
      // обрывок, который никто не прочитает как план, а не полуплан под
      // настоящим именем. `.tmp-` не совпадает с именем токена, поэтому `take`
      // его не видит.
      const file = planPath(token);
      const temp = `${file}.tmp-${randomUUID()}`;
      await writeFile(temp, JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: FILE_MODE });
      await rename(temp, file);
      return plan;
    },

    async peek(token: string): Promise<MutationPlan> {
      if (!TOKEN_RE.test(token)) {
        throw new ConfirmError('plan_id имеет неверный формат (ожидается uuid плана)', 'bad_token');
      }
      const file = planPath(token);
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error: unknown) {
        // ENOENT — единственный случай, который что-то говорит о плане; всё
        // остальное (нет прав на общий каталог, каталог вместо файла) — авария
        // чтения, и выдавать её за «плана нет» значит отправить человека
        // строить новый план вместо того, чтобы чинить доступ.
        if (!isErrno(error, 'ENOENT')) {
          const why = error instanceof Error ? error.message : String(error);
          throw new ConfirmError(`план ${token} лежит на диске, но не читается: ${why}`, 'corrupt');
        }
        const inFlight = await stat(`${file}.taken`).then(
          () => true,
          () => false,
        );
        throw inFlight
          ? new ConfirmError(
              `план ${token} применяется прямо сейчас другим вызовом (или предыдущая попытка умерла на середине). Повторять вслепую нельзя: проверьте журнал мутаций`,
              'in_flight',
            )
          : new ConfirmError('план не найден: токен уже использован или не создавался', 'not_found');
      }
      return parsePlan(raw, token);
    },

    async take(
      token: string,
      profile: Profile,
      expectedTool: string | null,
      inputHash: string | null,
    ): Promise<MutationPlan> {
      if (!TOKEN_RE.test(token)) {
        throw new ConfirmError(
          'confirm_token имеет неверный формат (ожидается uuid плана)',
          'bad_token',
        );
      }
      const file = planPath(token);
      const claimed = `${file}.taken`;

      // ЗАХВАТ. Атомарен на уровне ядра: из двадцати одновременных вызовов
      // переименование удаётся ровно одному, остальные получают ENOENT.
      try {
        await rename(file, claimed);
      } catch (error: unknown) {
        if (!isErrno(error, 'ENOENT')) throw error;
        const inFlight = await stat(claimed).then(
          () => true,
          () => false,
        );
        throw inFlight
          ? new ConfirmError(
              `план ${token} применяется прямо сейчас другим вызовом (или предыдущая попытка умерла на середине). Повторять вслепую нельзя: проверьте журнал мутаций`,
              'in_flight',
            )
          : new ConfirmError('план не найден: токен уже использован или не создавался', 'not_found');
      }

      try {
        // Снимок захвачен, но может не читаться: каталог общий, и stdio с http
        // вполне ходят под разными пользователями — тогда это EACCES, а не
        // «плана нет». Сырой errno в ответе модели ничего не объясняет.
        let raw: string;
        try {
          raw = await readFile(claimed, 'utf8');
        } catch (error: unknown) {
          const why = error instanceof Error ? error.message : String(error);
          throw new ConfirmError(`план ${token} захвачен, но не читается: ${why}`, 'corrupt');
        }
        const plan = parsePlan(raw, token);

        if (plan.profile !== profile) {
          throw new ConfirmError(
            `план построен профилем ${plan.profile}, а применяется профилем ${profile} — отказ (К8, §4.2). ` +
              'Каталог снимков общий у stdio и http, поэтому чужой план применить нельзя.',
            'foreign_profile',
          );
        }
        if (expectedTool !== null && plan.tool !== expectedTool) {
          throw new ConfirmError(
            `confirm_token принадлежит плану инструмента ${plan.tool}, а вызван ${expectedTool} — отказ`,
            'foreign_tool',
          );
        }
        if (inputHash !== null && plan.inputHash !== inputHash) {
          throw new ConfirmError(
            `план ${plan.tool} построен с другими аргументами: применить его этим вызовом нельзя. ` +
              `Постройте план заново теми аргументами, которые собираетесь применить (§7.3)`,
            'input_mismatch',
          );
        }
        if (new Date(plan.expiresAt).getTime() <= now().getTime()) {
          throw new ConfirmError(
            `план протух (expiresAt=${plan.expiresAt}): постройте новый вызовом ${plan.tool} без confirm_token`,
            'expired',
          );
        }

        // Сгорает только тот план, который действительно уходит в применение.
        // Дальше единственный след попытки — запись `applying` в журнале (§7.5).
        await rm(claimed, { force: true });
        return plan;
      } catch (error: unknown) {
        // ВОЗВРАТ. Отказ не должен стоить плана: чужой вызов, протухший срок или
        // не те аргументы оставляют человека при его плане.
        try {
          await rename(claimed, file);
        } catch {
          /* вернуть не вышло — причина отказа важнее, обрывок подметёт sweep */
        }
        throw error;
      }
    },
  };
}
