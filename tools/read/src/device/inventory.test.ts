import { describe, expect, it } from 'vitest';
import { makeCtx } from '../testkit.js';
import { deviceInventory } from './inventory.js';

interface Answer {
  stats: {
    totalHwidDevices: number | null;
    totalUniqueDevices: number | null;
    averageHwidDevicesPerUser: number | null;
    usersWithDevices: number | null;
    byPlatform: { platform: string | null; byApp: { app: string | null; count: number | null }[] }[];
  } | null;
  topUsers: { userId: number | null; devicesCount: number | null }[];
  devices: { items: number | null; returned: number; data: { ip: string | null }[] } | null;
  warnings: { code: string; message: string }[];
}

type Handler = typeof deviceInventory.handler;
type Input = Parameters<Handler>[0];

async function run(input: unknown, ctx: Parameters<Handler>[1]): Promise<Answer> {
  return (await deviceInventory.handler(deviceInventory.input.parse(input) as Input, ctx)) as Answer;
}

const STATS = {
  byPlatform: [
    { platform: 'iOS', count: 126, byApp: [{ app: 'Happ', count: 91 }] },
    { platform: 'Android', count: 54, byApp: [{ app: 'Happ', count: 44 }] },
  ],
  stats: { totalUniqueDevices: 210, totalHwidDevices: 229, averageHwidDevicesPerUser: 2.72 },
};

/** `total` тут — число КЛИЕНТОВ с устройствами, а не длина списка. */
const TOP = {
  users: [
    { username: 'HQVPN_53', id: 53, devicesCount: 26 },
    { username: 'HQVPN_54', id: 54, devicesCount: 23 },
  ],
  total: 84,
};

const DEVICES = {
  total: 229,
  devices: [
    {
      hwid: '00000000-1111-2222-3333-444444444444',
      userId: 55,
      platform: 'Linux',
      osVersion: '5.15.0',
      deviceModel: 'Linux amd64',
      userAgent: 'INCY/3.4.0/linux',
      requestIp: '203.0.113.25',
      createdAt: '2026-02-04T04:56:56.701Z',
      updatedAt: '2026-02-04T07:26:19.184Z',
    },
  ],
};

function ctxWith(overrides: Record<string, unknown> = {}) {
  return makeCtx({
    remnaGet: (path) => {
      if (path === '/api/hwid/devices/stats') return overrides.stats ?? STATS;
      if (path === '/api/hwid/devices/top-users') return overrides.top ?? TOP;
      if (path === '/api/hwid/devices') return overrides.devices ?? DEVICES;
      throw new Error(`unexpected path ${path}`);
    },
  });
}

describe('device_inventory', () => {
  it('gives the fleet baseline a per-client count is meaningless without', async () => {
    const result = await run({}, ctxWith());
    expect(result.stats?.totalHwidDevices).toBe(229);
    expect(result.stats?.averageHwidDevicesPerUser).toBe(2.72);
    expect(result.stats?.byPlatform[0]?.byApp[0]?.app).toBe('Happ');
    expect(result.topUsers[0]?.devicesCount).toBe(26);
  });

  /**
   * `total` ручки top-users — 84 КЛИЕНТА, а строк она вернула две.
   * Подставить сюда длину среза значило бы превратить «84 клиента с
   * устройствами» в «2».
   */
  it('reads the top-users total as clients-with-devices, not as the row count', async () => {
    const result = await run({}, ctxWith());
    expect(result.stats?.usersWithDevices).toBe(84);
    expect(result.topUsers).toHaveLength(2);
  });

  it('names the address field so profile redaction can see it', async () => {
    const result = await run({}, ctxWith());
    const device = result.devices?.data[0];
    expect(device?.ip).toBe('203.0.113.25');
    // Родное имя панели (`requestIp`) не попадает под PII_KEYS и уехало бы боту.
    expect(JSON.stringify(result)).not.toContain('requestIp');
  });

  it('declares the server-side count and warns that the window is a slice', async () => {
    const result = await run({ limit: 1 }, ctxWith());
    expect(result.devices?.items).toBe(229);
    expect(result.devices?.returned).toBe(1);
    const warning = result.warnings.find((one) => one.code === 'truncated');
    expect(warning?.message).toMatch(/1 of 229/);
  });

  it('says the count is unverifiable when the panel gives no total', async () => {
    const result = await run({}, ctxWith({ devices: { devices: DEVICES.devices } }));
    expect(result.warnings.map((one) => one.code)).toContain('server_count_absent');
  });

  /**
   * Ноль устройств на всю панель почти всегда означает выключенный учёт, а не
   * отсутствие устройств, и вывод «клиент ничем не пользуется» из него неверен.
   */
  it('treats a fleet-wide zero as a question about hwid tracking, not an answer about clients', async () => {
    const result = await run(
      {},
      ctxWith({ stats: { byPlatform: [], stats: { totalHwidDevices: 0, totalUniqueDevices: 0 } } }),
    );
    const warning = result.warnings.find((one) => one.code === 'hwid_not_recorded');
    expect(warning?.message).toMatch(/check that hwid tracking is switched on/);
  });

  it('reports a failed aggregate as unknown rather than zero', async () => {
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/hwid/devices/stats') throw new Error('panel down');
        if (path === '/api/hwid/devices/top-users') return TOP;
        if (path === '/api/hwid/devices') return DEVICES;
        throw new Error(`unexpected path ${path}`);
      },
    });
    const result = await run({}, ctx);
    expect(result.stats).toBeNull();
    expect(result.warnings.map((one) => one.code)).toContain('partial_result');
    expect(result.warnings.map((one) => one.code)).not.toContain('hwid_not_recorded');
  });

  it('refuses the bot profile: this is a fleet-wide PII export, not a client answer', async () => {
    const ctx = makeCtx({ profile: 'bot', remnaGet: () => STATS });
    await expect(run({}, ctx)).rejects.toThrow(/human profile only/);
  });
});
