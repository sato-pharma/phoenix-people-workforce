---
name: vacation-report-cross-request-cache-live-on-prod-2026-08-14
description: "Vacation report is served from a cross-request cache, NOT the phx_vacation_report_rows RPC per request — LIVE on prod, do not redo/undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T17:59:46.562Z
---

The vacation report no longer calls `phx_vacation_report_rows` per request. `src/lib/vacation/service.ts`
now reads the whole ~300-row `v2_vacation_requests` table ONCE per 60s window via `unstable_cache`
(`loadAllVacationRequestRowsCached`, tag `VACATION_REPORT_ROWS_CACHE_TAG`) and applies each viewer's
scope + WHERE filters in memory. It was the #1 prod query by share of DB time (~15%, ~779 calls/hour) —
a pure VOLUME problem (~7ms over 312 rows), not a slow query.

**Do NOT redo/undo, and do NOT "restore" the `.rpc("phx_vacation_report_rows")` call.** The RPC still
EXISTS in the database (kept for rollback); the app just stopped calling it. The filter logic lives in
the pure, dependency-free `src/lib/vacation/report-filter.ts` (`filterVacationRowsInMemory` +
`vacationIlikePatternToRegExp`), proven **36/36 md5+count-identical to the live production RPC** across a
filter×scope matrix, with a registered guard `tests/vacation-report-filter-equivalence.test.ts`
(break-the-fix confirmed). `tests/vacation-module.test.ts` was updated to assert the new contract
(`doesNotMatch` the per-request RPC call; `unstable_cache(loadAllVacationRequestRowsRaw…)` wired) — do
not revert that guard to the old `.rpc(...)` assertion.

Freshness: every leave write already calls `invalidateExecutiveDashboardCache(reason, ['leave'])`, which
`revalidateTag`s `VACATION_REPORT_ROWS_CACHE_TAG` — one bust in the `leave` block covers all 10 write
sites; the 60s TTL is only a self-healing backstop. Per-request scope mirrors the RPC's
`employee_hr_id = any(p_visible_employee_hr_ids)` exactly (unscoped only for all-visibility viewers).

LIVE on prod 2026-08-14: PR #2143, squash commit `6ed2f5d6`, healthz confirmed serving it, vacation
routes 307 (no 500), 0 app_error_events post-deploy. Same campaign as
[[attribution-rollup-applied-to-prod-2026-08-14]] and the earlier request-level dedup (PR #2105).
