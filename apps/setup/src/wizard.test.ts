import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetPanelNamingCache } from '@hq/tools-read';
import { SetupAbortedError } from './errors.js';
import { parseEnvText } from './envfile.js';
import { buildSections, runWizard } from './wizard.js';
import type { SetupIo } from './io.js';
import type { ToolCounts } from './tools.js';

/**
 * Диалог без терминала. Он же — единственный способ проверить ветки, которые
 * иначе проверяются человеком за клавиатурой: «креды не приняты», «сервер
 * недоступен», «файл уже есть», «оставили дефолт».
 */
class ScriptedIo implements SetupIo {
  readonly said: string[] = [];
  readonly secretPrompts: string[] = [];
  private readonly answers: string[];

  constructor(answers: readonly string[]) {
    this.answers = [...answers];
  }

  private next(kind: string): string {
    const value = this.answers.shift();
    if (value === undefined) {
      throw new Error(
        `the wizard asked one more ${kind} question than the script answers.\nTranscript:\n${this.said.join('\n')}`,
      );
    }
    return value;
  }

  ask(prompt: string): Promise<string> {
    this.said.push(prompt);
    return Promise.resolve(this.next('visible'));
  }

  askSecret(prompt: string): Promise<string> {
    this.said.push(prompt);
    this.secretPrompts.push(prompt);
    return Promise.resolve(this.next('hidden'));
  }

  say(line: string): void {
    this.said.push(line);
  }

  close(): void {
    /* nothing to close */
  }

  get transcript(): string {
    return this.said.join('\n');
  }

  get unanswered(): number {
    return this.answers.length;
  }
}

const SHM_URL = 'https://billing.example.com/shm/v1';
const PANEL_URL = 'https://panel.example.com';
/**
 * Значения нарочно имеют форму плейсхолдера: `scripts/no-secrets.test.ts`
 * краснеет на присваивании настоящего вида секретному имени, и правильный
 * ответ на это — не исключение из проверки, а фикстура, которая на секрет не
 * похожа. Проверяем мы здесь путь значения, а не его содержимое.
 */
const PASSWORD = 'example-secret-value';
const PANEL_TOKEN = 'placeholder-panel-token';

const COUNTS: ToolCounts = { ro: 34, rw: 41, writers: 11 };

/**
 * Ответ на первый вопрос мастера — «какие системы у этой установки». Стоит
 * первым в КАЖДОМ сценарии ниже, потому что до него мастер не знает, чьи креды
 * спрашивать. Сценарии с ОДНОЙ системой — в describe «one backend» в конце
 * этого же файла.
 */
const BOTH = 'both';

