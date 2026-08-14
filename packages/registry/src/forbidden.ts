const IDENTITY_REASON =
  'Reading a node identity or keygen material means a private SSH key / enrollment material ' +
  'travels in a GET response body. There is no read-only version of that.';

const TOKEN_REASON =
  'The panel returns API tokens in plaintext, creating one grants a permanent admin outside ' +
  'every gate, and deleting one breaks SHM provisioning. Passkey and auth routes are a ' +
  'persistence mechanism, not an operation.';

/**
 * ПРАВИЛО СУЖАЛОСЬ ДВАЖДЫ, И ОБА РАЗА ЭТО БЫЛО ИСПРАВЛЕНИЕ, А НЕ ПОСЛАБЛЕНИЕ.
 *
 * Первое сужение. Правило стояло без `methods`, то есть резало и GET, — а его
 * собственное обоснование всё это время говорило про ЗАПИСЬ: «нет гита, нет
 * отката, одна плохая правка роняет вебхуки». Ни одно из этих слов не про
 * чтение. Цена ширины оказалась не теоретической: в разобранном окне многие
 * уведомления отрендерились пустыми и не отправили НИЧЕГО, при этом задача
 * отчиталась SUCCESS, а причина такого молчания лежит внутри файла шаблона.
 *
 * Второе сужение: из трёх методов записи открыт РОВНО ОДИН — POST,
 * то есть перезапись СУЩЕСТВУЮЩЕГО шаблона, и открыт он не «вообще», а под
 * `template_edit`, который снимает предыдущие байты в локальный снапшот ДО
 * записи и умеет положить их обратно (`restore_from`). Аргумент «нет отката»
 * снят не словами, а механизмом: откат теперь есть, и он часть инструмента.
 *
 * PUT и DELETE остаются закрыты, и это не осторожность по инерции. У
 * появившегося и у исчезнувшего шаблона НЕТ предыдущего состояния — снимать
 * перед записью нечего, и та самая причина «нет гита, нет отката» действует на
 * них в полную силу. Плюс `Core::Template::add` в file-режиме зовёт
 * `make_path(dirname($id))` (app/lib/Core/Template.pm), то есть создание — это
 * ещё и создание каталогов на диске биллинга по имени, пришедшему снаружи.
 */
const TEMPLATE_REASON =
  'CREATING (PUT) and DELETING (DELETE) a template stay forbidden: templates are live billing ' +
  'logic executed by the workers, stored as files with no git and no rollback, and a template ' +
  'that has just appeared — or just vanished — has no previous state to snapshot or to go back ' +
  'to. WRITING OVER an existing one is available, but only through template_edit: it refuses an ' +
  'empty body, snapshots the previous bytes to disk before it writes, and takes that snapshot ' +
  'back through restore_from. READING is open and template_read exists for it — a template that ' +
  'renders empty sends nothing while the task still reports SUCCESS, and that cause is visible ' +
  'nowhere else.';

const CONFIG_REASON =
  'Reading /admin/config wholesale dumps the telegram bot token and every payment-system ' +
  'secret in clear text; writing replaces the value without a merge. Only config_read with ' +
  'its allowlist exists, and it reads exactly one key at /admin/config/{key}.';

const SETTINGS_REASON =
  'Panel-wide settings writes lose access to the panel itself, and the subscription settings ' +
  'block every subscription at the first typo. A backup to restore them from is not a given: ' +
  'the panel pg_dump may not have run in months.';

const BULK_REASON =
  'restart-all takes down the fleet on one typo, reorder changes the default object for every ' +
  'client, and PUT /admin/spool with job_users mails every user in the base with no cancel. None of ' +
  'the three can state in advance how many clients it hits.';

