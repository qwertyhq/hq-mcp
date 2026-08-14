import { defineTool } from '@hq/registry';
import { redact } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { asArray, asRecord, capLimit, envelope, num, settle, str, take, warn } from '../kit.js';

const MAX_LIMIT = 100;

/** Штампы Remnawave — полный ISO с `Z` (§6.17), в отличие от «голых» дат SHM. */
function millis(value: unknown): number {
  const text = str(value);
  if (text === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export const subscriptionInspect = defineTool({
  name: 'subscription_inspect',
  description:
    'Remnawave card of one user: status, expiry, normalised traffic, squads, HWID devices and ' +
    'the most recent subscription requests. Connection credentials and the raw subscription ' +
    'link are never part of the answer. An id the panel does not know answers found=false ' +
    'rather than a card of zeroes. The traffic here is the two RUNNING COUNTERS the card ' +
    'carries — used since the last reset and used lifetime — with no time axis at all; for ' +
    '"where and when did the bytes go" (per day, per node, per squad, over a window) call ' +
    'traffic_stats instead. The two are different measurements and will not reconcile: on a ' +
    'live subscriber the lifetime counter read 15 048 GB against 268 GB over the last eight ' +
    'days, so do not subtract one from the other. An empty request history is NOT proof that ' +
    'the client never connected: recording it is a panel-wide setting, and when it is off the ' +
    'route still answers 200 with an empty list. Run platform_probe — capability ' +
    '`remna.subscriptionRequestHistory` is the only thing that tells the two apart, and this ' +
    'tool repeats its verdict in `requests.recordedByPanel`.',
  input: z.object({
    user_id: z
      .number()
      .int()
      .positive()
      .describe('Remnawave numeric user id (`id`) from client_resolve — 3.x has no user uuid'),
    limit: z
      .number()
      .int()
      .default(20)
      .describe('Most recent subscription requests to return, capped at 100'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ user_id, limit }, ctx) => {
    const cap = capLimit(limit, 20, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    /**
     * Вердикт platform_probe о том, ведёт ли панель журнал обращений вообще.
     * `'unknown'`, если пробу не гоняли (хранилище пусто в обычной сессии) —
     * и это ЧЕСТНОЕ значение: отсутствие пробы не даёт права утверждать ни
     * «пишет», ни «не пишет».
     */
    const srhRecorded: boolean | 'unknown' =
      ctx.probe.get()?.capabilities['remna.subscriptionRequestHistory'] ?? 'unknown';
    // Remnawave 3.x адресует пользователя ЧИСЛОМ: поля uuid у объекта нет
    // вовсе, а параметр пути объявлен как `userId: number`. Zod уже сузил
    // вход до положительного целого, поэтому в путь оно уходит как есть.
    const id = String(user_id);

    const [user, devices, history] = await Promise.all([
      settle(ctx.remna.get<unknown>(`/api/users/${id}`)),
      settle(ctx.remna.get<unknown>(`/api/hwid/devices/${id}`)),
      settle(ctx.remna.get<unknown>(`/api/users/${id}/subscription-request-history`)),
    ]);

    // Сырое значение проверяется ДО asRecord: @hq/remna осознанно отдаёт null
    // (а не бросает) на ПРИКЛАДНОЙ 404 у /api/users/{id}, поэтому settle
    // успешен и degraded пуст. asRecord(null) — это {}, и протухший id без
    // этой проверки выглядел бы как живой абонент с нулевым трафиком, который
    // просто ни разу не подключался.
    //
    // Признаком существования служит `id`, а НЕ `uuid`: последнего в ответе
    // 3.x нет ни у одного пользователя, поэтому проверка по нему давала
    // found=false всегда — на каждого живого абонента.
    const raw = take(user, 'remna', degraded, null);
    const safe = asRecord(redact(asRecord(raw), ctx.profile));
    const foundId = num(safe.id, Number.NaN);
    const found = user.ok && Number.isFinite(foundId) && foundId > 0;

    // Трафик и онлайн живут ТОЛЬКО во вложенном userTraffic (§6.17), а байты
    // приезжают то строкой, то числом.
    const traffic = asRecord(safe.userTraffic);
    const hwidLimit = num(safe.hwidDeviceLimit, Number.NaN);

    const deviceBox = envelope(take(devices, 'remna', degraded, null), 'devices');
    const historyBox = envelope(take(history, 'remna', degraded, null), 'records');

    // Одна запись на КАЖДЫЙ забор подписки, а клиенты опрашивают её
    // непрерывно: у долгоживущего клиента это тысячи строк, и ручка не
    // принимает ни size, ни start — сузить можно только здесь. Свежие сверху,
    // иначе «последние запросы» означали бы «первые, что вернула панель».
    const requests = [...historyBox.rows]
      .sort((a, b) => millis(b.requestAt ?? b.createdAt) - millis(a.requestAt ?? a.createdAt))
      .slice(0, cap);
    if (historyBox.total > requests.length) {
      warnings.push(
        warn(
          'truncated',
          `Returned ${String(requests.length)} of ${String(historyBox.total)} subscription ` +
            'requests, newest first. "The client last connected at ..." is about this slice; ' +
            'raise limit before concluding anything about older activity.',
        ),
      );
    }

    if (!user.ok) {
      // `found: false` здесь означает «не ответили», а не «в панели нет».
      // Второе — утверждение, и делать его по неудавшемуся запросу нельзя:
      // ровно так support-бот пять минут отрицал живого клиента.
      warnings.push(
        warn(
          'card_unavailable',
          'The user card call failed (see `degraded`), so found=false means the panel was not ' +
            'reached — not that the subscriber is gone. Retry before telling anyone their ' +
            'account no longer exists.',
        ),
      );
    }
    if (user.ok && !found) {
      warnings.push(
        warn(
          'user_not_found',
          `Remnawave has no user with id ${String(user_id)}. The panel answers a missing user ` +
            'with an application 404 (errorCode A063) on this route and the client turns that ' +
            'into an absence, not an error — so this is the panel speaking, not a failed ' +
            'request. Re-resolve the client with client_resolve: the numeric id changes when ' +
            'the panel user is recreated.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the panel calls did not answer (see `degraded`); the part it owns — the card, ' +
            'the devices or the request history — is empty rather than wrong. An empty device ' +
            'list here is not evidence that the client has no devices.',
        ),
      );
    }
    /**
     * «Клиент ни разу не подключался» и «панель этого не пишет» дают ОДИН И ТОТ
     * ЖЕ ответ ручки: 200 и пустой список. Отличить их можно только по
     * настройке самой панели (`SERVICE_DISABLE_SRH_RECORDS`), которую читает
     * platform_probe. Здесь она и озвучивается — но только при пустой истории:
     * на непустой вопроса не возникает, и предупреждение было бы шумом.
     */
    if (history.ok && requests.length === 0 && srhRecorded === false) {
      warnings.push(
        warn(
          'subscription_history_not_recorded',
          'This panel has subscription-request recording switched off, so the empty history ' +
            'above says nothing about this client. Do not read it as "never connected" — check ' +
            'the traffic counters and onlineAt instead, and expect the same emptiness for every ' +
            'user on this deployment.',
        ),
      );
    }

    return {
      found,
      user: found
        ? {
            id: foundId,
            username: str(safe.username),
            status: str(safe.status),
            expireAt: str(safe.expireAt),
            tag: str(safe.tag),
            telegramId: (() => {
              const parsed = num(safe.telegramId, Number.NaN);
              return Number.isFinite(parsed) ? parsed : null;
            })(),
            traffic: {
              usedBytes: num(traffic.usedTrafficBytes),
              lifetimeBytes: num(traffic.lifetimeUsedTrafficBytes),
              limitBytes: num(safe.trafficLimitBytes),
            },
            onlineAt: str(traffic.onlineAt),
            firstConnectedAt: str(traffic.firstConnectedAt),
            squads: asArray(safe.activeInternalSquads)
              .map((squad) => str(asRecord(squad).name))
              .filter((name): name is string => name !== null),
          }
        : null,
      devices: {
        // `checked: false` — ручка не ответила, и `total: 0` тогда ничего не
        // утверждает. Проза в partial_result этого не заменяет: вызывающий
        // читает число, а «устройств нет» и «мы не спросили» — разные ответы,
        // и на первом строят «сбросьте лишние устройства».
        checked: devices.ok,
        // hwidDeviceLimit === 0 означает «лимита нет», а не «ноль устройств»
        // (wbap/src/lib/api/hwidDevices.ts:80-81 приводит <= 0 к null). Как
        // есть это читалось бы как «три устройства при лимите ноль».
        limit: Number.isFinite(hwidLimit) && hwidLimit > 0 ? hwidLimit : null,
        total: deviceBox.total,
        items: deviceBox.rows.map((device) => ({
          hwid: str(device.hwid),
          platform: str(device.platform),
          deviceModel: str(device.deviceModel),
          createdAt: str(device.createdAt),
        })),
      },
      requests: {
        checked: history.ok,
        /**
         * Пишет ли панель эту историю ВООБЩЕ. Отдельно от `checked` (мы
         * спросили) и от `total` (сколько нашлось): без этого поля пустой
         * список — это два разных факта под одним видом, и выбор между ними
         * делал бы читающий, у которого данных для выбора нет.
         * `'unknown'` — platform_probe в этой сессии не запускали.
         */
        recordedByPanel: srhRecorded,
        total: historyBox.total,
        limit: cap,
        items: requests.map((row) => ({
          at: str(row.requestAt ?? row.createdAt),
          // User-Agent — клиентский ввод и PII: профилю bot он не уезжает
          // вовсе, а не уезжает маркером редакции.
          userAgent: ctx.profile === 'bot' ? null : str(row.userAgent),
        })),
      },
      warnings,
      degraded,
    };
  },
});
