import { beforeEach, describe, expect, it } from 'vitest';
import { resetAbuseBudget, resetProbeCache } from '@hq/tools-read';
import type { HqMcpConfig } from '@hq/env';
import { buildRuntime, createNullAuditLog, createNullConfirmStore } from './index.js';
import type { Runtime } from './index.js';

const cfg: HqMcpConfig = {
  shm: { baseUrl: 'https://admin.example.test/shm/v1', auth: 'mcp:secret' },
  remna: { baseUrl: 'https://panel.example.test', token: 'jwt' },
  mode: 'ro',
  profile: 'human',
  auditPath: '/tmp/hq/audit.jsonl',
  snapshotDir: '/tmp/hq/snapshots',
  shmTz: 'Europe/Moscow',
  tunnel: {
    abuseUrl: 'http://127.0.0.1:18099',
    postgres: { host: '127.0.0.1', port: 16767 },
    mysql: null,
    sshCommand: 'ssh -L 18099:192.0.2.10:8099 -L 16767:192.0.2.20:6767 jump-host',
  },
  budget: { limit: 30, windowMs: 60_000 },
  mutations: { maxOpAmount: 5000, maxBulkUsers: 100 },
};

function jsonFetch(body: unknown): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Вызывает инструмент по имени в обход exec: здесь проверяется сборка, а не исполнитель. */
async function callTool(runtime: Runtime, name: string, input: unknown): Promise<unknown> {
  const def = runtime.registry.get(name);
  if (def === undefined) throw new Error(`${name} is not registered`);
  return def.handler(input, runtime.ctx);
}

// Кэш platform_probe и потолок abuse_report — модульное состояние процесса, и
// buildRuntime его СОЗНАТЕЛЬНО не трогает (см. комментарий в index.ts). Значит
// изоляцию обеспечивает тест, а не сборка, — ровно это и написано здесь.
beforeEach(() => {
  resetProbeCache();
  resetAbuseBudget();
});