/**
 * ПОЧЕМУ ЭТОТ ЗАПРЕТ СНЯТ С `/api/users/bulk/all`, А НА `delete-by-status` ОСТАЛСЯ.
 *
 * Обоснование запрета было одно на все массовые ручки: «применяются ко всей
 * базе без списка uuid». Оно верно ровно до тех пор, пока никто не считает
 * затронутых. `bulk_ops` их считает — у панели, до применения, и отказывается
 * строить план, если число не установилось; сверх того действует потолок
 * `HQ_MCP_MAX_BULK_USERS` (при дефолте 100 и флоте в 1125 учёток `bulk/all/*`
 * не проходит вовсе, пока границу не подняли руками) и `profiles: ['human']`.
 * То есть закрывался не маршрут, а слепота вызывающего, и она закрыта в другом
 * месте — там, где её можно закрыть по-настоящему.
 *
 * `bulk/delete-by-status` остаётся запрещённой ПО СВОЕЙ ФОРМЕ, а не по
 * радиусу. Её тело — это `{status}`: панель принимает СТАТУС и удаляет всех,
 * кто под него попал НА МОМЕНТ РАБОТЫ ОЧЕРЕДИ (bulkDeleteByStatus уходит в
 * очередь и отвечает 202 без тела). Между планом и применением состав группы
 * меняется сам: клиент истёк — и попал под удаление, которого оператор не
 * видел. Назвать людей поимённо такой вызов не даёт в принципе, поэтому
 * «удалить всех со статусом X» сделано перечислением: план вычитывает
 * КОНКРЕТНЫЕ id с этим статусом, показывает их, и применение удаляет ровно их
 * через `bulk/delete`. Возможность сохранена, беспамятная ручка — нет.
 */
const DELETE_BY_STATUS_REASON =
  'POST /api/users/bulk/delete-by-status takes a status, not a list of people: the queue picks ' +
  'up whoever matches when it runs, which is not who the operator reviewed — accounts that ' +
  'expire in between are deleted unseen, and the panel answers 202 with no body and no count. ' +
  'The capability exists as bulk_ops delete_by_status, which enumerates the exact ids first and ' +
  'deletes that reviewed set through bulk/delete.';

const SUBSCRIPTION_REASON =
  'Subscription endpoints hand out ready-to-use configs — that is account takeover of the ' +
  'subscriber, not diagnostics. subscription_inspect returns the card without the keys.';

const MANUAL_SUCCESS_REASON =
  'Stamping a spool task successful does not execute it: the service goes ACTIVE in billing ' +
  'while the user never appears in the panel. provisioning_repair does retry/resume only.';

/**
 * ЭТИ ДВА ПРАВИЛА ЗАКРЫВАЮТ ОБХОД ПРЕДЫДУЩЕГО, А НЕ ДОБАВЛЯЮТ НОВЫЙ ЗАПРЕТ.
 *
 * Без них запрет на ручную пометку задачи успешной обходится соседним
 * сегментом того же маршрута: `Core::Spool::api_manual_action` собирает имя
 * метода из URL и вызывает его, если `$self->can()` истинно, — а `can` видит и
 * унаследованное. Проверено по исходникам SHM, ссылки поимённо ниже.
 */
const MANUAL_WRITE_REASON =
  'Core::Spool::api_manual_action builds a method name from the URL segment and calls it whenever ' +
  '$self->can() is true (Spool.pm:323-338), which includes api_set and api_add inherited from ' +
  'Core::Base (Base.pm:388, :399). POST /admin/spool/manual/set is therefore an arbitrary write to ' +
  'a spool row — including its status, which is exactly what the /manual/success rule forbids.';

const PAYMENT_DELETE_REASON =
  'Deleting a payment, bonus or withdraw is a plain DELETE FROM the ledger table: ' +
  'users.balance is not recomputed and history drifts from balance permanently. Only ' +
  'billing_refund_service touches money.';

const SQUAD_BULK_REASON =
  'Squad bulk-actions add or remove every matching member of an internal/external squad in ' +
  'one call with no per-user list to review; a bad filter reassigns VPN access for an ' +
  'unknown number of clients at once. bulk_ops update_squads does the same thing from the ' +
  'other end — an explicit list of user ids, counted and shown before it runs.';

const BULK_SCOPE_REASON =
  'Mass operations exist for panel CLIENTS only, as bulk_ops: it establishes the exact number ' +
  'of affected users from the panel before applying, refuses above HQ_MCP_MAX_BULK_USERS, and ' +
  'is never offered to the bot. Mass routes on other entities — hosts, nodes, squads, spool ' +
  'mailings — have no such counting step and stay absent.';

