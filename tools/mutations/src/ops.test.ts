import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '@hq/redact';
import { opsAudit, opsConfirm } from './ops.js';
import { callTool, callToolResult, listOf, makeWorld } from './testkit.js';
import { userFlags } from './user/flags.js';
import type { MutationTool } from './kit.js';
import type { FakeWorld } from './testkit.js';
import type { MutationDraft } from '@hq/confirm';

interface AuditOut {
  unclosed: Array<{
    id: string;
    tool: string;
    calls: string[];
    ageMinutes: number | null;
    plan_id: string | null;
  }>;
  counts: { returned: number; unclosed: number; corrupt: number; scannedRecords: number };
  warnings: Array<{ code: string; message: string }>;
  filter: { plan_id: string | null; since: string | null; tool: string | null };
  records: Array<{ tool: string; outcome: string; input: unknown; before: unknown }>;
}

const USER = { user_id: 3073, block: 0, full_name: 'Иван', phone: null, comment: null };

function flagsWorld(): FakeWorld {
  return makeWorld({
    shmGet: () => [USER],
    shmList: () => listOf([USER]),
    shmAction: () => [{ user_id: 3073, block: 1 }],
  });
}

function draft(over: Partial<MutationDraft> = {}): MutationDraft {
  return {
    tool: 'user_flags',
    profile: 'human',
    inputHash: 'deadbeef',
    // Снимок «до» ровно той формы, которую читает guard user_flags: сверка
    // мира сравнивает все поля whitelist, а не только изменяемое.
    before: { user_id: 3073, block: 0, full_name: 'Иван', phone: null, comment: null },
    after: { user_id: 3073, block: 1 },
    diff: [{ path: 'block', from: 0, to: 1 }],
    sideEffects: [],
    ...over,
  };
}

async function writeRecord(
  world: FakeWorld,
  over: Partial<Parameters<FakeWorld['deps']['audit']['write']>[0]> = {},
): Promise<{ id: string }> {
  return world.deps.audit.write({
    tool: 'billing_adjust',
    profile: 'human',
    mode: 'rw',
    outcome: 'planned',
    input: {},
    before: null,
    after: null,
    ...over,
  });
}

