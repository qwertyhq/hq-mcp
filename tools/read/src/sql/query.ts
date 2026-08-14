/**
 * sql_query — ПРЕДПОЛЁТНАЯ часть и только она. Ни одна строка этого модуля не
 * выполняет SQL, и выполнить его сегодня нечем: MySQL SHM не публикует 3306
 * вообще (только docker-сеть своего хоста), а read-only роль не заведена ни в
 * SHM, ни в Postgres Remnawave (спека §4.3, §7.1, открытые вопросы §9.21-9.22;
 * в packages/env/src/index.ts штатный дефолт `mysql: null`). Инструмент
 * существует, чтобы СКАЗАТЬ это словами, а не молча ходить под админской
 * учёткой — Postgres панели работает под POSTGRES_USER, то есть владельцем
 * базы, и это ровно тот класс сырого доступа, ради запрета которого §7.1
 * написан.
 *
 * ═══ ПРЕДУСЛОВИЯ ВЫПОЛНЕНИЯ ═══
 *
 * Это не «дополнительное усиление», а список того, что обязано существовать ДО
 * первого живого запроса. Лексическая проверка ниже не заменяет ни одного
 * пункта и не приближает к нему.
 *
 * Postgres (Remnawave):
 *   - отдельная роль с `SELECT`-грантами и ничем больше; НЕ владелец базы;
 *   - `ALTER ROLE <role> SET default_transaction_read_only = on`;
 *   - каждый запрос внутри `BEGIN READ ONLY`;
 *   - `statement_timeout` на роли (иначе `pg_sleep`/рекурсивный CTE держат
 *     соединение сколько угодно);
 *   - `REVOKE` на функции работы с файлами и на `pg_read_server_files`.
 *
 * MySQL (SHM):
 *   - пользователь с `SELECT` только на схеме `shm`;
 *   - `START TRANSACTION READ ONLY`;
 *   - `max_execution_time`;
 *   - драйвер с `multipleStatements: false` — это единственная НАСТОЯЩАЯ
 *     защита от склейки запросов; проверка `;` в тексте ею не является.
 *
 * Денилист таблиц и колонок (обязателен, вычисляется по колонкам, которые
 * запрос реально трогает, а не по тексту):
 *   - `config.value` — это ровно тот payload, который §8 запрещает на
 *     HTTP-слое (/admin/config, packages/registry/src/forbidden.ts:78):
 *     telegram.token и секреты всех платёжных систем;
 *   - `users.password`, `users.settings` — в settings лежат `otp.secret`,
 *     `otp.backup_codes`, `passkey.credentials` (Core/User/OTP.pm:82,88,
 *     Core/User/Passkey.pm:48-56);
 *   - `sessions.*` целиком.
 *   Алиас вердикта не меняет: `SELECT value AS v FROM config` — тот же запрет.
 *
 * Редакция (обязательна и НЕ является границей):
 *   - строки проходят через `redact(rows, ctx.profile)`;
 *   - маскирование идёт по ИМЕНИ ВОЗВРАЩЁННОЙ КОЛОНКИ
 *     (packages/redact/src/index.ts:71-86), а имя выбирает вызывающий:
 *     `SELECT CONCAT(login,':',password) AS x FROM users` не маскируется
 *     ничем;
 *   - JSON-строки `redact` пропускает насквозь (там же, :89), а MySQL отдаёт
 *     `users.settings` именно строкой — такую колонку нужно разбирать и
 *     редактировать, либо отказывать в запросе.
 *
 * Кто будет включать выполнение: лексическая проверка ниже — дешёвый первый
 * фильтр. Прочитать её как достаточную нельзя, и KNOWN_BYPASSES существует
 * затем, чтобы это было невозможно случайно.
 */
import { defineTool } from '@hq/registry';
import net from 'node:net';
import { z } from 'zod';
import type { TcpProbe, ToolDef, TunnelConfig } from '@hq/types';
import { assertHumanOnly } from '../kit.js';

