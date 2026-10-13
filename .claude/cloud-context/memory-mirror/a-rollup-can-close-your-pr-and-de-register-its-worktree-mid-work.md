---
name: a-rollup-can-close-your-pr-and-de-register-its-worktree-mid-work
description: "a peer session's roll-up closed the PR this session was still working in and de-registered its worktree; the branch on origin is what survives, and the recovery is a new worktree --from origin/<branch> plus a merge whose conflicts are proven with git ls-tree"
metadata:
  node_type: memory
  type: project
  originSessionId: e92e7929-b494-4f05-a30f-3ad6d87b11ca
  modified: 2026-10-13T02:50:08.604Z
---

A roll-up merged by another session **closes your PR as superseded and can retire its worktree while
you are still working in it.** On 13 October 2026 PR #5830's content went to `main` inside roll-up
#5840 (05:32 Cairo); #5830 was closed, and `_wt-hr-talent-acquisition-overview` was removed from
`git worktree list` — its `.git` file deleted too, so every `git` and `gh` call inside the folder
answered `fatal: not a git repository`, which reads as a broken shell rather than as what it was.

**Why:** the roll-up is correct — the content it carried really was on `main`. What it cannot know is
that the session is still ADDING to that branch. A push that lands after the PR closes triggers no
checks at all (no open PR), so the work looks shipped and is actually invisible.

**How to apply:**
- **The pushed branch is what survives.** `git ls-remote origin refs/heads/<branch>` from the primary
  proves the commit is safe; the folder losing `.git` loses nothing.
- Recover with `node scripts/new-session.mjs <new-slug> --from origin/<the-branch>` — a fresh
  worktree on a NEW branch at your own commit. `git worktree repair` cannot help: the admin
  directory is gone.
- Then `git merge origin/main` **will conflict on every file the roll-up squashed**, because both
  sides changed the same lines. Before resolving, prove it: `git ls-tree origin/main <file>` against
  `git ls-tree <your-pre-work-commit> <file>`. Equal blobs mean `main` holds exactly your earlier
  state and nobody else touched the file, so `--ours` is safe; a different blob is somebody else's
  work and must be merged by hand. Never take `--ours` on the diff's say-so.
- The net size of the rescue is only readable AFTER the merge — see
  [[a-rescue-branchs-real-size-is-measured-after-merging-main-in]].
- The emptied folder is a plain directory, not a husk git can see, so `pnpm run repo:doctor --fix`
  will not clear it and it may still be the folder his `phx-live` sync points at
  ([[a-worktree-can-be-held-by-his-phx-live-sync]]). Leave it and say so.
