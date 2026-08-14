import { OWNERSHIP_PAGE, assertOwnsService } from '../billing/ownership.js';
import type { ToolContext } from '@hq/types';

/**
 * ПОЧЕМУ ПРОВЕРКА ВЛАДЕНИЯ — НЕ ФОРМАЛЬНОСТЬ.
 *
 * Все действующие маршруты услуги (`/admin/user/service/{stop,activate,touch,
 * change,status}`, `POST` и `DELETE /admin/user/service`) объявлены с
 * `required => ['user_id','user_service_id']`, и по этому объявлению кажется,
 * что бэкенд сверяет пару. Он её не сверяет. Диспетчер зовёт
 * `$service->id( get_service_id($service, %args) )`, а `get_service_id`
 * (app/public_html/shm/v1.cgi:1900-1917) берёт РОВНО `user_service_id` — ключ
 * таблицы. Дальше `Core::Sql::Data::get` (Data.pm:837-862) строит `where` из
 * одного ключа и дописывает владельца ТОЛЬКО при флаге
 * `structure->{user_id}{key_mul}`, которого у `Core::USObject` нет
 * (USObject.pm:26-31). Скоупинг из `clean_query_args` (Data.pm:1058-1060) сюда
 * не доезжает вовсе: он живёт в `list`, а `get` зовёт `_list` напрямую —
 * комментарий в исходнике объясняет это прямо («do not use list() because of
 * list might contain default selectors»).
 *
 * Итог: `POST /admin/user/service/stop {user_id: 3073, user_service_id: 55}`
 * остановит услугу 55 независимо от того, чья она. `user_id` в теле —
 * декоративный, и единственная проверка владения, которая существует, — эта.
 *
 * Размер страницы запасного пути — тот же и оттуда же, что у канонической
 * проверки: два числа под одним именем разъезжаются молча.
 */
export { OWNERSHIP_PAGE };

export interface OwnedService {
  user_service_id: number;
  /** Владелец строки. Ради него всё и затевается. */
  user_id: number | null;
  service_id: number | null;
  status: string | null;
  name: string | null;
  expire: string | null;
  /** id тарифа, на который услуга переключится по истечении периода. -1 — удаление. */
  next: number | null;
  auto_bill: number | null;
  cost: number | null;
}

export interface ServicesPage {
  services: OwnedService[];
  /**
   * `FOUND_ROWS()` всей выборки, а не длина страницы (§6.4). Разница и есть
   * ответ на вопрос «услуги нет» против «услуга не попала в окно».
   */
  items: number;
  /** Страница покрыла весь список. */
  covered: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Строка услуги из `UserService::list_for_api`.
 *
 * Форма отличается между версиями SHM, и это не мелочь: в исходнике 2.x поля
 * тарифа склеены в `JSON_OBJECT(...) AS service` (USObject.pm:122-137), а
 * работающая 2.19.4 отдаёт их и плоско (`name`, `cost`, `expire` рядом с
 * `user_service_id`), и вложенно под ключом `services`. Читаются все три
 * варианта: инструмент, знающий одну форму, на другой версии молча получает
 * `null` вместо статуса и тарифа — то есть перестаёт видеть предусловия, ради
 * которых он эту строку и читает.
 *
 * Числа приходят строками (`cost: "300.00"`, `auto_bill: "1"`) — приведение
 * обязательно, сравнение по сырому значению здесь врёт.
 */
function toOwned(row: Record<string, unknown>): OwnedService | null {
  const id = num(row.user_service_id);
  if (id === null) return null;
  const nested = { ...asRecord(row.service), ...asRecord(row.services) };
  return {
    user_service_id: id,
    user_id: num(row.user_id),
    service_id: num(row.service_id),
    status: str(row.status),
    name: str(row.name) ?? str(nested.name),
    expire: str(row.expire),
    next: num(row.next),
    auto_bill: num(row.auto_bill),
    cost: num(row.cost) ?? num(nested.cost),
  };
}

/**
 * Страница услуг клиента вместе с честным `items`.
 *
 * Нужна там, где интересен ВЕСЬ список, а не одна строка: водяной знак заказа
 * (у `give` нет «объекта до», сверять при применении нечего) и справка о том,
 * что у клиента ещё работает.
 *
 * Из этого списка НЕ следует «такой услуги у клиента нет»: `USObject::_list`
 * дописывает `status != REMOVED`, когда в условии нет ключа таблицы
 * (USObject.pm:110-121), поэтому исчерпанная страница ничего не доказывает.
 */
export async function readServicesPage(ctx: ToolContext, userId: number): Promise<ServicesPage> {
  const page = await ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
    user_id: userId,
    limit: OWNERSHIP_PAGE,
  });
  const services = page.data
    .map((row) => toOwned(asRecord(row)))
    .filter((row): row is OwnedService => row !== null);
  return { services, items: page.items, covered: page.items <= page.data.length };
}

/**
 * Услуга принадлежит клиенту — В НОРМАЛИЗОВАННОЙ форме, нужной жизненному
 * циклу (`status`, `next`, `expire`, `cost` приведены к типам, а не оставлены
 * строками настоящей SHM).
 *
 * ПРОВЕРКА ЗДЕСЬ БОЛЬШЕ НЕ ЖИВЁТ. Она одна на пакет и лежит в
 * `../billing/ownership.js`: точечный запрос по `user_service_id`,
 * положительное доказательство владельца, запасной путь на страницу клиента
 * для сборок без server-side filter и «подтвердить не удалось» вместо «услуга
 * чужая». Раньше здесь стояла вторая копия того же алгоритма под другим именем
 * — сознательно, пока обе задачи шли параллельно и один экспорт не мог
 * дождаться другого. Две копии одной проверки владения — это ровно тот случай,
 * где одна однажды перестаёт действовать молча, поэтому осталась одна, а тут —
 * приведение её результата к типам.
 *
 * ЕДИНСТВЕННОЕ РАСХОЖДЕНИЕ С ПРЕЖНИМ ПОВЕДЕНИЕМ: когда фильтр СРАБОТАЛ и
 * вернул ноль строк (`items === 0`), канонический хелпер говорит «такой услуги
 * в SHM нет», а не «подтвердить не удалось». Это утверждение сильнее, и оно
 * верное: `status != REMOVED` USObject дописывает только тогда, когда ключа
 * таблицы нет в условии (USObject.pm:110-121), — а здесь он в условии и есть,
 * то есть снятая услуга по такому фильтру вернулась бы.
 */
export async function assertServiceOwner(
  ctx: ToolContext,
  userId: number,
  userServiceId: number,
  tool: string,
): Promise<OwnedService> {
  const row = await assertOwnsService(ctx, userId, userServiceId, tool);
  const parsed = toOwned(asRecord(row));
  if (parsed === null) {
    throw new Error(
      `${tool}: SHM вернул строку услуги user_service_id=${userServiceId} без числового ` +
        'user_service_id — разобрать её нечем. Проверьте id через service_inspect.',
    );
  }
  return parsed;
}
