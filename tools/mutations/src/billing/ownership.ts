import { asRecord, toNumber } from './money.js';
import type { ToolContext } from '@hq/types';

/**
 * Страница услуг клиента для запасного пути. 200, а не 25: чем больше страница,
 * тем реже запасной путь заканчивается «подтвердить не удалось».
 */
export const OWNERSHIP_PAGE = 200;

const SERVICE_PATH = '/admin/user/service';

/** Списание, которым SHM оплатил ТЕКУЩИЙ период услуги (`withdraw_history`). */
export interface OwnedWithdraw {
  withdraw_id?: unknown;
  service_id?: unknown;
  /** Деньги, снятые за период: `$wd{total} -= $wd{bonus}` (Billing.pm:229). */
  total?: unknown;
  /** Бонусная часть того же периода. Деньгами она не возвращается. */
  bonus?: unknown;
  cost?: unknown;
  months?: unknown;
  create_date?: unknown;
  end_date?: unknown;
  withdraw_date?: unknown;
}

export interface OwnedService {
  user_service_id: number;
  user_id?: unknown;
  service_id?: unknown;
  status?: unknown;
  name?: unknown;
  expire?: unknown;
  next?: unknown;
  withdraw_id?: unknown;
  /** SHM подмешивает списание прямо в строку услуги (UserService::with). */
  withdraws?: OwnedWithdraw;
}

function ownershipRefusal(tool: string, userServiceId: number, userId: number, owner: unknown): Error {
  return new Error(
    `${tool}: услуга user_service_id=${userServiceId} принадлежит клиенту user_id=${String(owner)}, ` +
      `а не ${userId}. Деньги и услуги разных клиентов не пересекаются: проверьте id услуги ` +
      'инструментом client_services.',
  );
}

/**
 * «Услуга принадлежит клиенту» — с положительным доказательством, а не с
 * выводом из отсутствия.
 *
 * ОСНОВНОЙ ПУТЬ: спрашиваем ОДНУ строку по `user_service_id` и читаем в ней
 * `user_id`. Это доказательство в обе стороны: совпал — своя, не совпал — точно
 * чужая, строки нет вовсе — услуги нет.
 *
 * Так, а не «прочитали страницу услуг клиента и не нашли», потому что страница
 * не видит трёх классов услуг сразу, и два из них — на стороне SHM, а не в
 * пагинации:
 *   1. `limit` по умолчанию 25, а `items` — полный FOUND_ROWS (§6.4);
 *   2. `UserService::list_for_api` (UserService.pm:437-441) добавляет
 *      `parent IS NULL` — дочерние услуги composite-тарифа не показываются;
 *   3. там же `status != REMOVED` — снятая услуга не показывается.
 * Оба умолчания отключаются только тем, что в `where` попал сам
 * `user_service_id`, — то есть ровно основным путём. Поэтому исчерпанная
 * страница НЕ доказывает, что услуга чужая, и запасной путь такого не говорит
 * никогда: он либо подтверждает принадлежность, либо честно отказывается её
 * подтвердить.
 *
 * ЗАПАСНОЙ ПУТЬ нужен для сборки SHM, где server-side filter не сужает выборку
 * (возможность `shm.filter`): тогда фильтр вернёт голову таблицы, нужной строки
 * в ней не будет, и единственное, что остаётся, — страница услуг клиента.
 * Вызывающий обязан к этому моменту УЖЕ убедиться, что клиент существует
 * (`readClientMoney`): `?user_id=` несуществующего клиента ломает роутер SHM.
 */
export async function assertOwnsService(
  ctx: ToolContext,
  userId: number,
  userServiceId: number,
  tool: string,
): Promise<OwnedService> {
  const exact = await ctx.shm.list<OwnedService>(SERVICE_PATH, {
    filter: JSON.stringify({ user_service_id: userServiceId }),
    limit: 2,
  });
  const found = exact.data.find((row) => toNumber(row.user_service_id) === userServiceId);

  if (found !== undefined) {
    const owner = asRecord(found).user_id;
    if (owner !== undefined && toNumber(owner) === userId) return found;
    if (owner !== undefined) throw ownershipRefusal(tool, userServiceId, userId, owner);
  } else if (exact.data.length === 0 && exact.items === 0) {
    throw new Error(
      `${tool}: услуги user_service_id=${userServiceId} нет в SHM (спрошено фильтром по самому ` +
        'id, а не страницей услуг клиента). Найдите её id инструментом client_services.',
    );
  }

  // Сюда попадаем, только если фильтр не сузил выборку или в строке не оказалось
  // user_id: доказать принадлежность точечным чтением не вышло.
  const page = await ctx.shm.list<OwnedService>(SERVICE_PATH, {
    user_id: userId,
    limit: OWNERSHIP_PAGE,
  });
  const mine = page.data.find((row) => toNumber(row.user_service_id) === userServiceId);
  if (mine !== undefined) return mine;

  throw new Error(
    `${tool}: подтвердить принадлежность услуги user_service_id=${userServiceId} клиенту ` +
      `user_id=${userId} не удалось. Точечный запрос по id не сузился (server-side filter на этой ` +
      `сборке SHM не работает), а страница услуг клиента вернула ${page.data.length} из ` +
      `${page.items} и по построению не показывает ни дочерние услуги composite-тарифов ` +
      '(parent IS NULL), ни снятые (status != REMOVED). Это НЕ значит, что услуга чужая — ' +
      'уточните её id инструментом client_services и повторите вызов.',
  );
}
