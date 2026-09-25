---
name: analytics-multi-select-time-filters
description: "Period/Channel/Week/Year analytics filters converted from single-select to multi-select — PR #1170 MERGED + PROD-LIVE 2026-07-19"
metadata:
  node_type: memory
  type: project
  originSessionId: 7a426ddb-95c0-494b-928f-6af0ac0d891a
---

Owner ask 2026-07-18: "i want to be able to choose multiple in the same filter" → clarified as "all" (every remaining single-select filter). Scope: **Period (exact-period picker), Channel, Week, Year**. From/To Period deliberately stay single-value (continuous range pair — multi-selecting from+to independently has no coherent meaning).

**Built as [[analytics-open-to-all-scoped-plan|PR #1170]]**, stacked on `codex/analytics-dual-mode-routing` (#1150), worktree `_wt-analytics-multi-filters`. Commit `2632f443`.

**Database migration** `20260718200000_analytics_multi_select_period_channel_week_year.sql` — 7 functions (`analytics_sos_by_period/_line/_area/_product/_customer`, `analytics_closing_by_employee` live overload only, `analytics_weekly_fact`) converted scalar `p_period`/`p_channel`/`p_week_start`/`p_year` → array `p_periods`/`p_channels`/`p_week_starts`/`p_years`, using the SAME `(p_x is null or col = any(p_x))` pattern already proven for lines/regions/etc in these same functions. Postgres requires DROP+CREATE (not CREATE OR REPLACE) since param types change → identity changes. **Applied + verified on staging only** (mathematically exact: multi-period union sums match manually-summed single-period queries; select-both-channels = no-filter baseline). Confirmed safe: only `service_role` has grants on these functions — `anon`/`authenticated` have none, so exposure doesn't change.

**⚠️ DEPLOYMENT COUPLING (critical, re-read before any merge):** the migration RENAMES params, not just widens types — so old frontend code + new migration = broken (param names don't match), and new frontend + old migration = also broken. Migration and this PR's frontend code MUST deploy together. Recommended sequencing: apply production migration, then merge PR #1170 immediately after (auto-promote deploy = few minutes; brief unavoidable mismatch window either order, analytics-pages-only blast radius).

**Also found:** `analytics_closing_by_employee` has a DEAD, UNUSED second overload in prod+staging (narrower signature, doesn't match what `service.ts` actually calls — confirmed via the args it sends). Left untouched, out of scope — flag if anyone asks "why are there two."

**NOT live-verified in a browser**: worktree's `.env.local` = production (unmigrated by design); pointing dev server at staging would need staging's raw service-role key, which I only have indirect MCP tool access to and won't extract as plaintext. Staging SQL-level verification (exact math) substitutes.

**EXECUTED 2026-07-19, exactly this order, owner-approved via explicit "go ahead" on the named 3-step sequence:**
1. Re-verified both PRs CI-green/CLEAN immediately before acting (#1150 had gone briefly CONFLICTING from main advancing — resolved via fresh merge, see [[analytics-open-to-all-scoped-plan]]).
2. Merged #1150 → prod deploy verified (revision `phoenix-hr-00127-ded`, 100% traffic).
3. Applied the migration directly to **production** (`ozucdzovmcqvepbozvqf`) via `mcp__supabase-production__apply_migration`. Pre-flight check confirmed prod's live function signatures matched the migration's `DROP FUNCTION` clauses exactly (no drift from the 2026-07-11 staging clone) before applying. Post-apply, re-queried `pg_proc` to confirm all 7 signatures flipped to array params, and re-ran the same exact-math sanity checks against **prod's real data** (multi-period union = sum of parts; multi-channel-all = no-filter baseline) — both matched exactly.
4. Merged #1170 immediately after → prod deploy verified (revision `phoenix-hr-00136-fik`, 100% traffic, ~10 min after the migration).
5. Checked Cloud Run logs for the ~10-minute gap window (migration live, old frontend still deployed) for RPC/PGRST errors — found none; most likely explained by very low traffic at that hour (~03:20-03:30 UTC / pre-dawn Cairo), not by the mismatch being harmless. Treat the gap as a real (if apparently unhit) production risk window for any future migration of this shape, not a proven-safe pattern.

**Lesson for next time:** this coupled migration+frontend deploy pattern worked but had an unavoidable multi-minute window (CI + Cloud Build + smoke + promote, ~5-10 min) where prod DB and prod frontend disagreed on RPC param names. If a future change of this shape touches higher-traffic hours or a hotter path, consider a backward-compatible two-step instead (add new array params alongside old scalar ones, deploy frontend to use new params, THEN drop old params in a second migration) to eliminate the window entirely.
