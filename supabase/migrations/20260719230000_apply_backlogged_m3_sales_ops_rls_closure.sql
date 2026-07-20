-- Applies migration 20260712010000_revoke_blanket_authenticated_read_sales_reference.sql
-- (PR #1016, merged 2026-07-12) which was committed to main but NEVER ACTUALLY APPLIED to
-- either staging or production — confirmed via supabase_migrations.schema_migrations on both
-- projects and via live pg_policies showing all 17 policies still present with qual=true.
-- Discovered during the 2026-07-19 deep Supabase audit (RLS policy review found 17 tables
-- with an unconditional `authenticated` SELECT policy that should have been dropped a week ago).
--
-- Re-verified safety before applying: zero references to sales_ops_*, sales_product_codes,
-- sales_distributor_codes, sales_area_region_codes, departments, marketing_pharmacy_code_references,
-- or outstation_policy_rules via direct supabase.from()/getSupabaseRlsClient in src/ — all reads go
-- through getSupabaseAdmin() (service role) or SECURITY DEFINER RPCs, both of which bypass RLS
-- regardless of policy. Dropping these policies removes ONLY the redundant authenticated-read grant;
-- RLS stays enabled, service-role access is unaffected.

begin;

drop policy if exists departments_read on public.departments;
drop policy if exists marketing_pharmacy_code_refs_authenticated_read on public.marketing_pharmacy_code_references;
drop policy if exists outstation_policy_rules_select_access on public.outstation_policy_rules;
drop policy if exists sales_area_region_codes_authenticated_read on public.sales_area_region_codes;
drop policy if exists sales_distributor_codes_authenticated_read on public.sales_distributor_codes;
drop policy if exists sales_ops_dashboard_snapshot_authenticated_read on public.sales_ops_dashboard_snapshot;
drop policy if exists sales_ops_distributor_profile_authenticated_read on public.sales_ops_distributor_profile;
drop policy if exists sales_ops_rollup_area_product_authenticated_read on public.sales_ops_rollup_area_product;
drop policy if exists sales_ops_rollup_by_area_authenticated_read on public.sales_ops_rollup_by_area;
drop policy if exists sales_ops_rollup_by_brick_authenticated_read on public.sales_ops_rollup_by_brick;
drop policy if exists sales_ops_rollup_by_distributor_authenticated_read on public.sales_ops_rollup_by_distributor;
drop policy if exists sales_ops_rollup_by_line_authenticated_read on public.sales_ops_rollup_by_line;
drop policy if exists sales_ops_rollup_by_product_authenticated_read on public.sales_ops_rollup_by_product;
drop policy if exists sales_ops_rollup_by_region_authenticated_read on public.sales_ops_rollup_by_region;
drop policy if exists sales_ops_rollup_leaf_authenticated_read on public.sales_ops_rollup_leaf;
drop policy if exists sales_ops_rollup_period_authenticated_read on public.sales_ops_rollup_period;
drop policy if exists sales_product_codes_authenticated_read on public.sales_product_codes;

-- Two additional stale grants found in the same audit pass (both trigger functions, unreachable
-- via direct SQL/RPC, but closing for hygiene since the 20260719170000 default-privilege fix only
-- covers functions created after it landed):
-- set_coaching_updated_at carried an explicit anon grant that none of its 9 sibling touch-updated-at
-- trigger helpers have.
revoke execute on function public.set_coaching_updated_at() from anon;

-- au.enforce_lam_region had a NULL proacl (raw Postgres default = EXECUTE to PUBLIC), unlike its
-- 12 au-schema sibling trigger functions which all carry an explicit postgres+service_role-only ACL.
revoke execute on function au.enforce_lam_region() from public;
grant execute on function au.enforce_lam_region() to service_role;

notify pgrst, 'reload schema';

commit;
