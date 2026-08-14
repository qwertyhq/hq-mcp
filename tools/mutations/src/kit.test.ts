import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeTool } from '@hq/exec';
import { FORBIDDEN_RULES, createRegistry, defineTool, matchForbidden } from '@hq/registry';
import { ShmError } from '@hq/shm';
import { uniqKeyFor } from '@hq/idempotency';
import type { AuditRecord } from '@hq/audit';
import type { MutationPlan } from '@hq/confirm';
import {
  BALANCE_SPEND_ENDPOINT_PATHS,
  NO_MONEY,
  assertUnchanged,
  defaultSleep,
  defineMutation,
  planIdField,
  retryOn408,
} from './kit.js';
import type { DeclaredAmount, MutationDeps, MutationInput, MutationTool } from './kit.js';
import { callHandler, callTool, callToolResult, makeWorld } from './testkit.js';

const input = z.object({ value: z.number(), ...planIdField });
type Input = z.infer<typeof input>;

/** Снимок «до» демо-мутатора; он же то, что читает guard на применении. */
const BEFORE = { value: 1 };

function demoTool(deps: MutationDeps, applied: string[]): MutationTool {
  return defineMutation<Input>(
    {
      name: 'demo_mutate',
      description: 'demo',
      input,
      risk: 'medium',
      profiles: ['human'],
      endpoints: ['POST /admin/demo'],
      target: (i) => ({ system: 'shm', id: i.value }),
      guard: { keys: ['value'], read: async () => BEFORE },
      plan: async (i) => {
        if (i.value > 100) throw new Error('demo_mutate: value превышает потолок');
        return {
          before: BEFORE,
          after: { value: i.value },
          diff: [{ path: 'value', from: 1, to: i.value }],
          sideEffects: ['клиенту уйдёт уведомление'],
          rollback: { method: 'POST', path: '/admin/demo', body: { value: 1 } },
        };
      },
      apply: async (plan) => {
        applied.push(JSON.stringify(plan.after));
        return { ok: true };
      },
    },
    deps,
  );
}

async function journal(deps: MutationDeps): Promise<AuditRecord[]> {
  const { records } = await deps.audit.search({});
  return records;
}

