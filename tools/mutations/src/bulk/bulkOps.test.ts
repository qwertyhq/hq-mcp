import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callHandler, callTool, makeWorld } from '../testkit.js';
import { bulkOps } from './bulkOps.js';
import type { FakeOpts, FakeWorld } from '../testkit.js';

const SQUAD_A = 'aaaaaaaa-e7d9-4102-b7e7-4a512925b76a';
const SQUAD_B = 'bbbbbbbb-e7d9-4102-b7e7-4a512925b76a';

interface Person {
  id: number;
  status?: string;
  expireAt?: string | null;
  trafficLimitBytes?: number;
  hwidDeviceLimit?: number;
  tag?: string | null;
  used?: number;
  squads?: string[];
}

function panelRow(person: Person): Record<string, unknown> {
  return {
    id: person.id,
    username: `client-${String(person.id)}`,
    status: person.status ?? 'DISABLED',
    expireAt: person.expireAt === undefined ? '2026-09-01T00:00:00.000Z' : person.expireAt,
    trafficLimitBytes: person.trafficLimitBytes ?? 53_687_091_200,
    trafficLimitStrategy: 'MONTH',
    hwidDeviceLimit: person.hwidDeviceLimit ?? 5,
    tag: person.tag ?? null,
    activeInternalSquads: (person.squads ?? [SQUAD_A]).map((uuid) => ({ uuid, name: 'squad' })),
    userTraffic: { usedTrafficBytes: person.used ?? 1_000_000 },
    subscriptionUrl: 'https://sub.example.io/abcdefghijklmnopqrst',
    trojanPassword: 'live-trojan-password',
  };
}

interface Scene {
  w: FakeWorld;
  /** Что уехало в панель мутирующим вызовом. */
  writes: { method: string; path: string; body?: unknown }[];
}

/**
 * Панель с заданным составом. Строки отдаются постранично и, если запрошен
 * фильтр по статусу, сужаются им — ровно как настоящая (проверено на
 * работающей панели, а не по спецификации: фильтр `status` точный, суммы по
 * четырём статусам сходятся с общим total).
 */
function scene(people: Person[], opts: FakeOpts = {}): Scene {
  const writes: Scene['writes'] = [];
  const w = makeWorld(
    {
      remnaGet: (_path, params) => {
        let rows = people;
        const raw = params?.filters;
        if (typeof raw === 'string') {
          const filters = JSON.parse(raw) as { id: string; value: string }[];
          for (const filter of filters) {
            if (filter.id === 'status') {
              rows = rows.filter((person) => (person.status ?? 'DISABLED') === filter.value);
            }
          }
        }
        const start = Number(params?.start ?? 0);
        const size = Number(params?.size ?? 25);
        return { users: rows.slice(start, start + size).map(panelRow), total: rows.length };
      },
      // Массовые маршруты панели отвечают 202/204 с ПУСТЫМ телом; клиент
      // отдаёт на это undefined. Харнесс обязан вести себя так же, иначе
      // инструмент проверялся бы в мире, где панель что-то подтверждает.
      remnaSend: (method, path, body) => {
        writes.push({ method, path, body });
        return undefined;
      },
    },
    opts,
  );
  return { w, writes };
}

interface PlanOut {
  status: string;
  plan_id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: { path: string; from: unknown; to: unknown }[];
  sideEffects: string[];
}

async function planOf(s: Scene, args: Record<string, unknown>): Promise<PlanOut> {
  return (await callTool(bulkOps(s.w.deps), args, s.w)) as unknown as PlanOut;
}

async function apply(s: Scene, args: Record<string, unknown>): Promise<unknown> {
  const plan = await planOf(s, args);
  return callTool(bulkOps(s.w.deps), { ...args, plan_id: plan.plan_id }, s.w);
}

/** Пятеро отключённых — обычная заготовка для операций по набору. */
const FIVE: Person[] = [1, 2, 3, 4, 5].map((n) => ({ id: 1000 + n }));
const FIVE_IDS = FIVE.map((person) => person.id);