/**
 * Как правило сравнивается с путём:
 * - 'exact'    — путь равен pattern целиком (без query);
 * - 'prefix'   — путь начинается с pattern;
 * - 'contains' — pattern встречается где-то внутри пути (нужен для squad
 *   bulk-actions и reorder, где путь несёт uuid посередине:
 *   /api/internal-squads/{uuid}/bulk-actions/{action}).
 *
 * `methods`, если задан, сужает правило до перечисленных HTTP-методов: путь
 * остаётся открыт для остальных методов того же пути (GET /admin/spool для
 * spool_inspect, GET /admin/user/pay для billing_ledger). Без `methods`
 * правило действует на любой метод — так же, как раньше.
 */
export interface ForbiddenRule {
  pattern: string;
  match: 'exact' | 'prefix' | 'contains';
  reason: string;
  methods?: readonly string[];
}

/**
 * §8 дизайна: операции, которых в реестре НЕТ и не будет. Список живёт ровно
 * здесь, потому что его читают три места: клиент SHM (denylist мутирующих GET),
 * тест-скан исходников и текст instructions MCP-сервера.
 *
 * Поле `match` — не украшение. §8 запрещает ДАМП `/admin/config` целиком, а §5.1
 * требует чтение ОДНОГО ключа из allowlist (`GET /admin/config/{key}`). Префиксное
 * правило запретило бы и то и другое, то есть убило бы config_read на каждом вызове.
 */
