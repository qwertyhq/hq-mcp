import { defineTool } from '@hq/registry';
import { redact } from '@hq/redact';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asRecord,
  capLimit,
  envelope,
  listOut,
  lookupAccountsFor,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';
import type { IdentitySchema, ShmAccount } from '../kit.js';
import { applyAccounts, normalizeShmUser } from './resolve.js';
import type { ShmUserMatch } from './resolve.js';

const MAX_LIMIT = 100;

export const clientOverview = defineTool({
  name: 'client_overview',
  description:
    'Client 360 in one call: SHM profile, services, payments and withdraws plus the Remnawave ' +
    'card and its devices. Both systems are read in parallel and a failure of one degrades the ' +
    'answer instead of killing it. Connection credentials are never returned.',
  input: z.object({
    shm_user_id: z.number().int().positive().describe('SHM user_id from client_resolve'),
    remna_user_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe(
        'Remnawave numeric user id (`id`) from client_resolve; null skips the panel half. ' +
          '3.x has no user uuid — the panel addresses users by this number.',
      ),
    limit: z.number().int().default(20).describe('Rows per money list, capped at 100'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  // Панель НЕ обязательна: без неё это по-прежнему полный ответ про
  // биллинг, а про недостающую половину сказано вслух — `remna_absent`
  // вместо `card_unavailable`, то есть «её здесь нет», а не «не ответила».
  backends: ['shm'],
  handler: async ({ shm_user_id, remna_user_id, limit }, ctx) => {
    const cap = capLimit(limit, 20, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    /**
     * Спрашивать ли панель вообще. Два РАЗНЫХ основания не спрашивать, и оба
     * должны привести к `remna: null`, но НЕ к записи в `degraded`: там живут
     * системы, которые не ответили, а здесь ни одна не спрашивалась. Запись в
     * `degraded` подняла бы `partial_result` — «одна из систем не ответила», —
     * и ответ, полный по построению, читался бы как урезанный.
     */
    const panelWanted = ctx.backends.remna && remna_user_id !== null;

    const [user, services, payments, withdraws, remnaUser, devices, identity] = await Promise.all([
      settle(ctx.shm.list<Record<string, unknown>>('/admin/user', { user_id: shm_user_id, limit: 1 })),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
          user_id: shm_user_id,
          limit: cap,
        }),
      ),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/pay', {
          user_id: shm_user_id,
          limit: cap,
        }),
      ),
      settle(
        ctx.shm.list<Record<string, unknown>>('/admin/user/service/withdraw', {
          user_id: shm_user_id,
          limit: cap,
        }),
      ),
      panelWanted
        ? settle(ctx.remna.get<unknown>(`/api/users/${String(remna_user_id ?? 0)}`))
        : Promise.resolve<{ ok: true; value: unknown }>({ ok: true, value: null }),
      panelWanted
        ? settle(ctx.remna.get<unknown>(`/api/hwid/devices/${String(remna_user_id ?? 0)}`))
        : Promise.resolve<{ ok: true; value: unknown }>({ ok: true, value: [] }),
      /**
       * ГДЕ У ЭТОЙ SHM ЛЕЖАТ ПОЧТА И ТЕЛЕФОН КЛИЕНТА — вопрос к самой SHM, и
       * задаётся он здесь же, в общем пучке, а не после.
       *
       * С 3.0 адрес и номер переехали в таблицу `accounts`, а `users.login2`
       * осталась в базе физически, со значениями, записанными ДО переезда.
       * `/admin/user` отдаёт её как обычную колонку (`fields => '*'`,
       * Sql/Data.pm:906), поэтому карточка клиента без этого запроса печатала
       * бы довоенный адрес — а на телеграм-регистрации и вовсе хендл вида
       * `@<id>` — как действующую почту. Один запрос на клиента; на установке
       * до 3.0 он отвечает роутерным 404, и это записывается как `legacy` без
       * degraded.
       */
      settle(lookupAccountsFor(ctx, { user_id: shm_user_id })),
    ]);

    // ВСЕ take() — ДО подсчёта предупреждений. Если посчитать degraded раньше,
    // падение трёх списков SHM не попадёт в partial_result: они разворачиваются
    // позже, и ответ окажется частичным без единого слова об этом.
    const userRow = take(user, 'shm', degraded, EMPTY_LIST).data[0];

    let identitySchema: IdentitySchema = 'unknown';
    let accountRows: ShmAccount[] = [];
    if (identity.ok) {
      identitySchema = identity.value.schema;
      accountRows = identity.value.accounts;
      // Отказ, который НЕ роутерный 404: схему установить не удалось, и почта
      // ниже — то, что нашлось в строке, а не то, что есть у клиента.
      if (identity.value.error !== null) degraded.push({ system: 'shm', error: identity.value.error });
    } else {
      degraded.push({ system: 'shm', error: identity.error });
    }

    const rawProfile: ShmUserMatch | null =
      userRow === undefined ? null : normalizeShmUser(asRecord(userRow), identitySchema);
    const profile: ShmUserMatch | null =
      rawProfile !== null && identitySchema === 'accounts'
        ? applyAccounts(rawProfile, accountRows)
        : rawProfile;

    // items выносится наружу по §6.4: без него «платежей нет» и «услуг нет»
    // неотличимы от «окно в 20 строк закончилось».
    const serviceList = listOut(take(services, 'shm', degraded, EMPTY_LIST), warnings, 'services');
    const paymentList = listOut(take(payments, 'shm', degraded, EMPTY_LIST), warnings, 'payments');
    const withdrawList = listOut(take(withdraws, 'shm', degraded, EMPTY_LIST), warnings, 'withdraws');

    const rawRemnaUser = take(remnaUser, 'remna', degraded, null);
    // take() ровно один раз на источник: повторный вызов записал бы вторую
    // запись в degraded для одной и той же неудачи.
    // envelope() из kit — то же правило счёта, что и у subscription_inspect:
    // `total` берётся из конверта, а не из длины отданного куска.
    const deviceBox = envelope(take(devices, 'remna', degraded, null), 'devices');

    // Панель ВСЕГДА отдаёт trojanPassword/ssPassword/vlessUuid — режем явно,
    // не полагаясь на редакцию транспортного слоя.
    const safeRemnaUser =
      rawRemnaUser === null ? null : redact(asRecord(rawRemnaUser), ctx.profile);

    if (!ctx.backends.remna) {
      // ПЕРВЫМ, и это важнее порядка чтения. Ниже стоят две ветки про панель,
      // которые обе неверны в установке без панели: `remna_not_requested`
      // послал бы за remna_user_id, которого здесь взять негде, а
      // `card_unavailable` — повторять запрос, которого не было. «Панели тут
      // нет» — конечный ответ, а не совет.
      warnings.push(
        warn(
          'remna_absent',
          'This deployment has no Remnawave panel configured, so `remna` is null because there ' +
            'is no panel here — not because the subscriber is gone and not because a request ' +
            'failed. Everything under `shm` is the complete billing answer. Do not conclude ' +
            'anything about whether the client can connect: nothing was asked.',
        ),
      );
    } else if (remna_user_id === null) {
      warnings.push(
        warn(
          'remna_not_requested',
          'No remna_user_id was given, so the panel side is empty. Run client_resolve first — ' +
            'the billing status alone does not prove the client can connect.',
        ),
      );
    }
    // Два РАЗНЫХ способа не получить карточку, и путать их нельзя — то же
    // различение, что у соседа (subscription/inspect.ts:113-137). Прикладной
    // 404 клиент отдаёт как null, а не как ошибку (§6.16), поэтому вызов
    // успешен, degraded пуст, и без второй ветки «в панели такого нет»
    // выглядело бы точно как «панель ответила: ноль трафика».
    if (panelWanted && !remnaUser.ok) {
      warnings.push(
        warn(
          'card_unavailable',
          'The panel user card did not answer (see `degraded`), so `remna.user` is null because ' +
            'the panel was not reached — not because the subscriber is gone — and `remna.traffic` ' +
            'is null rather than zero. Retry before telling anyone their account no longer exists.',
        ),
      );
    } else if (panelWanted && safeRemnaUser === null) {
      warnings.push(
        warn(
          'user_not_found',
          `Remnawave has no user with id ${String(remna_user_id)}: the panel answered an ` +
            'application 404 (errorCode A063) and the client turns that into an absence, not an ' +
            'error — so this is the panel speaking, not a failed request. `remna.traffic` is null ' +
            'rather than zero for the same reason. Re-resolve the client with client_resolve: ' +
            'the numeric id changes when the panel user is recreated.',
        ),
      );
    }
    // Считается ПОСЛЕ всех take() выше (шести, включая оба remna) — иначе
    // деградация части списков, разворачиваемых позже по файлу, осталась бы
    // немаркированной, и вызывающий принял бы частичный ответ за полный.
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'One of the systems did not answer; the fields it owns are empty rather than wrong. ' +
            'See `degraded` before drawing conclusions.',
        ),
      );
    }

    return {
      shm: {
        /**
         * Где эта SHM держит почту и телефон клиента: `accounts` — в отдельной
         * таблице (3.0+), `legacy` — в его строке, `unknown` — спросить не
         * удалось. Нужно снаружи потому, что от этого зависит, чем является
         * `user.email === null`: фактом или непрочитанным полем.
         */
        identitySchema,
        user: profile,
        services: serviceList,
        payments: paymentList,
        withdraws: withdrawList,
      },
      remna:
        !panelWanted
          ? null
          : {
              user: safeRemnaUser,
              devices: {
                // `checked: false` — ручка не ответила, и `total: 0` тогда
                // ничего не утверждает. Без этого признака неудавшийся вызов
                // отвечал «0 устройств» тем же числом, каким отвечает клиент
                // без единого устройства, и на первом строят «сбросьте лишние».
                checked: devices.ok,
                total: deviceBox.total,
                items: deviceBox.rows.map((device) => ({
                  hwid: str(device.hwid),
                  platform: str(device.platform),
                  deviceModel: str(device.deviceModel),
                  createdAt: str(device.createdAt),
                })),
              },
              // null, а не нули: числа трафика живут В КАРТОЧКЕ, и без неё
              // `usedBytes: 0 / limitBytes: 0` — это не «трафика нет», а «мы
              // не спросили» или «такого пользователя нет», написанное языком,
              // на котором вызывающий читает первое. Условие — по наличию
              // карточки, а не по успеху вызова: прикладной 404 успешен.
              traffic:
                safeRemnaUser === null
                  ? null
                  : {
                      usedBytes: num(
                        asRecord(asRecord(safeRemnaUser).userTraffic).usedTrafficBytes,
                      ),
                      limitBytes: num(asRecord(safeRemnaUser).trafficLimitBytes),
                    },
            },
      warnings,
      degraded,
    };
  },
});
