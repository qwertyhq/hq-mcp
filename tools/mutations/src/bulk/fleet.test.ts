import { describe, expect, it } from 'vitest';
import { makeWorld } from '../testkit.js';
import { FLEET_PAGE_SIZE, readFleet, readFleetTotal, resolveUserIds, toFleetUser } from './fleet.js';
import type { FakeWorld } from '../testkit.js';

/**
 * Строка панели 3.2.3 в том виде, в каком она приходит с работающей панели:
 * числовой `id`, сквады списком объектов `{uuid, name}`, счётчик
 * трафика внутри `userTraffic`, и рядом — ключи подписки, которым в снимке
 * плана делать нечего.
 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 18171,
    username: 'client-3073',
    status: 'ACTIVE',
    expireAt: '2026-09-01T00:00:00.000Z',
    trafficLimitBytes: 53_687_091_200,
    trafficLimitStrategy: 'MONTH',
    hwidDeviceLimit: 5,
    tag: 'PREMIUM',
    activeInternalSquads: [
      { uuid: 'bbbbbbbb-e7d9-4102-b7e7-4a512925b76a', name: 'Second' },
      { uuid: 'aaaaaaaa-e7d9-4102-b7e7-4a512925b76a', name: 'Main Squad' },
    ],
    userTraffic: { usedTrafficBytes: 1_000_000 },
    shortUuid: 'abcdefghijklmnopqrst',
    subscriptionUrl: 'https://sub.example.io/abcdefghijklmnopqrst',
    trojanPassword: 'live-trojan-password',
    ssPassword: 'live-ss-password',
    vlessUuid: '11111111-2222-3333-4444-555555555555',
    ...over,
  };
}

/** Панель, отдающая `count` строк постранично, как настоящая. */
function fleetWorld(count: number, over?: (index: number) => Record<string, unknown>): FakeWorld {
  return makeWorld({
    remnaGet: (_path, params) => {
      const start = Number(params?.start ?? 0);
      const size = Number(params?.size ?? 25);
      const users: Record<string, unknown>[] = [];
      for (let i = start; i < Math.min(start + size, count); i += 1) {
        users.push(row({ id: 1000 + i, username: `c-${String(i)}`, ...over?.(i) }));
      }
      return { users, total: count };
    },
  });
}

describe('toFleetUser', () => {
  it('нормализует сквады до голых uuid — в теле запроса панель ждёт именно их', () => {
    const user = toFleetUser(row());
    expect(user?.squadUuids).toEqual([
      'aaaaaaaa-e7d9-4102-b7e7-4a512925b76a',
      'bbbbbbbb-e7d9-4102-b7e7-4a512925b76a',
    ]);
  });

  /**
   * Снимок плана уезжает на диск и в журнал мутаций. Ключи подписки, попавшие
   * туда, лежали бы там открытым текстом сколь угодно долго, а инструменту они
   * не нужны ни для одной ветки: тела массовых запросов собираются из
   * аргументов оператора, а не из прочитанного.
   */
  it('не переносит в снимок ни одного ключа подписки', () => {
    const user = toFleetUser(row());
    const flat = JSON.stringify(user);
    for (const secret of [
      'live-trojan-password',
      'live-ss-password',
      'sub.example.io',
      '11111111-2222-3333-4444-555555555555',
    ]) {
      expect(flat).not.toContain(secret);
    }
  });

  it('отбрасывает строку без числового id — адресоваться по ней нечем', () => {
    expect(toFleetUser({ username: 'no-id' })).toBeNull();
    expect(toFleetUser(null)).toBeNull();
  });

  it('читает счётчик трафика из userTraffic, а не с верхнего уровня', () => {
    expect(toFleetUser(row())?.usedTrafficBytes).toBe(1_000_000);
    expect(toFleetUser(row({ userTraffic: null }))?.usedTrafficBytes).toBeNull();
  });
});

