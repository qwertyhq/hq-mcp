import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Код предупреждения — это то, на что модель и вызывающий КЛЮЧУЮТСЯ: текст они
 * читают, а ветвятся по коду. Поэтому у кодов ровно два требования, и оба
 * проверяются здесь по исходникам, а не по одному прогону:
 *
 *  1. Одно написание. `client_resolve` был единственным, кто писал коды через
 *     точку (`shm.blocked_invisible`) против плоского snake_case у остальных
 *     пятнадцати — вызывающий, знающий один инструмент, промахивался мимо
 *     второго.
 *  2. Один код — один факт. `blocked_hidden` означал «заблокированные СЮДА не
 *     попали» в client_search и «заблокированные читаются вторым запросом» в
 *     sync_audit: модель, ключующаяся на код, из одного из двух узнавала
 *     неправду. Список кодов ниже фиксирует состав, чтобы столкновение нельзя
 *     было завезти молча; менять его руками и с разбором.
 */
function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/**
 * Первый аргумент каждого `warn(...)` в исходниках инструментов.
 *
 * Целиком комментарные строки выбрасываются заранее: между `warn(` и кодом
 * часто стоит объяснение, почему код именно такой, и без этого шага сканер
 * пропускал бы ровно те коды, которые кто-то счёл нужным объяснить. Режутся
 * только строки, состоящие из комментария целиком, — `//` внутри строкового
 * литерала (`https://t.me/...`) остаётся на месте.
 */
function warningCodes(): string[] {
  const codes = new Set<string>();
  for (const file of sourceFiles('tools/read/src')) {
    const source = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const found of source.matchAll(/\bwarn\(\s*'([^']*)'/g)) {
      codes.add(found[1] ?? '');
    }
  }
  return [...codes].sort();
}

/**
 * Полный словарь кодов. Растёт вместе с инструментами — но осознанно: новая
 * строка здесь заставляет посмотреть, не называет ли она факт, у которого имя
 * уже есть.
 */
