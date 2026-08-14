import { describe, expect, it } from 'vitest';
import { serviceLifecycle } from './lifecycle.js';
import { callTool, listOf, makeWorld, planThenApply } from '../testkit.js';
import type { ClientParams } from '@hq/types';
import type { FakeWorld } from '../testkit.js';

interface ServiceRow {
  user_service_id: number;
  user_id: number;
  service_id: number;
  status: string;
  name: string;
  expire: string | null;
  next: number | null;
  /**
   * Цена тарифа, подмешанная `UserService::list_for_api` в строку услуги.
   * Необязательна намеренно: на части сборок SHM её в строке нет, и план обязан
   * уметь дочитать её каталогом, а не молча остаться без суммы.
   */
  cost?: number | null;
}

const ACTIVE: ServiceRow = {
  user_service_id: 55,
  user_id: 3073,
  service_id: 21,
  status: 'ACTIVE',
  name: 'Месяц',
  expire: '2026-09-01 00:00:00',
  next: null,
  cost: 300,
};

/**
 * Мир, у которого строку услуги можно подменить между планом и применением —
 * без этого сверку мира (§7.4) проверить нечем.
 */
function world(
  opts: {
    rows?: ServiceRow[];
    items?: number;
    actionResult?: unknown;
    /** Что бэкенд делает со строкой услуги, приняв запись. */
    onAction?: (setRows: (rows: ServiceRow[]) => void) => void;
    /**
     * Цена по каталогу: число — одна на все тарифы, карта — по service_id,
     * `null` — тариф в каталоге есть, а цены в строке нет.
     */
    catalog?: number | null | Record<number, number | null>;
    /** Каталог отвечает отказом — самый частый вид «цену прочитать не удалось». */
    catalogFails?: boolean;
    maxOpAmount?: number;
  } = {},
): {
  w: FakeWorld;
  setRows: (rows: ServiceRow[]) => void;
} {
  let rows = opts.rows ?? [ACTIVE];
  const setRows = (next: ServiceRow[]): void => {
    rows = next;
  };
  const catalogCost = (serviceId: number): number | null => {
    const table = opts.catalog;
    if (table === undefined) return 300;
    if (table === null || typeof table === 'number') return table;
    return table[serviceId] ?? null;
  };
  const w = makeWorld({
    shmList: (path: string, params?: ClientParams) => {
      if (path === '/admin/user/service/spool') return listOf([{ id: 1, event: 'PROLONGATE' }]);
      if (path === '/admin/service') {
        if (opts.catalogFails === true) {
          throw new Error('SHM: /admin/service ответил 500');
        }
        const cost = catalogCost(Number(params?.service_id));
        return listOf([{ service_id: params?.service_id, ...(cost === null ? {} : { cost }) }]);
      }
      // Серверный фильтр отдаёт одну строку по её id — вместе с владельцем.
      const raw = params?.filter;
      if (typeof raw === 'string') {
        const wanted = (JSON.parse(raw) as { user_service_id?: number }).user_service_id;
        const hit = rows.filter((row) => row.user_service_id === wanted);
        return listOf(hit, hit.length);
      }
      const mine = rows.filter((row) => row.user_id === Number(params?.user_id));
      return listOf(mine, opts.items ?? mine.length);
    },
    shmAction: () => {
      opts.onAction?.(setRows);
      return opts.actionResult ?? [{ user_service_id: 55 }];
    },
  }, opts.maxOpAmount === undefined ? {} : { maxOpAmount: opts.maxOpAmount });
  return { w, setRows };
}

