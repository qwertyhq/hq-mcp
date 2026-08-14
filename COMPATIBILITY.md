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

Минимумы · Floors: **SHM 2.18.0**, **Remnawave 3.0.0**.
Проверено на · Verified against: **SHM 2.19.4**, **Remnawave 3.2.3**.

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
| `GET /api/connections/by-user/{id}` · `/by-node/{uuid}` | 3.0.0 | `connections_inspect` |
| `GET /api/nodes` · `POST`/`PATCH` · `actions/{enable,disable,restart,reset-traffic}` | 1.3.3 (reset-traffic 1.6.0) | `country_health`, `infra_map`, `node_manage` |
| `GET /api/nodes/tags` | 1.6.0 | `node_config_audit` |
| `GET /api/hosts` · `PATCH` · `DELETE /{uuid}` | 1.3.3 | `country_health`, `infra_map`, `host_edit`, `host_cleanup` |
| `GET /api/config-profiles` · `/inbounds` | 2.0.0 | `infra_map`, `node_manage`, `host_cleanup` |
| `GET /api/config-profiles/{uuid}/computed-config` | 2.2.4 | `node_config_audit` |
| `GET /api/internal-squads` · `/{uuid}/accessible-nodes` | 2.0.0 | `squads_read`, `infra_map`, `traffic_stats` |
| `GET /api/external-squads` | 2.2.0 | `squads_read` |
| `GET /api/bandwidth-stats/nodes` · `/nodes/realtime` · `/internal-squads/{uuid}/usage` · `/users/{id}` | 2.0.0 (realtime 1.5.2) | `country_health`, `traffic_stats`, `platform_probe` |
| `GET /api/bandwidth-stats/nodes/{uuid}/users` | 2.8.0 | `traffic_stats` |
| `GET /api/node-plugins` · `/{uuid}` · `/torrent-blocker` · `/torrent-blocker/stats` | 2.7.0 | `node_config_audit`, `torrent_reports` |
| `GET /api/infra-billing/providers` · `/nodes` · `/history` | 2.0.0 | `infra_costs` |
| `GET /api/subscription-page-configs` · `/{id}` | 2.4.0 | `subpage_read` |
| `GET /api/snippets` | 2.2.0 | `subpage_read` |
| `GET /api/subscription-request-history` · `/stats` | 2.1.14 | `panel_activity` |

Маршрутов, снесённых в 3.0.0 (`by-telegram-id`, `by-email`, `by-tag`, `by-id`,
`by-subscription-uuid`), здесь нет ни одного: они заменены на `/api/users/stream`
с точными фильтрами, который отвечает 200 и пустым списком вместо 404.

Not one of the routes 3.0.0 removed (`by-telegram-id`, `by-email`, `by-tag`,
`by-id`, `by-subscription-uuid`) appears here: they are replaced by
`/api/users/stream` with exact filters, which answers 200 and an empty list
instead of 404.

<a id="youngest-panel-routes"></a>

## Самые молодые маршруты панели ниже 3.0.0 · The youngest panel routes below the 3.0.0 line

Всё остальное, что зовут инструменты, живёт в SHM с 1.x, а в панели — с 2.x и
раньше.

Everything else these tools call has been in SHM since 1.x and in the panel
since 2.x or earlier.

| Маршрут · Route | С версии · Since | Кто зовёт · Called by |
|---|---|---|
| `/api/users/stream` | 2.8.0 | `client_resolve` |
| `/api/bandwidth-stats/nodes/{uuid}/users` | 2.8.0 | `traffic_stats` |
| `/api/node-plugins` | 2.7.0 | `node_config_audit`, `torrent_reports` |
| `/api/system/stats/recap` | 2.7.0 | `panel_activity` |
| `/api/subscription-page-configs` | 2.4.0 | `subpage_read` |
| `/api/hwid/devices/top-users` | 2.3.2 | `abuse_report` |
| `/api/snippets` · `/api/external-squads` | 2.2.0 | `subpage_read`, `squads_read` |

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
