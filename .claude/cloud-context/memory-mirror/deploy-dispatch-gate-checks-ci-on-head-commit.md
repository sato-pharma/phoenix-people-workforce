---
name: deploy-dispatch-gate-checks-ci-on-head-commit
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — workflow_dispatch on deploy-cloud-run.yml silently skips unless CI has ALREADY concluded success on the current head of main"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd6c2994-f622-4563-b891-87464fa64cea
  modified: 2026-08-01T09:16:42.394Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

`gh workflow run deploy-cloud-run.yml` right after merging **does not deploy**.
The run goes green with `gate: success, deploy: skipped` — which looks like a
success and is easy to misread as "shipped".

**Why:** the `gate` job asks the API for the CI conclusion of `github.sha` (the
head of main *at dispatch time*) and requires it to already be `success`:

```
CI_CONCLUSION=$(gh api ".../workflows/ci.yml/runs?head_sha=$SHA&per_page=1" --jq '.workflow_runs[0].conclusion // "none"')
if [ "$CI_CONCLUSION" != "success" ]; then proceed=false
```

A merge triggers CI on the new commit; dispatching seconds later finds it
`in_progress` → `"none"`/not-success → skip. Nothing warns you.

**Hit twice on 2026-08-01** deploying the deductions restore: dispatched
immediately after merging #1571 (skip), dispatched again while main had already
moved to another PR's commit whose CI was also mid-flight (skip). Production
stayed on the old revision through both.

**How to apply:**
1. Merge.
2. `gh run list --workflow=ci.yml --commit <head-sha>` and WAIT for `success`.
3. Re-check `git log -1 origin/main` — main is a moving target in this repo, and
   the gate uses whatever the head is when the dispatch fires, not your commit.
4. Only then dispatch, and confirm `deploy` is `success`, **not** `skipped`.

`force: true` bypasses the CI check but the workflow calls it an emergency
override — do not reach for it just to skip the wait.

Verify what is actually live with
`gcloud run revisions list --service phoenix-hr --region europe-west3`, never
from the workflow's overall conclusion. Related:
[[prod-deploy-scheduled-not-on-push]], [[staging-deploys-daily-0340-utc-from-prod-image]].
