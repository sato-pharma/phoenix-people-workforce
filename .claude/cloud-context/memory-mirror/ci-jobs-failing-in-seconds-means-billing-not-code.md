---
name: ci-jobs-failing-in-seconds-means-billing-not-code
description: "All GitHub Actions checks failing in under ~15s with no failed step and no log means account billing, not a code fault — read the check-run annotation, or the job's step count."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9d18cf9e-a282-408f-bbf2-27614b1f76b7
  modified: 2026-08-28T15:04:20.617Z
---

When every required check fails in **seconds** (3–12s, against a normal 2–4 min), reports **no failed step**, and `gh run view --log-failed` answers `log not found`, the jobs never started. The cause is not in the diff.

The real message is visible only through the check-run annotation:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/actions/runs/<run-id>/jobs --jq '.jobs[0].id'
gh api repos/Gawish-1997/phoenix-people-workforce/check-runs/<job-id>/annotations --jq '.[].message'
```

On **2026-08-05 ~20:24Z** that returned: *"The job was not started because recent account payments have failed or your spending limit needs to be increased."* Last green run 20:18:41Z, first failure 20:24:03Z — a clean cutover, and `gh run rerun --failed` failed identically, so it is persistent, not a blip.

**Consequence: nothing can merge at all.** `main` requires 5 green checks with `enforce_admins: true`, so a billing stop is a total merge freeze across every PR and every session — see [[railway-merge-is-the-production-deploy]]. Production itself keeps serving: Railway deploys on push to `main` and is independent of Actions.

Second billing-driven outage here — GCP was closed the same way on 2026-08-01 (see [[railway-is-prod-cloud-run-workflow-is-dead]]). Never try to fix it: billing is the owner's account settings, off-limits.

## Recurrence 2026-08-28 — three things the entry above could not tell you

Same cause, third occurrence. Cap crossed between **14:46 and 14:58 Cairo**: run on head `0737ae32` passed everything in 5m31s, the next run on `acefcce7` died in **2 seconds**.

- **`steps=0` is a faster and surer tell than the annotation, and needs no second call.**
  `gh api repos/.../actions/runs/<id>/jobs --jq '.jobs[] | "\(.name): \(.conclusion) steps=\(.steps|length)"'`
  A job that fails having executed **zero steps** cannot have been failed by the diff. On 2026-08-28 that read `changes: failure steps=0` with every other job `skipped` — the cascade from a `needs:` dependency, which reads misleadingly like four separate problems.
- **The old billing endpoint is GONE.** `users/<u>/settings/billing/actions` now returns **HTTP 410 "This endpoint has been moved."** The live one is:
  `gh api "users/Gawish-1997/settings/billing/usage?year=2026&month=8"`
  It returns `usageItems[]` with `grossAmount`, `discountAmount`, `netAmount` per SKU per day. **Sum `netAmount`: a total landing on an exactly round figure IS the cap.** Measured that day: gross $233.58 − included $33.58 = **net exactly $200.00**, against 36,466 Actions minutes for the month. Note the endpoint reports SPEND, never the LIMIT — so after the owner raises it, the API still reads $200.00 and cannot confirm the change. **Only a rerun proves it.**
- **Recovery once he has raised it: `gh run rerun <id>` on the PR's own `pull_request`-sourced run** — verified working 2026-08-28, both the `CI` and `Security Scan (OSS)` runs, jobs went from 0 to **43 steps executing**. Rerun BOTH workflows: `secret-scan` is a required check and lives in `security-scan.yml`, not `ci.yml`. Do not reach for `gh workflow run` — a `workflow_dispatch` run's checks never enter the PR's `statusCheckRollup`, so branch protection ignores them ([[a-conflicted-pr-runs-no-ci-at-all]] neighbours this trap).

**Own the share of it that is yours.** Three CI cycles were spent on one PR that afternoon because each new commit re-ran the full suite; the repo's standing rule against reflexive `gh pr update-branch` exists for the same economics. Batch changes onto an open PR instead of pushing each fix separately.

**Why:** a fast total failure looks exactly like a broken build, so the instinct is to hunt the diff — or to blame a merge conflict you just resolved, which is how it presented on 2026-08-05.

**How to apply:** if ALL checks fail fast and no step is named, read `steps=0` and the annotation BEFORE touching any code, confirm Actions is `operational` at githubstatus (an outage creates NO run at all, billing creates one and fails it), and tell the owner it is billing. He raises the limit; you rerun.