const ALL_ACTIONS = [
  { action: 'update', args: { user_ids: FIVE_IDS, hwid_device_limit: 3 } },
  { action: 'reset_traffic', args: { user_ids: FIVE_IDS } },
  { action: 'revoke_subscription', args: { user_ids: FIVE_IDS } },
  { action: 'update_squads', args: { user_ids: FIVE_IDS, squad_uuids: [SQUAD_B] } },
  { action: 'extend_expiration', args: { user_ids: FIVE_IDS, extend_days: 30 } },
  { action: 'delete', args: { user_ids: FIVE_IDS } },
  { action: 'delete_by_status', args: { status: 'DISABLED' } },
  { action: 'all_update', args: { hwid_device_limit: 3 } },
  { action: 'all_reset_traffic', args: {} },
  { action: 'all_extend_expiration', args: { extend_days: 30 } },
] as const;

// ─── Требование 1: точное число затронутых, взятое у панели ─────────────────

describe('bulk_ops: число затронутых берётся у панели', () => {
  it('называет ТОЧНОЕ число и состав набора, а не длину списка оператора', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: FIVE_IDS });
    expect(plan.before.affectedCount).toBe(5);
    expect(plan.before.userIds).toEqual(FIVE_IDS);
  });

  /**
   * Панель молча выбрасывает незнакомые id (`getUsersByUserIds`,
   * `validateUserIds` в users.service.ts 3.2.3). Оператор, назвавший пятерых и
   * задевший троих, не узнал бы об этом ниоткуда — ни из ответа панели
   * (пустое тело), ни из журнала.
   */
  it('отказывается планировать, когда часть названных id панели неизвестна', async () => {
    const s = scene(FIVE);
    await expect(
      planOf(s, { action: 'reset_traffic', user_ids: [1001, 1002, 777_777] }),
    ).rejects.toThrow(/в панели нет клиентов с id 777777.*1 из 3/s);
  });

  it('берёт число для операций по всему флоту из total панели, а не из слова «все»', async () => {
    const s = scene(
      Array.from({ length: 42 }, (_unused, index) => ({ id: 2000 + index })),
      { maxBulkUsers: 100 },
    );
    const plan = await planOf(s, { action: 'all_reset_traffic' });
    expect(plan.before.affectedCount).toBe(42);
    expect(plan.before.fleetTotal).toBe(42);
  });

  it('без total панели плана нет вовсе — подтверждать «всех» вслепую нечем', async () => {
    const s = scene([]);
    const w = makeWorld({ remnaGet: () => ({ users: [] }) });
    await expect(callTool(bulkOps(w.deps), { action: 'all_reset_traffic' }, w)).rejects.toThrow(
      /total/,
    );
    expect(s.writes).toEqual([]);
  });

  /**
   * Каркас, а не вежливость автора: массовая ручка без `affectedUsers` в плане
   * — это план, который нельзя подтвердить осознанно, и он отвергается ещё до
   * записи снимка.
   */
  it('каркас требует число у любого инструмента с массовой ручкой', async () => {
    const w = makeWorld({});
    const { defineMutation, planIdField } = await import('../kit.js');
    const { z } = await import('zod');
    const silent = defineMutation(
      {
        name: 'silent_bulk',
        description: 'массовая ручка, забывшая посчитать',
        input: z.object({ ...planIdField }),
        risk: 'high',
        profiles: ['human'],
        endpoints: ['POST /api/users/bulk/delete'],
        guard: { keys: ['x'], read: async () => ({ x: 1 }) },
        plan: async () => ({ before: { x: 1 }, after: { x: 2 }, diff: [], sideEffects: [] }),
        apply: async () => ({}),
      },
      w.deps,
    );
    await expect(callTool(silent, {}, w)).rejects.toThrow(/affectedUsers/);
  });
});

// ─── Требование 2: потолок, настраиваемый и отказывающий ────────────────────

