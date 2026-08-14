import { describe, expect, it } from 'vitest';
import { createProbeStore } from '@hq/registry';
import { makeCtx } from '../testkit.js';
import type { StubCall } from '../testkit.js';
import { UNKNOWN_CAPABILITIES } from '../platform/probe.js';
import { subscriptionInspect } from './inspect.js';

interface SubscriptionOut {
  found: boolean;
  user: {
    id: number | null;
    username: string | null;
    status: string | null;
    expireAt: string | null;
    traffic: { usedBytes: number; lifetimeBytes: number; limitBytes: number };
    onlineAt: string | null;
    squads: string[];
  } | null;
  devices: {
    checked: boolean;
    limit: number | null;
    total: number;
    items: Array<{ hwid: string | null; platform: string | null }>;
  };
  requests: {
    checked: boolean;
    recordedByPanel: boolean | 'unknown';
    total: number;
    limit: number;
    items: Array<{ at: string | null; userAgent: string | null }>;
  };
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const SUB_TAIL = 'aBcDeFgHiJkLmNoP';

const user = {
  // Live 3.2.3 shape: numeric `id`, no `uuid` field at all.
  id: 11221,
  username: 'HQVPN_51',
  status: 'ACTIVE',
  expireAt: '2026-09-01T00:00:00.000Z',
  hwidDeviceLimit: 5,
  trafficLimitBytes: '10737418240',
  trojanPassword: 'trojan-plaintext',
  vlessUuid: 'vless-plaintext',
  subscriptionUrl: `https://sub.example.com/${SUB_TAIL}`,
  // §6.17: трафик и онлайн живут ТОЛЬКО во вложенном userTraffic, а байты
  // приезжают то строкой, то числом.
  userTraffic: {
    usedTrafficBytes: '1073741824',
    lifetimeUsedTrafficBytes: 2147483648,
    onlineAt: '2026-08-08T11:00:00.000Z',
    firstConnectedAt: '2026-07-01T09:00:00.000Z',
  },
  activeInternalSquads: [{ uuid: 's-1', name: 'vk-turn' }],
};

/**
 * Обе ручки отдают КОНВЕРТ, а не голый массив: после снятия `response`
 * клиентом остаётся `{total, devices}` и `{total, records}`
 * (GetUserSubscriptionRequestHistoryResponseDto; подтверждено работающим кодом —
 * ai-bot/src/ai/tools.ts:87-92, ai-bot/src/operator/tickets.ts:250-257).
 * Голый массив в фикстуре пропустил бы реализацию, теряющую всю историю.
 */
const routes = (path: string): unknown => {
  if (path === '/api/users/11221') return user;
  if (path === '/api/hwid/devices/11221') {
    return { total: 1, devices: [{ hwid: 'h1', platform: 'ios', deviceModel: 'iPhone 15' }] };
  }
  if (path === '/api/users/11221/subscription-request-history') {
    return {
      total: 1,
      records: [
        {
          id: 1,
          userId: 11221,
          requestAt: '2026-08-08T10:00:00.000Z',
          requestIp: '203.0.113.7',
          userAgent: 'Happ/3.5.2/ios',
        },
      ],
    };
  }
  throw new Error(`unexpected path ${path}`);
};

const input = (over: Partial<{ user_id: number; limit: number }> = {}) => ({
  user_id: 11221,
  limit: 20,
  ...over,
});

describe('subscription_inspect', () => {
  it('addresses all three panel routes by the numeric id', async () => {
    // On 3.x the path parameter is `userId: number`; a uuid is rejected at
    // validation (live: 400 "Validation failed"). `found` was computed from
    // `uuid`, which no longer exists, so it was permanently false.
    const calls: StubCall[] = [];
    const ctx = makeCtx({ calls, remnaGet: routes });
    const result = (await subscriptionInspect.handler(input(), ctx)) as SubscriptionOut;

    expect(result.found).toBe(true);
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/users/11221');
    expect(paths).toContain('/api/hwid/devices/11221');
    expect(paths).toContain('/api/users/11221/subscription-request-history');
  });

  it('normalises string bytes into numbers and never leaks credentials', async () => {
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({ remnaGet: routes }),
    )) as SubscriptionOut;

    expect(result.found).toBe(true);
    expect(result.user?.traffic).toEqual({
      usedBytes: 1073741824,
      lifetimeBytes: 2147483648,
      limitBytes: 10737418240,
    });
    expect(result.user?.onlineAt).toBe('2026-08-08T11:00:00.000Z');
    expect(result.user?.squads).toEqual(['vk-turn']);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('trojan-plaintext');
    expect(serialized).not.toContain('vless-plaintext');
    expect(serialized).not.toContain(SUB_TAIL);
  });

