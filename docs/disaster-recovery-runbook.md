# Phoenix Workforce — Disaster Recovery & Operations Runbook

> ## ⛔ THIS RUNBOOK IS OUT OF DATE — READ THIS FIRST
>
> **Production moved from GCP Cloud Run to Railway on 2026-08-01.** The GCP billing account was
> closed and every billable API in project `phoenix-workforce-498619` now returns
> `BILLING_DISABLED`. Everything below that starts with `gcloud` will fail, including — most
> dangerously — the rollback procedure, which is the one thing you would reach for at 3am.
>
> **Until this document is rewritten, use these instead:**
>
> | You need to | Do this |
> |---|---|
> | **Roll back a bad deploy** | Railway → project `Phoenix-HR-Workforce` → service `phoenix-people-workforce` → **Deployments** → find the last good one → **Redeploy**. There is no traffic-splitting; it is all-or-nothing. |
> | Confirm what is live | `GET /api/healthz` and read `revision`. Not the workflow list — merges no longer go through a deploy workflow. |
> | Check readiness | `GET /api/readyz` → `{database:true, env:true}`, `warnings: []` |
> | Check email | `GET /api/health/email` → 200 healthy |
> | **Check alerts** | **There are none.** All five Cloud Monitoring policies and the uptime check died with GCP and nothing has replaced them. Healthchecks.io still covers cron liveness only. |
> | Read logs | Railway → service → **Deploy Logs**. Cloud Logging is gone, so the `labels.event` search recipes below no longer apply — `event` is now a top-level JSON key. |
>
> Scheduling: the 8 Cloud Scheduler jobs are dead. A `phoenix-cron` Railway service exists but its
> effectiveness is unverified. `scripts/setup-gcp-cron.sh` remains the only reliable inventory of
> what is *supposed* to run — read it, do not run it.

_Historical context (pre-2026-08-01): production ran on **GCP Cloud Run** (project `phoenix-workforce-498619`, region `europe-west3` since the 2026-07-17 region cutover, service `phoenix-hr`) at **https://phoenix-hr.satopharma.com**, backed by Supabase (`ozucdzovmcqvepbozvqf`), Resend (email), and Cloud Scheduler. The domain and Supabase project are unchanged. No secret values appear in this document._

## 1. Incident response — first 5 minutes

1. **Confirm scope:** open `https://phoenix-hr.satopharma.com/api/healthz` (liveness) and `/api/readyz` (dependency readiness). `readyz` returns `{database:true, env:true}` when healthy, HTTP 503 when a dependency is down.
2. **Check alerts:** GCP Monitoring → Alerting. Active policies: Cloud Run 5xx rate, p95 latency, uptime-check failure, Cloud Scheduler failures, app auth/cron/webhook failure spike. Alerts deliver to the owner email channel.
3. **Check logs:** Cloud Logging → `resource.type="cloud_run_revision" resource.labels.service_name="phoenix-hr" severity>=ERROR`. Structured events carry `labels.event` (`cron_unauthorized`, `webhook_signature_invalid`, `cron_failed`, `background_job_failed`).
4. **Classify:** app error (deploy a fix / roll back) vs data issue (see §4) vs dependency outage (Supabase/Resend status pages).

## 2. Rollback (fastest recovery for a bad deploy)

Cloud Run keeps prior revisions; traffic can be moved instantly with no rebuild.

```bash
# List recent revisions (most recent first)
gcloud run revisions list --service=phoenix-hr --region=europe-west3 --project=phoenix-workforce-498619

# Roll 100% traffic back to a known-good revision
gcloud run services update-traffic phoenix-hr \
  --region=europe-west3 --project=phoenix-workforce-498619 \
  --to-revisions <GOOD_REVISION>=100
```

The deploy pipeline (`.github/workflows/deploy-cloud-run.yml`) already deploys **no-traffic + smoke-tested** and only promotes on success, so a broken build should not reach 100% in the first place. Container images/revisions are retained by Cloud Run for rollback.

## 3. Redeploy / forward-fix

- Merge a fix to `main` → CI must pass → the deploy workflow auto-deploys (gated on CI success, SHA-pinned actions, env-validated, no-traffic → smoke → promote).
- Manual: Actions → "Deploy to Google Cloud Run" → **Run workflow** (`workflow_dispatch`), or `gcloud run deploy phoenix-hr --source . --region europe-west3 --project phoenix-workforce-498619`.

## 4. Database recovery (Supabase)

