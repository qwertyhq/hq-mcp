import type { Profile } from '@hq/types';
import { scrubSecretShapes } from './shapes.js';

export const REDACTED = '<redacted>';

/** Креды подключения: режутся всегда, в обоих профилях (§7.2, §6.13). */
export const CREDENTIAL_KEYS: readonly string[] = [
  'trojanPassword',
  'ssPassword',
  'vlessUuid',
  'links',
  'ssConfLinks',
  'cryptoLink',
  'connectionKeys',
  'rawInbound',
];

/** Секреты платформы: маскируются по имени поля (§7.2). */
export const SECRET_KEY_RE = /token|secret|key|password|auth/i;

/**
 * ИМЕНА, КОТОРЫЕ `SECRET_KEY_RE` ЛОВИТ ПО ОШИБКЕ. Закрытый список, и каждое
 * имя в нём — НАСТОЯЩЕЕ, съеденное на работающей системе:
 *
 *  - `showConnectionKeys`  — булев переключатель страницы подписки (панель);
 *  - `svgLibraryKeys`      — имена иконок в библиотеке страницы подписки;
 *  - `translationKeys`     — имена строк перевода;
 *  - `changedKeys`         — имена полей, которые изменились в конфиге ноды.
 *
 * Ни одно не несёт ключевого материала: все четыре — это ИМЕНА ключей или
 * переключатель. Маска на них не защищает ничего и гасит ровно то поле, ради
 * которого инструмент писали. Обходили это переименованием у каждого
 * инструмента (`showConnectionCreds`, `translationCount`, `changedSections`) —
 * то есть каждый следующий такой ключ снова доезжал бы до вызывающего маркером.
 *
 * Список не отменяет проверку кредов: `CREDENTIAL_KEY_SET` сверяется РАНЬШЕ,
 * поэтому `connectionKeys` (тоже кончается на Keys, но это ссылки подключения)
 * маскируется по-прежнему. И имя из этого списка не делает значение
 * доверенным: оно всё равно обходится и чистится по форме.
 */
export const SAFE_KEYS: readonly string[] = [
  'showConnectionKeys',
  'svgLibraryKeys',
  'translationKeys',
  'changedKeys',
];

/** Ссылка подписки: human — хвост маскируется, bot — запрет. */
export const TAIL_MASK_KEYS: readonly string[] = [
  'subscriptionUrl',
  'shortUuid',
  'happLink',
  'subscriptionRequestUrl',
];

/** PII: массивами такое уезжать боту не должно. */
const PII_KEYS: readonly string[] = [
  'email',
  'login2',
  'phone',
  'full_name',
  'fullName',
  'ip',
  'lastIp',
  'userAgent',
  'user_agent',
  'subLastUserAgent',
];

/**
 * Ключи бэкендов не гарантируют единый регистр или разделитель
 * (subscriptionUrl / subscriptionURL / subscription_url — один и тот же
 * смысл). Сравнение по спискам идёт по нормализованной форме: нижний
 * регистр без `_`/`-`. `SECRET_KEY_RE` уже регистронезависима сама по себе,
 * поэтому её не трогаем.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function toNormalizedSet(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeKey));
}

const CREDENTIAL_KEY_SET = toNormalizedSet(CREDENTIAL_KEYS);
const TAIL_MASK_KEY_SET = toNormalizedSet(TAIL_MASK_KEYS);
const PII_KEY_SET = toNormalizedSet(PII_KEYS);
const SAFE_KEY_SET = toNormalizedSet(SAFE_KEYS);

/**
 * Маскирует хвост значения, оставляя первые `keep` символов.
 * Для ссылки подписки это оставляет домен и режет секретную часть пути.
 */
export function maskTail(value: string, keep = 6): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.length <= keep) return '*'.repeat(value.length);
  return value.slice(0, keep) + '*'.repeat(Math.min(value.length - keep, 8));
}

function maskByKey(
  key: string,
  value: unknown,
  profile: Profile,
  seen: Set<object>,
): unknown {
  const normalized = normalizeKey(key);
  if (CREDENTIAL_KEY_SET.has(normalized)) return REDACTED;
  if (!SAFE_KEY_SET.has(normalized) && SECRET_KEY_RE.test(key)) return REDACTED;
  if (TAIL_MASK_KEY_SET.has(normalized)) {
    if (profile === 'bot') return REDACTED;
    return typeof value === 'string' ? maskTail(value, 24) : REDACTED;
  }
  if (profile === 'bot' && PII_KEY_SET.has(normalized)) return REDACTED;
  return walk(value, profile, seen);
}