  it('reads devices and request history out of their envelopes', async () => {
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({ remnaGet: routes }),
    )) as SubscriptionOut;

    expect(result.devices.total).toBe(1);
    expect(result.devices.checked).toBe(true);
    expect(result.requests.checked).toBe(true);
    expect(result.devices.limit).toBe(5);
    expect(result.devices.items).toEqual([
      { hwid: 'h1', platform: 'ios', deviceModel: 'iPhone 15', createdAt: null },
    ]);
    expect(result.requests.total).toBe(1);
    expect(result.requests.items).toEqual([
      { at: '2026-08-08T10:00:00.000Z', userAgent: 'Happ/3.5.2/ios' },
    ]);
  });

  it('reports a device limit of zero as no limit at all', async () => {
    // wbap/src/lib/api/hwidDevices.ts:80-81 приводит <= 0 к null: нулевой
    // лимит означает «ограничения нет». Как есть это читалось бы как «три
    // устройства при лимите ноль».
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({
        remnaGet: (path) =>
          path === '/api/users/11221' ? { ...user, hwidDeviceLimit: 0 } : routes(path),
      }),
    )) as SubscriptionOut;

    expect(result.devices.limit).toBeNull();
  });

  it('caps the request history and says how much of it there was', async () => {
    // Одна запись на каждый забор подписки, а клиенты опрашивают её
    // непрерывно: без потолка долгоживущий клиент вываливает тысячи строк с
    // сырыми User-Agent в контекст модели на каждый вызов.
    const records = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      requestAt: `2026-08-0${String((i % 8) + 1)}T10:00:00.000Z`,
      userAgent: `Happ/3.5.${String(i)}/ios`,
    }));
    const result = (await subscriptionInspect.handler(
      input({ limit: 5 }),
      makeCtx({
        remnaGet: (path) =>
          path === '/api/users/11221/subscription-request-history'
            ? { total: 8431, records }
            : routes(path),
      }),
    )) as SubscriptionOut;

    expect(result.requests.total).toBe(8431);
    expect(result.requests.limit).toBe(5);
    expect(result.requests.items).toHaveLength(5);
    // Самые свежие сверху: без сортировки «последние запросы» означали бы
    // «первые, что вернула панель».
    expect(result.requests.items[0]?.at).toBe('2026-08-08T10:00:00.000Z');
    expect(result.warnings.map((w) => w.code)).toContain('truncated');
  });

  it('drops the user agent for the bot profile', async () => {
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({ remnaGet: routes, profile: 'bot' }),
    )) as SubscriptionOut;
    expect(result.requests.items[0]?.userAgent).toBeNull();
  });

  it('says the user does not exist instead of returning a zeroed card', async () => {
    // @hq/remna отдаёт null (не бросает) на прикладной 404 у /api/users/{id},
    // поэтому settle успешен, degraded пуст, а asRecord(null) — это {}. Без
    // явной проверки протухший id выглядел бы как живой абонент, который
    // просто ни разу не подключался.
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({
        remnaGet: (path) => (path === '/api/users/11221' ? null : routes(path)),
      }),
    )) as SubscriptionOut;

    expect(result.found).toBe(false);
    expect(result.user).toBeNull();
    expect(result.degraded).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain('user_not_found');
  });

  it('does not read a failed card call as a deleted subscriber', async () => {
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({
        remnaGet: (path) => {
          if (path === '/api/users/11221') throw new Error('HTTP 502');
          return routes(path);
        },
      }),
    )) as SubscriptionOut;

    expect(result.found).toBe(false);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('card_unavailable');
    // «В панели такого нет» — утверждение, и по неудавшемуся запросу его
    // делать нельзя.
    expect(codes).not.toContain('user_not_found');
  });

  it('degrades softly when the history route is missing', async () => {
    const result = (await subscriptionInspect.handler(
      input(),
      makeCtx({
        remnaGet: (path) => {
          if (path.endsWith('/subscription-request-history')) throw new Error('HTTP 404');
          return routes(path);
        },
      }),
    )) as SubscriptionOut;

    expect(result.requests.items).toEqual([]);
    // `total: 0` рядом с `checked: false` — «не спросили», а не «запросов не
    // было». Вызывающий читает число, а не прозу в partial_result.
    expect(result.requests.total).toBe(0);
    expect(result.requests.checked).toBe(false);
    expect(result.devices.checked).toBe(true);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'HTTP 404' }]);
    expect(result.user?.id).toBe(11221);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('defaults the history window', async () => {
    expect(subscriptionInspect.input.parse({ user_id: 11221 })).toEqual({
      user_id: 11221,
      limit: 20,
    });
  });

  /**
   * Пустая история — два разных факта под одним видом: «клиент не подключался»
   * и «панель этого не пишет». Различает их только настройка панели, которую
   * читает platform_probe, поэтому вердикт пробы обязан доехать сюда — иначе
   * инструмент отвечает уверенно и наугад.
   */
  describe('empty request history is not proof that the client never connected', () => {
    const emptyHistory = (path: string): unknown =>
      path.endsWith('/subscription-request-history') ? { total: 0, records: [] } : routes(path);

    const withProbe = (verdict: boolean | 'unknown'): ReturnType<typeof makeCtx> => {
      const probe = createProbeStore();
      probe.set({
        checkedAt: '2026-08-08T12:00:00.000Z',
        cached: false,
        shm: {
          configured: true,
          reachable: true,
          error: null,
          spoolStatuses: [],
          version: null,
          live: true,
          credentialsRejected: false,
        },
        remna: {
          configured: true,
          reachable: true,
          error: null,
          version: '3.2.3',
          credentialsRejected: false,
          runtime: null,
        },
        capabilities: { ...UNKNOWN_CAPABILITIES, 'remna.subscriptionRequestHistory': verdict },
        warnings: [],
      });
      return makeCtx({ probe, remnaGet: emptyHistory });
    };

    it('says so out loud when the panel does not record it', async () => {
      const result = (await subscriptionInspect.handler(input(), withProbe(false))) as SubscriptionOut;
      expect(result.requests.recordedByPanel).toBe(false);
      const found = result.warnings.find((w) => w.code === 'subscription_history_not_recorded');
      expect(found?.message).toContain('never connected');
    });

    it('stays quiet when the panel does record it — then empty means empty', async () => {
      const result = (await subscriptionInspect.handler(input(), withProbe(true))) as SubscriptionOut;
      expect(result.requests.recordedByPanel).toBe(true);
      expect(result.warnings.map((w) => w.code)).not.toContain('subscription_history_not_recorded');
    });

    it("answers 'unknown', not 'recorded', when the probe never ran", async () => {
      const result = (await subscriptionInspect.handler(
        input(),
        makeCtx({ remnaGet: emptyHistory }),
      )) as SubscriptionOut;
      // Пустое хранилище пробы — это отсутствие данных, а не разрешение
      // утверждать. Значение по умолчанию `true` было бы ровно тем молчаливым
      // «клиент не подключался», ради устранения которого поле заведено.
      expect(result.requests.recordedByPanel).toBe('unknown');
      expect(result.warnings.map((w) => w.code)).not.toContain('subscription_history_not_recorded');
    });

    it('does not fire on a non-empty history even when recording is off', async () => {
      const probeCtx = withProbe(false);
      const result = (await subscriptionInspect.handler(
        input(),
        makeCtx({ probe: probeCtx.probe, remnaGet: routes }),
      )) as SubscriptionOut;
      expect(result.requests.total).toBe(1);
      expect(result.warnings.map((w) => w.code)).not.toContain('subscription_history_not_recorded');
    });
  });
});
