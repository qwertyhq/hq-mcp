import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Access, Profile } from '@hq/types';

/**
 * Исход попытки (§7.5).
 *
 * `applying` — не украшение, а единственная запись, которая существует В МОМЕНТ
 * обращения к бэкенду. Журнал, который пишется только ПОСЛЕ вызова, не способен
 * объяснить процесс, умерший на середине: план к этому времени уже удалён
 * (`confirm.take` сносит файл до применения), в журнале осталось `planned`, а
 * деньги ушли. Незакрытая `applying` без пары — сигнал, что смотреть должен
 * человек; найти такие строки помогает `unclosedAttempts`.
 */
export type AuditOutcome = 'planned' | 'applying' | 'applied' | 'failed' | 'rejected';

export type AuditSystem = 'shm' | 'remna';

/** Кого правили. Без этого «что делали клиенту 3073» ищется грепом по input. */
export interface AuditTarget {
  system: AuditSystem;
  id: string | number;
}

export interface AuditRecord {
  /** uuid. Не `${ms}-${seq}`: seq обнуляется рестартом и совпадает у двух процессов. */
  id: string;
  /** Номер записи В ЭТОМ экземпляре журнала. Поле, а не идентификатор. */
  seq: number;
  at: string;
  tool: string;
  profile: Profile;
  mode: Access;
  outcome: AuditOutcome;
  input: unknown;
  before: unknown;
  after: unknown;
  /** Токен плана: единственное, что связывает `applied` с его `planned`. */
  token?: string;
  /** `id` записи `applying`, которую закрывает эта строка. */
  attempt?: string;
  target?: AuditTarget;
  /** `METHOD /path`: на `applying` — что собираемся звать, на терминальной — что позвали. */
  calls?: string[];
  result?: unknown;
  error?: string;
}

/**
 * Вход `write`. Отличается от `AuditRecord` только тем, что необязательные поля
 * принимают явный `undefined`: писателю не нужно городить условный спред ради
 * поля, которого в этом исходе не бывает.
 */
export interface AuditEntry {
  tool: string;
  profile: Profile;
  mode: Access;
  outcome: AuditOutcome;
  input: unknown;
  before: unknown;
  after: unknown;
  token?: string | undefined;
  attempt?: string | undefined;
  target?: AuditTarget | undefined;
  calls?: readonly string[] | undefined;
  result?: unknown;
  error?: string | undefined;
}

export interface AuditQuery {
  tool?: string | undefined;
  token?: string | undefined;
  /** Каждое заданное поле должно совпасть; `id` сравнивается как строка. */
  target?: { system?: AuditSystem | undefined; id?: string | number | undefined } | undefined;
  /** Включительно: `rec.at >= since`. */
  since?: string | undefined;
  limit?: number | undefined;
}

export interface AuditSearchResult {
  /** Свежие первыми — в порядке файла, развёрнутом задом наперёд. */
  records: AuditRecord[];
  /**
   * Сколько строк прочитать не удалось. Молчаливое `continue` на битой строке
   * показывает оператору журнал без следа потери — а потеря реальна: файл
   * общий у stdio и http, запись несёт снимки в килобайтах, и на аварии
   * процесса последняя строка остаётся оборванной.
   */
  corrupt: number;
}

export interface AuditLog {
  write(entry: AuditEntry): Promise<AuditRecord>;
  search(query?: AuditQuery): Promise<AuditSearchResult>;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

export interface AuditDeps {
  now?: () => Date;
  /** Порог ротации в байтах. */
  maxBytes?: number;
}

/** 8 МиБ ≈ тысячи мутаций со снимками; ротация редка, чтение всего файла дёшево. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_LIMIT = 50;
/** Каталог и файл держат сырые `trojanPassword`, `vlessUuid` и почты (§1.5). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Строка журнала → запись. Проверяются только опорные поля: строка без `id`,
 * `at`, `tool` или `outcome` — это не запись, и выдавать её за таковую хуже,
 * чем посчитать нечитаемой. `outcome` НЕ сверяется с перечислением: писатель
 * новее читателя — не повод терять строку.
 */
function toRecord(value: unknown): AuditRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<AuditRecord>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.at !== 'string' ||
    typeof candidate.tool !== 'string' ||
    typeof candidate.outcome !== 'string'
  ) {
    return null;
  }
  return candidate as AuditRecord;
}

function matches(rec: AuditRecord, query: AuditQuery): boolean {
  if (query.tool !== undefined && rec.tool !== query.tool) return false;
  if (query.token !== undefined && rec.token !== query.token) return false;
  if (query.since !== undefined && rec.at < query.since) return false;
  if (query.target !== undefined) {
    const { system, id } = query.target;
    if (system !== undefined && rec.target?.system !== system) return false;
    // Число из SHM и строка из ввода инструмента — один и тот же клиент.
    if (id !== undefined && String(rec.target?.id ?? '') !== String(id)) return false;
  }
  return true;
}

