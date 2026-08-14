import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  asArray,
  asRecord,
  assertHumanOnly,
  capLimit,
  declaredTotal,
  envelope,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

/**
 * Контроллер hwid панели 3.2.3, читающая половина. Из семи маршрутов читают
 * четыре, и один из них — `devices/{userId}` — уже стоит за
 * subscription_inspect. Здесь остальные три, то есть ФЛОТ ЦЕЛИКОМ:
 *   devices             — список всех привязок разом;
 *   devices/stats       — разрез по платформам и приложениям;
 *   devices/top-users   — кто держит больше всех устройств.
 * Три маршрута записи (create/delete/delete-all) отсутствуют намеренно: отвязка
 * устройства выкидывает живого клиента из сети, и это операция, а не чтение.
 *
 * ЗАЧЕМ ФЛОТ, КОГДА ЕСТЬ КАРТОЧКА КЛИЕНТА: «у клиента 5 устройств» —
 * бессмысленное число, пока неизвестно, сколько держит средний по базе клиент и
 * сколько — верхний. Расследование шеринга начинается со сравнения с флотом, а
 * заканчивается конкретным клиентом, и до сих пор здесь был доступен только
 * второй конец.
 */
const DEVICES_PATH = '/api/hwid/devices';
const STATS_PATH = '/api/hwid/devices/stats';
const TOP_PATH = '/api/hwid/devices/top-users';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;
const MAX_TOP = 100;

