/**
 * РЕДАКЦИЯ ПО ФОРМЕ ЗНАЧЕНИЯ, А НЕ ПО ИМЕНИ ПОЛЯ.
 *
 * `redact` в соседнем модуле маскирует по ИМЕНИ ключа и внутрь значений не
 * смотрит вовсе. Этого достаточно ровно до тех пор, пока секрет является
 * значением поля. Он им не является в двух уже встреченных местах:
 *
 *  - строка спула несёт токен бота ВНУТРИ `response.request.url`
 *    (`/bot<id>:<токен>/sendMessage`) — утечка настоящего токена в контекст
 *    модели, найденная прогоном `spool_inspect` на работающей установке;
 *  - тело шаблона SHM — это ТЕКСТОВЫЙ БЛОБ, в котором секрет лежит голой
 *    подстрокой: рабочий `hwid_blocker.tpl` присваивает `REMNA_TOKEN` JWT
 *    панели прямо в теле.
 *
 * Поэтому здесь живут правила по ФОРМЕ. Они же — правила, которыми
 * `scripts/no-secrets.test.ts` не пускает секрет в опубликованный коммит:
 * модуль вынесен из того теста именно затем, чтобы у «как выглядит секрет» был
 * ОДИН источник. Две копии этого знания разъезжаются молча и в худшую сторону
 * — вторая продолжает ВЫГЛЯДЕТЬ работающей.
 *
 * ЧЕГО ЭТИ ПРАВИЛА НЕ ДЕЛАЮТ: они не полны и полны быть не могут. Секрет,
 * напечатанный словами («пароль admin123»), формы не имеет. Это фильтр, а не
 * граница, и всё, что через него проходит, обязано оставаться в человеческом
 * профиле.
 */

/** JWT: три base64url-сегмента через точку. Так выглядит токен Remnawave. */
export const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/**
 * `KEY=<значение>` там, где имя обещает секрет, а значение не плейсхолдер.
 *
 * Кавычка ПОСЛЕ имени необязательна — ради `"API_KEY": "<значение>"`, то есть
 * ради любого закоммиченного json/yaml, где имя закавычено вместе со значением.
 * Ровно эту форму `ASSIGNMENT_RE` ниже учитывает с самого начала, а здесь её не
 * было: две записи одного знания разъехались молча, как и обещает шапка файла.
 * Имя остаётся ТОЛЬКО в верхнем регистре: `token`/`auth` в нижнем — обычные
 * идентификаторы кода (`const token = randomUUID()`, `auth: required(env, …)`),
 * и на трекаемых файлах регистронезависимое имя даёт 71 ложное срабатывание
 * против нуля у этой формы. Это известный пробел, а не забытый: секрет в
 * нижнем регистре ловится JWT-правилом и формами токена бота.
 */
