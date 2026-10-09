---
name: a-rebase-by-the-branchs-own-session-cancels-your-ci-run
description: "A `cancelled` required check on a head you pushed usually means another session moved the branch under you — read the branch tip before calling it red, and judge a check by its LATEST run on the head."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-09T01:03:39.399Z
---

Pushing a conflict resolution onto someone else's PR branch (#5608, 9 Oct 2026, 03:43 Cairo) started
CI on merge `b33a04a61`. Six minutes later `validate` read **`cancelled`** while `checks` read
`success` — and the branch tip was no longer mine: the session that owns
`_wt-portal-deductions-ledger` had **rebased** onto a newer `main`, replacing the merge commit with
rebased copies of its own two commits. GitHub's concurrency rule cancelled the run on the orphaned
head. Nothing was broken; the resolution survived in the rebase (both suite imports and both
`runTest` registrations were at the merged head), and the PR merged green on `2092efe9b`.

**Why:** `cancelled` and `failure` look identical in a rollup, and a cancelled run is the NORMAL
result of any new push to the same ref — including one made by another session, which a local watcher
never sees. A second trap sits beside it: `gh pr view --json statusCheckRollup` returns a row per
check-run, so a superseded run leaves a `CANCELLED` row with the SAME name as the live `SUCCESS` one,
and `rows.every(r => r.conclusion === "SUCCESS")` then reads a green head as red.

**How to apply:** on any non-success conclusion, re-read `git rev-parse origin/<branch>` and the PR's
`headRefOid` before reporting — a moved tip means superseded, not failed. Judge a required check by
its **latest** run on the exact head (`/commits/<sha>/check-runs`, newest `started_at` per name), which
is also what `scripts/rollup-check-state.mjs` was taught to do in #5615 the same night. Related:
[[verify-the-emitted-artifact-never-the-source]].