describe('bulk_ops: потолок числа затронутых', () => {
  it('отвергает операцию по набору выше потолка целиком, а не усекает её', async () => {
    const s = scene(FIVE, { maxBulkUsers: 3 });
    await expect(planOf(s, { action: 'reset_traffic', user_ids: FIVE_IDS })).rejects.toThrow(
      /затронет 5 клиентов.*HQ_MCP_MAX_BULK_USERS=3/s,
    );
    expect(s.writes).toEqual([]);
  });

  /**
   * Дефолт 100 при флоте 1234 означает, что `bulk/all/*` не проходит вовсе,
   * пока границу не подняли руками. Это назначение потолка, а не побочный
   * эффект: чтобы задеть весь флот, оператор обязан назвать число.
   */
  it('при дефолтном потолке fleet-wide операция на большом флоте не проходит', async () => {
    const people = Array.from({ length: 1234 }, (_unused, index) => ({ id: 3000 + index }));
    const s = scene(people);
    await expect(planOf(s, { action: 'all_reset_traffic' })).rejects.toThrow(
      /затронет 1234 клиентов.*HQ_MCP_MAX_BULK_USERS=100/s,
    );

    const raised = scene(people, { maxBulkUsers: 2000 });
    const plan = await planOf(raised, { action: 'all_reset_traffic' });
    expect(plan.before.affectedCount).toBe(1234);
  });

  it('отказ по потолку записан в журнал как rejected, а не потерян', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2 });
    await expect(planOf(s, { action: 'delete', user_ids: FIVE_IDS })).rejects.toThrow();
    const log = readFileSync(s.w.auditPath, 'utf8');
    expect(log).toContain('"outcome":"rejected"');
    expect(log).toContain('bulk_ops');
  });
});

// ─── Требование 3: боту не достаётся ни при каком режиме ────────────────────

describe('bulk_ops: только человек', () => {
  it('в профиле бота инструмента нет в реестре вовсе', async () => {
    const s = scene(FIVE, { profile: 'bot' });
    await expect(planOf(s, { action: 'reset_traffic', user_ids: FIVE_IDS })).rejects.toThrow(
      /bulk_ops/,
    );
  });

  /**
   * Вторая линия: резолв по имени в обход фильтра видимости. `callHandler`
   * зовёт хендлер напрямую — ровно тот путь, которого фильтр не видит.
   */
  it('и при прямом вызове хендлера мимо реестра — отказ по профилю', async () => {
    const s = scene(FIVE, { profile: 'bot' });
    await expect(
      callHandler(bulkOps(s.w.deps), { action: 'all_reset_traffic' }, s.w),
    ).rejects.toThrow(/только человеку/);
    expect(s.writes).toEqual([]);
  });

  /**
   * Третья линия и самая ранняя: инструмент, объявивший массовую ручку и
   * доступный боту, не собирается вовсе — отказ при построении реестра, а не
   * решение автора инструмента.
   */
  it('каркас не даёт собрать массовый инструмент, отданный боту', async () => {
    const w = makeWorld({});
    const { defineMutation, planIdField } = await import('../kit.js');
    const { z } = await import('zod');
    expect(() =>
      defineMutation(
        {
          name: 'bulk_for_bot',
          description: 'массовая ручка, отданная боту',
          input: z.object({ ...planIdField }),
          risk: 'high',
          profiles: ['human', 'bot'],
          endpoints: ['POST /api/users/bulk/all/reset-traffic'],
          guard: { keys: ['x'], read: async () => ({ x: 1 }) },
          plan: async () => ({
            before: {},
            after: {},
            diff: [],
            sideEffects: [],
            affectedUsers: 1,
          }),
          apply: async () => ({}),
        },
        w.deps,
      ),
    ).toThrow(/массовую ручку.*bot/s);
  });
});

// ─── Требование 4: необратимость — первой строкой ───────────────────────────

describe('bulk_ops: необратимость сказана первой строкой', () => {
  for (const { action, args } of ALL_ACTIONS) {
    it(`${action}: первая строка побочных эффектов — про необратимость`, async () => {
      const s = scene(FIVE, { maxBulkUsers: 2000 });
      const plan = await planOf(s, { action, ...args });
      expect(plan.sideEffects[0]).toMatch(/^НЕОБРАТИМО/);
    });
  }

  it('у удаления сказано ещё и про отсутствие резервной копии панели', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'delete', user_ids: FIVE_IDS });
    expect(plan.sideEffects[0]).toMatch(/pg_dump/);
  });

  it('план честно говорит, что панель выполнение не подтверждает', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: FIVE_IDS });
    expect(plan.sideEffects.join('\n')).toMatch(/202\/204 с пустым телом/);
    expect(plan.sideEffects.join('\n')).toMatch(/в очередь/);
  });
});

// ─── Требование 5: delete_by_status — статус это не список людей ────────────