describe('service_lifecycle', () => {
  it('боту инструмент не отдаётся: profiles ровно ["human"] (К21)', () => {
    const { w } = world();
    expect(serviceLifecycle(w.deps).def.profiles).toEqual(['human']);
  });

  it('change_plan без finish_active отбивается: дефолта нет', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'change_plan', user_service_id: 55, service_id: 42 }, w),
    ).rejects.toThrow(/finish_active обязателен/);
  });

  it('change_plan передаёт finish_active явно и в план, и в запрос', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await planThenApply(
      tool,
      { user_id: 3073, action: 'change_plan', user_service_id: 55, service_id: 42, finish_active: 0 },
      w,
    );

    const call = w.calls.find((c) => c.path === '/admin/user/service/change');
    expect(call?.body).toEqual({
      user_id: 3073,
      user_service_id: 55,
      service_id: 42,
      finish_active: 0,
    });
  });

  it('finish_active вне change_plan отбивается, а не уезжает в тело без эффекта', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'touch', user_service_id: 55, finish_active: 1 }, w),
    ).rejects.toThrow(/finish_active не имеет смысла/);
  });

  /**
   * На админском маршруте api_safe_args не применяется (admin=1 ставит
   * диспетчер), поэтому «лишние поля отрежет бэкенд» здесь неверно: отрежем их
   * мы, или они будут записаны.
   */
  it('schedule_change шлёт ровно три поля и ни одного сверх', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await planThenApply(
      tool,
      { user_id: 3073, action: 'schedule_change', user_service_id: 55, service_id: 42 },
      w,
    );

    const call = w.calls.find((c) => c.path === '/admin/user/service' && c.method === 'POST');
    expect(call?.body).toEqual({ user_id: 3073, user_service_id: 55, next: 42 });
  });

  it('schedule_change с service_id=-1 отбивается объяснением, а не ошибкой схемы', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    // вход валиден для zod намеренно: иначе пользователь увидит «Too small»
    // вместо объяснения, что он заказал отложенное удаление услуги
    expect(
      tool.def.input.safeParse({
        user_id: 3073,
        action: 'schedule_change',
        user_service_id: 55,
        service_id: -1,
      }).success,
    ).toBe(true);
    await expect(
      callTool(
        tool,
        { user_id: 3073, action: 'schedule_change', user_service_id: 55, service_id: -1 },
        w,
      ),
    ).rejects.toThrow(/next=-1/);
  });

  it('чужая услуга не трогается: бэкенд эту пару не сверяет, сверяем мы', async () => {
    const { w } = world({
      rows: [ACTIVE, { ...ACTIVE, user_service_id: 999, user_id: 9999, status: 'ACTIVE' }],
    });
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 999 }, w),
    ).rejects.toThrow(/принадлежит клиенту user_id=9999/);
    expect(w.calls.some((c) => c.method !== 'LIST')).toBe(false);
  });

  /**
   * Фильтр по самому `user_service_id` СРАБОТАЛ и вернул ноль строк — значит
   * такой услуги в SHM нет, и это утверждение сильнее, чем «подтвердить не
   * удалось»: ключ таблицы стоит в условии, поэтому `status != REMOVED`
   * USObject не дописывает (USObject.pm:110-121) и снятая услуга вернулась бы.
   * Случай «страница не покрыла список» (§6.4) — другой, и он живёт в тестах
   * самой проверки владения (`billing/ownership.test.ts`).
   */
  it('услуги нет в SHM — так и сказано, и это по-прежнему не «чужая»', async () => {
    const { w } = world({ items: 900 });
    const tool = serviceLifecycle(w.deps);
    const promise = callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 999 }, w);
    await expect(promise).rejects.toThrow(/нет в SHM/);
    await expect(promise).rejects.not.toThrow(/принадлежит клиенту user_id=/);
  });

  /**
   * Главная ловушка этих маршрутов: block_force вне статуса ACTIVE отвечает 200
   * и той же строкой, ничего не сделав. dataTruthyGuard такой ответ пропускает —
   * он truthy. Ловит только предусловие.
   */
  it('stop из не-ACTIVE отбивается предусловием, а не «успехом»', async () => {
    const { w } = world({ rows: [{ ...ACTIVE, status: 'BLOCK' }] });
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55 }, w),
    ).rejects.toThrow(/только услугу в статусе ACTIVE/);
  });

  it('activate из не-BLOCK отбивается предусловием', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'activate', user_service_id: 55 }, w),
    ).rejects.toThrow(/только услугу в статусе BLOCK/);
  });

  it('change_plan из PROGRESS отбивается: USObject::change оттуда возвращает undef', async () => {
    const { w } = world({ rows: [{ ...ACTIVE, status: 'PROGRESS' }] });
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(
        tool,
        { user_id: 3073, action: 'change_plan', user_service_id: 55, service_id: 42, finish_active: 1 },
        w,
      ),
    ).rejects.toThrow(/смена тарифа работает из статусов/);
  });

  it('change_plan на тот же тариф отбивается: это обрыв периода ради ничего', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(
        tool,
        { user_id: 3073, action: 'change_plan', user_service_id: 55, service_id: 21, finish_active: 1 },
        w,
      ),
    ).rejects.toThrow(/уже на тарифе/);
  });

  it('ложный успех (200 + data:[null]) на stop не считается остановкой', async () => {
    const { w } = world({ actionResult: [null] });
    const tool = serviceLifecycle(w.deps);
    await expect(
      planThenApply(tool, { user_id: 3073, action: 'stop', user_service_id: 55 }, w),
    ).rejects.toThrow();
  });

  /**
   * Регрессия: маршрут спула объявлен `required => ['user_id','user_service_id']`
   * (v1.cgi:877-884), и диспетчер отвечает 400 ещё до контроллера. Запрос с
   * одним user_id всегда падал бы, а спул в ответе был бы вечно пуст.
   */
  it('после применения читает спул ОБОИМИ id и отдаёт его в результате', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    const res = (await planThenApply(
      tool,
      { user_id: 3073, action: 'touch', user_service_id: 55 },
      w,
    )) as { result: { spool: unknown[] } };

    expect(Array.isArray(res.result.spool)).toBe(true);
    const spool = w.calls.find((c) => c.path === '/admin/user/service/spool');
    expect(spool?.params).toMatchObject({ user_id: 3073, user_service_id: 55 });
  });

  it('give не требует user_service_id и заказывает услугу', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await planThenApply(tool, { user_id: 3073, action: 'give', service_id: 21 }, w);
    const call = w.calls.find((c) => c.path === '/admin/service/order');
    expect(call?.method).toBe('PUT');
    expect(call?.body).toEqual({ user_id: 3073, service_id: 21 });
  });

  it('give с user_service_id отбивается: услуги ещё нет', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'give', service_id: 21, user_service_id: 55 }, w),
    ).rejects.toThrow(/у give нет user_service_id/);
  });

  /**
   * Лимит «5 заказов за 10 минут» живёт в create_for_api_safe — это КЛИЕНТСКИЙ
   * маршрут. Админский зовёт create_for_api, и счётчик там не инкрементирует
   * никто. План обязан говорить правду, иначе оператор рассчитывает на
   * предохранитель, которого нет.
   */
  it('give не обещает несуществующего лимита на заказ', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'give', service_id: 21 }, w)) as {
      sideEffects: string[];
    };
    const text = plan.sideEffects.join(' ');
    expect(text).toMatch(/Отдельного лимита на заказ здесь НЕТ/);
    expect(text).toMatch(/create_for_api_safe/);
  });

  it('план называет стоимость целевого тарифа: её видит человек, подтверждающий план', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'give', service_id: 21 }, w)) as {
      sideEffects: string[];
    };
    expect(plan.sideEffects.join(' ')).toMatch(/спишется 300/);
  });

  it('delete попадает в план с пометкой необратимости и без отката', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'delete', user_service_id: 55 }, w)) as {
      sideEffects: string[];
      rollback?: unknown;
    };
    expect(plan.sideEffects.join(' ')).toMatch(/необратим/i);
    expect(plan.rollback).toBeUndefined();
  });

  it('schedule_change несёт откат на прежний next', async () => {
    const { w } = world({ rows: [{ ...ACTIVE, next: 7 }] });
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(
      tool,
      { user_id: 3073, action: 'schedule_change', user_service_id: 55, service_id: 42 },
      w,
    )) as { rollback?: { body?: Record<string, unknown> } };
    expect(plan.rollback?.body).toEqual({ user_id: 3073, user_service_id: 55, next: 7 });
  });

  /** §7.4: статус, уехавший между планом и применением, сжигает план. */
  it('мир уехал между планом и применением — применение отклонено', async () => {
    const { w, setRows } = world();
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55 }, w)) as {
      plan_id: string;
    };

    setRows([{ ...ACTIVE, status: 'BLOCK' }]);

    await expect(
      callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось после построения плана/);
    expect(w.calls.some((c) => c.path === '/admin/user/service/stop')).toBe(false);
  });

  /**
   * Заказ — единственное действие без «объекта до». Водяной знак ловит второй
   * заказ, приехавший между планом и применением; для остальных действий он
   * обязан молчать, иначе чужой заказ ломает не связанный с ним stop.
   */
  it('give: чужой заказ между планом и применением сжигает план', async () => {
    const { w, setRows } = world({ rows: [] });
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'give', service_id: 21 }, w)) as {
      plan_id: string;
    };

    setRows([ACTIVE]);

    await expect(
      callTool(tool, { user_id: 3073, action: 'give', service_id: 21, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/last_user_service_id/);
  });

  it('stop не ломается от чужого заказа: водяной знак действует только для give', async () => {
    const { w, setRows } = world();
    const tool = serviceLifecycle(w.deps);
    const plan = (await callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55 }, w)) as {
      plan_id: string;
    };

    setRows([ACTIVE, { ...ACTIVE, user_service_id: 9001, status: 'NOT PAID' }]);

    await expect(
      callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55, plan_id: plan.plan_id }, w),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  /**
   * Часть переходов доезжает до строки услуги через спул, поэтому расхождение —
   * предупреждение, а не ошибка: объявить прошедшую операцию неудачной значит
   * спровоцировать повтор, а повтор здесь списывает деньги второй раз.
   */
  it('расхождение ожидаемого и наблюдаемого состояния попадает в ответ как drift', async () => {
    const { w } = world();
    const tool = serviceLifecycle(w.deps);
    const res = (await planThenApply(
      tool,
      { user_id: 3073, action: 'stop', user_service_id: 55 },
      w,
    )) as { result: { drift?: { field: string; expected: unknown; observed: unknown } } };

    expect(res.result.drift).toMatchObject({ field: 'status', expected: 'BLOCK', observed: 'ACTIVE' });
  });

  it('совпадение ожидаемого и наблюдаемого drift не рождает', async () => {
    // бэкенд, который честно перевёл услугу в BLOCK, приняв запись
    const { w } = world({
      onAction: (setRows) => {
        setRows([{ ...ACTIVE, status: 'BLOCK' }]);
      },
    });
    const tool = serviceLifecycle(w.deps);
    const res = (await planThenApply(
      tool,
      { user_id: 3073, action: 'stop', user_service_id: 55 },
      w,
    )) as { result: { drift?: unknown; state: { status: string } } };

    expect(res.result.drift).toBeUndefined();
    expect(res.result.state.status).toBe('BLOCK');
  });

  it('журнал мутаций хранит и отказ предусловия', async () => {
    const { w } = world({ rows: [{ ...ACTIVE, status: 'BLOCK' }] });
    const tool = serviceLifecycle(w.deps);
    await expect(
      callTool(tool, { user_id: 3073, action: 'stop', user_service_id: 55 }, w),
    ).rejects.toThrow();

    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({
      tool: 'service_lifecycle',
      outcome: 'rejected',
      target: { system: 'shm', id: 3073 },
    });
  });
});

