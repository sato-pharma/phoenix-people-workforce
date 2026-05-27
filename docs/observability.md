# Observability — Error Monitoring & Cron Alerting (Sentry, free tier)

Phoenix Workforce uses **Sentry** (free "Developer" plan) for external error monitoring,
audit-failure alerting, and daily-cron health alerting. All alerts are delivered by **email**.

The integration is **dormant until a DSN is configured** — with no `NEXT_PUBLIC_SENTRY_DSN`
set, `Sentry.init` is disabled and the app behaves exactly as before. So nothing breaks
in local dev, CI, or an un-configured deploy.

## What is wired up (code, already done)

- `instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`,
  `instrumentation-client.ts` — initialize Sentry per runtime (server / edge / browser).
- `next.config.ts` — wrapped with `withSentryConfig`; CSP `connect-src` allows the Sentry
  ingest endpoints. Source-map upload only runs if `SENTRY_AUTH_TOKEN` is set.
- `src/lib/admin/audit.ts` — audit-persistence failures are sent to Sentry. A failed
  **required** audit write is reported at `level: "fatal"` (tag
  `critical_audit_persistence_failed`); a best-effort failure at `level: "error"`.
- Daily crons wrapped with `Sentry.withMonitor` (dead-man's-switch):
  - `birthday-notifications` — schedule `0 4 * * *` (UTC)
  - `contract-renewals` — schedule `15 4 * * *` (UTC)
  A missed or failed run raises an alert. Cron errors also flow to `captureException`.

## One-time activation (manual — needs your Sentry account)

1. Sign up free at https://sentry.io and create a project (platform: **Next.js**).
2. Copy the project **DSN** (Settings → Projects → your project → Client Keys (DSN)).
3. Add this environment variable everywhere the app runs:
   - **Vercel** → Project → Settings → Environment Variables (add for **Production** and **Preview**):
     - `NEXT_PUBLIC_SENTRY_DSN = <your DSN>`
   - **Local** (optional) → add the same line to `.env.local`.
4. Redeploy. Errors now appear in Sentry. The default alert rule ("a new issue is created")
   emails you automatically.
5. After the first daily cron run, Sentry auto-creates the two cron monitors. In
   Sentry → **Crons**, confirm the email alert on **missed**/**failed** check-ins is on.

## Optional environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | **Required to activate.** Publishable identifier, safe to expose. | (unset → disabled) |
| `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Performance trace sampling (keep low for free tier). | `0.1` |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Enable source-map upload for readable stack traces. Create the token in Sentry → Settings → Auth Tokens. | (unset → upload skipped) |

## Free-tier notes

- Session Replay is intentionally disabled (saves quota; avoids extra CSP).
- Two daily crons + low trace sampling stay well within the free monthly quota.
- The DSN is **not** a secret; the auth token (if used) **is** — keep it only in env vars.
