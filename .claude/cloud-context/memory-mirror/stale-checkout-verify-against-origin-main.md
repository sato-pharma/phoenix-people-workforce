---
name: stale-checkout-verify-against-origin-main
description: "My own Grep/Bash/Read tool calls default to the primary checkout's currently-checked-out branch, which can be stale vs. origin/main — verify with git show/git grep origin/main, not just the working tree"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

When checking "does X exist in the codebase right now" for something that may have shipped recently, my own Grep/Read/Bash tool calls operate against whatever the primary checkout (`F:\Phoenix Workforce\phoenix-workforce`) currently has checked out — which is frequently a long-lived feature branch (e.g. `codex/agents-policy-v2`) sitting behind `origin/main`, not `origin/main` itself.

**Why:** During the [[crm-integrity-module]] work, I searched `supabase/migrations/` for a table's migration file, found nothing, and told the user it was a real gap needing a fix — then a Plan subagent (which happened to check `origin/main` via `git show`) reported it DID exist. Re-verifying with `git ls-tree origin/main` / `git show origin/main:<path>` confirmed the subagent was right and I was wrong: my own `Grep`/`Bash` call had silently read the stale primary checkout's working tree, not `origin/main`. This is the same class of failure already documented for Explore subagents in [[compaction-replay-mistaken-for-live-state]] and the visits-report re-audit lesson, except this time I fell into it myself, directly, not a subagent.

**How to apply:** Before asserting "X doesn't exist / isn't merged yet" based on a Grep/Read/Bash result, check whether the claim is about *current main* specifically. If so, either verify with `git show origin/main:<path>` / `git grep <pattern> origin/main --` (bypassing the working tree entirely), or explicitly note the claim is scoped to "the currently checked-out branch," not main. This matters most right after merges land (my own or others') and when working from a worktree/branch that hasn't rebased recently — which, in this repo, given the number of parallel `codex/*` branches and worktrees active at any time, is close to always.