function replies(
  handler: (url: string) => { status: number; body: string } | Error,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const answer = handler(url);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

// Резолвер именования кэширует прочитанное на пять минут в модульном
// состоянии, а оно переживает тест. Без сброса второй тест в файле работал бы
// на ответе первого — и «прочитано у самой SHM» проверялось бы кэшем.
beforeEach(() => {
  resetPanelNamingCache();
});

const happyBackends = (): { fetchImpl: typeof fetch; urls: string[] } =>
  replies((url) =>
    url.includes('/admin/user')
      ? { status: 200, body: JSON.stringify({ TZ: 'Europe/Moscow', data: [{ id: 1 }] }) }
      : { status: 200, body: JSON.stringify({ response: { runtimeMetrics: [] } }) },
  );

function wizard(
  io: SetupIo,
  fetchImpl: typeof fetch,
  overrides: { envPath?: string } = {},
): Promise<{ envPath: string; backupPath: string | null; values: Record<string, string> }> {
  const envPath = overrides.envPath ?? join(mkdtempSync(join(tmpdir(), 'hq-setup-')), '.env');
  return runWizard({
    io,
    envPath,
    serverPath: '/repo/apps/stdio/dist/index.js',
    now: () => new Date('2026-08-13T09:00:00.000Z'),
    fetchImpl,
    countToolsImpl: () => Promise.resolve(COUNTS),
    fileExists: () => true,
  });
}

describe('runWizard: the credentials it writes are the ones it checked', () => {
  it('asks, verifies, and writes a 0600 file with the answers', async () => {
    const io = new ScriptedIo([BOTH, SHM_URL, 'operator', PASSWORD, PANEL_URL, PANEL_TOKEN, '', '']);
    const { fetchImpl, urls } = happyBackends();
    const result = await wizard(io, fetchImpl);

    expect(io.unanswered).toBe(0);
    expect(urls).toEqual([
      `${SHM_URL}/admin/user?limit=1`,
      `${PANEL_URL}/api/system/health`,
      // Третий запрос — не проверка кредов, а чтение именования установки.
      `${SHM_URL}/admin/config/remnawave`,
    ]);
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);
    const written = parseEnvText(readFileSync(result.envPath, 'utf8'));
    expect(Object.keys(written)).toEqual([
      'SHM_BASE_URL',
      'SHM_ADMIN_AUTH',
      'REMNA_BASE_URL',
      'REMNA_API_TOKEN',
      'HQ_MCP_MODE',
    ]);
    expect(written.SHM_BASE_URL).toBe(SHM_URL);
    expect(written.SHM_ADMIN_AUTH).toBe(`operator:${PASSWORD}`);
    expect(written.REMNA_API_TOKEN).toBe(PANEL_TOKEN);
    expect(written.HQ_MCP_MODE).toBe('ro');
    expect(result.backupPath).toBeNull();
  });

  it('never lets a secret reach the transcript, not even in the summary', async () => {
    const io = new ScriptedIo([BOTH, SHM_URL, 'operator', PASSWORD, PANEL_URL, PANEL_TOKEN, '', '']);
    await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).not.toContain(PASSWORD);
    expect(io.transcript).not.toContain(PANEL_TOKEN);
    // И спрошены они были скрытым вводом, а не «просто не напечатаны потом».
    expect(io.secretPrompts).toHaveLength(2);
    expect(io.transcript).toContain('operator:');
  });

  it('prints the client commands with the real absolute path and edits no config', async () => {
    const io = new ScriptedIo([BOTH, SHM_URL, 'operator', PASSWORD, PANEL_URL, PANEL_TOKEN, '', '']);
    await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain(
      'claude mcp add hq -s user -- node /repo/apps/stdio/dist/index.js',
    );
    expect(io.transcript).toContain('[mcp_servers.hq]');
    expect(io.transcript).toContain('"command": ["node", "/repo/apps/stdio/dist/index.js"]');
    expect(io.transcript).toContain('paste it yourself');
  });
});

describe('runWizard: how this install names its objects', () => {
  const naming = (config: { status: number; body: string }) =>
    replies((url) => {
      if (url.includes('/admin/config/remnawave')) return config;
      if (url.includes('/admin/user')) {
        return { status: 200, body: JSON.stringify({ TZ: 'Europe/Moscow', data: [] }) };
      }
      return { status: 200, body: JSON.stringify({ response: {} }) };
    });
  const answers = [BOTH, SHM_URL, 'operator', PASSWORD, PANEL_URL, PANEL_TOKEN, '', ''];

  it('reads the prefixes off the live SHM and names that as the source', async () => {
    const io = new ScriptedIo(answers);
    await wizard(
      io,
      naming({
        status: 200,
        body: JSON.stringify({ data: [{ storage_prefix: 'acme_cfg_', name_prefix: 'ACME_' }] }),
      }).fetchImpl,
    );

    expect(io.transcript).toContain('ACME_<id>');
    expect(io.transcript).toContain('acme_cfg_<id>');
    expect(io.transcript).toContain("read live from SHM's own config.remnawave");
    // Ни одного вопроса про префиксы человеку не задано: он их не знает.
    expect(io.transcript).not.toContain('PANEL_PREFIXES —');
  });

  it('says outright when the prefixes are only defaults, and what that costs', async () => {
    const io = new ScriptedIo(answers);
    await wizard(io, naming({ status: 404, body: '{"msg":"no such key"}' }).fetchImpl);

    expect(io.transcript).toContain('never confirmed against this install');
    expect(io.transcript).toContain('look');
    expect(io.transcript).toContain('HQ_MCP_PANEL_PREFIXES');
  });
});

