---
name: git-worktree-remove-can-timeout-and-partially-delete
description: "git worktree remove on a large worktree (60k+ files) can run past a 2-minute tool timeout and get killed mid-deletion, leaving real content (including xlsx files) behind in a directory git now calls 'prunable' — always background these with a 5min+ timeout, and always rescue-scan for xlsx/pdf BEFORE attempting removal, not after."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-08-08T20:49:00.492Z
---

**What happened (2026-08-08).** Retiring 3 worktrees with already-merged PRs (#1916, #1915, #1909)
as part of building [[ram-guard-routine-every-30-min]]. The first (`_wt-approval-gate`, 86,953
files) completed fine. The second (`.claude/worktrees/agent-a239a7dcdbe2a2c93`, 60,328 files) was
run in the foreground with the tool's default 2-minute timeout and got killed mid-deletion.

**The result was NOT a clean husk.** `git worktree list` immediately showed it as `prunable`
(git's own term for "the worktree's `.git` link is gone"), which reads like a completed removal.
It was not: `find -type f | wc -l` still reported **3,718 files** — `.git` and `.next` had been
deleted first, but `src/`, `tests/`, `package.json`, and **four `.xlsx` files**
(`Phoenix Pharmacy Database.xlsx`, `phoenix products.xlsx`, `Phoneix system template.xlsx`,
`Source of sales area database.xlsx`) were all still sitting there untouched. `node_modules` was
also still present, mid-deletion.

**Why this is dangerous, not just messy:** AGENTS.md's "never delete an xlsx/pdf" rule has no
exceptions, and `git worktree prune` (the normally-correct next step for a `prunable` entry) only
clears git's own metadata — it does not look at what is still on disk. Running it reflexively here
would have de-registered the worktree while those 4 files were still physically present and about
to become an untracked, unfindable orphan the moment anyone (repo-doctor's own husk sweep included)
next touched that directory.

**How it was actually resolved:** hashed all 4 xlsx files (`sha256sum`) against the primary
checkout's tracked `xlsx/` folder before touching anything else. All 4 were byte-identical —
already-committed data, nothing unique — so it was safe to finish the deletion. Finished it with
native `rmdir /s /q` (per [[worktree-triage]] section 5b: never `Remove-Item -Recurse`, it follows
pnpm's directory symlinks), then `git worktree prune`, then `git branch -D`.

**How to apply, every time from now on:**
1. **Rescue-scan for `*.xlsx`/`*.pdf` BEFORE running `git worktree remove`, not after a timeout
   forces the question.** The worktree-triage skill already says to scan before removal; treat that
   as literal, not a step to do once "if something looks left over."
2. **Never run `git worktree remove` on a worktree with a nontrivial file count (tens of thousands)
   in the foreground with a short timeout.** Background it with 5+ minutes. A 2-minute default is
   not long enough — confirmed live, twice: this one timed out at 60k files, a sibling at 86,953
   files completed within 2 minutes, so file count alone does not predict duration reliably enough
   to skip backgrounding.
3. **A `prunable` worktree is not proof of a clean deletion.** Before running `git worktree prune`
   or treating the directory as a husk, check its actual file count and contents. Only prune/finish
   the deletion after confirming nothing irreplaceable remains.
4. If real, non-identical files are found: copy them to `xlsx/` at the repo root (create it if
   missing) before letting the deletion proceed — this rule has no exceptions.

Related: [[repo-doctor-strip-idle-runs-for-many-minutes]] (large-worktree operations here routinely
exceed a couple of minutes), [[merged-pr-does-not-make-a-worktree-retirable]] (re-verify state
immediately before removing, which this incident did correctly — the failure was in the removal
mechanics, not the pre-check), [[dont-foreground-watch-long-pipelines]].
