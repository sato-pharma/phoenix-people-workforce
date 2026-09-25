---
name: au-rollback-tables-pending-teardown
description: "10 untracked `_au_rollback.*` snapshot tables on production are almost certainly the area-unification Phase-9 cutover's safety net — do not DROP until owner confirms the cutover is stable (PKs were safely added 2026-07-19, that's a different, non-destructive question)"
metadata:
  node_type: memory
  type: project
  originSessionId: a521782f-ade2-4f0a-88ab-a720b96ba864
  modified: 2026-07-19T19:21:21.702Z
---

Discovered 2026-07-19 while triaging the production Supabase Advisor Center (see
[[supabase-advisor-by-design]]): production (`ozucdzovmcqvepbozvqf`) has a `_au_rollback` schema
with 10 tables — `areas_full`, `coaching_reports_area`, `employee_history_area`, `employees_area`,
`job_offers_area`, `marketing_customers_area`, `marketing_pharmacies_area`,
`marketing_requests_area`, `position_vacancies_area`, `positions_area` — each flagged by the
performance advisor as "no primary key." All are tiny (0-16 kB), have no table comments, and **are
not referenced anywhere in the repo** (`grep -r "_au_rollback"` returns nothing) — meaning they were
created directly against production via MCP/execute_sql, outside the normal migration pipeline, and
never committed.

**Why they're probably still load-bearing:** the naming pattern (`<table>_area`) plus their
existence right alongside the area-unification (`au`) Phase-9 cutover strongly suggests point-in-
time snapshots of each table's area-related column(s), taken as a rollback safety net before the
cutover reassigned area codes. There's direct precedent for needing exactly this: production
migration history includes `restore_area_ids_after_unification_incident` (2026-07-06) — this exact
domain already had one incident that required restoring old area IDs. Per the area-unification
memory thread ([[area-unification-42-areas-audit-findings]], [[au-phase9-cutover-validation]]),
**owner sign-off on the Phase-9 cutover was still open** as of the last update to those memories.

**How to apply — updated 2026-07-19:** do not DROP, TRUNCATE, or otherwise touch the DATA in any
`_au_rollback.*` table without owner confirmation that the area-unification cutover is fully
stable — that's the actual safety-net concern, and it still stands. Adding a PRIMARY KEY turned
out to be a separate, safe question: it's purely additive (ADD CONSTRAINT, no rows touched) and
doesn't reduce the tables' usefulness as a rollback source at all, so this was done directly once
each table's natural key (`id`, or `hr_id` for `employees_area`) was verified to have zero
nulls/duplicates — see [[supabase-advisor-by-design]] for the exact migration. If a future session
wants to close the schema entirely (drop the tables), that's the part that still needs: confirm
with the owner the cutover is fully stable and these snapshots are no longer needed (mirroring how
the 2026-05-31 `private`-schema backup tables were closed, but that closure was preceded by
confirming nothing read them back; do the equivalent check here, e.g. an app-code/RPC grep plus
explicit owner confirmation, before repeating that pattern).

Related: [[supabase-advisor-by-design]], [[area-unification-42-areas-audit-findings]].
