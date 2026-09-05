import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@hq/env';
import { executeTool, listVisibleTools } from '@hq/exec';
import { resetAbuseBudget, resetProbeCache } from '@hq/tools-read';
import { BackendNotConfiguredError } from '@hq/types';
import type { ProbeResult, ToolWarning } from '@hq/types';
import { buildRuntime } from './index.js';
import type { Runtime } from './index.js';

/**
 * ОДНА СИСТЕМА — ЭТО ПОЛНОЦЕННОЕ РАЗВЁРТЫВАНИЕ, А НЕ ПОЛОМАННОЕ.
 *
 * Панель Remnawave стоит у каждого, кто вообще держит Remnawave; SHM — нишевый
 * биллинг, и человек с одной только панелью — самый вероятный читатель этого
 * репозитория. Проверяется здесь ровно то, что он увидит: какие инструменты
 * появятся в его реестре, чего в нём не будет и откуда он об этом узнает.
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ — НИ ОДНОГО МОЛЧАЛИВОГО ПУСТОГО ОТВЕТА. Инструмент,
 * который при отсутствующем бэкенде отвечает «ничего не найдено», хуже
 * отсутствующего: он уверенно неверен. Поэтому проверяются оба конца — что
 * ненастроенный клиент ОТКАЗЫВАЕТ, и что исчезнувший инструмент объяснён
 * пробой и исполнителем.
 */
const SHM_ENV = {
  SHM_BASE_URL: 'https://billing.example.test/shm/v1',
  SHM_ADMIN_AUTH: 'mcp:secret',
};
const REMNA_ENV = {
  REMNA_BASE_URL: 'https://panel.example.test',
  REMNA_API_TOKEN: 'jwt-token',
};

/** Читающие инструменты, которым нужен ТОЛЬКО биллинг. */
const SHM_READ = [
  'autopay_inspect',
  'billing_ledger',
  'catalog_read',
  'client_account_state',
  'client_billing_view',
  'client_catalog_view',
  'client_overview',
  'client_resolve',
  'client_search',
  'config_read',
  'notify_history',
  'promo_read',
  'server_inventory',
  'service_inspect',
  'spool_inspect',
  'template_read',
];

/** Читающие инструменты, которым нужна ТОЛЬКО панель. */
const REMNA_READ = [
  'abuse_report',
  'client_reach',
  'connections_inspect',
  'country_health',
  'device_inventory',
  'infra_costs',
  'infra_map',
  'node_config_audit',
  'node_geocheck',
  'node_integrations_read',
  'panel_activity',
  'shared_lists_read',
  'squads_read',
  'subpage_read',
  'subscription_inspect',
  'torrent_reports',
  'traffic_stats',
];

/**
 * Читающие инструменты, которым нужны ОБЕ системы. Их ровно два, и оба сшивают
 * биллинг с панелью: `sync_audit` их СВЕРЯЕТ, `provisioning_diagnose` проверяет,
 * доехал ли провижининг одной до другой. С одной стороной у обоих нет вопроса,
 * а не «неполный ответ».
 */
const BOTH_READ = ['provisioning_diagnose', 'sync_audit'];

/** Не нужна ни одна: проба рассказывает про сами системы, sql_query ходит в туннель. */
const NO_BACKEND_READ = ['platform_probe', 'sql_query'];

const SHM_WRITE = [
  'billing_adjust',
  'billing_refund_service',
  'provisioning_repair',
  'server_edit',
  'service_lifecycle',
  'storage_edit',
  'template_edit',
  'user_flags',
];

const REMNA_WRITE = ['bulk_ops', 'host_cleanup', 'host_edit', 'node_manage', 'panel_sync', 'subscription_ops'];

/** Служебные: ни одного бэкенда сами не трогают. */
const OPS_WRITE = ['ops_audit', 'ops_confirm'];

function runtimeFor(
  env: Record<string, string>,
  calls: string[] = [],
): Runtime {
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return buildRuntime(loadConfig({ ...env, HQ_MCP_MODE: 'rw' }), {
    fetchImpl,
    probeTcp: async () => false,
  });
}

function visible(runtime: Runtime): string[] {
  return listVisibleTools({ registry: runtime.registry, ctx: runtime.ctx })
    .map((def) => def.name)
    .sort();
}