// TcpProbe живёт в общем контракте (@hq/types): его же принимает platform_probe
// и передаёт buildRuntime. Здесь только реализация поверх node:net.
export type { TcpProbe };

const READ_ONLY_RE = /^(select|with|show|explain|describe|desc)\b/i;

/**
 * ANALYZE (и британское ANALYSE) превращает EXPLAIN из планировщика в
 * исполнителя. Живёт отдельно от WRITE_RE намеренно: сам по себе это слово
 * ничего не пишет и запрещать его везде — значит отвергать безобидное
 * `SELECT relname FROM pg_stat_user_tables ORDER BY analyze_count`. Опасна
 * ровно связка «EXPLAIN + ANALYZE», и проверяется ровно она.
 */
const ANALYZE_RE = /\banaly[sz]e\b/i;
const WRITE_RE =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|call|lock|set|copy|outfile|load_file|into)\b/i;

const TUNNEL_TIMEOUT_MS = 1_500;

/** Утверждение, которое проходит проверку насквозь, и что оно на самом деле делает. */
export interface KnownBypass {
  sql: string;
  effect: string;
  /**
   * Заполнено — значит ЭТО выражение с некоторых пор отвергается, и здесь
   * написано, чем именно. Запись остаётся в списке как история: убрать её
   * значило бы стереть повод, по которому проверка изменилась.
   */
  nowRefused?: string;
}

/**
 * Дыры, оставленные ОТКРЫТЫМИ и зафиксированные тестом. Это не список «надо
 * бы починить»: залатать перечисленное поимённо нельзя — денилист слов не
 * становится границей оттого, что слов стало больше, — а вид «почти полного»
 * фильтра опаснее явно дырявого. Настоящая защита перечислена в блоке
 * ПРЕДУСЛОВИЯ ВЫПОЛНЕНИЯ выше: read-only роль, read-only транзакция,
 * statement_timeout и денилист колонок.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТ ЭТОТ СПИСОК. Ровно одно: перечисленное проходит
 * `assertReadOnlySql` — лексический фильтр. Большинство строк как записаны
 * упрутся дальше в `assertRowCap`, потому что не кончаются на `LIMIT n`; это
 * не защита и не смягчение, приписать `LIMIT 1` стоит одного нажатия, и после
 * этого выражение проходит хендлер целиком. Читать список как «вот что
 * пролезает мимо фильтра», а не как «вот что фильтр пропускает в базу», —
 * ошибка в безопасную сторону, и лучше её не делать вовсе.
 *
 * Первые девять — из предиспатч-аудита; остальные найдены при реализации тем
 * же способом (прогоном через реальные регулярки). Список — нижняя граница, а
 * не полный перечень; ровно поэтому он и не может служить границей.
 */
