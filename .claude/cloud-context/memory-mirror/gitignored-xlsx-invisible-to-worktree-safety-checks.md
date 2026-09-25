---
name: gitignored-xlsx-invisible-to-worktree-safety-checks
description: "*.xlsx is gitignored repo-wide (named exceptions only), so generated analysis workbooks in a worktree are invisible to git status AND to the repo's own automated backup/wip-* branches — a blind git worktree remove silently destroys them"
metadata: 
  node_type: memory
  type: project
  originSessionId: 06437bb7-6857-4d58-82d6-1cc08a88f2cc
  modified: 2026-08-09T15:39:25.132Z
---

`.gitignore` line 31 is a blanket `*.xlsx`, with line 33+ `!<name>.xlsx` exceptions only for the
few standard reference files (Phoenix Pharmacy Database.xlsx, phoenix products.xlsx, Phoneix system
template.xlsx, Source of sales area database.xlsx). Any OTHER `.xlsx` a session generates — audit
output, verification workbooks — is gitignored the moment it's created.

**Why this matters for worktree cleanup:** `git status` (even `-uall`) never shows a gitignored
file, so the standard "is this worktree clean?" check reports clean even when real generated
workbooks sit on disk. Found live 2026-08-09: `_wt-allmonths-audit/_audit_out/` held 21 xlsx
workbooks and `_wt-v1853-rowlevel/xlsx/` held 3 (`ai-2026-07.xlsx`, `cns-2026-05.xlsx`,
`pedia-2026-07.xlsx`) — `git status` showed only their `.json` siblings as untracked, zero mention
of the xlsx.

**The repo's own automated safety net misses them too.** This repo runs an automated mechanism that
pushes `origin/backup/wip-_wt-<name>` branches for dirty worktrees (commit message
`wip-backup(_wt-<name>): uncommitted working-tree snapshot, N dirty path(s)`) — but it enumerates
dirty paths via a git-based method, so it inherits the same gitignore blindness. Verified by reading
the backup branch's tree directly: it contained the `.ts` scripts and `.json` siblings but NOT one
of the 24 `.xlsx` files. So "there's already a backup branch for this worktree" is NOT sufficient
proof the worktree is safe to force-remove — the backup can be incomplete in exactly the place a
naive check would trust it.

**How to apply:** before any worktree removal, run an independent filesystem scan —
`find <worktree> -iname "*.xlsx" -o -iname "*.pdf"` — never rely on `git status` or an existing
backup branch alone to enumerate what's at risk. Cross-check every hit's git-tracked status
(`git ls-files`) and gitignore status (`git check-ignore -v`) individually; a hit that's gitignored
and not on any backup branch's tree must be copied out (this session used
`xlsx/rescued-from-worktrees/<worktree-name>/`, untracked, at the main checkout's repo root — the
same location AGENTS.md's older "rescue stray xlsx into xlsx/ at repo root" rule already points to)
before `git worktree remove --force` runs. See [[strip-worktree-payload-before-removing-it]] for the
separate node_modules/.next payload-stripping step this doesn't replace.
