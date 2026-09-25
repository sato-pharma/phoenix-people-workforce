---
name: prod-excellence-waves-2026-07
description: "Post-migration \"Production Excellence\" remediation program (4 waves) on GCP Cloud Run; Waves 1-2 shipped, 3-4 pending."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5fc35f6d-fde7-4c5d-9ca9-18c04c141b55
---

After the Vercel→GCP migration + audit ([[gcp-cloud-run-migration-2026-07]]), the owner mandated a **Production Excellence** program (2026-07-11): eliminate every known defect/stale-config/Vercel-dep/Cloud-Run-incompat, add monitoring/DR, verify everything. Plan file: `C:\Users\satoh\.claude\plans\continue-the-phoenix-workforce-mutable-wall.md`. Delivery = **wave-by-wave** (each = PR → CI-gated auto-deploy → verify).

**Owner decisions:** Cairo scheduler times (defaults: daily 06:30, sync 09/12/19, reconcile Sun 04:00); min-instances=1 always; **full async re-architecture** for heavy routes+caches; alerts → owner email achieverrr303@gmail.com.

**WAVE 1 SHIPPED (PR #987, merged):** removed 3 legacy `*.vercel.app` CSRF origins; replaced dead `!process.env.VERCEL` cron guard with `!isProductionRuntime()` in 7 routes; proxy.ts preview gate → APP_ENV; attendance sync-now/agent-start now return 501 (never spawn powershell.exe on Cloud Run — gated by `canManageLocalAttendanceAgent()` in src/lib/attendance/local-agent.ts); new CI gates `scripts/check-no-stale-domains.mjs` + `scripts/validate-env.mjs`; **deploy workflow hardened**: `workflow_run` gate on CI success, SHA-pinned actions, validate-env pre-deploy, deploy `--no-traffic --tag` → smoke isolated revision → promote (bad revision never gets traffic), `npm audit` critical gate. validate-env with the real secret CONFIRMED GitHub `NEXT_PUBLIC_APP_URL`=canonical.

**WAVE 2 SHIPPED (PR #988, merged; rev phoenix-hr-00039-cuw):** `min-instances=1` (cold-start gone, warm ~0.57s); 4 scheduler jobs → `Africa/Cairo`; `/api/healthz` (liveness) + `/api/readyz` (Supabase ping + env) — registered in access-registry, deploy smoke checks healthz; `src/lib/observability/log.ts` GCP structured logger (severity+labels) logging cron 401s (event=cron_unauthorized), webhook sig failures, dispatcher failures; `pruneOldAppErrorEvents()` (90d) in daily cron; `.run.app`/unknown host tests.
**GCP monitoring created (via Monitoring/Logging REST API — gcloud beta/alpha components NOT installable here):** notification channel `.../notificationChannels/17782674617968101953` (owner email); uptime check `.../uptimeCheckConfigs/phoenix-hr-healthz-xUvjqdqBJ7s` on /api/healthz; alert policies: Cloud Run 5xx rate, p95 latency, uptime-failure, Cloud Scheduler failures (log-metric `phoenix_scheduler_failures`), app auth/cron/webhook failure spike (log-metric `phoenix_app_auth_failures`).

**WAVE 3 SHIPPED (PRs #989 + #990, rev phoenix-hr-00043-fud):** durable `background_jobs` queue (migration 20260711140000 APPLIED TO PROD + verified — table/claim RPC/`job-exports` bucket; owner approved; staging was read-only so verified on prod directly). `src/lib/background-jobs/{service,worker}.ts`; CRON_SECRET-authed worker `/api/cron/background-jobs` drained by Cloud Scheduler `phoenix-background-jobs` (*/10 Cairo — NOTE: had to copy the current CRON_SECRET header from a working job since it was rotated again mid-session, fingerprint fbf476651c5d now shared by all jobs+env). Async data-backup (POST enqueue → status/download routes → Storage); UI (`src/components/admin/async-backup-download.tsx`) generates the all-modules export in the background. Cache item (#9) resolved by EVIDENCE (bounded 30s–5min TTLs, fail-closed, auth reads live data not caches — no rewrite). sales-upload/commit + iReports async conversion NOT done (data-backup was the flagship; same pattern reusable).

**WAVE 4 PENDING:** authenticated role smoke, live email+webhook test, external-callback inventory, perf baseline, DR runbook, docs cleanup (observability.md stale), DB advisor hardening (revoke SECURITY DEFINER RPC execute + search_path), Secret Manager migration. Owner-gated: Resend dashboard, Supabase Auth Site URL, live-email send approval, role test creds, synthetic-journey scheduling.
