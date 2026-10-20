---
name: a-main-build-step-can-be-cancelled-with-no-code-fault
description: "a push-to-main run's validate Build step can end 'The operation was canceled' (8m38s vs the usual 5 min) with static, unit and checks all green — the release gate skips and the deploy is withheld; `gh run rerun <push run id> --failed` turned it green, and the NEXT merge carried production forward; cause never proven, GitHub showed no incident"
metadata:
  node_type: memory
  type: project
  originSessionId: b2b16e72-ac86-4c40-92f7-ae25603160ee
  modified: 2026-10-20T08:02:38.612Z
---

**Measured 2026-10-20, merge `f2472792c` (roll-up #6198).** `main`'s `ci.yml` push run failed 10:10 Cairo:
`validate` ran 9m19s and its `Build` step was `cancelled` ("The operation was canceled" annotation) at 8m38s,
where the two earlier `main` builds took ~5 min (06:54–06:59 UTC). `static`, `unit (1-3)` and `checks` passed,
so `release-gate` was **skipped**, the deploy row stayed `failure`, and production kept serving the previous
commit. The job's `timeout-minutes` is 20, so it was not the job timeout; GitHub's status page read all systems
operational afterwards, and the same tree had built fine minutes earlier. **Cause not proven (n=1).**

**What worked:** `gh run rerun <push run id> --failed` (the repo's documented recovery — never walk away from a
red `main` run). Attempt 2 went green and `main`'s CI read `success`. The deploy row for `f2472792c` never posted a
terminal status itself; another session's merge (#6200) deployed at 10:37 and **carried it forward** (`verify-shipped`
reads that as CARRIED/SHIPPED, benign). The merge changed no runtime code, so nothing user-facing waited on it.

**How to read it next time:** `failure` with a `cancelled` step and a *completed* `static`/`unit` is a cancelled
build, not a red suite — read `jobs/<id>.steps[]` before touching code. The verifier's exit 3 NOT LIVE after 30 min
is not a pass; check `actions/runs?head_sha=<merge sha>` for `validate`. Related: [[github-actions-status-can-freeze-while-the-jobs-actually-run]],
[[a-rebase-by-the-branchs-own-session-cancels-your-ci-run]], [[the-merge-guard-reads-a-concurrent-merge-as-not-green]].