/**
 * ПОТОЛОК MAX_OP_AMOUNT НА ДЕЙСТВИЯХ, ТРАТЯЩИХ БАЛАНС КЛИЕНТА.
 *
 * Раньше он их не касался вовсе: каркас применял его к трём денежным ручкам
 * реестра, а `service_lifecycle` вызывает не их — и сам инструмент печатал это
 * в побочные эффекты как известный факт. Списание при этом происходило ровно
 * такое же, только считал его биллинг по каталогу, а не называл вызывающий.
 *
 * Проверяется по ДЕЙСТВИЮ, а не по инструменту, и тесты ниже держат обе
 * половины утверждения: у четырёх действий сумма обязательна и проверяется, у
 * трёх её нет и требовать её нельзя.
 */
describe('service_lifecycle × потолок MAX_OP_AMOUNT', () => {
  const SPENDING: Array<{ action: string; args: Record<string, unknown>; rows?: ServiceRow[] }> = [
    { action: 'give', args: { user_id: 3073, action: 'give', service_id: 29 } },
    { action: 'touch', args: { user_id: 3073, action: 'touch', user_service_id: 55 } },
    {
      action: 'change_plan',
      args: {
        user_id: 3073,
        action: 'change_plan',
        user_service_id: 55,
        service_id: 29,
        finish_active: 1,
      },
    },
    {
      action: 'activate',
      args: { user_id: 3073, action: 'activate', user_service_id: 55 },
      rows: [{ ...ACTIVE, status: 'BLOCK' }],
    },
  ];

  const QUIET: Array<{ action: string; args: Record<string, unknown> }> = [
    { action: 'stop', args: { user_id: 3073, action: 'stop', user_service_id: 55 } },
    {
      action: 'schedule_change',
      args: { user_id: 3073, action: 'schedule_change', user_service_id: 55, service_id: 29 },
    },
    { action: 'delete', args: { user_id: 3073, action: 'delete', user_service_id: 55 } },
  ];

  describe.each(SPENDING)('$action списывает с баланса', ({ args, rows }) => {
    it('в пределах потолка план выдаётся', async () => {
      const { w } = world({
        maxOpAmount: 5000,
        catalog: 2300,
        ...(rows === undefined ? {} : { rows: rows.map((row) => ({ ...row, cost: 2300 })) }),
      });
      const plan = (await callTool(serviceLifecycle(w.deps), args, w)) as { status: string };
      expect(plan.status).toBe('plan');
    });

    it('за потолком — отказ, и он попадает в журнал', async () => {
      const { w } = world({
        maxOpAmount: 5000,
        catalog: 7500,
        rows: (rows ?? [ACTIVE]).map((row) => ({ ...row, cost: 7500 })),
      });
      await expect(callTool(serviceLifecycle(w.deps), args, w)).rejects.toThrow(
        /MAX_OP_AMOUNT=5000/,
      );
      const { records } = await w.deps.audit.search({});
      expect(records[0]).toMatchObject({ tool: 'service_lifecycle', outcome: 'rejected' });
    });

    it('цену прочитать не удалось — отказ, а не молчаливый проход', async () => {
      const { w } = world({
        maxOpAmount: 5000,
        catalogFails: true,
        rows: (rows ?? [ACTIVE]).map((row) => ({ ...row, cost: null })),
      });
      await expect(callTool(serviceLifecycle(w.deps), args, w)).rejects.toThrow(
        /списывает деньги с баланса клиента, а цену тарифа/,
      );
    });

    it('тариф есть, а цены в нём нет — тот же отказ', async () => {
      const { w } = world({
        maxOpAmount: 5000,
        catalog: null,
        rows: (rows ?? [ACTIVE]).map((row) => ({ ...row, cost: null })),
      });
      await expect(callTool(serviceLifecycle(w.deps), args, w)).rejects.toThrow(
        /прочитать не удалось/,
      );
    });
  });

  describe.each(QUIET)('$action баланс не трогает', ({ args }) => {
    it('потолок в единицу не мешает и суммы не требует', async () => {
      const { w } = world({ maxOpAmount: 1 });
      const plan = (await callTool(serviceLifecycle(w.deps), args, w)) as { status: string };
      expect(plan.status).toBe('plan');
    });

    it('недоступный каталог ему безразличен: цена не спрашивается вовсе', async () => {
      const { w } = world({ maxOpAmount: 1, catalogFails: true });
      const plan = (await callTool(serviceLifecycle(w.deps), args, w)) as { status: string };
      expect(plan.status).toBe('plan');
      expect(w.calls.some((call) => call.path === '/admin/service')).toBe(false);
    });
  });

  /**
   * Отложенная ветка смены тарифа проверяется наравне с немедленной. Из ACTIVE
   * при `finish_active=0` списания сейчас не будет — и ровно поэтому послабление
   * здесь было бы дырой в размер одной опечатки в аргументе: оператору обе ветки
   * выглядят одним действием, а неденежный двойник у отложенной есть свой
   * (`schedule_change`), и он потолком не ограничен.
   */
  it('change_plan из ACTIVE с finish_active=0 проверяется тоже', async () => {
    const { w } = world({ maxOpAmount: 5000, catalog: 7500 });
    await expect(
      callTool(
        serviceLifecycle(w.deps),
        { user_id: 3073, action: 'change_plan', user_service_id: 55, service_id: 29, finish_active: 0 },
        w,
      ),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });

  /**
   * `prolongate` перед оплатой смотрит на `next`: при `next > 0` она зовёт
   * `switch_to_next_service`, и списание считается по СЛЕДУЮЩЕМУ тарифу
   * (Billing.pm:354-420). Продление услуги с назначенной сменой стоит цену
   * будущего тарифа, и проверять потолок по текущему значило бы проверять не то
   * число — здесь текущий тариф вдвое ниже потолка, а будущий вдвое выше.
   */
  it('touch с назначенной сменой берёт цену СЛЕДУЮЩЕГО тарифа, а не текущего', async () => {
    const { w } = world({
      maxOpAmount: 5000,
      rows: [{ ...ACTIVE, service_id: 12, cost: 2300, next: 29 }],
      catalog: { 12: 2300, 29: 7500 },
    });
    await expect(
      callTool(serviceLifecycle(w.deps), { user_id: 3073, action: 'touch', user_service_id: 55 }, w),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });

  /**
   * Цена в строке услуги есть не на всякой сборке SHM (`list_for_api`
   * подмешивает поля каталога по-разному от версии к версии). Пустое поле —
   * повод дочитать каталогом, а не повод остаться без суммы.
   */
  it('цены нет в строке услуги — она дочитывается каталогом', async () => {
    const { w } = world({
      maxOpAmount: 5000,
      rows: [{ ...ACTIVE, cost: null }],
      catalog: 7500,
    });
    await expect(
      callTool(serviceLifecycle(w.deps), { user_id: 3073, action: 'touch', user_service_id: 55 }, w),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
    expect(w.calls.some((call) => call.path === '/admin/service')).toBe(true);
  });

  /**
   * Обратная половина того же: цена уже прочитана вместе со строкой услуги, и
   * второй запрос за ней — чужой отказ по общему ведру SHM (§6.14).
   */
  it('цена из строки услуги берётся без второго запроса к каталогу', async () => {
    const { w } = world({ maxOpAmount: 5000, catalogFails: true });
    const plan = (await callTool(
      serviceLifecycle(w.deps),
      { user_id: 3073, action: 'touch', user_service_id: 55 },
      w,
    )) as { status: string; sideEffects: string[] };
    expect(plan.status).toBe('plan');
    expect(w.calls.some((call) => call.path === '/admin/service')).toBe(false);
    expect(plan.sideEffects.join(' ')).toMatch(/спишется 300/);
  });

  /**
   * Бесплатный тариф стоит ровно ноль, и это ЗАКОННАЯ сумма, а не «цену не
   * прочитали»: пробный период раздаётся именно так, и отказ на нём означал бы,
   * что триал через инструмент выдать нельзя.
   */
  it('тариф ценой 0 проходит даже при потолке в единицу', async () => {
    const { w } = world({ maxOpAmount: 1, catalog: 0 });
    const plan = (await callTool(
      serviceLifecycle(w.deps),
      { user_id: 3073, action: 'give', service_id: 21 },
      w,
    )) as { status: string };
    expect(plan.status).toBe('plan');
  });

  /** Потолок берётся по модулю — как и у прямых платежей. */
  it('отрицательная цена в каталоге проверяется по модулю', async () => {
    const { w } = world({ maxOpAmount: 5000, catalog: -7500 });
    await expect(
      callTool(serviceLifecycle(w.deps), { user_id: 3073, action: 'give', service_id: 29 }, w),
    ).rejects.toThrow(/MAX_OP_AMOUNT=5000/);
  });
});
