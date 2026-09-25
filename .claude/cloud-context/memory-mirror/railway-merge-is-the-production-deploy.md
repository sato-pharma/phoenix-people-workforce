---
name: railway-merge-is-the-production-deploy
description: "Since 2026-08-01 production is Railway, not Cloud Run: a merge to main ships to production immediately, and GCP is dead on purpose."
metadata: 
  node_type: memory
  type: project
  originSessionId: a2224779-e5db-46b9-962c-b3642028fdb4
  modified: 2026-08-09T08:22:23.055Z
---

**A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY.** Railway is GitHub-connected and deploys on
push, at full traffic — no cron wait, no staged rollout, no smoke test, and because branch
protection requires **zero** status checks, no requirement that CI was ever green. Never merge
anything you are not willing to have serving employees within minutes.

**Verify production with `curl https://phoenix-hr.satopharma.com/api/healthz` and read `revision`.**
Never `gcloud run revisions list`, never the workflow list. Confirm the serving revision actually
contains your commit (`git merge-base --is-ancestor <merge-sha> <revision>`) — a merge is not proof
of a deploy, and rollover takes a few minutes.

**"A few minutes" can mean "never" with zero error surfaced.** Confirmed live 2026-08-09: a merge's
auto-deploy webhook can be silently `SKIPPED` by Railway (not queued, not failed — just discarded)
if another deploy is still building when it arrives, which this repo's merge rate makes routine.
`gh pr view` still says MERGED, CI was still green, nothing anywhere shows red. See
[[railway-auto-deploy-can-silently-skip-a-race]] for the fix (`railway redeploy --yes
--from-source`, NOT plain `railway redeploy`) and how to detect it (`railway deployment list`,
not the GitHub deployments API).

**GCP is dead on purpose.** Billing account `01BDEA-A20B4C-CC568F` was closed over an unpaid balance
the owner chose not to settle. Every API in `phoenix-workforce-498619` returns `BILLING_DISABLED`.
`deploy-cloud-run.yml` is trigger-disabled, so `deploy: skipped` there is EXPECTED, not a problem —
**do not "fix" it, do not dispatch it, and never recommend restoring the billing account.** Two
symptoms trace to this: Cloud Build 403 "billing account ... is delinquent", and
`BillingNotEnabledMapError` in the browser console (Maps later moved to a new Google project).

Cost of relearning this: several wasted rounds on 2026-08-01 dispatching a dead pipeline and
diagnosing billing, while the Railway cutover commit (`f7918074`, "record the Railway cutover") sat
in `main`'s log the whole time. **AGENTS.md §§ 2–3 is authoritative — read it before deploying.**

These older memories are now WRONG: [[staging-deploys-daily-0340-utc-from-prod-image]] ·
[[prod-deploy-scheduled-not-on-push]] · [[deploy-dispatch-gate-checks-ci-on-head-commit]] ·
[[prod-verify-region-europe-west3]]. Related: [[railway-migration-live-topology-and-cli]].
