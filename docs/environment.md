# Environment Variables

All environment variables are listed in `.env.example` at the repository root. Copy it to `.env.local` for local development.

## Required for Local Development

| Variable | Description | Example |
|---|---|---|
| NEXT_PUBLIC_SUPABASE_URL | Supabase project URL | https://xxx.supabase.co |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase anon/public key (safe for browser) | eyJhbGc... |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key (server-only, bypasses RLS) | eyJhbGc... |
| PHOENIX_AUTH_SECRET | Session signing secret (64-char hex) | (generate with openssl rand -hex 32) |

## App URLs

| Variable | Description | Default |
|---|---|---|
| APP_URL | Server-side base URL | http://localhost:3000 |
| NEXT_PUBLIC_APP_URL | Client-side base URL | http://localhost:3000 |
| NOTIFICATION_DASHBOARD_URL | URL used in notification emails | http://localhost:3000 |

## Email & Notifications

| Variable | Description | Notes |
|---|---|---|
| EMAIL_NOTIFICATIONS_ENABLED | Enable email sending | Set to "true" in production |
| PHOENIX_EMAIL_DELIVERY_MODE | Set to "testing" to redirect ALL mail to the test recipients (case-insensitive); any other value, including unset, is a no-op | Not the on/off switch (that is EMAIL_NOTIFICATIONS_ENABLED). Redirect targets PHOENIX_EMAIL_TEST_RECIPIENTS, else a fallback list |
| PHOENIX_EMAIL_TEST_RECIPIENTS | Comma-separated test emails | Redirects all emails in test mode |
| RESEND_API_KEY | Resend.com API key | Required for live email |
| NOTIFICATION_EMAIL_FROM | Sender address | e.g. Phoenix HR <noreply@domain.com> |
| NOTIFICATION_REPLY_TO | Reply-to address | |
| JOB_OFFER_EMAIL_FROM | Offer email sender | Falls back to NOTIFICATION_EMAIL_FROM |
| INTERNAL_MESSAGE_EMAIL_FROM | Internal msg sender | Falls back to NOTIFICATION_EMAIL_FROM |
| HR_NOTIFICATION_EMAILS | HR team emails for admin notifications | Comma-separated |
| NOTIFICATION_TEST_MODE | Force test mode | "true" to prevent real sends |

## Google Maps (Optional)

| Variable | Description |
|---|---|
| GOOGLE_MAPS_SERVER_KEY | Server-side Maps API key (geocoding, directions) |
| NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY | Browser-side Maps API key |
| NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID | Google Maps style/map ID |

## LocationIQ (Optional)

| Variable | Description |
|---|---|
| LOCATIONIQ_API_KEY | Server-side key for `src/lib/geocoding/locationiq.ts` — first-choice (free-tier) geocoder for CRM check-in addresses and the sales normalizer's pharmacy/brick geocoding ONLY. Google (`GOOGLE_MAPS_SERVER_KEY`) is still required as the accuracy fallback for low-confidence LocationIQ matches; outstation, marketing-requests, and Routes/Directions always use Google directly and never read this key. |

## Google Calendar (Optional)

| Variable | Description |
|---|---|
| GOOGLE_CALENDAR_API_KEY | Calendar API key for national holidays |
| GOOGLE_HOLIDAY_CALENDAR_ID_EG | Egyptian holiday calendar ID |

## Attendance Agent (Optional)

| Variable | Description | Default |
|---|---|---|
| ATTENDANCE_AGENT_LOCAL_URL | Local agent endpoint | http://127.0.0.1:8787 |
| ATTENDANCE_AGENT_TOKEN | Shared auth token between app and agent | |
| ATTENDANCE_AGENT_START_SCRIPT | Path to agent start script | |
| ATTENDANCE_AGENT_WORKING_DIRECTORY | Agent working directory | |
| ATTENDANCE_DEFAULT_DEVICE_ID | Default ZKTeco device ID | 1 |
| ATTENDANCE_REPORT_TIME_ZONE | Timezone for attendance reports | Africa/Cairo |

## Observability

`COMMIT_SHA` / `NEXT_PUBLIC_COMMIT_SHA` are the release identifier for the self-hosted
`app_error_events` table (server + client error capture — see docs/observability.md), set by the
deploy workflows from the same `$SHA_TAG` used for the Cloud Run image tag.

| Variable | Description |
|---|---|
| COMMIT_SHA | Runtime release identifier, set by the deploy workflows from the same `$SHA_TAG` used for the Cloud Run image tag. Feeds the self-hosted `app_error_events.release` field for server errors. |
| NEXT_PUBLIC_COMMIT_SHA | Build-time twin of `COMMIT_SHA`, baked into the client bundle and used as the release identifier for client-side error reports. |
| HEALTHCHECKS_PING_KEY | External cron-liveness dead-man's-switch. Set on the `phoenix-hr` **production** Cloud Run service ONLY — never staging, never local (see the Dead-Man's-Switch section below for why, and for the full variable table). |

See docs/observability.md for the full picture.

## Cloud Scheduler / Deployment

| Variable | Description |
|---|---|
| CRON_SECRET | Bearer-token auth checked against Google Cloud Scheduler job requests (see docs/deployment.md) |
| PHOENIX_PREVIEW_READ_ONLY | Legacy Vercel-preview read-only guard; inert on Cloud Run today (neither environment sets `APP_ENV=preview`) |
| VERCEL_ENV | Legacy — Vercel is decommissioned for hosting, so nothing sets this anymore; any code still branching on it is inert |

## Dead-Man's-Switch Monitoring (Optional)

External liveness alert for the 8 Cloud Scheduler jobs, independent of GCP Monitoring — see
docs/observability.md for what it catches and full setup steps.