function walk(value: unknown, profile: Profile, seen: Set<object>): unknown {
  // ВТОРАЯ ПОЛОВИНА МЕХАНИЗМА, И ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ОНА ЖИВЁТ.
  //
  // Всё правило выше — про ИМЯ поля, и по построению слепо к секрету внутри
  // ЗНАЧЕНИЯ. Это уже стоило трёх утечек одного класса за один день: токен
  // бота в `response.request.url` строки спула, он же в колонке `host` строк
  // серверов SHM, креденшлы голыми подстроками в телах шаблонов. Чинили
  // по одной, у своего инструмента, — то есть класс оставался открытым для
  // всех остальных, включая ещё не написанные.
  //
  // Проход стоит здесь, потому что `redact` зовут ВСЕ трое: клиент @hq/shm,
  // клиент @hq/remna и исполнитель `executeTool` на выходе. Одна правка
  // закрывает вход и выход разом, и ни один инструмент не обязан помнить.
  //
  // `opaqueRuns: false` — не экономия, а граница компетенции правила: порог
  // непрозрачного прогона откалиброван на телах шаблонов, а не на ответах
  // панели, где его перешагивают data-URI иконок и hex платежа `uniq_id`.
  // Полный набор остаётся у того, кто читает текстовый блоб (`template_read`).
  if (typeof value === 'string') return scrubSecretShapes(value, { opaqueRuns: false }).text;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  // seen — это стек ТЕКУЩЕЙ ветки, а не множество всех виденных объектов.
  // Иначе повторная ссылка на один и тот же объект в разных ветках (обычный
  // DAG, а не цикл) со второго раза превратилась бы в '<circular>'.
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, profile, seen));
    // Object.create(null) — не {}: обычный литерал наследует
    // Object.prototype, а его `__proto__` — не данные, а accessor-свойство.
    // Присвоение out['__proto__'] = ... на {} подменяет [[Prototype]] самого
    // out вместо создания собственного поля, если во входном payload (напр.
    // из JSON.parse) есть буквальный ключ "__proto__". На объекте без
    // Object.prototype в цепочке такого accessor'а нет, и присвоение
    // становится обычным собственным свойством.
    const out = Object.create(null) as unknown as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskByKey(key, item, profile, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Рекурсивно маскирует креды, ссылки подписки, секреты платформы и (для профиля bot) PII.
 * Идемпотентна: повторный проход по уже отредактированному значению ничего не ломает.
 */
export function redact<T>(value: T, profile: Profile): T {
  return walk(value, profile, new Set<object>()) as T;
}

/**
 * Те же правила, но для ОДНОГО значения, имя которого лежит не в ключе объекта,
 * а рядом. Нужна там, где `redact` бессильна по построению: у `DiffEntry`
 * ключи называются path/from/to, а имя изменяемого поля — ЗНАЧЕНИЕ строки
 * `path`, и ни одно правило на него не смотрит (`@hq/confirm`, находка 2.1).
 *
 * Экспортируется вместо копии сопоставления на той стороне СОЗНАТЕЛЬНО: два
 * матчера, разъехавшиеся на одном новом ключе, хуже одного — второй продолжает
 * ВЫГЛЯДЕТЬ работающим. Имя нормализуется и сверяется ровно теми же списками;
 * если имя безобидно, значение всё равно обходится `walk`, поэтому кред,
 * лежащий ВНУТРИ значения, тоже маскируется.
 */
export function redactField(fieldName: string, value: unknown, profile: Profile): unknown {
  return maskByKey(fieldName, value, profile, new Set<object>());
}

/**
 * Редакция по ФОРМЕ значения — для текстовых блобов, где секрет не является
 * значением поля и по имени невидим (тело шаблона SHM, url строки спула).
 * Живёт в этом пакете, а не рядом с инструментом: «как выглядит секрет» — то
 * же знание, которым `scripts/no-secrets.test.ts` не пускает секрет в коммит,
 * и второй копии у него быть не должно.
 */
export {
  ALL_PLACEHOLDER_SEGMENTS_RE,
  ASSIGNED_MASK,
  ASSIGNED_SECRET_RE,
  BARE_BOT_TOKEN_RE,
  BOT_API_TOKEN_RE,
  BOT_TOKEN_MASK,
  JWT_MASK,
  JWT_RE,
  OPAQUE_MASK,
  PLACEHOLDER_RE,
  REGEX_LITERAL_RE,
  URL_CREDENTIALS_MASK,
  URL_CREDENTIALS_RE,
  scrubSecretShapes,
  scrubSecretShapesDeep,
} from './shapes.js';
export type { ScrubOptions, ScrubResult, SecretShapeHit } from './shapes.js';
