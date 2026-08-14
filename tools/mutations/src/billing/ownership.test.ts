import { describe, expect, it } from 'vitest';
import { listOf, makeWorld } from '../testkit.js';
import { OWNERSHIP_PAGE, assertOwnsService } from './ownership.js';

const own = {
  user_service_id: 56,
  user_id: 3073,
  service_id: 22,
  status: 'ACTIVE',
  name: 'Месяц',
  withdraw_id: 24641,
  withdraws: { withdraw_id: 24641, total: 300, bonus: 0, end_date: '2026-09-13 10:00:00' },
};

describe('assertOwnsService: путь фильтра', () => {
  it('берёт ОДНУ строку по user_service_id и отдаёт её вместе со списанием', async () => {
    const w = makeWorld({ shmList: () => listOf([own]) });

    await expect(assertOwnsService(w.ctx, 3073, 56, 'billing_refund_service')).resolves.toMatchObject({
      user_service_id: 56,
      status: 'ACTIVE',
      withdraws: { total: 300 },
    });
    // Спрашиваем именно услугу, а не страницу услуг клиента: страница врёт
    // трижды (пагинация, дети composite, REMOVED).
    expect(String((w.calls[0]?.params as Record<string, unknown>).filter)).toContain('56');
    expect(w.calls).toHaveLength(1);
  });

  it('чужая услуга — ОТКАЗ ПО СУЩЕСТВУ: строка нашлась и в ней другой user_id', async () => {
    const w = makeWorld({ shmList: () => listOf([{ ...own, user_id: 9999 }]) });
    const promise = assertOwnsService(w.ctx, 3073, 56, 'billing_refund_service');
    await expect(promise).rejects.toThrow(/принадлежит клиенту user_id=9999/);
  });

  it('такой услуги нет вовсе — это не «чужая», и текст другой', async () => {
    const w = makeWorld({ shmList: () => listOf([]) });
    await expect(assertOwnsService(w.ctx, 3073, 777, 'billing_refund_service')).rejects.toThrow(
      /нет в SHM/,
    );
  });
});

describe('assertOwnsService: сборка без server-side filter', () => {
  // Фильтр не сузил выборку — вернулась голова таблицы. Ровно тот случай,
  // ради которого в @hq/types живёт возможность shm.filter.
  const foreign = [
    { user_service_id: 1, user_id: 1, status: 'ACTIVE' },
    { user_service_id: 2, user_id: 2, status: 'ACTIVE' },
  ];

  it('переходит на страницу клиента и подтверждает принадлежность там', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return call === 1 ? listOf(foreign, 15520) : listOf([own]);
      },
    });

    await expect(assertOwnsService(w.ctx, 3073, 56, 'service_lifecycle')).resolves.toMatchObject({
      user_service_id: 56,
    });
    expect((w.calls[1]?.params as Record<string, unknown>).limit).toBe(OWNERSHIP_PAGE);
  });

  it('на странице услуги нет — «подтвердить не удалось», и НИКОГДА «не принадлежит»', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return call === 1 ? listOf(foreign, 15520) : listOf([own], 900);
      },
    });

    const promise = assertOwnsService(w.ctx, 3073, 777, 'service_lifecycle');
    await expect(promise).rejects.toThrow(/подтвердить принадлежность/);
    await expect(promise).rejects.toThrow(/900/);
    // Контроль: список услуг клиента прячет REMOVED и дочерние услуги на
    // стороне SHM, поэтому исчерпанная страница НЕ доказывает чужую услугу.
    await expect(promise).rejects.not.toThrow(/не принадлежит/);
  });

  it('и когда страница покрыла весь список — вывод тот же: не доказано, а не «чужая»', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return call === 1 ? listOf(foreign, 15520) : listOf([own]);
      },
    });

    const promise = assertOwnsService(w.ctx, 3073, 777, 'service_lifecycle');
    await expect(promise).rejects.toThrow(/подтвердить принадлежность/);
    await expect(promise).rejects.toThrow(/REMOVED/);
  });
});
