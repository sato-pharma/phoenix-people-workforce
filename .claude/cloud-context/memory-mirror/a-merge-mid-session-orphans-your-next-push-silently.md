---
name: a-merge-mid-session-orphans-your-next-push-silently
description: "If the owner merges your PR while you are still working, your next push to that branch is orphaned — the PR head stops updating, NO CI fires, and `gh pr checks` keeps reporting the OLD run as green"
metadata: 
  node_type: memory
  type: project
  originSessionId: 74378048-9128-494e-b932-c66a30368123
  modified: 2026-08-21T06:16:05.888Z
---

Hit 2026-08-21 on PR #2255. The owner merged it at 06:08:00Z while I was still writing a
second commit he had just asked for. I pushed that commit to the same branch; the push
**succeeded** (`git ls-remote` confirmed the remote ref moved). Everything after that lied:

| Check | What it said | Truth |
| --- | --- | --- |
| `git push` | `85bb2fad..6cd7680f` — success | true, but irrelevant |
| `gh pr checks 2255` | all four **pass**, settled in 30s | the FIRST commit's run, re-reported |
| `gh run list --branch <b>` | run titled with my NEW PR title | old run id, old commit — the **title** updates when you edit the PR, the run does not |
| `gh pr view --json headRefOid` | still the OLD sha | PR was MERGED, so its head froze |
| `check-runs` for the new sha | `total_count: 0` | **nothing ever ran on the new commit** |

**Why:** a merged PR is closed. GitHub stops associating new pushes to that branch with it, and
`pull_request`-triggered workflows never fire. So the branch carries a commit that no CI has ever
seen, while every convenient status command keeps showing the pre-merge green.

**How to apply:**

- **Never accept `gh pr checks` as proof.** It is keyed to the PR, not to your commit. Verify
  against the sha you actually pushed:
  `gh api repos/<o>/<r>/commits/$(git rev-parse HEAD)/check-runs --jq .total_count`.
  **`total_count: 0` means no CI has run on your code at all** — that is the tell, and it reads
  identically to "not started yet", so poll it, don't assume.
- **A green that settles in ~30s is a red flag**, not good news — real `validate` here takes ~4m24s.
  Compare the job URLs: if the run id matches the previous commit's, you are reading a stale run.
- **The recovery is a NEW branch off the new `main`, never the merged one** — see
  [[reusing-a-squash-merged-branch-makes-a-conflicting-pr]]. `git checkout -b <new> origin/main`
  then `git cherry-pick <orphaned-sha>`; the squash-merged content is already in `main`, so the
  follow-up commit applies cleanly.
- **Check what actually shipped before assuming your work is live**: the merge deploys immediately
  ([[railway-merge-is-the-production-deploy]]), so `/api/healthz` `revision` will show the merge
  commit while your later commit is nowhere — prod had the half of the fix that merged and none of
  the half the owner had just approved.
- **Verifying a deploy by exact SHA match is the WRONG TEST here** and produces a false
  "not deployed". This repo ships ~30 commits/day: 2026-08-21 my merge `a086665a` was superseded by
  two more merges within 3 minutes, so `/api/healthz` `revision` went straight past it and a poll
  waiting for equality ran its full 20 minutes and declared failure while the change was live.
  **Test CONTAINMENT, not equality:**
  `git merge-base --is-ancestor <my-merge-sha> <serving-revision>`. Strongest check of all is to
  read the file out of the serving commit itself:
  `git show <serving-revision>:path/to/file.ts`. Only that proves what production is running.

- Related: [[gh-pr-checks-lags-behind-the-real-job-state]] is the milder version of this (lag);
  this one is not lag, it never runs at all.
