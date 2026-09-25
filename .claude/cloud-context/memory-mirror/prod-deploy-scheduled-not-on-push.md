---
name: prod-deploy-scheduled-not-on-push
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Production Cloud Run deploy triggers on schedule + manual workflow_dispatch, NOT on push/merge — a merge is not live until the next scheduled or manual deploy"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 75eb7177-dd6b-4d55-ae0e-d55ce4c9001d
  modified: 2026-07-30T02:19:30.686Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

> ⚠️ **TEMPORARILY SUSPENDED 2026-07-30 04:45→10:00 Cairo.** During this window a
> `workflow_run: [CI]` trigger IS on `main` (PR #1478, merged as `87f26e05`), so a merge
> whose CI goes green **does** deploy to production immediately. It self-expires at
> `FAST_DEPLOY_UNTIL=2026-07-30T07:00:00Z` inside the gate job, after which everything
> below is true again. See [[deploy-speed-levers-audit-2026-07-30]].

The **production** "Deploy to Google Cloud Run" workflow (`deploy-cloud-run.yml`) is triggered by **`schedule`** and **`workflow_dispatch`** only — **never by push/merge**. Confirmed 2026-07-29: every recent prod deploy run's `event` was `schedule` or `workflow_dispatch` (e.g. #1458's 13:52Z deploy was a manual `workflow_dispatch` by the prior session, not automatic). **STAGING** (`deploy-cloud-run-staging.yml`) DOES auto-deploy from main after CI.

**Consequence:** merging a PR to main does NOT make it live in production. It goes live on the next **scheduled** prod deploy (which ships whatever main head is at that moment) OR a manual `gh workflow run "Deploy to Google Cloud Run" --ref main`. So a merge and a prod-live state are decoupled.

**Why:** I twice told the owner "merging auto-deploys to prod" (for #1451/#1458) — WRONG. Those deploys were manual dispatches by the prior session, minutes after merge, which looked automatic. [[one-prod-deploy-per-task]]
**How to apply:** after merging, never claim "it's live" until a Deploy run for a commit ≥ the merge shows `success`. A manual `workflow_dispatch` deploys ALL of current main — do NOT trigger it while another session is mid-merge (you'd promote their unfinished work too); coordinate or wait for the scheduled deploy. Verify `https://phoenix-hr.satopharma.com` after. [[gcp-cloud-run-migration-2026-07]]
