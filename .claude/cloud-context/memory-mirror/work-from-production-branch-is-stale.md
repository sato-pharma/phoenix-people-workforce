---
name: work-from-production-branch-is-stale
description: "GOTCHA — codex/work-from-production is stale (64 commits behind main) with a parallel session active; ship production work from a FRESH branch off origin/main, never by merging codex/work-from-production."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0e7129f4-58e9-4091-946a-78589f0bcf7b
---

As of 2026-06-21, `codex/work-from-production` was **64 commits BEHIND `origin/main`** and only ~5 ahead — it is stale, and a **parallel session was actively editing it** (uncommitted sales-marketing-intelligence / sales access-scope changes + untracked migrations appeared mid-session in the primary tree). CLAUDE.md/AGENTS.md still call it "the active working branch," but production (`main`) has moved far ahead via other PRs that never flowed back.

**Why:** Merging `codex/work-from-production` into `main` would risk reverting ~64 commits of live production work, and the primary tree may hold another session's uncommitted work you must not disturb.

**How to apply:** For any change destined for production, **branch from `origin/main`** in an **isolated worktree** (`git worktree add ... -b <branch> origin/main`), rebuild the change there (re-anchor edits against main — files like `excuses/service.ts` differ from the stale branch), validate, push, open a PR to `main`, wait for the required `validate` check, then squash-merge. Do NOT switch branches or stage files in the primary tree if it shows uncommitted changes you didn't make. Fresh worktrees have no node_modules → `npm ci`. See [[parallel-session-swarm-hazard]], [[main-sync-and-wt-main]].

Delivered this way: PR #409 (employee-facing `excuse_decision` email template) — squash-merged to main as e26c7d25, prod deploy success, `https://phoenix-workforce.vercel.app` 200. Migration `20260623000000_seed_excuse_decision_email_template.sql` APPLIED to prod via Supabase MCP `apply_migration` (project `ozucdzovmcqvepbozvqf`).

GOTCHA on Supabase MCP `apply_migration`: it records the history row with version = APPLY-TIME timestamp (not the filename timestamp) and stores whatever you pass as `name`. This prod's `schema_migrations` convention is version=apply-time, name=BARE descriptive (e.g. `weekly_batches_contract_source`, NOT `20260622235900_weekly_batches_contract_source`). So pass `name` WITHOUT the timestamp prefix (e.g. `seed_excuse_decision_email_template`), or normalize after. See [[probation-email-no-data-token-gap]], [[health-fixation-2026-06-15]].
