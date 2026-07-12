-- Close the blanket-authenticated RLS read gap on sales/reference tables (audit finding M3).
--
-- These 17 tables each carry a `FOR SELECT TO authenticated USING (true)` policy: any request bearing
-- a valid Supabase Auth JWT (the `authenticated` Postgres role) can SELECT every row directly via
-- PostgREST. That bypasses the application's own access rules — most importantly
-- canViewRestrictedProducts, which restricts the confidential products LA003/LA004/SS001 (and their
-- factory_price) in sales_product_codes to CEO/Super Admin, and the line/region sales scoping applied
-- over the sales_ops_* rollups. The DB layer imposes none of that: it is wide open to `authenticated`.
--
-- Exploitability is currently LOW (the Supabase access-token cookie is httpOnly, there is no
-- browser-side Supabase client, and the cookie is domain-scoped so it is not auto-sent to *.supabase
-- .co), so this is a defense-in-depth / latent gap rather than a one-click leak — but the app-layer
-- guard is the ONLY thing protecting this data today, and that gap goes live the moment anyone adds a
-- browser-side Supabase client (a common Next.js pattern) or via XSS.
--
-- Verified safe to drop: NONE of these 17 tables is read through an RLS-respecting client. The
-- confidential/sales-figure tables (sales_product_codes, sales_ops_*, sales_distributor_codes,
-- sales_area_region_codes) have ZERO direct supabase.from() references in application code -- they are
-- read only via SECURITY DEFINER RPCs (phx_exec_sos_*, phx_customer_directory, etc.) which read with
-- definer privileges. The reference tables (departments, marketing_pharmacy_code_references,
-- outstation_policy_rules) are read via getSupabaseAdmin() (service role, which bypasses RLS
-- regardless of policy). So the `authenticated` read policy serves no legitimate app path; its only
-- effect is permitting the direct-PostgREST exposure above.
--
-- Effect: RLS stays ENABLED on every table; only the over-permissive authenticated-read policy is
-- removed. Service-role access (the app's admin client + the definer RPCs) is unaffected.
--
-- SAFE: drops RLS policies only. No table, row, column, or index is dropped or modified.
--
-- APPLY IS GATED (staging first, per AGENTS.md): although verified safe from static analysis, this is
-- a production RLS change. Before promoting to production, verify on staging that the Sales / Source-of
-- -Sales dashboards, the Sales-Marketing Intelligence dashboard, the Database Mapping / master-data
-- pages, the employee-import confirm flow, and the attendance roster/fingerprint reports all still
-- load (these are the paths that touch the affected tables, all via service role / RPCs).

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