export const KNOWN_BYPASSES: readonly KnownBypass[] = [
  { sql: "SELECT setval('users_user_id_seq', 1)", effect: 'пишет: \\bset\\b не совпадает с setval' },
  { sql: "SELECT nextval('users_user_id_seq')", effect: 'пишет: двигает последовательность' },
  {
    sql: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid()',
    effect: 'убивает все соединения панели с её базой',
  },
  { sql: "SELECT pg_read_file('/etc/passwd')", effect: 'читает произвольный файл сервера' },
  { sql: 'SELECT SLEEP(600)', effect: 'держит соединение десять минут (MySQL)' },
  { sql: 'SELECT pg_sleep(600)', effect: 'то же самое в Postgres' },
  {
    sql: "SELECT GET_LOCK('shm', 3600)",
    effect: 'берёт именованную блокировку: \\block\\b не совпадает с GET_LOCK, `_` — словесный символ',
  },
  { sql: 'SELECT * FROM mysql.user', effect: 'хеши паролей СУБД' },
  { sql: 'SELECT * FROM pg_shadow', effect: 'хеши паролей СУБД' },
  {
    sql: 'SELECT * FROM pg_authid',
    effect: 'те же хеши другой таблицей; панель ходит владельцем базы, доступ есть',
  },
  { sql: "SELECT lo_import('/etc/passwd')", effect: 'пишет: создаёт large object из файла' },
  { sql: "SELECT * FROM pg_ls_dir('/')", effect: 'листинг каталогов сервера' },
  { sql: "SELECT pg_read_binary_file('/etc/shadow')", effect: 'бинарное чтение файла' },
  {
    sql: 'EXPLAIN ANALYZE SELECT pg_sleep(600)',
    effect: 'EXPLAIN ANALYZE ВЫПОЛНЯЕТ запрос, а не планирует его',
    nowRefused:
      'Единственная дыра, которая была на РАЗРЕШАЮЩЕЙ стороне: глагол из списка ' +
      'дозволенных исполнял свой аргумент, то есть неверен был сам список, а не денилист. ' +
      'Такое закрывается классом, а не именем, — поэтому отвергается любой EXPLAIN с ANALYZE.',
  },
  {
    sql: 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    effect: 'бесконечный рекурсивный CTE: память и CPU до отказа',
  },
  { sql: "SELECT BENCHMARK(100000000, MD5('a'))", effect: 'выжигает CPU биллинговой MySQL' },
  { sql: 'SELECT query FROM pg_stat_activity', effect: 'тексты чужих запросов вместе с их литералами' },
  { sql: 'SELECT 1 FOR SHARE', effect: 'берёт блокировки строк: \\block\\b не совпадает с FOR SHARE' },
  { sql: 'SELECT value FROM config', effect: 'дамп §8 целиком: telegram.token и секреты платёжек' },
  { sql: 'SELECT settings FROM users', effect: 'otp.secret, backup_codes, passkey.credentials' },
  {
    sql: "SELECT CONCAT(login,':',password) AS x FROM users",
    effect: 'редакция по имени колонки бессильна: имя выбирает вызывающий',
  },
];

