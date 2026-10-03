---
name: a-closed-pr-may-already-have-shipped-via-a-rollup
description: "A CLOSED PR is NOT lost work — a roll-up carrying its commits closes it, so read whether `main` holds the FILES before saying anything; never read the PR state as the answer, and never hand him a merge for a PR that no longer exists."
metadata:
  node_type: memory
  type: project
---

`gh pr view <n>` returning `CLOSED` with `mergedAt: null` looks exactly like abandoned work, and it is
the shape a roll-up leaves behind: `scripts/rollup-prs.mjs --apply` builds one branch from several
members, and once that merges the members are closed — by `--settle`, or by hand — with no merge commit
of their own. **Their content is on `main` under the roll-up's number.**

Measured 2026-10-03. PR **#5253** (the Turbify mailbox sign-in fix) read `CLOSED`, both required checks
`SUCCESS` on `eff42d554`, and `gh pr list` showed **no open PRs at all**. I was one line from telling him
"merge 5253" — a number that no longer existed. What actually happened: a parallel session's roll-up
**#5261** (`627b47f42`, *"roll up 4 open PRs into one merge"*) carried it, and production was already
serving that exact sha.

**The check that settles it, in this order:**

1. `git fetch`, then `git log origin/main --oneline` — look for a `chore: roll up N open PRs` commit.
2. `git diff --stat <my head> origin/main -- <every file the branch changed>`. **Empty output is the
   proof**, and it is the only one: it answers both "did it land" and [[a-rollup-ships-a-members-stale-head-not-its-latest]]
   — whether the roll-up shipped my FINAL commit or an older head — in one read.
3. `curl /api/healthz` and check `revision` is that commit or a descendant of it.

**Why the file comparison and not the commit graph:** a squash merge rewrites the sha, so my commits are
never ancestors of `main` and `git branch --merged` / `--is-ancestor` both answer "no" on work that
shipped. Only the file contents carry across a squash.

**How to report it:** say the fix is live and name the roll-up that carried it. Never present it as a
merge he still owes, and never open a fresh PR for it — that PR would be an empty squash paying a full
`main` run. Related: [[a-reused-branch-name-finds-the-old-merged-pr]].