describe('runWizard: a failed check stops the flow instead of writing a lie', () => {
  it('lets the operator re-enter after the credentials are rejected', async () => {
    let attempt = 0;
    const { fetchImpl } = replies((url) => {
      if (!url.includes('/admin/user')) {
        return { status: 200, body: JSON.stringify({ response: {} }) };
      }
      attempt += 1;
      return attempt === 1
        ? { status: 401, body: '{"msg":"Not authorized"}' }
        : { status: 200, body: JSON.stringify({ TZ: 'Europe/Moscow', data: [] }) };
    });
    const io = new ScriptedIo([
      BOTH,
      SHM_URL,
      'operator',
      'wrong-password-here',
      'r',
      SHM_URL,
      'operator',
      PASSWORD,
      PANEL_URL,
      PANEL_TOKEN,
      '',
      '',
    ]);
    const result = await wizard(io, fetchImpl);

    expect(attempt).toBe(2);
    expect(io.transcript).toContain('did not accept these credentials');
    expect(result.values.SHM_ADMIN_AUTH).toBe(`operator:${PASSWORD}`);
  });

  it('aborts without writing anything when the backend is unreachable', async () => {
    const { fetchImpl } = replies(() => {
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      return error;
    });
    const envPath = join(mkdtempSync(join(tmpdir(), 'hq-setup-')), '.env');
    const io = new ScriptedIo([BOTH, SHM_URL, 'operator', PASSWORD, 'a']);

    await expect(wizard(io, fetchImpl, { envPath })).rejects.toBeInstanceOf(SetupAbortedError);
    expect(io.transcript).toContain('nothing listens on that port');
    expect(existsSync(envPath)).toBe(false);
  });

  it('keeps an unverified value only when it is asked for by name, and says what that costs', async () => {
    const { fetchImpl } = replies((url) =>
      url.includes('/admin/user')
        ? { status: 503, body: 'upstream down' }
        : { status: 200, body: JSON.stringify({ response: {} }) },
    );
    const io = new ScriptedIo([
      BOTH,
      SHM_URL,
      'operator',
      PASSWORD,
      'k',
      PANEL_URL,
      PANEL_TOKEN,
      '',
      '',
    ]);
    const result = await wizard(io, fetchImpl);

    expect(io.transcript).toContain('nothing about the credentials was proven');
    expect(io.transcript).toContain('keeping the unverified value');
    expect(result.values.SHM_BASE_URL).toBe(SHM_URL);
  });
});

