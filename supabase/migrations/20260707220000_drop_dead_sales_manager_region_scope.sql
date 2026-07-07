-- sales_manager_region_scope (added 20260620170000) is a dead leftover: no scope resolver
-- reads it — Regional Manager scope resolves from the reporting subtree
-- (resolveRegionalManagerRegionCodes in portal-sos-dashboard.ts) and District Manager scope
-- from employees.region_name directly (access-scope.ts). Confirmed before dropping: 0 foreign
-- keys reference it, 0 views/policies/functions depend on it (verified against production,
-- 2026-07-07). The docs playbook (docs/operations/add-new-dsm-region-team.md) already tells
-- operators no row here is needed. 20 existing rows are historical only.

-- SAFE: confirmed zero runtime reads (no scope resolver, view, policy, or function references
-- this table) and zero dependents (FK/view/policy) before dropping; see commit message.
drop table if exists public.sales_manager_region_scope;