describe('readFleet', () => {
  it('дочитывает до конца страницами и отдаёт total панели рядом со строками', async () => {
    const w = fleetWorld(1234);
    const fleet = await readFleet(w.ctx, 'весь флот', { cap: Number.MAX_SAFE_INTEGER });
    expect(fleet.total).toBe(1234);
    expect(fleet.users).toHaveLength(1234);
    // 1234 при странице 500 — это ровно три обращения, а не одно и не 1234.
    expect(w.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
    expect(w.calls[0]?.params).toMatchObject({ size: FLEET_PAGE_SIZE, start: 0 });
  });

  /**
   * Перечислять поимённо набор, который заведомо не пройдёт потолок, незачем:
   * `total` для отказа известен уже с первой страницы, а трафик тратится.
   */
  it('обрывает чтение, как только прочитанного стало больше потолка, но total не теряет', async () => {
    const w = fleetWorld(1234);
    const fleet = await readFleet(w.ctx, 'статус DISABLED', { cap: 100 });
    expect(fleet.total).toBe(1234);
    expect(w.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(fleet.users.length).toBeLessThan(1234);
  });

  /**
   * Без `total` заявить полноту НЕЛЬЗЯ. Короткая страница у панели, которая
   * молча режет выдачу, выглядит ровно как конец списка — и «нашли 50 из 1234»
   * превратилось бы в «затронуто 50».
   */
  it('отказывается строить план, когда панель не сообщила total', async () => {
    const w = makeWorld({ remnaGet: () => ({ users: [row()] }) });
    await expect(readFleet(w.ctx, 'весь флот', { cap: 10 })).rejects.toThrow(/total/);
    await expect(readFleetTotal(w.ctx)).rejects.toThrow(/total/);
  });

  it('громко отказывает на пустой странице при ненулевом total, а не крутится на месте', async () => {
    const w = makeWorld({ remnaGet: () => ({ users: [], total: 300 }) });
    await expect(readFleet(w.ctx, 'весь флот', { cap: 1000 })).rejects.toThrow(/пустую страницу/);
  });

  /**
   * `/api/users` гонит `filters` через `z.preprocess(JSON.parse)`. Массив,
   * отданный не строкой, был бы молча выброшен нестрогой схемой — фильтр
   * «работал» бы, не сузив ничего, и число затронутых оказалось бы размером
   * всего флота.
   */
  it('передаёт фильтр строкой JSON — иначе панель молча его игнорирует', async () => {
    const w = fleetWorld(3);
    await readFleet(w.ctx, 'статус EXPIRED', {
      cap: 100,
      filters: [{ id: 'status', value: 'EXPIRED' }],
    });
    expect(w.calls[0]?.params).toMatchObject({
      filters: '[{"id":"status","value":"EXPIRED"}]',
    });
  });
});

describe('resolveUserIds', () => {
  it('делит названный список на существующих и отсутствующих', async () => {
    const w = fleetWorld(5);
    const { found, missing } = await resolveUserIds(w.ctx, [1000, 1002, 999_999]);
    expect(found.map((user) => user.id)).toEqual([1000, 1002]);
    expect(missing).toEqual([999_999]);
  });

  /**
   * Сотня точечных `GET /api/users/{id}` съела бы весь гейт запросов (§6.14,
   * 30 обращений в минуту) и упала бы на середине списка. Флот читается
   * страницами независимо от длины списка.
   */
  it('читает флот страницами, а не по запросу на каждый названный id', async () => {
    const w = fleetWorld(600);
    const ids = Array.from({ length: 200 }, (_unused, index) => 1000 + index);
    const { found, missing } = await resolveUserIds(w.ctx, ids);
    expect(found).toHaveLength(200);
    expect(missing).toEqual([]);
    expect(w.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('схлопывает повторы в списке — задеть одного дважды нельзя', async () => {
    const w = fleetWorld(5);
    const { found } = await resolveUserIds(w.ctx, [1001, 1001, 1001]);
    expect(found.map((user) => user.id)).toEqual([1001]);
  });
});