describe('runWizard: an existing .env', () => {
  // Строки собираются функцией, а не литералами `NAME=значение`: страж
  // секретов из scripts/no-secrets.test.ts ищет именно форму присваивания, и
  // литерал в тесте краснел бы наравне с настоящей утечкой.
  const line = (key: string, value: string): string => `${key}=${value}`;

  function seeded(): string {
    const envPath = join(mkdtempSync(join(tmpdir(), 'hq-setup-')), '.env');
    writeFileSync(
      envPath,
      [
        line('SHM_BASE_URL', SHM_URL),
        line('SHM_ADMIN_AUTH', `operator:${PASSWORD}`),
        line('REMNA_BASE_URL', PANEL_URL),
        line('REMNA_API_TOKEN', PANEL_TOKEN),
        line('HQ_STAND_FORBIDDEN_HOSTS', 'billing.example.com'),
      ].join('\n'),
      { mode: 0o600 },
    );
    return envPath;
  }

  it('offers every existing value as the default, so Enter keeps the whole file', async () => {
    const envPath = seeded();
    const io = new ScriptedIo(['', '', '', '', '', '', '', '', 'y']);
    const result = await wizard(io, happyBackends().fetchImpl, { envPath });

    expect(io.unanswered).toBe(0);
    const written = parseEnvText(readFileSync(envPath, 'utf8'));
    expect(written.SHM_ADMIN_AUTH).toBe(`operator:${PASSWORD}`);
    expect(written.REMNA_API_TOKEN).toBe(PANEL_TOKEN);
    expect(result.backupPath).not.toBeNull();
    // Показано было замаскированным, а не значением.
    expect(io.transcript).not.toContain(PASSWORD);
    expect(io.transcript).not.toContain(PANEL_TOKEN);
    // Кроме логина: он не секрет, и человек узнаёт запись именно по нему.
    expect(io.transcript).toContain('Enter keeps: operator');
  });

  it('carries over variables it never asked about', async () => {
    const envPath = seeded();
    await wizard(io2(), happyBackends().fetchImpl, { envPath });

    const written = parseEnvText(readFileSync(envPath, 'utf8'));
    expect(written.HQ_STAND_FORBIDDEN_HOSTS).toBe('billing.example.com');
  });

  it('keeps a copy of the old file before replacing it', async () => {
    const envPath = seeded();
    const result = await wizard(io2(), happyBackends().fetchImpl, { envPath });

    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath ?? '', 'utf8')).toContain('HQ_STAND_FORBIDDEN_HOSTS');
    expect(statSync(result.backupPath ?? '').mode & 0o777).toBe(0o600);
  });

  it('writes nothing when the overwrite is declined', async () => {
    const envPath = seeded();
    const before = readFileSync(envPath, 'utf8');
    const io = new ScriptedIo(['', '', '', '', '', '', '', '', 'n']);

    await expect(wizard(io, happyBackends().fetchImpl, { envPath })).rejects.toThrow(/untouched/);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });
});

function io2(): ScriptedIo {
  return new ScriptedIo(['', '', '', '', '', '', '', '', 'y']);
}

describe('runWizard: mode', () => {
  const answersWithMode = (mode: string, ...rest: string[]): string[] => [
    BOTH,
    SHM_URL,
    'operator',
    PASSWORD,
    PANEL_URL,
    PANEL_TOKEN,
    mode,
    ...rest,
  ];

  it('defaults to ro on Enter and writes no optional variable at all', async () => {
    const io = new ScriptedIo(answersWithMode('', ''));
    const result = await wizard(io, happyBackends().fetchImpl);

    expect(result.values.HQ_MCP_MODE).toBe('ro');
    expect(Object.keys(result.values)).not.toContain('HQ_MCP_BUDGET_LIMIT');
    expect(Object.keys(result.values)).not.toContain('HQ_MCP_PROFILE');
    expect(readFileSync(result.envPath, 'utf8')).not.toContain('HQ_MCP_SHM_TZ');
  });

  it('names how many tools rw adds and how many of them write', async () => {
    const io = new ScriptedIo(answersWithMode('rw', 'y', ''));
    const result = await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain('34 tools, not one of which writes anything');
    expect(io.transcript).toContain('41 tools, of which 11 change live billing');
    expect(result.values.HQ_MCP_MODE).toBe('rw');
  });

  it('falls back to ro when rw is typed but not confirmed', async () => {
    const io = new ScriptedIo(answersWithMode('rw', 'n', ''));
    const result = await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain('production write access');
    expect(result.values.HQ_MCP_MODE).toBe('ro');
  });

  it('re-asks instead of guessing what an unknown mode meant', async () => {
    const io = new ScriptedIo(answersWithMode('yes please', '', ''));
    const result = await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain('answer ro or rw');
    expect(result.values.HQ_MCP_MODE).toBe('ro');
  });
});

