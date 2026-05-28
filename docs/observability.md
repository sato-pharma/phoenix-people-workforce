# Observability - Error Monitoring and Cron Alerting

Phoenix Workforce uses Sentry on the free Developer plan for production error visibility, audit-failure alerting, and daily-cron health alerting. The integration is dormant until a DSN is configured, so local development, CI, and unconfigured deployments behave normally.

## What Is Wired

- `instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, and `instrumentation-client.ts` initialize Sentry for server, edge, and browser runtimes.
- `next.config.ts` wraps the app with `withSentryConfig`, allows Sentry ingest endpoints in CSP, and uploads source maps only when `SENTRY_AUTH_TOKEN` is configured.
- `src/lib/observability/sentry.ts` centralizes free-tier sampling, release/environment resolution, and sensitive-data scrubbing.
- `src/lib/admin/audit.ts` sends audit-persistence failures to Sentry.
- Daily crons are wrapped with `Sentry.withMonitor`:
  - `birthday-notifications` at `0 4 * * *` UTC.
  - `contract-renewals` at `15 4 * * *` UTC.

## Activation

1. Create a Sentry project using the Next.js platform.
2. Copy the project DSN from Sentry project settings.
3. Add environment variables in Vercel for Preview and Production:
   - `NEXT_PUBLIC_SENTRY_DSN=<project DSN>`
   - Optional: `SENTRY_DSN=<same DSN>` for server-only runtime config.
4. Optional source maps:
   - `SENTRY_AUTH_TOKEN=<Sentry auth token>`
   - `SENTRY_ORG=<org slug>`
   - `SENTRY_PROJECT=<project slug>`
5. Redeploy.

## Free-Tier Defaults

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | Required to activate browser monitoring. | unset = disabled |
| `SENTRY_DSN` | Optional server/edge DSN override. | falls back to `NEXT_PUBLIC_SENTRY_DSN` |
| `SENTRY_TRACES_SAMPLE_RATE` | Server/edge performance trace sample rate. | `0.02` |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Browser performance trace sample rate. | `0.02` |
| `SENTRY_ERROR_SAMPLE_RATE` | Server/edge error event sample rate. | `1` |
| `NEXT_PUBLIC_SENTRY_ERROR_SAMPLE_RATE` | Browser error event sample rate. | `1` |
| `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` | Enables browser Session Replay. Set only for Preview until masking is verified. | unset = disabled |
| `NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE` | Normal session replay sample rate when Replay is enabled. | `0` |
| `NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE` | Error-session replay sample rate when Replay is enabled. | `1` |
| `SENTRY_AUTH_TOKEN` | Enables source-map upload during build. | unset = upload skipped |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Source-map upload destination. | Phoenix defaults |

## Privacy Posture

- `sendDefaultPii` is always `false`.
- Session Replay is disabled unless `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true`.
- Session Replay masks all text and blocks all media.
- Normal Session Replay sampling defaults to 0%; error-session sampling defaults to 100% only in environments where Replay is explicitly enabled.
- Console and input breadcrumbs are dropped.
- Request bodies, cookies, query strings, auth headers, tokens, passwords, HR IDs, login IDs, emails, phone numbers, salaries, payroll fields, payslip fields, GPS/location fields, and image/evidence fields are scrubbed before events leave the app.
- Source maps are deleted after upload and are uploaded only when the auth token is available.
- Sentry wizard sample routes are ignored and must not be shipped.
