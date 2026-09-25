---
name: merge-blocked-says-checks-but-means-behind
description: "gh pr merge failing with 'N of N required status checks are expected' when all have actually passed used to mean the branch was BEHIND main — SUPERSEDED 2026-08-05: strict is now false, BEHIND no longer blocks, and the old fix (gh pr update-branch) is now the expensive thing you should NOT run reflexively"
metadata: 
  node_type: memory
  type: project
  originSessionId: 429aa81f-8bf3-4816-993f-e6aaaadc1e75
  modified: 2026-08-22T22:19:55.294Z
---

🔴 **SUPERSEDED THE NEXT DAY — 2026-08-05. Read this before acting on anything below.**

This file's whole diagnosis rests on `strict: true`. **That was turned OFF on 2026-08-05 with the
owner's approval, one day after this was written**, because `gh pr update-branch` was the dominant
GitHub Actions cost and had hit the spending cap, freezing every merge. Verified live 2026-08-23:
`required_status_checks.strict` is **`false`**.

What that changes:

- **A PR behind `main` is no longer refused.** `BEHIND` is no longer a merge blocker, so the symptom
  this file explains should not recur from that cause.
- **The prescribed fix is now the thing to avoid.** `gh pr update-branch` costs ~16 Actions minutes,
  moves the head SHA and discards the prior green CI. AGENTS.md §2: run it **only** when the change
  genuinely depends on something newly on `main`, never as merge ceremony.
- **The count is now 4, not 5** — `validate`, `lint`, `typecheck`, `secret-scan`. Semgrep's
  `sast-scan` was deliberately never restored and no longer runs at all, so the "`sast-scan` pending"
  observation below can no longer happen either.

**What still holds, and is why this file is kept:** the *reasoning move*. A GitHub merge refusal
worded as "N of N required status checks are expected" can be true while every check has genuinely
passed — the message names checks but is really reporting mergeability state. **Diagnose with
`gh pr view <n> --json mergeable,mergeStateStatus`, never by re-reading `gh pr checks`.** And
`gh pr checks` really does serve stale data ([[gh-pr-checks-lags-behind-the-real-job-state]]) — trust
`gh run view` or the check-runs API. Today the state to expect on a blocked merge is a failing
required check or a conflict ([[a-conflicted-pr-runs-no-ci-at-all]]), not `BEHIND`.

Everything below is the original 2026-08-04 record, kept as the worked example.

---

Hit live 2026-08-04 on PR #1730. `gh pr merge --squash` was rejected with:

> GraphQL: 5 of 5 required status checks are expected. (mergePullRequest)

All five had already reported `completed/success` on the head SHA — verified directly with
`gh api repos/.../commits/<sha>/check-runs`. The message is misleading: "expected" reads like the
checks never ran, so the instinct is to go chase CI. **The real cause was `mergeStateStatus=BEHIND`**
— another PR merged in the minutes between opening and merging, and protection has `strict: true`
("require branches to be up to date").

**Diagnose with `gh pr view <n> --json mergeable,mergeStateStatus`, not with `gh pr checks`.**
`BEHIND` is the tell. Note `gh pr checks` also served stale data in the same session — it showed
`sast-scan pending 0` for minutes after `gh run view` showed that job `completed/success` in 3m57s.
Trust `gh run view` / the check-runs API over `gh pr checks`.

Fix is `gh pr update-branch` per `AGENTS.md` §2 — and its documented consequences both
bit: the merge commit lands on the **remote** (re-sync with `git fetch` + `git merge --ff-only`
before touching anything), and the head SHA moves so **CI re-runs and the earlier green is void**.

**Why it keeps happening here:** with ~30 commits/day and several parallel sessions, `main` moves
during the life of almost every PR. Expect `BEHIND` as the normal case, not the exception. In this
one session `main` moved three times mid-work (#1727, #1728, #1729).

Related: [[concurrent-session-branch-switch-recovery]], [[gh-pr-merge-auto-merges-immediately]].
