---
name: prod-verify-region-europe-west3
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Verify prod Cloud Run traffic at europe-west3, NOT us-central1 (stale standby)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f2052a5b-d2b4-46ea-9c8a-82be1c8eb6a0
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

When verifying a production Cloud Run deploy (which revision holds 100% traffic, its `sha-*` tag), query **`--region=europe-west3`** — that is the live production region since the 2026-07-17 cutover. `us-central1` is now a **stale rollback/standby** region (kept until ~2026-07-24) whose old revisions still exist and still report a "100% traffic" revision of their own.

**Why:** On 2026-07-17 I chased a phantom "concurrent-deploy race": every check showed prod stuck on an OLDER revision (`phoenix-hr-00261-vav` = `sha-0b764721`) even after two successful deploys of `caf8056e`. Root cause was not a race — I was describing `us-central1` (the standby) the whole time. The real prod region `europe-west3` was already serving `sha-caf8056e` (revision `phoenix-hr-00026-cej`) at 100%. My own ScheduleWakeup verification prompt had hardcoded `--region=us-central1`, carried over from pre-cutover instructions, and I trusted it across several turns.

**How to apply:** In any `gcloud run services describe` / `gcloud run revisions list` for prod verification, use `--region=europe-west3 --project=phoenix-workforce-498619`. Revision numbers also disambiguate: europe-west3 is low (00026 as of the cutover), us-central1 is high (00261) — a 5-digit prod revision like `phoenix-hr-002xx` means you're on the OLD region. Don't hardcode a region into a long-lived ScheduleWakeup/loop prompt without re-checking it. The deploy workflow itself (`.github/workflows/deploy-cloud-run.yml`, `REGION:`) is the source of truth for the current prod region. See [[gcp-speed-audit-2026-07-17]].
