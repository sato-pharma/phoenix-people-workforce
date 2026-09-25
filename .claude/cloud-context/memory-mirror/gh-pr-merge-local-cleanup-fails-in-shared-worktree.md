---
name: gh-pr-merge-local-cleanup-fails-in-shared-worktree
description: "gh pr merge from a worktree can report a git error and non-zero exit even though the merge itself succeeded on GitHub"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 0ae8a0b0-d0e1-43b4-9ba8-570fdca85c41
  modified: 2026-08-13T03:43:21.636Z
---

Running `gh pr merge` from a sibling worktree (e.g. `_wt-<task>`, sharing `.git` with the primary
checkout at `F:/Phoenix Workforce/phoenix-workforce`) can fail with:

```
failed to run git: fatal: 'main' is already used by worktree at 'F:/Phoenix Workforce/phoenix-workforce'
```

**This is `gh`'s post-merge LOCAL cleanup step failing, not the merge itself.** `gh pr merge` calls
the GitHub API to merge first, then tries to locally checkout `main` and delete the head branch —
that second part can't checkout `main` because another worktree already has it checked out. The API
merge already went through by the time this error fires.

**How to apply:** never read this error as "the merge failed." Immediately verify with
`gh pr view <n> --json state,mergedAt,mergeCommit` — if `state` is `MERGED`, it merged; move on to
verifying the production deploy. Do not retry `gh pr merge` (it will just no-op or error on an
already-merged PR) and do not manually intervene in worktree state to "fix" this — the remote branch
still gets deleted by the repo's `delete_branch_on_merge` setting regardless of whether the local
cleanup step succeeded.