describe('bulk_ops: delete_by_status', () => {
  const MIXED: Person[] = [
    { id: 11, status: 'EXPIRED' },
    { id: 12, status: 'EXPIRED' },
    { id: 13, status: 'DISABLED' },
    { id: 14, status: 'ACTIVE' },
  ];

  it('перечисляет попавших под статус поимённо и называет их число', async () => {
    const s = scene(MIXED);
    const plan = await planOf(s, { action: 'delete_by_status', status: 'EXPIRED' });
    expect(plan.before.affectedCount).toBe(2);
    expect(plan.before.userIds).toEqual([11, 12]);
    expect(plan.before.targetStatuses).toEqual(['11:EXPIRED', '12:EXPIRED']);
  });

  /**
   * ГЛАВНОЕ РЕШЕНИЕ ЭТОГО ИНСТРУМЕНТА. `POST /api/users/bulk/delete-by-status`
   * удаляет тех, кто подпадёт под статус в момент работы очереди, а не тех,
   * кого показали оператору. Применение идёт в `bulk/delete` со списком id,
   * зафиксированным планом.
   */
  it('применяется через bulk/delete со списком id, а запрещённую ручку не зовёт никогда', async () => {
    const s = scene(MIXED);
    await apply(s, { action: 'delete_by_status', status: 'EXPIRED' });
    expect(s.writes).toEqual([
      { method: 'POST', path: '/api/users/bulk/delete', body: { userIds: [11, 12] } },
    ]);
    expect(JSON.stringify(s.writes)).not.toContain('delete-by-status');
  });

  /**
   * Клиент, истёкший между планом и применением, в набор не попадает: набор
   * зафиксирован поимённо. Это ровно то, чего не умеет ручка панели.
   */
  it('клиенты, истёкшие после планирования, не удаляются — набор зафиксирован', async () => {
    const people = [...MIXED];
    const s = scene(people);
    const plan = await planOf(s, { action: 'delete_by_status', status: 'EXPIRED' });
    // Между планом и применением ещё двое истекли.
    people.push({ id: 15, status: 'EXPIRED' }, { id: 16, status: 'EXPIRED' });
    await callTool(bulkOps(s.w.deps), {
      action: 'delete_by_status',
      status: 'EXPIRED',
      plan_id: plan.plan_id,
    }, s.w);
    expect(s.writes[0]?.body).toEqual({ userIds: [11, 12] });
  });

  /**
   * «Оператор может не понимать, скольких покрывает статус» — это и есть та
   * ошибка, которую ловит потолок. Отказ называет НАСТОЯЩЕЕ число панели, а не
   * длину прочитанного куска: обход прерван намеренно.
   */
  it('отказывает по настоящему числу панели, когда статус покрывает больше потолка', async () => {
    const many = Array.from({ length: 376 }, (_unused, index) => ({
      id: 5000 + index,
      status: 'DISABLED',
    }));
    const s = scene(many, { maxBulkUsers: 100 });
    await expect(planOf(s, { action: 'delete_by_status', status: 'DISABLED' })).rejects.toThrow(
      /подпадает 376 клиент.*HQ_MCP_MAX_BULK_USERS=100.*Статус — это не список людей/s,
    );
  });

  it('отказывает, когда под статус не подпадает никто', async () => {
    const s = scene(MIXED);
    await expect(planOf(s, { action: 'delete_by_status', status: 'LIMITED' })).rejects.toThrow(
      /никого нет/,
    );
  });

  it('не принимает user_ids: набор берётся из статуса, иначе непонятно, что главнее', async () => {
    const s = scene(MIXED);
    await expect(
      planOf(s, { action: 'delete_by_status', status: 'EXPIRED', user_ids: [11] }),
    ).rejects.toThrow(/user_ids здесь лишний/);
  });
});

// ─── Удаление: ACTIVE — это живой платящий клиент ───────────────────────────

describe('bulk_ops: удаление живого клиента', () => {
  it('отказывается удалять ACTIVE и называет обратимый первый шаг', async () => {
    const s = scene([
      { id: 21, status: 'DISABLED' },
      { id: 22, status: 'ACTIVE' },
    ]);
    await expect(planOf(s, { action: 'delete', user_ids: [21, 22] })).rejects.toThrow(
      /1 клиент\(ов\) со статусом ACTIVE.*id 22.*set_status=DISABLED/s,
    );
    expect(s.writes).toEqual([]);
  });

  it('говорит, что услуги в SHM останутся и провижининг по ним упадёт', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'delete', user_ids: FIVE_IDS });
    expect(plan.sideEffects.join('\n')).toMatch(/sync_audit/);
  });
});

// ─── Формы тела: три разных контракта, а не один ────────────────────────────