export const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  // ПРЕФИКС — на `/admin/server/identity`, а не на `/admin/server/identity/generate`.
  // Прежнее правило накрывало ТОЛЬКО генерацию: `/admin/server/identity` не
  // начинается с `/admin/server/identity/generate`, поэтому GET списка ключей
  // (controller Identities, v1.cgi:957) проезжал и через assertNotForbidden, и
  // через скан исходников — то есть запрет, объявленный на «identity(+generate)»,
  // не действовал ровно на той половине, где лежат сами ключи. Соседние
  // `/admin/server` и `/admin/server/group` под этот префикс не попадают и
  // остаются открыты для server_inventory.
  { pattern: '/admin/server/identity', match: 'prefix', reason: IDENTITY_REASON },
  { pattern: '/admin/config', match: 'exact', reason: CONFIG_REASON },
  // GET /admin/template стоит за template_read, POST — за template_edit; оба
  // обязаны остаться открыты. Запрещены PUT (создать) и DELETE (удалить): у
  // того и другого нет предыдущего состояния, которое можно было бы снять до
  // записи, то есть ровно та причина, которой правило и обосновано.
  //
  // Два метода перечислены поимённо, а не «всё, кроме GET и POST»: правило,
  // написанное отрицанием, откроет создание первым же новым методом, который
  // заведёт SHM. PATCH, если он однажды появится, обязан потребовать
  // осознанной строки здесь — на это стоит тест.
  {
    pattern: '/admin/template',
    match: 'prefix',
    methods: ['PUT', 'DELETE'],
    reason: TEMPLATE_REASON,
  },
  { pattern: '/admin/spool/manual/success', match: 'prefix', reason: MANUAL_SUCCESS_REASON },
  // Рядом с ним и по той же причине. Префикс `/admin/spool/manual/` целиком
  // брать НЕЛЬЗЯ: под ним живут retry/resume/pause, ради которых существует
  // provisioning_repair, — правило, написанное шире своего обоснования, здесь
  // убило бы единственный инструмент починки провижининга.
  { pattern: '/admin/spool/manual/set', match: 'prefix', reason: MANUAL_WRITE_REASON },
  { pattern: '/admin/spool/manual/add', match: 'prefix', reason: MANUAL_WRITE_REASON },
  // GET /admin/spool стоит за spool_inspect (Task 14) и обязан остаться открыт —
  // запрещён только PUT, создающий рассылочную задачу с job_users.
  { pattern: '/admin/spool', match: 'exact', methods: ['PUT'], reason: BULK_REASON },
  { pattern: '/api/keygen', match: 'prefix', reason: IDENTITY_REASON },
  { pattern: '/api/tokens', match: 'prefix', reason: TOKEN_REASON },
  { pattern: '/api/auth', match: 'prefix', reason: TOKEN_REASON },
  { pattern: '/api/passkeys', match: 'prefix', reason: TOKEN_REASON },
  { pattern: '/api/remnawave-settings', match: 'prefix', reason: SETTINGS_REASON },
  { pattern: '/api/subscription-settings', match: 'prefix', reason: SETTINGS_REASON },
  // `/api/users/bulk/all` СТОЯЛО ЗДЕСЬ и было снято отсюда — разбор в
  // DELETE_BY_STATUS_REASON выше. Коротко: запрет закрывал слепоту вызывающего,
  // а не маршрут, и слепота закрыта точнее (счёт затронутых у панели до
  // применения + HQ_MCP_MAX_BULK_USERS + только человек). Соседняя ручка ниже
  // осталась запрещённой, и это не непоследовательность: у неё в теле статус
  // вместо людей, и назвать затронутых она не даёт в принципе.
  { pattern: '/api/users/bulk/delete-by-status', match: 'prefix', reason: DELETE_BY_STATUS_REASON },
  { pattern: '/api/nodes/actions/restart-all', match: 'prefix', reason: BULK_REASON },
  // Reorder существует на разных сущностях Remnawave (hosts/nodes/...); uuid и
  // сущность варьируются, инвариант — хвост пути. 'contains' ловит все разом.
  { pattern: '/actions/reorder', match: 'contains', reason: BULK_REASON },
  // Обе squad-семьи (internal/external) несут uuid посередине пути перед
  // /bulk-actions/{action} — одно contains-правило покрывает обе.
  { pattern: '/bulk-actions/', match: 'contains', reason: SQUAD_BULK_REASON },
  { pattern: '/api/subscriptions', match: 'prefix', reason: SUBSCRIPTION_REASON },
  /**
   * ПРАВИЛО СУЖЕНО, И ЭТО ИСПРАВЛЕНИЕ, А НЕ ПОСЛАБЛЕНИЕ.
   *
   * Запрещать полагалось контроллер выдачи подписки — `/api/sub/{shortUuid}` и
   * `/api/sub/{shortUuid}/info`, то есть готовый к употреблению конфиг. Но
   * префикс `/api/sub` — это ПОДСТРОКА имён двух совершенно других
   * контроллеров панели 3.2.3:
   *   /api/subscription-page-configs     — что страница подписки показывает клиенту;
   *   /api/subscription-request-history  — кто, когда и каким приложением её дёргал.
   * Оба читающие, оба не выдают ни одного ключа, и оба были недоступны молча:
   * `assertNotForbidden` бросал в клиенте, а `scanForbiddenLiterals` краснел на
   * самом литерале, то есть инструмент нельзя было даже написать. Запрет
   * действовал шире собственного обоснования — тот же класс дефекта, что этот
   * проект ловит с первого дня, и ровно тот, за который уже сужали
   * `/admin/template`.
   *
   * Разделено на два правила намеренно. `prefix` на `/api/sub/` со слэшем
   * оставляет запертым всё поддерево выдачи; `exact` на `/api/sub` запирает
   * голый корень, до которого префикс со слэшем не дотягивается. Написать одно
   * правило «`/api/sub`, но не то, что длиннее» нельзя — семантика match такого
   * не знает, а отрицанием такие вещи и открываются.
   */
  { pattern: '/api/sub', match: 'exact', reason: SUBSCRIPTION_REASON },
  { pattern: '/api/sub/', match: 'prefix', reason: SUBSCRIPTION_REASON },
  { pattern: '/api/connection-keys', match: 'prefix', reason: SUBSCRIPTION_REASON },
  // GET /admin/user/pay стоит за billing_ledger (Task 13) и обязан остаться
  // открыт — запрещено только DELETE, которое рвёт связь баланса с историей.
  { pattern: '/admin/user/pay', match: 'prefix', methods: ['DELETE'], reason: PAYMENT_DELETE_REASON },
  { pattern: '/admin/user/bonus', match: 'prefix', methods: ['DELETE'], reason: PAYMENT_DELETE_REASON },
  {
    pattern: '/admin/user/service/withdraw',
    match: 'prefix',
    methods: ['DELETE'],
    reason: PAYMENT_DELETE_REASON,
  },
];

