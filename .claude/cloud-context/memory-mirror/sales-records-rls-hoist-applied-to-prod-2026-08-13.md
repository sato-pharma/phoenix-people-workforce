---
name: sales-records-rls-hoist-applied-to-prod-2026-08-13
description: "The sales_records RLS policies were hoisted to InitPlan form in BOTH staging and production on 2026-08-13 — applied by hand, do not redo or undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: c139b350-0753-43a0-9dd3-00cd120e658d
  modified: 2026-08-12T22:37:02.751Z
---

**Applied to PRODUCTION (`ozucdzovmcqvepbozvqf`) and STAGING (`cifwmndunmlxjhyjugxa`) on 2026-08-13.
Do NOT re-apply and do NOT revert.** Owner approved the production apply explicitly.

All four `authenticated` policies on `public.sales_records` had their access helpers wrapped in scalar
subqueries: `sales_records_select_access`, `_hr_update`, `_hr_delete`, `_hr_insert`. Migration file
`supabase/migrations/20260813133000_sales_records_rls_initplan_hoist.sql`, PR
[#2075](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2075).

**Why:** the helpers were called bare, so Postgres made them part of the per-row qual and re-ran them
for every row. Each runs its own `select` against `user_access_profiles`; at 11,267 rows that is
~56,000 subqueries per scoped SELECT. Reads **timed out** for all five scoped roles (Employee,
Medical Rep, District Manager, Finance Manager, Talent Acquisition). Super Admin and CEO were
unaffected only because `OR` short-circuits on the first disjunct.

**The hoist is semantics-preserving, not a visibility change.** All four helpers
(`current_access_is_super_admin`, `current_access_is_company_reader`, `current_access_is_hr`,
`current_access_hr_id`) are STABLE, zero-argument, SECURITY DEFINER, and row-independent — verified in
BOTH projects before applying. Post-apply the policy fingerprint
`md5 = 2d9c93051ec79ea1f1676deb1838e473` is **identical in staging and production**.

**How to apply this pattern elsewhere:** this is the standard Supabase RLS trap and probably affects
other tables. `employee_probation_select_access` was already in the correct form
(`( SELECT private.phx_has_company_access() )`) — use it as the reference shape. Grep policies for
bare `current_access_*()` / `phx_*()` calls not wrapped in `( select ... )`.

**Caveat when applying by MCP:** `apply_migration` stamps its own version, so the ledger entry will
not match the migration filename — see [[mcp-apply-migration-versions-drift-from-filename]]. The file
is the source of truth. The filename also collided at `20260813120000` with
`ci_schema_shape_private_usage` from #2073; see
[[migration-timestamp-collides-across-parallel-branches]].

Measured after: scoped read ~185 ms including the Cairo→Frankfurt round trip; phase24 smoke went
`sales_records` FAIL 5/7 → pass 7/7, total passed 59 → 64. `get_advisors(security)` on production
afterwards: 94 advisories, 0 ERROR, none mentioning `sales_records`.

Related: [[phase24-rls-smoke-cannot-run-locally]] · [[every-db-round-trip-crosses-the-atlantic]]