describe('ops_audit', () => {
  it('журнал мутаций — часть мутационной поверхности: rw и только human (К21, К9)', () => {
    const tool = opsAudit(makeWorld().deps);
    expect(tool.access).toBe('rw');
    expect(tool.profiles).toEqual(['human']);
    expect(tool.risk).toBe('none');
  });

  it('боту не отдаётся даже прямым вызовом хендлера мимо реестра', async () => {
    const w = makeWorld({}, { profile: 'bot' });
    const tool = opsAudit(w.deps);
    await expect(tool.handler(tool.input.parse({}) as never, w.ctx)).rejects.toThrow(/только профилю human/);
  });

  it('отдаёт записи свежими первыми и фильтрует по инструменту', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    await writeRecord(w, { tool: 'billing_adjust', outcome: 'planned' });
    await writeRecord(w, { tool: 'user_flags', outcome: 'applied' });

    const all = (await callTool(tool, { limit: 10 }, w)) as AuditOut;
    expect(all.counts.returned).toBe(2);
    expect(all.records[0]?.tool).toBe('user_flags');

    const filtered = (await callTool(tool, { tool: 'billing_adjust', limit: 10 }, w)) as AuditOut;
    expect(filtered.counts.returned).toBe(1);
    expect(filtered.records[0]?.tool).toBe('billing_adjust');
  });

  it('фильтрует по идентификатору плана и по адресату', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    await writeRecord(w, { token: 't-1', target: { system: 'shm', id: 3073 } });
    await writeRecord(w, { token: 't-2', target: { system: 'remna', id: 'uuid-9' } });

    const byToken = (await callTool(tool, { plan_id: 't-1' }, w)) as AuditOut;
    expect(byToken.counts.returned).toBe(1);

    // id клиента приезжает из SHM числом, а из ввода инструмента — строкой:
    // это один и тот же клиент, и фильтр обязан их не различать.
    const byTarget = (await callTool(tool, { target_system: 'shm', target_id: '3073' }, w)) as AuditOut;
    expect(byTarget.counts.returned).toBe(1);
  });

  /**
   * `since` сравнивается СТРОКОЙ, а `at` записан в UTC. Значение со смещением
   * лексикографически больше своего же UTC-эквивалента — без нормализации окно
   * молча уезжает ровно на размер офсета.
   */
  it('нормализует since в UTC, а не сравнивает строку со смещением как есть', async () => {
    const w = makeWorld({}, { now: new Date('2026-08-08T10:00:00.000Z') });
    const tool = opsAudit(w.deps);
    await writeRecord(w, {});

    const res = (await callTool(tool, { since: '2026-08-08T12:00:00+03:00' }, w)) as AuditOut;
    expect(res.filter.since).toBe('2026-08-08T09:00:00.000Z');
    expect(res.counts.returned).toBe(1);
  });

  it('неразбираемый since — ошибка, а не фильтр, который ничего не отфильтровал', async () => {
    const w = makeWorld();
    const res = await callToolResult(opsAudit(w.deps), { since: '13.08.2026' }, w);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/не разбирается как дата/);
  });

  it('НЕЗАКРЫТАЯ applying выносится наверх отдельным полем и предупреждением', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    const started = await writeRecord(w, {
      tool: 'billing_adjust',
      outcome: 'applying',
      token: 't-9',
      calls: ['PUT /admin/user/payment'],
      target: { system: 'shm', id: 3073 },
    });

    const res = (await callTool(tool, {}, w)) as AuditOut;
    expect(res.counts.unclosed).toBe(1);
    expect(res.unclosed[0]?.id).toBe(started.id);
    expect(res.unclosed[0]?.plan_id).toBe('t-9');
    expect(res.unclosed[0]?.calls).toEqual(['PUT /admin/user/payment']);
    expect(res.warnings.map((one) => one.code)).toContain('unclosed_applying');
    expect(res.warnings.find((one) => one.code === 'unclosed_applying')?.message).toMatch(
      /деньги могли\s+двинуться|деньги могли двинуться/,
    );
  });

  it('закрытая пара незакрытой не считается', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    const started = await writeRecord(w, { outcome: 'applying', token: 't-9' });
    await writeRecord(w, { outcome: 'applied', token: 't-9', attempt: started.id });

    const res = (await callTool(tool, {}, w)) as AuditOut;
    expect(res.counts.unclosed).toBe(0);
    expect(res.warnings.map((one) => one.code)).not.toContain('unclosed_applying');
  });

  /**
   * САМАЯ ВАЖНАЯ ПРОВЕРКА ЭТОГО ИНСТРУМЕНТА. Пара «applying + applied» лежит
   * дальше запрошенного окна, и поиск, идущий по окну, показал бы ЛОЖНУЮ
   * незакрытую попытку — тревогу, за которой ничего нет.
   */
  it('ищет незакрытые по ВСЕМУ журналу, а не по запрошенному окну', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    const started = await writeRecord(w, { outcome: 'applying', token: 't-9' });
    await writeRecord(w, { outcome: 'applied', token: 't-9', attempt: started.id });
    for (let i = 0; i < 5; i += 1) await writeRecord(w, { outcome: 'planned' });

    const res = (await callTool(tool, { limit: 1 }, w)) as AuditOut;
    expect(res.counts.returned).toBe(1);
    expect(res.counts.scannedRecords).toBe(7);
    expect(res.counts.unclosed).toBe(0);
  });

  it('битые строки не проглатываются молча: их число и предупреждение в ответе', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    await writeRecord(w, {});
    const raw = await readFile(w.auditPath, 'utf8');
    await writeFile(w.auditPath, `${raw}{"id":"оборвано на середин\n`, 'utf8');

    const res = (await callTool(tool, {}, w)) as AuditOut;
    expect(res.counts.corrupt).toBe(1);
    expect(res.warnings.map((one) => one.code)).toContain('journal_lines_unreadable');
  });

  /**
   * `executeTool` маскирует по ИМЕНИ ключа, а поле записи зовётся `token` — под
   * своим именем идентификатор плана приезжал бы к модели как '<redacted>', то
   * есть единственная связь между `planned` и `applied` исчезала бы в каждой
   * строке. Тот же дефект, из-за которого поле подтверждения зовут `plan_id`.
   */
  it('идентификатор плана доезжает до модели, а не превращается в маркер', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    const token = '11111111-2222-3333-4444-555555555555';
    await writeRecord(w, { outcome: 'planned', token });

    const res = (await callTool(tool, { plan_id: token }, w)) as AuditOut;
    const record = res.records[0] as unknown as Record<string, unknown>;
    expect(record.plan_id).toBe(token);
    expect(record.token).toBeUndefined();
    expect(res.filter.plan_id).toBe(token);
    expect(JSON.stringify(res)).not.toContain(REDACTED);
  });

  it('пустой журнал — это пустой ответ, а не ошибка', async () => {
    const w = makeWorld();
    const res = (await callTool(opsAudit(w.deps), {}, w)) as AuditOut;
    expect(res).toMatchObject({ unclosed: [], records: [] });
    expect(res.counts).toMatchObject({ returned: 0, unclosed: 0, corrupt: 0 });
  });

  /**
   * Снимки в журнале лежат НЕредактированными — иначе откатом уехал бы маркер
   * вместо значения. Токен бота живёт внутри значения обычного поля `host`, и
   * редакция по имени ключа его не видит: ловит его проход по форме.
   */
  it('вырезает секреты по форме из снимков и считает вырезанное', async () => {
    const w = makeWorld();
    const tool = opsAudit(w.deps);
    await writeRecord(w, {
      tool: 'server_edit',
      before: { host: 'https://api.telegram.org/bot7331234567:AAF9kZq2xWvBn4TcMdLpQr8sYh3JgEuVwXy/sendMessage' },
    });

    const res = (await callTool(tool, {}, w)) as AuditOut;
    const before = res.records[0]?.before as { host: string };
    expect(before.host).not.toContain('AAF9kZq2xWvBn4TcMdLpQr8sYh3JgEuVwXy');
    expect(before.host).toContain('api.telegram.org');
    expect(res.warnings.map((one) => one.code)).toContain('secret_shapes_scrubbed');
  });
});

