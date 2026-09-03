# Observability

_Phoenix Workforce runs on **Railway** (moved off GCP Cloud Run 2026-08-01). Sentry was retired
2026-07-31. What still works today: the `app_error_events` table (server errors via
`instrumentation.ts`'s `onRequestError` → `/api/errors/client`; client errors via
`reportClientError` → the same endpoint), structured JSON logging (`src/lib/observability/log.ts`,
readable with `railway logs`), the health probes, and the Healthchecks.io dead-man's-switch on the
cron routes._

## ⚠️ The alerting layer died with GCP and has not been replaced

Read this before concluding "nothing is wrong because nothing alerted."

GCP billing account `01BDEA-A20B4C-CC568F` was closed 2026-08-01; every API in project
`phoenix-workforce-498619` returns `BILLING_DISABLED`. Everything that was hosted **inside** that
project is therefore gone, including the pieces that used to page the owner:

| What | Status |
|---|---|
| Cloud Monitoring alert policies (5xx rate, p95 latency, uptime, scheduler failure, auth-failure spike, config drift) | **Dead** — see "Metrics & alerting" below |
| "Phoenix HR production ERROR log alert" (the Sentry replacement) | **Dead** — nothing emails the owner on a production ERROR any more |
| Cloud Logging retention, log-based metrics, and the log query language | **Dead** — use `railway logs` |
| The `/admin/system-issues` "live infra logs" half | **Dead** — shows its "not connected" banner |
| Healthchecks.io dead-man's-switch | **Alive** — third-party, outside GCP, `HEALTHCHECKS_PING_KEY` is set on the Railway service |
| `app_error_events` table + `/admin/system-issues` app-error half | **Alive** — it is in Supabase, not GCP |

**Net effect: errors are still recorded, but nothing pages anyone.** Discovering a production
problem currently depends on someone looking at `/admin/system-issues`, `railway logs`, or a
Healthchecks notification for a cron that stopped pinging. Replacing the alerting layer is open
work, not a solved problem.

## Error capture

