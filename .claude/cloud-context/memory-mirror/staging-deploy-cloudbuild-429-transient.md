---
name: staging-deploy-cloudbuild-429-transient
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging Cloud Run deploy failures are usually a transient Cloud Build get-requests 429 quota, not a code bug — they self-heal on retry."
metadata: 
  node_type: memory
  type: project
  originSessionId: a1ae3f4a-4798-46a1-abd5-92535e4ba475
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

"Deploy to Google Cloud Run (Staging)" failures are almost always a **transient Cloud Build quota 429**, not a code/build problem. The failing step is `gcloud run deploy --source .`; the error is `HttpError ... status 429`, reason `RATE_LIMIT_EXCEEDED`, metric `cloudbuild.googleapis.com/get_requests`, limit `GetRequestsPerMinutePerProject` = **60/min** on project `phoenix-workforce-498619` (number 897559113412). gcloud's build-status polling blows past 60/min when 2+ `--source` builds poll concurrently.

**Why the existing mitigation doesn't fully cover it:** the staging workflow chains off prod's "Deploy to Google Cloud Run" completion (`workflow_run`) to serialize staging-after-prod **for the same commit** (documented in the workflow header, PR #1029/#1032). But that does NOT stop **different commits'** deploys from overlapping. During a merge burst (many PRs landing on `main` in one window — as on 2026-07-17), commit A's staging build and commit B's prod build poll Cloud Build at the same time → one 429s.

**How to recognize / triage:** a red staging deploy is expected churn, not an incident. Check `gh run list --workflow deploy-cloud-run-staging.yml`: you'll see fail-then-success for the same SHA (e.g. 2026-07-17: `7a53c60` 07:59 fail→08:03 success; `37ad2df` 08:58 fail→09:03 success). Production is a separate workflow and unaffected. **Do not chase a staging 429 as a code bug** — if the same commit built to prod fine, the code is fine.

**Fix options (not yet implemented, owner-gated — it's a deploy-workflow change):**
- A: bounded retry-with-backoff around the `gcloud run deploy` step in both deploy workflows (self-heal 429 in-place).
- B: a shared GitHub Actions `concurrency:` group across BOTH "Deploy to Google Cloud Run" and its staging counterpart so no two `--source` builds ever overlap regardless of commit (strongest structural fix; trades burst throughput).
- C: request a Cloud Build "Get requests per minute" quota increase (60 → higher) for the project.
Best combo: A + B.

Related: [[staging-churn-pin-branch-with-cloud-run-tag]], [[cloud-run-stale-tag-cpu-quota-exhaustion]] (different quota — CPU), [[gcp-cloud-run-migration-2026-07]].
