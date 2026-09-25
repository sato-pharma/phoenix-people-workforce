---
name: orphaned-worktree-symlink-skeletons
description: "Removed worktrees leave unregistered empty symlink skeletons under .claude/worktrees that git cannot see and that resolve git UP into the primary checkout"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bc3bd8d-69af-4796-a9d6-d8f9a750fcb7
  modified: 2026-08-03T17:48:51.743Z
---

On 2026-08-01, `.claude/worktrees/` held **6 directories that were not registered git worktrees**:
`crm-export-streaming`, `sales-bulk-idle-gate`, `_wt-1400-fix`, `_wt-1517-merge`, `_wt-export-test`,
`_wt-export-test2`. Each contained **0 files** but 1,424–1,603 empty dirs and **3,263–3,567 dangling
pnpm symlinks** — the `node_modules` link farm left behind when a worktree's real files go away.
All 6 were deleted (guard-checked, nothing registered harmed, registered count unchanged).
Three more of the same class — `confident-wu-144d66`, `sad-hopper-5d16b0`,
`vibrant-poincare-ac3e34` (see [[claude-worktree-sad-hopper-5d16b0-is-corrupt]] — that one is not a
one-off, it is this class) — had their **contents** deleted but the **directory stubs could not be
removed**: `rmdir` and `[System.IO.Directory]::Delete` both fail with exit 32 / "being used by
another process" on a directory containing 0 files, 0 symlinks, 0 subdirs.

**That is the answer to the 07-31 "locked, harmless empty dir" mystery.** Windows refuses to delete
a directory that is any live process's **current working directory**. These are Claude sessions
(or their ~58 child cmd/powershell/bash shells) still sitting in worktrees whose contents were
wiped underneath them. Nothing is corrupt and no handle needs breaking — the stub simply becomes
deletable once the holding session exits. Do not kill processes to force it.

**Why it matters:** these are invisible to `git worktree list` AND to `git worktree prune`, so the
`/worktree-triage` ritual never surfaces them. Worse, each lacks a `.git` file, so
`git rev-parse --show-toplevel` from inside walks **up into the primary production checkout**. A
session that starts in one and runs `git status`/`commit`/`reset` operates on the main checkout
while believing it is isolated. They cost ~no disk (0 bytes of file data), so the reason to remove
them is safety, not space.

**Full 2026-08-01 tally — 13 orphan directories found, in two places:** 9 under
`.claude/worktrees/` and 4 at the repo root (`_wt-*`). 10 were fully deleted; 3 (`confident-wu-144d66`,
`sad-hopper-5d16b0`, `vibrant-poincare-ac3e34`) were emptied but their stubs stay pinned as a live
session's CWD. One root orphan, `_wt-vacation-hr-single-approver`, was NOT an empty skeleton — it
held **2,095 real files (46.6 MB)**, a partial 07-04 snapshot with no `app/` dir, still carrying
`sentry.*.config.ts` and `vercel.json`. Verified safe to delete by hashing every file with
`git hash-object` and checking each blob against the object DB: **1,911 of 1,913 already in git**;
the 2 outliers were superseded pre-Sentry-retirement versions (orphan had `console.error`/`fullName`,
primary has `logError`/`displayName`/`rpcAll`, last committed 07-28 vs the orphan's 07-04).
`.codex-worktrees/` was deliberately left alone — it is Codex's, not Claude's.

**How to apply:**
- To prove an orphan holds nothing unique, hash its whole tree and test the blobs against git:
  `find <dir> -type f -not -path '*/node_modules/*' | git hash-object --stdin-paths |
  git cat-file --batch-check` then count `missing`. Beware: filter on the **status field**, not the
  whole line — `grep 'missing'` also matches filenames like `missing-punch-verification.tsx` and
  wildly overstates the result. Also normalize CRLF before concluding two files differ.
- Detect with `git rev-parse --show-toplevel` per directory: healthy worktree resolves to *itself*;
  an orphan resolves to `F:/Phoenix Workforce/phoenix-workforce`. Cross-check membership against
  `git worktree list --porcelain` — absence there plus resolves-up is the signature.
- **Do not trust `Get-ChildItem` or robocopy to size these.** `Get-ChildItem -Recurse` counted 4,686
  "entries" but 0 files (it counts symlinks as entries and silently swallows MAX_PATH errors);
  robocopy reported 0 bytes but flagged 3,263 dirs `FAILED` because it choked on dead links, so its
  zero was not trustworthy either. Only `find <dir> -type f` through Git Bash gave a consistent
  answer. When two tools disagree about emptiness, add a third with a different filesystem API.
- Delete with `cmd /c rmdir /s /q` — it removes reparse points without traversing them. Plain
  `Remove-Item -Recurse` can follow links. No long-path fallback was needed in practice.
- Always run the AGENTS.md xlsx/pdf rescue scan first anyway (all 9 here held zero documents, but
  the registered worktrees each hold 8–9 real xlsx files, so the habit matters).
- Worktrees are being created faster than triage removes them: the registered count went 17 → 16 →
  **20** within one session. See [[parallel-work-model-2026-07]].

**2026-08-03 update — dirty-file sweep across all worktrees.** Re-ran the detection method (rev-parse
--show-toplevel per path, cross-checked against `git worktree list --porcelain`) covering every
`_wt-*` sibling, every `.claude/worktrees/*`, and — new this pass — `.codex-worktrees/*`. Orphan
count is back up to **10**: 8 under `.claude/worktrees/` (`competent-tu-118c82`, `confident-wu-144d66`,
`crm-latent-hardening`, `distracted-fermi-14fc56`, `interesting-engelbart-c1b50b`,
`pensive-varahamihira-f25af0`, `sad-hopper-5d16b0`, `vibrant-poincare-ac3e34`) plus **2 new ones**
under `.codex-worktrees/` (`migration-reconciliation-audit`, `mm-account-hard-rebuild`). All 10
resolve up to the primary checkout and have no `.git` entry at all (confirmed by direct `ls`, not
just the git resolution). AGENTS.md §5 says to leave `.codex-worktrees/` alone as "Codex's, not
Claude's" — true for a live Codex worktree, but these two are not that: each holds only dead build
leftovers (`supabase/` and `.next/` respectively, zero source files, zero `.git`), i.e. the same
orphan-skeleton class as the Claude-side ones, not active Codex sessions. Safe cleanup candidates
next triage, pending the same guard-check + approval this file already describes. None were deleted
this pass — this was a read-only dirty-file audit, not a triage.

At the same time, of the 39 **registered** non-primary worktrees, only 4 actually carried
uncommitted changes: `_wt-aif-ue-split`, `_wt-analytics-scope`, `_wt-vercel-rescue`, and
`.claude/worktrees/sad-ardinghelli-5efcd9`. The other 35 were clean, including 3 sitting in detached
HEAD (`elastic-burnell-410265`, `hungry-haslett-d7ab1e`, `laughing-pike-b346b5`) — clean but worth a
second look since detached HEAD is an unusual resting state for a task worktree.

Related: [[worktree-corruption-parallel-session-2026-07-05]], [[laptop-thrashing-pagefile-feedback-loop]]