- **Server errors:** `instrumentation.ts`'s `onRequestError` forwards to `/api/errors/client`
  (edge-safe, HTTP), which calls `logAppError()` → the **`app_error_events`** table
  (`src/lib/error-monitor/service.ts`). Fields include route, module, hr_id, message, stack,
  `release` (`COMMIT_SHA` → the platform's revision env var → `unknown`), environment.
- **Client errors:** `src/lib/error-monitor/report-client-error.ts` (`keepalive` POST) → the same
  endpoint, called from `app/global-error.tsx` (React root error boundary) and
  `src/components/layout/global-error-reporter.tsx` (`window.onerror` / `unhandledrejection`).
- **Retention:** `pruneOldAppErrorEvents()` runs in the daily cron (default 90 days, `PHOENIX_ERROR_EVENT_RETENTION_DAYS`).
- **Access:** the table is service-role only (RLS-enabled, no policies); the admin error dashboard reads it via the admin client with an application permission check.
- **Local dev never writes here (since 2026-07-30).** `shouldPersistErrorEvents()`
  (`src/lib/error-monitor/derived-status.ts`) makes `logAppError()` skip the insert and log to
  the console instead whenever `NODE_ENV !== "production"` — i.e. under `next dev` only. The
  Railway service builds with `NODE_ENV=production`. (The staging app builds that way too, but it
  writes to the staging Supabase project — so every non-dev row in *this* table is still
  production. Staging's own error rows live in `cifwmndunmlxjhyjugxa`.) Override with
  `PHOENIX_PERSIST_DEV_ERROR_EVENTS=true` when deliberately debugging ingestion.
  - *Why:* `.env.local` on the maintainer machines points at the **production** Supabase project
    (a deliberate, documented setup), so local iterate-and-reload churn was inserting straight
    into the production error table — **275 of its 903 rows** were `environment='development'`
    when this was found. They read exactly like an outage (bursts of `X is not defined` on
    whatever page was being built), and cost a production go/no-go audit a false alarm.
  - *Reading the table:* the historical dev rows are still there, so **every** read in
    `service.ts` filters `environment != 'development'` (see `DEVELOPMENT_ENVIRONMENT` there —
    add it to any new query). When triaging by hand, always filter on `environment='production'`;
    the quick tell on an unfiltered row is `release`, which is `sha-XXXXXXXX` for real
    production traffic and `unknown` for local dev.

## Migration drift check

`.github/workflows/migration-drift-check.yml` runs `pnpm run check:migrations-applied` daily
against **both** staging and production, comparing every `supabase/migrations/*.sql` file to the
target project's `supabase_migrations.schema_migrations` (via the `phx_ci_migration_versions`
RPC). Each run prints the project ref it judged.

The production leg was added 2026-07-30. Until then the check ran against **staging only**, on
the reasoning that "if a migration never reached staging it never reached production either".
That proxy runs backwards: the documented workflow is staging-**first**, with production apply
gated on separate explicit approval (AGENTS.md), so the normal drift is applied-on-staging /
missing-on-production — exactly what a staging-only check reports as green. It had been passing
daily for over a week while production was missing
`20260725180000_analytics_dim_products_exclude_head_office.sql`.

**Operational requirement:** the production leg needs a `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`
GitHub Actions secret (production project ref `ozucdzovmcqvepbozvqf`). Without it the step is
skipped and the job emits a `::warning::` saying production was **not** checked — a skipped step
and a passing step look identical at a glance, which is the same silent-green failure this
workflow exists to prevent.

## Structured logging

`src/lib/observability/log.ts` emits single-line JSON with a top-level `severity` plus a
`logging.googleapis.com/labels` object. The label key is a GCP convention left in place so the
format is unchanged if GCP ever returns — on Railway it is simply part of the JSON line. Current
stable labels:

- `event=cron_unauthorized` — a cron/worker endpoint hit without a valid `CRON_SECRET`. Logged at
  `WARNING` except for the known-dead `Google-Cloud-Scheduler` user-agent (the GCP project retired
  2026-08-01 whose scheduler jobs still fire on their old secret), which logs at `INFO` so it stays
  greppable without reading as an incident. Any other caller — including a caller claiming that same
  user-agent string with a different IP — still warrants a look.
- `event=webhook_signature_invalid` / `webhook_misconfigured` — Resend webhook rejections.
- `event=cron_failed` / `background_job_failed` — job execution failures.
- `event=config_drift` — a notification-/cron-critical env var is unset where it must be present, emitted by `/api/readyz` (`src/lib/observability/config-drift.ts`). Non-fatal — readiness stays 200 — but alerted, see below. The gate differs per var, because the environment a var *must* exist in is a per-var question:
  - **Production only** (legitimately unset in dev/preview/staging): `EMAIL_NOTIFICATIONS_ENABLED`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `NOTIFICATION_WEBHOOK_SECRET`, and `MASTER_MAP_SYNC_TOKEN` (the Master Map Apps Script only ever calls production, so the token is deliberately absent on staging — a production-only gate keeps that from reading as drift).
  - **Every deployed environment** (production *and* staging, silent only in local `development`): `CRON_SECRET`. PR #2479 made the 18 cron/notification routes 401 on an unset `CRON_SECRET` on staging too — the drift alarm mirrors that route condition (`NODE_ENV !== "development"`) so it is not blind to a staging outage.

Read them with the Railway CLI (there is no log query language and no log-based metrics any more —
grep the stream):

```bash
railway logs --service phoenix-people-workforce | grep cron_unauthorized
```

`railway logs --http --json` gives the HTTP access log, which is how the real cron caller was
identified (read `clientUa` + `httpStatus` per `/api/cron/*` request).

## Health probes

- **`/api/healthz`** — liveness: returns 200 plus `revision`, the running commit SHA. **This is the
  authoritative answer to "what is actually live?"** — not the workflow list, not a merged PR. There
  is no longer a deploy smoke test or an uptime check calling it; you call it.
- **`/api/readyz`** — readiness: cheap Supabase head-ping + required-env presence; returns 503 when not ready. Returns only booleans / missing-env **names**, never values. Also surfaces non-fatal notification-config drift (see `event=config_drift` above) in a `warnings[]` field — drift never fails readiness, but it is logged and alerted (see below) since it means email/Telegram may be silently broken while everything else is healthy.

## Metrics & alerting — DEAD (nothing pages the owner)

All of the below lived in GCP Cloud Monitoring inside project `phoenix-workforce-498619`. That
project's billing closed 2026-08-01, so **every one of these alerts is dead** and none has been
rebuilt on Railway. Kept as the specification to rebuild against, not as a description of what runs:

| Alert (dead) | Was sourced from |
|---|---|
| Cloud Run 5xx rate | `run.googleapis.com/request_count` (response_code_class=5xx) |
| Cloud Run p95 latency | log-based metric `phoenix_hr_production_request_latencies` |
| Uptime failure | uptime check on `/api/healthz` |
| Cloud Scheduler job failure | log-based metric `phoenix_scheduler_failures` |
| App auth/cron/webhook failure spike | log-based metric `phoenix_app_auth_failures` |
| Notification-config drift | log-based metric `phoenix_config_drift` (`labels.event="config_drift"`) |
| Production error log ("Phoenix HR production ERROR log alert") | log-match on `severity>=ERROR`; this was the Sentry replacement |

The one alerting path that **does** still work is Healthchecks.io (next section) — it is
third-party, was never inside GCP, and answers exactly one question: did a cron job run at all.
It says nothing about 5xx rates, latency, or application errors.

Rebuilding this is open work. Whatever replaces it must live **outside** the hosting platform, for
the same reason the dead-man's-switch does: a monitor that runs inside the thing it monitors cannot
report that the thing is down.

## External dead-man's-switch (Healthchecks.io)

`src/lib/observability/dead-mans-switch.ts`, wired into the cron routes. **This is now the only
working alert in the system**, and the reason it survived the GCP shutdown is exactly why it was
built: it is hosted outside the platform it watches, so it can still fire when that platform is the
thing that is broken. The GCP monitoring that sat inside the same project it monitored is gone; this
is not.

The original gap it was built for: 3 scheduler jobs (including the notification outbox drain) sat
silently **PAUSED for ~2 days** after a 2026-07-23 emergency stop — the scheduler showed a state,
not an alert, and nothing external was watching for the absence of an expected ping.

The routes are now triggered by **cron-job.org**, not Cloud Scheduler (see
[deployment.md](deployment.md) § Cron Jobs). The dead-man's-switch is indifferent to who calls the
route — it pings on completion either way — so it kept working across the cutover.

**How it works:** each route calls `pingDeadMansSwitch(jobSlug, "success" | "fail", detail?)` (via
the `withDeadMansSwitch` wrapper, or directly for `notifications/daily`'s partial-sub-job-failure
case — see that file's own comment) after its real work completes. Healthchecks.io alerts when an
**expected ping doesn't arrive**, which is exactly the failure shape a paused/crashed/misconfigured
job produces. Uses Healthchecks' [Ping Key + slug API](https://healthchecks.io/docs/http_api/) —
one secret (`HEALTHCHECKS_PING_KEY`) covers every check, addressed by slug instead of a per-check
UUID, with [auto-provisioning](https://healthchecks.io/docs/autoprovisioning/) (`?create=1`) so
each check is created automatically on its job's first real ping. Fails silent by design: no key
configured, or non-production runtime, means the code never attempts a network call at all — see
`tests/dead-mans-switch.test.ts` for the exact contract (never throws, never masks the real job
outcome, no-ops outside production).

**One-time owner setup** (an AI session cannot create third-party accounts — see repository
policy):

1. Create a free account at [healthchecks.io](https://healthchecks.io/) (or use an existing one).
2. Open the default project (or create one) → **Settings** → copy the **Ping Key**.
3. Set `HEALTHCHECKS_PING_KEY` on the Railway service `phoenix-people-workforce` (production env
   var change — needs its own approval per repo policy). **Already done** — the switch is armed.
   Healthchecks slugs are not environment-namespaced, so if a second environment ever exists again,
   never set this key there: its ping would reset the exact check production relies on, masking a
   real outage behind a healthy-looking heartbeat. `withDeadMansSwitch`/`pingDeadMansSwitch`
   no-op outside production anyway (see `tests/dead-mans-switch.test.ts`).
4. Configure notification channels for the project (email is on by default; add Slack/Telegram/
   SMS/etc. under **Integrations** if wanted) — this is what actually pages you. Every channel
   configured here gets attached to every check by the sync script in step 6; there is no per-check
   opt-out, because a check that alerts nobody is silently useless and this is a single-owner
   project. Found 2026-08-27: `phoenix-db-health-snapshot` and `phoenix-direct-orders-probation`
   had sat with zero channels since creation — neither had ever gone red, so nothing surfaced it
   until someone checked by hand. `pnpm run healthchecks:sync --apply` now fixes and prevents this.
5. Deploy. Each job's check auto-appears in the dashboard the first time it pings after step 3 —
   nothing to pre-create.
6. **Tune each check's schedule and channels — run the script, do not do this by hand:**

   ```bash
   pnpm run healthchecks:sync            # dry run: print what would change
   pnpm run healthchecks:sync --apply    # push it
   ```

   Auto-provisioned defaults (Simple: 1-day period, 1-hour grace, **zero channels**) are wrong for
   every one of these jobs, so every check is born red-or-silent and stays that way until someone
   corrects it — and a dashboard that is always red, or always silent, is one nobody reads.
   [`scripts/healthchecks-sync.mjs`](../scripts/healthchecks-sync.mjs) reads the table below and
   makes Healthchecks match it: cron expression, `Africa/Cairo` timezone (Healthchecks defaults to
   UTC), grace, **and every channel configured in the project** (there is no per-check column for
   this — it always means "all of them", see step 4). It is idempotent, it reads back after writing
   rather than trusting the POST, and it changes nothing without `--apply`.

   It needs `HEALTHCHECKS_API_KEY` in `.env.local` — a Healthchecks **project API key**
   (Settings › API keys, full access), which is **not** `HEALTHCHECKS_PING_KEY`. A ping key can
   create a check but cannot set its schedule, which is exactly why every check has been sitting on
   defaults. The script never prints the key.

   Doing it in the web UI instead — switch **Schedule** to **Cron Expression**, paste the row, set
   **Time Zone**, set the grace — still works and is the fallback if the key is unavailable.

   One row is deliberately **Simple** rather than a cron expression: it is pinged on an interval,
   not at a wall-clock time.

   | Check slug | Cron expression | Suggested grace | What actually pings it |
   |---|---|---|---|
   | `phoenix-notify-daily` | `36 6 * * *` | 1h | cron-job.org job `8200909` |
   | `phoenix-marketing-field-capture-nudge` | `50 6 * * *` | 1h | cron-job.org job `8348773` |
   | `phoenix-marketing-invoice-overdue-nudge` | `5 7 * * *` | 1h | cron-job.org job `8350529` |
   | `phoenix-distributor-upload-overdue-nudge` | `20 7 * * *` | 1h | cron-job.org job `8375333` |
   | `phoenix-mailbox-offboarding-sweep` | `15 8 * * *` | 1h | cron-job.org job `8350624` |
   | `phoenix-process-notifications` | `*/5 * * * *` | 10m | cron-job.org job `8200914` |
   | `phoenix-background-jobs` | `0 3 * * 5` | 2h | cron-job.org job `8200915` |
   | `phoenix-inbound-intake` | `*/2 * * * *` | 10m | cron-job.org job `8200920` |
   | `phoenix-recruitment-email-intake` | `4-59/10 * * * *` | 10m | cron-job.org job `8200919` |
   | `phoenix-run-synthetic-journeys` | `0 * * * *` | 1h | cron-job.org job `8220577` |
   | `phoenix-direct-orders-rotate-sheet-token` | `23 3 * * 5` | 2h | cron-job.org job `8313169` |
   | `phoenix-marketing-requests-rotate-sheet-token` | `43 3 * * 5` | 2h | cron-job.org job `8313171` |
   | `phoenix-brevo-keepalive` | `9 4 1 * *` | 12h | cron-job.org job `8313297` |
   | `phoenix-direct-orders-expire-held` | `17 2 * * *` | 2h | cron-job.org job `8313165` |
   | `phoenix-direct-orders-probation` | `27 2 * * *` | 2h | cron-job.org job `8313177` |
   | `phoenix-db-health-snapshot` | `17 */6 * * *` | 2h | cron-job.org job `8242721` |
   | `phoenix-territory-restamp` | `20 3 * * *` | 2h | cron-job.org job `8350721` |
   | `phoenix-reconciliation-check` | `40 4 * * *` | 2h | cron-job.org job `8350984` |
   | `phoenix-crm-contact-lists` | `*/5 5 * * *` | 10m | cron-job.org job `8344730` |
   | `phoenix-expense-claims-refresh` | `51 * * * *` | 1h | cron-job.org job `8350207` |
   | `phoenix-recruitment-cv-digest` | `47 0,6,12,18 * * *` | 1h | cron-job.org job `8334658` |
   | `phoenix-ireports360-live-poll` | **Simple**, period `5m` | 15m | the in-process poller, every tick |
   | `phoenix-ireports360-sync` | `0 6-21/3 * * *` | 2h | the in-process poller, when due |
   | `phoenix-reconcile-visits` | `0 4 * * 0` | 12h | the in-process poller, when due |
   | `phoenix-job-heartbeat-sweep` | `*/15 * * * *` | 30m | cron-job.org job `8351275` |

   **This table is machine-read.** `scripts/healthchecks-sync.mjs` parses these rows — slug in
   backticks, then either a backticked cron expression or a **Simple** cell naming its period, then
   the grace as `10m` / `2h`. `tests/healthchecks-schedule-sync.test.ts` fails in CI if that stops
   parsing, if a row loses `Africa/Cairo`, or if either Direct Orders row drifts from its live
   cron-job.org clock.
   Reformat the table freely, but re-run `pnpm run test` — a parser that silently matches nothing
   turns the sync into a no-op that reports success.

   🔴 **THE HEALTHCHECKS ACCOUNT IS FULL AT 20 CHECKS — WHICH IS WHY THERE IS NOW A SECOND,
   IN-HOUSE BACKEND.** Measured 2026-08-30: `GET /api/v3/checks/` returns exactly **20**, every one
   of them declared here and legitimate, and `POST /checks/` for a 21st returns **HTTP 403 with an
   empty body** — the free tier's ceiling. So `phoenix-crm-contact-lists`,
   `phoenix-expense-claims-refresh`, `phoenix-recruitment-cv-digest` and
   `phoenix-job-heartbeat-sweep` are declared above but have no external check, and the sync reports
   them `FAILED: HTTP 403` on every run. **That is the honest state, not a bug to re-diagnose** — do
   not spend time on the 403, and do not delete a row to make the sync go green, which would only
   hide unwatched jobs again. The owner declined a paid plan on 2026-08-30 (`$20/month` for 100
   checks) and asked for a free path; the register below is that path.

   ⚠️ **A ping to an uncreated slug is best-effort and silent, which is the trap here.**
   `pingDeadMansSwitch` never throws and swallows its own failure into a `logWarning`, so these
   routes will ping into nothing and carry on working normally. Nothing breaks; nothing is
   watched either. **Absence of a red check is not evidence of a healthy job when the check was
   never created** — that is precisely how these came to be unwatched in the first place.

### The in-house register — `public.job_heartbeats`

`pingDeadMansSwitch` now writes to **two** backends on every call, and neither can block the other
(`Promise.allSettled`; both halves already swallow their own errors). No route changed to gain
this — the function is the single seam every one of the 24 declared jobs already went through.

| | Healthchecks.io | `public.job_heartbeats` |
|---|---|---|
| Where it lives | outside Phoenix | inside Phoenix |
| Capacity | **20, full** | unlimited |
| Survives Phoenix being down | **yes — this is its whole value** | no |
| Detects "ran and reported FAILURE" | on a dashboard only | **yes, and it alerts** |
| Alerts via | whatever the project has configured | in-app + Telegram, never email |

The sweeper is [`/api/cron/job-heartbeat-sweep`](../app/api/cron/job-heartbeat-sweep/route.ts),
every 15 minutes. It bootstraps a row for every declared slug, judges each against its schedule,
and on any problem writes an ERROR log, an audit row, and a notification to the
`weekly_system_health_digest` audience. **Deliberately no email, and do not "fix" that back** —
this alert can fire *because* the notification pipeline is what stopped, so an emailed alert would
depend on the channel it is reporting broken.

Three design points worth not re-deriving:

- **The previous scheduled fire is computed with `cron-parser`, never from an average interval.**
  Several schedules here are windowed — `*/5 5 * * *` fires twelve times inside one hour and is then
  silent for 23 hours *by design*, and `0 6-21/3 * * *` has a nine-hour overnight gap. Any
  interval-based staleness rule calls both of those stranded every single day, and a monitor that
  cries wolf daily is one nobody reads.
- **A job that has never reported is not stranded until a fire has passed since `first_seen_at`.**
  Otherwise declaring a new job pages someone the moment it deploys.
- **The sweep pings its own switch `success` even when it finds problems.** That check answers one
  question — "is the sweeper running?" — and turning it red for another job's fault is how a
  watchdog stops being trusted.

🔴 **THE ONE HOLE, STATED RATHER THAN HIDDEN: the sweeper is not externally watched.** A sweeper
that stops entirely cannot report its own silence, and `phoenix-job-heartbeat-sweep` has no
Healthchecks slot because the account is full. **Every other job is now covered internally, which
is exactly what makes retiring an external check safe for the first time** — freeing one slot for
this slug is the single action that closes the loop, and it costs nothing that is not already
covered twice. Until then: a monitoring layer that overstates its own coverage is worse than one
that admits a gap, so this paragraph exists instead of a green dashboard.

   🔴 **A check created through the management API is stored with an EMPTY slug unless one is sent
   explicitly** — and the app pings by slug (`hc-ping.com/<ping-key>/<slug>?create=1`), never by name.
   A slugless check therefore never receives the ping it is waiting for: it goes red on schedule while
   the job runs perfectly, and the next real ping quietly auto-provisions a **second** check beside
   it. The sync sends `slug` on every write for this reason. Found on the first live run, on
   2026-08-23, by the read-back the script performs after writing.

   The fourth column is the point of the table. A slug in the code proves only that the app *would*
   ping if something called it; it says nothing about whether anything does. Every row above was
   read back out of the live cron-job.org account on **2026-08-23** (17 jobs, 12 enabled) or traced
   to the code that pings it, and the two rows that did not survive that check are called out below.

   **Three of these are pinged by the app itself, not by any scheduler.** `src/lib/crm/live-poller.ts`
   runs inside the production process and absorbed the iReports360 cron work: it pings
   `phoenix-ireports360-live-poll` on **every tick** (20 s in the 08:00–12:30 Cairo compliance
   window, 30 s daytime, 120 s overnight — hence a Simple 5-minute period rather than a cron
   expression, with a grace wide enough to survive a deploy restart), and it pings
   `phoenix-ireports360-sync` / `phoenix-reconcile-visits` when their deep runs come due. Those two
   fire on an elapsed-time guard, not a wall clock — 3 h since the last success and no earlier than
   06:00 Cairo for the rolling sync, 5.5 days and Sunday from 04:00 for the wide reconcile — so the
   expressions above are the *envelope* they run inside, and the graces are wide on purpose. The
   old rows (`7 9,12,19 * * *` at 30 m, `24 4 * * 0` at 2 h) were copied from the dead GCP script
   and would now go red daily: a poller sync at 09:00 Cairo does not satisfy a check expecting one
   after 09:07.

   🔴 **`phoenix-ireports360-live-sync` is no longer in this table, and if that check exists in the
   dashboard it should be deleted.** `/api/cron/ireports360-visits-live-sync` is still wired to the
   switch, but its only caller — cron-job.org job `8200918` — is **disabled**, last fired
   2026-08-16, and nothing else pings that slug. It was made redundant by the in-process poller, so
   the check has been red since 2026-08-16 for no reason at all. This table used to instruct the
   owner to give it a 15-minute schedule, which would have kept it red forever.

   The two `phoenix-direct-orders-*` rows **moved into cron-job.org on 2026-08-23** — jobs `8313165`
   (02:17) and `8313177` (02:27), both Africa/Cairo, staggered so the two sweeps never overlap. They
   are therefore covered by the drift warning below like every other row: read the live schedule out
   of the account before tuning their grace.

   They ran from `.github/workflows/direct-orders-sweeps.yml` for one day before that. The move
   happened because scheduling from GitHub put `CRON_SECRET` in a second, independently rotated
   store: the 2026-08-14 Railway rotation was never mirrored into Actions, both clocks 401'd nightly
   for nine days, and nobody noticed — a red scheduled-workflow run proved not to reach anyone; a
   missing ping does. That workflow still exists with `workflow_dispatch` and **no `schedule:`**, as
   a manual fallback; re-adding a schedule there would double-fire both sweeps.

   Both expressions above are **Africa/Cairo local**, matching how cron-job.org is configured. Set
   these two Healthchecks checks to that timezone rather than UTC, or the expected-ping window sits
   two to three hours off the real one and shifts again at every Egyptian DST change.

   `phoenix-run-synthetic-journeys` was the first row here to be **measured rather than copied**.
   `/api/cron/run-synthetic-journeys` does
   not do the work itself — it asks GitHub to start `synthetic-journeys.yml` — so its cadence is
   visible in this repository's own Actions history: `gh run list --workflow=synthetic-journeys.yml`
   shows **177 `workflow_dispatch` events between 2026-08-15 and 2026-08-23, every one 4-12 seconds
   past the top of the hour, all 24 UTC hours represented, one single missed hour in eight days**.
   Railway's HTTP log names the caller (`@path:/api/cron/run-synthetic-journeys` → `clientUa`
   `cron-job.org`, GET, 200). Hence `0 * * * *`. The 1h grace deliberately tolerates exactly one
   missed hour — that has already happened once (2026-08-17 18:00 UTC) without anything being wrong,
   and a check that pages on a single blip is a check people learn to ignore.

   Ignore the `schedule:` block inside `synthetic-journeys.yml` when tuning this: GitHub's own
   scheduler fires it at effectively random minutes (visible as the `schedule` events in the same
   run list), which is the entire reason the cron-job.org trigger exists. Only the
   `workflow_dispatch` events are this job's real clock.

   The two `*-rotate-sheet-token` rows are **not copied from anywhere either** — those jobs did not
   exist until 2026-08-23, when they were created to fix the second half of the same problem: those
   routes were not merely unwatched, *nothing was calling them at all*, and the live feed tokens
   they exist to rotate had sat unchanged since 2026-08-05. cron-job.org jobs `8313169` (Fridays
   03:23) and `8313171` (Fridays 03:43) are now the schedule, and the rows above simply restate
   them. Weekly, on the Egyptian weekend, twenty minutes apart so two 30 s requests can never
   overlap: rotation is cheap and safely repeatable, but each run is one more chance to disturb a
   live sheet the owner reads, so it happens when nobody is reading it. **That cadence is a
   judgement call, not a requirement** — moving either job to daily is harmless, and needs only the
   row above and the route's own comment changed to match.

   `phoenix-brevo-keepalive` is the odd one out: **monthly**, because the thing it defends against
   is a 90-day clock, not a daily one. Brevo expires an API key after 90 consecutive days of
   inactivity regardless of its stated expiry date, and `BREVO_API_KEY` is the email **failover** —
   by design it is never exercised while Resend is healthy, so left alone it dies quietly and the
   backup is gone at the exact moment it is needed. Monthly gives three pings per expiry window, so
   two consecutive failures still leave a month of margin. The route does a single authenticated
   `GET /v3/account` — no email, no send credit — and **throws** on a 401, so a revoked key pings
   fail immediately rather than waiting for a missing ping. The 12h grace only has to cover a
   deploy window.

   ⚠️ **The cron-job.org account, not this table, is the schedule.** Every expression here was
   verified against it on 2026-08-23, but nobody can see or change that account from this
   repository, so the table can drift again silently — and it has: these rows originally came from
   `scripts/setup-gcp-cron.sh`, which stopped being the source of truth when GCP died, and two of
   them were still describing jobs the in-process poller had taken over. Re-read the account before
   tuning a grace period, or the switch will alert on a job that is running perfectly well.

   **`phoenix-db-health-snapshot` had no row here until 2026-08-24, on purpose. Read why it now
   does before removing it again.** The route opted out because a missed snapshot is a gap in a
   graph, not an incident, and paging on it would teach the owner to ignore the pager. That
   answered *severity* and ignored *visibility*: opting out did not make the job alert quietly, it
   made a stopped job indistinguishable from a running one. On 2026-08-24 a half-finished
   `CRON_SECRET` rotation left six of the twelve enabled cron-job.org jobs presenting a superseded
   token; every one 401’d before reaching any ping, so they went silent rather than red, and the
   only reason it was caught is that the hourly synthetic-journeys check blew its grace window. On
   a 6-hourly clock with no check at all, this job would have stayed dark indefinitely and taken
   the slow-query history with it. Severity is now carried by the 2h grace, not by the silence.

   Note also that cron-job.org caps request timeout at 30 s, so a slow route logs `Failed
   (timeout)` there while the server finishes the work and pings Healthchecks successfully. The
   two systems will disagree, and Healthchecks is the one telling the truth about whether the work
   completed.

**Two `/api/cron/*` routes are NOT watched, and only one of them is deliberate.** A
dead-man's-switch check is a statement that a job is *expected* at a known cadence; auto-provisioning
defaults to a 1-day period with a 1-hour grace, so pointing one at a route nobody schedules produces
a permanently red check — which is worse than no check, because it teaches whoever reads the
dashboard that red is the normal colour. Checked against the live cron-job.org account 2026-08-23:

| Route | State |
|---|---|
| `/api/cron/marketing-assignment-backfill` | **Unwired on purpose, and its work is already watched elsewhere.** `backfillMissingMarketingAssignmentEmails()` runs as a sub-job of the daily notification run (PR #2211), so it is already covered by `phoenix-notify-daily`. This route exists only so the same sweep can be driven by hand in production without firing every other daily notification alongside it. Leave it alone. |

`/api/cron/reconciliation-check` left this table on 2026-08-30, and what had to happen first is the
part worth keeping. It had been wired to `phoenix-reconciliation-check` and called by nothing, so
its slug read as a watch that did not exist. Scheduling it was not, however, a matter of creating
the job: run against production as it stood, the harness reported two breaches, and one of them —
an active login carrying no `HR_ID` — was `admin-HR`, the break-glass Super Admin that has no
`employees` row **by standing rule** and must never be given one. Arming it in that state would
have paged a human every night about a condition ruled permanent, which is the fastest way to
manufacture a dashboard nobody reads. So the allowance landed first
(`src/lib/reconciliation/logins-without-employee-row.ts`, pinned by
`tests/reconciliation-harness.test.ts`) and the job was created **held** — `cronjob-sync.mjs
--hold`, disabled, firing nothing — so that its id could be written into the table above in the
same pull request that made it safe to run. The plain `--apply` afterwards is the arming step.
**The generalisation: a check is not ready to be scheduled the day it is written, but the day its
expected exceptions are expressed in code.** Until then, scheduling it is worse than leaving it off.

`/api/cron/brevo-keepalive` was in this table for a few hours on 2026-08-23 and left it the same way
the rotations did: it was wired to `phoenix-brevo-keepalive` and called by **nothing at all**, so
its check had never even been created — auto-provisioning needs a first ping, and a job that never
runs produces silence rather than red. That was not cosmetic. The route exists to reset Brevo's
90-day inactivity expiry on the email **failover** key, and an unused backup key that nobody pings
is exactly the key that is dead on the day the primary fails. It now runs monthly (cron-job.org job
`8313297`), which is three pings per expiry window.

The two `*-rotate-sheet-token` routes were in this table until 2026-08-23, and how they left it is
the lesson worth keeping. The evidence that they had no schedule was entirely indirect: both webhook
variable pairs were set on Railway, each report had exactly one live `feed` share link (so none of
the no-op branches applied), and both sheets were demonstrably alive —
`direct_order_report_share_links` showed 25,156 reads with the newest at 2026-08-23 09:19 Cairo, the
marketing equivalent 24,820 with the newest at 09:18. A rotation under those conditions succeeds and
leaves a trail. Yet both live tokens were minted **2026-08-05 and had never rotated**, and the only
two `system:rotation` audit rows are from that same day. Nothing was calling either route, and the
code written to rotate them looked perfectly healthy for eighteen days. They are wired now because
the **schedule** was created, not because the code changed. Before wiring any route here, prove
something calls it — and if nothing does, that is the bug, not the missing check.

**What it does NOT replace:** the Confidence Gate (holds a suspicious send before it goes out),
the held-notification alert (tells you when the gate held something), or fix #3's truthful
`cron_run_summary` logging (tells you which of the daily job's 22 sub-jobs failed). This only
answers one question — "did the job run at all?" — for the case none of those can cover: total
silence.

### p95 latency: obsolete

There used to be a log-based metric (`phoenix_hr_production_request_latencies`, applied via
`scripts/scope-p95-latency-alert-to-production-revision.py`) that excluded deploy-time smoke-test
traffic from the p95 that paged the owner. It existed because `deploy-cloud-run.yml` smoke-tested
each new revision through a no-traffic `sha-<8hex>` tag URL, and those cold-start hits polluted the
raw Cloud Run latency metric.

**Both halves of that are gone**: there is no no-traffic tag deploy on Railway, and the alert it
protected is dead with GCP Monitoring. The script is left in the repo but cannot run.

## Synthetic journeys

`src/lib/synthetic-journeys/` is a Playwright smoke suite (`pnpm run synthetic:test`) that walks key
routes and records pass/fail to `synthetic_journey_runs`. It is **not yet scheduled** — to use it as
active monitoring it needs (a) a scheduled runner (a GitHub Actions cron is now the obvious host,
since Cloud Scheduler is dead) and (b) safe test credentials. Environment classification treats
`phoenix-hr.satopharma.com` as production.

Given that the alert layer is dead, scheduling this suite is the cheapest route back to an
automated "is production actually working?" signal — it runs on GitHub's infrastructure, outside
Railway, which satisfies the outside-the-platform requirement.

## Railway runtime signals

`railway logs` (add `--http --json` for the access log) and the Railway dashboard's built-in
service metrics — CPU, memory, network, restarts. There are no log-based metrics and no alert
policies; these are things you look at, not things that page you.

## System Issues dashboard (`/admin/system-issues`, Super Admin + CEO)

Two tabs, gated by direct role check (not the `admin` permission resource, which is
hard-locked to Super Admin — see `isRolePermissionWithinHardBoundary` in
`src/lib/auth/permissions.ts`):

- **Issues & Errors** — shows `app_error_events` (self-hosted, app-level). It was built to *merge*
  those with live Cloud Logging entries (`src/lib/observability/gcp-logs.ts`, severity ≥ WARNING,
  last 24h) so infra-level failures that never reach application code (container crash, OOM kill,
  cold-start failure) were visible too. 🔴 **That half is dead** — the GCP project's billing is
  closed, so the tab shows its explicit "not connected" banner. The banner is correct behaviour
  (better than a misleading empty list), but it means **container-level failures are currently
  invisible in the UI** — use `railway logs` for those. Re-pointing this at the Railway log API is
  open work.
- **Per-User Attempts** — aggregates `app_error_events` + failed `auth_login_attempts`
  grouped by HR ID + module/route, computed in application code (`getUserAttemptSummary`
  in `src/lib/error-monitor/service.ts`), not a DB view/RPC — no migration required.
  Row-capped per source at 20,000 (paged in 1,000-row batches); hitting the cap sets
  `truncated: true` in the response, surfaced as a banner rather than a silent drop.