/**
 * §6.15: GET, которые мутируют. Риск классифицируется по имени ручки, никогда
 * по HTTP-методу. Эти пути не кэшируются, не повторяются и через обычный
 * `ShmClient.get` не проходят вовсе. Сравнение — `startsWith` в
 * `packages/shm/src/client.ts`, поэтому запись со слэшем на конце запирает
 * поддерево, а без слэша — семейство путей с общим началом.
 *
 * СПИСОК ВЫРОС ПОСЛЕ РАЗБОРА КЛИЕНТСКОЙ ЧАСТИ API. До этого разбора
 * аудит видел только `swagger_admin.json`, а мутирующие GET искали среди
 * админских ручек — и нашли две штуки поимённо (`/template/smena`,
 * `/template/roulette`). Обе оказались частными случаями одного правила,
 * которого в списке не было вовсе: на КЛИЕНТСКОЙ стороне `GET /template/{id}`
 * это `Template::parse_for_api`, то есть «выполнить шаблон»
 * (app/public_html/shm/v1.cgi:424-443). Что именно он делает, зависит от тела
 * шаблона, а телу доступны user/us/pay/bonus/wd/spool/mail/http/ssh/storage/
 * promo (app/lib/Core/Template.pm:111-152). Перечислять такие шаблоны по
 * именам — значит защищаться ровно от тех двух, которые уже знаешь.
 */
export const MUTATING_GET_PATHS: readonly string[] = [
  '/promo/apply',
  /**
   * Исполнение шаблона клиентской стороной. Накрывает и `/template/smena`, и
   * `/template/roulette` — они остаются перечисленными ниже НЕ ради работы
   * гейта (префикс их уже запирает), а ради знания: это два шаблона, про
   * которые точно известно, что они меняют тариф и тратят баланс.
   *
   * `/admin/template` под это правило НЕ ПОПАДАЕТ и попасть не может:
   * сравнение идёт `startsWith`, а '/admin/template' не начинается с
   * '/template/'. Чтение тел шаблонов (template_read) остаётся открытым.
   */
  '/template/',
  '/template/smena',
  '/template/roulette',
  /**
   * `Template::parse_for_public` с `user_id => 1` прямо в объявлении маршрута
   * (v1.cgi:444-465). Этот `user_id` доезжает до `SHM->new` (v1.cgi:1661) и
   * закорачивает проверку сессии (app/lib/SHM.pm:84-87), то есть шаблон
   * исполняется БЕЗ АУТЕНТИФИКАЦИИ от имени пользователя 1. Единственный
   * ограничитель — флаг `allow_public` у самого шаблона.
   */
  '/public/',
  /**
   * Аутентификационная поверхность, у которой GET не читает, а ДЕЛАЕТ:
   *  - /user/passkey/register и /user/auth/passkey — `generate_challenge`
   *    кладёт свежий 32-байтный вызов в кэш на 300 с
   *    (app/lib/Core/User/Passkey.pm:95-106), второй маршрут — ещё и без
   *    аутентификации;
   *  - /user/passwd/reset/verify — тот же самый обработчик, что у POST, и
   *    `required => ['token']` проверяет ТОЛЬКО наличие token, а лишние
   *    параметры не запрещает: `?token=..&password=..` доходит до
   *    `$self->passwd(...)` и меняет пароль (app/lib/Core/User.pm:559-570,
   *    маршрут v1.cgi:273-289, `skip_check_auth => 1`);
   *  - телеграм-вход: `/telegram/webapp/auth` создаёт сессию
   *    (app/lib/Core/Transport/Telegram.pm:1680), `/telegram/web/auth/init`
   *    и `/telegram/web/auth/start` пишут состояние OIDC в кэш (Telegram.pm:777),
   *    `/telegram/web/callback` гасит его и может ЗАРЕГИСТРИРОВАТЬ клиента.
   * Ни один из них не будет прочитан ни одним инструментом; запись здесь —
   * это предохранитель на случай, если кто-нибудь попробует.
   */
  '/user/passkey/register',
  '/user/auth/passkey',
  '/user/passwd/reset',
  '/telegram/webapp/auth',
  '/telegram/web/auth',
  '/telegram/web/callback',
];

/**
 * Тематические объяснения для СЛОВ, а не для путей: сюда приходит «identity»,
 * «template», «bulk» из просьбы пользователя, и модель должна получить причину,
 * а не «нет такого инструмента».
 */
