import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProbeStore, createRegistry, defineTool } from '@hq/registry';
import type { Registry } from '@hq/registry';
import type { ProbeResult, ToolContext, ToolDef } from '@hq/types';
import type { ExecResult, ToolOutcome } from './index.js';
import { executeTool, listVisibleTools } from './index.js';

const echo = defineTool({
  name: 'client_overview',
  description: 'echo',
  input: z.object({ shm_user_id: z.number().int(), note: z.string().default('none') }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  handler: async (input) => ({
    user_id: input.shm_user_id,
    note: input.note,
    trojanPassword: 'trojan-plaintext',
  }),
});

const boom = defineTool({
  name: 'spool_inspect',
  description: 'always fails',
  input: z.object({ status: z.string().nullable().default(null) }),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  handler: async () => {
    throw new Error('SHM answered 403');
  },
});

const empty = defineTool({
  name: 'infra_map',
  description: 'no input at all',
  input: z.object({}),
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  handler: async () => ({ nodes: [] }),
});

const gated = defineTool({
  name: 'sql_query',
  description: 'needs a tunnel',
  input: z.object({ sql: z.string() }),
  access: 'ro',
  risk: 'high',
  profiles: ['human'],
  requires: ['tunnel.postgres'],
  handler: async () => ({ rows: [] }),
});

const mutator = defineTool({
  name: 'billing_adjust',
  description: 'writes money',
  input: z.object({ money: z.number() }),
  access: 'rw',
  risk: 'high',
  profiles: ['human'],
  handler: async (input) => ({ money: input.money }),
});

function makeProbe(value: boolean | 'unknown'): ProbeResult {
  return {
    checkedAt: '2026-08-08T12:00:00.000Z',
    cached: false,
    shm: {
      configured: true,
      reachable: true,
      error: null,
      spoolStatuses: [],
      version: null,
      live: true,
      credentialsRejected: false,
    },
    remna: {
      configured: true,
      reachable: true,
      error: null,
      version: '2.8.0',
      credentialsRejected: false,
      runtime: null,
    },
    capabilities: {
      'shm.filter': 'unknown',
      'shm.dry_run': 'unknown',
      'remna.subscriptionRequestHistory': 'unknown',
      'remna.realtimeBandwidth': 'unknown',
      'tunnel.mysql': 'unknown',
      'tunnel.postgres': value,
      'tunnel.abuse': 'unknown',
    },
    warnings: [],
  };
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    shm: {} as ToolContext['shm'],
    remna: {} as ToolContext['remna'],
    backends: { shm: true, remna: true },
    profile: 'human',
    mode: 'ro',
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    // Обязательное поле ToolContext (packages/types/src/index.ts:119). Стоит ДО
    // спреда, чтобы тест мог его переопределить; без него не собирается
    // tsconfig.test.json, а `vitest run` этого не видит вовсе.
    shmTz: 'Europe/Moscow',
    probe: createProbeStore(),
    ...over,
  };
}

const registry = createRegistry([echo, boom, empty, gated, mutator]);

describe('ToolOutcome', () => {
  it('is the single outcome vocabulary and ExecResult is expressed through it', () => {
    // Проверка в первую очередь типовая: `pnpm typecheck` видит .test.ts, и если
    // ExecResult заведёт код вне ToolOutcome, красным станет typecheck, а не
    // уже запущенный сервер.
    const outcomes: ToolOutcome[] = ['ok', 'not_found', 'invalid_input', 'handler_failed'];
    const failure: ExecResult = { ok: false, code: 'handler_failed', message: 'x' };
    expect(outcomes).toHaveLength(4);
    expect(outcomes).toContain(failure.ok ? 'ok' : failure.code);
  });
});