- **NEVER** run a destructive restore on production without explicit owner approval and a verified backup.
- **Point-in-time recovery / backups:** Supabase dashboard → Database → Backups (owner-gated; confirm PITR + retention are enabled — see §8).
- All schema changes are migration-based (`supabase/migrations/`). To recover schema, re-apply migrations to a fresh project.
- The durable job queue (`background_jobs`) and `app_error_events` are non-critical/transient; safe to truncate if corrupted (they hold no business records).

## 5. Secret rotation

Secrets live in the Cloud Run service env (owner-managed). To rotate one (owner-run — never minted or entered by automation):

```bash
# Example shape (values entered by the owner; not shown here):
gcloud run services update phoenix-hr --region=europe-west3 --project=phoenix-workforce-498619 \
  --update-env-vars "<NAME>=<NEW_VALUE>"
```

`CRON_SECRET` rotation must also update the `Authorization: Bearer` header on **all** Cloud Scheduler jobs (`phoenix-notify-daily`, `phoenix-process-notifications`, `phoenix-ireports360-sync`, `phoenix-reconcile-visits`, `phoenix-background-jobs`) in the same window, or crons 401. `RESEND_WEBHOOK_SECRET` rotation must also be updated in the Resend dashboard.

## 6. Pause switches (containment)

- **Email:** set `EMAIL_NOTIFICATIONS_ENABLED=false` (all sends skip) or `PHOENIX_EMAIL_DELIVERY_MODE=testing` (redirect to internal test inboxes) via a Cloud Run env update.
- **Crons:** `gcloud scheduler jobs pause <JOB> --location=us-central1 --project=phoenix-workforce-498619` for each job.
- **Read-only-ish:** `APP_ENV=preview` + `PHOENIX_PREVIEW_READ_ONLY=true` blocks most mutations (preview-read-only guard) — use only if the deployment is intended as a temporary safe read surface.

## 7. External callback / integration inventory

| Integration | Direction | Auth | Endpoint / config location | Idempotent |
|---|---|---|---|---|
| Resend (email) | outbound | `RESEND_API_KEY` | `api.resend.com/emails` | Idempotency-Key header |
| Resend webhook | inbound | Svix signature (`RESEND_WEBHOOK_SECRET`) | `…/api/webhooks/resend` (owner sets in Resend dashboard) | `provider_event_id` upsert |
| Supabase (DB/Storage/GoTrue bridge) | both | anon + service-role keys | `NEXT_PUBLIC_SUPABASE_URL` | — |
| Telegram | both | bot token + `NOTIFICATION_WEBHOOK_SECRET` | `api.telegram.org`; inbound `…/api/integrations/telegram/webhook` | secret-token header |
| iReports360 CRM | outbound | `IREPORTS360_USERNAME/PASSWORD` | `IREPORTS360_BASE_URL` | chunk upsert |
| Google Maps / Calendar | outbound | server + browser keys | Google APIs | — |
| OpenAI (+ fallbacks) | outbound | `OPENAI_API_KEY` | api.openai.com | — |
| On-prem attendance agent | inbound | `ATTENDANCE_AGENT_TOKEN` bearer | `…/api/attendance/raw-punches` | `ON CONFLICT DO NOTHING` |
| Cloud Scheduler → crons | inbound | `CRON_SECRET` bearer | `/api/notifications/*`, `/api/cron/*` | per-job |
| GitHub Actions → Cloud Run | deploy | Workload Identity Federation | `WIF_PROVIDER` / `WIF_SERVICE_ACCOUNT` | — |

## 8. Owner-gated verifications (external consoles)

| Check | Where | Expected |
|---|---|---|
| Resend webhook endpoint | Resend → Webhooks | `https://phoenix-hr.satopharma.com/api/webhooks/resend`; signing secret == `RESEND_WEBHOOK_SECRET` |
| Supabase Auth Site URL | Supabase → Auth → URL Config | Site URL + redirects = canonical domain (low impact: app uses app-managed auth, bridge uses admin API) |
| Supabase backups / PITR | Supabase → Database → Backups | PITR enabled + retention that meets policy |
| GCP alert notification channel | Monitoring → Alerting → Channels | owner email verified/receiving |

## 9. Vercel retirement

There is **no runtime dependency on Vercel** (verified by the `check-no-stale-domains` CI gate — no `vercel.app` / `process.env.VERCEL` in shipped source). The old Vercel deployment is useful only as a temporary rollback reference and can be decommissioned once (a) the Resend webhook endpoint is confirmed on the new domain and (b) an authenticated role smoke passes. Keep DNS pointed at the Cloud Run domain mapping (Google-managed cert).