beforeEach(() => {
  resetProbeCache();
  resetAbuseBudget();
});

describe('the registry follows the backends this deployment actually has', () => {
  it('publishes everything when both systems are configured', () => {
    const names = visible(runtimeFor({ ...SHM_ENV, ...REMNA_ENV }));
    expect(names).toEqual(
      [
        ...SHM_READ,
        ...REMNA_READ,
        ...BOTH_READ,
        ...NO_BACKEND_READ,
        ...SHM_WRITE,
        ...REMNA_WRITE,
        ...OPS_WRITE,
      ].sort(),
    );
  });

  it('drops every panel tool when only the billing is configured', () => {
    const names = visible(runtimeFor(SHM_ENV));
    expect(names).toEqual([...SHM_READ, ...NO_BACKEND_READ, ...SHM_WRITE, ...OPS_WRITE].sort());
    for (const absent of [...REMNA_READ, ...REMNA_WRITE, ...BOTH_READ]) {
      expect(names).not.toContain(absent);
    }
  });

  it('drops every billing tool when only the panel is configured', () => {
    const names = visible(runtimeFor(REMNA_ENV));
    expect(names).toEqual([...REMNA_READ, ...NO_BACKEND_READ, ...REMNA_WRITE, ...OPS_WRITE].sort());
    for (const absent of [...SHM_READ, ...SHM_WRITE, ...BOTH_READ]) {
      expect(names).not.toContain(absent);
    }
  });

  /**
   * Проверка не списком, а ПРАВИЛОМ: инструмент, добавленный завтра и
   * объявивший систему, которой в этой установке нет, обязан исчезнуть сам, а
   * не ждать, пока кто-нибудь допишет его имя в списки выше.
   */
  it('shows no tool that declares a backend this deployment lacks', () => {
    for (const env of [SHM_ENV, REMNA_ENV, { ...SHM_ENV, ...REMNA_ENV }]) {
      const runtime = runtimeFor(env);
      for (const def of listVisibleTools({ registry: runtime.registry, ctx: runtime.ctx })) {
        for (const backend of def.backends ?? []) {
          expect({ tool: def.name, backend, present: runtime.ctx.backends[backend] }).toEqual({
            tool: def.name,
            backend,
            present: true,
          });
        }
      }
    }
  });
});