describe('bulk_ops: что уходит в панель', () => {
  it('update кладёт поля во вложенный fields, как требует BulkUpdateUsersCommand', async () => {
    const s = scene(FIVE);
    await apply(s, {
      action: 'update',
      user_ids: FIVE_IDS,
      set_status: 'DISABLED',
      hwid_device_limit: 2,
    });
    expect(s.writes).toEqual([
      {
        method: 'POST',
        path: '/api/users/bulk/update',
        body: { userIds: FIVE_IDS, fields: { status: 'DISABLED', hwidDeviceLimit: 2 } },
      },
    ]);
  });

  /**
   * У fleet-wide обновления схема ПЛОСКАЯ (BulkAllUpdateUsersCommand), в
   * отличие от набора со вложенным `fields`. Перепутать их — получить принятый
   * запрос и ноль изменений.
   */
  it('all_update кладёт поля в корень тела, а не в fields', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    await apply(s, { action: 'all_update', hwid_device_limit: 2 });
    expect(s.writes).toEqual([
      { method: 'POST', path: '/api/users/bulk/all/update', body: { hwidDeviceLimit: 2 } },
    ]);
  });

  /**
   * diff без левой стороны читается как «поле было пустым», а оно было тысячей
   * разных значений, которых после применения не останется нигде.
   */
  it('fleet-wide diff честно говорит, что «было» в снимок не помещается', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    const plan = await planOf(s, { action: 'all_update', hwid_device_limit: 2 });
    expect(plan.before.hwidDeviceLimit).toMatch(/нынешние значения всех 5 клиентов/);
    expect(plan.diff).toContainEqual(
      expect.objectContaining({ path: 'hwidDeviceLimit', to: 2 }),
    );
  });

  it('all_reset_traffic уходит без тела — схемы тела у ручки нет вовсе', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    await apply(s, { action: 'all_reset_traffic' });
    expect(s.writes).toEqual([
      { method: 'POST', path: '/api/users/bulk/all/reset-traffic', body: undefined },
    ]);
  });

  it('update_squads зовёт поле activeInternalSquads голыми uuid', async () => {
    const s = scene(FIVE);
    await apply(s, { action: 'update_squads', user_ids: FIVE_IDS, squad_uuids: [SQUAD_B] });
    expect(s.writes[0]?.body).toEqual({ userIds: FIVE_IDS, activeInternalSquads: [SQUAD_B] });
  });

  it('extend_expiration шлёт extendDays, а дату не считает', async () => {
    const s = scene(FIVE);
    await apply(s, { action: 'extend_expiration', user_ids: FIVE_IDS, extend_days: 30 });
    expect(s.writes[0]?.body).toEqual({ userIds: FIVE_IDS, extendDays: 30 });
  });

  it('исход называется «принято», а не «выполнено»', async () => {
    const s = scene(FIVE);
    const out = (await apply(s, { action: 'reset_traffic', user_ids: FIVE_IDS })) as {
      result: { accepted: boolean; confirmed: boolean; note_panel: string };
    };
    expect(out.result.accepted).toBe(true);
    expect(out.result.confirmed).toBe(false);
    expect(out.result.note_panel).toMatch(/НЕ повторным применением/);
  });
});

// ─── Границы полей ──────────────────────────────────────────────────────────

