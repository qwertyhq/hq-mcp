import { describe, expect, it } from 'vitest';
import { OWNERSHIP_PAGE, assertServiceOwner, readServicesPage } from './ownership.js';
import { listOf, makeWorld } from '../testkit.js';
import type { ClientParams } from '@hq/types';

const own = {
  user_service_id: 56,
  user_id: 3073,
  service_id: 22,
  status: 'ACTIVE',
  name: 'Месяц',
  expire: '2026-09-01 00:00:00',
  next: -1,
};

/** Мир, где серверный фильтр работает: одна строка по user_service_id. */
function filtering(rows: Record<string, unknown>[]) {
  return makeWorld({
    shmList: (_path: string, params?: ClientParams) => {
      const raw = params?.filter;
      if (typeof raw !== 'string') return listOf(rows, rows.length);
      const wanted = (JSON.parse(raw) as { user_service_id?: number }).user_service_id;
      const hit = rows.filter((row) => row.user_service_id === wanted);
      return listOf(hit, hit.length);
    },
  });
}

describe('assertServiceOwner: строка по фильтру', () => {
  it('владелец совпал — строка отдана целиком', async () => {
    const w = filtering([own]);
    await expect(assertServiceOwner(w.ctx, 3073, 56, 'service_lifecycle')).resolves.toMatchObject({
      user_service_id: 56,
      user_id: 3073,
      status: 'ACTIVE',
      next: -1,
    });
    expect(String((w.calls[0]?.params as Record<string, unknown>).filter)).toContain('56');
    expect(w.calls).toHaveLength(1);
  });

  /**
   * Отказ по существу возможен ТОЛЬКО так: строка нашлась и в ней чужой
   * user_id. Из «не нашли» вывод «услуга чужая» не следует никогда.
   */
  it('чужая услуга — отказ по существу, с именем настоящего владельца', async () => {
    const w = filtering([{ ...own, user_id: 9999 }]);
    await expect(assertServiceOwner(w.ctx, 3073, 56, 'service_lifecycle')).rejects.toThrow(
      /принадлежит клиенту user_id=9999/,
    );
  });

  /**
   * Фильтр сработал (`items === 0`) — услуги нет, и об этом говорится прямо.
   * «Подтвердить не удалось» осталось за случаем, когда сузить выборку не
   * получилось вовсе: он ниже, в описании сборки без серверного фильтра.
   */
  it('строки нет вовсе — «нет в SHM», и НИКОГДА «не принадлежит»', async () => {
    const w = filtering([own]);
    const promise = assertServiceOwner(w.ctx, 3073, 777, 'service_lifecycle');
    await expect(promise).rejects.toThrow(/нет в SHM/);
    await expect(promise).rejects.not.toThrow(/принадлежит клиенту user_id=/);
  });

  it('имя инструмента открывает текст отказа: его читает оператор', async () => {
    const w = filtering([{ ...own, user_id: 9999 }]);
    await expect(assertServiceOwner(w.ctx, 3073, 56, 'billing_refund_service')).rejects.toThrow(
      /^billing_refund_service:/,
    );
  });
});

describe('assertServiceOwner: сборка без серверного фильтра', () => {
  /**
   * Живая проверка на 2.19.4: `?user_service_id=3938` без фильтра вернул
   * items=1039 и голову таблицы. Принять эту строку за ответ значит подтвердить
   * владение чужой услугой, поэтому несовпадение id и items>1 — сигнал «фильтр
   * не сработал», а не данные.
   */
  const head = [
    { user_service_id: 11222, user_id: 10169, status: 'ACTIVE' },
    { user_service_id: 11223, user_id: 10170, status: 'ACTIVE' },
  ];

  it('голова таблицы вместо фильтра не считается ответом — переходим на страницу клиента', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return call === 1 ? listOf(head, 1039) : listOf([own]);
      },
    });

    await expect(assertServiceOwner(w.ctx, 3073, 56, 'service_lifecycle')).resolves.toMatchObject({
      user_service_id: 56,
    });
    expect((w.calls[1]?.params as Record<string, unknown>).limit).toBe(OWNERSHIP_PAGE);
  });

  it('на странице услуги нет — «подтвердить не удалось», и никогда «чужая»', async () => {
    let call = 0;
    const w = makeWorld({
      shmList: () => {
        call += 1;
        return call === 1 ? listOf(head, 1039) : listOf([own], 900);
      },
    });

    const promise = assertServiceOwner(w.ctx, 3073, 777, 'service_lifecycle');
    await expect(promise).rejects.toThrow(/подтвердить принадлежность/);
    await expect(promise).rejects.toThrow(/900/);
    await expect(promise).rejects.not.toThrow(/принадлежит клиенту user_id=/);
  });
});

describe('readServicesPage', () => {
  it('сообщает покрытие, а не только строки', async () => {
    const full = makeWorld({ shmList: () => listOf([own]) });
    await expect(readServicesPage(full.ctx, 3073)).resolves.toMatchObject({ items: 1, covered: true });

    const partial = makeWorld({ shmList: () => listOf([own], 900) });
    await expect(readServicesPage(partial.ctx, 3073)).resolves.toMatchObject({
      items: 900,
      covered: false,
    });
  });

  it('спрашивает страницу клиента целиком, а не дефолтные 25', async () => {
    const w = makeWorld({ shmList: () => listOf([own]) });
    await readServicesPage(w.ctx, 3073);
    expect(w.calls[0]?.params).toMatchObject({ user_id: 3073, limit: OWNERSHIP_PAGE });
  });

  /**
   * Работающая SHM 2.19.4 отдаёт тариф и плоско, и вложенно под ключом `services`,
   * а исходник 2.x — под `service`. Инструмент, знающий одну форму, на другой
   * версии молча получает null вместо статуса: предусловия перестают
   * проверяться, а выглядит он рабочим.
   */
  it('читает вложенную форму тарифа и строковые числа настоящей SHM', async () => {
    const w = makeWorld({
      shmList: () =>
        listOf([
          {
            user_service_id: '3938',
            user_id: '3073',
            service_id: 12,
            status: 'ACTIVE',
            cost: '300.00',
            auto_bill: '1',
            services: { name: 'VPN 1 Месяц', cost: 300 },
          },
        ]),
    });
    const page = await readServicesPage(w.ctx, 3073);
    expect(page.services[0]).toMatchObject({
      user_service_id: 3938,
      user_id: 3073,
      name: 'VPN 1 Месяц',
      cost: 300,
      auto_bill: 1,
    });
  });
});
