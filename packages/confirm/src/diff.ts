import { redactField } from '@hq/redact';
import type { Profile } from '@hq/types';

export interface DiffEntry {
  path: string;
  /** Значение «до», уже замаскированное по имени поля (см. `redactDiff`). */
  from: unknown;
  /** Значение «после», замаскированное так же. Тело записи берётся НЕ отсюда. */
  to: unknown;
}

/** Метка вместо значения, на которое сослались по кругу: `redact` пишет ровно её. */
const CIRCULAR = '<circular>';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkFlat(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
  seen: Set<object>,
): void {
  // Date — объект без собственных ключей: без этой ветки он разложился бы в НОЛЬ
  // путей и изменение даты пропало бы из diff молча.
  if (!isPlainObject(value) || value instanceof Date) {
    out.set(prefix || '$', value);
    return;
  }
  // seen — стек ТЕКУЩЕЙ ветки, как в @hq/redact: один и тот же объект в двух
  // разных ветках (обычный DAG) циклом не является.
  if (seen.has(value)) {
    out.set(prefix || '$', CIRCULAR);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    // Пустой объект — лист, но только если он не корень: '$' у корня добавил бы
    // в diff строку, за которой нет ни одного поля.
    if (prefix) out.set(prefix, value);
    return;
  }
  seen.add(value);
  try {
    for (const key of keys) {
      walkFlat(value[key], prefix ? `${prefix}.${key}` : key, out, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Раскладывает объект в плоскую карту dot-путей. Массивы считаются листьями:
 * сравнивать позиции хостов/устройств поэлементно бессмысленно, оператору нужен
 * факт «список изменился», а полный снапшот всё равно лежит в плане.
 *
 * Ключи попадают только в Map — присвоение в объект дало бы буквальному ключу
 * `__proto__` из ответа бэкенда шанс подменить прототип результата.
 */
export function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  walkFlat(value, prefix, out, new Set<object>());
  return out;
}

/**
 * Сравнение значений одного пути. `undefined` сравнивается ТОЛЬКО с самим собой:
 * `JSON.stringify(undefined)` — это `undefined`, а не строка, и без отдельной
 * ветки «отсутствующее» слилось бы с функцией или с `null`.
 */
function sameValue(from: unknown, to: unknown): boolean {
  if (from === undefined || to === undefined) return from === to;
  if (Object.is(from, to)) return true;
  // Порядок ключей внутри листа-массива влияет на результат: это даёт ложное
  // «изменилось», но никогда не даёт ложного «не изменилось» — а тихо
  // потерянная строка здесь дороже лишней.
  return JSON.stringify(from) === JSON.stringify(to);
}

/**
 * Маскирует значение по ВСЕМ сегментам пути, а не только по последнему.
 *
 * `redact` вырезает целиком поддерево под секретным ключом: `{apiToken: {value}}`
 * уходит наружу как `apiToken: '<redacted>'`. Путь `apiToken.value` кончается на
 * безобидное `value`, и проверка одного последнего сегмента показала бы тот же
 * секрет открытым текстом рядом с замаскированным снапшотом. Прогон по цепочке
 * повторяет поведение `redact` один в один: сработал любой предок — значение
 * замаскировано.
 *
 * `null` и `undefined` не трогаются: прятать в них нечего, а `'<redacted>'`
 * вместо `undefined` соврал бы, что поле существовало (и наоборот — что
 * очистка поля чем-то заполняет его).
 */
function maskByPath(path: string, value: unknown, profile: Profile): unknown {
  if (value === null || value === undefined) return value;
  // Явный `unknown`: после проверки выше TS сузил бы тип до `{}`, и присвоение
  // результата redactField перестало бы компилироваться.
  let masked: unknown = value;
  for (const segment of path.split('.')) {
    masked = redactField(segment, masked, profile);
  }
  return masked;
}

/**
 * Маскирует значения diff по именам полей, зашитым в `path` (§7.2).
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `redact`. Страховочная редакция `executeTool` маскирует по
 * ИМЕНИ КЛЮЧА, а у `DiffEntry` ключи называются path/from/to — имя изменяемого
 * поля становится значением строки. План `host_edit` без этого прохода вернул
 * бы `{path: 'trojanPassword', from: 'old', to: 'new'}` открытым текстом, тогда
 * как `before`/`after` в том же ответе замаскированы: предохранитель ВЫГЛЯДИТ
 * работающим.
 *
 * ЗВАТЬ ОБЯЗАТЕЛЬНО НА РУЧНЫХ diff. `buildDiff` зовёт эту функцию сам, но
 * мутатор, собравший строки руками, обязан прогнать их здесь перед возвратом —
 * иначе дыра открывается ровно в прежнем виде (тест-контроль в
 * `diff.exec.test.ts` показывает это на живом `executeTool`).
 */
export function redactDiff(entries: readonly DiffEntry[], profile: Profile): DiffEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    from: maskByPath(entry.path, entry.from, profile),
    to: maskByPath(entry.path, entry.to, profile),
  }));
}

/**
 * Список изменений между снимком «до» и целевым состоянием. Пустой список =
 * мутация ничего не меняет.
 *
 * `profile` обязателен, а не «по умолчанию»: diff уходит в контекст модели, и
 * решение о маскировании должно приниматься на каждом вызове, а не забываться
 * молча. Значения в результате УЖЕ замаскированы — diff годится только для
 * показа оператору. Тело записи и откат берутся из `after`/`rollback` плана,
 * которые лежат на диске нетронутыми; собрать запрос из diff — значит отправить
 * в панель `'<redacted>'` и уничтожить учётку клиента.
 *
 * Сравнение идёт по СЫРЫМ значениям и отдельно по наличию ключа:
 *  - маскировать до сравнения нельзя — два разных пароля дали бы одинаковый
 *    `'<redacted>'`, строка исчезла бы, и оператор подтвердил бы пустой план;
 *  - `from ?? null` против `to ?? null` схлопывает «ключа не было» и «ключ стал
 *    null»: снапшот поля не вернул, мутатор ставит `description: null`, обе
 *    стороны дают "null", diff пуст — а запись поле стирает.
 */
export function buildDiff(before: unknown, after: unknown, profile: Profile): DiffEntry[] {
  const left = flatten(before);
  const right = flatten(after);
  const paths = new Set<string>([...left.keys(), ...right.keys()]);
  const entries: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const onBothSides = left.has(path) && right.has(path);
    const from = left.get(path);
    const to = right.get(path);
    if (onBothSides && sameValue(from, to)) continue;
    entries.push({ path, from, to });
  }
  return redactDiff(entries, profile);
}
