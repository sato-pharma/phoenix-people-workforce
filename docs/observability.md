# Observability

_Phoenix Workforce runs on GCP Cloud Run. Observability is **two intentionally parallel systems**,
not a migration from one to the other: Sentry (issues, tracing, session replay, cron-monitor
heartbeats) and a self-hosted, GCP-native pipeline (structured logging, log-based metrics/alerts,
the `app_error_events` table). Every error/request-error capture point fans out to both — see
`instrumentation.ts`'s `onRequestError`, which runs the self-hosted forward-to-`/api/errors/client`
call and `Sentry.captureRequestError` together via `Promise.all` (neither blocks or depends on the
other), and `app/global-error.tsx`, which calls both `reportClientError` and
`Sentry.captureException`. Do not remove either side without discussing first — they serve
different audiences (Sentry: trace/error-correlated search, cron-monitor alerting, session replay;
self-hosted: HR-ID/module-queryable errors, GCP log-based alerting, login-security correlation)._

## Sentry

- **Config:** `next.config.ts` (`withSentryConfig`, org `phoenix-workforce`, project `phx-b9`) +
  `instrumentation-client.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts` (`Sentry.init`).
  DSN reads `NEXT_PUBLIC_SENTRY_DSN`/`SENTRY_DSN` with a hardcoded fallback to the correct project.
- **PII:** `dataCollection` is deliberately **omitted** from all three `Sentry.init` calls — passing
  it at all (even `{}`) flips PII/body collection to its permissive default, which is wrong for an
  HR platform. Do not re-add it without an explicit per-field opt-in.
- **Sampling:** `tracesSampleRate` is 100% in dev, 20% in production (cost/noise tradeoff).
- **Release:** `release` on both `withSentryConfig` and every `Sentry.init` call reads
  `COMMIT_SHA`/`NEXT_PUBLIC_COMMIT_SHA`, set by the deploy workflows from the same `$SHA_TAG` used
  for the Cloud Run image tag — see "Error capture" below, which shares this identifier.
- **Source maps:** uploaded at build time via `@sentry/webpack-plugin`, authenticated with
  `SENTRY_AUTH_TOKEN` sourced from GCP Secret Manager as a BuildKit `--secret` mount in
  `Dockerfile`/`cloudbuild.yaml` (never a plain build-arg/env, so it never persists in the pushed
  `:deps-cache`/`:latest-cache` image layers).
- **Cron monitors:** all 6 GCP-scheduled cron routes (`app/api/notifications/{daily,process}`,
  `app/api/cron/{background-jobs,ireports360-visits-sync,ireports360-visits-reconcile,ireports360-visits-live-sync}`)
  wrap their real work in `Sentry.withMonitor(slug, fn, { schedule, timezone: "Africa/Cairo", ... })`,
  matching `scripts/setup-gcp-cron.sh`'s `--schedule`/`--time-zone` exactly. Sentry alerts on missed/
  failed check-ins independently of the app's own per-job notification logic.
- **Alerts:** a basic "new issue → email" rule is configured in the Sentry dashboard (Alerts →
  Rules). Slack/PagerDuty/MS Teams/webhook channels are dashboard-only (Settings → Integrations,
  then add an action to the alert rule) — no app code involved.
- **Feedback widget:** `Sentry.feedbackIntegration({ autoInject: false })` is registered, and
  `src/components/admin/sentry-feedback-widget.tsx` manually mounts it only inside
  `app/(admin)/layout.tsx` — never on employee-facing pages.
- **GitHub integration:** the Sentry GitHub App is installed against this repo (suspect commits),
  and `getsentry/action-release` runs in both deploy workflows after traffic promotion
  (best-effort, `continue-on-error: true`) to mark each deploy as a Sentry release.
- **Not enabled:** server-side CPU profiling (`@sentry/profiling-node`) was tried and reverted —
  it breaks Next.js's instrumentation-hook loading under this app's production build (Turbopack;
  see the `userAgent` note above), throwing `ERR_MODULE_NOT_FOUND` for `@sentry/core` at server
  startup. `serverExternalPackages` did not fix it. Revisit only with a specific fix in hand, not
  by re-adding the same config. Custom metrics (`Sentry.metrics`) also not enabled — low priority,
  add only for specific counters if/when needed.

## Error capture

- **Server errors:** `instrumentation.ts` `onRequestError` forwards to `/api/errors/client` (edge-safe, HTTP), which calls `logAppError()` → the **`app_error_events`** table (`src/lib/error-monitor/service.ts`), **and** in parallel calls `Sentry.captureRequestError` (see Sentry section above) — neither path blocks or depends on the other. Fields include route, module, hr_id, message, stack, `release` (`COMMIT_SHA` → Cloud Run `K_REVISION` → `unknown`), environment.
- **Client errors:** `src/lib/error-monitor/report-client-error.ts` (`keepalive` POST) → same endpoint, **and** `app/global-error.tsx` also calls `Sentry.captureException`.
- **Retention:** `pruneOldAppErrorEvents()` runs in the daily cron (default 90 days, `PHOENIX_ERROR_EVENT_RETENTION_DAYS`).
- **Access:** the table is service-role only (RLS-enabled, no policies); the admin error dashboard reads it via the admin client with an application permission check.

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

**Recommended additions** (same pattern, add when needed): container instance restarts, memory-utilization, max-instance saturation, Resend send-failure rate (outbox `failed` count).

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
