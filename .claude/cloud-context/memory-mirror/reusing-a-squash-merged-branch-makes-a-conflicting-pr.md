---
name: reusing-a-squash-merged-branch-makes-a-conflicting-pr
description: "Pushing a new commit to a branch whose PR was already squash-merged produces a PR that re-proposes every file and conflicts — cherry-pick onto a fresh branch instead of rebasing."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-16T00:49:17.727Z
---

**Never push follow-up work to a branch whose PR has already been squash-merged.** Cut a new branch
off current `origin/main` and cherry-pick.

PRs here merge by **squash**, so the branch's own commits never become ancestors of `main` — `main`
carries one new commit with the same *content* but a different identity. Push one more commit to that
branch and open a PR and GitHub compares the whole branch against `main`, so it re-proposes **every
file the branch ever touched**, and any movement on `main` since turns that into a conflict.

Seen 2026-08-16: `codex/recruitment-simplify` was merged as #2162. One further 2-file commit
(`21357d23`) was pushed to it; PR #2169 came back `CONFLICTING` / `DIRTY` listing **80 files**.
Nothing was actually wrong with the commit.

**Do NOT rebase or `gh pr update-branch` out of this** — that means hand-resolving conflicts between
the new work and the already-shipped copy of the same work, with a real chance of reverting live
behaviour. The recovery is cheap:

```
git checkout -b <new-branch> origin/main
git cherry-pick <sha>
```

It applied cleanly and reproduced the diff exactly (2 files, 111 insertions), shipped as #2170. Then
close the stale PR with the reason on it.

**Diagnose it by file count, not by the word "conflict".** A PR listing far more files than the
commit touched is this, every time. Confirm with `gh pr view <n> --json files` and prove the old
work is already on `main` (`git cat-file -e origin/main:<a-file-that-PR-added>`) before deciding.

Related: [[merge-blocked-says-checks-but-means-behind]] ·
[[two-sessions-fixed-one-bug-main-was-never-ci-validated]]
