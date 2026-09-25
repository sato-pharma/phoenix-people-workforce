---
name: sos-dashboard-perf-and-0621-revert
description: "SoS dashboard 'Could not load' = getSosDashboard ran ~6 heavy aggregates concurrently (16-26s each) -> timeout; fix = 1 lightweight per-period trend RPC + a PL/pgSQL-dynamic-SQL plan trick."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7a67c3ef-bdbd-4cb6-ad63-8c5bfdbbae90
---

Engineering learnings from diagnosing the Source-of-Sales dashboard (`/sales/monthly-dashboard`, `sos-dashboard.ts`) "Could not load source-of-sales data." outage. NOTE: that dashboard + the whole day were reverted — see [[revert-2026-06-21-full-day]]; this captures the fix pattern in case SoS is re-introduced. Reference impl on branch `codex/sos-dashboard-perf` (closed PR #419; the prod objects it added were dropped again as part of the revert cleanup).

**Symptom → cause:** `getSosDashboard()` fetched FULL per-distributor/product detail for ALL ~6 trend-window months at once (`rpcAll(phx_exec_distributor_product)` once per period, `count:"exact"` doubling each). That ~6-way concurrent burst saturated the DB → each call 16–26s → page over its limit → connection dropped.

**GOTCHA — broken page logs NO 5xx:** the page is a Server Component that `try/catch`es getSosDashboard and returns **HTTP 200 with `initialError`**. So "zero 500s in Vercel logs" did NOT mean it worked — it was failing every load at 200. A *generic fallback* error string ("Failed to load…") means a **non-Error object was thrown** (a supabase-js PostgrestError), i.e. a DB query failed.

**Fix pattern:** replace the 6 heavy calls with (a) ONE lightweight `phx_exec_sos_trend(periods, filters…, exclude)` RPC returning per-period totals only, (b) full detail for the SELECTED month only. Selected month reuses detail totals so the trend's last point matches the KPI cards; trend failure is non-fatal.

**DB PERF GOTCHA that cost hours:** a `LANGUAGE sql` / `SECURITY DEFINER` function plans its body ONCE with array args as a **bind parameter** → a generic plan that ignores a covering index (~17s on prod). The IDENTICAL query with **literal** arrays uses the covering index-only scan (~1.3s). `plan_cache_mode = force_custom_plan` did NOT fix the sql-function case. What worked: rewrite as **PL/pgSQL** `return query execute format($q$ … any(%1$L::text[]) … $q$, p_periods, …)` — inlines the values as literals (injection-safe via `%L`), re-plans per call, picks the index. Pair with a covering index `(invoice_period) INCLUDE (batch_id, qty, discount, value, is_direct, product_code)` + `VACUUM ANALYZE` (visibility map → true index-only). Related: [[sales-command-statement-timeout]], [[command-center-perf-on2-sales]].
