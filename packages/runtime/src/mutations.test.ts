import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditLog } from '@hq/audit';
import { createConfirmStore, hashInput } from '@hq/confirm';
import { executeTool, listVisibleTools } from '@hq/exec';
import { createMutationTools } from '@hq/tools-mutations';
import { resetAbuseBudget, resetProbeCache } from '@hq/tools-read';
import type { Access, Profile } from '@hq/types';
import type { HqMcpConfig } from '@hq/env';
import { buildRuntime } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'hq-runtime-mut-'));

/** Сколько читающих инструментов даёт план 1 — граница, от которой считается всё остальное. */
const READ_TOOLS_HUMAN = 38;

function cfg(mode: Access, profile: Profile, extra: Partial<HqMcpConfig> = {}): HqMcpConfig {
  const dir = join(root, `${mode}-${profile}-${String(Math.random()).slice(2)}`);
  return {
    shm: { baseUrl: 'https://admin.example.test/shm/v1', auth: 'mcp:secret' },
    remna: { baseUrl: 'https://panel.example.test', token: 'jwt' },
    mode,
    profile,
    auditPath: join(dir, 'audit.jsonl'),
    snapshotDir: join(dir, 'snapshots'),
    shmTz: 'Europe/Moscow',
    tunnel: {
      abuseUrl: 'http://127.0.0.1:18099',
      postgres: { host: '127.0.0.1', port: 16767 },
      mysql: null,
      sshCommand: 'ssh -L 18099:hook-host:8099 -L 16767:db-host:6767 jump-host',
    },
    budget: { limit: 30, windowMs: 60_000 },
    mutations: { maxOpAmount: 5000, maxBulkUsers: 100 },
    ...extra,
  };
}

/**
 * ВСЯ мутационная поверхность пакета, выведенная ИЗ ЕГО ИСХОДНИКОВ.
 *
 * `mutatorNames()` ниже отвечает только за `MUTATION_FACTORIES` — за то, что
 * собирается фабрикой формы `(deps) => MutationTool`. Этого мало: `ops_audit`
 * и `ops_confirm` мутаторами не являются (планов не строят, `defineMutation`
 * не зовут), в тот список попасть не могут по определению — и ровно поэтому
 * оба были написаны, покрыты тестами, выставлены из барреля и НЕ доехали до
 * реестра. Проверка «мутаторов ровно столько же, сколько фабрик» на этом была
 * зелёной, потому что сверяла копию с копией внутри одной половины пакета.
 *
 * Здесь граница проходит по БАРРЕЛЮ и по обоим каркасам сразу
 * (`defineMutation` и `defineTool`): экспорт из `index.ts` — это момент, когда
 * автор сказал «готово», и с него инструмент обязан быть виден в `rw`. Файл,
 * лежащий в дереве, но не экспортированный, — черновик и сюда не попадает.
 */
function exportedToolNames(): Map<string, string> {
  const src = 'tools/mutations/src';
  const barrel = readFileSync(join(src, 'index.ts'), 'utf8');
  const found = new Map<string, string>();

  for (const from of barrel.matchAll(/from '\.\/([\w./-]+)\.js'/g)) {
    const path = join(src, `${from[1] ?? ''}.ts`);
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // `(function\s+)?` отсекает ОБЪЯВЛЕНИЕ каркаса (`export function
    // defineMutation<...>`) в kit.ts от его ВЫЗОВА в модуле инструмента.
    for (const call of source.matchAll(/(function\s+)?define(?:Tool|Mutation)[<(]/g)) {
      if (call[1] !== undefined) continue;
      const named = /\bname:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/.exec(
        source.slice(call.index, call.index + 600),
      );
      if (named === null) continue;
      const literal = named[1];
      if (literal !== undefined) {
        found.set(literal, path);
        continue;
      }
      const constant = new RegExp(`\\b${named[2] ?? ''}\\s*=\\s*'([^']+)'`).exec(source);
      if (constant?.[1] !== undefined) found.set(constant[1], path);
    }
  }
  return found;
}

/**
 * Имена мутаторов берутся ИЗ САМОГО ПАКЕТА, а не переписаны сюда списком.
 * Список имён в тесте проверяет копию против копии: седьмой мутатор, забытый
 * в сборке, остался бы забыт и здесь — а тест был бы зелёным.
 */
function mutatorNames(): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'hq-names-'));
  return createMutationTools({
    audit: createAuditLog(join(dir, 'audit.jsonl')),
    confirm: createConfirmStore(join(dir, 'plans')),
    limits: { maxOpAmount: 5000, maxBulkUsers: 100 },
  })
    .map((tool) => tool.name)
    .sort();
}