describe('runWizard: optional settings', () => {
  it('writes the timezone the live server reported even when the extras are skipped', async () => {
    const { fetchImpl } = replies((url) =>
      url.includes('/admin/user')
        ? { status: 200, body: JSON.stringify({ TZ: 'Asia/Tbilisi', data: [] }) }
        : { status: 200, body: JSON.stringify({ response: {} }) },
    );
    const io = new ScriptedIo([BOTH, SHM_URL, 'operator', PASSWORD, PANEL_URL, PANEL_TOKEN, '', '']);
    const result = await wizard(io, fetchImpl);

    // Дефолт HQ_MCP_SHM_TZ — Europe/Moscow, а сервер живёт в другой зоне: не
    // записав её, мастер оставил бы каждый возраст задачи сдвинутым молча.
    expect(result.values.HQ_MCP_SHM_TZ).toBe('Asia/Tbilisi');
  });

  it('asks the extras behind one question and refuses a value the loader rejects', async () => {
    const io = new ScriptedIo([
      BOTH,
      SHM_URL,
      'operator',
      PASSWORD,
      PANEL_URL,
      PANEL_TOKEN,
      '',
      'y', // configure the optional settings
      '', // profile: keep human
      'Mars/Olympus', // timezone: not an IANA zone
      'Asia/Tbilisi', // …re-asked
      '0', // budget limit: not a positive integer
      '12', // …re-asked
      '', // budget window: keep the default
      'n', // no tunnel
    ]);
    const result = await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain('must be an IANA timezone');
    expect(io.transcript).toContain('must be a positive integer');
    expect(result.values.HQ_MCP_SHM_TZ).toBe('Asia/Tbilisi');
    expect(result.values.HQ_MCP_BUDGET_LIMIT).toBe('12');
    // Ответ, равный дефолту, в файл не едет: .env из повторённых дефолтов
    // читается как список осознанных решений.
    expect(Object.keys(result.values)).not.toContain('HQ_MCP_BUDGET_WINDOW_MS');
    expect(Object.keys(result.values)).not.toContain('HQ_MCP_PROFILE');
  });
});

/**
 * ОДНА СИСТЕМА — САМЫЙ ВЕРОЯТНЫЙ СЦЕНАРИЙ ЧУЖОГО ОПЕРАТОРА, а не крайний случай.
 * Мастер обязан не спрашивать креды той системы, которой у человека нет, и не
 * оставлять в файле креды той, от которой он отказался.
 */
