import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * СНИМОК «ДО» ДЛЯ ТОГО, ЧТО ПЛАН ПОКАЗАТЬ НЕ МОЖЕТ.
 *
 * Каркас уже хранит `before`/`after` плана на диске нетронутыми, и для всех
 * прочих мутаторов этого хватает: `executeTool` маскирует ответ по ИМЕНИ поля,
 * поэтому сырой `trojanPassword` лежит в снимке и уезжает наружу маркером.
 * Ровно здесь этот механизм не работает, и не по недосмотру, а по форме данных:
 *
 *  - тело шаблона SHM — один большой ТЕКСТ, внутри которого секрет лежит голой
 *    подстрокой (`{{ REMNA_TOKEN = "eyJ…" }}`, 22 файла из 197 в проде).
 *    Имени, по которому его маскировать, у него нет;
 *  - снимок конфигурации клиента (`vpn_mrzb_*`) несёт `subscription_config` —
 *    5944 символа готового конфига в ОДНОЙ строке. `SECRET_KEY_RE` на имени
 *    `subscription_config` не срабатывает, а внутри лежат живые vless-uuid.
 *
 * Положить такое в `before`/`rollback` значит вернуть его модели: `PlanResult`
 * отдаёт оба поля как есть. Поэтому «до» уезжает СЮДА — в файл рядом с
 * журналом мутаций и снимками планов, на тот же диск, с теми же правами (0700
 * на каталог, 0600 на файл), а наружу идёт только ПУТЬ к нему.
 *
 * Второй, не менее важный резон: снимок плана недолговечен. `ConfirmStore.take`
 * переименовывает его в `.taken`, а подметальщик убирает через десять TTL —
 * то есть «откат из плана» перестаёт существовать примерно через час после
 * применения. Файл здесь не подметается никем: откат обязан пережить смену.
 */
export type BackupKind = 'template' | 'storage' | 'host' | 'host_cleanup';

export interface BackupRecord {
  kind: BackupKind;
  /**
   * Адрес объекта, у которого снят снимок: имя шаблона либо `<user_id>:<ключ>`
   * для storage. Сверяется при восстановлении — снимок, приложенный не к тому
   * объекту, это запись чужого содержимого в живую услугу.
   */
  target: string;
  savedAt: string;
  bytes: number;
  sha256: string;
  /** Точное содержимое «до»: строка для шаблона, любое JSON-значение для storage. */
  payload: unknown;
}

/**
 * Каталог снимков. Дефолт повторяет дефолты `@hq/env`
 * (`${cwd}/.hq-mcp/...`) намеренно: `.hq-mcp/` уже перечислен в `.gitignore`
 * именно как «сырые значения, которым нельзя попасть в историю», и второй
 * каталог с той же природой данных, но вне этого правила, однажды уехал бы в
 * публичный коммит.
 */
export function defaultBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HQ_MCP_BACKUP_DIR?.trim();
  if (raw !== undefined && raw !== '') return raw;
  return resolve(process.cwd(), '.hq-mcp', 'backups');
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical UTF-16 order keeps fingerprints independent of the host locale. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * JSON с ОТСОРТИРОВАННЫМИ ключами — иначе сверка мира (§7.4) ловит порядок, а
 * не изменение. Perl рандомизирует порядок ключей хеша на каждый процесс, а
 * `encode_json` печатает их в этом порядке: два одинаковых чтения одного и того
 * же ключа storage, попавшие в разные воркеры SHM, дают разный `JSON.stringify`
 * при полностью одинаковых данных. Гард на таком хеше отвергал бы каждый второй
 * план, и выглядело бы это как «мир уехал».
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(sortDeep(value)) ?? 'undefined';
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareStrings(a, b));
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) out[key] = sortDeep(item);
  return out;
}

/** Имя файла: читаемое человеком, но без единого символа, который мог бы вывести из каталога. */
function fileNameFor(record: BackupRecord): string {
  const safeTarget = record.target.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  const stamp = record.savedAt.replace(/[:.]/g, '-');
  return `${record.kind}-${safeTarget}-${stamp}-${randomBytes(3).toString('hex')}.json`;
}

/**
 * Пишет снимок и возвращает путь к нему. Бросает, если записать не удалось, —
 * и это единственный правильный исход: инвариант обоих инструментов звучит как
 * «записи без снимка не бывает», а снимок, которого не случилось, превращает
 * правку живой логики биллинга в необратимую.
 */
export async function writeBackup(dir: string, record: BackupRecord): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, fileNameFor(record));
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

/**
 * Читает снимок по пути, ПРОВЕРЯЯ три вещи, и каждая закрывает свой отказ:
 *  1. путь не выходит из каталога снимков (в том числе через симлинк —
 *     сравнивается `realpath`): аргумент инструмента приходит от модели, и
 *     «прочитай файл по этому пути» без границы каталога — это чтение любого
 *     файла на машине оператора руками модели;
 *  2. `kind` совпадает: снимок storage, поданный в `template_edit`, записал бы
 *     JSON конфигурации клиента в исполняемый шаблон;
 *  3. `target` совпадает: снимок ДРУГОГО объекта того же вида — это чужое
 *     содержимое в живой услуге, и заметить это по diff уже поздно.
 */
export async function readBackup(
  dir: string,
  path: string,
  expected: { kind: BackupKind; target: string },
): Promise<BackupRecord> {
  const root = await realpath(dir).catch(() => resolve(dir));
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const real = await realpath(candidate).catch(() => candidate);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(
      `restore_from: путь ${path} лежит вне каталога снимков ${root}. Инструмент читает файлы ` +
        'только оттуда: аргумент приходит от модели, и чтение произвольного пути на машине ' +
        'оператора не является частью правки шаблона или storage.',
    );
  }

  let raw: string;
  try {
    raw = await readFile(real, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `restore_from: снимок ${path} не читается: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `restore_from: снимок ${path} повреждён и не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const record = parsed as Partial<BackupRecord>;
  if (record.kind !== expected.kind) {
    throw new Error(
      `restore_from: снимок ${path} снят с объекта вида "${String(record.kind)}", а восстанавливают ` +
        `"${expected.kind}". Содержимое одного вида, записанное в другой, ломает объект молча.`,
    );
  }
  if (record.target !== expected.target) {
    throw new Error(
      `restore_from: снимок ${path} снят с "${String(record.target)}", а восстанавливают в ` +
        `"${expected.target}". Это чужое содержимое: восстановление не сверяет его по diff за вас.`,
    );
  }
  if (typeof record.sha256 !== 'string' || typeof record.savedAt !== 'string') {
    throw new Error(`restore_from: снимок ${path} неполон — нет sha256/savedAt`);
  }
  return record as BackupRecord;
}