const REASONS: Array<{ match: RegExp; reason: string }> = [
  { match: /identity|keygen/i, reason: IDENTITY_REASON },
  { match: /token|passkey|auth/i, reason: TOKEN_REASON },
  { match: /template/i, reason: TEMPLATE_REASON },
  { match: /config/i, reason: CONFIG_REASON },
  { match: /settings/i, reason: SETTINGS_REASON },
  { match: /delete.?by.?status/i, reason: DELETE_BY_STATUS_REASON },
  { match: /bulk[-\s_]?action/i, reason: SQUAD_BULK_REASON },
  { match: /restart-all|reorder|job_users/i, reason: BULK_REASON },
  /**
   * СТОИТ ПОСЛЕДНИМ СРЕДИ МАССОВЫХ И ОТВЕЧАЕТ НЕ «НЕТ», А «ГДЕ ИМЕННО ДА».
   *
   * Раньше здесь стояло голое /bulk/, и слово «массово» получало ответ
   * «такого не будет». С появлением `bulk_ops` это стало неправдой ровно
   * наполовину, а полуправда здесь хуже отказа: модель, услышав «нет»,
   * предложит оператору делать то же самое руками по одному.
   */
  { match: /bulk|mass|массов/i, reason: BULK_SCOPE_REASON },
  { match: /subscription|connection-key|sub\b/i, reason: SUBSCRIPTION_REASON },
  { match: /manual.?success/i, reason: MANUAL_SUCCESS_REASON },
  { match: /delete.*(pay|bonus|withdraw)|pay.*delete/i, reason: PAYMENT_DELETE_REASON },
];

/** Человеческое объяснение «почему такого инструмента нет и не будет». */
export function explainRefusal(topic: string): string | undefined {
  return REASONS.find((entry) => entry.match.test(topic))?.reason;
}

function ruleMatchesPath(rule: ForbiddenRule, clean: string): boolean {
  if (rule.match === 'exact') return clean === rule.pattern;
  if (rule.match === 'prefix') return clean.startsWith(rule.pattern);
  return clean.includes(rule.pattern);
}

/**
 * Правило, под которое попадает путь. Query отбрасывается: сравнивается только
 * путь. `method`, если передан, обязан входить в `rule.methods` — правило со
 * своим `methods` НЕ применяется, когда метод не передан вовсе: вызывающий,
 * который не сказал, каким методом идёт, не может быть отгейтован по методу,
 * а выдумывать метод по умолчанию либо блокирует лишние чтения, либо пропускает
 * записи. Сравнение регистронезависимо: гейт существует для будущего
 * вызывающего, а не только для сегодняшних, которые случайно всегда шлют
 * заглавные буквы — 'delete'/'Delete'/'DELETE' обязаны совпасть одинаково.
 */
export function matchForbidden(path: string, method?: string): ForbiddenRule | undefined {
  const clean = path.split('?')[0] ?? path;
  const upperMethod = method?.toUpperCase();
  return FORBIDDEN_RULES.find((rule) => {
    if (rule.methods !== undefined) {
      if (upperMethod === undefined || !rule.methods.some((m) => m.toUpperCase() === upperMethod)) {
        return false;
      }
    }
    return ruleMatchesPath(rule, clean);
  });
}

export function assertNotForbidden(path: string, method?: string): void {
  const rule = matchForbidden(path, method);
  if (rule === undefined) return;
  const verb = method === undefined ? '' : `${method} `;
  throw new Error(
    `${verb}${path} is a forbidden operation for this server (${rule.pattern}). ${rule.reason}`,
  );
}

/**
 * Извлекает содержимое строковых литералов ('...', "...", `...`) из текста
 * исходника, не заходя за границу того же кавычка.
 */
