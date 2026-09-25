---
name: git-branch-d-is-not-a-safety-gate-after-a-squash-merge
description: "`git branch -d` on a squash-merged branch reports it merged to its own STALE remote-tracking ref, not to main, and deletes it — so the safe flag would pass identically on unmerged work. Gate a branch deletion on the merged PR, and archive the tip to refs/backups/* before deleting."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2e35f5a5-8c27-47f4-b35a-fc5d863e5462
  modified: 2026-09-16T13:20:53.062Z
---

**`git branch -d` is not a merged-into-`main` check here.** Measured 2026-09-12 deleting
`codex/recruitment-folder-filer-names` (tip `fdb1c4406`) after PR #3727 squash-merged as
`fa63ce5b1`:

```
warning: deleting branch 'codex/recruitment-folder-filer-names' that has been merged to
         'refs/remotes/origin/codex/recruitment-folder-filer-names', but not yet merged to HEAD
Deleted branch codex/recruitment-folder-filer-names (was fdb1c4406).
```

Read what it actually compared: the branch against **its own remote-tracking copy**. `delete_branch_on_merge`
had already removed the branch on GitHub, but **`git fetch` never prunes**, so the stale
`refs/remotes/origin/<branch>` was still sitting locally — and a branch always equals its own copy.
The same warning and the same deletion would therefore appear for **work that was merely pushed once
and never merged at all**. `-d` reads as the careful flag and gates nothing.

This is the `git log <branch> --not --remotes=origin` trap in `AGENTS.md` §2.1 wearing a different
command — same root cause (`fetch` never prunes, so the check compares the branch against itself),
but a session reaching for `-d` instead of that command gets no warning that it is unprotected.

**The gate is the merged PR, squash-aware, never reachability:**

```
gh pr list --head <branch> --state merged --json number,state,mergeCommit
```

**Archive before deleting, because a squash merge leaves the branch's own commits on no origin ref.**
`fa63ce5b1` carries the *content*; `fdb1c4406` and its parents existed nowhere else. House convention
is `refs/backups/<name>` and **origin holds ~690 of them** — pushing there is the practice, and the
only copy that survives losing the laptop:

```
git update-ref refs/backups/<name> <tip-sha>
git push origin refs/backups/<name>:refs/backups/<name>
```

**A branch that had a PR is already off-laptop, though.** Measured 2026-09-16 on #3884: after GitHub
deleted `codex/kpis-coverage-header-fit` on merge, `git ls-remote origin refs/pull/3884/head` still
returned its tip `c07aa6d77`. So when a push has not been approved, confirm that ref, take a LOCAL
`git update-ref refs/backups/<name> <tip> ""` (the empty old value refuses to overwrite), and
delete — nothing is lost.

Recover with `git branch rescue/<name> refs/backups/<name>`. Pushing to `refs/backups/*` triggers no
CI (`ci.yml` fires on `pull_request` and pushes to `main`) and creates no PR, so it is not the
"never push a merged branch to rescue it" mistake — that one is about `refs/heads/*`.

After the delete, `-d` leaves the stale `refs/remotes/origin/<branch>` behind. Clear that one ref with
`git update-ref -d refs/remotes/origin/<branch>` rather than `git remote prune origin` — remote-tracking
refs live in the shared primary `.git` and ~30 worktrees plus other live sessions read them.

Related: [[main-is-not-the-primary-checkout]] ·
[[gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded]]
