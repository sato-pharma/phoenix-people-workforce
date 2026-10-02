---
name: orphan-module-memory-notes-mean-your-branch-is-behind-the-fold
description: "`build.mjs --check` reporting ORPHAN notes you never wrote means your branch predates a fold that filed them — merge origin/main, do not file them yourself. Two sessions hit it inside an hour on 2026-10-02."
metadata:
  node_type: memory
  type: project
  originSessionId: 08f11fd9-5353-4d59-9fba-bc86e4eec1c4
  modified: 2026-10-02T21:26:56.555Z
---

Measured 2026-10-02, ~23:30 Cairo.

A branch created by `node scripts/new-session.mjs` an hour earlier failed the required `validate`
job's module-memory check with three orphans:

```
module memory: 3 problem(s)
- ORPHAN: memory note a-merge-approval-naming-only-a-number-reaches-every-session is filed under no module
- ORPHAN: memory note choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones
- ORPHAN: memory note remote-check-background-exit-code-is-not-the-check-verdict
```

**None of them was mine, and the fix was not to file them.** The worktree branched from `origin/main`
*before* `f0ef27605 fix(memory): file the three orphan notes — main went red on my own merge (#5186)`
landed, so the branch carried the three mirror files with none of the `assignments.json` entries that
main had already added. `git merge origin/main` turned the check from `3 problem(s)` to `healthy`
with nothing else changed.

**The tell that it is not yours:** the orphan names describe work you did not do. Check before
touching `assignments.json` —

```bash
git fetch origin && git rev-list --count HEAD..origin/main
git log --oneline HEAD..origin/main | grep -i memory
```

Filing them by hand instead would have produced a conflicting second set of assignments against the
ones already on main, i.e. a merge conflict in a generated-adjacent file for no reason.

**Why it recurs:** a session writes notes to laptop memory continuously, `sync-cloud-context.mjs`
mirrors them into the repo, and the fold that files them is a separate PR. Any branch cut in the
window between the mirror and the fold is red through nobody's fault. The other session's commit
title — "main went red on my own merge" — is the same trap from the other side.

Related: the Git cluster's "a merge to `main` mid-session silently orphans your next push", and
[[a-merge-mid-session-orphans-your-next-push-silently]].