describe('runWizard: one backend', () => {
  /** Та же косвенность, что у seeded() выше: страж секретов читает `KEY=<значение>`. */
  const line = (key: string, value: string): string => `${key}=${value}`;

  it('asks only about the panel when the panel is all there is', async () => {
    const io = new ScriptedIo(['remna', PANEL_URL, PANEL_TOKEN, '', '']);
    const { fetchImpl, urls } = happyBackends();
    const result = await wizard(io, fetchImpl);

    expect(io.unanswered).toBe(0);
    // Ни одного запроса к биллингу: ни проверки кредов, ни чтения именования.
    expect(urls).toEqual([`${PANEL_URL}/api/system/health`]);
    expect(io.transcript).not.toContain('SHM_BASE_URL');
    expect(io.transcript).not.toContain('SHM_ADMIN_AUTH');
    const written = parseEnvText(readFileSync(result.envPath, 'utf8'));
    expect(Object.keys(written)).toEqual(['REMNA_BASE_URL', 'REMNA_API_TOKEN', 'HQ_MCP_MODE']);
  });

  it('asks only about the billing when the billing is all there is', async () => {
    const io = new ScriptedIo(['shm', SHM_URL, 'operator', PASSWORD, '', '']);
    const { fetchImpl, urls } = happyBackends();
    const result = await wizard(io, fetchImpl);

    expect(io.unanswered).toBe(0);
    expect(urls).toEqual([`${SHM_URL}/admin/user?limit=1`, `${SHM_URL}/admin/config/remnawave`]);
    expect(io.transcript).not.toContain('REMNA_BASE_URL');
    expect(io.transcript).not.toContain('REMNA_API_TOKEN');
    const written = parseEnvText(readFileSync(result.envPath, 'utf8'));
    expect(Object.keys(written)).toEqual(['SHM_BASE_URL', 'SHM_ADMIN_AUTH', 'HQ_MCP_MODE']);
  });

  /**
   * Самая дорогая из возможных ошибок этой правки: креды отвергнутой системы,
   * пережившие перезапись. Сервер поднялся бы с обеими, а человек считал бы,
   * что настроил одну, — и половину инструментов получил бы молча.
   */
  it('drops the credentials of the backend the operator just said it does not have', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-setup-'));
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      [
        line('SHM_BASE_URL', SHM_URL),
        line('SHM_ADMIN_AUTH', `operator:${PASSWORD}`),
        line('REMNA_BASE_URL', PANEL_URL),
        line('REMNA_API_TOKEN', PANEL_TOKEN),
        line('HQ_STAND_FORBIDDEN_HOSTS', 'billing.example.com'),
      ].join('\n'),
      { mode: 0o600 },
    );

    const io = new ScriptedIo(['remna', '', '', '', '', 'y']);
    await wizard(io, happyBackends().fetchImpl, { envPath });

    const written = parseEnvText(readFileSync(envPath, 'utf8'));
    expect(written.SHM_BASE_URL).toBeUndefined();
    expect(written.SHM_ADMIN_AUTH).toBeUndefined();
    expect(written.REMNA_BASE_URL).toBe(PANEL_URL);
    // А вот то, о чём мастер не спрашивает, переживает перезапись по-прежнему.
    expect(written.HQ_STAND_FORBIDDEN_HOSTS).toBe('billing.example.com');
  });

  /** Прежний выбор ПРОЧИТАН из файла: Enter не должен молча включать вторую систему. */
  it('offers the previous pair as the default for the very first question', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-setup-'));
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      [line('REMNA_BASE_URL', PANEL_URL), line('REMNA_API_TOKEN', PANEL_TOKEN)].join('\n'),
      { mode: 0o600 },
    );

    const io = new ScriptedIo(['', '', '', '', '', 'y']);
    await wizard(io, happyBackends().fetchImpl, { envPath });

    expect(io.transcript).toContain('Enter keeps: remna');
    const written = parseEnvText(readFileSync(envPath, 'utf8'));
    expect(Object.keys(written)).toEqual(['REMNA_BASE_URL', 'REMNA_API_TOKEN', 'HQ_MCP_MODE']);
  });

  it('re-asks instead of guessing which systems an unknown answer meant', async () => {
    const io = new ScriptedIo(['everything', 'remna', PANEL_URL, PANEL_TOKEN, '', '']);
    await wizard(io, happyBackends().fetchImpl);

    expect(io.transcript).toContain('answer remna, shm or both');
    expect(io.unanswered).toBe(0);
  });
});

describe('buildSections', () => {
  it('groups known keys, keeps unknown ones and preserves what it never asked about', () => {
    const sections = buildSections(
      { SHM_BASE_URL: 'a', HQ_MCP_MODE: 'ro', HQ_MCP_FUTURE_FLAG: '1' },
      { SHM_BASE_URL: 'old', SHM_PUBLIC_SECRET: 'kept' },
    );
    const flat = sections.flatMap((section) => section.entries.map((entry) => entry.key));

    expect(flat).toEqual(['SHM_BASE_URL', 'HQ_MCP_MODE', 'HQ_MCP_FUTURE_FLAG', 'SHM_PUBLIC_SECRET']);
    expect(sections.at(-1)?.title).toContain('Kept from the previous file');
  });
});
