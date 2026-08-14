import { describe, expect, it } from 'vitest';
import type { TunnelConfig } from '@hq/types';
import { makeCtx } from '../testkit.js';
import { KNOWN_BYPASSES, assertReadOnlySql, createSqlQueryTool } from './query.js';

const tunnel: TunnelConfig = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: null,
  sshCommand: 'ssh -L 18099:192.0.2.10:8099 -L 16767:192.0.2.20:6767 jump-host',
};

/** Текст отказа целиком: часть проверок здесь — про то, чего в нём быть НЕ должно. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('assertReadOnlySql', () => {
  it('accepts plain read statements', () => {
    expect(() => assertReadOnlySql('SELECT id FROM users LIMIT 10')).not.toThrow();
    expect(() => assertReadOnlySql('  with x as (select 1) select * from x ')).not.toThrow();
    expect(() => assertReadOnlySql('SHOW TABLES;')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT updated_at, created_at FROM users')).not.toThrow();
  });

  it('rejects writes, stacked statements and comments', () => {
    expect(() => assertReadOnlySql('UPDATE users SET block=1')).toThrow(/SELECT/);
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE users')).toThrow(/one/i);
    expect(() => assertReadOnlySql('SELECT 1 -- comment')).toThrow(/comment/i);
    expect(() => assertReadOnlySql('SELECT * INTO OUTFILE "/tmp/x" FROM users')).toThrow();
    expect(() => assertReadOnlySql('   ')).toThrow(/empty/i);
  });

  it('says the refusal is about the statement TEXT, not about parsed SQL', () => {
    // Все три проверки сканируют сырую строку и ничего не знают о кавычках.
    // Без этой оговорки оператор не отличит гард от бага (§9-12, находка 10).
    expect(() => assertReadOnlySql("SELECT id FROM users WHERE login = 'a;b'")).toThrow(
      /string literal/i,
    );
    expect(() => assertReadOnlySql("SELECT id FROM t WHERE x LIKE '%#1%'")).toThrow(
      /string literal/i,
    );
    expect(() => assertReadOnlySql("SELECT id FROM log WHERE event LIKE '%delete%'")).toThrow(
      /string literal/i,
    );
    expect(() => assertReadOnlySql('SHOW CREATE TABLE users')).toThrow(/string literal/i);
  });

  it('refuses the EXPLAIN forms that execute their argument', () => {
    // EXPLAIN попал в список разрешённых глаголов потому, что планирует
    // запрос. EXPLAIN ANALYZE его ВЫПОЛНЯЕТ — и в Postgres, и в MySQL 8.
    // Это единственная дыра на РАЗРЕШАЮЩЕЙ стороне, и закрывается она классом
    // («глагол, исполняющий свой аргумент»), а не именем.
    expect(() => assertReadOnlySql('EXPLAIN SELECT id FROM users LIMIT 1')).not.toThrow();
    expect(() => assertReadOnlySql('EXPLAIN ANALYZE SELECT pg_sleep(600)')).toThrow(/executes/i);
    expect(() => assertReadOnlySql('EXPLAIN (ANALYZE) SELECT pg_sleep(600)')).toThrow(/executes/i);
    expect(() => assertReadOnlySql('EXPLAIN (FORMAT JSON, ANALYZE TRUE) SELECT 1')).toThrow(
      /executes/i,
    );
    // Британское написание — тот же глагол в Postgres.
    expect(() => assertReadOnlySql('explain analyse select 1')).toThrow(/executes/i);
  });

  it('is a lexical filter and NOT a boundary: the open bypasses still pass', () => {
    // Тест закрепляет ДЫРУ открытой намеренно. Пока он зелёный, следующий
    // читатель не может принять этот фильтр за границу безопасности:
    // всё перечисленное пишет, убивает соединения, читает файлы сервера,
    // держит блокировки или отдаёт хеши паролей — и проходит все пять проверок.
    const open = KNOWN_BYPASSES.filter((one) => one.nowRefused === undefined);
    expect(open.length).toBeGreaterThan(0);
    for (const bypass of open) {
      expect(() => assertReadOnlySql(bypass.sql), bypass.sql).not.toThrow();
    }
  });

  it('keeps a closed bypass in the list as history, and proves it is closed', () => {
    const closed = KNOWN_BYPASSES.filter((one) => one.nowRefused !== undefined);
    expect(closed.length).toBeGreaterThan(0);
    for (const bypass of closed) {
      expect(() => assertReadOnlySql(bypass.sql), bypass.sql).toThrow();
    }
  });
});

describe('sql_query', () => {
  const tool = (up: boolean) => createSqlQueryTool(tunnel, { probeTcp: async () => up });

  it('is human-only, read-only and stays visible with the tunnel closed', () => {
    // requires:['tunnel.postgres'] прятал бы инструмент ровно тогда, когда его
    // объяснение и есть весь его смысл — и модель заключила бы, что такой
    // возможности нет вовсе, вместо «туннель закрыт».
    expect(tool(true).profiles).toEqual(['human']);
    expect(tool(true).access).toBe('ro');
    expect(tool(true).requires).toBeUndefined();
  });

  it('says in the first sentence of its description that it cannot run a query yet', () => {
    // Иначе модель зовёт его в цикле и каждый раз получает отказ, не понимая,
    // что инструмент в принципе не работает.
    expect(tool(true).description.startsWith('PREFLIGHT ONLY')).toBe(true);
    expect(tool(true).description).toContain('read-only database role that does not exist yet');
  });

  it('names the redaction contract the executor will have to honour', () => {
    // §8 запрещает дамп /admin/config на HTTP-слое; `SELECT value FROM config`
    // возвращает ровно тот же payload в обход этого запрета.
    expect(tool(true).description).toContain('denylist');
  });

  it('refuses the bot profile before touching anything, and says why', async () => {
    // Самый рискованный из трёх инструментов объяснял отказ короче остальных
    // двух. «Нельзя» без причины читается как настраиваемое ограничение.
    const ctx = makeCtx({ profile: 'bot' });
    const message = await refusal(
      tool(true).handler({ target: 'postgres', sql: 'select 1 limit 1', limit: 100 }, ctx),
    );
    expect(message).toMatch(/human/);
    expect(message).toMatch(/not a boundary/i);
  });

  it('refuses a closed tunnel with the exact ssh command, not a timeout', async () => {
    const ctx = makeCtx({});
    await expect(
      tool(false).handler({ target: 'postgres', sql: 'select 1 limit 1', limit: 100 }, ctx),
    ).rejects.toThrow(/ssh -L 18099:192\.0\.2\.10:8099/);
  });

  it('explains that MySQL has no reachable port at all', async () => {
    const ctx = makeCtx({});
    await expect(
      tool(true).handler({ target: 'mysql', sql: 'select 1 limit 1', limit: 100 }, ctx),
    ).rejects.toThrow(/3306/);
  });

  it('enforces the row cap it advertises instead of only printing it', async () => {
    const ctx = makeCtx({});
    const missing = await refusal(
      tool(true).handler({ target: 'postgres', sql: 'SELECT * FROM users', limit: 100 }, ctx),
    );
    expect(missing).toMatch(/LIMIT/);
    const tooBig = await refusal(
      tool(true).handler(
        { target: 'postgres', sql: 'SELECT * FROM users LIMIT 5000', limit: 100 },
        ctx,
      ),
    );
    expect(tooBig).toMatch(/5000/);
    // SHOW/EXPLAIN/DESCRIBE ограничены схемой, а не строками — LIMIT к ним не
    // приписывается, и требовать его значило бы отвергать корректный запрос.
    const shown = await refusal(
      tool(true).handler({ target: 'postgres', sql: 'SHOW TABLES', limit: 100 }, ctx),
    );
    expect(shown).toMatch(/read-only role/);
  });

  it('refuses to run under the admin account when the read-only role is missing', async () => {
    const ctx = makeCtx({});
    const message = await refusal(
      tool(true).handler({ target: 'postgres', sql: 'select 1 limit 1', limit: 100 }, ctx),
    );
    expect(message).toMatch(/read-only role/);
    // Отказ обязан назвать и то, что предполётные проверки прошли: иначе
    // оператор чинит туннель, который и так открыт.
    expect(message).toMatch(/preflight passed/i);
  });
});
