---
name: bash-cwd-drift-after-background-notification
description: "After EnterWorktree, ambient Bash/Glob/Grep cwd can silently revert to the primary repo mid-session — observed right after background Agent-task-failure notifications arrived, with no EnterWorktree/ExitWorktree call in between"
metadata:
  node_type: memory
  type: feedback
  originSessionId: dsm-weekly-monthly-plans-worktree-session
---

Distinct from [[enterworktree-absolute-path-gotcha]] (which is about reusing a
stale absolute path from before `EnterWorktree`): this is ambient cwd — Bash
calls with no explicit `cd`, and Glob/Grep calls with no explicit `path` —
silently reverting to the PRIMARY repo root partway through a session, with no
`ExitWorktree` ever called.

**Observed sequence:** `EnterWorktree` succeeded; the very next `Bash` call
(git status/branch/log, no explicit cd) correctly showed the worktree's
branch. Ran `pnpm run worktree:sync-env` successfully (also worktree-scoped).
Then two background `Agent` (Explore) calls failed with a session-limit error
and sent task-notifications. The next turn's `Bash pwd` and `git branch
--show-current` showed the PRIMARY repo path and its original branch
(`codex/ceo-sidebar-probation`, with that session's pre-existing uncommitted
changes) — never touched deliberately. A `Glob`/`Grep` in that same turn also
silently walked the primary repo's nested `.claude/worktrees/*` subfolders
(other live sessions' worktrees), producing confusing duplicate/conflicting
matches across unrelated branches — exactly the cross-worktree-pollution
failure mode a background agent had independently flagged moments earlier.

**Why:** unconfirmed root cause. Correlates with the background-notification
delivery, not with any explicit directory-changing action — plausibly the
harness's cwd-restoration for a new turn defaults to the session's original
launch directory unless something re-asserts the worktree. Not reproduced
in isolation; treat as "can happen," not "always happens."

**How to apply:**
1. After any batch of background `Agent`/`Bash` work completes and control
   returns to you inside a worktree session, do NOT trust ambient cwd. Re-run
   `EnterWorktree` with `path: <the worktree's absolute path>` (safe/idempotent
   per its own docs: "re-issue EnterWorktree with path to return to one") and
   verify with `pwd && git branch --show-current` before any further Glob,
   Grep, or Bash call.
2. For the remainder of the task, prefer explicit `cd "<absolute worktree
   path>" &&` inside every Bash command, and pass `path:` explicitly to every
   Grep/Glob call — do not rely on default cwd resolution even after a
   successful verification, since it can drift again later in the same
   session.
3. If a Glob/Grep from a worktree-adjacent path returns matches under
   `.claude/worktrees/<other-name>/...` or a sibling `_wt-*` folder, that is
   the tell — you are not actually scoped to your own worktree.
4. This cost real turns (repeated a Grep/Read pass and a `pnpm exec next
   dev`-in-background restart) but caused no damage this time, because the
   only actions taken against the wrong directory were read-only (Bash
   `git status`, Glob, Grep). Had an Edit/Write landed there instead, it would
   have silently modified another live session's checkout — see
   [[parallel-session-swarm-hazard]].
