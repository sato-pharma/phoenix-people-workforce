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
  Railway service builds with `NODE_ENV=production`. (There is no staging app any more, so every
  non-dev row is production.) Override with
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
- `event=config_drift` — a notification-critical env var (`EMAIL_NOTIFICATIONS_ENABLED`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `NOTIFICATION_WEBHOOK_SECRET`) is unset in production, emitted by `/api/readyz` (`src/lib/observability/config-drift.ts`). Non-fatal — readiness stays 200 — but alerted, see below.

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
   SMS/etc. under **Integrations** if wanted) — this is what actually pages you.
5. Deploy. Each job's check auto-appears in the dashboard the first time it pings after step 3 —
   nothing to pre-create.
6. **Tune each check's schedule** — auto-provisioned defaults (Simple: 1-day period, 1-hour grace)
   are wrong for most of these jobs. For each check, switch **Schedule** to **Cron Expression**,
   paste the matching row below, set **Time Zone** to `Africa/Cairo` (Healthchecks defaults to
   UTC), and set the grace period:

   | Check slug | Cron expression | Suggested grace |
   |---|---|---|
   | `phoenix-notify-daily` | `36 6 * * *` | 1h |
   | `phoenix-process-notifications` | `*/5 * * * *` | 10m |
   | `phoenix-background-jobs` | `0 3 * * 5` | 2h |
   | `phoenix-inbound-intake` | `*/2 * * * *` | 10m |
   | `phoenix-ireports360-sync` | `7 9,12,19 * * *` | 30m |
   | `phoenix-reconcile-visits` | `24 4 * * 0` | 2h |
   | `phoenix-ireports360-live-sync` | `1,16,31,46 8-12 * * *` | 15m |
   | `phoenix-recruitment-email-intake` | `4-59/10 * * * *` | 10m |
   | `phoenix-direct-orders-expire-held` | `17 23 * * *` | 2h |
   | `phoenix-direct-orders-probation` | `17 23 * * *` | 2h |
   | `phoenix-run-synthetic-journeys` | `0 * * * *` | 1h |

   The two `phoenix-direct-orders-*` rows are the exception to the warning below: their schedule
   is **not** in cron-job.org, it is `.github/workflows/direct-orders-sweeps.yml` in this repo
   (`17 23 * * *` UTC = ~02:17 Cairo), so that expression is authoritative and reviewable. They
   were added 2026-08-23 after both clocks 401'd nightly for nine days unnoticed — the GitHub
   Actions copy of `CRON_SECRET` was left stale by the 2026-08-14 Railway rotation. A red
   scheduled-workflow run proved not to reach anyone; a missing ping does.

   `phoenix-run-synthetic-journeys` is the one row above that was **measured rather than copied**,
   so it is not subject to the drift warning that follows. `/api/cron/run-synthetic-journeys` does
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

   ⚠️ These expressions were copied from `scripts/setup-gcp-cron.sh`, which is **no longer the
   schedule source of truth** — the live schedules are in the cron-job.org account and have already
   drifted from this table (the weekly reconcile moved to Sunday 07:25, and the 15-minute live-sync
   job is redundant now that the in-process CRM poller exists). Read the real schedule out of
   cron-job.org before tuning a grace period, or the switch will alert on a job that is running
   fine — see [deployment.md](deployment.md) § Cron Jobs.

   Note also that cron-job.org caps request timeout at 30 s, so a slow route logs `Failed
   (timeout)` there while the server finishes the work and pings Healthchecks successfully. The
   two systems will disagree, and Healthchecks is the one telling the truth about whether the work
   completed.

**Three `/api/cron/*` routes are deliberately NOT wired, and must stay that way** unless someone
first creates a real schedule for them. A dead-man's-switch check is a statement that a job is
*expected* at a known cadence; auto-provisioning defaults to a 1-day period with a 1-hour grace, so
pointing one at a route nobody schedules produces a permanently red check — which is worse than no
check, because it teaches whoever reads the dashboard that red is the normal colour. Checked
2026-08-23:

| Route | Why it is not watched |
|---|---|
| `/api/cron/marketing-assignment-backfill` | **On-demand by design, and its work is already watched elsewhere.** `backfillMissingMarketingAssignmentEmails()` runs as a sub-job of the daily notification run (PR #2211), so it is already covered by `phoenix-notify-daily`. This route exists only so the same sweep can be driven by hand in production without firing every other daily notification alongside it. |
| `/api/cron/direct-orders-rotate-sheet-token` | **No schedule exists.** Both webhook variables are set on Railway, exactly one live `feed` share link exists (so none of the no-op branches apply), and the sheet is demonstrably alive — `direct_order_report_share_links` shows 25,156 reads with the newest at 2026-08-23 09:19 Cairo. A rotation under those conditions succeeds and leaves a trail (a revoked row plus an audit row). The live token was minted **2026-08-05 and has not rotated since**, so nothing has been calling this route on any cadence shorter than the elapsed window. |
| `/api/cron/marketing-requests-rotate-sheet-token` | **No schedule exists**, on the same evidence: `MARKETING_SHEET_REFRESH_WEBHOOK_URL`/`_SECRET` both set, one live feed link, 24,820 reads with the newest at 2026-08-23 09:18 Cairo, live token minted 2026-08-05 and never rotated since. The last two `system:rotation` audit rows are both from 2026-08-05. |

Neither rotation route appearing in [deployment.md](deployment.md) § Cron Jobs is consistent with
this: that inventory has never listed them. **Rotation therefore is not actually happening** —
separate from monitoring, and worth the owner's decision rather than a silent assumption. If either
route is given a cron-job.org job, wire it in the same commit and add its row above; the wiring is
one import and one wrapper call, and it is the schedule, not the code, that is missing.

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