describe('defineMutation: план', () => {
  it('без plan_id строит план, ничего не применяет и пишет outcome=planned', async () => {
    const world = makeWorld();
    const applied: string[] = [];
    const tool = demoTool(world.deps, applied);

    const res = (await callTool(tool, { value: 7 }, world)) as {
      status: string;
      plan_id: string;
      sideEffects: string[];
      hint: string;
    };

    expect(res.status).toBe('plan');
    expect(res.plan_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.sideEffects).toContain('клиенту уйдёт уведомление');
    expect(res.hint).toContain('ops_confirm');
    expect(applied).toEqual([]);

    const records = await journal(world.deps);
    expect(records[0]).toMatchObject({
      tool: 'demo_mutate',
      outcome: 'planned',
      // 5.19: mode обязателен в каждой записи.
      mode: 'rw',
      profile: 'human',
      token: res.plan_id,
      target: { system: 'shm', id: 7 },
    });
    expect(records[0]?.calls).toEqual(['POST /admin/demo']);
  });

  it('5.1: идентификатор плана переживает редакцию исполнителя и принимается обратно', async () => {
    const world = makeWorld();
    const applied: string[] = [];
    const tool = demoTool(world.deps, applied);

    const result = await callToolResult(tool, { value: 7 }, world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = JSON.stringify(result.value);
    expect(wire).not.toContain('<redacted>');

    const { plan_id } = result.value as { plan_id: string };
    const applyResult = (await callTool(tool, { value: 7, plan_id }, world)) as { status: string };
    expect(applyResult.status).toBe('applied');
    expect(applied).toEqual(['{"value":7}']);
  });

  it('5.1 CONTROL: поле с именем confirm_token исполнитель маскирует — поэтому оно plan_id', async () => {
    const world = makeWorld();
    const leaky = defineTool({
      name: 'demo_leak',
      description: 'returns both names',
      input: z.object({}),
      access: 'rw',
      risk: 'low',
      profiles: ['human'],
      handler: async () => ({ confirm_token: 'aaaa', plan_id: 'bbbb' }),
    });
    const result = await executeTool(
      'demo_leak',
      {},
      { registry: createRegistry([leaky]), ctx: world.ctx },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { confirm_token: string; plan_id: string };
    expect(value.confirm_token).toBe('<redacted>');
    expect(value.plan_id).toBe('bbbb');
  });

  it('5.15: собранный руками diff всё равно маскируется — забыть redactDiff невозможно', async () => {
    const world = makeWorld();
    const secretTool = defineMutation<Input>(
      {
        name: 'host_demo',
        description: 'demo',
        input,
        risk: 'high',
        profiles: ['human'],
        endpoints: ['PATCH /api/hosts'],
        guard: { keys: ['uuid'], read: async () => ({ uuid: 'h-1' }) },
        plan: async () => ({
          before: { uuid: 'h-1', trojanPassword: 'trojan-plaintext' },
          after: { uuid: 'h-1', trojanPassword: 'trojan-rotated' },
          // РУКАМИ, мимо buildDiff — ровно то, что оставил открытым контрольный
          // тест packages/confirm/src/diff.exec.test.ts.
          diff: [{ path: 'trojanPassword', from: 'trojan-plaintext', to: 'trojan-rotated' }],
          sideEffects: [],
        }),
        apply: async () => ({ ok: true }),
      },
      world.deps,
    );

    const result = await callToolResult(secretTool, { value: 1 }, world);
    expect(result.ok).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('trojan-plaintext');
    expect(wire).not.toContain('trojan-rotated');
    // Путь остаётся читаемым: оператор обязан видеть, ЧТО меняется.
    expect(wire).toContain('trojanPassword');
  });

  it('5.12: план с пустым diff не выдаёт токен', async () => {
    const world = makeWorld();
    const empty = defineMutation<Input>(
      {
        name: 'demo_empty',
        description: 'demo',
        input,
        risk: 'low',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        guard: { keys: ['value'], read: async () => BEFORE },
        plan: async () => ({ before: BEFORE, after: BEFORE, diff: [], sideEffects: [] }),
        apply: async () => ({ ok: true }),
      },
      world.deps,
    );

    await expect(callTool(empty, { value: 1 }, world)).rejects.toThrow(/ничего не меняет/);
    expect((await journal(world.deps))[0]?.outcome).toBe('rejected');
  });

  it('5.12: allowEmptyDiff пропускает намеренно пустой план', async () => {
    const world = makeWorld();
    const empty = defineMutation<Input>(
      {
        name: 'demo_empty',
        description: 'demo',
        input,
        risk: 'low',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        allowEmptyDiff: true,
        guard: { keys: ['value'], read: async () => BEFORE },
        plan: async () => ({ before: BEFORE, after: BEFORE, diff: [], sideEffects: [] }),
        apply: async () => ({ ok: true }),
      },
      world.deps,
    );

    const res = (await callTool(empty, { value: 1 }, world)) as { status: string };
    expect(res.status).toBe('plan');
  });

  it('5.24: ключ идемпотентности считается один раз, из токена плана', async () => {
    const world = makeWorld();
    const seen: (string | undefined)[] = [];
    const paid = defineMutation<Input>(
      {
        name: 'billing_demo',
        description: 'demo',
        input,
        risk: 'high',
        profiles: ['human'],
        endpoints: ['PUT /admin/user/payment'],
        amountOf: (i) => i.value,
        guard: { keys: ['lastPayId'], read: async () => ({ lastPayId: 10 }) },
        plan: async (i) => ({
          before: { lastPayId: 10 },
          after: { lastPayId: 11 },
          diff: [{ path: 'balance', from: 0, to: i.value }],
          sideEffects: [],
          idempotencyKey: uniqKeyFor('billing_adjust:balance', 3073),
        }),
        apply: async (plan) => {
          seen.push(plan.idempotencyKey);
          return { id: 11 };
        },
      },
      world.deps,
    );

    const plan = (await callTool(paid, { value: 100 }, world)) as { plan_id: string };
    await callTool(paid, { value: 100, plan_id: plan.plan_id }, world);
    expect(seen).toEqual([`hq:billing_adjust:balance:3073:${plan.plan_id}`]);
  });
});

describe('defineMutation: применение', () => {
  it('применяет ровно сохранённый план и пишет applying→applied', async () => {
    const world = makeWorld();
    const applied: string[] = [];
    const tool = demoTool(world.deps, applied);

    const plan = (await callTool(tool, { value: 7 }, world)) as { plan_id: string };
    const res = (await callTool(tool, { value: 7, plan_id: plan.plan_id }, world)) as {
      status: string;
      plan_id: string;
      result: unknown;
    };

    expect(res.status).toBe('applied');
    expect(res.plan_id).toBe(plan.plan_id);
    expect(applied).toEqual(['{"value":7}']);

    const records = await journal(world.deps);
    expect(records.map((r) => r.outcome)).toEqual(['applied', 'applying', 'planned']);
    // Терминальная запись закрывает свою applying (§7.5, поле attempt).
    expect(records[0]?.attempt).toBe(records[1]?.id);
    expect(records[0]?.token).toBe(plan.plan_id);
    expect(records.every((r) => r.mode === 'rw')).toBe(true);
  });

  it('5.4: расхождение мира между планом и применением — отказ, а не запись', async () => {
    const world = makeWorld();
    const applied: string[] = [];
    let current: Record<string, unknown> = BEFORE;
    const tool = defineMutation<Input>(
      {
        name: 'demo_mutate',
        description: 'demo',
        input,
        risk: 'medium',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        guard: { keys: ['value'], read: async () => current },
        plan: async (i) => ({
          before: BEFORE,
          after: { value: i.value },
          diff: [{ path: 'value', from: 1, to: i.value }],
          sideEffects: [],
        }),
        apply: async () => {
          applied.push('applied');
          return { ok: true };
        },
      },
      world.deps,
    );

    const plan = (await callTool(tool, { value: 7 }, world)) as { plan_id: string };
    // Пока план лежал, кто-то правил тот же объект руками.
    current = { value: 42 };

    await expect(
      callTool(tool, { value: 7, plan_id: plan.plan_id }, world),
    ).rejects.toThrow(/состояние изменилось после построения плана/);
    expect(applied).toEqual([]);

    const records = await journal(world.deps);
    expect(records[0]?.outcome).toBe('rejected');
    // applying не пишется: до бэкенда не дошло.
    expect(records.map((r) => r.outcome)).toEqual(['rejected', 'planned']);
  });

  it('5.4: лок услуги (408) повторяется внутри applyPlan, автору мутатора это не поручено', async () => {
    const world = makeWorld();
    let attempts = 0;
    const tool = defineMutation<Input>(
      {
        name: 'demo_mutate',
        description: 'demo',
        input,
        risk: 'medium',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        guard: { keys: ['value'], read: async () => BEFORE },
        plan: async (i) => ({
          before: BEFORE,
          after: { value: i.value },
          diff: [{ path: 'value', from: 1, to: i.value }],
          sideEffects: [],
        }),
        apply: async () => {
          attempts += 1;
          if (attempts < 3) throw new ShmError('SHM PUT /x: HTTP 408: lock', 408, true);
          return { ok: true };
        },
      },
      world.deps,
    );

    const plan = (await callTool(tool, { value: 7 }, world)) as { plan_id: string };
    const res = (await callTool(tool, { value: 7, plan_id: plan.plan_id }, world)) as {
      status: string;
    };
    expect(res.status).toBe('applied');
    expect(attempts).toBe(3);
  });

  it('провал apply пишется как failed, ошибка пробрасывается наружу', async () => {
    const world = makeWorld();
    const tool = defineMutation<Input>(
      {
        name: 'demo_mutate',
        description: 'demo',
        input,
        risk: 'medium',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        guard: { keys: ['value'], read: async () => BEFORE },
        plan: async () => ({
          before: BEFORE,
          after: { value: 2 },
          diff: [{ path: 'value', from: 1, to: 2 }],
          sideEffects: [],
        }),
        apply: async () => {
          throw new ShmError('HTTP 400: bad request', 400, false);
        },
      },
      world.deps,
    );

    const plan = (await callTool(tool, { value: 1 }, world)) as { plan_id: string };
    // Наружу текст доезжает подстриженным: `stripEmbeddedBodies` исполнителя
    // режет всё после маркера `HTTP <код>: `, потому что там обычно лежит
    // дословное тело бэкенда. Журнал пишется ДО этого прохода и хранит целое.
    await expect(
      callTool(tool, { value: 1, plan_id: plan.plan_id }, world),
    ).rejects.toThrow(/HTTP 400/);

    const records = await journal(world.deps);
    expect(records[0]).toMatchObject({ outcome: 'failed', error: 'HTTP 400: bad request' });
    expect(records[0]?.attempt).toBe(records[1]?.id);
  });

  it('5.7: провал записи журнала ПОСЛЕ успеха не превращает успех в отказ', async () => {
    const world = makeWorld();
    const applied: string[] = [];
    const tool = demoTool(world.deps, applied);
    const plan = (await callTool(tool, { value: 7 }, world)) as { plan_id: string };

    // Журнал ломается ровно на закрывающей записи: applying уже прошла.
    const real = world.deps.audit.write.bind(world.deps.audit);
    let calls = 0;
    world.deps.audit.write = async (entry) => {
      calls += 1;
      if (entry.outcome === 'applied') throw new Error('disk full');
      return real(entry);
    };

    const res = (await callTool(tool, { value: 7, plan_id: plan.plan_id }, world)) as {
      status: string;
      warnings: { code: string }[];
    };
    expect(res.status).toBe('applied');
    expect(res.warnings.map((w) => w.code)).toEqual(['audit_write_failed']);
    expect(applied).toEqual(['{"value":7}']);
    expect(calls).toBeGreaterThan(0);
  });

  it('5.23: план, применённый с другими аргументами, отклоняется и попадает в журнал', async () => {
    const world = makeWorld();
    const tool = demoTool(world.deps, []);
    const plan = (await callTool(tool, { value: 7 }, world)) as { plan_id: string };

    await expect(
      callTool(tool, { value: 8, plan_id: plan.plan_id }, world),
    ).rejects.toThrow(/построен с другими аргументами/);
    expect((await journal(world.deps))[0]?.outcome).toBe('rejected');
  });

  it('5.22: чужой инструмент отклоняет take, а не сам каркас', async () => {
    const world = makeWorld();
    const tool = demoTool(world.deps, []);
    const foreign = await world.deps.confirm.put({
      tool: 'other_tool',
      profile: 'human',
      inputHash: 'irrelevant',
      before: null,
      after: null,
      diff: [],
      sideEffects: [],
    });

    await expect(
      callTool(tool, { value: 1, plan_id: foreign.token }, world),
    ).rejects.toThrow(/принадлежит плану инструмента other_tool/);
    expect((await journal(world.deps))[0]?.outcome).toBe('rejected');
  });

  it('план чужого профиля не применяется и тоже попадает в журнал (К8)', async () => {
    const world = makeWorld();
    const tool = demoTool(world.deps, []);
    const botPlan = await world.deps.confirm.put({
      tool: 'demo_mutate',
      profile: 'bot',
      inputHash: 'irrelevant',
      before: null,
      after: null,
      diff: [],
      sideEffects: [],
    });

    await expect(
      callTool(tool, { value: 1, plan_id: botPlan.token }, world),
    ).rejects.toThrow(/построен профилем bot/);
    expect((await journal(world.deps))[0]?.outcome).toBe('rejected');
  });

  it('отказ на этапе построения плана пишется в журнал как rejected (§7.5)', async () => {
    const world = makeWorld();
    const tool = demoTool(world.deps, []);

    await expect(callTool(tool, { value: 1000 }, world)).rejects.toThrow(/превышает потолок/);

    const records = await journal(world.deps);
    expect(records[0]).toMatchObject({ tool: 'demo_mutate', outcome: 'rejected', mode: 'rw' });
    expect(records[0]?.error).toContain('превышает потолок');
  });
});

describe('defineMutation: режим и видимость', () => {
  it('в режиме ro инструмент не виден исполнителю вовсе', async () => {
    const world = makeWorld({}, { mode: 'ro' });
    const tool = demoTool(world.deps, []);
    const result = await callToolResult(tool, { value: 1 }, world);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
  });

  it('в режиме ro прямой вызов хендлера отказывает второй линией', async () => {
    const world = makeWorld({}, { mode: 'ro' });
    const tool = demoTool(world.deps, []);
    await expect(callHandler(tool, { value: 1 }, world)).rejects.toThrow(/режиме ro/);
  });

  it('объявляет access=rw и пробрасывает requires в ToolDef (К11)', () => {
    const world = makeWorld();
    expect(demoTool(world.deps, []).def.access).toBe('rw');

    const gated = defineMutation<Input>(
      {
        name: 'demo_gated',
        description: 'demo',
        input,
        risk: 'medium',
        profiles: ['human'],
        endpoints: ['POST /admin/demo'],
        requires: ['shm.dry_run'],
        guard: { keys: ['value'], read: async () => BEFORE },
        plan: async () => ({
          before: BEFORE,
          after: { value: 2 },
          diff: [{ path: 'value', from: 1, to: 2 }],
          sideEffects: [],
        }),
        apply: async () => ({ ok: true }),
      },
      world.deps,
    );
    expect(gated.def.requires).toEqual(['shm.dry_run']);
  });
});

describe('defineMutation: проверки на этапе объявления', () => {
  const okPlan = async (): Promise<{
    before: unknown;
    after: unknown;
    diff: { path: string; from: unknown; to: unknown }[];
    sideEffects: string[];
  }> => ({ before: BEFORE, after: { value: 2 }, diff: [{ path: 'value', from: 1, to: 2 }], sideEffects: [] });

  function build(
    deps: MutationDeps,
    endpoints: string[],
    extra: { amountOf?: (i: Input) => DeclaredAmount; keys?: string[] } = {},
  ): MutationTool {
    return defineMutation<Input>(
      {
        name: 'demo_mutate',
        description: 'demo',
        input,
        risk: 'high',
        profiles: ['human'],
        endpoints,
        ...(extra.amountOf === undefined ? {} : { amountOf: extra.amountOf }),
        guard: { keys: extra.keys ?? ['value'], read: async () => BEFORE },
        plan: okPlan,
        apply: async () => ({ ok: true }),
      },
      deps,
    );
  }

  it('5.5: запрещённый эндпоинт роняет объявление, а не первый вызов', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['POST /admin/spool/manual/success/17'])).toThrow(/forbidden/);
    expect(() => build(world.deps, ['POST /api/tokens'])).toThrow(/forbidden/);
    // Сужённое по методу правило не мешает законному соседу того же пути.
    expect(() =>
      build(world.deps, ['PUT /admin/user/payment'], { amountOf: (i) => i.value }),
    ).not.toThrow();
  });

  it('5.5: гейт спрашивает реестр, а не свою копию списка', () => {
    // Каркас не хранит собственного перечня запретов: расходящиеся копии — это
    // ровно тот дефект, где вторая продолжает ВЫГЛЯДЕТЬ работающей. Всё, что
    // объявит реестр, действует здесь автоматически.
    const world = makeWorld();
    for (const rule of FORBIDDEN_RULES) {
      if (rule.match !== 'prefix' || rule.methods !== undefined) continue;
      expect(matchForbidden(rule.pattern, 'POST')).toBeDefined();
      expect(() => build(world.deps, [`POST ${rule.pattern}`])).toThrow(/forbidden/);
    }
  });

  it('мутирующий GET объявить нельзя: клиент откажет на вызове', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['GET /promo/apply/CODE'])).toThrow(/мутирующ/i);
    expect(() => build(world.deps, ['GET /template/smena'])).toThrow(/мутирующ/i);
  });

  it('клиентские маршруты SHM и панели объявляются свободно — не всё живёт в /admin', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['POST /user/service/change'])).not.toThrow();
    expect(() => build(world.deps, ['PATCH /api/users/10165'])).not.toThrow();
  });

  it('эндпоинт без метода или пустой список — отказ', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['/admin/demo'])).toThrow(/METHOD \/path/);
    expect(() => build(world.deps, [])).toThrow(/ни одного эндпоинта/);
  });

  it('5.3: денежная ручка без amountOf не объявляется', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['PUT /admin/user/payment'])).toThrow(/amountOf/);
    expect(() => build(world.deps, ['PUT /admin/user/bonus'])).toThrow(/amountOf/);
    expect(() => build(world.deps, ['PUT /admin/user/service/withdraw'])).toThrow(/amountOf/);
  });

  /**
   * Ручка, тратящая баланс клиента, требует суммы наравне с денежной ручкой
   * реестра. Разница между ними только в том, кто число называет: там —
   * вызывающий, здесь — каталог; потолок один и тот же.
   */
  it('ручка, тратящая баланс клиента, без amountOf не объявляется', () => {
    const world = makeWorld();
    for (const path of BALANCE_SPEND_ENDPOINT_PATHS) {
      expect(() => build(world.deps, [`POST ${path}`])).toThrow(/amountOf/);
      expect(() => build(world.deps, [`POST ${path}`], { amountOf: () => null })).not.toThrow();
    }
  });

  /**
   * Чтение прайса — не списание. Правило сужено до пишущих методов намеренно:
   * иначе всякий инструмент, заглянувший в каталог, обязан был бы называть сумму.
   */
  it('GET на тот же путь денежным инструмент не делает', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['GET /admin/user/service/touch'])).not.toThrow();
  });

  /**
   * Совпадение ТОЧНОЕ, а не по префиксу: `POST /admin/user/service` — это
   * запись поля `next` (плановая смена тарифа), которая денег не двигает, и
   * префиксное правило накрыло бы её заодно с `…/touch` и `…/change`.
   */
  it('соседний путь под тем же корнем денежным не считается', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['POST /admin/user/service'])).not.toThrow();
    expect(() => build(world.deps, ['DELETE /admin/user/service'])).not.toThrow();
    expect(() => build(world.deps, ['POST /admin/user/service/stop'])).not.toThrow();
    expect(() => build(world.deps, ['GET /admin/service'])).not.toThrow();
  });

  it('5.4: guard без единого сверяемого поля — отказ', () => {
    const world = makeWorld();
    expect(() => build(world.deps, ['POST /admin/demo'], { keys: [] })).toThrow(/guard/);
  });

  it('5.13: схема не z.object() — отказ (реестру нужен shape)', () => {
    const world = makeWorld();
    // НЕ `.refine()`: в zod 4 он возвращает тот же ZodObject и `shape` не
    // теряет (проверено на 4.4.3) — то есть предпосылка поправки 5.13 верна
    // только для zod 3. Форму теряют `.transform()`/`.pipe()` и `z.union()`,
    // и именно они уронили бы Registry.register при сборке рантайма.
    const piped = z.object({ value: z.number(), ...planIdField }).transform((i) => i);
    expect(() =>
      defineMutation<Input>(
        {
          name: 'demo_mutate',
          description: 'demo',
          input: piped as unknown as typeof input,
          risk: 'low',
          profiles: ['human'],
          endpoints: ['POST /admin/demo'],
          guard: { keys: ['value'], read: async () => BEFORE },
          plan: okPlan,
          apply: async () => ({ ok: true }),
        },
        world.deps,
      ),
    ).toThrow(/z\.object/);
  });

  it('5.13: схема без shape отвергается ТИПОМ, а не только в рантайме', () => {
    // @ts-expect-error — ZodPipe не имеет shape, и MutationInput его не примет.
    // Проверка стоит здесь, а не в комментарии: сними сужение типа — и этот
    // тест перестанет компилироваться, потому что ошибки больше не будет.
    const bad: MutationInput<Input> = z
      .object({ value: z.number(), ...planIdField })
      .transform((i) => i);
    expect(bad).toBeDefined();
  });

  it('5.14: схема без plan_id — отказ (иначе инструмент навсегда в режиме плана)', () => {
    const world = makeWorld();
    const noField = z.object({ value: z.number() });
    expect(() =>
      defineMutation<{ value: number; plan_id?: string | undefined }>(
        {
          name: 'demo_mutate',
          description: 'demo',
          input: noField as unknown as typeof input,
          risk: 'low',
          profiles: ['human'],
          endpoints: ['POST /admin/demo'],
          guard: { keys: ['value'], read: async () => BEFORE },
          plan: okPlan,
          apply: async () => ({ ok: true }),
        },
        world.deps,
      ),
    ).toThrow(/plan_id/);
  });
});