const KNOWN_CODES = [
  // Remnawave 3.3 optional API access: missing route, denied scope, inconclusive probe.
  'extension_api_unavailable',
  'extension_probe_failed',
  'extension_scope_denied',
  'realtime_route_absent',
  // GeoCheck queue state is separate from the diagnostic's success and report quality.
  'geocheck_invalid_response',
  'geocheck_job_failed',
  'geocheck_node_failed',
  'geocheck_pending',
  'geocheck_report_invalid_fields',
  'geocheck_report_summary',
  'geocheck_report_truncated',
  'geocheck_report_unavailable',
  'geocheck_unavailable',
  // References are only missing after complete source reads; an empty catalog is available.
  'node_integration_missing',
  'node_integrations_separate_config',
  'node_integrations_unused',
  'shared_list_reference_missing',
  'shared_lists_unused',
  'addresses_masked',
  'attempts_recorded_none_succeeded',
  'autopay_comment_unreadable',
  'autopay_multiple_live_subscriptions',
  'autopay_status_unknown',
  // template_read: имя лежит под .DAV/ или bak-*/ — это копия, созданная
  // WebDAV-редактором панели или руками, и SHM её НЕ ИСПОЛНЯЕТ. Отдельный код,
  // а не 'truncated': там речь о срезе списка, здесь — о том, что показанный
  // (или прочитанный) файл вообще не тот, который работает.
  'backup_copies_listed',
  'bandwidth_shape_unrecognised',
  'bandwidth_top_n',
  // infra_costs: за ноду платим, а ёмкости за ней нет (выключена, отвалилась
  // или на ней никого). Отличается от node_agent_down: там нода сломана, здесь
  // — деньги уходят за то, чем никто не пользуется.
  'billed_node_idle',
  'blocked_filter_not_applied',
  'blocked_filtered_client_side',
  'blocked_hidden',
  'blocked_read_separately',
  'bonus_mismatch',
  'balance_mismatch',
  // billing_ledger: сверка НЕ ПРОВОДИЛАСЬ — ленту не удалось вычитать целиком,
  // поэтому `delta` и `matches` null. Отдельный код и отдельный факт: ни
  // 'balance_mismatch' («сверили, разошлось»), ни 'truncated' (там срезано ОКНО
  // ПОКАЗА, а суммы всё равно посчитаны по всем строкам), ни 'partial_result'
  // (там бэкенд не ответил). Здесь бэкенд ответил, показывать есть что, а
  // утверждать про баланс нечего — и молчание на этом месте читалось бы как
  // «сверено и сошлось».
  'reconciliation_incomplete',
  'card_unavailable',
  // squads_read: доступные ноды не спрашивали (accessible_nodes=false или
  // упёрлись в потолок). Это «не спросили», а не «сквад никуда не ведёт» —
  // второе называется squad_reaches_no_node и только по ОТВЕТУ панели.
  'accessible_nodes_not_read',
  // platform_probe: бэкенд ОТВЕТИЛ и отверг наши креды (401/403). Отдельно от
  // partial_result: там источник недоступен, здесь он жив и работает.
  'credentials_rejected',
  // platform_probe: самый молодой процесс панели моложе собственного окна
  // кэширования пробы, то есть чужие сбои могут быть перезапуском.
  'panel_recently_restarted',
  // subscription_inspect: панель не пишет историю обращений вовсе, поэтому
  // пустая история про клиента не говорит ничего.
  'subscription_history_not_recorded',
  // squads_read: сквад с участниками, ни один инбаунд которого не активен ни на
  // одной ноде. Не пересекается с squad_not_in_panel (traffic_stats: сквада с
  // таким uuid в панели нет) и squad_totals_overlap (суммы по сквадам не
  // складываются, потому что клиент может быть в нескольких).
  'squad_reaches_no_node',
  // squads_read: сквады адресуются ТОЛЬКО по uuid, маршрута by-name нет.
  'squad_uuid_malformed',
  'squad_not_found',
  'connections_job_failed',
  'connections_job_unfinished',
  'connections_nodes_not_polled',
  'connections_result_not_ours',
  'node_agent_down',
  'node_listing_unavailable',
  'node_not_in_panel',
  'squad_not_in_panel',
  'squad_totals_overlap',
  'clock_skew',
  'country_not_in_panel',
  'delivery_verdict_not_recorded',
  'duplicate_panel_users',
  'empty_or_absent',
  'empty_render',
  // server_inventory / infra_costs: из значения адреса вырезаны путь, query и
  // user:password@ — секрет там лежит ВНУТРИ значения, и маскировать его по
  // имени поля нечем.
  'endpoint_path_stripped',
  // server_inventory: группа, из которой SHM не сможет выбрать ни один сервер.
  'group_cannot_yield_a_server',
  // infra_costs, ДВА РАЗНЫХ ФАКТА и оба про пустой ответ: маршрутов нет на этой
  // версии панели — против «маршруты есть, но инфра-биллинг никто не настроил».
  'infra_billing_absent',
  'infra_billing_unconfigured',
  'excludes_children_and_removed',
  'findings_sampled',
  'hosts_not_attributable',
  'hosts_without_country',
  'inbounds_left_without_a_live_host',
  'manual_success_forbidden',
  'masked',
  'missing_panel_user_unverified',
  'next_deletes_service',
  'notifications_absent_in_window',
  // template_read: /admin/template отдаёт ВСЕ строки и игнорирует limit/offset
  // (шаблоны здесь — файлы, а не таблица), а `items` при этом всегда 0.
  // Не то же, что server_count_absent (torrent_reports: панель не прислала
  // total вовсе): счётчик здесь ПРИСЛАН и ЛЖИВ, а пагинации нет в принципе.
  'pagination_not_supported',
  'panel_not_fully_read',
  'panel_rows_repeated',
  'panel_rows_unusable',
  'panel_username_guessed',
  'panel_users_for_unlisted_services',
  'partial_result',
  'periodic_task_not_progress',
  'possible_fake_success',
  // sync_audit и provisioning_diagnose: имена в панели собраны НЕ теми
  // префиксами, которыми их здесь ищут, то есть «пользователя панели нет» —
  // про наш ключ поиска, а не про панель. Отдельно от
  // 'panel_username_guessed' и намеренно: там сказано, что имя ГАДАЛИ (снапшота
  // не было) и не угадали — законный исход на здоровой инсталляции; здесь есть
  // ДОКАЗАТЕЛЬСТВО того, что список префиксов эту инсталляцию не описывает —
  // имя, которое написал сам провижининг, или полная панель без единого
  // совпадения. Первое — оговорка, второе — настройка, которую надо поправить.
  'prefix_unverified',
  'quota_exhausted_is_not_desync',
  'remna_ambiguous_identifier',
  'remna_more_matches',
  'remna_not_requested',
  // client_resolve, ТРИ РАЗНЫХ ФАКТА про панельную половину ответа, и ни один
  // из них не выражается пустым `matches`.
  //
  // Аккаунт панели ЕСТЬ, и путь по идентификатору его не вернул: `telegramId`
  // панель пишет только при создании и только если Telegram уже был привязан
  // (пусто у заметной доли аккаунтов), поэтому существующий аккаунт находится
  // обходом по услугам, а не поиском по telegram id. Не 'duplicate_panel_users'
  // (sync_audit: на одну услугу нашлось ДВА аккаунта) — здесь аккаунт один и
  // он единственный.
  'remna_found_via_services',
  // Обход по услугам упёрся в собственный потолок стоимости, то есть список
  // аккаунтов может быть короче настоящего. Не 'truncated' (там срезан СПИСОК,
  // отданный бэкендом) и не 'panel_not_fully_read' (sync_audit: не дочитана
  // выдача панели) — здесь мы сами не стали спрашивать дальше.
  'panel_lookup_capped',
  // Аккаунтов не нашлось НИ ОДНИМ путём — и это не доказательство их
  // отсутствия: предупреждение перечисляет, где именно искали и чего каждый
  // путь не видит. Существует потому, что естественное следствие вывода «в
  // панели его нет» — завести аккаунт заново, то есть сделать клиенту дубль.
  // Не 'user_not_found' (client_overview: панель ОТВЕТИЛА, что по данному id
  // пользователя нет) — здесь ответа «нет такого» никто не давал.
  'remna_absence_unproven',
  // template_read: из тела шаблона вырезаны литеральные секреты. Не 'masked'
  // (config_read: поле съедено редакцией ПО ИМЕНИ) — здесь секрет был голой
  // подстрокой внутри текста, и вырезан он по ФОРМЕ; факты разные, и вызывающий,
  // ключующийся на код, обязан их различать.
  'secrets_scrubbed',
  'send_never_ran',
  'service_id_ignored',
  'service_in_progress',
  'service_not_found',
  'services_not_all_diagnosed',
  'shm_blocked_invisible',
  'shm_found_via_user_id',
  'shm_not_fully_read',
  'snapshot_predates_numeric_id',
  'specs_are_stale',
  // spool_inspect: находка в очереди, за которой не стоит НИ ОДНОЙ услуги, —
  // обслуживающая задача установки или событие аккаунта. Не
  // 'manual_success_forbidden' и намеренно: там назван вред, который
  // Spool.pm:352-364 обуславливает наличием settings.user_service_id, то есть
  // на этих строках он наступить не может. Факты разные: «ручной SUCCESS
  // двинет статус услуги мимо провижининга» против «это вообще не провижининг,
  // и искать клиента по такой строке некого».
  //
  // 'spool_task_paused' общий с provisioning_diagnose и остаётся один: факт
  // «PAUSED исключён из выборки навсегда (Spool.pm:130-133), то есть строка
  // мертва, а не ждёт» — один и тот же, чья бы задача ни была.
  'task_without_service_is_not_provisioning',
  'spool_task_paused',
  'status_filter_not_applied',
  'storage_empty_is_not_404',
  // template_read: файл ЕСТЬ и он пустой (в проде таких два, по 0 байт). Ровно
  // тот факт, который 'template_not_found' стёр бы: пустой шаблон рендерится в
  // ничто, а задача спула рапортует SUCCESS. Это исток той же поломки, которую
  // notify_history видит с другого конца как 'empty_render'.
  'template_body_empty',
  // template_read: файла с таким именем нет. Не 'empty_or_absent' (config_read:
  // ручка не различает «нет ключа» и «ключ пуст») — здесь различить МОЖНО,
  // потому что шаблоны это файлы, и разница «нет файла» / «файл пуст»
  // выражается двумя разными кодами, а не одним размытым.
  'template_not_found',
  'truncated',
  // infra_costs: «сколько нод можно привязать» по версии панели и «сколько нод
  // здесь не оплачены» по списку нод — разные числа, и расхождение надо назвать,
  // а не выбрать одно молча.
  'unbilled_node_count_disagrees',
  'unhosted_inbound_may_be_a_relay',
  'unknown_panel_status',
  'unlinkable_is_not_orphan',
  'user_filter_not_applied',
  // torrent_reports: фильтр панели по клиенту — подстрочный LIKE, а не
  // равенство, и его `total` считает чужие совпадения. Это НЕ
  // user_filter_not_applied: там фильтр не сработал вовсе, здесь он сработал
  // и захватил лишнее.
  'user_filter_matched_by_substring',
  'user_not_found',
  // torrent_reports, ЧЕТЫРЕ РАЗНЫХ ФАКТА про один и тот же пустой список:
  // плагина нет вовсе; плагин есть, но его блокировщик выключен; карточку
  // плагина прочитать не удалось, поэтому состояние неизвестно; нода вообще без
  // плагина, то есть трафик через неё не порождает отчётов никогда.
  'torrent_blocker_not_installed',
  'torrent_blocker_disabled',
  'torrent_blocker_state_unknown',
  'nodes_without_torrent_blocker',
  // torrent_reports: всего отчётов много, за сутки ноль — запись прекратилась,
  // а не абуз закончился.
  'no_recent_torrent_reports',
  // torrent_reports: панель не назвала `total` списка вовсе, поэтому усечение
  // проверить нечем. Отдельно от truncated: там мы ЗНАЕМ, что это срез.
  'server_count_absent',
  // torrent_reports: topUsers/topNodes срезаны по top_limit. Отдельно от
  // bandwidth_top_n — тот про top-N самой панели в графике трафика.
  'top_list_truncated',
  // promo_read, ТРИ РАЗНЫХ ФАКТА: в идентификаторе кода есть невидимые символы
  // (код неприменим); спрошенный код нашёлся только после их вычистки (то же
  // самое со стороны клиента); строки нет ни в каком виде.
  'promo_id_has_whitespace',
  'promo_code_matched_after_normalizing',
  'promo_code_not_found',
  // promo_read: код есть, но собственный счётчик остатка базы — ноль.
  'promo_code_exhausted',
  // ПЯТЬ ИНСТРУМЕНТОВ АУДИТА ПОВЕРХНОСТИ REMNAWAVE.
  //
  // subpage_read: список страниц подписки ВСЕГДА отдаёт `config: null` — тело
  // живёт только в карточке. Это не 'empty_or_absent' (там ручка не различает
  // «нет ключа» и «ключ пуст») и не 'truncated' (там срез): здесь ответ полон и
  // по построению не содержит того, за чем пришли.
  'subpage_body_absent_from_listing',
  // subpage_read: тела карточек дочитаны не все (потолок за вызов). Отдельно от
  // truncated: там срезан СПИСОК, здесь список полон, а не прочитаны ТЕЛА.
  'subpage_bodies_not_all_read',
  'subpage_config_not_found',
  // subpage_read: uuid не той формы. Отдельный код от config_uuid_malformed —
  // разные пространства объектов, и вызывающий, ключующийся на код, обязан
  // видеть, ЧТО он назвал неправильно.
  'subpage_uuid_malformed',
  'config_uuid_malformed',
  // node_config_audit, ТРИ РАЗНЫХ ФАКТА про вычисленный конфиг, и смешение
  // любых двух из них — это неправда про то, что исполняет нода:
  // сверка проведена и разошлась; сверка проведена и сошлась; сверки НЕ БЫЛО.
  // Третий существует именно потому, что молчание здесь читается как согласие.
  'computed_config_differs',
  'computed_config_identical',
  'computed_config_not_compared',
  // node_config_audit: профиль, к которому не привязана ни одна нода. Не
  // 'unlinkable_is_not_orphan' (sync_audit, про пользователей) — здесь объект
  // существует законно, просто ничего не обслуживает, продолжая держать живые
  // ключи Reality.
  'config_profile_without_nodes',
  // ОБЩИЙ КОД ТРЁХ ИНСТРУМЕНТОВ и намеренно один: ручка ответила нормально и
  // вернула пусто, то есть возможность на панели ЕСТЬ и ею никто не
  // пользуется (сниппеты, теги нод, теги пользователей). Факт один и тот же, и
  // разводить его по трём именам значило бы заставить вызывающего знать три.
  // Противоположность ему — 404 отсутствующего маршрута, который клиент
  // @hq/remna поднимает исключением и который сюда не попадает никогда.
  'feature_present_but_unused',
  // client_reach: клиент СУЩЕСТВУЕТ и не достаёт ни до одной ноды. Не
  // 'user_not_found' (клиента нет) и не 'squad_reaches_no_node' (squads_read,
  // про сквад): здесь у живого аккаунта нет ни одного пути подключения.
  'client_reaches_no_node',
  // client_reach: нода клиенту доступна, а инбаундов не даёт ни одного —
  // «серверов» в приложении больше, чем работающих.
  'reachable_node_grants_no_inbound',
  // device_inventory: панель не записала ни одного устройства ВООБЩЕ. Не
  // 'empty_or_absent': здесь пустота осмысленна и указывает на выключенный
  // учёт hwid, при котором каждый поклиентский счётчик равен нулю по той же
  // причине.
  'hwid_not_recorded',
  // panel_activity: все обращения окна попали в ОДНО правило SRR. Ни один
  // существующий код этого не называет, а вывод из него прямой: специфические
  // правила не матчат никого.
  'srr_single_rule_matched',
  // panel_activity: http-счётчики панели не подписаны периодом — ни «с
  // установки», ни «с рестарта». Отдельно от 'specs_are_stale' (там данные
  // устарели) — здесь неизвестно, за что они вообще посчитаны.
  'http_stats_period_unstated',
  // panel_activity: digest и почасовая статистика считаны за РАЗНЫЕ отрезки,
  // и складывать их нельзя. Не 'squad_totals_overlap' (там двойной счёт по
  // пересекающимся множествам) — здесь несовпадение по времени.
  'stats_windows_differ',
  // ТРИ ИНСТРУМЕНТА КЛИЕНТСКОЙ ЧАСТИ API SHM.
  //
  // client_billing_view, ДВА РАЗНЫХ ФАКТА про «списывать нечего»: в трёхдневном
  // окне прогноза нет ни одной услуги — против «услуги есть, но баланс и бонусы
  // их уже покрывают». Одним кодом это было бы «с клиента ничего не возьмут»,
  // что верно только в первом случае.
  'forecast_window_is_empty',
  'forecast_covered_by_balance',
  // client_billing_view: у нескольких предложенных методов оплаты совпало поле
  // `paysystem`, потому что SHM разрешает его переопределить. Это НЕ
  // 'duplicate_panel_users' (там две настоящие строки на один объект) — здесь
  // строки разные, а склеился идентификатор, по которому их сопоставляют с
  // платежом.
  'paysystem_family_collapsed',
  // client_billing_view: ссылка оплаты не воспроизводится. Не 'masked' (поле
  // съедено редакцией по имени) и не 'secrets_scrubbed' (секрет вырезан по
  // форме): здесь значение цело и опущено намеренно — по нему создаётся платёж.
  'payment_url_dropped',
  // client_billing_view: у SHM нет записи о рекуррентном методе, и на этой
  // инсталляции это НЕ значит, что клиента не списывают.
  'autopay_not_recorded_in_shm',
  // client_billing_view: сумма, которую подставит форма оплаты, не равна сумме
  // прогноза, потому что первая считается С заблокированными услугами, а вторая
  // без. Оба числа верны — ни одно из них не «неправильное», и слить их в
  // partial_result значило бы объявить расхождение сбоем.
  'payable_amount_differs_from_forecast',
  //
  // client_account_state: почты нет вовсе — против «почта есть, но никем не
  // подтверждена». Разные ответы на «почему клиент не получает письма».
  'email_absent',
  'email_unverified',
  // client_account_state: ни OTP, ни passkey. Утверждение ровно о двух
  // механизмах, и предупреждение само называет третий, которого в нём нет.
  'no_second_factor',
  // client_account_state: флаги входа по паролю приехали маркером редакции.
  // Не 'masked' (config_read: маскировка ТАМ и есть опубликованный контракт) —
  // здесь она поломка, и код существует, чтобы её было видно.
  'sign_in_flags_masked',
  // client_account_state: поля НЕТ в ответе вовсе — эта SHM его не отдаёт
  // (апстримный api_password_auth_status возвращает три флага, четвёртый
  // дописан патчем конкретной инсталляции). Отдельно от 'sign_in_flags_masked':
  // там значение съела наша редакция и чинить надо у нас, здесь чинить нечего,
  // а null означает «не сообщается», а не «пароль выдан автоматом».
  'sign_in_flag_absent',
  // client_account_state: маршрут рефералов отдаёт ЧИСЛО, списка не существует.
  'referrals_count_only',
  // client_account_state: клиентский маршрут и админская колонка называют
  // РАЗНЫЙ адрес одного клиента. Не 'email_absent' (адреса нет вовсе) и не
  // 'email_unverified' (адрес есть, но не подтверждён): здесь адресов ДВА, и
  // вопрос не в качестве одного из них, а в том, что половины сервера отвечают
  // на «какая у клиента почта» по-разному.
  'email_admin_record_differs',
  //
  // client_catalog_view, ДВА ВЗАИМНО ИСКЛЮЧАЮЩИХ ФАКТА: перечень, который видит
  // клиент, разошёлся с каталогом — против «сошёлся, но это про ЭТОГО клиента
  // сегодня, а не про каталог».
  'catalogue_differs_from_client_view',
  'client_view_matches_catalogue',
  // client_catalog_view: счётчик строк прайс-листа не равен числу позиций.
  // Отдельно от 'pagination_not_supported' (template_read: пагинации нет вовсе)
  // — здесь пагинация не нужна, лжив именно счётчик.
  'order_items_counter_unusable',
  // client_catalog_view: клиентский список промокодов отфильтрован по ВЛАДЕЛЬЦУ
  // строки, а не по применившему.
  'promo_scoped_to_owner',
  // promo_read: в ответе про клиента есть строки, где он ВЛАДЕЛЕЦ кода, а гасил
  // код кто-то другой. Не 'promo_scoped_to_owner' (client_catalog_view: там
  // маршрут SHM УМЕЕТ фильтровать только по владельцу, и находка в том, что
  // применения клиента в такой список не попадают) — здесь сопоставлены обе
  // колонки, список полный, и сказать надо обратное: часть строк отвечает не на
  // тот вопрос, с которым сюда приходят.
  'promo_owner_rows_included',
  //
  // ФОРМА РАЗВЁРТЫВАНИЯ, а не сбой. platform_probe: одной из двух систем в этой
  // установке нет вовсе, и инструментов, которым она нужна, в реестре тоже нет.
  // Единственное место, где это сказано целиком, — потому что исчезнувший
  // инструмент объяснить себя не может.
  'backend_not_configured',
  // platform_probe: бэкенд старее той версии, на которой набор инструментов
  // работает целиком. Не 'specs_are_stale' (там расходятся спека и прод, а код
  // прав) — здесь расходятся прод и код, и часть маршрутов, которые инструменты
  // зовут поимённо, на этой версии не существует.
  'backend_version_below_minimum',
  // platform_probe: /healthcheck отвечает роутерным 404 — маршрута нет (SHM до
  // 2.18.0). Отдельно от 'backend_version_below_minimum': тот говорит про
  // версию целиком, этот — про ОДНО следствие, из-за которого `shm.live`
  // остаётся null, и он единственный, что печатается, когда версия не
  // прочиталась вовсе.
  'shm_healthcheck_route_absent',
  // client_overview и client_resolve: панели здесь нет, поэтому её половина
  // ответа пуста — НИЧЕГО не спрашивали. Не 'card_unavailable' (панель есть,
  // но не ответила — там уместно «повторите») и не 'remna_absence_unproven'
  // (искали и не нашли): оба совета в установке без панели ведут в никуда.
  'remna_absent',
].sort();

describe('warning codes', () => {
  it('are flat snake_case in every tool, not dotted in one of them', () => {
    const offenders = warningCodes().filter((code) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(code));
    expect(offenders).toEqual([]);
  });

  it('name one fact each — the dictionary is closed and reviewed', () => {
    expect(warningCodes()).toEqual(KNOWN_CODES);
  });

  it('actually reads sources — an empty sweep would pass vacuously', () => {
    expect(warningCodes().length).toBeGreaterThan(30);
  });
});
