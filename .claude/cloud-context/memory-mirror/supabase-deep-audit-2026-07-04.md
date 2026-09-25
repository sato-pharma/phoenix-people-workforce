---
name: supabase-deep-audit-2026-07-04
description: "Full 10-dimension prod Supabase audit (ultracode, 22 agents): free-only fix plan + verified do-NOT-touch list so future audits don't re-flag healthy things."
metadata: 
  node_type: memory
  type: project
  originSessionId: be16768f-c208-447f-be4f-1cf91b93e99a
---

Deep read-only audit of prod (ozucdzovmcqvepbozvqf) on 2026-07-04 via a 22-agent ultracode workflow (10 audit dims → adversarial verify each → synthesize → completeness critic). 50 verified findings. Report Artifact published this session. Extends [[disk-io-temp-spill-workmem]] and [[perf-audit-2026-07-04-root-causes]].

DB is fundamentally HEALTHY: 99.93% cache hit, no txid-wraparound risk, no replication slots/walsenders, Realtime publication empty, RLS written correctly, connections fine (60 max, ~1 active). Scarce resource = disk I/O (temp spill), not memory/CPU.

**Two biggest levers are NOT SQL:**
1. Stale Vercel deployment **phoenix-workforce-old** = 100% of logged auth errors (37: 404 user_not_found, 500 "DB error checking email", 400 invalid_credentials) — retire/redirect the alias. Also a security liability (old code, prod keys).
2. Flip env **NEXT_PUBLIC_SMI_USE_FACT_TABLES=true** → routes phx_marketing_roi_customer_dashboard (9.5% of ALL DB time, mean 14s/max 45s) to already-built, already-fresh phx_marketing_roi_fast. Reversible, built-in fallback (service.ts ~804). Role-test CEO/SA/MM/GPM + confirm identical snapshot shape first.

**Apply-now free DB batch — APPLIED to prod 2026-07-04 (verified), EXCEPT #4 track_io_timing which is BLOCKED: `ALTER DATABASE postgres SET track_io_timing` → "permission denied to set parameter" (Supabase superuser-managed; NOT settable via the MCP postgres role — do not retry). Applied: effective_cache_size=1GB, phx_exec_customers work_mem=96MB, phx_customer_directory 96→128MB, idle_in_transaction_session_timeout=15s on authenticated/anon/authenticator, default_statistics_target=300 + ANALYZE of 5 hot tables, deleted 13,850 expired api_rate_limit_buckets rows (+VACUUM; recurring prune still a CODE follow-up in /api/notifications/daily), per-table autovacuum on 6 tables, dropped 6 dead indexes CONCURRENTLY (ireports360_checkins_agent_hr_id_idx + 5 dup twins). Original plan detail below.** track_io_timing=on FIRST (it's OFF, so all disk-I/O magnitudes are INFERRED from block counts, not measured); effective_cache_size 384MB→1GB (planner hint, 0 memory); `ALTER FUNCTION phx_exec_customers(text,text[]) SET work_mem='96MB'` (kills 41GB spill, top remaining offender); phx_customer_directory 96→128MB (still spills 31GB; 128 is the ceiling on this instance); idle_in_transaction_session_timeout=15s on authenticated/anon/authenticator; default_statistics_target=300 + ANALYZE 5 hot tables (prefix `SET maintenance_work_mem='256MB'` session-only to speed it); DELETE expired api_rate_limit_buckets (13,853 rows, 100% dead) + recurring prune in /api/notifications/daily (pg_cron NOT installed); per-table autovacuum tuning; drop 6 dead indexes (ireports360_checkins_agent_hr_id_idx 3.7MB 0-scans + 5 dup twins) CONCURRENTLY.

**VERIFIED DO-NOT-TOUCH (false alarms — acting regresses):** don't rewrite RLS auth wrapping (already (select auth.uid())); don't mass-drop the 253 unused indexes (~8MB total, some are month-end report idx); don't drop narrow SoS/weekly/coaching indexes (planner actively prefers them over wider supersets); don't add indexes on the 17 uncovered FKs (all child tables ≤125 rows); don't lower bcrypt cost; don't loosen connection limits or the 8s/3s statement_timeouts; wal_buffers can't be raised free (needs restart/paid). max_parallel_workers_per_gather=1 is a deliberate small-instance cap — leave it.

**Owner-review / deferred (free but not ad-hoc):** 32 RLS-enabled-no-policy tables (safe only while reads stay service_role); audit_logs retention needs compliance sign-off; partition source_of_sales_import_rows by invoice_period (7 distinct) and slim 2 oversized covering indexes and ireports360_visits fillfactor→90 all need staging rehearsal + verified backup + window.

Watch weekly_sales_rows: 3 of top-12 queries (~8.5% DB time), stalest-analyzed hot table — under-weighted, worth caching/EXPLAIN.
