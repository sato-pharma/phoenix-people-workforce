---
name: staging-deploys-daily-0340-utc-from-prod-image
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging does NOT auto-deploy on merge — it runs daily 03:40 UTC and reuses the prod-built image; prod ships every 2h. Corrects a stale AGENTS.md claim."
metadata: 
  node_type: memory
  type: project
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-07-31T20:07:27.322Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**AGENTS.md's "staging auto-deploys from `main` after CI passes" is STALE** (verified 2026-07-31 by reading the live workflows on `main`). I re-asserted that stale claim in PR #1506 and in PR #1514's body — do not trust it; the real behavior is:

| Workflow | Trigger | What it deploys |
|---|---|---|
| `deploy-cloud-run.yml` (**prod**) | `schedule: 0 */2 * * *` (00/02/…/22 UTC) + `workflow_run` after CI + `workflow_dispatch` | Builds/promotes the commit — no-traffic revision → smoke test → promote |
| `deploy-cloud-run-staging.yml` (**staging**) | `schedule: 40 3 * * *` (**daily 03:40 UTC** = 06:40 Cairo) + `workflow_dispatch` | **Reuses the image PROD already built** (`sha-<8>` from Artifact Registry), falling back to the newest `sha-*` image when the exact tag is absent |

Consequences that repeatedly mislead:
- **Merging to `main` ships nothing immediately.** Staging is up to ~24h behind; prod up to ~2h.
- **Staging can never be ahead of prod** on the normal path — it deploys prod's image. To put a commit on staging that prod never built, dispatch staging with `build_from_source: true` (its documented escape hatch).
- **A prod deploy run can report `success` while deploying nothing.** It has a `gate` job ("Decide whether there is anything to deploy"); when the gate says no, the `deploy` job shows `skipped` and the run is still green. On 2026-07-31 the `workflow_run`-triggered runs for `58910af6` and `d7fd06e0` were green with `deploy: skipped` because a **temporary self-expiring "fast-deploy window"** (`FAST_DEPLOY_UNTIL`) had lapsed — the gate logs `Fast-deploy window closed … the 2-hourly schedule still ships this commit`. That expired config was removed by #1510 (`c79d9c31`). **Always check the `deploy` job's conclusion, never the run's overall conclusion**, before claiming something shipped.
- Verify what is actually live with `gcloud run services describe phoenix-hr --region europe-west3` → `status.traffic[].percent` + the `COMMIT_SHA` env var, not from a green workflow.

Related: [[prod-deploy-scheduled-not-on-push]] · [[claude-config-audit-2026-07-31]]
