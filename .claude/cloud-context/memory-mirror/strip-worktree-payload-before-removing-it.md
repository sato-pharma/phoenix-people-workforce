---
name: strip-worktree-payload-before-removing-it
description: "Run repo-doctor --strip-idle BEFORE `git worktree remove`, or the removal strands ~60k files per tree as NEEDS-REVIEW residue that --fix can never clear."
metadata: 
  node_type: memory
  type: project
  originSessionId: 716ff586-e100-4cd1-bc1e-2e4e8fcfae38
  modified: 2026-08-19T20:15:56.788Z
---

`git worktree remove` deletes tracked files and the registry entry but leaves gitignored
directories behind. The ORDER you do this in decides whether the leftover is reclaimable:

- **Strip first, then remove** → git deletes the whole directory. `Test-Path` returns False.
  **No husk at all.** Verified 2026-08-06 on `_wt-counters`, `_wt-expense-ticket`,
  `_wt-normalizer-guard` (PRs #1855, #1856, #1851) — all three vanished cleanly.
- **Remove first** → `node_modules`/`.next` stay behind holding ~60,000 real files. That is
  not a husk (husk = ZERO files), so `--fix` refuses it by design and it is reported
  NEEDS REVIEW forever. Three worktrees done in that order would strand ~224,000 path entries.

**Why:** `scripts/repo-doctor.mjs` only iterates REGISTERED worktrees in its `--strip-idle`
loop. The moment you unregister one, its payload is unreachable by every automated path.

**When `--strip-idle` is blocked, strip by hand — the property is the ORDER, not the tool.**
`--strip-idle` refuses to run while other Claude sessions are open
([[repo-doctor-strip-idle-cannot-run-with-sessions-open]]), which on a busy night is always. Plain
`rm -rf "<wt>/node_modules" "<wt>/.next"` is an exact substitute: both are gitignored, so removing
them leaves `git status --porcelain` **empty** and the tree still qualifies as clean for
`git worktree remove`. Verified 2026-08-19 on `_wt-resend-nudge` (PR #2228): 61,022 files → 4,790,
then `git worktree remove` exited **0** and the directory was completely gone — no `Permission
denied`, no husk, in contrast to the two unstripped removals earlier the same evening which both
left undeletable empty husks ([[worktree-remove-permission-denied-still-deregisters]]).

**How to apply:** `node scripts/repo-doctor.mjs --strip-idle --force`, wait for the process to
actually exit (see [[repo-doctor-strip-idle-runs-for-many-minutes]]), then `git worktree remove`,
then `--fix --force` for any older husks. Re-check `git rev-parse --abbrev-ref HEAD` at removal
time — see [[merged-pr-does-not-make-a-worktree-retirable]].