describe('bulk_ops: что менять не разрешено', () => {
  /**
   * Оба поля — один класс: одно значение на весь флот стирает распределение,
   * которое после записи не восстановить ниоткуда. Правило действует на них
   * одинаково; исключение для одного из двух было бы дырой в собственном
   * обосновании.
   */
  it('expire_at и set_status по всему флоту запрещены: прежние значения вернуть неоткуда', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    await expect(
      planOf(s, { action: 'all_update', expire_at: '2027-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/fleet-wide обновлении запрещён/);
    await expect(planOf(s, { action: 'all_update', set_status: 'DISABLED' })).rejects.toThrow(
      /set_status во fleet-wide обновлении запрещён.*node_manage/s,
    );
    await expect(planOf(s, { action: 'all_update', set_status: 'ACTIVE' })).rejects.toThrow(
      /set_status во fleet-wide обновлении запрещён/,
    );
    expect(s.writes).toEqual([]);
  });

  it('по набору set_status разрешён — там видно, кого именно', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, {
      action: 'update',
      user_ids: FIVE_IDS,
      set_status: 'ACTIVE',
    });
    expect(plan.before.status).toBe('DISABLED');
    expect(plan.after.status).toBe('ACTIVE');
  });

  it('по набору expire_at разрешён, и прежние даты видны в снимке «до»', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, {
      action: 'update',
      user_ids: FIVE_IDS,
      expire_at: '2027-01-01T00:00:00.000Z',
    });
    expect(plan.before.expireAt).toBe('2026-09-01T00:00:00.000Z');
    expect(plan.after.expireAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('дату в прошлом отбивает на плане — панель отвергла бы её на валидации', async () => {
    const s = scene(FIVE);
    await expect(
      planOf(s, { action: 'update', user_ids: FIVE_IDS, expire_at: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/в прошлом/);
  });

  /**
   * `telegramId`, `email`, `description` и `externalSquadUuid` ручка панели
   * принимает. Одно значение на весь набор склеило бы N личностей в одну —
   * схема входа таких имён не знает вовсе, и zod их вырезает.
   */
  it('личность и внешний сквад через массовое обновление не правятся', async () => {
    const s = scene(FIVE);
    await apply(s, {
      action: 'update',
      user_ids: FIVE_IDS,
      hwid_device_limit: 2,
      telegram_id: 12_345,
      email: 'one@example.com',
      description: 'массовая заметка',
      external_squad_uuid: SQUAD_B,
    });
    const body = JSON.stringify(s.writes[0]?.body);
    for (const banned of ['telegram', 'email', 'description', 'externalSquad', '12345']) {
      expect(body).not.toContain(banned);
    }
  });

  it('EXPIRED и LIMITED выставить нельзя — панель их ставит сама', async () => {
    const s = scene(FIVE);
    await expect(
      planOf(s, { action: 'update', user_ids: FIVE_IDS, set_status: 'EXPIRED' }),
    ).rejects.toThrow();
  });

  /**
   * Каркас на пустой diff отвечает «объявите allowEmptyDiff» — верно и
   * бесполезно: следующий шаг оператора зависит от того, ПОЧЕМУ пусто.
   */
  it('называет причину пустоты, а не устройство каркаса', async () => {
    const zeroed = scene([
      { id: 91, status: 'DISABLED', used: 0 },
      { id: 92, status: 'DISABLED', used: 0 },
    ]);
    await expect(planOf(zeroed, { action: 'reset_traffic', user_ids: [91, 92] })).rejects.toThrow(
      /счётчики трафика у всего набора уже нулевые/,
    );

    const same = scene([{ id: 93, hwidDeviceLimit: 5 }]);
    await expect(
      planOf(same, { action: 'update', user_ids: [93], hwid_device_limit: 5 }),
    ).rejects.toThrow(/уже равны тому, что вы ставите/);

    const squadded = scene([{ id: 94, squads: [SQUAD_A] }]);
    await expect(
      planOf(squadded, { action: 'update_squads', user_ids: [94], squad_uuids: [SQUAD_A] }),
    ).rejects.toThrow(/уже ровно этот набор сквадов/);

    for (const s of [zeroed, same, squadded]) expect(s.writes).toEqual([]);
  });

  it('нулевые счётчики при LIMITED в наборе — план всё же есть: статус изменится', async () => {
    const s = scene([{ id: 95, status: 'LIMITED', used: 0 }]);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: [95] });
    expect(plan.sideEffects.join('\n')).toMatch(/LIMITED станут ACTIVE/);
  });

  it('обновление без единого поля отбивается до похода в панель', async () => {
    const s = scene(FIVE);
    await expect(planOf(s, { action: 'update', user_ids: FIVE_IDS })).rejects.toThrow(
      /требует хотя бы одно поле/,
    );
  });

  it('all_* со списком id отвергается: ручка списка не читает и соврала бы про радиус', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    await expect(planOf(s, { action: 'all_reset_traffic', user_ids: FIVE_IDS })).rejects.toThrow(
      /списка не принимает/,
    );
  });

  it('пустой набор сквадов назван потерей доступа ко всем серверам', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'update_squads', user_ids: FIVE_IDS, squad_uuids: [] });
    expect(plan.sideEffects.join('\n')).toMatch(/без доступа ко всем серверам/);
  });
});

// ─── Предсказание, которое не врёт ──────────────────────────────────────────

