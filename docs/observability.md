# Observability

_Phoenix Workforce runs on GCP Cloud Run. Sentry was retired 2026-07-31 — observability is now a
single self-hosted pipeline: the `app_error_events` table (server errors via `instrumentation.ts`'s
`onRequestError` → `/api/errors/client`; client errors via `reportClientError` → the same endpoint),
structured JSON logging to Cloud Logging (`src/lib/observability/log.ts`), an external dead-man's-
switch on all 8 Cloud Scheduler-triggered cron routes (Healthchecks.io — see below), and the GCP
alert policy **"Phoenix HR production ERROR log alert"** (log-match on `severity>=ERROR` for the
`phoenix-hr` Cloud Run service, throttled to at most one owner email every 30 minutes) — this
replaces Sentry's "new issue → email" rule._

## Error capture

- **Server errors:** `instrumentation.ts`'s `onRequestError` forwards to `/api/errors/client`
  (edge-safe, HTTP), which calls `logAppError()` → the **`app_error_events`** table
  (`src/lib/error-monitor/service.ts`). Fields include route, module, hr_id, message, stack,
  `release` (`COMMIT_SHA` → Cloud Run `K_REVISION` → `unknown`), environment.
- **Client errors:** `src/lib/error-monitor/report-client-error.ts` (`keepalive` POST) → the same
  endpoint, called from `app/global-error.tsx` (React root error boundary) and
  `src/components/layout/global-error-reporter.tsx` (`window.onerror` / `unhandledrejection`).
- **Retention:** `pruneOldAppErrorEvents()` runs in the daily cron (default 90 days, `PHOENIX_ERROR_EVENT_RETENTION_DAYS`).
- **Access:** the table is service-role only (RLS-enabled, no policies); the admin error dashboard reads it via the admin client with an application permission check.
- **Local dev never writes here (since 2026-07-30).** `shouldPersistErrorEvents()`
  (`src/lib/error-monitor/derived-status.ts`) makes `logAppError()` skip the insert and log to
  the console instead whenever `NODE_ENV !== "production"` — i.e. under `next dev` only. Both
  Cloud Run services build with `NODE_ENV=production`, so **staging keeps its own error events**
  (they land in the staging Supabase project). Override with
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

`src/lib/observability/log.ts` emits single-line JSON that Cloud Logging parses into a structured entry: top-level `severity` + `logging.googleapis.com/labels` (searchable labels). Use it for anything that should drive a log-based metric/alert. Current stable labels:

- `event=cron_unauthorized` — a cron/worker endpoint hit without a valid `CRON_SECRET`.
- `event=webhook_signature_invalid` / `webhook_misconfigured` — Resend webhook rejections.
- `event=cron_failed` / `background_job_failed` — job execution failures.
- `event=config_drift` — a notification-critical env var (`EMAIL_NOTIFICATIONS_ENABLED`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `NOTIFICATION_WEBHOOK_SECRET`) is unset in production, emitted by `/api/readyz` (`src/lib/observability/config-drift.ts`). Non-fatal — readiness stays 200 — but alerted, see below.

Query in Cloud Logging: `resource.type="cloud_run_revision" resource.labels.service_name="phoenix-hr" labels.event="cron_unauthorized"`.

## Health probes

- **`/api/healthz`** — liveness: static 200, no dependencies. Used by the deploy smoke test and the uptime check.
- **`/api/readyz`** — readiness: cheap Supabase head-ping + required-env presence; returns 503 when not ready. Returns only booleans / missing-env **names**, never values. Also surfaces non-fatal notification-config drift (see `event=config_drift` above) in a `warnings[]` field — drift never fails readiness, but it is logged and alerted (see below) since it means email/Telegram may be silently broken while everything else is healthy.

## Metrics & alerting (GCP Monitoring)

Managed in Cloud Monitoring (created via the Monitoring/Logging API). Notification channel = owner email.

| Alert | Source |
|---|---|
| Cloud Run 5xx rate | `run.googleapis.com/request_count` (response_code_class=5xx) |
| Cloud Run p95 latency | log-based metric `phoenix_hr_production_request_latencies` (see below) |
| Uptime failure | uptime check on `/api/healthz` |
| Cloud Scheduler job failure | log-based metric `phoenix_scheduler_failures` |
| App auth/cron/webhook failure spike | log-based metric `phoenix_app_auth_failures` |
| Notification-config drift | log-based metric `phoenix_config_drift` — fires on any occurrence in a 5-minute window (`labels.event="config_drift"`, see Structured logging above) |
| Production error log | **"Phoenix HR production ERROR log alert"** — log-match on `severity>=ERROR` for the `phoenix-hr` Cloud Run service, throttled to at most one owner email every 30 minutes. Replaces Sentry's "new issue → email" rule; catches anything `logError`/structured logging writes at ERROR/CRITICAL, not just `app_error_events` rows. |