describe('buildRuntime', () => {
  it('assembles the 38 read tools and a context in ro/human', () => {
    const runtime = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl });
    expect(runtime.registry.list({ mode: 'ro', profile: 'human' })).toHaveLength(38);
    expect(runtime.ctx.profile).toBe('human');
    expect(runtime.ctx.mode).toBe('ro');
    expect(runtime.ctx.probe.get()).toBeNull();
  });

  it('wires the profile all the way into the clients so §7.2 cannot be switched off', async () => {
    // Единственное место, где профиль попадает в транспорт. Регрессия здесь
    // молча снимает маскирование кредов, и её не поймает ни один тест инструмента.
    const { fetchImpl } = jsonFetch({ response: { uuid: 'u-1', trojanPassword: 'plain' } });
    const runtime = buildRuntime({ ...cfg, profile: 'bot' }, { fetchImpl });
    const user = await runtime.ctx.remna.get<Record<string, unknown>>('/api/users/u-1');
    expect(user.trojanPassword).toBe('<redacted>');
    expect(runtime.ctx.profile).toBe('bot');
  });

  it('leaves the unredacted channel unredacted', async () => {
    const { fetchImpl } = jsonFetch({ response: { uuid: 'u-1', trojanPassword: 'plain' } });
    const runtime = buildRuntime(cfg, { fetchImpl });
    const raw = await runtime.ctx.remna.getRaw<Record<string, unknown>>('/api/users/u-1');
    expect(raw.trojanPassword).toBe('plain');
  });

  it('carries the configured SHM timezone into the context instead of assuming Moscow', () => {
    // Голые даты SHM — локальное время СЕРВЕРА (Core::Utils::now). Зона живёт в
    // HQ_MCP_SHM_TZ и попадает в инструменты ровно отсюда: не донести её значит
    // читать каждый штамп с ошибкой в размер офсета, молча и всегда.
    const moscow = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl });
    expect(moscow.ctx.shmTz).toBe(cfg.shmTz);
    // Вторая проверка обязательна: против захардкоженной 'Europe/Moscow'
    // первая зелена и там, где конфиг вообще не читали.
    const yekaterinburg = buildRuntime(
      { ...cfg, shmTz: 'Asia/Yekaterinburg' },
      { fetchImpl: jsonFetch({}).fetchImpl },
    );
    expect(yekaterinburg.ctx.shmTz).toBe('Asia/Yekaterinburg');
  });

  it('takes the general budget ceiling from the config, one bucket per process', async () => {
    // Путь НЕ батчевый: у /admin/user и /admin/user/service свой потолок, и
    // общий лимит на них не действует вовсе.
    const { fetchImpl, calls } = jsonFetch({ data: [] });
    const runtime = buildRuntime({ ...cfg, budget: { limit: 2, windowMs: 60_000 } }, { fetchImpl });
    await runtime.ctx.shm.get('/admin/spool/statuses');
    await runtime.ctx.shm.get('/admin/spool/statuses');
    await expect(runtime.ctx.shm.get('/admin/spool/statuses')).rejects.toThrow(/budget/i);
    expect(calls).toHaveLength(2);
  });

  it('gives the batch listing routes their own ceiling, or sync_audit can never finish', async () => {
    // BATCH_LIST_LIMITS не абстрактная константа: sync_audit вычитывает
    // /admin/user/service и /admin/user целиком — на большой установке это
    // десятки запросов против общих 30/60с. Без exactKeyLimits readShmRows глотает
    // BudgetExceededError через settle и отвечает 200 с вечно неполным охватом.
    const { fetchImpl, calls } = jsonFetch({ data: [] });
    const runtime = buildRuntime({ ...cfg, budget: { limit: 2, windowMs: 60_000 } }, { fetchImpl });

    for (let i = 0; i < 30; i += 1) await runtime.ctx.shm.get('/admin/user');
    for (let i = 0; i < 30; i += 1) await runtime.ctx.shm.get('/admin/user/service');
    // Панель — тот же список, третий ключ той же таблицы лимитов: подмена
    // BATCH_LIST_LIMITS самодельным подмножеством ловится здесь.
    for (let i = 0; i < 30; i += 1) await runtime.ctx.remna.get('/api/users');
    expect(calls).toHaveLength(90);

    // Потолок при этом остаётся потолком, а не отключением бюджета.
    for (let i = 30; i < 120; i += 1) await runtime.ctx.shm.get('/admin/user');
    await expect(runtime.ctx.shm.get('/admin/user')).rejects.toThrow(/budget/i);
  });

  it('takes no tool list from the caller: the same call gives both transports the same registry', () => {
    // Параметра extraTools НЕТ. Мутаторы регистрируются внутри buildRuntime,
    // поэтому у stdio и http не может быть разных наборов.
    const stdioLike = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl });
    const httpLike = buildRuntime({ ...cfg, profile: 'bot' }, { fetchImpl: jsonFetch({}).fetchImpl });
    expect(stdioLike.registry.list({ mode: 'ro', profile: 'human' }).map((d) => d.name)).toEqual(
      httpLike.registry.list({ mode: 'ro', profile: 'human' }).map((d) => d.name),
    );
    // Мутаторы В РЕЕСТРЕ ЕСТЬ всегда, а видимость решает один механизм —
    // Registry.list: в ro их не показывают, в rw показывают. Разница между
    // двумя числами и есть доказательство, что фильтр работает, а не что
    // мутаторов не собрали.
    expect(stdioLike.registry.list({ mode: 'ro', profile: 'human' })).toHaveLength(38);
    expect(stdioLike.registry.list({ mode: 'rw', profile: 'human' }).length).toBeGreaterThan(38);
    expect(stdioLike.registry.get('billing_adjust')).toBeDefined();
  });

  it('always provides an audit log and a confirm store, so nobody has to check for null', () => {
    const runtime = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl });
    // Настоящие реализации, а не заглушки: у AuditLog и ConfirmStore поля
    // `kind` нет вовсе — по его отсутствию заглушка и отличается от журнала.
    expect((runtime.audit as unknown as { kind?: string }).kind).toBeUndefined();
    expect((runtime.confirm as unknown as { kind?: string }).kind).toBeUndefined();
    expect(typeof runtime.audit.write).toBe('function');
    expect(typeof runtime.confirm.put).toBe('function');
  });

  it('lets a test substitute both, which is how the mutation wiring is checked', () => {
    const written: Array<Record<string, unknown>> = [];
    const audit = {
      kind: 'null' as const,
      write: async (rec: Record<string, unknown>): Promise<Record<string, unknown>> => {
        written.push(rec);
        return rec;
      },
      search: async (): Promise<{ records: Record<string, unknown>[]; corrupt: number }> => ({
        records: written,
        corrupt: 0,
      }),
    };
    const confirm = createNullConfirmStore();
    const runtime = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl, audit, confirm });
    expect(runtime.audit).toBe(audit);
    expect(runtime.confirm).toBe(confirm);
  });

  it('uses the injected clock everywhere', () => {
    const now = (): Date => new Date('2026-08-08T12:00:00.000Z');
    const runtime = buildRuntime(cfg, { fetchImpl: jsonFetch({}).fetchImpl, now });
    expect(runtime.ctx.now().toISOString()).toBe('2026-08-08T12:00:00.000Z');
  });
});