describe('bulk_ops: массовое продление считается не так, как точечное', () => {
  /**
   * `bulkExtendExpirationDateByUserIds` — это SQL `expire_at + interval`, без
   * `max(сейчас, expireAt)`. Давно истёкшему клиенту такое продление доступа не
   * вернёт, и план обязан сказать это до применения, а не после.
   */
  it('называет формулу панели и считает тех, кому продление не поможет', async () => {
    const s = scene([
      { id: 31, status: 'EXPIRED', expireAt: '2025-01-01T00:00:00.000Z' },
      { id: 32, status: 'ACTIVE', expireAt: '2026-09-01T00:00:00.000Z' },
    ]);
    const plan = await planOf(s, {
      action: 'extend_expiration',
      user_ids: [31, 32],
      extend_days: 30,
    });
    const text = plan.sideEffects.join('\n');
    expect(text).toMatch(/expire_at \+ interval/);
    expect(text).toMatch(/У 1 клиент\(ов\) новая дата всё равно останется в прошлом/);
  });

  it('когда всем хватает — говорит именно это, а не молчит', async () => {
    const s = scene([{ id: 33, status: 'ACTIVE', expireAt: '2026-09-01T00:00:00.000Z' }]);
    const plan = await planOf(s, { action: 'extend_expiration', user_ids: [33], extend_days: 30 });
    expect(plan.sideEffects.join('\n')).toMatch(/Всем из набора новая дата придётся в будущее/);
  });

  it('reset_traffic называет сумму, которая исчезнет, и судьбу LIMITED', async () => {
    const s = scene([
      { id: 41, status: 'LIMITED', used: 2_000 },
      { id: 42, status: 'DISABLED', used: 3_000 },
    ]);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: [41, 42] });
    expect(plan.before.usedTrafficBytes).toBe(5_000);
    expect(plan.after.usedTrafficBytes).toBe(0);
    expect(plan.sideEffects.join('\n')).toMatch(/1 клиент\(ов\) со статусом LIMITED станут ACTIVE/);
  });

  it('сводит разные значения набора в одну строку, а не вываливает сотню чисел', async () => {
    const s = scene([
      { id: 51, hwidDeviceLimit: 1 },
      { id: 52, hwidDeviceLimit: 2 },
      { id: 53, hwidDeviceLimit: 3 },
      { id: 54, hwidDeviceLimit: 4 },
    ]);
    const plan = await planOf(s, {
      action: 'update',
      user_ids: [51, 52, 53, 54],
      hwid_device_limit: 9,
    });
    expect(String(plan.before.hwidDeviceLimit)).toMatch(/^4 разных значений: 1, 2, 3, …$/);
    expect(plan.after.hwidDeviceLimit).toBe(9);
  });
});

// ─── Сверка мира и снимок с диска ───────────────────────────────────────────

