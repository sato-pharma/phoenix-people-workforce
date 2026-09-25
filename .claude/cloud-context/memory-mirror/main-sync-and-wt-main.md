---
name: main-sync-and-wt-main
description: "main now lives at _wt-main, synced to production; new npm run sync:main tool; worktree-move stale node_modules gotcha"
metadata: 
  node_type: memory
  type: project
  originSessionId: 71755360-9003-4626-91b9-a15d068db4a8
---

2026-06-20: Cleaned up `main` drift. Local `main` had fallen 29 commits behind
`origin/main` (0 ahead) and was stuck in a half-merged state (stale Sentry-file
deletions — the same drift seen across ~10 worktrees). Fixed by `reset --hard
origin/main` (safe: 0 unique commits; junk restored from prod).

Durable outcomes:
- **`main` now lives at `F:\Phoenix Workforce\_wt-main`** (relocated via `git worktree
  move` out of the misleadingly-named `_wt-admin-shell-role-authority`, which is gone).
- **New tool: `npm run sync:main`** (`scripts/sync-main.mjs`, Node built-ins only) —
  auto-detects the worktree holding `main`, refuses if it has unique commits or is
  dirty, and only `merge --ff-only`. MERGED as PR #354 (squash `6d0c8ead`), now on
  main/prod. (CI showed UNSTABLE = the known billing-gated `validate` check, not a
  code failure — see [[ci-billing-block-and-unprotected-main]].)
- Synced main passed the FULL local gate: lint + typecheck + test (0 fail) + build (exit 0).

**Gotcha:** `git worktree move` carries the OLD worktree's `node_modules` along. If that
worktree predates newer deps (here `@sentry/nextjs`, `@openai/agents`, `openai`),
typecheck/test fail with ERR_MODULE_NOT_FOUND until you run `npm install` in the moved
worktree. Always `npm install` after relocating a stale worktree onto newer code.

2026-06-20 cleanup DONE (same day): backed up all unmerged local-only branches to
origin (28 pushed) + preserved the `_wt-pr345-conflict` detached orphan as
`backup/pr345-conflict`; then removed 11 merged worktrees (25→13) and deleted 28
merged local branches (~60→37). KEPT (untouched) the 3 worktrees with live uncommitted
WIP — `coaching-duplicate-flag`, `weekly-plans-hardening-main`, `marketing-roi-import`
— so nothing was lost. Branch deletion was LOCAL only; merged remote branches not pruned.

2026-06-20: 2 of those 3 WIP features investigated GOOD-COHERENT (deep review) and resolved:
- `codex/coaching-duplicate-flag` — duplicate detection on coaching import (preview+
  commit+UI). GENUINELY NEW (not on main). Rebased clean onto main + removed now-dead
  legacy inline dup checks; SHIPPED as PR #356 (typecheck + 7 coaching tests green;
  CI running). Ready to merge once `validate` is green.
- `codex/weekly-plans-hardening-main` — ALREADY ON MAIN via commit `8a48b2da`
  (atomic `phx_weekly_plan_replace_items` RPC + same migration + tests). Branch is a
  stale redundant copy → NOT PR'd, kept on origin as backup only. PROD VERIFIED healthy:
  the function exists with correct signature, granted service_role+postgres only (no
  anon/authenticated), and the migration IS applied+recorded — under version
  `20260619120535` (name `weekly_plans_atomic_item_replace`), applied via MCP. The repo
  file `20260620010000_weekly_plans_atomic_item_replace.sql` on main is the SAME migration
  under a different filename → idempotent `create or replace` no-op; pipeline may show it
  "pending" but re-applying changes nothing. Plan save/submit is NOT broken.
`marketing-roi-import` (3rd WIP) left uncommitted (active session).

2026-06-20 full branch triage DONE. Verified each branch's commits against main (content + PR-traced), then:
- Deleted ~16 redundant branches (all already shipped to main) + 2 dangerous ones
  (`revert-sales-operations`, `weekly-sos-filters-tables` — re-adds forbidden alert).
  Group C "to ship" all turned out already-in-main (PRs #304-#308/#326/#327/#343/#346/#348/#351);
  the `sos-fix-auth-hole` security fix is LIVE in prod via #304 (no gap).
- ARCHIVED Group D (large/incomplete sales rewrites) as annotated tags on origin, then deleted
  the branches: `archive/sales-operations-module`, `archive/sales-operations-dashboard`,
  `archive/sales-ops-month-picker`, `archive/sales-one-connected-platform`,
  `archive/weekly-mapping-consolidation` (recover via `git checkout -b <name> archive/<name>`).
  NOTE: `sales-one-connected-platform` mostly shipped via #314; the rewrite was never adopted.
- LEFT active session worktree branches untouched (Group E). Net: ~36→16 local branches.
RULE: never blind-merge all branches to main; triage each (most "branches" here are already shipped).

2026-06-20 worktree triage DONE (mirrors branch cleanup): removed 9 idle worktrees whose
branches are already in main (or safe on origin) — kept primary, `_wt-main`, and worktrees
with live WIP. KEY: removing a worktree never deletes its branch (branch persists local+origin);
only uncommitted work is at risk, so guard each removal on "no real uncommitted work (excl
Sentry junk)". Net worktrees 25→~4 (parallel sessions keep adding/removing their own).

2026-06-21 worktree state after second triage: `_wt-main` is now on `codex/portal-overview-redesign`
(PR #444) — NOT on `main`. Main worktree is on `codex/ceo-command-center-photo` (PR #443).
To access main: `git worktree add F:\Phoenix Workforce\_wt-main2 main`. All 9 confirmed-stale
_wt-* worktrees removed; `phoenix-workforce.worktrees/` entries (agents-sick-pinniped,
customer-directory-rollup-1/2, main-1) are pending review — customer-directory-rollup is
an unshipped DB feature (294-line migration, never applied to prod).
