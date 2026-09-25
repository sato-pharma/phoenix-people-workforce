---
name: worktree-session-can-silently-write-to-primary-checkout
description: "A worktree-assigned session can accidentally Read/Grep/Write/Edit using the PRIMARY checkout's path instead of its own worktree path — every tool call succeeds with no error, so the mistake is invisible until a git-status check catches it."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b58e2e36-31da-41a3-86ff-1ec0c7d97448
  modified: 2026-08-09T22:24:29.751Z
---

Every file tool (Read, Grep, Write, Edit) accepts an absolute path and will happily operate on
`F:\Phoenix Workforce\phoenix-workforce\...` (the primary checkout) even when the session's actual
assigned working directory is a worktree at
`F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\<name>\...`. Typing the short/primary
path instead of the full worktree path is an easy, silent slip — there is no error, no warning, the
Write tool reports "File created successfully," and Read returns real content, because the primary
checkout is a real, valid repo. The mistake only surfaces later, e.g. when a Bash command whose cwd
is genuinely the worktree can't find the file the Write tool just claimed to create.

**Why: caught live 2026-08-10.** A full investigation (reads across `src/lib/sales`, `supabase/migrations`)
plus a new migration file, a new test file, and a two-line edit to the shared `tests/run-tests.ts`
all landed in the PRIMARY checkout instead of the assigned worktree
`.claude/worktrees/clever-greider-1cb07e`. The primary checkout turned out to be sitting on a
**different, stale, already-merged branch** (`codex/territory-alias-repoint`, the source of an
already-landed PR) with its own pre-existing uncommitted work from a prior/other session (a modified
`package.json` and an untracked script). The shared file `tests/run-tests.ts` got contaminated:
git showed `modified: tests/run-tests.ts` mixing nothing-of-theirs (confirmed by diff — their whole
diff was in `package.json` and an untracked file only) with two new lines that were entirely mine.
Caught by: `git -C <path> status` run explicitly on BOTH the primary checkout and the worktree,
after a Bash `ls` from the true worktree cwd failed to find a file Write had just "successfully"
created — the mismatch between Write's silent success and Bash's real cwd is the tell.

**How to apply:**
- The instant a worktree is in play (check the system prompt's "Worktree path" line), treat the
  short/primary repo path as **off-limits for writes** for the rest of the session — always type
  the full `...\.claude\worktrees\<name>\...` prefix, every single time, no shortcuts.
- Before the FIRST write of a session that has a worktree, sanity-check with a Bash `pwd` (or
  `ls <relative-path>` from Bash, whose cwd is reliably the real worktree) against what a Read/Write
  call just did at an absolute path — if they disagree, stop and audit every prior tool call's path.
- If contamination is found: diff the primary checkout's affected file against its committed state
  first. If the WHOLE diff is traceable to you (as it was here), it's safe to surgically remove
  exactly your inserted lines (or the file, if untracked and newly created by you) — never a bulk
  `git checkout`/`reset` on a file that might also carry another session's real, undiff-isolated work.
  Relocate the content (Write, using the correct worktree path) before removing the primary-checkout
  copy, so nothing is lost mid-fix.
- Two trees on the same physical branch name can also have **diverged content** even when a file
  quick-diffs identical today — after relocating, re-verify anchor points (line numbers, surrounding
  text) fresh in the worktree's own copy rather than assuming offsets carry over; they did not in
  this incident (`tests/run-tests.ts` had different content at the same line range between the two
  branches).

See also [[nested-worktree-without-git-impersonates-parent]] and
[[primary-checkout-branch-can-change-mid-merge-use-worktree-and-rerere]] for related worktree/primary
cross-contamination hazards.