describe('bulk_ops: план приезжает с диска и ему не верят на слово', () => {
  function tamper(s: Scene, planId: string, edit: (after: Record<string, unknown>) => void): void {
    const file = join(s.w.snapshotDir, `${planId}.json`);
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as {
      after: Record<string, unknown>;
    };
    edit(snapshot.after);
    writeFileSync(file, JSON.stringify(snapshot));
  }

  it('дописанное в снимок запрещённое поле отбивается strictObject до сети', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'update', user_ids: FIVE_IDS, hwid_device_limit: 2 });
    tamper(s, plan.plan_id, (after) => {
      (after.op as { fields: Record<string, unknown> }).fields.telegramId = 999;
    });
    await expect(
      callTool(
        bulkOps(s.w.deps),
        { action: 'update', user_ids: FIVE_IDS, hwid_device_limit: 2, plan_id: plan.plan_id },
        s.w,
      ),
    ).rejects.toThrow(/не несёт разрешённой операции/);
    expect(s.writes).toEqual([]);
  });

  it('подменённое в снимке действие отбивается закрытым enum', async () => {
    const s = scene(FIVE);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: FIVE_IDS });
    tamper(s, plan.plan_id, (after) => {
      (after.op as Record<string, unknown>).action = 'delete';
    });
    // Действие подменено на разрешённое имя — enum пропустит, но сверка мира
    // увидит другой снимок: у удаления в `before` есть `targetStatuses`,
    // которого в плане сброса трафика не было.
    await expect(
      callTool(
        bulkOps(s.w.deps),
        { action: 'reset_traffic', user_ids: FIVE_IDS, plan_id: plan.plan_id },
        s.w,
      ),
    ).rejects.toThrow(/состояние изменилось|targetStatuses/);
    expect(s.writes).toEqual([]);
  });

  it('дописанные в снимок чужие id ловятся сверкой состава набора', async () => {
    const s = scene([...FIVE, { id: 9999 }]);
    const plan = await planOf(s, { action: 'delete', user_ids: FIVE_IDS });
    tamper(s, plan.plan_id, (after) => {
      (after.op as { user_ids: number[] }).user_ids = [...FIVE_IDS, 9999];
    });
    await expect(
      callTool(
        bulkOps(s.w.deps),
        { action: 'delete', user_ids: FIVE_IDS, plan_id: plan.plan_id },
        s.w,
      ),
    ).rejects.toThrow(/состояние изменилось/);
    expect(s.writes).toEqual([]);
  });

  /**
   * Между планом и применением клиент заплатил и вернулся. Удаление
   * необратимо, поэтому решение, принятое по устаревшей картине, обязано быть
   * принято заново.
   */
  it('отказывает, когда клиент из набора на удаление стал ACTIVE', async () => {
    const people: Person[] = [{ id: 61, status: 'DISABLED' }, { id: 62, status: 'DISABLED' }];
    const s = scene(people);
    const plan = await planOf(s, { action: 'delete', user_ids: [61, 62] });
    const revived = people[1];
    if (revived !== undefined) revived.status = 'ACTIVE';
    await expect(
      callTool(bulkOps(s.w.deps), { action: 'delete', user_ids: [61, 62], plan_id: plan.plan_id }, s.w),
    ).rejects.toThrow(/targetStatuses/);
    expect(s.writes).toEqual([]);
  });

  it('отказывает, когда клиент из набора исчез — подтверждали другое число', async () => {
    const people: Person[] = [{ id: 71 }, { id: 72 }];
    const s = scene(people);
    const plan = await planOf(s, { action: 'reset_traffic', user_ids: [71, 72] });
    people.pop();
    await expect(
      callTool(
        bulkOps(s.w.deps),
        { action: 'reset_traffic', user_ids: [71, 72], plan_id: plan.plan_id },
        s.w,
      ),
    ).rejects.toThrow(/affectedCount|userIds/);
  });

  /**
   * Флот вырос между планом и применением — значит `all_*` заденет не тех, кого
   * считали. У операций по набору такой сверки нет намеренно: флот растёт от
   * каждой регистрации, и она отвергала бы планы по причине, к набору отношения
   * не имеющей.
   */
  it('fleet-wide отказывает, когда флот изменился, а операция по набору — нет', async () => {
    const fleet: Person[] = [{ id: 81 }, { id: 82 }];
    const s = scene(fleet, { maxBulkUsers: 2000 });
    const wide = await planOf(s, { action: 'all_reset_traffic' });
    const narrow = await planOf(s, { action: 'reset_traffic', user_ids: [81] });
    fleet.push({ id: 83 });

    await expect(
      callTool(bulkOps(s.w.deps), { action: 'all_reset_traffic', plan_id: wide.plan_id }, s.w),
    ).rejects.toThrow(/fleetTotal|affectedCount/);

    await expect(
      callTool(
        bulkOps(s.w.deps),
        { action: 'reset_traffic', user_ids: [81], plan_id: narrow.plan_id },
        s.w,
      ),
    ).resolves.toMatchObject({ status: 'applied' });
  });
});

// ─── Гигиена: ключи подписки и запрещённые пути ─────────────────────────────

describe('bulk_ops: гигиена ответа', () => {
  it('ни один план не уносит ключи подписки в снимок', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    for (const { action, args } of ALL_ACTIONS) {
      const plan = await planOf(s, { action, ...args });
      const flat = JSON.stringify(plan);
      expect(flat, action).not.toContain('live-trojan-password');
      expect(flat, action).not.toContain('sub.example.io');
    }
  });

  it('запрещённая ручка удаления по статусу не зовётся ни одной веткой', async () => {
    const s = scene(FIVE, { maxBulkUsers: 2000 });
    for (const { action, args } of ALL_ACTIONS) {
      await apply(s, { action, ...args });
    }
    expect(JSON.stringify(s.writes)).not.toContain('delete-by-status');
    expect(s.writes.every((write) => write.path.startsWith('/api/users/bulk/'))).toBe(true);
  });
});
