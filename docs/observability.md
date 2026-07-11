# Observability

_Phoenix Workforce runs on GCP Cloud Run. **Sentry has been fully removed** — do not reintroduce `@sentry/*`, `withSentryConfig`, or `sentry.*.config.ts`. Observability is native GCP + a self-hosted error table._

## Error capture

- **Server errors:** `instrumentation.ts` `onRequestError` forwards to `/api/errors/client` (edge-safe, HTTP), which calls `logAppError()` → the **`app_error_events`** table (`src/lib/error-monitor/service.ts`). Fields include route, module, hr_id, message, stack, `release` (`COMMIT_SHA` → Cloud Run `K_REVISION` → `unknown`), environment.
- **Client errors:** `src/lib/error-monitor/report-client-error.ts` (`keepalive` POST) → same endpoint.
- **Retention:** `pruneOldAppErrorEvents()` runs in the daily cron (default 90 days, `PHOENIX_ERROR_EVENT_RETENTION_DAYS`).
- **Access:** the table is service-role only (RLS-enabled, no policies); the admin error dashboard reads it via the admin client with an application permission check.

## Structured logging

`src/lib/observability/log.ts` emits single-line JSON that Cloud Logging parses into a structured entry: top-level `severity` + `logging.googleapis.com/labels` (searchable labels). Use it for anything that should drive a log-based metric/alert. Current stable labels:

- `event=cron_unauthorized` — a cron/worker endpoint hit without a valid `CRON_SECRET`.
- `event=webhook_signature_invalid` / `webhook_misconfigured` — Resend webhook rejections.
- `event=cron_failed` / `background_job_failed` — job execution failures.

Query in Cloud Logging: `resource.type="cloud_run_revision" resource.labels.service_name="phoenix-hr" labels.event="cron_unauthorized"`.

## Health probes

- **`/api/healthz`** — liveness: static 200, no dependencies. Used by the deploy smoke test and the uptime check.
- **`/api/readyz`** — readiness: cheap Supabase head-ping + required-env presence; returns 503 when not ready. Returns only booleans / missing-env **names**, never values.

## Metrics & alerting (GCP Monitoring)

Managed in Cloud Monitoring (created via the Monitoring/Logging API). Notification channel = owner email.

| Alert | Source |
|---|---|
| Cloud Run 5xx rate | `run.googleapis.com/request_count` (response_code_class=5xx) |
| Cloud Run p95 latency | `run.googleapis.com/request_latencies` |
| Uptime failure | uptime check on `/api/healthz` |
| Cloud Scheduler job failure | log-based metric `phoenix_scheduler_failures` |
| App auth/cron/webhook failure spike | log-based metric `phoenix_app_auth_failures` |

**Recommended additions** (same pattern, add when needed): container instance restarts, memory-utilization, max-instance saturation, Resend send-failure rate (outbox `failed` count).

## Synthetic journeys

`src/lib/synthetic-journeys/` is a Playwright smoke suite (`npm run synthetic:test`) that walks key routes and records pass/fail to `synthetic_journey_runs`. It is **not yet scheduled** — to use it as active monitoring it needs (a) a scheduled runner (Cloud Scheduler → ingest, or a GH Actions cron) and (b) safe test credentials. Environment classification treats `phoenix-hr.satopharma.com` and the `*.run.app` host as production.

## Cloud Run runtime signals

Built-in Cloud Run metrics (no code needed): request count/latency by response code, instance count, CPU/memory utilization, billable instance time. `min-instances=1` keeps one instance warm (no cold starts).