export const ASSIGNED_SECRET_RE =
  /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)[A-Z_]*)["']?\s*[:=]\s*['"]?([^\s'"#]{12,})/;

/** Значения, которые обязаны считаться плейсхолдерами, а не секретами. */
export const PLACEHOLDER_RE =
  /^(?:<[^>]*>|\$\{[^}]*\}|x{3,}|\*{3,}|your[-_].*|change[-_]?me|example.*|placeholder.*|login:password|jwt-token|mcp:secret|Basic\s+xxx.*)$/i;

/**
 * Литерал регулярки — не присваивание секрета. Нужно ровно из-за
 * `SECRET_KEY_RE = /token|secret|key|password|auth/i` в этом же пакете:
 * определение правила, которое ищет секреты, само выглядит как секрет.
 */
export const REGEX_LITERAL_RE = /^\/.*\/[gimsuy]*$/;

/** `<login>:<password>` — плейсхолдер целиком, хотя ни один сегмент им не является. */
export const ALL_PLACEHOLDER_SEGMENTS_RE = /^(?:<[^>]*>[:@/\-]?)+$/;

/**
 * ТОКЕН БОТА В ПУТИ Bot API. Форма `/bot<id>:<секрет>/` бывает ровно у одного
 * адресата, поэтому порога длины здесь нет: усечённый, тестовый или чужой
 * токен в этой позиции — всё равно токен, а ложным срабатыванием такая форма
 * быть не может.
 *
 * Правило ОТДЕЛЬНОЕ от непрозрачного прогона, и обе причины измеримы:
 *  - между `bot` и первой цифрой нет границы слова, поэтому «голая» форма
 *    внутрь пути не попадает вовсе;
 *  - секретная часть токена Bot API — 35 символов из алфавита с `-`, а `-`
 *    непрозрачный прогон разрывает намеренно (см. `OPAQUE_RUN_RE`). Дефис
 *    встречается примерно в двух токенах из пяти: столько бы и проезжало.
 * Это ровно та утечка, что нашлась дважды — в `response.request.url` строки
 * спула и в колонке `host` записей серверов SHM.
 */
export const BOT_API_TOKEN_RE = /\bbot\d{5,16}:[A-Za-z0-9_-]+/gi;

/**
 * Тот же токен без адреса вокруг: `<id бота>:<35 символов>`. Порог длины здесь
 * обязателен — без `bot` перед цифрами форма «цифры, двоеточие, буквы» слишком
 * обычна (`18099:192.0.2.10`, `12:24:35`), и коротким порогом правило начало бы
 * есть тоннельные спецификации и таймстемпы.
 */
export const BARE_BOT_TOKEN_RE = /\b\d{5,16}:[A-Za-z0-9_-]{30,}/g;

/**
 * `scheme://<user>:<пароль>@host`. Пароль в адресе — не редкость проекта, а
 * его норма: так выглядят строки подключения к postgres и mysql через туннель
 * и ss-ссылки. Вырезается ТОЛЬКО пароль: схема, пользователь и хост — это
 * диагноз, ради которого строку и показывают.
 */
export const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/** Что остаётся вместо вырезанного. Форма названа вслух: модель должна видеть, ЧТО тут было. */
export const JWT_MASK = '<redacted:jwt>';
export const ASSIGNED_MASK = '<redacted:secret-value>';
export const OPAQUE_MASK = '<redacted:opaque>';
export const BOT_TOKEN_MASK = '<redacted:bot-token>';
export const URL_CREDENTIALS_MASK = '<redacted:url-credentials>';

/**
 * Алфавит непрозрачного прогона БЕЗ подсказки в имени: буквы, цифры и `+=_`.
 *
 * ТРИ СИМВОЛА ИСКЛЮЧЕНЫ НАМЕРЕННО, И КАЖДЫЙ — ПО ИЗМЕРЕНИЮ НА ПОЛНОМ КОРПУСЕ
 * НАСТОЯЩИХ ШАБЛОНОВ SHM, а не по вкусу:
 *  - `.` склеивала бы составные идентификаторы (`config.telegram.bot_token`);
 *  - `/` склеивает ПУТЬ URL: `$API_URL/shm/v1/storage/manage/vpn_mrzb_` — это
 *    39 символов «случайного вида», то есть ровно тот адрес провижининга,
 *    ради которого шаблон и читают;
 *  - `-` склеивает дефисный слаг: `telegra.ph/Polzovatelskoe-soglashenie-…`
 *    — публичная ссылка на условия, 38 символов.
 * Все три вырезались бы как секреты и уносили с собой ЛОГИКУ — то есть ответ
 * на вопрос, ради которого чтение шаблонов и открыли.
 *
 * ЧЕМ ЗА ЭТО ПЛАТИМ, вслух: base64 стандартного алфавита (с `/`) без подсказки
 * в имени распадается на куски и может проехать. Такой секрет ловится вторым
 * слоем — правилом присваивания, которому имя переменной уже пообещало секрет
 * и которое на форму значения смотрит мягче. Голый base64-с-косой, никому не
 * присвоенный, этот фильтр не поймает; это известная дыра, а не забытая.
 */
const OPAQUE_RUN_RE = /[A-Za-z0-9+=_]{12,}/g;

/**
 * Порог для прогона БЕЗ подсказки в имени. Откалиброван по полному корпусу
 * настоящих шаблонов SHM: на 32 символах правило вырезает ровно непрозрачные
 * ключи (`X-Guard-Token` 32 символа, секрет вебхука аналайзера 64) и не трогает
 * ни одного идентификатора, имени шаблона или заголовка.
 */
const OPAQUE_MIN = 32;

/** Порог для прогона, которому ИМЯ уже пообещало секрет. Тот же, что у ASSIGNED_SECRET_RE. */
const ASSIGNED_MIN = 12;

/**
 * «Похоже на случайное»: три класса символов в одном прогоне. Отсекает
 * `remnawave_update_configs_all` (28 символов, ни одной заглавной и ни одной
 * цифры) и `send_broadcast_25_12_2025_23_43` (нет заглавных), оставляя
 * base64-подобное. Отдельной веткой — чистый hex длиной от 32 (md5/sha и
 * ключи, напечатанные шестнадцатеричными): у него по построению не бывает
 * трёх классов, и без этой ветки он проходил бы насквозь.
 */
function looksOpaque(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run) && run.length >= 32) return true;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Значение, которое присваивать секретному имени законно: плейсхолдер, регулярка, шаблонная подстановка. */
function isPlaceholderValue(value: string): boolean {
  if (value === '') return true;
  if (PLACEHOLDER_RE.test(value)) return true;
  if (REGEX_LITERAL_RE.test(value)) return true;
  if (ALL_PLACEHOLDER_SEGMENTS_RE.test(value)) return true;
  // `{{ config.telegram.bot_token }}` и `${TOKEN}` — ССЫЛКА на секрет, а не он
  // сам. Вырезав её, инструмент скрыл бы от модели, ОТКУДА шаблон берёт токен,
  // ничего при этом не защитив.
  return value.includes('{{') || value.includes('${');
}

