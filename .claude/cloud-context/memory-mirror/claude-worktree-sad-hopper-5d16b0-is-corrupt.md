---
name: claude-worktree-sad-hopper-5d16b0-is-corrupt
description: "Worktree .claude/worktrees/sad-hopper-5d16b0 has no source files and no .git pointer — git commands run from it silently resolve UP into the primary checkout (another session's dirty branch). Verify before editing."
metadata: 
  node_type: memory
  type: project
  originSessionId: f09c1e06-e648-4e1e-bdec-d7aa871f0d10
  modified: 2026-07-31T18:24:33.668Z
---

Found 2026-07-31. The Claude Code worktree `F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\sad-hopper-5d16b0` is **broken**: its directory contains only `.claude` and `node_modules` (no `app/`, no `src/`, no `package.json`), and it is **absent from `git worktree list`**.

**Why: it is dangerous.** Because the folder sits *inside* the primary repo and has lost its `.git` pointer file, git walks UP the directory tree and resolves to `F:/Phoenix Workforce/phoenix-workforce/.git`. So from inside that worktree:
- `git rev-parse --show-toplevel` → the PRIMARY checkout, not the worktree
- `git branch --show-current` → `codex/retire-sentry` (another live session's branch, at 020600c5, with ~30 uncommitted files)

Any `git add`/`commit` run there would stage **another session's in-progress work**, and any file edit would land in their checkout. The session-start snapshot claimed branch `claude/sweet-mestorf-cfa28d`, clean — that was already stale/wrong, so do not trust it.

**How to apply:** before editing or committing in any `.claude/worktrees/*` session, run `git rev-parse --show-toplevel` and confirm it equals the worktree path, and that the path appears in `git worktree list`. If it resolves to the primary repo, STOP — do not edit, do not commit. Do the work in a fresh sibling worktree (`git worktree add ../_wt-<task>`) instead.

Also relevant: the repo currently has **15 registered worktrees**, far above the owner's stated ceiling of 2-3 local worktrees ([[parallel-work-model-2026-07]]) — prefer cloud sessions over adding more.

Related: [[worktree-corruption-parallel-session-2026-07-05]], [[parallel-session-swarm-hazard]], [[stale-checkout-verify-against-origin-main]].
