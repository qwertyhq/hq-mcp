/**
 * ЕДИНСТВЕННОЕ место, решающее, в каком виде чувствительное значение попадает
 * на экран. Мастер печатает много: подтверждения, сводку, сообщения об
 * ошибках, — и каждая из этих строк собирается из значений, часть которых
 * секретна. Если бы правило маскирования жило по месту печати, оно бы жило в
 * пяти местах и в одном из них однажды не оказалось.
 */

/** Сколько символов оставить с начала и с конца, чтобы значение можно было опознать. */
const KEEP_HEAD = 3;
const KEEP_TAIL = 3;

/**
 * Ниже этой длины не показываем НИЧЕГО. Короткое значение из трёх начальных и
 * трёх конечных символов восстанавливается перебором, а «сравнить с тем, что у
 * меня записано» человек может и по длине звёздочек.
 */
const MIN_LENGTH_TO_HINT = 12;

/** `eyJhbGciOi…3f9` — узнать своё значение можно, восстановить нельзя. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '(empty)';
  if (trimmed.length < MIN_LENGTH_TO_HINT) return '•'.repeat(8);
  return `${trimmed.slice(0, KEEP_HEAD)}…${trimmed.slice(-KEEP_TAIL)}`;
}

/**
 * SHM_ADMIN_AUTH — это ДВА значения в одной строке, и секретно из них одно.
 *
 * Общая маска показала бы `adm…123`, то есть хвост пароля и ничего полезного о
 * логине. Здесь наоборот: логин целиком (по нему человек и узнаёт запись),
 * пароль — под звёздочками до последнего символа. Готовый заголовок
 * `Basic <base64>` — уже секрет целиком, к нему применяется общая маска.
 */
export function maskAuth(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '(empty)';
  if (/^basic\s+/i.test(trimmed)) return `Basic ${maskSecret(trimmed.replace(/^basic\s+/i, ''))}`;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return maskSecret(trimmed);
  return `${trimmed.slice(0, colon)}:${'•'.repeat(8)}`;
}

/**
 * Адрес в том виде, в каком его можно печатать: схема, хост, путь. Query и
 * userinfo срезаются.
 *
 * Это не гигиена ради гигиены. Человек, у которого спросили «адрес панели»,
 * вполне может вклеить туда строку с `?token=…` из браузера или
 * `https://login:password@host` из своих заметок, — и тогда сообщение об
 * ошибке, честно назвавшее адрес, напечатает секрет. Адрес участвует ровно в
 * тех сообщениях, которые человек потом копирует в чат или в issue.
 */
export function safeUrlLabel(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    // Неразобранный адрес — это ещё не разобранный адрес, а не безопасный:
    // печатаем только то, что заведомо не является значением.
    return '(unparseable URL)';
  }
}
