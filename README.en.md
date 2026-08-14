# hq-mcp

[Русская версия](README.md) · English

An MCP server that gives an AI agent access to a VPN business: billing in
[SHM](https://github.com/danuk/shm) and the panel in
[Remnawave](https://github.com/remnawave/backend), stitched together so questions
that span both systems can be answered in one call.

No tool changes anything on the call that asks for it: a writer answers with a
plan first, and applying is a second call that carries the plan's id.

## What this looks like in use

The first call on any install is `platform_probe`. It says what this deployment
has at all and which of it is alive; everything else here is downstream of what
it reports. The answers below are trimmed and the values are made up.

```
platform_probe {}
```
```json
{
  "shm":   { "configured": true, "reachable": true, "version": "2.19.4", "live": true },
  "remna": { "configured": true, "reachable": true, "version": "3.2.3",
             "runtime": { "instances": 6, "youngestUptimeSeconds": 54294 } },
  "capabilities": { "shm.filter": false, "remna.realtimeBandwidth": true,
                    "tunnel.mysql": false, "…": "…" },
  "warnings": [{ "code": "specs_are_stale", "message": "…" }]
}
```

Then a question neither system answers on its own: "the client says they paid
and there is no config".

```
client_resolve { "query": "kot@example.com" }
```
```json
{
  "shm":   { "count": 1, "matches": [{ "user_id": 4821, "email": "kot@example.com",
                                      "blocked": false }] },
  "remna": { "count": 0, "ambiguous": false,
             "paths": [{ "path": "email",   "tried": true, "found": 0, "note": null },
                       { "path": "service", "tried": true, "found": 0, "note": "…" }] }
}
```

The panel knows nothing about them — but `count: 0` here is not "there is no
account": `paths` names every lookup that ran and what it cannot see. What
actually happened takes a second pair of eyes:

```
provisioning_diagnose { "shm_user_id": 4821 }
```
```json
{
  "verdict": "panel_user_missing",
  "services": { "items": 1, "diagnosed": [{
    "user_service_id": 90210,
    "status": "ACTIVE",
    "verdict": "panel_user_missing",
    "storage": { "name": "vpn_mrzb_90210", "present": true, "checked": true },
    "panel":   { "username": "HQVPN_90210", "id": 11274, "found": false, "checked": true },
    "spool":   { "total": 0, "stuck": 0, "failed": 0, "succeeded": 0 },
    "history": { "total": 1, "success": 1 }
  }] }
}
```

The service is ACTIVE, the configuration snapshot is there, provisioning
reported success — and the user that success belongs to does not exist in the
panel. Neither system shows that on its own.

Thirty-four tools read across both systems. `rw` mode adds fifteen writers:
thirteen change live data, one applies a plan, and one reads the local mutation
journal.

## Why composite tools instead of endpoint proxies

The obvious design is one tool per HTTP endpoint — roughly 150 of them. That was
tried and abandoned, for two reasons.

A raw proxy tool voids every allowlist you write. If the model can call
`GET <any path>`, then the list of operations you decided to forbid is
decoration: the forbidden path is one string away. The tools here call named
routes and a build-time scanner fails the suite if a source file hardcodes a
forbidden one.

And an endpoint is not a question. The example above touches four SHM routes and
two panel routes, and the interesting part is the *join*. `client_overview`,
`sync_audit` and `provisioning_diagnose` exist because that seam is where the
bugs live.

## The design rule that shaped everything

**An empty answer must never be mistaken for a proven absence.**

When a backend fails, the tool degrades: the failure lands in `degraded`, a
`partial_result` warning says which half is missing, and any finding that
depended on the missing half is *suppressed* rather than computed from what
survived. When a list is truncated, the server-side total comes back with it, so
"there is no such service" cannot rest on an unannounced window.

This is not theoretical caution. During development, one tool read the panel
listing in full, discarded every record in it because a field had been renamed
upstream, and then reported most of the client base as needing to be
re-provisioned — a destructive recommendation, stated confidently, derived from
an empty set. The fix was not only the renamed field: it was that a bucket
computed from unusable input must refuse to be a finding.

## Compatibility: will this work on your install

Verified against **SHM 2.19.4** and **Remnawave 3.2.3** — both numbers read off
the running deployment, not asserted from a specification.

**The floors are SHM 2.18.0 and Remnawave 3.0.0.** The official `danuk/shm`
qualifies: every route these tools call is an upstream route, and no fork is
needed. The one place a patch on that deployment was ever *visible* to a tool is
the fourth flag of `GET /user/password-auth`; its absence is now reported as the
warning `sign_in_flag_absent` rather than passed off as a diagnosis. The full
route list for both systems, the release each route first appeared in, and the
long answer about forks are in [COMPATIBILITY.md](COMPATIBILITY.md).

Checking takes one call — the same `platform_probe`. When a version is below its
floor it answers with a `backend_version_below_minimum` warning naming the
version, the floor and exactly what breaks. Nothing is switched off by that: an
older backend produces *loud* refusals on specific routes, never quiet empty
answers.

| Version | What disappears | Who is affected |
|---|---|---|
| SHM < 2.18.0 | `GET /healthcheck`, the one unauthenticated route | `platform_probe` only: `shm.live` stays `null` and "the billing is down" stops being distinguishable from "the password is wrong" (`shm_healthcheck_route_absent`). No other tool is touched |
| SHM < 2.11.3 | `GET /admin/user/search` | `client_search`, `client_resolve` — a refusal, not an empty list |
| SHM < 2.9.0 | `GET /user/referrals` | `client_account_state` loses the referral count |
| SHM < 2.4.0 | `GET /user/email` | `client_account_state` loses the address and its verified flag |
| Panel < 3.0.0 | users are addressed by `uuid`, not by a numeric `id` | `client_overview`, `subscription_inspect`, `traffic_stats`, `provisioning_diagnose`, `subscription_ops`: `/api/users/{id}` is rejected by validation with 400 |
| Panel < 3.0.0 | no `/api/connections/*` | `connections_inspect`, the whole tool |
| Panel < 3.0.0 | no `POST /api/users/{id}/actions/extend` | `subscription_ops` loses per-user extension (only the bulk route remains) |
| Panel < 3.0.0 | no `/api/system/stats/digest` and `/stats/http` | `panel_activity` loses two of its five reads |
| Panel < 3.2.0 | no `GET /api/system/configuration` | `platform_probe` only: the `remna.subscriptionRequestHistory` capability stays `unknown` — deliberately, not `false` |

**Remnawave 3.x is a breaking change for anything written against 2.x, and it
does not break loudly.** The release removed `uuid` from the user object,
together with the `by-telegram-id`, `by-email` and `by-tag` lookup routes. Code
written against a 2.x spec addresses users by a field that no longer exists,
through routes that no longer answer — and `/api/users/{uuid}` replies 400, not
404, so the failure does not even look like "no such user". None of those routes
are called here; wherever this server still meets a legacy `uuid` (an old SHM
storage snapshot, for instance) it says so in the answer rather than silently
falling back to a guess.

Whatever OpenAPI file you hold for either system lags the running code, which is
why `platform_probe` carries the `specs_are_stale` warning on every call. SHM's
own specification makes that worse than usual: it stamps `info.version` from the
`_shm` config row at runtime, so the version in a dumped spec describes whichever
stand produced the dump, not yours. The probe therefore does not read versions
from files at all — it asks the live systems, and while it is there it
establishes what is true of *this* deployment: whether SHM's server-side `filter`
narrows anything, whether the panel honours `filters` on the user listing (both
answer 200 and silently drop unknown parameters), whether the panel records
subscription-request history, whether the realtime bandwidth route exists, and
which ssh tunnels are open. It also separates "the backend is down" from "our
credentials are wrong": a 401/403 is reported as `credentialsRejected` rather
than as an outage.

## Install

Requires Node 22.12+ and pnpm, **and at least one of the two systems** — SHM or
Remnawave. Both are not required: each is configured separately, and either one
alone is a complete configuration. Tools belonging to a system you do not have
are not published at all — they do not answer emptily, they are absent, and
`platform_probe` says plainly which backends are configured. So the tool count
depends on the deployment: panel only 16, SHM only 18, both 34 (more in `rw`).

```bash
pnpm install
pnpm build
pnpm run setup
```

> `pnpm run setup`, with the `run`. `pnpm setup` is a built-in command of pnpm
> itself — it edits your shell profile and never reaches this repository.

The wizard exists because the step it replaces — writing `.env` by hand — fails
quietly: a typo in the panel token does not stop the server from starting, and
surfaces later as a tool error in the middle of an unrelated question. So it
**checks every credential against the live system** and tells three failures
apart — the host never answered (DNS, TLS, a closed port), the host answered and
rejected the credentials, the host answered something that proves nothing (502,
429) — because those need different fixes, and a single "login failed" would send
you to fix the wrong one.

It asks only about the system you actually have, and about the access mode;
everything else sits behind one `Configure the optional settings? [y/N]`. The
timezone it reads off the live SHM rather than guessing: SHM writes dates in its
own local time with no offset, and a wrong zone shifts every age silently. It
never echoes a secret. It defaults to `ro`; `rw` takes the word `rw` and then a
separate yes, after it names how many tools appear and how many of them write to
live billing and the live panel, counted from the registry at that moment. It
writes `.env` with mode 0600 over a backup of the previous file, carrying over
variables it never asked about. It prints the client commands for Claude Code,
Codex and opencode but does not edit those config files: a wizard that rewrites
JSONC eventually breaks someone's working setup. Re-run it any time — Enter keeps
the existing value. Without a terminal it refuses to run: an MCP client starts
the *server* with no TTY, and a wizard that could wake up there would block on a
question nobody can see.

### By hand instead

```bash
cp .env.example .env && chmod 600 .env    # then fill it in
```

Every variable is documented in `.env.example`. A missing or malformed one fails
at startup naming the variable and what it expects, rather than surfacing later
as a confusing tool error.

```json
{
  "mcpServers": {
    "hq": {
      "command": "node",
      "args": ["/absolute/path/to/hq-mcp/apps/stdio/dist/index.js"]
    }
  }
}
```

### The second transport: MCP over HTTP

The same tools are reachable over HTTP, which is what you need when the client
cannot spawn a process itself: it runs in a container, on another machine, or
there is more than one of it. A separate application, configured from the same
`.env`:

```bash
# the label is yours (it is what /metrics shows), the token is at least 24
# characters: openssl rand -hex 24
HQ_MCP_HTTP_TOKENS='<label>:<token>' pnpm --filter @hq/http start
# hq-mcp http ready: url=http://127.0.0.1:42480 mode=ro profile=human tools=34 …
```

Without `HQ_MCP_HTTP_TOKENS` it does not start at all, and it refuses before it
builds any client to the billing or the panel. It binds loopback; opening it to
the network is `HQ_MCP_HTTP_HOST=0.0.0.0`, which prints a warning, because that
token is then the only thing between the server and the network. The port is
`HQ_MCP_HTTP_PORT`. A client connects to `/mcp` and presents the token as an
ordinary `Authorization: Bearer` header:

```json
{
  "mcpServers": {
    "hq": {
      "type": "http",
      "url": "http://127.0.0.1:42480/mcp",
      "headers": { "Authorization": "Bearer <the same token>" }
    }
  }
}
```

The route is sessionless: no `Mcp-Session-Id` is issued or required, so several
copies of the process can sit behind a reverse proxy without sticky connections.
It has no server-initiated messages, so `GET` for an SSE stream and `DELETE` for
session termination answer 405 — an MCP client understands that. A request
carrying an `Origin` header is refused with 403: that is the DNS-rebinding
defence, see "Limitations".

The neighbouring `/v1/tools` is not MCP but an internal REST facade for the
support bot: one listing route and one call route, with their own response
envelope and their own request allowance.

### Fitting it to your installation

Upstream `danuk/shm` does not contain the word "Remnawave" anywhere. The bridge
between the billing and the panel lives entirely in *your* provisioning
templates: one panel user per **user_service_id**, named
`<NAME_PREFIX><user_service_id>`, with a configuration snapshot in SHM storage
under `<STORAGE_PREFIX><user_service_id>`. The server reads both prefixes live
from your SHM's `config.remnawave` and lets you override them
(`HQ_MCP_STORAGE_PREFIX`, `HQ_MCP_PANEL_PREFIXES`) — an operator knows what the
panel holds today better than a config key describing what SHM will build
tomorrow.

The panel username is the only join key, and a prefix that matches nothing does
not produce an error: it produces a confident wrong answer in which every service
looks unprovisioned. So the tools that can *prove* it has happened say so with
the code **`prefix_unverified`** and suppress the affected finding —
`sync_audit` withholds its `missingPanelUser` bucket entirely,
`provisioning_diagnose` marks its result with the same code or with
`panel_username_guessed`. Exactly three tools need the convention (`sync_audit`,
`provisioning_diagnose` and the `storage_edit` mutator); `client_overview` takes
`remna_user_id` as an optional argument and without it simply leaves the panel
half empty. If you have no such convention, every other tool works as usual and
these three do not invent findings. The full account, with prefix ordering and
legacy names, is in [COMPATIBILITY.md](COMPATIBILITY.md#fitting).

## The tools

Thirty-four are visible in `ro`; `rw` adds the fifteen in the last table and
takes nothing away. The counts are for the `human` profile; what `bot` sees is in
the safety model below.

**Platform and one client**

| Tool | Answers |
|---|---|
| `platform_probe` | What is live right now: versions, capabilities, tunnels, and whether a failure is an outage or a credential |
| `client_resolve` | Any identifier (telegram id, email, login, id, panel username) into the canonical ids of both systems — every match, not the first |
| `client_search` | Find SHM clients by a fragment, with the server-side match count |
| `client_overview` | One client across both systems in a single call |
| `client_account_state` | How the account signs in: email and its verification, OTP, passkeys, whether password login is possible, referrals |
| `client_billing_view` | Money as the *client* sees it: the upcoming charge, the payment methods actually offered to them |
| `client_catalog_view` | The catalogue and promo codes as one client sees them — their discount, their bonus balance, the tariffs hidden from them |

**Money, catalogue, configuration**

| Tool | Answers |
|---|---|
| `billing_ledger` | Payments, bonuses, charges, and two independent reconciliations (balance and bonus are separate columns with separate update paths) |
| `autopay_inspect` | Recurring-payment state and every fee withheld — it lives in the JSON `comment` of payment rows, not in `user.settings` |
| `promo_read` | Promo codes and their redemptions, which are different rows and must not be read off one |
| `catalog_read` | Tariffs, the order price list, child services, the event map, categories — the source of valid `service_id` values |
| `config_read` | One SHM configuration key from a fixed allowlist, secrets masked. Reading the configuration wholesale does not exist |
| `template_read` | The list of templates, or the body of exactly one — the file that actually produces a notification or a provisioning script |

**Services and provisioning**

| Tool | Answers |
|---|---|
| `service_inspect` | One client's services: status, expiry, the scheduled next tariff, the spool tasks attached to each |
| `spool_inspect` | The provisioning queue: stuck, failed, paused, and the real depth |
| `provisioning_diagnose` | "Paid, but there is no config" — per service, not per client |
| `sync_audit` | Batch reconciliation of billing against the panel, both sides paged to completeness |
| `notify_history` | Whether the client was actually told, and if not, why — the delivery verdict nothing else surfaces |
| `server_inventory` | SHM's own transports and groups (ssh, http, mail, telegram) and the breaks that stop provisioning silently. Not the Remnawave node list |

**The panel** — first from the client's side, then from the fleet's

| Tool | Answers |
|---|---|
| `subscription_inspect` | The Remnawave card: status, expiry, traffic, HWID devices, recent subscription requests. Never the keys |
| `subpage_read` | What the subscription page actually shows a client: platforms, apps, install steps, button links |
| `client_reach` | Which nodes this client can actually reach, and which squads and inbound tags grant it |
| `device_inventory` | The HWID picture for the whole fleet — the baseline a per-client device count is meaningless without |
| `traffic_stats` | Traffic per day by node and by squad; the time series, not the card's running counters |
| `connections_inspect` | Who is connected right now. The panel answers this with a job, and the tool owns the polling |
| `infra_map` | Nodes × config profiles × inbounds × hosts × squads, and the gaps between them |
| `infra_costs` | What the infrastructure costs, joined against the panel: a billed node nobody reaches is money going out |
| `country_health` | Nodes, online users, traffic and hosts for one country |
| `node_config_audit` | What a profile declares against what the panel would actually hand the node |
| `squads_read` | Both squad families: internal squads decide reach, external ones decide how the subscription is presented |
| `panel_activity` | What is happening to the panel itself: recap, digest, which routes are hit, subscription request history |
| `torrent_reports` | Torrent-blocker evidence — and, separately, whether the blocker is even installed and watching |

**Behind a tunnel** (these two refuse without one, with the exact ssh command)

| Tool | Answers |
|---|---|
| `abuse_report` | The anti-abuse hook's findings plus the panel tops. Expensive: unbounded scans over the billing's own MySQL, capped at 5 calls per 5 minutes |
| `sql_query` | Read-only SQL — preflight only, see below |

**Writers** (`rw` only, `human` profile only, plan first)

| Tool | Changes |
|---|---|
| `billing_adjust` | An SHM client's balance or bonuses |
| `billing_refund_service` | Refunds a service to the balance, for the sum SHM recorded as withdrawn for the current paid period |
| `bulk_ops` | Bulk operations over panel clients — by a named id set, or fleet-wide |
| `host_edit` | One Remnawave host: remark, address, port, SNI/host/path/ALPN/fingerprint, security layer, tags, enable/hide |
| `host_cleanup` | Deletes hosts by an explicit uuid list. Irreversible |
| `node_manage` | One node: enable, disable, restart, reset_traffic, update, create |
| `subscription_ops` | One panel subscription: enable, disable, extend, reset_traffic, revoke, set_limits, device removal |
| `service_lifecycle` | A client's service: give, touch, change_plan, schedule_change, stop, activate, delete |
| `provisioning_repair` | Retry, resume or pause one stuck spool task |
| `template_edit` | Overwrites the body of an existing SHM template |
| `storage_edit` | Writes SHM user storage, from a key list derived from this installation |
| `server_edit` | An SHM transport row or transport group — webhooks, the ssh provisioning endpoint, mail senders |
| `user_flags` | Blocks a client, or edits the safe card fields (`full_name`, `phone`, `comment`) |
| `ops_confirm` | Applies a plan by its `plan_id`. Writes whatever the planned tool writes |
| `ops_audit` | Nothing. It reads the local mutation journal — `rw` because the journal is part of the mutation surface |

## Mutations

**Nothing is applied by the call that asks for it.** A mutator without `plan_id`
reads the current state, builds the target state, and returns a plan: `before`,
`after`, a field-level `diff`, the side effects, a `rollback` where one exists,
and an id. It writes nothing. Applying is a second call:

```
ops_confirm { "plan_id": "…" }          # or: the same mutator, the SAME arguments, plus plan_id
```

The plan is bound to the **profile** that built it, the **tool** it was built
for, and a hash of the **arguments**: it cannot be redeemed by a different
caller, a different tool, or the same tool with one number changed. It expires in
10 minutes. The one-shot property is an atomic `rename` on disk, not a
read-then-delete: of twenty concurrent confirmations exactly one wins and the
rest get "not found". A *refusal* never burns a valid plan — every check runs
after the claim, and a failing check renames it back; what consumes it is the
attempt itself, so if the backend fails the plan is gone. That is deliberate, and
it is the difference between one charge and three. Before applying, the tool
re-reads the world and compares it against the snapshot the plan was built from:
if the object drifted, the plan is rejected rather than applied over the change.

**Every attempt is journaled** to `HQ_MCP_AUDIT_PATH` (JSONL, one line per
attempt, `.hq-mcp/audit.jsonl` by default, file mode 0600): who ran what, with
which arguments, what the object looked like before and after, and how it ended —
`planned`, `applying`, `applied`, `failed` or `rejected`, refusals on the same
footing as successes. `applying` is written *before* the backend is touched and
is the whole point of the design: a record with no terminal pair means a process
died mid-write, the plan snapshot is already gone, and the money may already have
moved. `ops_audit` scans the entire journal for those unclosed records regardless
of the window you asked for, and reports them first. Lines it cannot parse are
counted, not skipped.

**Ceilings are enforced by the framework, not by the tool author.** A mutation
above `HQ_MCP_MAX_OP_AMOUNT` is refused before a plan is built, and the framework
refuses to even *register* a tool that declares a money endpoint without saying
how to read the amount out of its input. The ceiling covers both kinds of money
movement, and the second is easy to forget: payments and bonuses, where the
caller names the sum, and lifecycle actions that spend the client's balance
(`give`, `touch`, `change_plan`, `activate`), where the sum is the tariff price
and the plan has to read it from the catalogue. A plan whose price could not be
read is refused — not knowing the number does not make the charge free.
`HQ_MCP_MAX_BULK_USERS` bounds how many panel clients one bulk operation may
touch, and a plan that cannot establish that number from the panel is refused
rather than estimated. Over the ceiling the operation is rejected whole — never
truncated to fit.

The ceiling is checked **when the plan is built, and only there**: applying works
off the plan already built and does not measure it again. That is not a way
around the ceiling — the arguments are pinned by hash — but a ceiling lowered in
`.env` after a plan was issued does not apply to that plan.

**`template_edit` and `storage_edit` write their own rollback first**, to
`HQ_MCP_BACKUP_DIR` (0700 directory, 0600 files); the path comes back in the
answer, `restore_from` puts the bytes back, and neither tool writes when it
cannot take that snapshot. The backup is separate from the plan snapshot on
purpose: template bodies and configuration snapshots carry secrets as bare
substrings with no key name to redact, so they must never travel back to the
model inside `before`/`rollback` — and a rollback has to outlive a shift, while
plan snapshots are swept within the hour.

Two more things the writers refuse to do. A body carrying `<redacted:…>` markers
is never written back: that is the output of a read tool, and writing it would
replace a live credential with the word that hid it. And raw panel blobs
(`finalMask`, `xhttpExtraParams`, `muxParams`, `sockoptParams`) are excluded from
every host patch — on a real fleet a sizeable share of hosts carry a working
Hysteria2 password inside `finalMask`.

### What has actually been proven, and what has not

`host_edit` is the only mutator whose **apply** branch has been run against a
working system: a host's remark was changed on a running Remnawave 3.2.3 panel,
then verified — the password in `finalMask` had survived, nothing beyond the
declared field had moved — and rolled back. Every other mutator is proven **as
far as the plan**: the plan is built against data read out of running systems and
the applier is covered by tests, but its apply branch has never run against a
working system.
Read that as it is written. A plan that looks right is evidence about the plan.

## Safety model

**Two profiles.** `human` is a trusted operator and gets specific, actionable
refusals — including the exact ssh command when a tunnel is closed. `bot` is an
untrusted channel: every refusal collapses into one uniform message, so the tool
registry cannot be enumerated by probing for which names answer differently. No
writer is ever offered to `bot`; in `rw` the bot profile sees the same twenty
read tools it sees in `ro`.

**A forbidden class, separate from merely dangerous.** These are not gated — they
are absent, and a build-time scanner fails the suite if a source file so much as
hardcodes one of their paths. Node identity and keygen routes (a GET whose body
is a private key). Token, auth and passkey routes (the panel returns tokens in
plaintext; creating one grants a permanent admin outside every gate). Panel-wide
and subscription settings. Dumping `/admin/config` wholesale. Stamping a
provisioning task successful by hand — it does not perform the work, it only
moves the service to ACTIVE while the panel still has no user. Deleting a
payment, bonus or withdraw, which is a plain `DELETE FROM` the ledger while
`users.balance` is not recomputed. Ready-to-use subscription links and connection
keys. `restart-all`, `reorder`, squad bulk-actions, and `PUT /admin/spool` with
`job_users` (a mailing to every client, with no cancel).

The class has *narrowed*, and each narrowing was a correction rather than a
relaxation. Reading templates was forbidden together with writing, although the
stated reason — no git, no rollback — was only ever about writing, and the width
cost something real: a large share of notifications in one observed window
rendered empty and sent nothing while the task still reported SUCCESS, and the
cause lives inside the template body. Reading is now open, `POST` is open under
`template_edit` because that tool brought its own rollback, and `PUT` and
`DELETE` stay forbidden — a template that has just appeared, or just vanished,
has no previous state to snapshot. The `/api/sub` rule was a prefix rule, and
that is also a prefix of `/api/subscription-page-configs` and
`/api/subscription-request-history`, two read-only controllers that were
unreachable by accident; it is now `exact` plus `prefix` on `/api/sub/`. Bulk
operations on panel clients were forbidden because they apply to the whole base
with no list to review — true only while nobody counts: `bulk_ops` counts from
the panel before applying, refuses when the number cannot be established or is
above `HQ_MCP_MAX_BULK_USERS`, and is never offered to the bot.

`POST /api/users/bulk/delete-by-status` stays forbidden **by its shape**: its
body is a status, not a list of people. The panel queues the job and deletes
whoever matches *when the queue runs* — not who the operator reviewed — and
answers 202 with no body and no count, so accounts that expire in between are
deleted unseen. The capability survives as `bulk_ops delete_by_status`, which
enumerates the concrete ids, shows them, and deletes exactly those through
`bulk/delete`. Mass routes on *other* entities — hosts, nodes, squads, spool
mailings — have no counting step available to them and stay absent.

**Secrets are masked on the way out — by key name and by the shape of the
value.** By name: a closed list of credential keys, a
`token|secret|key|password|auth` match with an explicit exception list,
tail-masking for a few, and PII masking for the `bot` profile. That is not
enough, and it failed three times in one day: the Telegram bot token travelled
inside `response.request.url` of a spool row (the key is called `url`), the same
token sat in the `host` column of several SHM transport rows, and template bodies
carry credentials as bare substrings with no field name anywhere near them. So
the walk that masks by name also runs every string it passes through a set of
**value-shape** rules: JWTs; `NAME=<value>` where the name promises a secret and
the value does not look like a placeholder; Telegram bot tokens with and without
the surrounding path; `user:password@` inside a URL. That walk sits inside
`redact`, which is called by both HTTP clients on the way in and by the executor
on the way out, so no individual tool has to remember.

The rules are calibrated, not guessed, and the calibration is stated in the
source: the "opaque run" rule (32+ characters that look random) is measured
against a whole library of real template bodies and is *disabled* on structured
API responses, where an icon's data-URI and a payment's hex `uniq_id` step over
the same threshold and would be cut out — losing exactly the fields the tool was
written to return. None of it is a boundary, and the source says so: a secret
spelled out in words has no shape. Everything that passes stays inside the
`human` profile. The same shape rules are the ones `scripts/no-secrets.test.ts`
uses to keep a secret out of a published commit — one definition of "what a
secret looks like", deliberately, because two copies of that knowledge drift
apart silently and the second one goes on *looking* like it works.

**`sql_query` does not execute anything.** It validates and refuses, and says so
in its own source. The lexical check is a cheap first filter and explicitly not a
security boundary; the module lists the bypasses that pass it, with tests pinning
them open, so nobody mistakes the filter for a guarantee. Before execution is
ever wired, the preconditions are stated in the same file: a read-only role, a
read-only transaction, a statement timeout, and a column denylist.

## Limitations worth knowing

- The HTTP transport speaks MCP (`/mcp`, streamable HTTP) and serves the same
  tools as stdio: one function publishes them for both transports. What it
  deliberately does not do: sessions (no `Mcp-Session-Id` is issued),
  server-initiated messages, and with them the `GET` SSE stream and
  `Last-Event-ID` resumption. Every call is self-contained, so the server and the
  transport are created fresh per request; the SDK requires that too — its
  sessionless transport must not be reused.
- Two executor outcomes are unreachable over `/mcp`, and the `/metrics` counters
  see two of four for that route. The SDK validates input BEFORE the tool and
  answers `-32602` itself; an unknown tool name it also answers itself, never
  reaching the registry. So `invalid_input` and `not_found` appear on that route
  neither in the response nor in the report. On the REST facade both are
  reachable.
- A request to `/mcp` carrying an `Origin` header is refused with 403, with no
  way around it: the server binds loopback, and a page in a browser can point its
  own domain at `127.0.0.1` and call in as the operator. A browser sets `Origin`
  on any cross-origin POST, a real MCP client never does, and the server emits no
  CORS headers, so it has no browser client and cannot have one. The transport's
  built-in `allowedHosts`/`allowedOrigins` do not fit: in this SDK version they
  are deprecated in favour of external middleware, and an empty origin list there
  means "check disabled", not "no origin is acceptable".
- Two tools need a tunnel into a private network and refuse without one. They
  stay visible on purpose: a tool that vanishes teaches the model that the
  capability does not exist, when the truth is that a port is closed.
- `sync_audit` reads both systems to completion and is the one expensive call
  here — it has its own request allowance for that reason.
- The panel's page size is measured at runtime rather than assumed, because the
  API declares no maximum and the effective one has changed between releases.
- The panel's bulk routes answer 202 or 204 with an empty body and queue part of
  the work, so "applied" means "accepted by the panel", not "done for everyone".
  The number the plan established beforehand is the only honest one available.
- Changes made in the panel do not propagate back into SHM billing, and the tools
  that make them say so. There is no reconciliation step; `sync_audit` will show
  you the drift afterwards.

## Development

```bash
pnpm test          # unit tests
pnpm typecheck
pnpm test:guards   # the secret scanner and the capture script's production-refusal guards
```

Tests run against fixtures shaped like real responses. Where a defect was only
visible against a live system, the test that pins it says so.

## License

MIT.
