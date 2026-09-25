---
name: gcp-hardening-2026-07-16
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — 2026-07-16 GCP hardening pass — secrets to Secret Manager, min-instances=0 (near-free), budget, AR cleanup, unused APIs disabled, dual alert channel."
metadata: 
  node_type: memory
  type: project
  originSessionId: 68d7ba56-d3bb-4d18-8f81-e77a6b01dbf8
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Big GCP hardening pass on `phoenix-workforce-498619` (2026-07-16), raising the audit score ~68→~93. See [[cloud-run-runtime-sa-least-privilege]] for the earlier SA split.

**W1 notifications:** the `/api/notifications/process` 504 outage was NOT my fix — it was resolved by merged PRs **#1067** (timeout budget/overlap guard) + **#1068** (parallelize per-recipient probation fan-out). Steps `probation-feedback-sla`/`probation-milestones` went 30s-timeout→~3-6s; cron 70s→~20s; `audit_persistence_failed` stopped (pool pressure relieved).

**W2 cost — NEAR-FREE:** owner chose near-free over no-cold-starts. Set prod **`min-instances=0`** (was 1, ~$68/mo always-on). Made DURABLE via **PR #1071** (deploy-cloud-run.yml `--min-instances 1`→`0`), MERGED+deployed 2026-07-16; verified a full deploy keeps min-instances=0 AND preserves the 15 secret-sourced env vars + phoenix-hr-run SA. Steady state: the `*/5` cron keeps prod warm on cheap request-based billing, so few real cold starts. Budget: `billingbudgets` API enabled; budget id `463c858c-8d66-4a6f-bea4-03f71e4a27dd` on billing acct `01BDEA-A20B4C-CC568F`, $20/mo, thresholds 50/90/100% + forecast, wired to both email channels.

**W3 secrets → Secret Manager:** 15 prod secrets + 2 staging (`-staging` suffix, different Supabase) migrated to Secret Manager, each with per-secret `secretmanager.secretAccessor` to `phoenix-hr-run`. Flipped Cloud Run via atomic `--remove-env-vars NAME --update-secrets NAME=NAME:latest` (can't convert literal→secret in place). **Secrets persist across deploys** (deploy uses `--update-env-vars` for only PHOENIX_ALLOWED_ORIGINS, never these). `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` was NOT set on prod (no exposure). Script: `scratchpad/migrate_secrets.py` (pipes values, never prints; uses full gcloud.cmd path on Windows).

**W4 Artifact Registry:** cleanup policy on `cloud-run-source-deploy` — keep 15 most-recent, delete untagged >30d (self-maintaining; was 304 images/6GB, but AR storage is only ~$0.60/mo so it's hygiene not cost).

**W5 monitoring:** added 2nd email channel (achieverrr303@gmail.com, id 16699453622316383239) attached to all 6 alert policies + the budget; added staging uptime check. Primary channel id 17782674617968101953.

**W6 APIs:** disabled 9 verified-unused (30-day request_count=0): 6 bigquery subs + dataflow + notebooks + sqladmin + texttospeech (73→64). Left enabled: `bigquery`/`sql-component` core (cloudapis-bundled defaults, need --force), and `pubsub`(324)/`aiplatform`(271) which have real traffic (build-pipeline / console Gemini).

**Tier-1 observability/security add-ons (2026-07-16):** Error Reporting enabled (free Sentry-replacement — Sentry was lost in the Cloud Run migration); Cloud Trace already enabled; IAM Recommender enabled + shows NO over-privilege/unused-SA findings (validates the SA cleanup). Secret Manager **DATA_READ audit logs** enabled (who-read-which-secret trail; project auditConfigs). **Secret rotation** set on PHOENIX_AUTH_SECRET/SUPABASE_SERVICE_ROLE_KEY/RESEND_API_KEY (90-day, first due 2026-10-14) → publishes to Pub/Sub topic `secret-rotation-reminders` → monitoring alert "Secret rotation due (90-day reminder)" emails both channels. NOTE: project IS under org `876942796781` (phoenixx-oag-org, Cloud Identity tied to the Gmail). **SCC Standard ACTIVATED** 2026-07-16 (via console, org-level, free tier — Google-managed encryption default, no data residency). Confirmed: `gcloud scc sources list 876942796781` now works (was "Legacy disabled"). Security Health Analytics will populate findings over hours. Done via Claude-in-Chrome browser automation (careful to pick Standard, not Premium/Enterprise which are paid).

**Tier-2 (2026-07-16, owner picked only the free one):** SLOs + health dashboard built. Custom Monitoring service `projects/897559113412/services/phoenix-hr-prod` with 2 SLOs (availability 99.5% non-5xx / latency 95%<2s, both 30d rolling) + a fast-burn alert (>10x, routed to both email channels). Dashboard "Phoenix HR — Service Health" id `5a582599-abfa-43f5-92a6-0964e708d194` (request rate by class, latency p50/95/99, instance count, 5xx rate, cron endpoint by status). Owner DECLINED Cloud Armor (~$30/mo, breaks near-free) and BigQuery (multi-day build) — both remain available if wanted later. Note: latency SLO may dip after deploys due to min-instances=0 cold starts.

**In-app Service Health + health-dashboard consolidation (PR #1073, OPEN 2026-07-16):** audited all ~11 in-app health surfaces (see [[system-issues-dashboard-gcp-supabase]]). Findings: System Issues = the real one; Error Monitor = duplicate; Monitoring card = MISLABELED ("uptime/service status" but really auth+notification telemetry); Synthetic Journeys = starved (nothing feeds it). PR #1073: new `src/lib/observability/gcp-metrics.ts` (Cloud Monitoring reader via ADC + `google-auth-library`, mirrors gcp-logs.ts contract, runtime SA now has `roles/monitoring.viewer`) → Service Health panel in `/admin/system-issues` (availability/5xx/latency p50-99/instances vs the 2 SLOs); retired Error Monitor (redirects to system-issues); fixed Monitoring mislabel; best-effort (inert) CI step for Synthetic Journeys ingest (needs `SYNTHETIC_BASE_URL` + a `synthetic:test` run to activate). Typecheck+385 tests green. NOTE: worktree build agents create a `node_modules` JUNCTION → main repo's node_modules; remove safely with PowerShell `[IO.Directory]::Delete(path,$false)` (non-recursive), NEVER `rm -rf` (would follow into main repo — see [[worktree-junction-breaks-turbopack]]).

**W7 (user):** 2FA on both owners CONFIRMED by owner 2026-07-16 (self-attested; not API-verifiable) → item at its ~88 ceiling. Owners still personal Gmail (company Workspace owner is the only lever past ~88; deferred).