describe('executeTool', () => {
  it('parses the input, applies defaults and redacts the result', async () => {
    const result = await executeTool('client_overview', { shm_user_id: 3073 }, {
      registry,
      ctx: makeCtx(),
    });
    expect(result).toEqual({
      ok: true,
      value: { user_id: 3073, note: 'none', trojanPassword: '<redacted>' },
    });
  });

  it('handles a tool with an empty input object', async () => {
    const result = await executeTool('infra_map', {}, { registry, ctx: makeCtx() });
    expect(result).toEqual({ ok: true, value: { nodes: [] } });
  });

  it('reports a bad input as invalid_input with the offending field', async () => {
    const result = await executeTool('client_overview', { shm_user_id: 'nope' }, {
      registry,
      ctx: makeCtx(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_input');
    expect(result.message).toContain('shm_user_id');
  });

  it('never reaches the handler with an input the schema rejects', async () => {
    // Единственное место, где вход инструмента вообще проверяется: defineTool
    // стирает схему, а Registry.register только убеждается, что parse есть.
    // Если этот тест позеленеет «сам собой» — валидации нет ни у кого.
    let calls = 0;
    const counting = defineTool({
      name: 'client_search',
      description: 'counts its own calls',
      input: z.object({ query: z.string() }),
      access: 'ro',
      risk: 'low',
      profiles: ['human'],
      handler: async () => {
        calls += 1;
        return { rows: [] };
      },
    });
    const local = createRegistry([counting]);
    const result = await executeTool('client_search', { query: 42 }, {
      registry: local,
      ctx: makeCtx(),
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toBe(0);
  });

  it('reports a throwing handler as handler_failed, not as a crash', async () => {
    const result = await executeTool('spool_inspect', {}, { registry, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('handler_failed');
    expect(result.message).toContain('SHM answered 403');
  });

  it('refuses an unknown tool and a tool the profile cannot see', async () => {
    const unknown = await executeTool('nope', {}, { registry, ctx: makeCtx() });
    expect(unknown).toMatchObject({ ok: false, code: 'not_found' });

    const hidden = await executeTool('spool_inspect', {}, {
      registry,
      ctx: makeCtx({ profile: 'bot' }),
    });
    expect(hidden).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses an rw tool while the process is in ro mode', async () => {
    const result = await executeTool('billing_adjust', { money: 100 }, {
      registry,
      ctx: makeCtx(),
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a tool whose required capability the probe found missing', async () => {
    const probe = createProbeStore(makeProbe(false));
    const result = await executeTool('sql_query', { sql: 'select 1' }, {
      registry,
      ctx: makeCtx({ probe }),
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    if (result.ok) return;
    expect(result.message).toContain('tunnel.postgres');
  });

  it('tells the human operator WHY, and tells the bot nothing at all', async () => {
    // Два текста, потому что аудитории две. human — оператор за stdio: «есть, но
    // туннель закрыт» это единственное, ради чего задача 18 сняла гейт по
    // requires. bot — HTTP-контур: там Registry.list уже прячет чужие
    // инструменты, и отличать «есть, но не для тебя» от «нет такого» значит
    // отдать перебор реестра.
    const botVisible = defineTool({
      name: 'country_health',
      description: 'visible to both, needs a tunnel',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      requires: ['tunnel.postgres'],
      handler: async () => ({ rows: [] }),
    });
    const botMutator = defineTool({
      name: 'billing_topup',
      description: 'visible to both, writes money',
      input: z.object({ money: z.number() }),
      access: 'rw',
      risk: 'high',
      profiles: ['human', 'bot'],
      handler: async () => ({ ok: true }),
    });
    const local = createRegistry([botVisible, botMutator]);
    const blind = createProbeStore(makeProbe(false));

    const asBot = async (tool: string, probe = createProbeStore()): Promise<string> => {
      const result = await executeTool(tool, {}, {
        registry: local,
        ctx: makeCtx({ profile: 'bot', probe }),
      });
      expect(result).toMatchObject({ ok: false, code: 'not_found' });
      return result.ok ? '' : result.message;
    };

    // Нет имени / чужой режим / возможность снята — одна строка на все случаи,
    // отличающаяся только именем, которое боту и так известно: он его прислал.
    expect(await asBot('made_up_tool')).toBe('Tool made_up_tool not found');
    expect(await asBot('billing_topup')).toBe('Tool billing_topup not found');
    expect(await asBot('country_health', blind)).toBe('Tool country_health not found');
    // Чужой профиль — тот же текст, из другого реестра.
    expect(
      await executeTool('spool_inspect', {}, { registry, ctx: makeCtx({ profile: 'bot' }) }),
    ).toEqual({ ok: false, code: 'not_found', message: 'Tool spool_inspect not found' });

    // Ни намёка на режим, профиль или снятую возможность.
    for (const tool of ['made_up_tool', 'billing_topup']) {
      expect(await asBot(tool)).not.toMatch(/profile|mode|human|rw\b|probe|tunnel/i);
    }
    expect(await asBot('country_health', blind)).not.toContain('tunnel.postgres');

    // А оператору — по-прежнему три разных, действующих текста.
    const humanBlind = await executeTool('country_health', {}, {
      registry: local,
      ctx: makeCtx({ probe: blind }),
    });
    expect(humanBlind).toMatchObject({ ok: false, code: 'not_found' });
    if (humanBlind.ok) return;
    expect(humanBlind.message).toContain('tunnel.postgres');
    expect(humanBlind.message).toContain('platform_probe');

    const humanUnknown = await executeTool('made_up_tool', {}, {
      registry: local,
      ctx: makeCtx(),
    });
    expect(humanUnknown).toMatchObject({ ok: false, code: 'not_found' });
    if (humanUnknown.ok) return;
    expect(humanUnknown.message).toContain('unknown tool');
    expect(humanUnknown.message).not.toBe(humanBlind.message);
  });

  it('answers a forbidden operation with the reason it will never exist', async () => {
    // §8 обещает, что модель, попросившая запрещённую операцию, получает
    // ПРИЧИНУ, а не «нет такого инструмента»: словарь объяснений живёт в
    // @hq/registry (explainRefusal), но его никто не звал — эта ветка и есть
    // единственное место, где просьба про запрещённое доезжает до отказа.
    const templates = await executeTool('template_edit', {}, { registry, ctx: makeCtx() });
    expect(templates).toMatchObject({ ok: false, code: 'not_found' });
    if (templates.ok) return;
    expect(templates.message).toContain('unknown tool');
    expect(templates.message).toContain('live billing logic');

    const identity = await executeTool('node_keygen', {}, { registry, ctx: makeCtx() });
    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.message).toContain('private SSH key');

    // Обычная опечатка объяснения не получает — его просто нет.
    const typo = await executeTool('client_overwiev', {}, { registry, ctx: makeCtx() });
    expect(typo).toMatchObject({ ok: false, code: 'not_found' });
    if (typo.ok) return;
    expect(typo.message).toBe('unknown tool "client_overwiev"');
  });

  it('keeps the bot answer a single string even for a forbidden operation', async () => {
    // Причина — это карта реестра: боту она рассказывает, ЧТО существует и
    // почему спрятано. У него по-прежнему одна строка на все случаи.
    const result = await executeTool('template_edit', {}, {
      registry,
      ctx: makeCtx({ profile: 'bot' }),
    });
    expect(result).toEqual({ ok: false, code: 'not_found', message: 'Tool template_edit not found' });
  });

  it('warns instead of refusing when the capability could not be verified', async () => {
    const probe = createProbeStore(makeProbe('unknown'));
    const result = await executeTool('sql_query', { sql: 'select 1' }, {
      registry,
      ctx: makeCtx({ probe }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { warnings?: Array<{ code: string; message: string }> };
    expect(value.warnings?.map((w) => w.code)).toContain('capability_unverified');
    expect(JSON.stringify(value.warnings)).toContain('platform_probe');
  });

  it('keeps existing warnings when it appends its own', async () => {
    const withWarnings = defineTool({
      name: 'country_health',
      description: 'has its own warnings',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human'],
      requires: ['tunnel.postgres'],
      handler: async () => ({ warnings: [{ code: 'panel_blind_to_relay_dataplane', message: 'x' }] }),
    });
    const local = createRegistry([withWarnings]);
    const result = await executeTool('country_health', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { warnings: Array<{ code: string }> };
    expect(value.warnings.map((w) => w.code)).toEqual([
      'panel_blind_to_relay_dataplane',
      'capability_unverified',
    ]);
  });
});

/**
 * Дословное тело бэкенда, вклеенное в текст: `packages/shm/src/client.ts:73`
 * и `:187`, `packages/remna/src/index.ts:105` и `:201` (по 200 символов),
 * `tools/read/src/abuse/report.ts:193` (300). `redact` его не видит — он
 * маскирует по имени ключа, а на голой строке не делает ничего. У stdio этот
 * текст уезжает прямо в контекст модели (план 1, Task 22).
 *
 * Отрезание идёт по МАРКЕРУ, а не по форме тела: два из пяти мест срабатывают
 * в `catch` у `JSON.parse`, то есть их тело заведомо НЕ JSON (HTML-страница
 * SHM, perl-traceback), и разбор по скобкам туда не дотягивался в принципе.
 */
describe('the handler_failed message', () => {
  function throwing(name: string, message: string): ReturnType<typeof createRegistry> {
    return createRegistry([
      defineTool({
        name,
        description: 'fails with a spliced backend body',
        input: z.object({}),
        access: 'ro',
        risk: 'none',
        profiles: ['human', 'bot'],
        handler: async () => {
          throw new Error(message);
        },
      }),
    ]);
  }

  it('drops a JSON body the client spliced into it, and keeps the rest', async () => {
    const local = throwing(
      'client_overview',
      'SHM GET /admin/user: HTTP 500: ' +
        '{"data":[{"user_id":3073,"login":"tg900001","password":"$2a$plain"}],"items":1}',
    );
    const result = await executeTool('client_overview', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('tg900001');
    expect(result.message).not.toContain('$2a$plain');
    // Диагностика остаётся: без метода, пути и статуса сообщение бесполезно.
    expect(result.message).toContain('SHM GET /admin/user');
    expect(result.message).toContain('HTTP 500');
    expect(result.message).toContain('<redacted>');
  });

  it('drops a body that was truncated mid-JSON by the client', async () => {
    // slice(0, 200) почти всегда режет объект посередине: закрывающей скобки
    // нет, и «вырезать до закрывающей» здесь не сработало бы.
    const local = throwing(
      'client_overview',
      'Remnawave GET /api/users: HTTP 502: ' +
        '{"response":{"username":"HQVPN_1861","trojanPassword":"plaintext-secret',
    );
    const result = await executeTool('client_overview', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('HQVPN_1861');
    expect(result.message).not.toContain('plaintext-secret');
    expect(result.message).toContain('Remnawave GET /api/users');
    expect(result.message).toContain('HTTP 502');
  });

  it('drops a body that is not JSON at all — an HTML page or a traceback', async () => {
    // packages/shm/src/client.ts:187 и packages/remna/src/index.ts:201 живут в
    // `catch` у JSON.parse: их тело НЕ может быть JSON по построению.
    const local = throwing(
      'client_overview',
      'SHM GET /admin/user returned a non-JSON body: ' +
        '<html><body>DBD::mysql::st execute failed for login tg900001 at Core/User.pm line 88',
    );
    const result = await executeTool('client_overview', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('tg900001');
    expect(result.message).not.toContain('<html>');
    expect(result.message).toBe('SHM GET /admin/user returned a non-JSON body: <redacted>');
  });

  it('drops a body that is a bare JSON string, not an object', async () => {
    const local = throwing('client_overview', 'SHM GET /admin/user: HTTP 500: "someone@gmail.com"');
    const result = await executeTool('client_overview', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('SHM GET /admin/user: HTTP 500: <redacted>');
  });

  it('cuts to the end of the text, prose included, once the marker is seen', async () => {
    // abuse_report ставит тело в СЕРЕДИНУ, а после него — инструкцию оператору
    // (tools/read/src/abuse/report.ts:191-199). Отделить одно от другого можно
    // только угадыванием, поэтому режется всё до конца строки: потерянная
    // подсказка дешевле выданной записи клиента. Заодно исчезает фраза «the
    // text above is that answer verbatim», которая после вырезания была бы
    // враньём. Чинится на стороне инструмента — тело должно стоять последним.
    const local = throwing(
      'abuse_report',
      'The abuse-guard hook answered HTTP 500: ' +
        '{"clients":[{"login":"tg900001","email":"someone@gmail.com"}]}. Something answered, ' +
        'so the tunnel carries traffic; the guard-hook log on the SHM host carries the reason.',
    );
    const result = await executeTool('abuse_report', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('someone@gmail.com');
    expect(result.message).not.toContain('tg900001');
    expect(result.message).toBe('The abuse-guard hook answered HTTP 500: <redacted>');
  });

  it('leaves prose alone: no marker, no cut, whatever the punctuation', async () => {
    // Отрезание по форме тела портило ровно такие строки: `(see [1] below)`
    // превращалось в `(see <redacted>2 below)`, а `[0-9]+_[a-z]+` — в мусор.
    const prose =
      'refused: the statement TEXT contains ";" [see KNOWN_BYPASSES] — send exactly one ' +
      'read-only statement (SELECT 1 LIMIT 1). Object keys look like {"status":"FAIL"} and ' +
      'names match [0-9]+_[a-z]+ (see [1] below).';
    const local = throwing('sql_query', prose);
    const result = await executeTool('sql_query', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(prose);
  });

  it('does the same for the bot profile, which is what §7.2 exists for', async () => {
    const local = throwing(
      'client_overview',
      'SHM GET /admin/user: HTTP 500: {"login":"tg900001","full_name":"Иван"}',
    );
    const result = await executeTool('client_overview', {}, {
      registry: local,
      ctx: makeCtx({ profile: 'bot' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('tg900001');
    expect(result.message).not.toContain('Иван');
  });
});

describe('the success path', () => {
  it('strips the same backend body out of the value, wherever the tool put it', async () => {
    // settle/take (tools/read/src/kit.ts:26-29, :49-57) кладут в
    // `degraded[].error` ДОСЛОВНОЕ сообщение клиента, и оно возвращается ВНУТРИ
    // значения: spool/inspect.ts:214, catalog/read.ts:138,
    // provisioning/diagnose.ts:242, infra/map.ts:345. Ключа `error` нет ни в
    // одном списке @hq/redact, так что страховочная редакция его пропускает —
    // тот же фрагмент, который отрезан у handler_failed, уезжал через ok: true,
    // и все три инструмента видны профилю bot. platform_probe кладёт то же самое
    // в shm.error/remna.error (platform/probe.ts:150 и :160).
    const leaky = defineTool({
      name: 'spool_inspect',
      description: 'degrades softly and reports why',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      handler: async () => ({
        byStatus: { FAIL: 1 },
        shm: {
          reachable: false,
          error:
            'SHM GET /admin/spool/statuses returned a non-JSON body: <html><body>login ' +
            'tg900001 secret@mail.com',
        },
        degraded: [
          {
            system: 'shm',
            error:
              'SHM GET /admin/spool: HTTP 500: {"data":[{"user_id":3073,"login":"tg900001"}]}',
          },
        ],
      }),
    });
    const local = createRegistry([leaky]);
    const result = await executeTool('spool_inspect', {}, {
      registry: local,
      ctx: makeCtx({ profile: 'bot' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('tg900001');
    expect(JSON.stringify(result.value)).not.toContain('secret@mail.com');
    expect(result.value).toEqual({
      byStatus: { FAIL: 1 },
      shm: {
        reachable: false,
        error: 'SHM GET /admin/spool/statuses returned a non-JSON body: <redacted>',
      },
      degraded: [{ system: 'shm', error: 'SHM GET /admin/spool: HTTP 500: <redacted>' }],
    });
  });

  it('touches nothing that has no marker in it', async () => {
    const intact = defineTool({
      name: 'catalog_read',
      description: 'ordinary answer',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human', 'bot'],
      handler: async () => ({
        rows: [{ id: 7, name: 'HTTP tariff (see [1])', cost: 199.5, at: '2026-08-08' }],
        note: 'Object keys look like {"block":1}; names match [0-9]+_[a-z]+.',
        empty: [],
        nothing: null,
      }),
    });
    const local = createRegistry([intact]);
    const result = await executeTool('catalog_read', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      rows: [{ id: 7, name: 'HTTP tariff (see [1])', cost: 199.5, at: '2026-08-08' }],
      note: 'Object keys look like {"block":1}; names match [0-9]+_[a-z]+.',
      empty: [],
      nothing: null,
    });
  });

  it('keeps capability_unverified when the value has nowhere to hold it', async () => {
    // Массив или число — законный ответ инструмента, а предупреждение о
    // неподтверждённой возможности терять нельзя. Поэтому оно всегда лежит в
    // конверте, а в значение дописывается лишь тогда, когда туда есть куда
    // писать: оба транспорта сегодня пересылают модели только value.
    const listTool = defineTool({
      name: 'country_health',
      description: 'answers with a bare array',
      input: z.object({}),
      access: 'ro',
      risk: 'none',
      profiles: ['human'],
      requires: ['tunnel.postgres'],
      handler: async () => [{ country: 'NL' }],
    });
    const local = createRegistry([listTool]);
    const result = await executeTool('country_health', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ country: 'NL' }]);
    expect(result.warnings?.map((w) => w.code)).toEqual(['capability_unverified']);
  });

  it('reports the warning in the envelope for an object result too', async () => {
    const probe = createProbeStore(makeProbe('unknown'));
    const result = await executeTool('sql_query', { sql: 'select 1' }, {
      registry,
      ctx: makeCtx({ probe }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings?.map((w) => w.code)).toEqual(['capability_unverified']);
  });

  it('carries no warnings key when the probe confirmed everything', async () => {
    const probe = createProbeStore(makeProbe(true));
    const result = await executeTool('sql_query', { sql: 'select 1' }, {
      registry,
      ctx: makeCtx({ probe }),
    });
    expect(result).toEqual({ ok: true, value: { rows: [] } });
  });
});

describe('executeTool always answers with an ExecResult', () => {
  it('does not reject when the registry itself throws', async () => {
    // Registry.list и ProbeStore.get сегодня чистые, поэтому вживую это не
    // случается. Но «исполнитель всегда возвращает исход» — контракт обоих
    // транспортов: отклонённый промис прошёл бы мимо их обработки ошибок.
    const exploding = {
      list: (): ToolDef[] => {
        throw new Error('probe store exploded: HTTP 500: {"login":"tg900001"}');
      },
      get: (): undefined => undefined,
    } as unknown as Registry;
    const result = await executeTool('client_overview', {}, {
      registry: exploding,
      ctx: makeCtx(),
    });
    expect(result).toMatchObject({ ok: false, code: 'handler_failed' });
    if (result.ok) return;
    expect(result.message).not.toContain('tg900001');
    expect(result.message).toContain('probe store exploded');
  });

  it('does not echo an unbounded tool name back into the refusal', async () => {
    // Имя приходит от вызывающего; TOOL_NAME_RE ограничивает длину только при
    // регистрации, а сюда попадает что угодно.
    const huge = 'z'.repeat(5000);
    const forHuman = await executeTool(huge, {}, { registry, ctx: makeCtx() });
    const forBot = await executeTool(huge, {}, { registry, ctx: makeCtx({ profile: 'bot' }) });
    expect(forHuman).toMatchObject({ ok: false, code: 'not_found' });
    expect(forBot).toMatchObject({ ok: false, code: 'not_found' });
    if (forHuman.ok || forBot.ok) return;
    expect(forHuman.message.length).toBeLessThan(200);
    expect(forBot.message.length).toBeLessThan(200);
  });

  it('names the root cause instead of dropping it', async () => {
    // `fetch failed` без cause не говорит ничего: причина (ECONNREFUSED,
    // просроченный сертификат) живёт в cause и до оператора не доезжала.
    const local = createRegistry([
      defineTool({
        name: 'infra_map',
        description: 'wraps a network failure',
        input: z.object({}),
        access: 'ro',
        risk: 'none',
        profiles: ['human'],
        handler: async () => {
          throw new Error('Remnawave request GET /api/nodes failed: fetch failed', {
            cause: new Error('connect ECONNREFUSED 192.0.2.20:3000'),
          });
        },
      }),
    ]);
    const result = await executeTool('infra_map', {}, { registry: local, ctx: makeCtx() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('fetch failed');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('listVisibleTools', () => {
  it('applies mode, profile and the probe in one place', () => {
    expect(listVisibleTools({ registry, ctx: makeCtx() }).map((d) => d.name)).toEqual([
      'client_overview',
      'infra_map',
      'spool_inspect',
      'sql_query',
    ]);
    const probe = createProbeStore(makeProbe(false));
    expect(listVisibleTools({ registry, ctx: makeCtx({ probe }) }).map((d) => d.name)).toEqual([
      'client_overview',
      'infra_map',
      'spool_inspect',
    ]);
    expect(listVisibleTools({ registry, ctx: makeCtx({ mode: 'rw' }) }).map((d) => d.name)).toContain(
      'billing_adjust',
    );
  });
});