/** Одна находка. Значение не выносится НИКОГДА — только форма и длина. */
export interface SecretShapeHit {
  shape: 'jwt' | 'assigned_secret' | 'opaque_run' | 'bot_token' | 'url_credentials';
  chars: number;
}

export interface ScrubResult {
  text: string;
  hits: SecretShapeHit[];
}

/**
 * ВЫКЛЮЧАТЕЛЬ У ЕДИНСТВЕННОГО ПРАВИЛА, КОТОРОЕ УМЕЕТ ОШИБАТЬСЯ.
 *
 * Порог непрозрачного прогона (32 символа) откалиброван на настоящих
 * ШАБЛОНАХ, то есть на тексте. У структурированного ответа панели статистика
 * другая: `svgLibrary` несёт data-URI, `uniq_id` платежа — hex провайдера, и
 * оба этот порог перешагивают. Вырезав их, чистка гасит ровно те поля, ради
 * которых инструмент и писали, — эта потеря в проекте уже выкатывалась дважды
 * (по имени поля: `uniq_key`, `showConnectionKeys`), и во второй раз её нашёл
 * только прогон против работающего бэкенда.
 *
 * Поэтому: текстовый блоб (тело шаблона) чистится полным набором, а сквозной
 * проход по значениям в `redact` — только формами, которые ложными не бывают.
 */
export interface ScrubOptions {
  /** Прогон без подсказки в имени. По умолчанию включён. */
  opaqueRuns?: boolean;
}

/**
 * Присваивания вида `NAME = "<значение>"`, где имя обещает секрет. Имя ищется
 * той же `SECRET_KEY_RE`, которой `redact` маскирует поля объектов: одна
 * договорённость о том, какое имя обещает секрет, на структуру и на текст.
 * Регистронезависимо и без требования верхнего регистра — в шаблонах
 * встречается и `REMNA_TOKEN`, и `api_token`.
 *
 * Вырезается ТОЛЬКО значение. Имя остаётся: «здесь присваивается токен» — это
 * логика, и ровно она отвечает на вопрос, почему шаблон молчит.
 *
 * ЧЕТЫРЕ ФОРМЫ ОПЕРАТОРА И ОДНА ГРАНИЦА ЗНАЧЕНИЯ — обе выучены на настоящем
 * корпусе шаблонов, где первая версия правила промахнулась дважды:
 *  - `==` (сравнение с секретом-константой: `secret == 'zRL33es…'` — значение
 *    там такое же настоящее, как при присваивании), `=>` (perl-хеш заголовков)
 *    и `:` (JSON/YAML) наравне с `=`; необязательная кавычка ПОСЛЕ имени —
 *    ради `"password": "…"`, где имя закавычено вместе со значением;
 *  - из значения исключены `&`, `=`, `;`, `<`, `>`. Без этого жадное значение
 *    съедало всю строку запроса: в `port=443&secret=dd77…` совпадало имя
 *    `port`, значением становился остаток вместе с настоящим секретом, а имя
 *    `secret` до сопоставления не доживало вовсе — правило молча пропускало
 *    hex-ключ MTProxy, лежащий прямо в ссылке.
 */