/**
 * Записи `applying`, к которым не пришла терминальная пара. Считает по тому
 * окну, которое ей дали: `search` с маленьким `limit` обрежет пару и покажет
 * ложную «незакрытую» строку — для проверки берите весь журнал.
 */
export function unclosedAttempts(records: readonly AuditRecord[]): AuditRecord[] {
  const closed = new Set<string>();
  for (const rec of records) {
    if (rec.attempt !== undefined) closed.add(rec.attempt);
  }
  return records.filter((rec) => rec.outcome === 'applying' && !closed.has(rec.id));
}

/**
 * Журнал мутаций (§7.5). Пишется ДО и ПОСЛЕ выполнения, включая провалы и
 * отказы. Формат JSONL: одна попытка — одна строка.
 *
 * Файл общий: его делят stdio и http, а путь по умолчанию — на каждый cwd свой.
 * Поэтому запись идёт одним `write(2)` в дескриптор, открытый на `O_APPEND`, с
 * проверкой числа байт: `appendFile` выше PIPE_BUF рвётся, а порванная строка
 * теряется беззвучно. Внутри процесса записи выстроены в очередь — так `seq`
 * монотонен и два больших снимка не лезут в один дескриптор одновременно.
 */
export function createAuditLog(path: string, deps: AuditDeps = {}): AuditLog {
  const now = deps.now ?? ((): Date => new Date());
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /** Ставит задачу в хвост очереди; провал предыдущей записи её не рвёт. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Ротация по размеру: журнал живёт рядом с рабочей копией, и файл, растущий
   * без предела, однажды кладёт диск. Старое НЕ удаляется — автоматически
   * стирать улики хуже, чем занимать место; прибирает оператор.
   *
   * Ошибка ротации проглатывается намеренно: не сумев переименовать файл, мы
   * всё равно обязаны дописать запись. Потерять строку хуже, чем перерасти
   * порог, а гонка двух процессов заканчивается лишним мелким файлом.
   */
  const rotateIfFull = async (bytes: number): Promise<void> => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size === 0 || size + bytes <= maxBytes) return;
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    try {
      await rename(path, `${path}.${stamp}-${randomUUID().slice(0, 8)}`);
    } catch {
      /* см. докстринг: запись важнее ротации */
    }
  };

  const append = async (line: string): Promise<void> => {
    const bytes = Buffer.byteLength(line, 'utf8');
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await rotateIfFull(bytes);
    const handle = await open(path, 'a', FILE_MODE);
    try {
      const { bytesWritten } = await handle.write(line, null, 'utf8');
      if (bytesWritten !== bytes) {
        throw new AuditError(
          `audit: запись в ${path} оборвалась на ${String(bytesWritten)} байте из ${String(bytes)} — строка журнала неполна`,
        );
      }
    } finally {
      await handle.close();
    }
  };

  return {
    async write(input: AuditEntry): Promise<AuditRecord> {
      return enqueue(async () => {
        const at = now();
        seq += 1;
        const rec: AuditRecord = {
          id: randomUUID(),
          seq,
          at: at.toISOString(),
          tool: input.tool,
          profile: input.profile,
          mode: input.mode,
          outcome: input.outcome,
          input: input.input,
          before: input.before,
          after: input.after,
          ...(input.token === undefined ? {} : { token: input.token }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.calls === undefined ? {} : { calls: [...input.calls] }),
          ...(input.result === undefined ? {} : { result: input.result }),
          ...(input.error === undefined ? {} : { error: input.error }),
        };
        await append(`${JSON.stringify(rec)}\n`);
        return rec;
      });
    },

    async search(query: AuditQuery = {}): Promise<AuditSearchResult> {
      const limit = Math.max(0, Math.trunc(query.limit ?? DEFAULT_LIMIT));
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error: unknown) {
        // Нет файла — пустой журнал. Всё остальное (нет прав, каталог вместо
        // файла) — авария чтения, и молчать о ней нельзя.
        if (isErrno(error, 'ENOENT')) return { records: [], corrupt: 0 };
        throw error;
      }

      let corrupt = 0;
      const found: AuditRecord[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          corrupt += 1;
          continue;
        }
        const rec = toRecord(parsed);
        if (rec === null) {
          corrupt += 1;
          continue;
        }
        if (!matches(rec, query)) continue;
        found.push(rec);
      }
      // Разворот по порядку файла, а не по `at`: у двух процессов на общем файле
      // штампы идут вперемешку, а порядок записи — единственный, который был.
      found.reverse();
      return { records: found.slice(0, limit), corrupt };
    },
  };
}