/**
 * ДЕШЁВЫЙ ПЕРВЫЙ ФИЛЬТР, А НЕ ГРАНИЦА БЕЗОПАСНОСТИ. Он ловит опечатку и
 * очевидную запись; он НЕ доказывает, что запрос ничего не изменит и ничего
 * лишнего не прочитает — см. KNOWN_BYPASSES выше и блок ПРЕДУСЛОВИЯ
 * ВЫПОЛНЕНИЯ в шапке модуля. Проверок пять, все — по СЫРОМУ ТЕКСТУ, без
 * разбора SQL и без понятия о кавычках.
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '').trim();
  if (trimmed === '') throw new Error('empty SQL statement');
  if (trimmed.includes(';')) {
    throw new Error(
      'refused: the statement TEXT contains ";" — send exactly one read-only statement. The ' +
        'check scans the raw string and knows nothing about quoting, so a semicolon inside a ' +
        "string literal (WHERE login = 'a;b') is refused too. That is the filter working as " +
        'built, not a bug: rewrite the literal or ask an operator.',
    );
  }
  if (/--|\/\*|#/.test(trimmed)) {
    throw new Error(
      'refused: the statement TEXT contains a comment marker (--, /* or #), the usual way to ' +
        'smuggle a second statement. The check scans the raw string, so a marker inside a ' +
        "string literal (LIKE '%#1%') is refused too — that is the filter working as built, " +
        'not a bug.',
    );
  }
  if (!READ_ONLY_RE.test(trimmed)) {
    throw new Error(
      'only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE statements are allowed, and the statement ' +
        'must START with one of those words: a leading parenthesis ((SELECT 1) UNION (SELECT 2)) ' +
        'is refused by the same rule.',
    );
  }
  if (/^explain\b/i.test(trimmed) && ANALYZE_RE.test(trimmed)) {
    throw new Error(
      'refused: EXPLAIN ANALYZE EXECUTES the statement it is given instead of planning it — in ' +
        'PostgreSQL and in MySQL 8 alike, and in every spelling (EXPLAIN ANALYZE …, ' +
        'EXPLAIN (ANALYZE) …, EXPLAIN (FORMAT JSON, ANALYZE TRUE) …, ANALYSE). EXPLAIN is on the ' +
        'allowed-verb list only because a plain EXPLAIN plans and does not run; ANALYZE turns it ' +
        'back into a run, so the allowed verb would otherwise smuggle in anything at all. Drop ' +
        'ANALYZE to get the plan. The check scans the raw text, so the word inside a string ' +
        'literal is refused too.',
    );
  }
  const write = WRITE_RE.exec(trimmed);
  if (write !== null) {
    throw new Error(
      `refused: the statement TEXT contains the write keyword "${write[0]}". The check scans the ` +
        "raw string, so the word inside a string literal (LIKE '%delete%') or inside an " +
        'otherwise harmless statement (SHOW CREATE TABLE users) is refused just the same. That ' +
        'is the filter working as built, not a bug — and passing it proves nothing about the ' +
        'statement being read-only (see KNOWN_BYPASSES).',
    );
  }
}

/**
 * Требует, чтобы выборка строк была ОГРАНИЧЕНА в самом тексте. Без этого
 * `limit` — украшение: он только подставляется в текст финального отказа, и
 * `SELECT * FROM users` отчитывается как «предполёт пройден». Решается здесь,
 * а не «когда будет исполнитель», чтобы у того, кто будет его писать, не
 * появилось третьего ответа на этот вопрос.
 *
 * SHOW / EXPLAIN / DESCRIBE освобождены: они ограничены схемой, а не строками,
 * и LIMIT к ним не приписывается — требовать его значило бы отвергать
 * корректный запрос ради формы.
 *
 * Освобождение EXPLAIN безопасно ТОЛЬКО потому, что EXPLAIN с ANALYZE
 * отвергается выше, в assertReadOnlySql. Пока это было не так, EXPLAIN ANALYZE
 * оставался единственным известным выражением, проходившим весь хендлер без
 * единой правки: разрешающий список пускал его, а здешнее освобождение
 * снимало последнюю проверку. Ослабите ту — вернёте эту.
 */
function assertRowCap(sql: string, limit: number): void {
  const trimmed = sql.trim().replace(/;\s*$/, '').trim();
  if (!/^(select|with)\b/i.test(trimmed)) return;
  const found = /\blimit\s+(\d+)\s*$/i.exec(trimmed);
  if (found === null) {
    throw new Error(
      `refused: a row-returning statement must END with "LIMIT n" where n <= ${String(limit)}. ` +
        'Without it the cap in the input is decoration — nothing would stop the query from ' +
        'returning the whole table. Append the LIMIT explicitly, even to a statement you expect ' +
        'to return one row (SELECT 1 LIMIT 1). "LIMIT n OFFSET m" and MySQL\'s "LIMIT m, n" are ' +
        'refused by the same rule on purpose: in the second form the FIRST number is the offset, ' +
        'and reading it as the row cap would understate how much the query returns.',
    );
  }
  const asked = Number(found[1]);
  if (asked > limit) {
    throw new Error(
      `refused: the statement asks for LIMIT ${String(asked)} while the tool's cap is ` +
        `${String(limit)}. Raise the limit input on purpose, or lower the LIMIT clause.`,
    );
  }
}

export const probeTcp: TcpProbe = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.unref();
  });

/**
 * Предполётная часть sql_query: профиль, лексический фильтр, ограничение
 * строк и живой туннель. Что бы ни прошло все четыре — запрос не выполняется:
 * не хватает read-only роли, а под админской учёткой ходить запрещено.
 */