const ASSIGNMENT_RE =
  /([A-Za-z_][A-Za-z0-9_]*)(["']?\s*(?:==?|=>|:)\s*)(["']?)([^\s"'`#&;<>=]+)\3/g;

const SECRET_NAME_RE = /token|secret|key|password|auth/i;

export function scrubSecretShapes(text: string, options: ScrubOptions = {}): ScrubResult {
  const hits: SecretShapeHit[] = [];
  if (text === '') return { text, hits };

  let out = text.replace(new RegExp(JWT_RE.source, 'g'), (match) => {
    hits.push({ shape: 'jwt', chars: match.length });
    return JWT_MASK;
  });

  // Токен бота — ДО правила присваивания: иначе `TELEGRAM_TOKEN = "<id>:<секрет>"`
  // засчитался бы присваиванием, и отчёт назвал бы форму, которой там нет.
  out = out.replace(BOT_API_TOKEN_RE, (match) => {
    hits.push({ shape: 'bot_token', chars: match.length });
    return BOT_TOKEN_MASK;
  });
  out = out.replace(BARE_BOT_TOKEN_RE, (match) => {
    hits.push({ shape: 'bot_token', chars: match.length });
    return BOT_TOKEN_MASK;
  });

  out = out.replace(URL_CREDENTIALS_RE, (_match, scheme: string, user: string, password: string) => {
    hits.push({ shape: 'url_credentials', chars: password.length });
    return `${scheme}${user}:${URL_CREDENTIALS_MASK}@`;
  });

  out = out.replace(ASSIGNMENT_RE, (match, name: string, gap: string, quote: string, value: string) => {
    if (!SECRET_NAME_RE.test(name)) return match;
    if (value.length < ASSIGNED_MIN) return match;
    if (isPlaceholderValue(value)) return match;
    // Значение обязано выглядеть непрозрачным, а не быть просто длинным:
    // `PASSWORD_RESET_TEMPLATE = brevo_password_reset` — это имя шаблона,
    // и вырезав его, инструмент соврал бы про логику вместо защиты секрета.
    if (!looksOpaque(value)) return match;
    hits.push({ shape: 'assigned_secret', chars: value.length });
    return `${name}${gap}${quote}${ASSIGNED_MASK}${quote}`;
  });

  if (options.opaqueRuns ?? true) {
    out = out.replace(OPAQUE_RUN_RE, (match) => {
      if (match.length < OPAQUE_MIN) return match;
      if (!looksOpaque(match)) return match;
      hits.push({ shape: 'opaque_run', chars: match.length });
      return OPAQUE_MASK;
    });
  }

  return { text: out, hits };
}

/**
 * ТОТ ЖЕ СКРУББЕР, НО ПО ДЕРЕВУ, А НЕ ПО ОДНОЙ СТРОКЕ.
 *
 * `scrubSecretShapes` работает с текстовым блобом — телом шаблона, url строки
 * спула. Ответы Remnawave устроены иначе: секрет там лежит строкой ГДЕ-ТО
 * внутри вложенного объекта, и какое имя у поля над ним — заранее неизвестно.
 * Пример, снятый с работающей панели 3.2.3: приватный ключ
 * Reality приезжает как `config.inbounds[].streamSettings.realitySettings
 * .privateKey`, а рядом, в том же объекте, лежат `seed` и `shortIds` — их
 * `SECRET_KEY_RE` не видит вовсе, потому что в именах нет ни одного из слов
 * token/secret/key/password/auth.
 *
 * Функция ЖИВЁТ ЗДЕСЬ, а не рядом с инструментом, по причине из шапки файла:
 * «как выглядит секрет» обязано иметь один источник. Это обход дерева поверх
 * уже написанного правила, а не второе правило.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ЧЕМ ЭТО КОМПЕНСИРУЕТСЯ У ВЫЗЫВАЮЩЕГО: секрет без формы
 * она не поймает — тот же `seed` вида `xhttp-r3mna-s33d-7k2pQ` рассыпается
 * дефисами на куски короче любого порога и проезжает целиком. Поэтому
 * инструменты, читающие сырой xray-конфиг, обязаны строить ответ БЕЛЫМ списком
 * полей, а этот проход ставить вторым слоем — он считает то, что просочилось,
 * и превращает молчаливую утечку в число в ответе.
 *
 * Имена ключей не трогаются намеренно: имя — это логика («здесь лежит ключ»),
 * и вырезав его, мы скрыли бы от вызывающего сам факт наличия секрета.
 */
export function scrubSecretShapesDeep<T>(
  value: T,
  options: ScrubOptions = {},
): { value: T; hits: SecretShapeHit[] } {
  const hits: SecretShapeHit[] = [];
  return { value: walkShapes(value, hits, new Set<object>(), options) as T, hits };
}

/**
 * Обход написан на `typeof` / `Array.isArray` / `Object.entries` и НИЧЕГО
 * другого: сюда приезжают объекты, построенные `redact` через
 * `Object.create(null)`, у которых нет `Object.prototype` в цепочке, и любой
 * `instanceof Object` / `.hasOwnProperty(...)` на них либо бросает, либо молча
 * врёт. `seen` — стек текущей ветки, а не множество всего виденного: иначе
 * повторная ссылка на один объект из двух веток (обычный DAG, не цикл) со
 * второго раза превратилась бы в маркер.
 */
function walkShapes(
  value: unknown,
  hits: SecretShapeHit[],
  seen: Set<object>,
  options: ScrubOptions,
): unknown {
  if (typeof value === 'string') {
    const scrubbed = scrubSecretShapes(value, options);
    hits.push(...scrubbed.hits);
    return scrubbed.text;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walkShapes(item, hits, seen, options));
    const out = Object.create(null) as unknown as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walkShapes(item, hits, seen, options);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