| Variable | Description | Default |
|---|---|---|
| HEALTHCHECKS_PING_KEY | Healthchecks.io project Ping Key. Inert (no ping ever attempted, in any environment) until set. | (unset) |
| HEALTHCHECKS_PING_HOST | Override for a self-hosted Healthchecks instance | `https://hc-ping.com` |

## Dev-Only Variables

These should never be set in production.

| Variable | Description |
|---|---|
| PHOENIX_ENABLE_DEV_AUTH_HEADERS | Allow x-phoenix-role/x-phoenix-hr-id headers in dev |
| PHOENIX_PORTAL_SHOW_BETA_NAV | Show beta navigation items in employee portal |

## Business Rule Overrides

| Variable | Description | Default |
|---|---|---|
| PHOENIX_MONTHLY_EXCUSE_ALLOWANCE | Max excuses per employee per month | 2 |
| PHOENIX_PERMISSION_MATRIX_CACHE_SECONDS | Permission matrix cache TTL | 30 |

## GitHub Actions Secrets & Variables

Secrets flow **GitHub → Railway production** automatically: `.github/workflows/sync-railway-production-secrets.yml`
runs `scripts/sync-railway-production-secrets.mjs` (push a value) then `scripts/validate-railway-production-secrets.mjs`
(confirm it landed) on every push touching either file, or on manual dispatch. Most of the list below
only needs setting once, in GitHub — Railway picks it up from there. A number of Railway variables are
not yet mirrored to GitHub at all (no automated backup if Railway ever lost them); the sync script's own
`variables` array is the authoritative, current list of what's actually covered — treat this doc as a
map, not the source of truth for that.

**GitHub secrets AND variables both exist for the same 4 public values** (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL`) —
intentionally left duplicated: `ci.yml`'s synthetic-journey-ingest and full-e2e steps read the secret
copies directly with no variable fallback, so deleting the secret copies would silently break both.

### Core platform & auth
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_SUPABASE_URL | Supabase project URL (also a GitHub variable) |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase anon/public key (also a GitHub variable) |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Modern publishable key (also a GitHub variable) |
| SUPABASE_SERVICE_ROLE_KEY | Production service-role key — canonical, preferred by the Railway sync |
| STAGING_SUPABASE_SERVICE_ROLE_KEY | Staging service-role key — the login smoke test step in `ci.yml`'s `validate` job + both of `migration-drift-check.yml`'s staging legs |
| PRODUCTION_SUPABASE_SERVICE_ROLE_KEY | Used ONLY by `migration-drift-check.yml`'s production leg — intentionally a separate secret from `SUPABASE_SERVICE_ROLE_KEY` (see that workflow's comment); never reaches Railway |
| PHOENIX_AUTH_SECRET | Session signing secret |

### App URLs
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_APP_URL | Client-side base URL (also a GitHub variable) |

### Email & notifications
| Secret | Purpose |
|---|---|
| RESEND_API_KEY | Primary email provider |
| RESEND_WEBHOOK_SECRET | Verifies inbound Resend delivery webhooks |
| NOTIFICATION_WEBHOOK_SECRET | Verifies inbound Telegram webhook calls (`secret_token`) |
| TELEGRAM_BOT_TOKEN | Telegram Bot API token |
| NEXT_PUBLIC_ONESIGNAL_APP_ID | OneSignal app id (client-side) |
| ONESIGNAL_REST_API_KEY | OneSignal REST API key (server-side push) |

### Scheduling & agents
| Secret | Purpose |
|---|---|
| CRON_SECRET | Bearer-token auth for cron-job.org's calls into `/api/cron/*` |

### Maps & geo
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY | Browser-side Maps API key |
| NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID | Google Maps style/map ID |

### AI
| Secret | Purpose |
|---|---|
| OPENAI_API_KEY | AI-assist features (email drafting, SoS normalizer suggestions) |

### Feature flags
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_SMI_USE_FACT_TABLES | Sales-marketing-intelligence fact-table toggle |

### Infra & ops
| Secret | Purpose |
|---|---|
| RAILWAY_TOKEN | Auth for `sync-railway-production-secrets.yml`'s Railway CLI calls |
| CLOUDFLARE_API_TOKEN | Not currently consumed by any workflow or app code — held for future Cloudflare DNS/cache automation |
| SENTRY_AUTH_TOKEN | Build-time only — sourcemap upload for the Sentry Next.js plugin, never read at runtime |
| SONAR_TOKEN | SonarQube Cloud scan (workflow is currently `workflow_dispatch`-only, not running on PRs) |

### CI / testing
| Secret | Purpose |
|---|---|
| PLAYWRIGHT_DATA_USER_HRID | Data-bearing E2E test account HR ID |
| PLAYWRIGHT_DATA_USER_PASSWORD | Data-bearing E2E test account password |
| SYNTHETIC_ADMIN_HR_ID | Synthetic-journey monitoring account |
| SYNTHETIC_ADMIN_PASSWORD | Synthetic-journey monitoring account |

### Orphaned — flagged for removal
| Secret | Purpose |
|---|---|
| WIF_PROVIDER | GCP Workload Identity Federation — authenticated the now-`workflow_dispatch`-only Cloud Run deploy workflows. GCP billing closed 2026-08-01; safe to delete. |
| WIF_SERVICE_ACCOUNT | Same as above. |

### GitHub variables (non-secret)
`APP_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `RAILWAY_PROJECT_ID`,
`RAILWAY_SERVICE_NAME`, `SUPABASE_PROJECT_ID` — all verified matching their Railway counterparts.

Optional for full E2E:
- PLAYWRIGHT_DATA_USER_HRID
- PLAYWRIGHT_DATA_USER_PASSWORD
