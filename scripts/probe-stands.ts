/**
 * Ручной харнесс §9/§10: снимает ответы со СТЕНДОВ и раскладывает в fixtures/.
 * В CI не запускается и прод не трогает. Запуск:
 *   HQ_STAND_FORBIDDEN_HOSTS=billing.example.com,panel.example.com \
 *   HQ_STAND_SHM_URL=http://127.0.0.1:8080/shm/v1 HQ_STAND_SHM_AUTH=<login>:<password> \
 *   HQ_STAND_REMNA_URL=https://<your-stand> HQ_STAND_REMNA_TOKEN=... \
 *   pnpm tsx scripts/probe-stands.ts
 *
 * HQ_STAND_FORBIDDEN_HOSTS — рабочие хосты ИМЕННО этого развёртывания, через
 * запятую. Список живёт в конфигурации (`.env` гитигнорится, а `pnpm
 * probe:stands` его подхватывает), а не в исходнике: репозиторий публичный, и
 * захардкоженные там имена — это адреса чужого прода в чужом git. Не задан —
 * харнесс не стартует вовсе; см. assertNotProduction.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CREDENTIAL_KEYS, REDACTED, TAIL_MASK_KEYS, redact } from '@hq/redact';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Target {
  system: 'shm' | 'remna';
  endpoint: string;
  path: string;
  params?: Record<string, string>;
}

const SHM_TARGETS: Target[] = [
  { system: 'shm', endpoint: 'admin-user', path: '/admin/user', params: { limit: '2' } },
  { system: 'shm', endpoint: 'admin-user-search', path: '/admin/user/search', params: { text: 'a', limit: '2' } },
  { system: 'shm', endpoint: 'admin-user-filter-blocked', path: '/admin/user', params: { filter: '{"block":1}', limit: '2' } },
  { system: 'shm', endpoint: 'admin-user-service', path: '/admin/user/service', params: { limit: '2' } },
  { system: 'shm', endpoint: 'admin-user-pay', path: '/admin/user/pay', params: { limit: '2' } },
  { system: 'shm', endpoint: 'admin-user-service-withdraw', path: '/admin/user/service/withdraw', params: { limit: '2' } },
  { system: 'shm', endpoint: 'admin-spool', path: '/admin/spool', params: { limit: '2' } },
  { system: 'shm', endpoint: 'admin-spool-statuses', path: '/admin/spool/statuses' },
  { system: 'shm', endpoint: 'admin-service', path: '/admin/service', params: { limit: '2' } },
];

const REMNA_TARGETS: Target[] = [
  { system: 'remna', endpoint: 'system-metadata', path: '/api/system/metadata' },
  { system: 'remna', endpoint: 'users', path: '/api/users', params: { size: '2', start: '0' } },
  { system: 'remna', endpoint: 'users-search-value', path: '/api/users', params: { size: '2', start: '0', searchValue: 'tg' } },
  { system: 'remna', endpoint: 'nodes', path: '/api/nodes' },
  { system: 'remna', endpoint: 'hosts', path: '/api/hosts' },
  { system: 'remna', endpoint: 'config-profiles', path: '/api/config-profiles' },
  { system: 'remna', endpoint: 'internal-squads', path: '/api/internal-squads' },
  // Параметры — ровно те, что маршрут объявляет в схеме API Remnawave:
  // /api/system/stats — ни одного, /api/bandwidth-stats/nodes — topNodesLimit+
  // start+end. topUsersLimit принадлежит /api/bandwidth-stats/nodes/{uuid}/users
  // и здесь лишний. Для скрипта, снимающего эталонные фикстуры, это важнее, чем
  // где-либо ещё: снимок, взятый с несуществующим параметром, закрепил бы в
  // тестах форму ответа на запрос, которого настоящий код инструментов никогда
  // не сделает.
  { system: 'remna', endpoint: 'system-stats', path: '/api/system/stats' },
  { system: 'remna', endpoint: 'bandwidth-stats-nodes', path: '/api/bandwidth-stats/nodes', params: { start: '2026-08-01', end: '2026-08-08', topNodesLimit: '5' } },
  { system: 'remna', endpoint: 'bandwidth-stats-nodes-realtime', path: '/api/bandwidth-stats/nodes/realtime', params: { topNodesLimit: '5' } },
];

/** Имя переменной окружения со списком рабочих хостов. */
export const FORBIDDEN_HOSTS_VAR = 'HQ_STAND_FORBIDDEN_HOSTS';

/**
 * `a.example.com, b.example.com` → `['a.example.com', 'b.example.com']`.
 * Hostnames are case-insensitive by RFC 4343 — the guard has to be too, so
 * записи нормализуются в нижний регистр здесь, один раз.
 */
export function parseForbiddenHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * Совпадение проверяется ДВУМЯ способами, и хватает любого: по разобранному
 * hostname (плюс его поддомены — `example.com` в списке закрывает и
 * `panel.example.com`) и по подстроке в сырой строке. Второй нужен потому, что
 * `new URL()` бросает на «admin.example.com» без схемы, а hostname у
 * «host:8080/x» вообще пустой: URL, который не разобрался, обязан упереться в
 * отказ, а не проскочить мимо гейта. Гейт отказывающий — перебдеть здесь
 * дешевле, чем недобдеть.
 */
