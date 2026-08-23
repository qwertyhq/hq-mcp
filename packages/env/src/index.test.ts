import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, backendPresence, loadConfig } from './index.js';

const base: NodeJS.ProcessEnv = {
  SHM_BASE_URL: 'https://billing.example.com/shm/v1/',
  SHM_ADMIN_AUTH: 'mcp:secret',
  REMNA_BASE_URL: 'https://panel.example.com',
  REMNA_API_TOKEN: 'jwt-token',
};

function withSecretDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hq-mcp-secret-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function caughtConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  describe('protected backend secret files', () => {
    it('loads both backend credentials from mode-0600 regular files', () => {
      withSecretDir((dir) => {
        const shm = join(dir, 'shm_admin_auth');
        const remna = join(dir, 'remna_api_token');
        writeFileSync(shm, 'mcp:file-password\n', { mode: 0o600 });
        writeFileSync(remna, 'file-remna-token-0123456789\n', { mode: 0o600 });
        const env = { ...base };
        delete env.SHM_ADMIN_AUTH;
        delete env.REMNA_API_TOKEN;
        env.SHM_ADMIN_AUTH_FILE = shm;
        env.REMNA_API_TOKEN_FILE = remna;

        const cfg = loadConfig(env);
        expect(cfg.shm?.auth).toBe('mcp:file-password');
        expect(cfg.remna?.token).toBe('file-remna-token-0123456789');
      });
    });

    it('treats a credential _FILE as backend presence and reports the missing base URL', () => {
      withSecretDir((dir) => {
        const shm = join(dir, 'shm_admin_auth');
        writeFileSync(shm, 'mcp:file-password\n', { mode: 0o600 });
        const error = caughtConfigError(() =>
          loadConfig({ SHM_ADMIN_AUTH_FILE: shm } as NodeJS.ProcessEnv),
        );
        expect(error.variable).toBe('SHM_BASE_URL');
        expect(error.message).toMatch(/^Missing required environment variable SHM_BASE_URL/);
      });
    });

    it('rejects direct and file sources together without exposing either value', () => {
      withSecretDir((dir) => {
        const shm = join(dir, 'shm_admin_auth');
        const fileValue = 'example-file-password-0123456789';
        writeFileSync(shm, `${fileValue}\n`, { mode: 0o600 });
        const env = { ...base };
        env.SHM_ADMIN_AUTH_FILE = shm;
        const error = caughtConfigError(() => loadConfig(env));
        expect(error.variable).toBe('SHM_ADMIN_AUTH');
        expect(error.message).not.toContain(fileValue);
        expect(error.message).not.toContain(base.SHM_ADMIN_AUTH);
        expect(error.message).not.toContain(shm);
      });
    });

    it.each([
      ['empty file', 'Secret file is empty', (dir: string) => {
        const path = join(dir, 'empty');
        writeFileSync(path, ' \n', { mode: 0o600 });
        return path;
      }],
      ['missing file', 'Cannot read protected secret file', (dir: string) => join(dir, 'missing')],
      ['directory', 'Protected secret file required', (dir: string) => {
        const path = join(dir, 'directory');
        mkdirSync(path, { mode: 0o700 });
        return path;
      }],
      ['symlink', 'Protected secret file required', (dir: string) => {
        const target = join(dir, 'target');
        const path = join(dir, 'link');
        writeFileSync(target, 'example-file-password-0123456789\n', { mode: 0o600 });
        symlinkSync(target, path);
        return path;
      }],
      ['group-readable file', 'Protected secret file required', (dir: string) => {
        const path = join(dir, 'group-readable');
        writeFileSync(path, 'example-file-password-0123456789\n', { mode: 0o640 });
        return path;
      }],
      ['world-readable file', 'Protected secret file required', (dir: string) => {
        const path = join(dir, 'world-readable');
        writeFileSync(path, 'example-file-password-0123456789\n', { mode: 0o644 });
        return path;
      }],
      ['non-0600 owner-only file', 'Protected secret file required', (dir: string) => {
        const path = join(dir, 'owner-read-only');
        writeFileSync(path, 'example-file-password-0123456789\n', { mode: 0o400 });
        return path;
      }],
    ] as const)('rejects a %s with a base-name-only ConfigError', (_case, message, makePath) => {
      withSecretDir((dir) => {
        const env: NodeJS.ProcessEnv = {
          ...base,
          ['SHM_ADMIN_AUTH_FILE']: makePath(dir),
        };
        delete env.SHM_ADMIN_AUTH;
        const error = caughtConfigError(() => loadConfig(env));
        expect(error.variable).toBe('SHM_ADMIN_AUTH');
        expect(error.message).toContain(message);
        expect(error.message).not.toContain(env.SHM_ADMIN_AUTH_FILE ?? 'impossible');
        expect(error.message).not.toContain('example-file-password-0123456789');
      });
    });

    it('treats a whitespace-only _FILE as absent', () => {
      const env = { ...base };
      delete env.SHM_ADMIN_AUTH;
      env.SHM_ADMIN_AUTH_FILE = '   ';
      const error = caughtConfigError(() => loadConfig(env));
      expect(error.variable).toBe('SHM_ADMIN_AUTH');
    });
  });

  it('fills defaults and strips the trailing slash from base urls', () => {
    const cfg = loadConfig(base);
    expect(cfg.shm?.baseUrl).toBe('https://billing.example.com/shm/v1');
    expect(cfg.shm?.auth).toBe('mcp:secret');
    expect(cfg.shm?.publicSecret).toBeUndefined();
    expect(cfg.remna?.baseUrl).toBe('https://panel.example.com');
    expect(cfg.mode).toBe('ro');
    expect(cfg.profile).toBe('human');
    expect(cfg.tunnel.postgres).toEqual({ host: '127.0.0.1', port: 16767 });
    expect(cfg.tunnel.mysql).toBeNull();
    // Дефолт — шаблон с плейсхолдерами вместо адресов внутренней сети: он
    // печатается в отказе закрытого туннеля, а своё значение приходит из
    // HQ_MCP_TUNNEL_SSH.
    expect(cfg.tunnel.sshCommand).toContain('ssh -L 18099:hook-host:8099');
    // Дефолт занижен вдвое относительно порога: ведро SHM общее на весь сервис.
    expect(cfg.budget).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it('reads the budget limits from the environment', () => {
    const cfg = loadConfig({ ...base, HQ_MCP_BUDGET_LIMIT: '12', HQ_MCP_BUDGET_WINDOW_MS: '30000' });
    expect(cfg.budget).toEqual({ limit: 12, windowMs: 30_000 });
    expect(() => loadConfig({ ...base, HQ_MCP_BUDGET_LIMIT: '0' })).toThrow(/HQ_MCP_BUDGET_LIMIT/);
    expect(() => loadConfig({ ...base, HQ_MCP_BUDGET_WINDOW_MS: 'soon' })).toThrow(
      /HQ_MCP_BUDGET_WINDOW_MS/,
    );
  });

  it('moves both tunnel endpoints when HQ_MCP_TUNNEL_HOST is set', () => {
    const cfg = loadConfig({
      ...base,
      HQ_MCP_TUNNEL_HOST: '192.0.2.99',
      HQ_MCP_TUNNEL_MYSQL_PORT: '13306',
    });
    expect(cfg.tunnel.postgres).toEqual({ host: '192.0.2.99', port: 16767 });
    expect(cfg.tunnel.mysql).toEqual({ host: '192.0.2.99', port: 13306 });
  });

  /**
   * КАЖДЫЙ БЭКЕНД НЕОБЯЗАТЕЛЕН, ОБЯЗАТЕЛЕН ХОТЯ БЫ ОДИН.
   *
   * Это и есть барьер входа, ради снятия которого правка написана: панель
   * Remnawave есть у каждого её оператора, SHM — нишевый биллинг, и требование
   * обеих не пускало на порог большинство. Четыре случая ниже — полный разбор:
   * обе, только биллинг, только панель, ни одной.
   */
  describe('each backend is optional and at least one is required', () => {
    // Половинки собираются ВЫЧИТАНИЕМ из `base`, а не перечислением: `KEY:
    // <выражение>` у секретного имени страж секретов (scripts/no-secrets.test.ts)
    // читает как присваивание настоящего значения, и правильный ответ на это —
    // не исключение из стража, а код, который на утечку не похож.
    const { REMNA_BASE_URL: _pu, REMNA_API_TOKEN: _pt, ...shmOnly } = base;
    const { SHM_BASE_URL: _bu, SHM_ADMIN_AUTH: _ba, ...remnaOnly } = base;

    it('loads with both, which stays the ordinary case', () => {
      const cfg = loadConfig(base);
      expect(cfg.shm).not.toBeNull();
      expect(cfg.remna).not.toBeNull();
      expect(backendPresence(cfg)).toEqual({ shm: true, remna: true });
    });

    it('loads with SHM alone and leaves the panel null', () => {
      const cfg = loadConfig(shmOnly);
      expect(cfg.shm?.baseUrl).toBe('https://billing.example.com/shm/v1');
      expect(cfg.remna).toBeNull();
      expect(backendPresence(cfg)).toEqual({ shm: true, remna: false });
    });

    it('loads with the panel alone and leaves SHM null', () => {
      const cfg = loadConfig(remnaOnly);
      expect(cfg.remna?.baseUrl).toBe('https://panel.example.com');
      expect(cfg.shm).toBeNull();
      expect(backendPresence(cfg)).toEqual({ shm: false, remna: true });
    });

    /**
     * Отказ обязан назвать ПОЛОЖЕНИЕ ДЕЛ, а не первую недостающую переменную.
     * «Missing required environment variable SHM_BASE_URL» посылает человека
     * настраивать биллинг, которого у него нет и который ему не нужен.
     */
    it('refuses an empty configuration by naming the choice, not the first variable', () => {
      let caught: unknown;
      try {
        loadConfig({});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      expect(err.message).toContain('Neither of the two backends is configured');
      expect(err.message).toContain('At least ONE pair is required');
      // Обе пары названы поимённо: человек обязан увидеть, что выбор есть.
      for (const name of ['SHM_BASE_URL', 'SHM_ADMIN_AUTH', 'REMNA_BASE_URL', 'REMNA_API_TOKEN']) {
        expect(err.message).toContain(name);
      }
      // Подсказка своя, а не общая «задайте <variable>»: у этого отказа два
      // правильных ответа, и один из них не трогает названную переменную.
      expect(err.hint).toContain('EITHER');
      expect(err.message).not.toMatch(/^Missing required environment variable/);
    });

    /**
     * ПОЛОВИНЧАТЫЙ БЭКЕНД — ЭТО ОШИБКА, А НЕ ВЫБОР. Забытый пароль обязан
     * остановить старт: молча выбросив такой бэкенд, сервер поднялся бы без
     * тринадцати инструментов, и объяснения этому не было бы нигде.
     */
    it('refuses a half-configured backend instead of quietly dropping it', () => {
      expect(() => loadConfig({ SHM_BASE_URL: base.SHM_BASE_URL })).toThrow(/SHM_ADMIN_AUTH/);
      expect(() => loadConfig({ SHM_ADMIN_AUTH: 'mcp:secret' })).toThrow(/SHM_BASE_URL/);
      expect(() => loadConfig({ REMNA_BASE_URL: base.REMNA_BASE_URL })).toThrow(/REMNA_API_TOKEN/);
      expect(() => loadConfig({ ...shmOnly, REMNA_BASE_URL: base.REMNA_BASE_URL })).toThrow(
        /REMNA_API_TOKEN/,
      );
    });

    /** Пустая строка — это «не задано», а не «задано пустым». */
    it('treats a blank value as unset rather than as a configured backend', () => {
      const cfg = loadConfig({ ...remnaOnly, SHM_BASE_URL: '   ', SHM_ADMIN_AUTH: '' });
      expect(cfg.shm).toBeNull();
    });

    /**
     * `SHM_PUBLIC_SECRET` НЕ включает биллинг: он необязателен и сам по себе
     * ничего не настраивает. Иначе оставшаяся от прошлой конфигурации строка
     * требовала бы пароля к системе, которой здесь больше нет.
     */
    it('does not let an optional SHM variable alone demand the required pair', () => {
      const cfg = loadConfig({ ...remnaOnly, SHM_PUBLIC_SECRET: 'left-over' });
      expect(cfg.shm).toBeNull();
    });
  });

  it('explains which variable is missing instead of throwing something vague', () => {
    const { REMNA_API_TOKEN: _drop, ...withoutToken } = base;
    let caught: unknown;
    try {
      loadConfig(withoutToken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.variable).toBe('REMNA_API_TOKEN');
    expect(err.message).toContain('REMNA_API_TOKEN');
    expect(err.message).toContain('Bearer');
  });

  it('rejects garbage in HQ_MCP_MODE and HQ_MCP_PROFILE', () => {
    expect(() => loadConfig({ ...base, HQ_MCP_MODE: 'write' })).toThrow(/HQ_MCP_MODE/);
    expect(() => loadConfig({ ...base, HQ_MCP_PROFILE: 'root' })).toThrow(/HQ_MCP_PROFILE/);
  });

  it('accepts rw mode, bot profile, public secret and tunnel overrides', () => {
    const cfg = loadConfig({
      ...base,
      HQ_MCP_MODE: 'rw',
      HQ_MCP_PROFILE: 'bot',
      SHM_PUBLIC_SECRET: 'shm-all',
      HQ_MCP_AUDIT_PATH: '/tmp/hq/audit.jsonl',
      HQ_MCP_SNAPSHOT_DIR: '/tmp/hq/snapshots',
      HQ_MCP_TUNNEL_ABUSE_URL: 'http://127.0.0.1:28099/',
      HQ_MCP_TUNNEL_PG_PORT: '15432',
      HQ_MCP_TUNNEL_MYSQL_PORT: '13306',
    });
    expect(cfg.mode).toBe('rw');
    expect(cfg.profile).toBe('bot');
    expect(cfg.shm?.publicSecret).toBe('shm-all');
    expect(cfg.auditPath).toBe('/tmp/hq/audit.jsonl');
    expect(cfg.snapshotDir).toBe('/tmp/hq/snapshots');
    expect(cfg.tunnel.abuseUrl).toBe('http://127.0.0.1:28099');
    expect(cfg.tunnel.postgres.port).toBe(15432);
    expect(cfg.tunnel.mysql).toEqual({ host: '127.0.0.1', port: 13306 });
  });

  /**
   * SHM пишет даты локальным временем сервера без офсета (Core::Utils::now —
   * strftime + localtime, app/lib/Core/Utils.pm:133-141), а сервер живёт в
   * Europe/Moscow: TZ прибит в docker-compose.staging.yml:27,
   * docker-compose.test.yml:24, contributing/docker-compose.yml:25 и
   * helm/k8s-shm/values.yaml, в прод-компоузах он приходит через ${TZ}. Без
   * этой зоны любой возраст задачи считается с ошибкой ровно в офсет.
   */
  it('defaults the SHM timezone to the one the stands actually run in', () => {
    expect(loadConfig(base).shmTz).toBe('Europe/Moscow');
    expect(loadConfig({ ...base, HQ_MCP_SHM_TZ: 'UTC' }).shmTz).toBe('UTC');
  });

  it('rejects a timezone the platform does not know instead of silently using UTC', () => {
    expect(() => loadConfig({ ...base, HQ_MCP_SHM_TZ: 'Mars/Olympus' })).toThrow(/HQ_MCP_SHM_TZ/);
  });

  /**
   * `GET /report` у abuse-хука закрыт общим секретом
   * (services/shm-abuse-guard/guard-hook.py:260-262 — `X-Guard-Token`, файл
   * `.guard-hook-secret` на хосте SHM). Без него инструмент получал бы 403 при
   * полностью исправном туннеле и рапортовал бы «туннель закрыт».
   */
  it('carries the abuse-guard hook token when it is configured, and omits it otherwise', () => {
    expect(loadConfig(base).tunnel.abuseToken).toBeUndefined();
    expect(loadConfig({ ...base, HQ_MCP_GUARD_HOOK_TOKEN: '  s3cr3t  ' }).tunnel.abuseToken).toBe(
      's3cr3t',
    );
    expect(loadConfig({ ...base, HQ_MCP_GUARD_HOOK_TOKEN: '   ' }).tunnel.abuseToken).toBeUndefined();
  });

  it('rejects a base url that is not a url at all', () => {
    expect(() => loadConfig({ ...base, SHM_BASE_URL: 'billing.example.com' })).toThrow(
      /SHM_BASE_URL/,
    );
  });

  /**
   * Потолок одной денежной операции (§5.2). Живёт в конфиге, а не в
   * `tools/mutations`: второй читатель того же значения — это второй дефолт,
   * который однажды разъедется с первым, и потолок молча станет другим.
   */
  it('reads the ceiling of a single money operation and refuses garbage', () => {
    expect(loadConfig(base).mutations).toEqual({ maxOpAmount: 5000, maxBulkUsers: 100 });
    expect(loadConfig({ ...base, HQ_MCP_MAX_OP_AMOUNT: '1500' }).mutations.maxOpAmount).toBe(1500);
    // Тихий откат к дефолту на опечатке — потолок, о котором оператор думает,
    // что поднял его, а он остался прежним.
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_OP_AMOUNT: '0' })).toThrow(/HQ_MCP_MAX_OP_AMOUNT/);
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_OP_AMOUNT: '-5' })).toThrow(
      /HQ_MCP_MAX_OP_AMOUNT/,
    );
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_OP_AMOUNT: 'много' })).toThrow(
      /HQ_MCP_MAX_OP_AMOUNT/,
    );
  });

  it('refuses a ceiling above the hard maximum instead of quietly clamping it', () => {
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_OP_AMOUNT: '999999' })).toThrow(/100000/);
  });

  /**
   * Потолок массовой операции живёт рядом с денежным и по той же причине:
   * второй читатель со своим дефолтом — это второй потолок. Дефолт 100 заведомо
   * меньше реального флота учёток, то есть `bulk/all/*` не проходит без явного
   * поднятия границы, и это его прямое назначение, а не побочный эффект.
   */
  it('reads the ceiling on how many clients one bulk operation may touch', () => {
    expect(loadConfig(base).mutations.maxBulkUsers).toBe(100);
    expect(loadConfig({ ...base, HQ_MCP_MAX_BULK_USERS: '1200' }).mutations.maxBulkUsers).toBe(1200);
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_BULK_USERS: '0' })).toThrow(
      /HQ_MCP_MAX_BULK_USERS/,
    );
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_BULK_USERS: '-1' })).toThrow(
      /HQ_MCP_MAX_BULK_USERS/,
    );
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_BULK_USERS: 'все' })).toThrow(
      /HQ_MCP_MAX_BULK_USERS/,
    );
  });

  it('refuses a bulk ceiling above the hard maximum — a slipped zero is not a policy', () => {
    expect(() => loadConfig({ ...base, HQ_MCP_MAX_BULK_USERS: '999999' })).toThrow(/10000/);
  });

  /**
   * Журнал мутаций и снимки планов держат СЫРЫЕ значения: пароли троянов,
   * vless-uuid, адреса подписок и почты. Дефолтные пути ведут в рабочую копию
   * ПУБЛИЧНОГО репозитория, поэтому «не попадает в git» — свойство, которое
   * обязано проверяться, а не подразумеваться.
   */
  it('keeps the default journal and snapshot paths out of the published repository', () => {
    const cfg = loadConfig(base);
    for (const target of [cfg.auditPath, cfg.snapshotDir]) {
      const check = spawnSync('git', ['check-ignore', '-q', target], { cwd: process.cwd() });
      expect({ target, ignored: check.status }).toEqual({ target, ignored: 0 });
    }
  });
});
