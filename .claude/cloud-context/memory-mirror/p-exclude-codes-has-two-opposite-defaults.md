---
name: p-exclude-codes-has-two-opposite-defaults
description: "The SAME RPC arg name p_exclude_codes defaults to fail-CLOSED in analytics_sos_* but fail-OPEN ('{}') in 18 other functions — omitting it hides or reveals depending on which you call"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 73e17b1a-b911-4f54-91a1-e54eb3d313b0
  modified: 2026-08-02T03:15:27.563Z
---

✅ **FIXED 2026-08-02 — PR #1621, squash `f5dfdfd3`, applied to staging AND production.** The table
below is the state that USED to exist; every default is now fail-closed and the 7 dead RPCs are
dropped. Production before → after: fail-open defaults 17 → 0; `phx_exec_distributor_product()`
called with the argument omitted returned **307** confidential rows → now **0**, while an explicit
`p_exclude_codes := '{}'` still returns 307 (so the guard is real, not an empty table).
🔴 `phx_customer_directory` was NOT dropped despite zero TS callers — `phx_customer_directory_json`
calls it from SQL. Always check `pg_proc.prosrc`/`pg_views`, not just `git grep`, before dropping.
Kept as history because the two-conventions trap explains the codebase's older call sites.

Verified in production `ozucdzovmcqvepbozvqf` on 2026-08-02 via `pg_get_function_arguments`.

**Two opposite conventions for one argument name:**

| Functions | `p_exclude_codes` default | Omitting the arg means |
| --- | --- | --- |
| `analytics_sos_by_period` / `_by_area` / `_by_line` / `_by_product` | `{LA003,LA004,SS001}` | **HIDE** (fail-closed) |
| `phx_sos_geo_aggregates_without_restricted`, `phx_marketing_coverage_export_sales_detail`, `phx_marketing_request_view_sales` | `{LA003,LA004,SS001}` | **HIDE** (fail-closed) |
| **18 others** — `phx_si_*` (6), `phx_exec_*` (4), `phx_customer_directory[_json]`, `phx_customer_sales`, `phx_marketing_roi_fast`, `phx_marketing_roi_customer_dashboard`, `phx_marketing_request_roi_actuals_v2`, `phx_sales_marketing_dashboard` | `'{}'` | **REVEAL** (fail-open) |

`analytics_sos_by_period` and `_by_area` additionally take `p_exclude_head_office boolean DEFAULT
true` (fail-closed). `_by_line` and `_by_product` deliberately do **not** — they return a line column,
so TS strips Head Office via `stripHeadOfficeRows`. That asymmetry is intentional, not a gap.

🔴 **The trap:** `tests/sales-head-office-lock.test.ts` pins the analytics idiom — *"Hiding must OMIT
the key rather than pass the codes: the RPC default is the fail-closed answer."* Apply that learned
habit to any `phx_exec_*` / `phx_si_*` call and you **silently reveal** the confidential products.
`sos-dashboard.ts:383` even uses the omit-when-empty spread against a fail-open default — correct
there only because empty legitimately means "reveal" for that viewer, not because omitting is safe.

**Severity is LATENT, not live** (checked, don't re-panic): every one of these is `SECURITY DEFINER`
and **`service_role` only** — `has_function_privilege('anon'|'authenticated', …, 'EXECUTE')` is
`false` for all 15 sampled. No browser JWT can call them directly, so this is a footgun for our own
server code, not an exposed hole.

**Dead surface:** the 6 `phx_si_*` functions have **zero TypeScript callers** (`git grep` on
src+app) yet still exist in prod with fail-open defaults. Candidates for deletion.

**The safe idiom regardless of which function you call:** always pass `p_exclude_codes` explicitly.
Deriving it as `canSeeRestricted ? [] : [...RESTRICTED_PRODUCT_CODES]` (plus the Head Office codes
resolved from the master) is what both `sos-dashboard.ts:650/685/690` and the import loader do.

Related: [[sos-import-dashboard-head-office-line-lock]] · [[head-office-line-leak-is-ry001-not-212m]]