describe('the module state that outlives a single runtime', () => {
  it('does not re-probe the deployment just because a second runtime was built', async () => {
    // Кэш пробы описывает ДЕПЛОЙ, а не объект рантайма, и живёт в модуле
    // platform_probe. buildRuntime его не сбрасывает: сброс — это решение
    // теста, а не побочный эффект сборки.
    const first = jsonFetch({});
    const a = buildRuntime(cfg, { fetchImpl: first.fetchImpl, probeTcp: async () => false });
    await callTool(a, 'platform_probe', { refresh: false });
    expect(a.ctx.probe.get()?.cached).toBe(false);
    expect(first.calls.length).toBeGreaterThan(0);

    const second = jsonFetch({});
    const b = buildRuntime(cfg, { fetchImpl: second.fetchImpl, probeTcp: async () => false });
    await callTool(b, 'platform_probe', { refresh: false });
    expect(b.ctx.probe.get()?.cached).toBe(true);
    expect(second.calls).toEqual([]);

    resetProbeCache();
    await callTool(b, 'platform_probe', { refresh: false });
    expect(b.ctx.probe.get()?.cached).toBe(false);
    expect(second.calls.length).toBeGreaterThan(0);
  });

  it('does not hand a second runtime a fresh abuse_report ceiling', async () => {
    // Этот потолок защищает саму MySQL, а не рантайм: хуку безразлично, кто
    // его позвал. Сборка, обнуляющая его, раздавала бы по пять полных сканов
    // базы на каждый повторный buildRuntime — и ни один тест этого не увидел бы.
    const withToken: HqMcpConfig = { ...cfg, tunnel: { ...cfg.tunnel, abuseToken: 'guard-secret' } };
    const refuse = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18099');
    }) as unknown as typeof fetch;

    const a = buildRuntime(withToken, { fetchImpl: refuse });
    for (let i = 0; i < 5; i += 1) {
      await expect(callTool(a, 'abuse_report', {})).rejects.toThrow(/unreachable/i);
    }

    const b = buildRuntime(withToken, { fetchImpl: refuse });
    await expect(callTool(b, 'abuse_report', {})).rejects.toThrow(/spent its local budget/i);

    resetAbuseBudget();
    await expect(callTool(b, 'abuse_report', {})).rejects.toThrow(/unreachable/i);
  });
});

describe('the no-op audit log and confirm store', () => {
  it('accept calls without writing anything and say so out loud', async () => {
    const audit = createNullAuditLog();
    expect(await audit.write({ tool: 'billing_adjust' })).toEqual({ tool: 'billing_adjust' });
    // Форма ответа та же, что у настоящего AuditLog.search: не голый массив.
    expect(await audit.search({ limit: 10 })).toEqual({ records: [], corrupt: 0 });

    const confirm = createNullConfirmStore();
    await expect(confirm.put({ tool: 'billing_adjust' })).rejects.toThrow(/read-only build/i);
    await expect(confirm.take('t-1', 'human')).rejects.toThrow(/read-only build/i);
  });
});