/** Сеть в тестах реестра не нужна: обращение к ней — дефект самого теста. */
const noFetch = (async () => {
  throw new Error('fetch в тесте сборки рантайма вызываться не должен');
}) as unknown as typeof fetch;

function jsonFetch(route: (url: string) => unknown): typeof fetch {
  return (async (input: string | URL | Request) =>
    new Response(JSON.stringify(route(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  resetProbeCache();
  resetAbuseBudget();
});

describe('buildRuntime × мутации: шов, ради которого мутаторы вообще существуют', () => {
  it('в ro не видно НИ ОДНОГО мутатора — модель их не видит, а не получает отказ', () => {
    const runtime = buildRuntime(cfg('ro', 'human'), { fetchImpl: noFetch });
    const visible = runtime.registry.list({ mode: 'ro', profile: 'human' }).map((t) => t.name);

    expect(visible).toHaveLength(READ_TOOLS_HUMAN);
    // Служебные ops_* сюда входят наравне с мутаторами: журнал мутаций и
    // применение плана — часть мутационной поверхности, и сервер, поднятый в
    // `ro`, не показывает её ни одной ручкой (К21).
    for (const name of exportedToolNames().keys()) {
      expect(visible, `${name} не должен быть виден в ro`).not.toContain(name);
      // В реестре он при этом ЕСТЬ: прячет один механизм — Registry.list.
      expect(runtime.registry.get(name)).toBeDefined();
    }
    expect(runtime.registry.list({ mode: 'ro', profile: 'bot' }).map((t) => t.name)).not.toContain(
      'billing_adjust',
    );
  });

  it('в ro мутатор не вызывается и через исполнителя: его там просто нет', async () => {
    const runtime = buildRuntime(cfg('ro', 'human'), { fetchImpl: noFetch });
    const result = await executeTool(
      'subscription_ops',
      { user_id: 42, action: 'enable' },
      { registry: runtime.registry, ctx: runtime.ctx },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.message).toMatch(/not available for profile "human" in mode "ro"/);
    }
  });

  it('в rw появляется РОВНО столько инструментов, сколько написано в пакете мутаций', () => {
    const runtime = buildRuntime(cfg('rw', 'human'), { fetchImpl: noFetch });
    const visible = runtime.registry.list({ mode: 'rw', profile: 'human' }).map((t) => t.name);
    const surface = exportedToolNames();

    expect(visible).toHaveLength(READ_TOOLS_HUMAN + surface.size);
    for (const name of surface.keys()) expect(visible).toContain(name);
    // Тот же список глазами исполнителя: видимость считается в одном месте.
    expect(listVisibleTools({ registry: runtime.registry, ctx: runtime.ctx }).map((t) => t.name))
      .toEqual(visible);
  });

  /**
   * ТА САМАЯ ДЫРА, ИЗ-ЗА КОТОРОЙ `ops_audit` И `ops_confirm` ПРОЖИЛИ НЕДЕЛЮ
   * НАПИСАННЫМИ И НЕДОСТУПНЫМИ.
   *
   * `register.test.ts` в пакете мутаций сторожит `MUTATION_FACTORIES` — то
   * есть только те инструменты, что собираются через `defineMutation`.
   * Служебный инструмент мутационной поверхности в тот список не попадает по
   * своей форме, и не было НИ ОДНОГО теста, который заметил бы его отсутствие
   * в реестре: он просто переставал существовать для модели.
   *
   * Сверка двусторонняя и обе стороны выведены, а не переписаны: слева —
   * баррель пакета, справа — то, что рантайм действительно показывает в `rw`
   * сверх читающих. Забытая регистрация красит тест слева, лишняя (инструмент
   * зарегистрирован, но из барреля убран) — справа.
   */
  it('КАЖДЫЙ инструмент, выставленный баррелем мутаций, доезжает до реестра', () => {
    const runtime = buildRuntime(cfg('rw', 'human'), { fetchImpl: noFetch });
    const readOnly = new Set(
      runtime.registry.list({ mode: 'ro', profile: 'human' }).map((t) => t.name),
    );
    const mutationSurface = runtime.registry
      .list({ mode: 'rw', profile: 'human' })
      .map((t) => t.name)
      .filter((name) => !readOnly.has(name))
      .sort();

    const exported = exportedToolNames();
    // Скан действительно ходит по дереву: опечатка в пути дала бы пустую карту
    // и зелёный тест на пустом множестве.
    expect(exported.size).toBeGreaterThan(mutatorNames().length);
    expect(
      [...exported.keys()].sort(),
      'инструмент экспортирован из tools/mutations/src/index.ts, но в реестре его нет: в ' +
        'tools/list он не появится, и для модели такой возможности не существует',
    ).toEqual(mutationSurface);
  });

  it('боту не открыт НИ ОДИН инструмент мутационной поверхности, включая служебные', () => {
    const runtime = buildRuntime(cfg('rw', 'bot'), { fetchImpl: noFetch });
    const rw = runtime.registry.list({ mode: 'rw', profile: 'bot' }).map((t) => t.name);
    // Не только мутаторы: `ops_confirm` боту тоже закрыт, и это решение, а не
    // недосмотр. Ботовый контур не получает ни одного мутатора — значит и
    // подтверждать ему нечего, а общий каталог снимков (HQ_MCP_SNAPSHOT_DIR у
    // stdio и http один) сделал бы открытый боту ops_confirm дверью к планам
    // денежных инструментов, которых он не видит даже в списке. `ops_audit`
    // закрыт по §7.2: журнал несёт input/before/after чужих операций.
    for (const name of exportedToolNames().keys()) expect(rw).not.toContain(name);
  });

  it('executeTool доходит до ветки плана: строит план и НИЧЕГО не меняет', async () => {
    const config = cfg('rw', 'human');
    const seen: string[] = [];
    const fetchImpl = jsonFetch((url) => {
      seen.push(url);
      return {
        response: {
          id: 42,
          username: 'client-42',
          status: 'DISABLED',
          expireAt: '2026-09-01T00:00:00.000Z',
          trafficLimitBytes: 0,
          trafficLimitStrategy: 'NO_RESET',
          hwidDeviceLimit: 3,
          subRevokedAt: null,
        },
      };
    });
    const runtime = buildRuntime(config, { fetchImpl });

    const result = await executeTool(
      'subscription_ops',
      { user_id: 42, action: 'enable' },
      { registry: runtime.registry, ctx: runtime.ctx },
    );

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    const plan = result.value as { status: string; plan_id: string; diff: unknown[]; hint: string };
    expect(plan.status).toBe('plan');
    expect(plan.plan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.diff.length).toBeGreaterThan(0);
    expect(plan.hint).toContain(plan.plan_id);

    // Построение плана — это ЧТЕНИЕ. Ни одного не-GET к панели.
    expect(seen).toEqual(['https://panel.example.test/api/users/42']);

    // Снимок плана лежит на диске по cfg.snapshotDir — хранилище настоящее.
    expect(readdirSync(config.snapshotDir)).toContain(`${plan.plan_id}.json`);

    // И он одноразов: второй `take` того же токена уже нечего брать.
    const hash = hashInput({ user_id: 42, action: 'enable' });
    await expect(
      runtime.confirm.take(plan.plan_id, 'human', 'subscription_ops', hash),
    ).resolves.toMatchObject({ tool: 'subscription_ops' });
    await expect(
      runtime.confirm.take(plan.plan_id, 'human', 'subscription_ops', hash),
    ).rejects.toThrow();
  });

  /**
   * ШОВ ЦЕЛИКОМ, ОДНИМ ПРОГОНОМ: мутатор построил план → `ops_confirm` его
   * применил → `ops_audit` показал обе записи.
   *
   * Проверка на «оба имени есть в реестре» этого не доказывает. `opsConfirm`
   * получает СОБРАННЫЕ мутаторы аргументом и ищет исполнителя по `plan.tool` в
   * этом наборе: собранный с пустым списком (или со ВТОРЫМ, пересобранным
   * набором тех же имён), он виден в `tools/list` и отвечает «применить нечем»
   * на каждый план. Именно это и происходило бы при аккуратной, но неверной
   * регистрации.
   */
  it('план мутатора применяется через ops_confirm и виден в ops_audit', async () => {
    const config = cfg('rw', 'human');
    const seen: string[] = [];
    const runtime = buildRuntime(config, {
      fetchImpl: jsonFetch((url) => {
        seen.push(url);
        return {
          response: {
            id: 42,
            username: 'client-42',
            status: 'DISABLED',
            expireAt: '2026-09-01T00:00:00.000Z',
            trafficLimitBytes: 0,
            trafficLimitStrategy: 'NO_RESET',
            hwidDeviceLimit: 3,
            subRevokedAt: null,
          },
        };
      }),
    });
    const world = { registry: runtime.registry, ctx: runtime.ctx };

    const planned = await executeTool(
      'subscription_ops',
      { user_id: 42, action: 'enable' },
      world,
    );
    expect(planned.ok, planned.ok ? '' : planned.message).toBe(true);
    if (!planned.ok) return;
    const { plan_id: planId } = planned.value as { plan_id: string };

    const applied = await executeTool('ops_confirm', { plan_id: planId }, world);
    expect(applied.ok, applied.ok ? '' : applied.message).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).toMatchObject({ status: 'applied', tool: 'subscription_ops' });
    // План применён по-настоящему: действие ушло в панель POST-ом.
    expect(seen).toContain('https://panel.example.test/api/users/42/actions/enable');
    // И снимок сгорел — одноразовость держит хранилище, а не вежливость.
    expect(readdirSync(config.snapshotDir)).not.toContain(`${planId}.json`);

    const journal = await executeTool('ops_audit', { plan_id: planId }, world);
    expect(journal.ok, journal.ok ? '' : journal.message).toBe(true);
    if (!journal.ok) return;
    const page = journal.value as {
      counts: { returned: number; unclosed: number };
      records: Array<{ tool: string; outcome: string }>;
    };
    // planned + applying + applied по одному plan_id, и ни одной незакрытой
    // попытки: `applying` закрылась своей парной записью.
    expect(page.records.map((one) => one.outcome).sort()).toEqual([
      'applied',
      'applying',
      'planned',
    ]);
    expect(page.counts.unclosed).toBe(0);
  });

  it('журнал настоящий: план записан в cfg.auditPath, с обязательным mode', async () => {
    const config = cfg('rw', 'human');
    const runtime = buildRuntime(config, {
      fetchImpl: jsonFetch(() => ({ response: { id: 7, status: 'DISABLED' } })),
    });

    await executeTool(
      'subscription_ops',
      { user_id: 7, action: 'enable' },
      { registry: runtime.registry, ctx: runtime.ctx },
    );

    const lines = readFileSync(config.auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      tool: 'subscription_ops',
      outcome: 'planned',
      profile: 'human',
      // 5.19: без mode запись не отличает настоящий прогон от прогона в ro-сборке.
      mode: 'rw',
    });

    const found = await runtime.audit.search({ tool: 'subscription_ops' });
    expect(found.records).toHaveLength(1);
    expect(found.corrupt).toBe(0);
  });

  it('потолок суммы приходит из cfg.mutations.maxOpAmount, а не из второго дефолта', async () => {
    const config = cfg('rw', 'human', { mutations: { maxOpAmount: 100, maxBulkUsers: 100 } });
    const runtime = buildRuntime(config, {
      fetchImpl: jsonFetch(() => ({ data: [{ user_id: 3073, balance: '500.00' }] })),
    });

    const result = await executeTool(
      'billing_adjust',
      { user_id: 3073, kind: 'balance', amount: 4000, comment: 'проверка потолка' },
      { registry: runtime.registry, ctx: runtime.ctx },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('MAX_OP_AMOUNT=100');

    // §7.5: отказ на этапе плана journalится наравне с успехом.
    const journal = await runtime.audit.search({ tool: 'billing_adjust' });
    expect(journal.records[0]).toMatchObject({ outcome: 'rejected', mode: 'rw' });
  });

  it('оба транспорта получают один реестр: список имён совпадает до строки', () => {
    const stdioLike = buildRuntime(cfg('rw', 'human'), { fetchImpl: noFetch });
    const httpLike = buildRuntime(cfg('rw', 'human'), { fetchImpl: noFetch });
    expect(stdioLike.registry.list({ mode: 'rw', profile: 'human' }).map((t) => t.name)).toEqual(
      httpLike.registry.list({ mode: 'rw', profile: 'human' }).map((t) => t.name),
    );
  });
});