describe('потолок суммы (5.3)', () => {
  const moneyInput = z.object({ amount: z.number(), ...planIdField });
  type MoneyInput = z.infer<typeof moneyInput>;

  function moneyTool(
    deps: MutationDeps,
    amountOf: (i: MoneyInput) => DeclaredAmount,
    draftAmount?: number,
  ): MutationTool {
    return defineMutation<MoneyInput>(
      {
        name: 'billing_demo',
        description: 'demo',
        input: moneyInput,
        risk: 'high',
        profiles: ['human'],
        endpoints: ['PUT /admin/user/payment'],
        amountOf,
        guard: { keys: ['lastPayId'], read: async () => ({ lastPayId: 10 }) },
        plan: async (i) => ({
          before: { lastPayId: 10 },
          after: { lastPayId: 11 },
          diff: [{ path: 'balance', from: 0, to: i.amount }],
          sideEffects: [],
          ...(draftAmount === undefined ? {} : { amount: draftAmount }),
        }),
        apply: async () => ({ id: 11 }),
      },
      deps,
    );
  }

  it('одна и та же сумма проходит под одним потолком и отклоняется под другим', async () => {
    const loose = makeWorld({}, { maxOpAmount: 10_000 });
    const res = (await callTool(moneyTool(loose.deps, (i) => i.amount), { amount: 9000 }, loose)) as {
      status: string;
    };
    expect(res.status).toBe('plan');

    const tight = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(moneyTool(tight.deps, (i) => i.amount), { amount: 9000 }, tight),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
    const { records } = await tight.deps.audit.search({});
    expect(records[0]).toMatchObject({ outcome: 'rejected' });
  });

  it('потолок берётся по модулю: списание такого же размера тоже отклоняется', async () => {
    const world = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(moneyTool(world.deps, (i) => i.amount), { amount: -9000 }, world),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });

  it('сумма, узнанная только при планировании (dry_run), проверяется после плана', async () => {
    const world = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(moneyTool(world.deps, () => null, 9000), { amount: 1 }, world),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });

  it('денежный план, не сообщивший суммы вовсе, не выдаёт токен', async () => {
    const world = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(moneyTool(world.deps, () => null), { amount: 1 }, world),
    ).rejects.toThrow(/не сообщил сумму/);
  });

  /**
   * NO_MONEY существует ради инструментов, у которых денежным является
   * ДЕЙСТВИЕ, а не сам инструмент. У денежной ручки реестра такого действия
   * нет: сумму туда передаёт вызывающий, и «этот вызов денег не двигает»
   * означало бы, что потолок выключается по просьбе автора.
   */
  it('денежная ручка реестра отказаться от суммы не может', async () => {
    const world = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(moneyTool(world.deps, () => NO_MONEY), { amount: 1 }, world),
    ).rejects.toThrow(/NO_MONEY/);
    const { records } = await world.deps.audit.search({});
    expect(records[0]).toMatchObject({ outcome: 'rejected' });
  });
});

