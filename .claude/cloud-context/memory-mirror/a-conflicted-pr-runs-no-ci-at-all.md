---
name: a-conflicted-pr-runs-no-ci-at-all
description: "A PR with merge conflicts (mergeStateStatus=DIRTY) gets ZERO CI runs — pull_request workflows need a merge ref GitHub cannot build, so check-runs stays 0 forever and never starts"
metadata:
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-08-21T09:24:21.830Z
---

Hit 2026-08-21 on PR #2270. Two pushes in a row produced `check-runs: 0` and
`gh pr checks` → *"no checks reported on the branch"*, while Actions was demonstrably healthy —
other branches got `pull_request` runs in the same minutes and `main` was running `push` builds.

**Cause:** `mergeStateStatus` was **`DIRTY`** (a real content conflict). A `pull_request`-triggered
workflow runs against `refs/pull/N/merge`, and GitHub cannot build that ref while the merge
conflicts — so **no run is ever queued.** Not delayed. Never.

The tell that it was this and not something else: the instant the conflict was resolved and pushed,
`mergeState` went `DIRTY` → `BLOCKED` and two runs appeared on the very next poll.

**Why this is a trap:** `check-runs: 0` is the SAME symptom as
[[a-merge-mid-session-orphans-your-next-push-silently]], and the instinct — "CI hasn't started yet,
poll longer" — burns the whole timeout either way. Three different causes, one symptom:

| `mergeStateStatus` | What `check-runs: 0` means | Fix |
| --- | --- | --- |
| `DIRTY` | conflicted — **no run will EVER be queued** | resolve the conflict locally, push |
| (PR closed/merged) | push is orphaned | new branch off `origin/main`, cherry-pick |
| `CLEAN` / `BLOCKED` | genuinely still starting | poll |

**How to apply:** read `gh pr view <n> --json mergeStateStatus,headRefOid` **first**, before
polling `check-runs` at all. One call separates "never going to run" from "not yet".

**In this repo it recurs on one file.** `tests/run-tests.ts` is appended to at the tail by every
branch, so with ~30 commits/day and several parallel sessions it collides constantly — #2270 hit
the identical conflict twice in twenty minutes as four PRs landed. `git rerere` is on and replays
the resolution, but the durable fix is to **move your registration off the tail**, next to a
related suite, leaving the tail free for whoever appends next. Always re-run
`test-wiring-complete` after resolving: it is the guard against a registration being dropped, which
would make a whole test file silently never run.

Related: [[merge-blocked-says-checks-but-means-behind]] (BLOCKED/BEHIND, a different state that
does run CI), [[gh-pr-checks-lags-behind-the-real-job-state]].
