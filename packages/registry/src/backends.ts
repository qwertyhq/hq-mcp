import { BACKENDS } from '@hq/types';
import type { Backend } from '@hq/types';

/**
 * КАКОЙ СИСТЕМЕ ПРИНАДЛЕЖИТ ОБЪЯВЛЕННЫЙ ЭНДПОИНТ.
 *
 * Мутаторы объявляют свою поверхность списком `METHOD /path` (`MutationSpec.endpoints`),
 * и этот список уже служит источником истины для двух проверок каркаса —
 * запрещённых операций (§8) и денежных ручек. Отсюда же берётся и третий ответ:
 * к какой из двух систем инструмент вообще ходит. Второй список, набранный
 * руками рядом с первым, разошёлся бы с ним на первой же добавленной ручке — и
 * разошёлся бы молча, потому что несовпадение видно только в том развёртывании,
 * где второй системы нет.
 *
 * Разделение по префиксу пути, а не по угадыванию: у Remnawave ВСЕ маршруты
 * лежат под `/api/`, у SHM — под `/admin/`, `/user/`, `/template/`, `/promo/` и
 * `/healthcheck` (базовый адрес SHM уже несёт `/shm/v1`). Незнакомый префикс —
 * это ОТКАЗ ПРИ СБОРКЕ, а не догадка в пользу одной из систем: догадка здесь
 * означала бы инструмент, показанный в развёртывании, где его бэкенда нет, и
 * узнали бы об этом по ошибке на живом вызове.
 */
const REMNA_PREFIX = '/api/';
const SHM_PREFIXES: readonly string[] = ['/admin/', '/user/', '/template/', '/promo/', '/healthcheck'];

export function backendOfPath(path: string): Backend {
  if (path.startsWith(REMNA_PREFIX)) return 'remna';
  if (SHM_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) return 'shm';
  throw new Error(
    `cannot tell which backend "${path}" belongs to: Remnawave routes start with ` +
      `"${REMNA_PREFIX}" and SHM routes with ${SHM_PREFIXES.map((one) => `"${one}"`).join(', ')}. ` +
      'Add the new prefix to backendOfPath — guessing here would publish a tool on a ' +
      'deployment that does not run its backend, and the mistake would only surface as a ' +
      'failed live call.',
  );
}

/**
 * Набор систем, к которым ходит объявленная поверхность. Порядок — канонический
 * (`BACKENDS`), а не порядок появления: список бэкендов уезжает в сравнения
 * тестов и в ответ `platform_probe`, и «тот же набор, другой порядок» там
 * читался бы как расхождение.
 */
export function backendsOfEndpoints(endpoints: readonly string[]): readonly Backend[] {
  const seen = new Set<Backend>();
  for (const endpoint of endpoints) {
    const space = endpoint.indexOf(' ');
    seen.add(backendOfPath(space === -1 ? endpoint : endpoint.slice(space + 1)));
  }
  return BACKENDS.filter((backend) => seen.has(backend));
}