interface Device {
  hwid: string | null;
  userId: number | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  /**
   * Имя поля выбрано так, чтобы редакция профиля bot его СЪЕЛА: панель зовёт
   * его `requestIp`, а PII_KEYS в @hq/redact содержит `ip`, и нормализация имён
   * ('requestip' против 'ip') их не сближает — то есть под родным именем адрес
   * уехал бы боту в обход §7.2. Тот же приём и по той же причине, что
   * `actionReport.ip` в torrent_reports. Инструмент human-only, но имя обязано
   * защищать и в том случае, если профили когда-нибудь расширят.
   */
  ip: string | null;
  userAgent: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const deviceInventory = defineTool({
  name: 'device_inventory',
  description:
    'The hwid device picture for the whole fleet: how many devices exist, how they split across ' +
    'platforms and apps, who holds the most, and a window into the raw device list. This is the ' +
    'baseline a per-client device count is meaningless without — "five devices" only means ' +
    'something next to the fleet average and the top of the distribution, and until now only ' +
    'the per-client end was readable. ' +
    'Counts come from the panel and are exact; the device window is a slice and says so. The ' +
    'per-user counts in `topUsers` are the panel\'s own, not derived from the window. ' +
    'Device rows carry the client address under the field name `ip` deliberately, so that ' +
    'profile redaction can see it. ' +
    'Deleting a device, deleting all of a client\'s devices and creating one are absent on ' +
    'purpose: unbinding a device drops a live client off the network, which is an operation ' +
    'and not a diagnosis.',
  input: z.object({
    limit: z.number().int().default(DEFAULT_LIMIT).describe('Devices in the window, capped at 200'),
    offset: z.number().int().min(0).default(0).describe('Window start inside the device list'),
    top_limit: z.number().int().default(10).describe('Rows of topUsers to return, capped at 100'),
    include_devices: z
      .boolean()
      .default(true)
      .describe('Include the raw device window; off returns only the aggregates'),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * Только human. Не из-за формы данных — она та же, что в
   * subscription_inspect, который боту открыт, — а из-за ОБЪЁМА: там карточка
   * одного клиента, здесь выгрузка всего флота — тысячи привязок с адресами и
   * user-agent'ами. Массовая выгрузка PII не становится ответом на
   * вопрос клиента ни в одной формулировке, и §7.2 отделяет именно это.
   */
  profiles: ['human'],
  backends: ['remna'],
  handler: async ({ limit, offset, top_limit, include_devices }, ctx) => {
    assertHumanOnly(
      ctx,
      'device_inventory is available to the human profile only: it is a fleet-wide export of ' +
        'device bindings with client addresses and user agents, not an answer to one client\'s ' +
        'question (§7.2). subscription_inspect returns the same shape for a single client.',
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);
    const topCap = capLimit(top_limit, 10, MAX_TOP);

    const [stats, top, devices] = await Promise.all([
      settle(ctx.remna.get<unknown>(STATS_PATH)),
      settle(ctx.remna.get<unknown>(TOP_PATH)),
      include_devices
        ? settle(ctx.remna.get<unknown>(DEVICES_PATH, { size: cap, start: offset }))
        : Promise.resolve({ ok: true as const, value: null }),
    ]);

    const statsBody = asRecord(take(stats, 'remna', degraded, null));
    const counts = asRecord(statsBody.stats);
    const byPlatform = asArray(statsBody.byPlatform)
      .map(asRecord)
      .map((row) => ({
        platform: str(row.platform),
        count: optionalNumber(row.count),
        byApp: asArray(row.byApp)
          .map(asRecord)
          .map((app) => ({ app: str(app.app), count: optionalNumber(app.count) })),
      }));

    const topBody = asRecord(take(top, 'remna', degraded, null));
    const topUsers = asArray(topBody.users)
      .map(asRecord)
      .map((row) => ({
        userId: optionalNumber(row.id),
        username: str(row.username),
        devicesCount: optionalNumber(row.devicesCount),
      }));
    /**
     * `total` этой ручки — это НЕ длина списка и не число устройств: на
     * работающей панели она вернула короткую верхушку рейтинга при `total`,
     * больше её в сотни раз: `total` считает всех клиентов, у которых устройства
     * вообще есть. Подставить сюда длину среза значило бы превратить «сотни
     * клиентов с устройствами» в «столько, сколько строк влезло в верхушку».
     */
    const usersWithDevices = top.ok ? optionalNumber(topBody.total) : null;

    // Тело разбирается ДВАЖДЫ и намеренно: `envelope` даёт строки, а
    // `declaredTotal` — то, назвал ли сервер число ВООБЩЕ. Взять `total` из
    // `envelope` значило бы принять длину среза за размер флота.
    const devicesBody = take(devices, 'remna', degraded, null);
    const window = include_devices ? envelope(devicesBody, 'devices') : { rows: [], total: 0 };
    const data: Device[] = window.rows.map((row) => ({
      hwid: str(row.hwid),
      userId: optionalNumber(row.userId),
      platform: str(row.platform),
      osVersion: str(row.osVersion),
      deviceModel: str(row.deviceModel),
      ip: str(row.requestIp),
      userAgent: str(row.userAgent),
      createdAt: str(row.createdAt),
      updatedAt: str(row.updatedAt),
    }));
    const serverTotal = include_devices && devices.ok ? declaredTotal(devicesBody) : null;

    const totalDevices = optionalNumber(counts.totalHwidDevices);
    if (stats.ok && totalDevices === 0) {
      warnings.push(
        warn(
          'hwid_not_recorded',
          'The panel records zero hwid devices in total. Before reading that as "nobody has ' +
            'bound a device", check that hwid tracking is switched on at all — with it off the ' +
            'apps never send a device id, the table stays empty however many clients connect, ' +
            'and every per-client device count is zero for the same reason.',
        ),
      );
    }
    if (serverTotal !== null && serverTotal > offset + data.length) {
      warnings.push(
        warn(
          'truncated',
          `The device window holds ${String(data.length)} of ${String(serverTotal)} rows (limit ` +
            `${String(cap)}, offset ${String(offset)}). Anything counted from this slice is ` +
            'about the slice — use `stats` and `topUsers` for fleet numbers, they come from the ' +
            'panel and are exact.',
        ),
      );
    }
    if (include_devices && devices.ok && serverTotal === null) {
      warnings.push(
        warn(
          'server_count_absent',
          'The panel did not return a `total` for the device list, so whether this window is the ' +
            'whole set cannot be checked here. Do not treat its length as the device count.',
        ),
      );
    }
    if (topUsers.length > topCap) {
      warnings.push(
        warn(
          'top_list_truncated',
          `topUsers was cut to ${String(topCap)} rows of ${String(topUsers.length)}. A client ` +
            'missing from the list below is not one without devices.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). A missing aggregate is unknown, ' +
            'not zero — and a zero device count that came from a failed call is the exact shape ' +
            'of an investigation that clears a client who should not have been cleared.',
        ),
      );
    }

    return {
      stats: stats.ok
        ? {
            totalHwidDevices: totalDevices,
            totalUniqueDevices: optionalNumber(counts.totalUniqueDevices),
            averageHwidDevicesPerUser: optionalNumber(counts.averageHwidDevicesPerUser),
            usersWithDevices,
            byPlatform,
          }
        : null,
      topUsers: topUsers.slice(0, topCap),
      devices: include_devices
        ? { items: serverTotal, limit: cap, offset, returned: data.length, data }
        : null,
      warnings,
      degraded,
    };
  },
});

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