const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Вырезает комментарии, не трогая строки. Нужно потому, что доккомментарии в
 * этом репозитории написаны с markdown-обратными кавычками, а обратная кавычка
 * — полноценный строковый литерал для регулярки выше. Без вырезания фраза
 * ``запрещён `PUT /admin/spool` `` в объяснении запрета краснила бы скан, то
 * есть предохранитель наказывал бы за документирование ровно того, что
 * защищает. Комментарий не исполняется — назвать в нём запрещённый путь
 * законно и нужно.
 *
 * Состояние отслеживается только для строк: `//` внутри литерала не начинает
 * комментарий, иначе запрещённый путь, стоящий на той же строке после ссылки
 * вида 'https://…', ушёл бы из-под скана.
 *
 * Предел, унаследованный от прежней реализации и не расширенный этой: кавычка
 * внутри regexp-литерала (`/['"]/`) читается как начало строки. Ложных
 * СРАБАТЫВАНИЙ это не даёт, но в теории может дать пропуск; в исходниках
 * инструментов regexp-литералов с кавычками нет.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
        if (source[i - 1] === ch) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Скан видит только текст, а не вызов вокруг литерала — он не может узнать,
 * идёт ли `ctx.shm.list('/admin/user/pay', ...)` (всегда GET) или
 * `ctx.shm.action('DELETE', '/admin/user/pay', ...)`. Для правила БЕЗ
 * `methods` это не проблема: оно запрещено на любом методе, и голый литерал —
 * уже нарушение. Но правило С `methods` (напр. `/admin/user/pay`, только
 * DELETE) сужено рантаймом именно потому, что GET на этом пути легитимен и
 * обязан остаться доступен (billing_ledger, Task 13; аналогично GET
 * /admin/spool — spool_inspect, Task 14) — статический скан не имеет права
 * требовать прятать такой литерал за конкатенацией только ради того, чтобы
 * пройти тест. Поэтому правило со своим `methods` учитывается сканом, только
 * если GET входит в список запрещённых методов: в этом случае само чтение и
 * есть нарушение, и голый литерал остаётся подозрительным по праву. Во всех
 * остальных случаях единственная настоящая защита — assertNotForbidden в
 * клиенте, которому известен подлинный метод вызова.
 */
function ruleAppliesToLiteralScan(rule: ForbiddenRule): boolean {
  if (rule.methods === undefined) return true;
  return rule.methods.some((method) => method.toUpperCase() === 'GET');
}

/**
 * Те же правила, но для ТЕКСТА исходника: ищем строковый литерал с путём, а не
 * упоминание в прозе или комментарии. Скан и рантайм пользуются одной и той же
 * семантикой match ('exact'/'prefix'/'contains'), поэтому «в тесте одна
 * семантика, в клиенте другая» невозможно по построению. Для exact литерал
 * `/admin/config/${name}` нарушением НЕ является (равенство целой строки, а не
 * префикса) — §5.1 разрешает читать один ключ, запрещён только дамп целиком.
 */
export function scanForbiddenLiterals(source: string): string[] {
  const hits = new Set<string>();
  for (const found of stripComments(source).matchAll(STRING_LITERAL_RE)) {
    const literal = found[2] ?? '';
    for (const rule of FORBIDDEN_RULES) {
      if (!ruleAppliesToLiteralScan(rule)) continue;
      if (ruleMatchesPath(rule, literal)) hits.add(rule.pattern);
    }
  }
  return [...hits];
}

/** Уезжает в instructions MCP-сервера, чтобы модель видела причину без вызова. */
export const REFUSAL_INSTRUCTIONS = [
  'Some operations are deliberately absent from this server and will never be added:',
  '- node identity / keygen (a GET that returns a private key),',
  '- /api/tokens, /api/auth, /api/passkeys (plaintext tokens and persistence),',
  '- creating or deleting a template, and every settings write (live billing logic, no git; ' +
    'template_edit overwrites an EXISTING template and takes its own snapshot back),',
  '- restart-all, reorder and squad bulk-actions routes (whole-fleet or whole-squad blast radius),',
  '- POST /api/users/bulk/delete-by-status (it deletes whoever matches when the queue runs, not who the operator reviewed; bulk_ops delete_by_status enumerates the exact ids instead),',
  '- creating a spool task with job_users (mass-mails the whole user base with no cancel),',
  '- /api/subscriptions and connection keys (ready-to-use configs = subscriber takeover),',
  '- marking a spool task successful (fakes provisioning),',
  '- deleting payments, bonuses or withdraws (breaks the balance with no way back).',
  'Asking for them will not produce a tool. Say so plainly and offer the closest legitimate one.',
].join('\n');