**Recommended additions** (same pattern, add when needed): container instance restarts, memory-utilization, max-instance saturation, Resend send-failure rate (outbox `failed` count).

## External dead-man's-switch (Healthchecks.io)

`src/lib/observability/dead-mans-switch.ts`, wired into all 8 Cloud Scheduler-triggered routes.
**Deliberately separate from GCP Monitoring above** — that's hosted by/runs inside this same GCP
project, so it structurally cannot alert on the case where the app or its Cloud Run service itself
is what's paused or broken. That exact gap is what let 3 scheduler jobs (including the notification
outbox drain) sit silently **PAUSED for ~2 days** after a 2026-07-23 emergency stop — Cloud
Scheduler showed a state, not an alert, and nothing external was watching for the absence of an
expected ping.

**How it works:** each route calls `pingDeadMansSwitch(jobSlug, "success" | "fail", detail?)` (via
the `withDeadMansSwitch` wrapper, or directly for `notifications/daily`'s partial-sub-job-failure
case — see that file's own comment) after its real work completes. Healthchecks.io alerts when an
**expected ping doesn't arrive**, which is exactly the failure shape a paused/crashed/misconfigured
job produces. Uses Healthchecks' [Ping Key + slug API](https://healthchecks.io/docs/http_api/) —
one secret (`HEALTHCHECKS_PING_KEY`) covers all 8 jobs, addressed by slug instead of a per-check
UUID, with [auto-provisioning](https://healthchecks.io/docs/autoprovisioning/) (`?create=1`) so
each check is created automatically on its job's first real ping. Fails silent by design: no key
configured, or non-production runtime, means the code never attempts a network call at all — see
`tests/dead-mans-switch.test.ts` for the exact contract (never throws, never masks the real job
outcome, no-ops outside production).

**One-time owner setup** (an AI session cannot create third-party accounts — see repository
policy):

1. Create a free account at [healthchecks.io](https://healthchecks.io/) (or use an existing one).
2. Open the default project (or create one) → **Settings** → copy the **Ping Key**.
3. Set `HEALTHCHECKS_PING_KEY` on the `phoenix-hr` Cloud Run service ONLY (production env var
   change — needs its own approval per repo policy). **Never set this key on
   `phoenix-hr-staging`** — Healthchecks slugs are not environment-namespaced (the same 8 slugs
   below apply everywhere), so a staging ping would reset the exact same check production relies
   on, masking a real production outage behind a healthy-looking staging heartbeat. Staging is
   additionally covered by `APP_ENV=staging`, which makes `isProductionRuntime()` false there —
   `withDeadMansSwitch`/`pingDeadMansSwitch` already no-op outside production (see
   `tests/dead-mans-switch.test.ts`), so leaving the key unset on staging is also the
   functionally-correct state, not just the safer one.
4. Configure notification channels for the project (email is on by default; add Slack/Telegram/
   SMS/etc. under **Integrations** if wanted) — this is what actually pages you.
5. Deploy. Each job's check auto-appears in the dashboard the first time it pings after step 3 —
   nothing to pre-create.
6. **Tune each check's schedule** — auto-provisioned defaults (Simple: 1-day period, 1-hour grace)
   are wrong for most of these jobs. For each check, switch **Schedule** to **Cron Expression**,
   paste the matching row below, set **Time Zone** to `Africa/Cairo` (Healthchecks defaults to
   UTC), and set the grace period:

   | Check slug (= Cloud Scheduler job name) | Cron expression | Suggested grace |
   |---|---|---|
   | `phoenix-notify-daily` | `36 6 * * *` | 1h |
   | `phoenix-process-notifications` | `*/5 * * * *` | 10m |
   | `phoenix-background-jobs` | `0 3 * * 5` | 2h |
   | `phoenix-inbound-intake` | `*/2 * * * *` | 10m |
   | `phoenix-ireports360-sync` | `7 9,12,19 * * *` | 30m |
   | `phoenix-reconcile-visits` | `24 4 * * 0` | 2h |
   | `phoenix-ireports360-live-sync` | `1,16,31,46 8-12 * * *` | 15m |
   | `phoenix-recruitment-email-intake` | `4-59/10 * * * *` | 10m |

   These are the exact same cron expressions already live in `scripts/setup-gcp-cron.sh` — keep
   both in sync if a schedule ever changes.

**What it does NOT replace:** the Confidence Gate (holds a suspicious send before it goes out),
the held-notification alert (tells you when the gate held something), or fix #3's truthful
`cron_run_summary` logging (tells you which of the daily job's 22 sub-jobs failed). This only
answers one question — "did the job run at all?" — for the case none of those can cover: total
silence.

### p95 latency: scoped to production traffic

`deploy-cloud-run.yml` deploys every revision with **no traffic** and a
`sha-<8hex>` tag, then smoke-tests it directly via its tag URL
(`https://sha-xxxxxxxx---phoenix-hr-<hash>-<region>.a.run.app`) before ever
routing production traffic to it. That tag URL is a real, separately
routable Cloud Run endpoint — a cold-starting smoke-test hit against it is
indistinguishable, in the raw `run.googleapis.com/request_latencies` metric,
from a slow request against live production traffic; both only carry a
`revision_name` label, with nothing indicating whether the request reached
the promoted default/custom-domain URL or an unpromoted 0%-traffic tag URL.

`phoenix_hr_production_request_latencies` (log-based, DISTRIBUTION, seconds)
filters Cloud Run's automatic per-request log entries down to
`httpRequest.requestUrl NOT LIKE '%://sha-%'` — i.e. it excludes every
request that came in through a tag URL, leaving only traffic against the
custom domain / default promoted URL. The "Cloud Run p95 latency (phoenix-hr)"
alert policy's condition is scoped to this metric instead of the raw
built-in one, so deploy-time smoke tests and any other tag-URL traffic can
no longer contribute to the p95 that pages the owner.

Defined and applied via
`scripts/scope-p95-latency-alert-to-production-revision.py` (idempotent,
`--dry-run` by default — pass `--apply` to actually create the metric /
update the policy). It reads whatever threshold/duration/notification
channels are live on the policy at apply time rather than hardcoding them,
so re-tuning the policy afterward (Console or API) doesn't get clobbered by
re-running the script.

## Synthetic journeys

`src/lib/synthetic-journeys/` is a Playwright smoke suite (`npm run synthetic:test`) that walks key routes and records pass/fail to `synthetic_journey_runs`. It is **not yet scheduled** — to use it as active monitoring it needs (a) a scheduled runner (Cloud Scheduler → ingest, or a GH Actions cron) and (b) safe test credentials. Environment classification treats `phoenix-hr.satopharma.com` and the `*.run.app` host as production.

## Cloud Run runtime signals

Built-in Cloud Run metrics (no code needed): request count/latency by response code, instance count, CPU/memory utilization, billable instance time. `min-instances=1` keeps one instance warm (no cold starts).

## System Issues dashboard (`/admin/system-issues`, Super Admin + CEO)

Two tabs, gated by direct role check (not the `admin` permission resource, which is
hard-locked to Super Admin — see `isRolePermissionWithinHardBoundary` in
`src/lib/auth/permissions.ts`):

- **Issues & Errors** — merges `app_error_events` (self-hosted, app-level) with live
  Cloud Logging entries (`src/lib/observability/gcp-logs.ts`, severity ≥ WARNING for
  the Cloud Run service, last 24h) so infra-level failures that never reach application
  code (container crash, OOM kill, cold-start failure) are also visible. Requires env
  `GCP_PROJECT_ID` (and optionally `GCP_CLOUD_RUN_SERVICE`, defaults to `phoenix-hr`) and
  `roles/logging.viewer` granted to the Cloud Run runtime service account — without it,
  the tab shows an explicit "not connected" banner rather than a misleading empty list.
- **Per-User Attempts** — aggregates `app_error_events` + failed `auth_login_attempts`
  grouped by HR ID + module/route, computed in application code (`getUserAttemptSummary`
  in `src/lib/error-monitor/service.ts`), not a DB view/RPC — no migration required.
  Row-capped per source at 20,000 (paged in 1,000-row batches); hitting the cap sets
  `truncated: true` in the response, surfaced as a banner rather than a silent drop.