export function createSqlQueryTool(cfg: TunnelConfig, deps: { probeTcp: TcpProbe }): ToolDef {
  return defineTool({
    name: 'sql_query',
    description:
      'PREFLIGHT ONLY — this tool cannot run a query yet and will always refuse at the last step. ' +
      'It validates the profile, checks the statement is a single read-only one with an explicit ' +
      'row cap and probes the ssh tunnel, then explains what is missing. Executing SQL needs a ' +
      'dedicated read-only database role that does not exist yet (SHM MySQL 3306 is not ' +
      'published at all; the Remnawave Postgres role has not been created). Running under the ' +
      'admin account is refused on purpose: unrestricted database access is exactly what this ' +
      'server exists to avoid. When execution is wired it will also need a table/column denylist ' +
      '(config.value, users.password, users.settings, sessions.*) evaluated on the columns the ' +
      'query touches, because the statement check here is a lexical filter and not a boundary. ' +
      'Use it to find out what to ask an operator for, not to get data.',
    input: z.object({
      target: z.enum(['mysql', 'postgres']).describe('mysql = SHM billing, postgres = Remnawave'),
      sql: z.string().min(1).describe('One read-only statement: SELECT / WITH / SHOW / EXPLAIN'),
      limit: z
        .number()
        .int()
        .positive()
        .default(100)
        .describe('Max rows the query would return once a read-only role exists'),
    }),
    access: 'ro',
    risk: 'high',
    // requires: ['tunnel.postgres'] СОЗНАТЕЛЬНО отсутствует — по той же
    // причине, что и у abuse_report: probe ставит возможность в жёсткий false
    // при закрытом туннеле, Registry.list прячет такой инструмент, и модель
    // заключает, что возможности нет вовсе. Отдельно: инструмент обслуживает и
    // target:'mysql', чья работа — объяснить, что 3306 не публикуется; гейт по
    // одной только tunnel.postgres прятал бы и это объяснение.
    profiles: ['human'],
    // Ни одной: инструмент ходит в БАЗЫ через ssh-туннель, а не в API, и
    // осмысленно отказывает независимо от того, чьи креды заданы.
    backends: [],
    handler: async ({ target, sql, limit }, ctx) => {
      assertHumanOnly(
        ctx,
        'sql_query is available to the human profile only. It is the preflight for raw ' +
          'database access, which §7.1 puts behind a human on purpose: the statement check ' +
          'here is a lexical filter and not a boundary, and no redaction can cover the rows ' +
          'either, because masking keys on the returned column name and the caller picks that ' +
          "name (SELECT CONCAT(login,':',password) AS x). Ask a human operator, or use the " +
          'typed tools — client_overview, billing_ledger, sync_audit — which answer the same ' +
          'questions under a contract.',
      );
      assertReadOnlySql(sql);
      assertRowCap(sql, limit);

      const endpoint = target === 'mysql' ? cfg.mysql : cfg.postgres;
      if (endpoint === null) {
        throw new Error(
          'The SHM MySQL has no reachable endpoint: port 3306 is not published at all, it only ' +
            'exists inside the docker network of the billing VM. Publishing a source-restricted ' +
            'port or standing up a read-only endpoint is a prerequisite of this tool.',
        );
      }

      const reachable = await deps.probeTcp(endpoint.host, endpoint.port, TUNNEL_TIMEOUT_MS);
      if (!reachable) {
        throw new Error(
          `No tunnel to ${target} at ${endpoint.host}:${String(endpoint.port)}. Open it first:\n  ` +
            cfg.sshCommand,
        );
      }

      throw new Error(
        `Preflight passed: the statement got past the lexical filter and the row-cap rule (at ` +
          `most ${String(limit)} rows), the profile is human and the tunnel to ` +
          `${target} at ${endpoint.host}:${String(endpoint.port)} is open. What is missing is the ` +
          'database credential: a dedicated read-only role is a prerequisite of this tool and ' +
          'has not been created yet (design §9.22). Falling back to the admin or root account is ' +
          'not an option — unrestricted database access is exactly what this server exists to ' +
          'avoid, and the lexical filter is not a substitute for it (a read-only role, a ' +
          'read-only transaction, a statement_timeout and a column denylist are). Ask an ' +
          'operator to create the read-only role, then wire it in.',
      );
    },
  });
}
