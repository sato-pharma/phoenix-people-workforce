---
name: crm-effective-view-column-order-trap
description: "ireports360_visits_effective must be DROP+recreated (not CREATE OR REPLACE) when base columns are added — reorder fails 42P16; both No-Check-in tabs broke"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6d20aeb9-9413-4a9f-b937-e9c675075ca7
  modified: 2026-07-27T22:49:47.113Z
---

The `ireports360_visits_effective` view (public) is `select v.* , has_checkin, reclassified_no_checkin, effective_visit_type` from `ireports360_visits` (with `security_invoker = true`). Because it's `v.*`, when a NEW column is added to `ireports360_visits`, the view must be **recreated** to expose it (Postgres freezes the column list at view-creation time).

**The trap (cost a prod incident 2026-07-27):** a bare `CREATE OR REPLACE VIEW` to refresh it FAILS with `42P16: cannot change name of view column "has_checkin" to "crm_region_id"`. `v.*` puts the newly-added (appended) base columns BEFORE the trailing computed columns (has_checkin/reclassified/effective), which reorders the existing view columns — and CREATE OR REPLACE VIEW can only ADD trailing columns, never reorder. **You must `DROP VIEW IF EXISTS ... ; CREATE VIEW ...`** (the view has no dependents; drop+recreate in one migration is atomic/safe).

**Incident:** vendor cols `crm_region_id/crm_region_name/speciality/crm_contact_grade` were added to the base table (2026-07-22..24) but the view (created 2026-07-17) wasn't refreshed → `VISIT_SELECT` in `src/lib/crm/master.ts` reads those from the view for the two No-Check-in tabs (`regular_no_checkin`, `regular_dv_no_checkin`) → both threw `column "crm_region_id" does not exist` → `/admin/crm` error boundary "Admin workspace unavailable", digest 2831842553. The Visits tab was fine (reads the base table, not the view).

**Resolution:** #1404 (`e0c55a44`) tried the refresh but used CREATE OR REPLACE → broken (never applied anywhere). I applied a DROP+recreate to staging+prod (`reconcile_visits_effective_view_vstar`) and **#1405 (`7c5244ae`, MERGED)** repaired #1404's migration file (`20260728000000_refresh_visits_effective_view.sql`) to add the DROP. DB + repo now consistent. See [[mcp-apply-migration-version-drift]] [[migration-timestamp-collision-hazard]] [[ireports360-crm-integration]].
