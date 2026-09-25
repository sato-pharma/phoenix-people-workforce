---
name: perf-audit-2026-07-04-root-causes
description: "Production performance root-cause audit (2026-07-04) — where DB time goes, the half-finished rollup migration, and the P0 fixes."
metadata: 
  node_type: memory
  type: project
  originSessionId: a92a7163-f2b7-4768-977a-f47b95254a35
---

Deep perf audit of production (`ozucdzovmcqvepbozvqf`) on 2026-07-04 using `pg_stat_statements`, table/index sizes, and code agents. Findings reflect live state that day.

**Where DB time goes** (cumulative ~43,154s tracked): analytics RPC family ≈ **39%**. SoS period RPCs 26.7%, marketing ROI customer dashboard 12.1% (400 calls, mean ~13s), employee lookups 5.4% (~154k calls on a 161-row table). 4.64M of 9.7M statements are PostgREST `set_config` = ~4.6M REST round-trips.

**Root causes (systemic):**
1. **Half-finished rollup migration.** Big bespoke SQL fns aggregate the raw 322MB `source_of_sales_import_rows` live (`phx_marketing_roi_customer_dashboard` = 43KB body/44 joins; `phx_si_*`, `phx_exec_sos_trend`, `phx_sales_marketing_dashboard` also read raw). Rollup twins + fresh fact tables EXIST (`phx_marketing_roi_fast`, `marketing_roi_*_facts` populated 2026-07-03) but prod still runs slow path (400 slow vs 90 fast). **P0 win: set `NEXT_PUBLIC_SMI_USE_FACT_TABLES=true` in prod** (flag at [service.ts:804](src/lib/sales-marketing-intelligence/service.ts)); verify parity first.
2. **No caching layer.** 584 `force-dynamic` files, exactly ONE `unstable_cache` (SMI service), zero React `cache()`, zero ISR. SoS dashboard (`getSosDashboard` [src/lib/sales/sos-dashboard.ts](src/lib/sales/sos-dashboard.ts)) skipped the `unstable_cache` that SMI uses. Reference data (national holidays via external Google Calendar per request, product/brick/distributor/org masters) refetched per request.
3. **Per-request auth/nav re-resolution, un-memoized.** `resolveAccessContextFromPage`/`resolveSessionState` ([src/lib/auth/server.ts](src/lib/auth/server.ts)) called ~530× across 250 files; admin/portal layouts re-resolve auth + permission matrix + sidebar modules every navigation (~5-8 DB hops/shell). Drives the ~154k employee reads. Fix: React `cache()` + prop-drill.
4. **Index sprawl.** 264MB indexes on 58MB raw SoS table (18+ indexes, several 40-50MB covering, many 0-25 scans). Advisors: 210 unused indexes, 33 no-PK tables, 16 unindexed FKs.
5. **Instance under-sized for OLAP:** work_mem 2MB, `max_parallel_workers_per_gather`=1, 60 conns. Cache hit 99.9% (not RAM-starved) → slowness is CPU-bound live aggregation, not I/O. Fix queries/caching BEFORE bumping tier.

**Ruled out (with evidence):** rate-limit RPC is per-route scoped (28 routes), not global middleware; `pg_timezone_names` scans (596×) are Supabase Studio/PostgREST introspection, not app code; heavy libs (exceljs/pdf-lib/openai) are correctly server-only/lazy — no bundle bloat. Client secondary: recharts eager in 22 files (never `dynamic()`), `@tanstack/react-virtual` installed but used nowhere.

Related: [[sos-fact-rollup-exec-si-dashboards]], [[sos-dashboard-perf-and-0621-revert]], [[sos-dashboard-rebuild-2026-07-02]].

**Implementation (2026-07-04, branch `codex/perf-caching`, worktree `../_wt-perf-caching`):** Caching + auth-memoization delivery built & validated (typecheck/lint/301 tests/build/routes all green; runtime smoke: SoS dashboard 18.3s→**0.35s** on 2nd load). 7 files: sos-dashboard.ts (extracted RPC fan-out into `fetchSosDashboardRpcRows` = `unstable_cache` 300s tag `sos-dashboard`, key = scope-resolved primitives so no cross-scope bleed; keepExec stays the authz backstop), dashboard/invalidation.ts (+`invalidateSalesDashboardCache`, +tag bust in exec helper when modules includes sales), 3 SoS import paths call it, monthly-distributor-import.ts (cached `listSourceOfSalesProducts` tag `sos-reference` + bust on product create/update/delete), auth/server.ts + admin/modules-control.ts (React `cache()` on resolveAccessContextFromPage / resolveViewerIdentityFromPage / getEffectiveSidebarModuleIds). As of write: NOT yet committed (awaiting owner approval per [[feedback-auto-git-workflow]]).

**Gotchas found:** (1) Next 16 `revalidateTag(tag)` is deprecated → must be `revalidateTag(tag, "max")` (2-arg); `updateTag` only works in Server Actions, not route handlers. (2) ROI fast-path parity PASS — `phx_marketing_roi_fast` == `phx_marketing_roi_customer_dashboard` (109 reqs / EGP 265,330.35 / month-range 53,224.875) BUT only when called with EMPTY ARRAYS (the service's convention); the fast RPC treats `null` array args as "match nothing"→zeros, the slow one treats null as "all". Never call fast with null arrays. Flip (`NEXT_PUBLIC_SMI_USE_FACT_TABLES=true`, build-inlined→needs redeploy) still owner-gated. (3) Deferred Phase C items: outstation policy / organogram / distributor-health caching (low traffic); national-holidays already has a 10-min in-memory cache; brick-centroids is a build tool (not cacheable).