/**
 * ПОТОЛОК НА ДЕЙСТВИЯХ, ТРАТЯЩИХ БАЛАНС КЛИЕНТА.
 *
 * Денежность бывает свойством ДЕЙСТВИЯ, а не инструмента: `service_lifecycle`
 * объявляет одним инструментом и заказ услуги (списание), и остановку (не
 * двигает ничего). Каркас обязан уметь и то, и другое — требовать сумму там,
 * где она есть, и не требовать там, где её нет.
 */
describe('потолок на ручках, тратящих баланс клиента', () => {
  const spendInput = z.object({ free: z.boolean(), ...planIdField });
  type SpendInput = z.infer<typeof spendInput>;

  function spendTool(
    deps: MutationDeps,
    draftAmount?: number,
    endpoint = 'PUT /admin/service/order',
  ): MutationTool {
    return defineMutation<SpendInput>(
      {
        name: 'lifecycle_demo',
        description: 'demo',
        input: spendInput,
        risk: 'high',
        profiles: ['human'],
        endpoints: [endpoint],
        amountOf: (i): DeclaredAmount => (i.free ? NO_MONEY : null),
        guard: { keys: ['status'], read: async () => ({ status: 'ACTIVE' }) },
        plan: async () => ({
          before: { status: 'ACTIVE' },
          after: { status: 'BLOCK' },
          diff: [{ path: 'status', from: 'ACTIVE', to: 'BLOCK' }],
          sideEffects: [],
          ...(draftAmount === undefined ? {} : { amount: draftAmount }),
        }),
        apply: async () => ({ ok: true }),
      },
      deps,
    );
  }

  it('сумма из плана проверяется потолком так же, как у прямого платежа', async () => {
    const loose = makeWorld({}, { maxOpAmount: 10_000 });
    const ok = (await callTool(spendTool(loose.deps, 7500), { free: false }, loose)) as {
      status: string;
    };
    expect(ok.status).toBe('plan');

    const tight = makeWorld({}, { maxOpAmount: 5000 });
    await expect(
      callTool(spendTool(tight.deps, 7500), { free: false }, tight),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });

  it('план, не назвавший цену, отклоняется — незнание суммы её не обнуляет', async () => {
    const world = makeWorld({}, { maxOpAmount: 5000 });
    await expect(callTool(spendTool(world.deps), { free: false }, world)).rejects.toThrow(
      /не сообщил сумму/,
    );
    const { records } = await world.deps.audit.search({});
    expect(records[0]).toMatchObject({ outcome: 'rejected' });
  });

  it('действие, объявившее NO_MONEY, суммы не требует и потолком не ограничено', async () => {
    const world = makeWorld({}, { maxOpAmount: 1 });
    const plan = (await callTool(spendTool(world.deps), { free: true }, world)) as {
      status: string;
    };
    expect(plan.status).toBe('plan');
  });

  it('правило действует на каждой ручке списка, а не только на заказе', async () => {
    for (const path of BALANCE_SPEND_ENDPOINT_PATHS) {
      const world = makeWorld({}, { maxOpAmount: 5000 });
      await expect(
        callTool(spendTool(world.deps, 7500, `POST ${path}`), { free: false }, world),
      ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
    }
  });
});

/**
 * ПОТОЛОК ЧИСЛА ЗАТРОНУТЫХ — РОДНОЙ БРАТ ДЕНЕЖНОГО И ПО ТОЙ ЖЕ ПРИЧИНЕ ЖИВЁТ В
 * КАРКАСЕ. Автор инструмента, проверяющий его сам, однажды не проверит; разница
 * лишь в том, что цена промаха здесь измеряется не рублями, а числом клиентов,
 * у которых что-то сломалось одновременно.
 *
 * `amountOf`-аналога нет намеренно: из аргументов это число не выводится
 * никогда — список id это имена, а не существующие учётки, а у `bulk/all/*`
 * списка нет вовсе. Сообщить его может только план, спросив панель.
 */
describe('потолок массовой операции', () => {
  const bulkInput = z.object({ ...planIdField });
  type BulkInput = z.infer<typeof bulkInput>;

  function bulkTool(
    deps: MutationDeps,
    affectedUsers: number | undefined,
    over: { profiles?: ('human' | 'bot')[]; endpoint?: string } = {},
  ): MutationTool {
    return defineMutation<BulkInput>(
      {
        name: 'bulk_demo',
        description: 'demo',
        input: bulkInput,
        risk: 'high',
        profiles: over.profiles ?? ['human'],
        endpoints: [over.endpoint ?? 'POST /api/users/bulk/reset-traffic'],
        guard: { keys: ['count'], read: async () => ({ count: 1 }) },
        plan: async () => ({
          before: { count: 1 },
          after: { count: 2 },
          diff: [{ path: 'count', from: 1, to: 2 }],
          sideEffects: [],
          ...(affectedUsers === undefined ? {} : { affectedUsers }),
        }),
        apply: async () => ({ ok: true }),
      },
      deps,
    );
  }

  it('одно и то же число проходит под одним потолком и отклоняется под другим', async () => {
    const loose = makeWorld({}, { maxBulkUsers: 500 });
    expect(await callTool(bulkTool(loose.deps, 120), {}, loose)).toMatchObject({ status: 'plan' });

    const tight = makeWorld({}, { maxBulkUsers: 100 });
    await expect(callTool(bulkTool(tight.deps, 120), {}, tight)).rejects.toThrow(
      /затронет 120 клиентов.*HQ_MCP_MAX_BULK_USERS=100/s,
    );
    const { records } = await tight.deps.audit.search({});
    expect(records[0]).toMatchObject({ outcome: 'rejected' });
  });

  it('массовый план без числа затронутых не выдаёт токен', async () => {
    const world = makeWorld({}, { maxBulkUsers: 100 });
    await expect(callTool(bulkTool(world.deps, undefined), {}, world)).rejects.toThrow(
      /affectedUsers пуст/,
    );
  });

  /**
   * Требование, которое не должно зависеть от внимательности автора: массовая
   * ручка и профиль бота несовместимы, и узнать об этом надо при сборке
   * реестра, а не от бота, отключившего сотню клиентов.
   */
  it('инструмент с массовой ручкой, отданный боту, не собирается вовсе', () => {
    const world = makeWorld({});
    expect(() => bulkTool(world.deps, 1, { profiles: ['human', 'bot'] })).toThrow(
      /массовую ручку.*bot/s,
    );
    expect(() => bulkTool(world.deps, 1, { profiles: ['bot'] })).toThrow(/массовую ручку/);
    expect(() => bulkTool(world.deps, 1, { profiles: ['human'] })).not.toThrow();
  });

  /**
   * Требование навешено на ПРЕФИКС `/api/users/bulk`, а не на список известных
   * имён: ручка, которую Remnawave заведёт под этим корнем завтра, попадёт под
   * счёт сама, а не тогда, когда кто-нибудь вспомнит дописать её в список.
   */
  it('требование действует и на ручку, которой сегодня ещё нет', async () => {
    const world = makeWorld({}, { maxBulkUsers: 100 });
    await expect(
      callTool(
        bulkTool(world.deps, undefined, { endpoint: 'POST /api/users/bulk/all/something-new' }),
        {},
        world,
      ),
    ).rejects.toThrow(/affectedUsers пуст/);
  });

  it('на немассовый инструмент требование не распространяется', async () => {
    const world = makeWorld({}, { maxBulkUsers: 1 });
    expect(
      await callTool(
        bulkTool(world.deps, undefined, { endpoint: 'POST /api/users/18171/actions/enable' }),
        {},
        world,
      ),
    ).toMatchObject({ status: 'plan' });
  });
});

describe('retryOn408', () => {
  it('повторяет лок услуги и в итоге отдаёт результат', async () => {
    let calls = 0;
    const result = await retryOn408(
      async () => {
        calls += 1;
        if (calls < 3) throw new ShmError('SHM PUT /x: HTTP 408: lock', 408, true);
        return 'ok';
      },
      { sleep: async () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('5.2: таймаут клиента НЕ повторяется — ответ мог дойти, а деньги уже уйти', async () => {
    let calls = 0;
    await expect(
      retryOn408(
        async () => {
          calls += 1;
          // Ровно то, что строит клиент SHM на таймауте: status 0, retryable true.
          throw new ShmError(
            'SHM request PUT /admin/user/payment failed: The operation was aborted due to timeout',
            0,
            true,
          );
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
  });

  it('терминальную ошибку (429) не повторяет: ретрай добивает общее ведро (§6.14)', async () => {
    let calls = 0;
    await expect(
      retryOn408(
        async () => {
          calls += 1;
          throw new ShmError('HTTP 429: rate limit', 429, false);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/429/);
    expect(calls).toBe(1);
  });

  it('чужую ошибку (не ShmError) не повторяет', async () => {
    let calls = 0;
    await expect(
      retryOn408(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });
});

describe('defaultSleep', () => {
  it('вешает таймер с unref: долгоживущий MCP-процесс не удерживается спящей паузой (§6.22)', async () => {
    let unrefCalled = false;
    const realSetTimeout = globalThis.setTimeout;
    const spy = ((handler: () => void, ms?: number) => {
      const handle = realSetTimeout(handler, ms);
      return {
        unref: () => {
          unrefCalled = true;
          handle.unref();
          return handle;
        },
      };
    }) as unknown as typeof globalThis.setTimeout;

    globalThis.setTimeout = spy;
    try {
      await defaultSleep(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(unrefCalled).toBe(true);
  });
});

describe('assertUnchanged', () => {
  it('молчит, когда сверяемые поля не изменились', () => {
    expect(() =>
      assertUnchanged(
        { status: 'ACTIVE', expireAt: 'x' },
        { status: 'ACTIVE', expireAt: 'x', extra: 1 },
        ['status', 'expireAt'],
        'subscription_ops',
      ),
    ).not.toThrow();
  });

  it('бросает, когда состояние уехало после построения плана', () => {
    expect(() =>
      assertUnchanged({ status: 'ACTIVE' }, { status: 'DISABLED' }, ['status'], 'subscription_ops'),
    ).toThrow(/состояние изменилось после построения плана/);
  });

  it('исчезнувший объект — тоже расхождение, а не «поля совпали»', () => {
    expect(() => assertUnchanged({ status: 'ACTIVE' }, null, ['status'], 'x')).toThrow(
      /состояние изменилось/,
    );
  });
});

describe('MutationTool', () => {
  it('несёт применение, guard и объявленные эндпоинты для ops_confirm', () => {
    const world = makeWorld();
    const tool = demoTool(world.deps, []);
    expect(tool.name).toBe('demo_mutate');
    expect(tool.endpoints).toEqual(['POST /admin/demo']);
    expect(tool.guard.keys).toEqual(['value']);
    expect(typeof tool.apply).toBe('function');
    const plan: MutationPlan = {
      token: '00000000-0000-4000-8000-000000000000',
      tool: 'demo_mutate',
      profile: 'human',
      createdAt: '2026-08-08T12:00:00.000Z',
      expiresAt: '2026-08-08T12:10:00.000Z',
      inputHash: 'x',
      before: BEFORE,
      after: { value: 7 },
      diff: [],
      sideEffects: [],
    };
    expect(plan.tool).toBe(tool.name);
  });
});
