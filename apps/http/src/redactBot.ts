import { scrubSecretShapes } from '@hq/redact';

export const BOT_SENTINEL = '<forbidden:bot>';
export const BOT_SCRUB_SENTINEL = '<redacted>';
export const BOT_LIST_CAP = 50;
export const BOT_MAX_DEPTH = 12;

/**
 * §7.2 спеки, колонка bot. Ключи нормализуются (нижний регистр, без разделителей), поэтому
 * один элемент списка ловит и snake_case, и camelCase, и SCREAMING_SNAKE.
 *
 * Список ЗАКРЫТЫЙ и сравнивается целиком, а не подстрокой — в отличие от
 * `SECRET_KEY_RE` в `@hq/redact`, которая матчит `key` буквально и потому
 * съедала обычные поля вроде `showConnectionKeys` и `uniq_key`, чьё значение —
 * ИМЕНА ключей, а не ключевой материал. В бот-контуре цена такой ошибки выше,
 * а не ниже: ответ уже ушёл клиенту, и починить его нечем.
 */
export const BOT_FORBIDDEN_KEYS: readonly string[] = [
  // креды подключения и всё, что даёт ATO абонента
  'links',
  'ssconflinks',
  'connectionkeys',
  'vlessuuid',
  'trojanpassword',
  'sspassword',
  'rawinbound',
  // ссылка подписки — боту запрещена целиком, не маскируется хвостом
  'subscriptionurl',
  'subscriptionlink',
  'shortuuid',
  'cryptolink',
  'subscriptioncryptolink',
  'happ',
  // PII абонента
  'ip',
  'ips',
  'lastip',
  'remoteip',
  'clientip',
  'ipaddress',
  'xforwardedfor',
  'useragent',
  'sublastuseragent',
  'ua',
  'username',
  'telegramlogin',
  // login в SHM — это 'tg<telegram_id>' (см. связку identity), то есть прямой
  // идентификатор клиента в Telegram. Закрывать username и не закрывать login
  // бессмысленно.
  'login',
  'login1',
  'login2',
  'email',
  'emails',
  'phone',
  'fullname',
  'firstname',
  'lastname',
];

export const BOT_FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [/^vpnmrzb/, /password$/, /secret$/, /token$/];

const FORBIDDEN = new Set(BOT_FORBIDDEN_KEYS);

const PROXY_LINK = /\b(?:vless|vmess|trojan|ss|hy2|hysteria2):\/\/\S+/gi;
const SUB_LINK = /https?:\/\/\S*\/(?:sub|subscription)\/\S+/gi;
const ANY_URL = /\bhttps?:\/\/\S+/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export interface BotRedactionReport {
  forbiddenKeys: number;
  scrubbedStrings: number;
  truncatedLists: number;
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

export function isForbiddenKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (FORBIDDEN.has(normalized)) return true;
  return BOT_FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Свободный текст (комментарии, сообщения об ошибках, тексты задач спула) тоже утекает в чат
 * с клиентом, поэтому чистится отдельно от ключей. Порядок важен: сначала прокси-ссылки,
 * которые сами содержат IP, потом ссылки подписки, потом голые адреса.
 *
 * ПОСЛЕДНИМ — ПРОХОД ПО ФОРМЕ СЕКРЕТА (`@hq/redact`, `scrubSecretShapes`). Всё
 * выше — про адреса, то есть про то, что и так распознаётся глазом. Класс,
 * который правило по ИМЕНАМ полей пропускает по построению, — это секрет
 * ВНУТРИ значения: токен бота в `response.request.url` строки спула и в
 * колонке `host` пяти серверов SHM, креденшл голой подстрокой в теле шаблона
 * (все три сняты с работающей установки). Тот же модуль зовёт и `redact`, поэтому
 * форма секрета описана в проекте ровно один раз.
 *
 * `opaqueRuns` не включается намеренно: порог «длинного непрозрачного прогона»
 * откалиброван на телах шаблонов, а в ответе панели его перешагивают data-URI
 * иконок и hex-идентификатор платежа `uniq_id` — то самое поле, ради которого
 * бот билинговую строку и запрашивает.
 */
export function scrubString(input: string): { value: string; hits: number } {
  let hits = 0;
  const bump = (): string => {
    hits += 1;
    return BOT_SCRUB_SENTINEL;
  };
  const masked = input.replace(PROXY_LINK, bump).replace(SUB_LINK, bump).replace(IPV4, bump);
  const shaped = scrubSecretShapes(masked, { opaqueRuns: false });
  return { value: shaped.text, hits: hits + shaped.hits.length };
}

/**
 * Тексты ошибок — отдельный, более жёсткий проход. `ShmError`/`RemnaError` кладут в сообщение
 * путь запроса вместе с параметрами (`?text=tg100000001`), а клиентские ручки SHM ходят с
 * секретом `shm-all` прямо в URL (§7.2: «URL с ним никогда не логируется»). Поэтому здесь
 * вырезается ЛЮБОЙ http(s)-URL, а не только прокси- и подписочные ссылки.
 *
 * Применяется к `error.message` на выходе обоих транспортов: без этого канал ошибок обходит
 * всю редакцию ответов.
 */
export function redactMessage(message: string): string {
  return scrubString(message.replace(ANY_URL, BOT_SCRUB_SENTINEL)).value;
}

export function redactBotStrict(value: unknown): { value: unknown; report: BotRedactionReport } {
  const report: BotRedactionReport = { forbiddenKeys: 0, scrubbedStrings: 0, truncatedLists: 0 };
  // `seen` — стек ТЕКУЩЕЙ ветки, а не множество всего виденного. Ответ
  // инструмента собирается в JS, поэтому одна и та же ссылка вполне лежит в
  // двух местах (обычный DAG, не цикл); пометив второе вхождение как
  // '<cycle>', редакция молча съела бы кусок ответа. `@hq/redact` эту ошибку у
  // себя уже исправляла — повторять её здесь незачем.
  const seen = new Set<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
      const scrubbed = scrubString(node);
      report.scrubbedStrings += scrubbed.hits;
      return scrubbed.value;
    }
    if (typeof node !== 'object') return node;
    if (node instanceof Date) return node.toISOString();
    if (depth >= BOT_MAX_DEPTH) return '<depth-limit>';
    if (seen.has(node)) return '<cycle>';
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        const capped = node.length > BOT_LIST_CAP ? node.slice(0, BOT_LIST_CAP) : node;
        if (capped.length < node.length) report.truncatedLists += 1;
        return capped.map((item) => walk(item, depth + 1));
      }

      // Object.create(null), а не {}: во входном payload (например из
      // JSON.parse) бывает буквальный ключ "__proto__", и присвоение его на
      // обычном литерале подменяет прототип результата вместо поля.
      const out = Object.create(null) as unknown as Record<string, unknown>;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isForbiddenKey(key)) {
          report.forbiddenKeys += 1;
          out[key] = BOT_SENTINEL;
          continue;
        }
        out[key] = walk(child, depth + 1);
      }
      return out;
    } finally {
      seen.delete(node);
    }
  };

  return { value: walk(value, 0), report };
}
