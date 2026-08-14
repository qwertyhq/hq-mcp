import { describe, expect, it } from 'vitest';
import { ALLOWED_USER_FIELDS, FORBIDDEN_USER_FIELDS, userFlags } from './flags.js';
import { callTool, listOf, makeWorld, planThenApply } from '../testkit.js';
import type { FakeWorld } from '../testkit.js';

const USER = {
  user_id: 3073,
  block: 0,
  full_name: 'Иван',
  phone: null,
  comment: null,
  gid: 0,
  balance: '1200.00',
};

const SERVICES = [
  { user_service_id: 55, service_id: 21, status: 'ACTIVE', name: 'Месяц' },
  { user_service_id: 56, service_id: 22, status: 'BLOCK', name: 'Год' },
];

function world(
  opts: { user?: Record<string, unknown>; actionResult?: unknown; onAction?: () => void } = {},
): FakeWorld {
  const row = { ...USER, ...(opts.user ?? {}) };
  return makeWorld({
    shmGet: () => [row],
    shmList: (path: string) => (path === '/admin/user/service' ? listOf(SERVICES) : listOf([row])),
    shmAction: () => {
      opts.onAction?.();
      return opts.actionResult ?? [{ user_id: 3073, block: 1 }];
    },
  });
}

describe('user_flags', () => {
  it('whitelist не содержит опасных полей', () => {
    for (const field of ['gid', 'balance', 'bonus', 'password', 'partner_id']) {
      expect(ALLOWED_USER_FIELDS as readonly string[]).not.toContain(field);
      expect(FORBIDDEN_USER_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('боту инструмент не отдаётся: profiles ровно ["human"] (К21)', () => {
    expect(userFlags(world().deps).def.profiles).toEqual(['human']);
  });

  it('блокирует клиента и показывает diff ровно по изменённому полю', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, fields: { block: 1 } }, w)) as {
      diff: Array<{ path: string; from: unknown; to: unknown }>;
      plan_id: string;
    };
    expect(plan.diff).toEqual([{ path: 'block', from: 0, to: 1 }]);

    await callTool(tool, { user_id: 3073, fields: { block: 1 }, plan_id: plan.plan_id }, w);
    const call = w.calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/admin/user');
    expect(call?.body).toEqual({ user_id: 3073, block: 1 });
  });

  /**
   * Ключ обязан пережить `def.input.parse`, иначе объяснение про gid не
   * прозвучит никогда: strip-режим z.object вырезал бы его до хендлера, и
   * пользователь получил бы «не передано ни одного поля».
   */
  it('gid=1 доезжает до хендлера через parse и отбивается объяснением', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    const parsed = tool.def.input.safeParse({ user_id: 3073, fields: { gid: 1 } });
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.data)).toContain('gid');

    await expect(callTool(tool, { user_id: 3073, fields: { gid: 1 } }, w)).rejects.toThrow(
      /gid.*админск/s,
    );
    expect(w.calls).toEqual([]);

    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({
      tool: 'user_flags',
      outcome: 'rejected',
      target: { system: 'shm', id: 3073 },
    });
  });

  it('balance через user_flags не правится — для этого есть billing_adjust', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 3073, fields: { balance: 100000 } }, w)).rejects.toThrow(
      /billing_adjust/,
    );
  });

  it('неизвестное поле отбивается со списком разрешённых', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 3073, fields: { login: 'tg1' } }, w)).rejects.toThrow(
      /вне whitelist/,
    );
  });

  it('неверный тип значения отбивается хендлером, а не молча уезжает в SHM', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 3073, fields: { block: 7 } }, w)).rejects.toThrow(
      /block принимает только 0 или 1/,
    );
  });

  it('пустой набор полей отбивается', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 3073, fields: {} }, w)).rejects.toThrow(/ни одного поля/);
  });

  it('повторная блокировка уже заблокированного отбивается с адресом настоящей проблемы', async () => {
    const w = world({ user: { block: 1 } });
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 3073, fields: { block: 1 } }, w)).rejects.toThrow(
      /уже заблокирован.*service_lifecycle/s,
    );
  });

  it('ложный успех (200 + data:[null]) не считается блокировкой', async () => {
    const w = world({ actionResult: [null] });
    const tool = userFlags(w.deps);
    await expect(planThenApply(tool, { user_id: 3073, fields: { block: 1 } }, w)).rejects.toThrow();
  });

  /**
   * Самое важное утверждение инструмента. `Core::User::set` при block=1 делает
   * ровно одно — убивает веб-сессии (User.pm:884-892). Ни услуг, ни панели он
   * не касается, и молчание об этом оставляет оператора в уверенности, что
   * доступ закрыт, когда VPN продолжает работать.
   */
  it('план говорит, что блокировка НЕ отключает доступ, и называет что делать дальше', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, fields: { block: 1 } }, w)) as {
      sideEffects: string[];
    };
    const text = plan.sideEffects.join(' ');
    expect(text).toMatch(/НЕ ОТКЛЮЧАЕТ ДОСТУП/);
    expect(text).toMatch(/blockedButActiveInPanel/);
    expect(text).toMatch(/service_lifecycle action=stop/);
    expect(text).toMatch(/поиск/i);
  });

  it('план перечисляет действующие услуги, которые блокировка не остановит', async () => {
    const w = world();
    const tool = userFlags(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, fields: { block: 1 } }, w)) as {
      sideEffects: string[];
    };
    const text = plan.sideEffects.join(' ');
    expect(text).toMatch(/1 действующих услуг/);
    expect(text).toMatch(/55 \(Месяц\)/);
    expect(text).not.toMatch(/56/);
  });

  it('разблокировка говорит, что сессии и услуги сами не вернутся', async () => {
    const w = world({ user: { block: 1 } });
    const tool = userFlags(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, fields: { block: 0 } }, w)) as {
      sideEffects: string[];
    };
    expect(plan.sideEffects.join(' ')).toMatch(/войти заново/);
  });

  /**
   * Снимок для отката читается `getRaw`, а не `get`: из него строится тело
   * восстановления, и поле, замаскированное редакцией по форме значения,
   * вернулось бы в SHM строкой '<redacted>' — то есть откат уничтожил бы
   * данные вместо их восстановления.
   */
  it('снимок читается нередактированным каналом', async () => {
    const w = world({ user: { comment: 'Bearer sk-live-0000000000000000' } });
    const tool = userFlags(w.deps);
    await callTool(tool, { user_id: 3073, fields: { block: 1 } }, w);

    const read = w.calls.find((c) => c.path === '/admin/user' && c.method === 'GET');
    expect(read?.raw).toBe(true);
  });

  it('откат несёт прежние значения ровно изменяемых полей', async () => {
    const w = world({ user: { comment: 'старый комментарий' } });
    const tool = userFlags(w.deps);
    const plan = (await callTool(
      tool,
      { user_id: 3073, fields: { comment: 'новый комментарий' } },
      w,
    )) as { rollback?: { body?: Record<string, unknown> } };

    expect(plan.rollback?.body).toEqual({ user_id: 3073, comment: 'старый комментарий' });
  });

  it('применение шлёт только изменённые поля, а не всю карточку', async () => {
    const w = world({ user: { full_name: 'Иван', phone: '+70000000000' } });
    const tool = userFlags(w.deps);
    await planThenApply(tool, { user_id: 3073, fields: { comment: 'заметка' } }, w);

    const call = w.calls.find((c) => c.method === 'POST');
    expect(call?.body).toEqual({ user_id: 3073, comment: 'заметка' });
  });

  /** §7.4: карточка, уехавшая между планом и применением, сжигает план. */
  it('мир уехал между планом и применением — применение отклонено', async () => {
    let row: Record<string, unknown> = { ...USER };
    const w = makeWorld({
      shmGet: () => [row],
      shmList: (path: string) => (path === '/admin/user/service' ? listOf(SERVICES) : listOf([row])),
      shmAction: () => [{ user_id: 3073 }],
    });
    const tool = userFlags(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, fields: { block: 1 } }, w)) as {
      plan_id: string;
    };

    row = { ...USER, block: 1 };

    await expect(
      callTool(tool, { user_id: 3073, fields: { block: 1 }, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось после построения плана/);
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('несуществующий клиент отбивается до записи', async () => {
    const w = makeWorld({
      shmGet: () => [],
      shmList: () => listOf([]),
      shmAction: () => [{ user_id: 3073 }],
    });
    const tool = userFlags(w.deps);
    await expect(callTool(tool, { user_id: 4242, fields: { block: 1 } }, w)).rejects.toThrow(
      /не найден в SHM/,
    );
  });
});
