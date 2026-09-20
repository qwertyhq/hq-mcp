# Совместимость и подгонка · Compatibility and fitting

Справочник к [README.md](README.md) и [README.en.md](README.en.md): полный
перечень маршрутов, которые зовут инструменты, подробный ответ про форк SHM и
конвенция, связывающая биллинг с панелью. Чтобы решить «подойдёт ли это мне»,
сюда заходить не нужно — минимумы версий и то, что ломается ниже, стоят в самих
README. Этот файл нужен, когда вы сверяете набор маршрутов и имён со своей
конкретной установкой.

Reference for [README.md](README.md) and [README.en.md](README.en.md): every
route these tools call, the long answer to "does this need a forked SHM", and
the convention that joins the billing to the panel. You do not need this file to
decide whether the project fits — the version floors and what breaks below them
are in the READMEs themselves. This one is for auditing routes and names against
a specific installation.

Минимумы базовых инструментов · Base-tool floors: **SHM 2.18.0**, **Remnawave 3.0.0**.
Проверено на · Verified against: **SHM 2.19.4**, **Remnawave 3.2.3**.
Новые возможности · New features: **Remnawave 3.3.2**, см. · see [below](#remna-332).
Разобрано по исходникам · Read off the sources: **SHM 3.0.43** (см. [SHM 3.0](#shm-30)).

<a id="shm-routes"></a>

## Маршруты SHM · SHM routes

Все — апстримные. «С версии» — первый релиз `danuk/shm`, где маршрут появился.

All upstream. "Since" is the first `danuk/shm` release that carries the route.

| Маршрут · Route | С версии · Since | Кто зовёт · Called by |
|---|---|---|
| `GET /healthcheck` | 2.18.0 | `platform_probe` |
| `GET /admin/config/{key}` | 1.x | `config_read`, `platform_probe`, определение префиксов · prefix resolution |
| `GET /admin/user` · `POST /admin/user` | 1.x | почти все клиентские · most client-facing tools, `user_flags` |
| `GET /admin/user/search` | 2.11.3 | `client_search`, `client_resolve` |
| `GET /admin/user/accounts` | 3.0.0 | `client_resolve`, `client_account_state`, `user_flags` (проба схемы · schema probe) |
| `GET /admin/user/service` · `/spool` · `/withdraw` · `/categories` | 1.x | `client_overview`, `service_inspect`, `sync_audit`, `service_lifecycle` |
| `POST /admin/user/service` · `/touch` · `/change` · `/stop` | 1.x | `service_lifecycle` |
| `GET /admin/user/pay` · `GET /admin/user/bonus` | 1.x | `billing_ledger`, `autopay_inspect`, мутаторы денег · the money mutators |
| `PUT /admin/user/payment` · `PUT /admin/user/bonus` | 1.x | `billing_adjust`, `billing_refund_service` |
| `GET /admin/spool` · `/history` | 1.x | `spool_inspect`, `notify_history`, `provisioning_diagnose` |
| `GET /admin/spool/statuses` | 1.13.1 | `platform_probe`, `spool_inspect` |
| `POST /admin/spool/manual/{retry,resume,pause}` | 1.9.1 | `provisioning_repair` |
| `GET /admin/storage/manage[/{name}]` · `PUT` · `POST` | 1.x | `provisioning_diagnose`, `storage_edit` |
| `GET /admin/template` · `POST /admin/template` | 1.x | `template_read`, `template_edit` |
| `GET /admin/server` · `/group` · `PUT` · `POST` · `DELETE` | 1.x | `server_inventory`, `server_edit` |
| `GET /admin/service` · `/order` · `/children` · `/event` | 1.x | `catalog_read`, `client_catalog_view`, `service_lifecycle` |
| `GET /admin/promo` | 1.x | `promo_read` |
| `GET /user/email` | 2.4.0 | `client_account_state` |
| `GET /user/otp` · `/passkey` · `/password-auth` | 1.14.0 | `client_account_state` |
| `GET /user/referrals` | 2.9.0 | `client_account_state` |
| `GET /user/pay` · `/pay/forecast` · `/pay/paysystems` · `/withdraw` · `/autopayment` | 1.x | `client_billing_view` |
| `GET /service` · `/service/order` · `/promo` | 1.x | `client_catalog_view` |

Клиентские маршруты (`/user/*`, `/service*`, `/promo`) зовутся под админскими
кредами с `?user_id=`: SHM переключает контекст исполнения на этого клиента. Это
апстримное поведение, а не наша надстройка.

Форма ответа тоже апстримная и не менялась с 1.x: конверт
`{data, items, limit, offset}`, где `items` — это `SQL_CALC_FOUND_ROWS`, то есть
серверный total. Он здесь сохраняется всюду: без него «такой услуги нет» и
«окно закончилось» неразличимы. Роутерный 404 SHM отвечает
`{"error":"Method not found","status":404}` — этим и распознаётся отсутствующий
маршрут.

The client-side routes (`/user/*`, `/service*`, `/promo`) are called under admin
credentials with `?user_id=`: SHM switches the execution context to that client.
That is upstream behaviour, not a layer of ours.

The response shape is upstream too and has not changed since 1.x: the
`{data, items, limit, offset}` envelope, where `items` is `SQL_CALC_FOUND_ROWS`
— the server-side total. It is preserved everywhere here, because without it "no
such service" and "the window ended" are indistinguishable. SHM's router 404
answers `{"error":"Method not found","status":404}`, which is how a missing route
is recognised.

<a id="panel-routes"></a>

## Маршруты панели · Panel routes

«С версии» — первый релиз `remnawave/backend`, где маршрут появился в контракте.

"Since" is the first `remnawave/backend` release whose contract carries the route.

| Маршрут · Route | С версии · Since | Кто зовёт · Called by |
|---|---|---|
| `GET /api/system/metadata` | 2.5.0 | `platform_probe` |
| `GET /api/system/health` | 1.6.14 | `platform_probe` |
| `GET /api/system/configuration` | 3.2.0 | `platform_probe` |
| `GET /api/system/stats` | 1.6.0 | `abuse_report` |
| `GET /api/system/stats/recap` | 2.7.0 | `panel_activity` |
| `GET /api/system/stats/digest` · `/stats/http` | 3.0.0 | `panel_activity` |
| `GET /api/system/nodes/metrics` | 2.0.0 | `country_health` |
| `GET /api/users` (список · listing) | 1.3.3 | `platform_probe`, `sync_audit`, `bulk_ops` |
| `GET /api/users/{id}` | 3.0.0 | `client_overview`, `subscription_inspect`, `traffic_stats`, `connections_inspect` |
| `GET /api/users/by-username/{name}` | 1.3.3 | `sync_audit`, `provisioning_diagnose`, `client_resolve` |
| `GET /api/users/stream` | 2.8.0 | `client_resolve` (поиск по telegram id и почте · telegram id and email lookups) |
| `GET /api/users/tags` | 1.6.0 | `client_reach` |
| `GET /api/users/{id}/accessible-nodes` | 2.0.0 | `client_reach` |
| `GET /api/users/{id}/subscription-request-history` | 3.0.0 | `subscription_inspect` |
| `PATCH /api/users` | 1.6.0 | `subscription_ops`, `bulk_ops` |
| `POST /api/users/{id}/actions/{enable,disable,reset-traffic,revoke}` | 3.0.0 (числовой id · numeric id) | `subscription_ops` |
| `POST /api/users/{id}/actions/extend` | 3.0.0 | `subscription_ops` |
| `POST /api/users/bulk/{update,reset-traffic,revoke-subscription,delete}` | 1.5.0 | `bulk_ops` |
| `POST /api/users/bulk/update-squads` | 2.0.0 | `bulk_ops` |
| `POST /api/users/bulk/extend-expiration-date` | 2.3.0 | `bulk_ops` |
| `POST /api/users/bulk/all/update` | 1.5.0 | `bulk_ops` |
| `GET /api/hwid/devices/{id}` · `POST /devices/delete` | 1.5.6 | `client_overview`, `subscription_inspect`, `subscription_ops` |
| `GET /api/hwid/devices/stats` | 2.1.13 | `device_inventory` |
| `GET /api/hwid/devices/top-users` | 2.3.2 | `device_inventory`, `abuse_report` |
| `POST /api/hwid/devices/delete-all` | 2.1.12 | `subscription_ops` |
| `POST /api/connections/by-user/{id}` · `/by-node/{uuid}`, `GET /api/connections/by-user/{jobId}` · `/by-node/{jobId}` | 3.0.0 | `connections_inspect` |
| `GET /api/nodes` · `POST`/`PATCH` · `actions/{enable,disable,restart,reset-traffic}` | 1.3.3 (reset-traffic 1.6.0) | `country_health`, `infra_map`, `node_manage` |
| `GET /api/nodes/tags` | 1.6.0 | `node_config_audit` |
| `GET /api/hosts` · `PATCH` · `DELETE /{uuid}` | 1.3.3 | `country_health`, `infra_map`, `host_edit`, `host_cleanup` |
| `GET /api/config-profiles` · `/inbounds` | 2.0.0 | `infra_map`, `node_manage`, `host_cleanup` |
| `GET /api/config-profiles/{uuid}/computed-config` | 2.2.4 | `node_config_audit` |
| `GET /api/internal-squads` · `/{uuid}/accessible-nodes` | 2.0.0 | `squads_read`, `infra_map`, `traffic_stats` |
| `GET /api/external-squads` | 2.2.0 | `squads_read` |
| `GET /api/bandwidth-stats/nodes` · `/internal-squads/{uuid}/usage` · `/users/{id}` | 2.0.0 | `country_health`, `traffic_stats` |
| `GET /api/bandwidth-stats/nodes/realtime` | константа, обработчика в 3.3.2 нет · constant only, no 3.3.2 handler | `platform_probe`: 404 → `realtime_route_absent` |
| `GET /api/bandwidth-stats/nodes/{uuid}/users` | 2.8.0 | `traffic_stats` |
| `GET /api/node-plugins` · `/{uuid}` · `/torrent-blocker` · `/torrent-blocker/stats` | 2.7.0 | `node_config_audit`, `torrent_reports` |
| `GET /api/infra-billing/providers` · `/nodes` · `/history` | 2.0.0 | `infra_costs` |
| `GET /api/subscription-page-configs` · `/{id}` | 2.4.0 | `subpage_read` |
| `GET /api/snippets` | 2.2.0 | `subpage_read` |
| `GET /api/subscription-request-history` · `/stats` | 2.1.14 | `panel_activity` |
| `GET /api/node-integrations` · `/{uuid}` | 3.3.0 | `node_integrations_read`, `node_config_audit`, `node_manage`, `platform_probe` |
| `GET /api/node-plugins/shared-lists` · `/{name}` | 3.3.0 | `shared_lists_read`, `node_config_audit`, `torrent_reports`, `panel_sync`, `platform_probe` |
| `POST /api/node-plugins/actions/sync` | 3.3.0 | `panel_sync`, `{uuid}`, 202 |
| `POST /api/node-plugins/shared-lists/actions/sync` | 3.3.0 | `panel_sync`, `{name}`, 202 |
| `POST /api/connections/geocheck/{nodeUuid}` · `GET /api/connections/geocheck/{jobId}` | 3.3.0 | `node_geocheck` |

Маршрутов, снесённых в 3.0.0 (`by-telegram-id`, `by-email`, `by-tag`, `by-id`,
`by-subscription-uuid`), здесь нет ни одного: они заменены на `/api/users/stream`
с точными фильтрами, который отвечает 200 и пустым списком вместо 404.

Not one of the routes 3.0.0 removed (`by-telegram-id`, `by-email`, `by-tag`,
`by-id`, `by-subscription-uuid`) appears here: they are replaced by
`/api/users/stream` with exact filters, which answers 200 and an empty list
instead of 404.

<a id="youngest-panel-routes"></a>

## Самые молодые маршруты панели ниже 3.0.0 · The youngest panel routes below the 3.0.0 line

Эти маршруты базовой группы живут в панели с 2.x и раньше. Дополнения 3.3
перечислены отдельно ниже.

These base-group routes have been in the panel since 2.x or earlier. The 3.3
extensions are listed separately below.

| Маршрут · Route | С версии · Since | Кто зовёт · Called by |
|---|---|---|
| `/api/users/stream` | 2.8.0 | `client_resolve` |
| `/api/bandwidth-stats/nodes/{uuid}/users` | 2.8.0 | `traffic_stats` |
| `/api/node-plugins` | 2.7.0 | `node_config_audit`, `torrent_reports` |
| `/api/system/stats/recap` | 2.7.0 | `panel_activity` |
| `/api/subscription-page-configs` | 2.4.0 | `subpage_read` |
| `/api/hwid/devices/top-users` | 2.3.2 | `abuse_report` |
| `/api/snippets` · `/api/external-squads` | 2.2.0 | `subpage_read`, `squads_read` |

<a id="remna-332"></a>

## Remnawave 3.3.2

Контракты сверены с исходниками [3.3.2](https://github.com/remnawave/backend/tree/3.3.2).
Новые возможности появились в [3.3.0](https://github.com/remnawave/backend/releases/tag/3.3.0).
В [3.3.1](https://github.com/remnawave/backend/releases/tag/3.3.1) добавлен
`rulePlacement`, а [3.3.2](https://github.com/remnawave/backend/releases/tag/3.3.2)
убрала его неявное значение `0`. Отсутствующее поле в диагностике остаётся
неизвестным; оно не подменяется нулём.

| Возможность · Feature | Поведение MCP · MCP behavior |
|---|---|
| Host Mapper | `host_edit` принимает `mapper` с `xrayJson`, `mihomo`, `base64`, `singbox` и операциями copy/set/unset. Без поля PATCH сохраняет текущий mapper. Содержимое хранится в локальной резервной копии; план показывает сводку и hash. · Accepts these four formats and operations, preserves an omitted mapper, stores content in a local backup and exposes only its summary/hash. |
| Host cleanup | Полный снимок удаляемых хостов, включая mapper, хранится в закрытой копии; `backupRef` указывает путь и hash. До удаления сверяются копия и текущие хосты. · Full hosts including mapper live in a private backup, with a public `backupRef` path/hash; backup and current hosts are verified before deletion. |
| Node integrations | `node_manage` принимает до 20 `integration_uuids` в заданном порядке. Поздняя интеграция перекрывает раннюю на верхнем уровне. Изменение привязок перезапускает включённую ноду. Интеграции идут отдельно от Xray-конфига. · Up to 20 ordered bindings, later top-level values win; an explicit binding update restarts an enabled node. Integrations travel separately from Xray config. |
| Shared lists | Имена API не содержат `ext:`, ссылки плагинов имеют вид `ext:name`. Превью содержит тип и число элементов; значения не возвращаются. Обрыв чтения означает неизвестные зависимости. · API names omit `ext:`, plugin references use it; summaries expose types/counts, incomplete reads leave dependencies unknown. |
| GeoCheck | `node_geocheck` доступен только human в `ro`. `start` делает POST и сразу возвращает `job_id`; `result` делает один GET. Завершённая задача может содержать `success: false`. · Human-only read-scope diagnostic; start returns immediately, result polls once, queue completion does not imply node success. |
| Sync | `panel_sync` доступен только human в `rw`, через план и подтверждение. План фиксирует подходящие ноды и содержимое источников; изменения до подтверждения требуют нового плана. Ответ 202 означает очередь. · Human-only confirmed mutation with source/membership guards; 202 means queued. |

Синхронизация выбирает ноды с подходящим `activePluginUuid`, для которых
`isDisabled=false`, `isConnected=true`, `isConnecting=false`. После подтверждения
общий конверт имеет `status: "applied"` (вызов выполнен), но вложенный результат
явно содержит `status: "queued"`, `accepted: true`, `completed: false`.
Фактическое применение на нодах этим ответом не подтверждается.

Sync eligibility requires a matching `activePluginUuid` and
`isDisabled=false`, `isConnected=true`, `isConnecting=false`. The confirmation
envelope uses `status: "applied"` for the executed request; its nested result is
explicitly `status: "queued"`, `accepted: true`, `completed: false`. It does not
claim the nodes have already applied the configuration.

```text
node_integrations_read {}
shared_lists_read {"name":"allowed_networks"}
node_geocheck {"action":"start","node_uuid":"00000000-0000-4000-8000-000000000001"}
node_geocheck {"action":"result","job_id":"returned-job-id"}
panel_sync {"target":"shared_list","name":"allowed_networks"}
ops_confirm {"plan_id":"returned-plan-id"}
```

Права чтения новых каталогов: `node-integrations:list/get` и
`node-plugins:shared-lists-list/shared-lists-get`. GeoCheck использует read-scopes
`connections:geocheck` и `connections:geocheck-result`. Синхронизация требует
`node-plugins:sync` или `node-plugins:shared-lists-sync`, а также чтения источников
для плана. 403 не доказывает отсутствие возможности: проверьте права токена.

New catalog reads use `node-integrations:list/get` and
`node-plugins:shared-lists-list/shared-lists-get`. GeoCheck uses the read scopes
`connections:geocheck` and `connections:geocheck-result`. Sync requires
`node-plugins:sync` or `node-plugins:shared-lists-sync` plus source reads for its
plan. A 403 leaves capability availability unknown: check token permissions.

На живой панели 3.3.2 проверены `platform_probe`, `node_integrations_read`,
`shared_lists_read`, `node_config_audit`, `torrent_reports`, `infra_map`.
Каталоги интеграций и общих списков были доступны и пусты. Заполненные каталоги,
новые записи, восстановление mapper и конфликты между планом и подтверждением
проверяются локальными тестами с ответами API. Проверка совместимости не
выполняет записи или задания GeoCheck на живой панели.

`platform_probe`, `node_integrations_read`, `shared_lists_read`, `node_config_audit`,
`torrent_reports` and `infra_map` were checked against a live 3.3.2 panel. Its
integration and shared-list catalogs were accessible and empty. Populated
catalogs, new writes, mapper restoration and plan/confirmation conflicts are
tested with local API fixtures. Compatibility checks do not write to a live panel
or start live GeoCheck jobs.

<a id="shm-30"></a>

## SHM 3.0: две схемы идентичности · SHM 3.0: two identity schemas

Разобрано по исходникам тега `3.0.43` (`app/public_html/shm/v1.cgi`,
`app/lib/Core/User.pm`, `app/lib/Core/User/Logins.pm`,
`app/bin/migrations/3.0.0.sql` и `3.0.38.sql`). На работающей 3.0 **не
проверялось** — всё ниже помечать как прочитанное, а не снятое.

Read off the sources at tag `3.0.43` (files above). **Not** verified against a
running 3.0 — treat everything below as read, not measured.

### Что переехало · What moved

| До 3.0 · Before 3.0 | С 3.0 · From 3.0 |
|---|---|
| `users.login2` (почта И телеграм-логин `@<id>` · email AND the `@<id>` telegram login) | строка `accounts` с `type='email'` · an `accounts` row with `type='email'` |
| `users.phone` | `accounts` с `type='phone'`, номеров может быть НЕСКОЛЬКО · `type='phone'`, and there may be SEVERAL |
| `users.settings.email`, `.email_verified` | `accounts.settings.email.verified`; из `users.settings` миграция их ВЫЧИЩАЕТ · the migration REMOVES them from `users.settings` |
| `users.settings.telegram.user_id` | `accounts` с `type='telegram'`; сам `users.settings.telegram` при этом ОСТАЁТСЯ — шаг 4.3 миграции закомментирован · `users.settings.telegram` STAYS: step 4.3 of the migration is commented out |

`users.login2` миграция `3.0.0.sql` НЕ дропает (DROP закомментирован), но
колонка снята из `Core::User::structure`, то есть API её больше не отдаёт.
`users.phone` дропнута миграцией `3.0.38.sql` по-настоящему, а одноимённое
поле структуры стало ВИРТУАЛЬНЫМ: `list_for_api` склеивает номера клиента из
`accounts` через запятую, а `Core::User::set` пишет их через
`_set_legacy_phone`, который умеет ТОЛЬКО ДОБАВИТЬ номер.

The `3.0.0.sql` migration does not actually drop `users.login2` (the DROP is
commented out), but the column is gone from `Core::User::structure`, so the API
no longer returns it. `users.phone` really is dropped by `3.0.38.sql`, and the
same-named structure field became VIRTUAL: `list_for_api` joins the client's
numbers from `accounts` with commas, and `Core::User::set` writes through
`_set_legacy_phone`, which can ONLY ADD a number.

### Как это видно инструментам · How the tools see it

Схема устанавливается запросом `GET /admin/user/accounts`, а не номером
версии: до 3.0 маршрута в роутере нет, и SHM отвечает собственным
`{"error":"Method not found","status":404}`. Любой другой отказ схему НЕ
устанавливает — это третий исход (`unknown`), а не «старая». Проба и чтение —
ОДИН запрос: сервер не перезапускается в момент миграции, и две разные
стороны перехода могли бы прийтись на два разных запроса. Вердикт «старая»
кэшируется на минуту (`@hq/shm`, `identity.ts`).

The schema is established by calling `GET /admin/user/accounts`, not by reading
a version number: below 3.0 that route is not in the router and SHM answers its
own `{"error":"Method not found","status":404}`. Any other failure does NOT
establish the schema — that is a third outcome (`unknown`), never "the old one".
The probe and the read are ONE request, because the server is not restarted at
the moment of the migration. The "old schema" verdict is cached for a minute.

`accounts.login` — ключ таблицы, поэтому запрос по нему даёт ТОЧНОЕ
совпадение: это единственный способ ответить «этот адрес принадлежит вот
этому клиенту» без догадки. `/admin/user/search` на 3.0 ищет по `accounts`
тоже, но ПОДСТРОКОЙ и в окне, которое расширить больше нельзя (см. ниже).

`accounts.login` is the table key, so asking by it is an EXACT match — the only
way to answer "this address belongs to this client" without a guess.

### Белый список аргументов · The argument whitelist

`v1.cgi` 3.0 объявляет у каждого маршрута схему `params` и собирает вызов
ТОЛЬКО из объявленных полей. Незадекларированный аргумент не отвергается — он
**молча выбрасывается, ответ 200**. Общие списочные параметры (`limit`,
`offset`, `filter`, `sort_*`) впрыскиваются только в GET без собственного
`method` (или с `common_params => 1`).

`v1.cgi` 3.0 declares a `params` schema per route and builds the call from the
declared fields ONLY. An undeclared argument is not rejected — it is **silently
dropped, HTTP 200**. The common list params are injected only into a GET with
no `method` of its own (or with `common_params => 1`).

Что это задевает здесь · What that touches here:

| Вызов · Call | Что выброшено · Dropped | Следствие · Consequence |
|---|---|---|
| `PUT /admin/user/payment` | `uniq_key` | дедуп `Core::User::payment` не срабатывает никогда; `billing_adjust` и `billing_refund_service` проверяют это по ЗАПИСАННОЙ строке и кричат `idempotencyWarning` · the dedupe never fires; both money mutators check the WRITTEN row and shout |
| `GET /admin/user/search` | `limit`, `offset` | окно всегда 25 и не листается; `client_search` говорит `search_limit_ignored` · the window is always 25 and cannot be paged |
| `GET /admin/user/service/spool`, `GET /promo` | `limit` | потолок выбирает SHM, не мы — на ответ не влияет · SHM picks the cap, not us |

`PUT /admin/user/payment` требует `comment` ОБЪЕКТОМ (`type => 'object'`),
строка теперь 400. Здесь он объектом и уезжал всегда — `stampComment` отдаёт
`{msg, hq_plan}`, — потому что колонка `comment` обеих денежных таблиц json.

`PUT /admin/user/payment` now requires `comment` to be an OBJECT; a string
400s. It has always gone out as an object here.

`POST /admin/user/pay` не существует ни в 3.0.43, ни в 2.19.14 — у
`/admin/user/pay` объявлены только GET и DELETE. Ни один инструмент его не
зовёт.

`POST /admin/user/pay` exists in neither 3.0.43 nor 2.19.14. No tool calls it.

`/user/email/verify` в 3.0.43 снят; его заменяет `POST /user/email`. Ни один
инструмент здесь не зовёт ни тот, ни другой: `client_account_state` читает
`GET /user/email`, а он с 3.0 отдаёт СПИСОК адресов (`get_emails`), а не один.

`/user/email/verify` is gone in 3.0.43, replaced by `POST /user/email`. No tool
here calls either: `client_account_state` reads `GET /user/email`, which from
3.0 returns a LIST of addresses (`get_emails`), not one.

### Почта и телефон в колонке, которая зовётся `login` · PII under a field named `login`

`@hq/redact` маскирует PII **по имени поля** (`email`, `phone`, `login2`,
`full_name`). В `accounts` почта и телефон лежат в колонке `login`, под это
правило не попадающей, — и попасть она не должна: под тем же именем ездит
безобидный `users.login`, который печатают все клиентские инструменты.
Поэтому строка `accounts` раскладывается по полям ПО ТИПУ: `email` для
`type='email'`, `phone` для `type='phone'`, `login` для остальных
(`@hq/shm`, `normalizeAccount`). `settings` строки наружу не отдаётся вовсе —
у типа `login` там лежит `password.hash`.

`@hq/redact` masks PII **by field name**. In `accounts` the email and the phone
live in a column called `login`, which that rule does not cover — and must not,
because the harmless `users.login` travels under the same name. So an
`accounts` row is split by TYPE into the field names the redactor understands.
The row's `settings` is never returned: for `type='login'` it holds
`password.hash`.

### Осталось человеку · Left for a human

- `sql_query` — предполётный денилист колонок в шапке модуля называет
  `users.password` и `users.settings`; на 3.0 к ним добавляется
  `accounts.settings` (там `password.hash`). Инструмент SQL не исполняет, так
  что это долг на момент, когда исполнение включат.
- Проверить всё вышеперечисленное на РАБОТАЮЩЕЙ 3.0: здесь оно прочитано по
  исходникам.

- `sql_query`'s preflight column denylist names `users.password` and
  `users.settings`; on 3.0 `accounts.settings` joins them (it holds
  `password.hash`). The tool executes no SQL, so this is a debt for the day
  execution is wired.
- Verify all of the above against a RUNNING 3.0: here it is read off sources.

<a id="fork"></a>

## Требуется ли форк SHM · Does this need a forked SHM

Нет. Развёртывание, на котором это проверялось, — апстримная **2.19.4** плюс
одиннадцать патченых файлов, и ни один инструмент от этих патчей не зависит:
маршрутизатор `v1.cgi` в них не тронут вовсе, набор маршрутов байт в байт
совпадает с апстримным тегом.

Единственное место, где патч был *виден* инструменту, — `GET /user/password-auth`:
апстримный `Core::User::api_password_auth_status` отдаёт три флага
(`password_auth_disabled`, `passkey_enabled`, `otp_enabled`), четвёртый
(`password_set_by_user`) существует только там, где его дописали. Раньше его
отсутствие было неотличимо от съеденного редакцией значения, и установка на
официальной SHM получала совет чинить работающий механизм. Теперь
`client_account_state` называет это отдельно: `pwdSetByUser` приезжает `null`, а
рядом стоит предупреждение **`sign_in_flag_absent`** — «эта SHM такого не
сообщает», а не «пароль выдан автоматом». Всё остальное в ответе не задето.

Остальные патчи того развёртывания (realtime-публикация SSE/WS, `EVAL_PERL=0` в
шаблонизаторе, лимит попыток входа, токен сброса пароля только на почту
аккаунта, скоуп `key_mul` у `user_services`, правки телеграм-авторизации) на
читаемую этим сервером поверхность не влияют: часть из них ужесточает то, чего
инструменты и так не делают, часть живёт вне HTTP-API вовсе.

---

No. The deployment this was verified against is upstream **2.19.4** plus eleven
patched files, and no tool depends on any of them: the `v1.cgi` router is not
touched at all, and the route set is byte-for-byte the upstream tag's.

The one place a patch was ever *visible* to a tool is `GET /user/password-auth`.
Upstream `Core::User::api_password_auth_status` returns three flags
(`password_auth_disabled`, `passkey_enabled`, `otp_enabled`); a fourth,
`password_set_by_user`, exists only where someone added it. Its absence used to
be indistinguishable from a value eaten by redaction, so an install on official
SHM was advised to go fix a mechanism that works. `client_account_state` now
names the two apart: `pwdSetByUser` comes back `null` next to a
**`sign_in_flag_absent`** warning meaning "this SHM does not report it", never
"the password was generated for them". Nothing else in the answer is affected.

That deployment's other patches — realtime SSE/WS publication, `EVAL_PERL=0` in
the template engine, a login attempt limit, password-reset tokens delivered only
to the account's own address, a `key_mul` scope on `user_services`, Telegram auth
fixes — do not touch the surface this server reads: some of them tighten things
these tools never do, and some live outside the HTTP API entirely.

<a id="fitting"></a>

## Подгонка под свою установку · Fitting it to your installation

Апстримный `danuk/shm` не знает слова «Remnawave» — ни строки. Мост между
биллингом и панелью живёт целиком в *ваших* шаблонах провижининга, и его
конвенция — единственный ключ, связывающий услугу с учёткой в панели: один
пользователь панели на **user_service_id**, а не на клиента; имя пользователя —
`<NAME_PREFIX><user_service_id>`; снимок его конфигурации — в storage SHM под
ключом `<STORAGE_PREFIX><user_service_id>`, а числовой `id` из панели лежит в
нём как `response.id`. Оба префикса шаблон *вычисляет*, а не фиксирует:

```
STORAGE_PREFIX = config.remnawave.storage_prefix || "vpn_mrzb_"
NAME_PREFIX    = config.remnawave.name_prefix    || "HQVPN_"
```

Сервер читает тот же ключ в рантайме (`GET /admin/config/remnawave`) и следует
тому, что говорит ваша SHM, откатываясь на умолчания самого шаблона, когда ключа
нет, — а это обычный случай. `HQ_MCP_STORAGE_PREFIX` и `HQ_MCP_PANEL_PREFIXES`
переопределяют оба, и стоят они *выше* этого чтения намеренно: ключ
конфигурации описывает, что SHM соберёт завтра, а оператор описывает, что в
панели лежит сегодня, — учётки, переименованные, но не мигрированные, или всё
ещё живой старый префикс. `HQ_MCP_PANEL_PREFIXES` принимает список целиком,
текущий префикс первым: этот порядок решает, какую из двух учёток, называющих
одну услугу, считать каноничной.

Префикс, не совпадающий ни с чем, не даёт ошибки — он даёт уверенный неверный
ответ, в котором каждая услуга выглядит непровижиненной. Поэтому инструменты,
способные это *доказать*, говорят об этом кодом **`prefix_unverified`** и
подавляют затронутую находку вместо того, чтобы её вернуть: `sync_audit` — когда
панель прочитана и разобрана, у SHM есть активные услуги, и при этом ни одно имя
в панели не построено ни одним известным префиксом (корзина `missingPanelUser`
тогда не возвращается вовсе); `provisioning_diagnose` — когда имя, записанное
*собственным* провижинингом SHM и прочитанное из снимка storage, не строится ни
одним настроенным префиксом, либо `panel_username_guessed`, когда снимка не было
и имя пришлось перебирать.

Наследные префиксы прицепляются только тогда, когда каноничный пришёл из
встроенного умолчания: установка, объявившая свой `name_prefix`, тем самым
объявила, что её имена строятся не как наши, и одолжить ей нашу историю значило
бы разобрать сделанный руками `us_2024` в «услугу 2024» и положить его в корзину
с рекомендацией «удалить эту учётку».

---

Upstream `danuk/shm` does not contain the word "Remnawave" anywhere. The bridge
between the billing and the panel lives entirely in *your* provisioning
templates, and its convention is the only key that ties a service to a panel
account: one panel user per **user_service_id**, not per client; the username is
`<NAME_PREFIX><user_service_id>`; a snapshot of its configuration goes into SHM
storage under `<STORAGE_PREFIX><user_service_id>`, with the panel's numeric `id`
inside it as `response.id`. The template *computes* both prefixes rather than
fixing them:

```
STORAGE_PREFIX = config.remnawave.storage_prefix || "vpn_mrzb_"
NAME_PREFIX    = config.remnawave.name_prefix    || "HQVPN_"
```

The server reads that same key live (`GET /admin/config/remnawave`) and follows
whatever your SHM says, falling back to the template's own defaults when the key
is absent — which is the common case. `HQ_MCP_STORAGE_PREFIX` and
`HQ_MCP_PANEL_PREFIXES` override both, and they sit *above* the live read on
purpose: the config key describes what SHM will build tomorrow, an operator
describes what the panel holds today — accounts renamed but never migrated, or
an older prefix still in use. `HQ_MCP_PANEL_PREFIXES` takes the full list,
current prefix first, because that order decides which of two accounts naming
the same service is treated as canonical.

A prefix that matches nothing does not produce an error — it produces a
confident wrong answer in which every service looks unprovisioned. So the tools
that can *prove* it has happened say so with the warning code
**`prefix_unverified`** and suppress the affected finding instead of returning
it: `sync_audit` when the panel was read and parsed, SHM has active services,
and not one panel name is built by any known prefix (its `missingPanelUser`
bucket is then withheld rather than reported); `provisioning_diagnose` when the
username written by SHM's *own* provisioning and read out of the storage
snapshot is a name no configured prefix builds, or `panel_username_guessed` when
there was no snapshot and the name had to be guessed.

Legacy prefixes are attached only when the canonical one came from the built-in
default: an installation that declares its own `name_prefix` has declared that
its names are not built like ours, and lending it our history would parse a
hand-made `us_2024` into "service 2024" and file it under "delete this account".
