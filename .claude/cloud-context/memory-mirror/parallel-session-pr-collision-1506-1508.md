---
name: parallel-session-pr-collision-1506-1508
description: "Two sessions fixed the same P0 permissions/CLAUDE.md on 2026-07-31 — how the collision surfaced and the merge (not rebase) resolution"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-07-31T19:35:13.652Z
---

On 2026-07-31 two parallel sessions independently fixed the same audit P0s. A cloud session shipped **PR #1508** (`claude/gracious-fermat-035527`, MERGED) touching `.claude/settings.json` + `CLAUDE.md`; this local session had **PR #1506** open touching the same two files plus AGENTS.md/.mcp.json/hooks. #1506 went `CONFLICTING/DIRTY` with no warning until I checked `gh pr view --json mergeable`.

**Why:** the tier-routing model (cloud sessions for independent tasks) has no de-duplication — nothing stops two sessions from being handed the same finding. The memory index was the only signal, and it was updated *after* both were already in flight.

**How to apply:**
1. Before starting work that touches shared config (`.claude/**`, `CLAUDE.md`, `AGENTS.md`), run `gh pr list --state open --json number,title,files` and grep for the files you're about to edit. Also re-read `MEMORY.md` — a parallel session may have claimed the task minutes ago.
2. When a collision has already happened, **merge, don't rebase**: `git merge origin/main` on the feature branch, resolve, plain `git push`. A rebase+force-push on a pushed branch needs owner approval per AGENTS.md and rewrites review history; a merge commit needs neither.
3. Resolve by **union, not preference** — the other session's `permissions.ask` list was strictly better (22 entries incl. staging `execute_sql`, `supabase db push`, github write tools) while mine had unique `deny` entries (`vercel deploy`, `Read(./.env*)`, UUID-connector wildcards). Final = both. Don't overwrite another session's work just because your branch is the one you're holding.
4. **`node_modules` follows the branch, not the checkout.** After switching between branches whose `package.json` differs (here: Sentry removed on one), the pre-push typecheck gate fails with a phantom "Cannot find module" until you re-run `pnpm install`. Not a code error — reinstall and re-push.

Related: [[parallel-work-model-2026-07]] · [[claude-config-audit-2026-07-31]] · [[feedback-parallel-session-pr-collision]]