describe('ops_confirm', () => {
  function toolsOf(world: FakeWorld): MutationTool[] {
    return [userFlags(world.deps)];
  }

  it('объявлен как rw и высокий риск, доступен только human', () => {
    const def = opsConfirm(makeWorld().deps, []);
    expect(def.access).toBe('rw');
    expect(def.risk).toBe('high');
    expect(def.profiles).toEqual(['human']);
  });

  it('применяет план, найдя исполнителя по имени инструмента из самого плана', async () => {
    const w = flagsWorld();
    const def = opsConfirm(w.deps, toolsOf(w));
    const plan = (await callTool(userFlags(w.deps), { user_id: 3073, fields: { block: 1 } }, w)) as {
      plan_id: string;
    };

    const res = (await callTool(def, { plan_id: plan.plan_id }, w)) as {
      status: string;
      tool: string;
    };
    expect(res).toMatchObject({ status: 'applied', tool: 'user_flags' });
    const write = w.calls.find((one) => one.method === 'POST');
    expect(write?.path).toBe('/admin/user');
    expect(write?.body).toEqual({ user_id: 3073, block: 1 });
  });

  it('токен одноразовый: второе подтверждение того же плана невозможно', async () => {
    const w = flagsWorld();
    const def = opsConfirm(w.deps, toolsOf(w));
    const plan = (await callTool(userFlags(w.deps), { user_id: 3073, fields: { block: 1 } }, w)) as {
      plan_id: string;
    };

    await callTool(def, { plan_id: plan.plan_id }, w);
    await expect(callTool(def, { plan_id: plan.plan_id }, w)).rejects.toThrow(
      /уже использован|не найден/,
    );
  });

  /**
   * ГЛАВНОЕ СВОЙСТВО ЭТОГО ИНСТРУМЕНТА: отказ на СОБСТВЕННОЙ проверке не имеет
   * права стоить человеку исправного плана. Отказала конфигурация сервера, а не
   * план, — и снимок обязан остаться на диске.
   */
  it('отвергнутое подтверждение НЕ сжигает план: он остаётся применимым', async () => {
    const w = flagsWorld();
    const plan = await w.deps.confirm.put(draft());

    // Сборка без user_flags — «применить нечем».
    const blind = opsConfirm(w.deps, []);
    await expect(callTool(blind, { plan_id: plan.token }, w)).rejects.toThrow(/применить его нечем/);

    // Тот же токен, правильная сборка — план на месте и применяется.
    const def = opsConfirm(w.deps, toolsOf(w));
    const res = (await callTool(def, { plan_id: plan.token }, w)) as { status: string };
    expect(res.status).toBe('applied');
  });

  it('план инструмента, невидимого профилю, не применяется и НЕ сгорает', async () => {
    const w = makeWorld({}, { profile: 'bot' });
    const plan = await w.deps.confirm.put(draft({ profile: 'bot' }));
    const hidden = userFlags(w.deps); // profiles: ['human']
    const def = opsConfirm(w.deps, [hidden]);

    // Прямой вызов хендлера: реестр не показал бы боту сам ops_confirm, и до
    // проверки видимости ПЛАНА дело бы не дошло.
    await expect(
      def.handler(def.input.parse({ plan_id: plan.token }) as never, w.ctx),
    ).rejects.toThrow(/только профиль human/);

    await expect(w.deps.confirm.peek(plan.token)).resolves.toMatchObject({ tool: 'user_flags' });
  });

  it('чужой профиль-создатель отбивается хранилищем, план остаётся на диске (К8)', async () => {
    const human = flagsWorld();
    const bot = makeWorld({}, { profile: 'bot' });
    // Каталог снимков общий, как в реальном развёртывании: HQ_MCP_SNAPSHOT_DIR
    // один на stdio и http.
    const botDeps = { ...bot.deps, confirm: human.deps.confirm };
    const botWorld: FakeWorld = { ...bot, deps: botDeps };
    const plan = await human.deps.confirm.put(draft());

    // Видимость инструмента боту открыта искусственно — проверяется именно
    // профиль-СОЗДАТЕЛЬ, а не видимость.
    const visible = { ...userFlags(botDeps), def: { ...userFlags(botDeps).def, profiles: ['human', 'bot'] } } as MutationTool;
    const def = opsConfirm(botDeps, [visible]);
    await expect(
      def.handler(def.input.parse({ plan_id: plan.token }) as never, botWorld.ctx),
    ).rejects.toThrow(/только профиль human|построен профилем human/);

    await expect(human.deps.confirm.peek(plan.token)).resolves.toMatchObject({ tool: 'user_flags' });
  });

  it('несуществующий токен — отказ с записью в журнал', async () => {
    const w = makeWorld();
    const def = opsConfirm(w.deps, toolsOf(w));
    await expect(
      callTool(def, { plan_id: '11111111-2222-3333-4444-555555555555' }, w),
    ).rejects.toThrow(/не найден|уже использован/);

    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({ tool: 'ops_confirm', outcome: 'rejected' });
  });

  it('в режиме ro отказывает (вторая линия к фильтру реестра)', async () => {
    const w = makeWorld({}, { mode: 'ro' });
    const def = opsConfirm(w.deps, []);
    await expect(
      def.handler(
        def.input.parse({ plan_id: '11111111-2222-3333-4444-555555555555' }) as never,
        w.ctx,
      ),
    ).rejects.toThrow(/режиме ro/);
  });

  it('поле называется plan_id: confirm_token доехал бы до модели как <redacted>', () => {
    const def = opsConfirm(makeWorld().deps, []);
    const shape = (def.input as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual(['plan_id']);
  });

  it('уехавший мир отбивается сверкой ДО записи, и это видно в журнале', async () => {
    let block = 0;
    const w = makeWorld({
      shmGet: () => [{ ...USER, block }],
      shmList: () => listOf([{ ...USER, block }]),
      shmAction: () => [{ user_id: 3073, block: 1 }],
    });
    const flags = userFlags(w.deps);
    const plan = (await callTool(flags, { user_id: 3073, fields: { block: 1 } }, w)) as {
      plan_id: string;
    };

    block = 1; // кто-то заблокировал клиента между планом и подтверждением
    const def = opsConfirm(w.deps, [flags]);
    await expect(callTool(def, { plan_id: plan.plan_id }, w)).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((one) => one.method === 'POST')).toBe(false);

    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({ outcome: 'rejected', tool: 'user_flags' });
  });
});
