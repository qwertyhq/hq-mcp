import { beforeEach, describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ACCOUNTS_PATH, resetIdentitySchemaCache } from '../kit.js';
import { ShmError } from '@hq/shm';
import { clientOverview } from './overview.js';

interface ListOut {
  items: number;
  limit: number;
  offset: number;
  data: Record<string, unknown>[];
}

interface OverviewOut {
  shm: {
    user: { user_id: number; blocked: boolean } | null;
    services: ListOut;
    payments: ListOut;
    withdraws: ListOut;
  };
  remna: {
    user: Record<string, unknown> | null;
    devices: { checked: boolean; total: number; items: unknown[] };
    traffic: { usedBytes: number; limitBytes: number } | null;
  } | null;
  warnings: Array<{ code: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const shmUser = { user_id: 3073, login: 'tg900001', block: 0, balance: 100 };
const remnaUser = {
  id: 11221,
  username: 'tg900001',
  status: 'ACTIVE',
  expireAt: '2026-09-01T00:00:00.000Z',
  trojanPassword: 'trojan-plaintext',
  ssPassword: 'ss-plaintext',
  vlessUuid: 'vless-plaintext',
  subscriptionUrl: 'https://sub.example.com/aBcDeFgHiJkLmNoP',
  userTraffic: { usedTrafficBytes: '1073741824', onlineAt: '2026-08-08T11:00:00.000Z' },
};

const routes = (path: string): unknown => {
  /**
   * Установка ДО 3.0: маршрута `accounts` в роутере нет, SHM отвечает своим
   * 404, и это не отказ источника, а факт о версии — в `degraded` он не идёт.
   * Стаб появился вместе с запросом: карточка клиента спрашивает у SHM, где
   * та держит почту и телефон, потому что по строке эти две схемы неотличимы
   * (`users.login2` на 3.0+ жива и полна довоенных значений).
   */
  if (path === ACCOUNTS_PATH) throw new ShmError('Method not found', 404);
  if (path === '/admin/user') return [shmUser];
  if (path === '/admin/user/service') return [{ user_service_id: 51, status: 'ACTIVE' }];
  if (path === '/admin/user/pay') return [{ id: 7, money: 300 }];
  if (path === '/admin/user/service/withdraw') return [{ total: 150 }];
  throw new Error(`unexpected shm path ${path}`);
};

describe('client_overview', () => {
  beforeEach(() => {
    resetIdentitySchemaCache();
  });

  it('masks connection credentials of the panel user', async () => {
    const ctx = makeCtx({
      shmList: routes,
      remnaGet: (path) =>
        path === '/api/users/11221' ? remnaUser : [{ hwid: 'h1' }, { hwid: 'h2' }],
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('trojan-plaintext');
    expect(serialized).not.toContain('ss-plaintext');
    expect(serialized).not.toContain('vless-plaintext');
    expect(result.remna?.user?.trojanPassword).toBe('<redacted>');
    expect(result.remna?.user?.ssPassword).toBe('<redacted>');
    expect(result.remna?.user?.vlessUuid).toBe('<redacted>');
    expect(result.remna?.user?.id).toBe(11221);
    expect(result.remna?.devices.total).toBe(2);
  });

  it('sews both systems in one shot', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({
      calls,
      shmList: routes,
      remnaGet: (path) => (path === '/api/users/11221' ? remnaUser : []),
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.shm.user?.user_id).toBe(3073);
    expect(result.shm.services.data).toHaveLength(1);
    expect(result.shm.payments.data).toHaveLength(1);
    expect(result.shm.withdraws.data).toHaveLength(1);
    // Пять обращений к SHM, а не четыре: четыре списка карточки плюс ОДИН
    // вопрос «где эта SHM держит почту и телефон клиента» (/admin/user/accounts).
    // Он идёт в том же пучке, а не после, и на установке до 3.0 отвечает 404.
    expect(calls.filter((c) => c.system === 'shm')).toHaveLength(5);
    expect(calls.filter((c) => c.system === 'remna')).toHaveLength(2);
  });

  it('carries the real total outward and warns when the money window was filled', async () => {
    // §6.4: без items «платежей всего два» неотличимо от «окно кончилось».
    const ctx = makeCtx({
      shmList: (path, params) => {
        if (path === '/admin/user') return [shmUser];
        if (path === '/admin/user/pay') {
          return { items: 8123, limit: Number(params?.limit ?? 20), offset: 0, data: [{ id: 7 }, { id: 8 }] };
        }
        return [];
      },
      remnaGet: () => [],
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: null, limit: 2 },
      ctx,
    )) as OverviewOut;
    expect(result.shm.payments.items).toBe(8123);
    expect(result.shm.payments.data).toHaveLength(2);
    const truncated = result.warnings.find((w) => w.code === 'truncated');
    expect(truncated).toBeDefined();
    expect(JSON.stringify(truncated)).toContain('8123');
  });

  it('marks the answer partial when only the SHM lists fail and the panel is fine', async () => {
    // Регрессия на порядок: partial_result считался ДО того, как
    // разворачивались списки услуг/платежей/списаний, и падение именно их
    // давало непустой degraded без единого предупреждения.
    const ctx = makeCtx({
      shmList: (path) => {
        if (path === ACCOUNTS_PATH) throw new ShmError('Method not found', 404);
        if (path === '/admin/user') return [shmUser];
        throw new Error('SHM 500');
      },
      remnaGet: (path) => (path === '/api/users/11221' ? remnaUser : []),
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.remna?.user?.id).toBe(11221);
    expect(result.degraded.map((d) => d.system)).toEqual(['shm', 'shm', 'shm']);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('does not answer "0 devices, 0 bytes" for a panel that never answered', async () => {
    // Тот же отказ, что и у соседа subscription_inspect:175-179: `total: 0` без
    // признака «спросили и получили» читается как «устройств нет», и на нём
    // строят «сбросьте лишние устройства». Проза в partial_result этого не
    // заменяет — вызывающий читает число.
    const ctx = makeCtx({
      shmList: routes,
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.remna?.devices.checked).toBe(false);
    expect(result.remna?.traffic).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('card_unavailable');
  });

  it('does not answer a card of zeroes for an id the panel does not know', async () => {
    // Прикладной 404 у /api/users/{id} клиент отдаёт как null, а не как ошибку
    // (§6.16), поэтому вызов УСПЕШЕН и degraded пуст — но пользователя нет, и
    // трафик «0 из 0» здесь такое же утверждение, как «0 устройств» у
    // неответившей ручки. Сосед subscription_inspect разводит эти два случая
    // отдельными предупреждениями; здесь их не было ни одного.
    const ctx = makeCtx({
      shmList: routes,
      remnaGet: (path) => (path === '/api/users/11221' ? null : { total: 0, devices: [] }),
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.remna?.user).toBeNull();
    expect(result.remna?.traffic).toBeNull();
    // Ручка устройств ответила — ноль устройств здесь настоящий.
    expect(result.remna?.devices.checked).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('user_not_found');
    expect(result.warnings.map((w) => w.code)).not.toContain('card_unavailable');
    expect(result.degraded).toEqual([]);
  });

  it('counts devices from the envelope total, exactly as subscription_inspect does', async () => {
    // Ручка отдаёт КОНВЕРТ {total, devices}: длина отданного куска и размер
    // выборки — разные числа, и два инструмента не имеют права отвечать на
    // «сколько у клиента устройств» по разным правилам.
    const ctx = makeCtx({
      shmList: routes,
      remnaGet: (path) =>
        path === '/api/users/11221'
          ? remnaUser
          : { total: 5, devices: [{ hwid: 'h1' }, { hwid: 'h2' }] },
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.remna?.devices.checked).toBe(true);
    expect(result.remna?.devices.total).toBe(5);
    expect(result.remna?.devices.items).toHaveLength(2);
    expect(result.remna?.traffic?.usedBytes).toBe(1073741824);
  });

  it('returns the SHM half with a marker when the panel is down', async () => {
    const ctx = makeCtx({
      shmList: routes,
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.shm.user?.user_id).toBe(3073);
    expect(result.remna?.user).toBeNull();
    expect(result.degraded.map((d) => d.system)).toEqual(['remna', 'remna']);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('skips the panel entirely when no panel id is given and says why', async () => {
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, shmList: routes });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: null, limit: 20 },
      ctx,
    )) as OverviewOut;
    expect(result.remna).toBeNull();
    expect(calls.filter((c) => c.system === 'remna')).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('remna_not_requested');
  });

  it('stays usable and clearly degraded when both systems are entirely down', async () => {
    // Not in the brief's Step 1 fixture set; added because both halves failing
    // at once (including the primary /admin/user lookup) is the actual worst
    // case soft-degradation exists for, and none of the six brief tests hits it.
    const ctx = makeCtx({
      shmList: () => {
        throw new Error('SHM 500');
      },
      remnaGet: () => {
        throw new Error('panel 502');
      },
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: 11221, limit: 20 },
      ctx,
    )) as OverviewOut;

    expect(result.shm.user).toBeNull();
    expect(result.shm.services.data).toHaveLength(0);
    expect(result.shm.payments.data).toHaveLength(0);
    expect(result.shm.withdraws.data).toHaveLength(0);
    expect(result.remna?.user).toBeNull();
    // Семь, а не шесть: `accounts` — седьмой источник, и его отказ тоже
    // записан. Молчание здесь означало бы «почты у клиента нет» на ответе, в
    // котором её просто не у кого было спросить.
    expect(result.degraded).toHaveLength(7);
    // Пять: четыре списка плюс проба схемы идентичности, которая тоже не
    // ответила. Её молчание — не «почты нет», а «спросить не удалось».
    expect(result.degraded.filter((d) => d.system === 'shm')).toHaveLength(5);
    expect(result.degraded.filter((d) => d.system === 'remna')).toHaveLength(2);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });
});

/**
 * КАРТОЧКА КЛИЕНТА НА SHM 3.0: ПОЧТА И ТЕЛЕФОН НЕ В СТРОКЕ.
 *
 * `users.login2` осталась в таблице физически, с тем, что было записано ДО
 * переезда, и `/admin/user` отдаёт её как обычную колонку. Карточка, читающая
 * её, печатает довоенный адрес — а на телеграм-регистрации хендл `@<id>` — как
 * действующую почту клиента.
 */
describe('client_overview × SHM 3.0 accounts', () => {
  beforeEach(() => {
    resetIdentitySchemaCache();
  });

  const row30 = { user_id: 3073, login: 'tg900001', login2: '@900001', block: 0, balance: 100 };
  const accountRows = [
    { login: 'tg900001', type: 'login', user_id: 3073, primary: 1 },
    {
      login: 'petr@example.test',
      type: 'email',
      user_id: 3073,
      settings: { email: { verified: 1 } },
      primary: 0,
    },
    { login: '79990000000', type: 'phone', user_id: 3073, primary: 0 },
  ];

  const routes30 = (path: string): unknown => {
    if (path === ACCOUNTS_PATH) return accountRows;
    if (path === '/admin/user') return [row30];
    if (path === '/admin/user/service') return [];
    if (path === '/admin/user/pay') return [];
    if (path === '/admin/user/service/withdraw') return [];
    throw new Error(`unexpected shm path ${path}`);
  };

  it('takes the email and phone from accounts instead of the dead column', async () => {
    const ctx = makeCtx({ shmList: routes30 });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: null, limit: 20 },
      ctx,
    )) as {
      shm: {
        identitySchema: string;
        user: { email: string | null; email_from: string | null; phones: string[] } | null;
      };
      degraded: Array<{ system: string }>;
    };
    expect(result.shm.identitySchema).toBe('accounts');
    expect(result.shm.user?.email).toBe('petr@example.test');
    expect(result.shm.user?.email_from).toBe('accounts');
    expect(result.shm.user?.phones).toEqual(['79990000000']);
    expect(result.degraded).toEqual([]);
  });

  it('reports no email rather than the pre-migration handle when accounts has none', async () => {
    const ctx = makeCtx({
      shmList: (path) =>
        path === ACCOUNTS_PATH
          ? [{ login: 'tg900001', type: 'login', user_id: 3073, primary: 1 }]
          : routes30(path),
    });
    const result = (await clientOverview.handler(
      { shm_user_id: 3073, remna_user_id: null, limit: 20 },
      ctx,
    )) as { shm: { user: { email: string | null; email_from: string | null } | null } };
    expect(result.shm.user?.email).toBeNull();
    expect(result.shm.user?.email_from).toBeNull();
  });
});
