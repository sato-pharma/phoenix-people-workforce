---
name: worktree-corruption-parallel-session-2026-07-05
description: "A committed-and-pushed worktree (_wt-ceo-nsm-parity) lost its .git pointer file mid-session while another Claude Code session was active in the primary folder — no work lost, but the worktree became unusable."
metadata: 
  node_type: memory
  type: project
  originSessionId: b0dc33c3-69c2-4340-82b1-c72ba656a84b
---

While doing follow-up work (Phase 3 speed pass) on `_wt-ceo-nsm-parity` (branch `codex/ceo-nsm-parity`,
already had a clean commit pushed to origin), a later `git` command in that same worktree failed with
`fatal: not a git repository` even though `pwd` confirmed the correct directory. `git worktree list` from
the primary tree still showed the entry (correct branch, correct latest commit hash) but flagged **`prunable`**,
and the worktree's `.git` file (the text pointer to `<primary>/.git/worktrees/<name>`) was gone.

This happened while a SessionStart hook was flagging another active Claude Code session in the primary
folder (`F:/Phoenix Workforce/phoenix-workforce`) — consistent with the parallel-session hazard class
already documented in [[parallel-session-swarm-hazard]] and [[ai-tool-damage-prevention]], just a new
variant (git-pointer-file deletion instead of checkout/branch-delete/staged-file-drop).

**Why this matters:** Also discovered mid-session that the PR from that same branch (#857) had ALREADY
been merged (squash) into `main` — by the account owner or another authorized session — while this session
was still working Phase 3 on the old branch. `git merge-base --is-ancestor <old-commit> origin/main` failed
(expected for a squash-merge) confirming main had moved on.

**How to apply:**
- If a git command in a worktree fails with "not a git repository" despite `pwd` being correct, don't assume
  data loss — check `git worktree list` from the primary tree first; if the commit hash is still listed
  correctly, your work is intact in the worktree's ODB even if the checkout itself is unusable, and if you
  already pushed, the commit is safe on the remote regardless.
- Recovery path that requires NO destructive action: cut a brand-new worktree off `origin/main`
  (`git worktree add <new-path> -b <new-branch> origin/main`), `git cherry-pick <sha>` the commit from the
  remote-tracking ref of the broken branch, validate, push, open a fresh PR. Never try to `git worktree remove`
  or repair the broken one without explicit owner approval — per [[ai-tool-damage-prevention]] destructive
  git ops always need a separate ask.
- Before starting ANY new phase of work on an existing branch, re-check whether its PR already merged
  (`gh pr view <n> --json state,mergedAt`) — a squash-merged PR means the branch is now stale relative to
  `main` even though its own history looks unchanged; new commits belong on a fresh branch, not stacked on
  the stale one.

Related: [[parallel-session-swarm-hazard]], [[ai-tool-damage-prevention]], [[ceo-field-sales-parity]]