describe('an absent backend refuses; it never answers empty', () => {
  /**
   * САМОЕ ВАЖНОЕ УТВЕРЖДЕНИЕ ФАЙЛА. Клиент отсутствующей системы обязан
   * ОТКАЗАТЬ. Пустой список вместо отказа — это «клиентов не найдено» там, где
   * правда «искать было негде», и построенное на нём решение (завести аккаунт
   * заново, вернуть деньги, разблокировать) уже не отличить от обоснованного.
   */
  it('rejects instead of resolving to an empty result', async () => {
    const runtime = runtimeFor(REMNA_ENV);
    await expect(runtime.ctx.shm.list('/admin/user', { limit: 1 })).rejects.toBeInstanceOf(
      BackendNotConfiguredError,
    );
    await expect(runtime.ctx.shm.get('/admin/user')).rejects.toThrow(/SHM_BASE_URL, SHM_ADMIN_AUTH/);
    const panelOnly = runtimeFor(SHM_ENV);
    await expect(panelOnly.ctx.remna.get('/api/users')).rejects.toThrow(
      /REMNA_BASE_URL, REMNA_API_TOKEN/,
    );
  });

  /** Отклонённое ОБЕЩАНИЕ, а не синхронный бросок: инструменты оборачивают вызовы в settle(). */
  it('refuses through a rejected promise, which settle() can catch', () => {
    const runtime = runtimeFor(SHM_ENV);
    const promise = runtime.ctx.remna.get('/api/users');
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toBeInstanceOf(BackendNotConfiguredError);
  });

  /**
   * Человеку за терминалом исчезнувший инструмент объясняется словами, и
   * объяснение называет ПРИЧИНУ, а не «нет такого»: «нет такого» учит модель
   * пробовать другое имя за тем же самым.
   */
  it('tells a human operator that the tool needs a backend this install lacks', async () => {
    const runtime = runtimeFor(REMNA_ENV);
    const result = await executeTool('client_overview', { shm_user_id: 1 }, {
      registry: runtime.registry,
      ctx: runtime.ctx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('SHM');
    expect(result.message).toContain('not published');
    expect(result.message).toContain('platform_probe');
  });

  /** Боту — по-прежнему одна строка на все случаи: реестр не перебирается пробами. */
  it('keeps the uniform answer for the bot profile', async () => {
    const runtime = buildRuntime(
      loadConfig({ ...REMNA_ENV, HQ_MCP_PROFILE: 'bot' }),
      { probeTcp: async () => false },
    );
    const result = await executeTool('client_overview', { shm_user_id: 1 }, {
      registry: runtime.registry,
      ctx: runtime.ctx,
    });
    expect(result).toEqual({
      ok: false,
      code: 'not_found',
      message: 'Tool client_overview not found',
    });
  });
});

describe('platform_probe is where the shape of the deployment is stated', () => {
  async function probe(env: Record<string, string>, calls: string[] = []): Promise<ProbeResult> {
    const runtime = runtimeFor(env, calls);
    const def = runtime.registry.get('platform_probe');
    if (def === undefined) throw new Error('platform_probe is not registered');
    return (await def.handler({ refresh: true }, runtime.ctx)) as ProbeResult;
  }

  const codes = (warnings: ToolWarning[]): string[] => warnings.map((one) => one.code);

  it('stays published no matter which backends exist', () => {
    for (const env of [SHM_ENV, REMNA_ENV, { ...SHM_ENV, ...REMNA_ENV }]) {
      expect(visible(runtimeFor(env))).toContain('platform_probe');
    }
  });

  it('says which backends are configured and does not call the one that is not', async () => {
    const calls: string[] = [];
    const result = await probe(REMNA_ENV, calls);

    expect(result.shm.configured).toBe(false);
    expect(result.remna.configured).toBe(true);
    // Не «лежит» и не «ошибка»: запроса не было вовсе.
    expect(result.shm.reachable).toBe(false);
    expect(result.shm.error).toBeNull();
    expect(result.shm.live).toBeNull();
    expect(result.shm.credentialsRejected).toBe(false);
    expect(calls.some((url) => url.includes('billing.example.test'))).toBe(false);
    expect(calls.some((url) => url.includes('panel.example.test'))).toBe(true);
  });

  it('is symmetric for a billing-only deployment', async () => {
    const calls: string[] = [];
    const result = await probe(SHM_ENV, calls);

    expect(result.remna.configured).toBe(false);
    expect(result.shm.configured).toBe(true);
    expect(result.remna.error).toBeNull();
    expect(result.remna.runtime).toBeNull();
    expect(calls.some((url) => url.includes('panel.example.test'))).toBe(false);
  });

  /**
   * Цена решения «прятать инструменты» — исчезнувший инструмент себя не
   * объясняет. Платит за неё проба: форма развёртывания названа здесь, один раз
   * и целиком, вместо тринадцати одинаковых отказов подряд.
   */
  it('warns that a backend is absent, and says the tools are absent rather than failing', async () => {
    const result = await probe(REMNA_ENV);
    expect(codes(result.warnings)).toContain('backend_not_configured');
    const said = result.warnings.find((one) => one.code === 'backend_not_configured');
    expect(said?.message).toContain('SHM');
    expect(said?.message).toContain('not published at all');
    expect(said?.message).toContain('absent, not failing');
  });

  it('says nothing about absent backends when both are configured', async () => {
    const result = await probe({ ...SHM_ENV, ...REMNA_ENV });
    expect(codes(result.warnings)).not.toContain('backend_not_configured');
    expect(result.shm.configured).toBe(true);
    expect(result.remna.configured).toBe(true);
  });

  /**
   * Возможности ненастроенной системы — 'unknown', а НЕ false. `false`
   * означает «проверили, её нет», и на нём реестр прячет ещё и туннельные
   * инструменты; здесь не проверяли ничего.
   */
  it('leaves the capabilities of an absent backend unknown rather than false', async () => {
    const result = await probe(REMNA_ENV);
    expect(result.capabilities['shm.filter']).toBe('unknown');
    expect(result.capabilities['shm.dry_run']).toBe('unknown');
  });
});
