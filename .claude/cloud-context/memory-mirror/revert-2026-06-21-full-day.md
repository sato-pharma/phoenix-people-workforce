---
name: revert-2026-06-21-full-day
description: "CRITICAL — the ENTIRE 2026-06-21 production day was reverted on prod (code + DB). Most \"shipped today\" memories are now rolled back."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bb7e256-8a0d-4b71-b511-72caf1d78089
---

On **2026-06-21** the owner reverted and then **fully un-reverted** the entire 2026-06-21 production day.

**UN-REVERT COMPLETE (PR #425, commit `0cf6ada9`):** All 34 PRs' code is back on `main` and all 12 DB migration effects have been re-applied to production (`ozucdzovmcqvepbozvqf`) via `execute_sql`. Final verified state: 11-arg `phx_marketing_roi_customer_dashboard` (with emp_req join + rollup-family lateral join + p_exclude_codes), lines id1="Anti infective"/id4="Head Office", `column_contract_source` column present, `excuse_decision` email template present, ROI attribution index present, pharmacy coverage fn present. The 5 post-revert commits (#420 employee dedupe, #421 nav order, #415 sales-upload streaming, #422 SoS fact rollup, 7956670f upload guards) were preserved throughout.

---

On **2026-06-21** the owner reverted the **entire 2026-06-21 production day**.

- **PR #418** (squash `271c1be0` on `main`) reverted ALL 34 of that day's PRs' **code** back to `7dc98083` (2026-06-20 23:55 — last commit before the day). Vercel prod deploy READY.
- A **compensating DB rollback** (migration file `20260624000000_revert_all_2026_06_21_db_changes.sql`, also on main) was **applied to PRODUCTION** (`ozucdzovmcqvepbozvqf`) via Supabase MCP `execute_sql`, undoing all **12** of that day's migrations. Verified post-state: 10-arg `phx_marketing_roi_customer_dashboard` restored (11-arg dropped), `lines` id1="Anti Inf" / id4="Office", `column_contract_source` dropped, `excuse_decision` template deleted, ROI attribution index + pharmacy-coverage fn dropped. The grant-revoke hardening (#377) was deliberately KEPT (not reversed).

**Consequence:** every memory entry marked "SHIPPED/LIVE on prod 2026-06-21" is **rolled back on prod** — e.g. CEO Command Center ([[ceo-command-center-phase1]] #408/#413), ROI 500/perf fix (#381), marketing personal workspace (#411 [[marketing-personal-workspace-own-scope]]), MM overview landing, weekly-plan approvals ([[weekly-plan-approvals-in-action-center]] #389), Office→Head Office (#388) / Anti infective (#384), excuse_decision email template, modern sales dashboards (#406/#412), sales-intel SS001/exclude-codes (#410). Treat those as NOT in prod until re-shipped.

**Side effect (by design):** the revert reintroduced the known ROI report **HTTP 500 + ~105x slowdown** (removed the timeout overrides + attribution index).

**Reason given:** "something broke in production" — the specific break was never identified; owner chose a full-day revert over a targeted fix despite the guardian warning. The compensating rollback SQL is idempotent/guarded (safe to re-run). The 12 original migration files were kept on main as the append-only ledger. See [[work-from-production-branch-is-stale]] for branch context.