function isForbidden(rawUrl: string, forbidden: string[]): boolean {
  const lowered = rawUrl.toLowerCase();
  let host: string | null = null;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = null;
  }
  return forbidden.some(
    (entry) =>
      lowered.includes(entry) ||
      (host !== null && (host === entry || host.endsWith(`.${entry}`))),
  );
}

/**
 * Прод скриптом не трогается вовсе (§ задачи): даже если кто-то по ошибке
 * передаст рабочий хост в HQ_STAND_*_URL, харнесс обязан упасть раньше первого
 * fetch. Иначе живые данные клиентов уедут в фикстуру, а фикстура — в git
 * навсегда. Вынесена в отдельную функцию, чтобы это можно было проверить
 * тестом без единого сетевого вызова.
 *
 * Пустой список — ОТКАЗ, а не «нечего запрещать». Гейт, который при
 * ненастроенной конфигурации тихо пропускает всё, хуже отсутствующего: оператор
 * продолжает считать, что предохранитель на месте, и ошибается ровно в тот
 * момент, когда он нужен.
 */
export function assertNotProduction(
  shmUrl: string,
  remnaUrl: string,
  forbiddenRaw: string | undefined,
): void {
  const forbidden = parseForbiddenHosts(forbiddenRaw);
  if (forbidden.length === 0) {
    throw new Error(
      `${FORBIDDEN_HOSTS_VAR} is not set: list this deployment's production hosts ` +
        '(comma-separated) so the capture can refuse them. Refusing to capture without it.',
    );
  }
  // Имя переменной названо, значение — нет: сам хост в сообщение не попадает,
  // чтобы отказ можно было цитировать в issue, не публикуя чужой прод.
  for (const [name, value] of [
    ['HQ_STAND_SHM_URL', shmUrl],
    ['HQ_STAND_REMNA_URL', remnaUrl],
  ] as const) {
    if (isForbidden(value, forbidden)) {
      throw new Error(
        `refusing to run against production hosts: ${name} matches ${FORBIDDEN_HOSTS_VAR}; ` +
          'point this script at the stands',
      );
    }
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required: this script talks to the stands from §9, not to prod`);
  }
  return value;
}

// Совпадает с нормализацией ключей внутри @hq/redact (нижний регистр, без
// '_'/'-'): бэкенды отдают один и тот же смысл то camelCase, то snake_case.
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

const CREDENTIAL_KEY_SET = new Set(CREDENTIAL_KEYS.map(normalizeKey));
const TAIL_MASK_KEY_SET = new Set(TAIL_MASK_KEYS.map(normalizeKey));

/** vless://…, ss://…, trojan://… — рабочая ссылка подключения, а не просто имя поля. */
const CREDENTIAL_SCHEME_RE = /(?:vless|ss|trojan):\/\//i;
/**
 * Длинный непрерывный base64/hex-прогон — типичная форма сырого секрета.
 * Дефисы НЕ входят в алфавит специально: обычный UUID (id, не секрет) —
 * это 32 hex-символа, порезанные дефисами на группы, и не должен матчиться.
 */
const OPAQUE_RUN_RE = /^[A-Za-z0-9+/_]{32,}={0,2}$/;

function looksMasked(value: string): boolean {
  return value === '' || value === REDACTED || value.includes('*');
}

/**
 * Рекурсивно ищет первое нарушение инварианта в УЖЕ отредактированной
 * структуре (см. отчёт по фиксу задачи 10):
 *
 * 1. Ни одно строковое значение нигде в дереве не похоже на сырой рабочий
 *    креденшл (ссылка-схема vless/ss/trojan или длинный непрерывный
 *    base64/hex-прогон) — независимо от того, лежит ли оно значением поля
 *    объекта или элементом массива (на любой глубине вложенности массивов:
 *    Remnawave отдаёт links/ssConfLinks как массивы РАБОЧИХ vless:// ссылок).
 * 2. Каждый ключ объекта, чьё имя (нормализованное) входит в CREDENTIAL_KEYS
 *    или TAIL_MASK_KEYS из @hq/redact, несёт замаскированное значение —
 *    REDACTED-сентинел для credential-ключей, REDACTED/пусто/со звёздочками
 *    для tail-mask-ключей — а не оригинал.
 *
 * Каждое значение проходит через один и тот же вход (эта же функция), а не
 * только те, что оказались object-property — иначе строка-элемент массива
 * никогда не попадает под проверку (1) вовсе.
 *
 * Возвращает путь до первого нарушения (без самого значения — оно не должно
 * попасть ни в лог, ни в сообщение об ошибке) или null, если всё чисто.
 */
function findLeak(value: unknown, path: string): string | null {
  if (typeof value === 'string') {
    if (CREDENTIAL_SCHEME_RE.test(value) || OPAQUE_RUN_RE.test(value)) {
      return `${path === '' ? '(root)' : path}: value looks like a raw credential`;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findLeak(value[index], `${path}[${String(index)}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const fieldValue = (value as Record<string, unknown>)[key];
    const here = path === '' ? key : `${path}.${key}`;
    const normalized = normalizeKey(key);

    if (CREDENTIAL_KEY_SET.has(normalized)) {
      if (fieldValue !== REDACTED) return `${here}: credential-named key is not masked`;
      continue;
    }
    if (TAIL_MASK_KEY_SET.has(normalized)) {
      if (typeof fieldValue !== 'string' || !looksMasked(fieldValue)) {
        return `${here}: tail-mask key does not look masked`;
      }
      continue;
    }

    const hit = findLeak(fieldValue, here);
    if (hit) return hit;
  }
  return null;
}

/**
 * Фикстура — это то, что уедет в git навсегда, поэтому редакция не
 * единственная линия обороны: `findLeak` прогоняется по результату
 * `redact()` ещё раз, и при нарушении запись на диск не происходит вовсе.
 * Вынесена отдельно (чистая функция, без fs, без вызова redact()) — так её
 * можно проверить тестом на инвариант независимо от того, работает ли сам
 * `redact()` сейчас корректно.
 */
export function assertRedactedIsSafe(redacted: unknown, endpoint: string): void {
  const violation = findLeak(redacted, '');
  if (violation) {
    throw new Error(`${endpoint}: credentials survived redaction (${violation}), refusing to write a fixture`);
  }
}

/**
 * Профиль 'bot', а не 'human'. Фикстура уедет в git навсегда, а репозиторий
 * публичный: email/login2/full_name/phone/ip/userAgent маскируются ТОЛЬКО
 * профилю 'bot' (packages/redact/src/index.ts), и `findLeak` их не подстрахует
 * — он ищет креды, а не персональные данные. 'human' здесь маскировал меньше
 * всех и складывал живые адреса и IP клиентов прямо в файл.
 */
export function redactForFixture(record: unknown, endpoint: string): string {
  const safe = redact(record, 'bot');
  assertRedactedIsSafe(safe, endpoint);
  return JSON.stringify(safe, null, 2);
}

async function capture(target: Target, baseUrl: string, headers: Record<string, string>): Promise<void> {
  const url = new URL(`${baseUrl}${target.path}`);
  for (const [name, value] of Object.entries(target.params ?? {})) url.searchParams.set(name, value);

  // manual: a 3xx from a stand must never be silently followed — the host
  // guard only inspected the ORIGINAL URL, and a redirect target could point
  // anywhere, including production. Capture the redirect response itself
  // (status, Location) rather than chase it.
  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const record = {
    capturedAt: new Date().toISOString(),
    status: response.status,
    path: target.path,
    params: target.params ?? {},
    body: text.trim() === '' ? null : (JSON.parse(text) as unknown),
  };
  const serialized = redactForFixture(record, target.endpoint);
  const dir = join(FIXTURES_DIR, target.system);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${target.endpoint}.json`), `${serialized}\n`, 'utf8');
  console.error(`captured ${target.system}/${target.endpoint} (HTTP ${String(response.status)})`);
}

async function main(): Promise<void> {
  const shmUrl = required('HQ_STAND_SHM_URL');
  const shmAuth = required('HQ_STAND_SHM_AUTH');
  const remnaUrl = required('HQ_STAND_REMNA_URL');
  const remnaToken = required('HQ_STAND_REMNA_TOKEN');

  assertNotProduction(shmUrl, remnaUrl, process.env[FORBIDDEN_HOSTS_VAR]);

  const shmHeaders = {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(shmAuth, 'utf8').toString('base64')}`,
  };
  const remnaHeaders = { Accept: 'application/json', Authorization: `Bearer ${remnaToken}` };

  for (const target of SHM_TARGETS) {
    try {
      await capture(target, shmUrl, shmHeaders);
    } catch (error: unknown) {
      console.error(`skipped shm/${target.endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const target of REMNA_TARGETS) {
    try {
      await capture(target, remnaUrl, remnaHeaders);
    } catch (error: unknown) {
      console.error(`skipped remna/${target.endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Гейт на прямой запуск: истинно только когда этот файл — точка входа процесса
 * (`tsx scripts/probe-stands.ts`), а не когда его импортирует тест ради
 * `assertNotProduction`/`redactForFixture`. Без гейта сам факт импорта из теста
 * запускал бы харнесс.
 *
 * Сравнение идёт по РЕАЛЬНОМУ пути — тот же дефект, что commit 71ce1c1 чинил в
 * apps/stdio: node кладёт в `import.meta.url` путь с разрешёнными симлинками, а
 * в `argv[1]` — тот, которым позвали. Через симлинк строки не совпадают, main()
 * не зовётся, и харнесс молча выходит с кодом 0, не сняв ни одной фикстуры и не
 * сказав ни слова. `realpathSync` на несуществующем пути бросает, поэтому
 * исходный путь остаётся запасным вариантом: хуже прежнего сравнения не будет.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  let resolved = resolve(argv1);
  try {
    resolved = realpathSync(resolved);
  } catch {
    resolved = resolve(argv1);
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main();
}
