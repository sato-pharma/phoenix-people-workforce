-- ============================================================================
-- Replace permissive "*_service_role" RLS policies that are actually TO public
-- (sales domain) — completes the permissive-policy sweep from the 2026-06-15 audit
-- ----------------------------------------------------------------------------
-- Finding (High): several sales policies are NAMED "...service_role" but are
-- actually `TO public USING (true) WITH CHECK (true)`, granting full read/write
-- on sales tables to EVERY role (anon + authenticated), not just the service
-- role. Verified live on production (ref ozucdzovmcqvepbozvqf):
--
--   sales_records:        phx_sales_records_service_role (ALL, public, true)
--                         sales_records_hr_admin_write   (ALL, public, true)
--                         "employee can see own sales"   (SELECT, public, true)
--                         sales_records_dynamic_read     (SELECT, public, true)
--   sales_audit_logs:     phx_sales_audit_logs_service_role     (ALL, public, true)
--   sales_import_batches: phx_sales_import_batches_service_role (ALL, public, true)
--   sales_role_overrides: phx_sales_role_overrides_service_role (ALL, public, true)
--   sales_target_batches: phx_sales_target_batches_service_role (ALL, public, true)
--   sales_targets:        phx_sales_targets_service_role        (ALL, public, true)
--
-- Fix: drop the always-true public policies and add an explicit service-role
-- policy. `service_role` has rolbypassrls=true (verified), so the app
-- (service-role client) is unaffected; sales_records keeps its gated
-- `authenticated` CRUD (sales_records_select_access, *_hr_insert/update/delete).
--
-- COORDINATION: these sales tables are under active change on codex/weekly-sales.
-- This is a standalone PR (based on main) rather than a push into that live
-- branch, to avoid a parallel-session collision. Sequence/merge it together with
-- the weekly-sales sales work; confirm weekly-sales does not re-introduce a
-- permissive policy on these tables. Idempotent (re-runnable) + reversible.
-- ============================================================================

-- sales_records: drop the four always-true public policies; keep the gated
-- authenticated policies (sales_records_select_access, *_hr_insert/update/delete).
drop policy if exists phx_sales_records_service_role on public.sales_records;
drop policy if exists sales_records_hr_admin_write   on public.sales_records;
drop policy if exists "employee can see own sales"   on public.sales_records;
drop policy if exists sales_records_dynamic_read     on public.sales_records;
drop policy if exists sales_records_service_role_all  on public.sales_records;
create policy sales_records_service_role_all on public.sales_records
  for all to service_role using (true) with check (true);

-- sales_audit_logs (system audit; service-role only)
drop policy if exists phx_sales_audit_logs_service_role on public.sales_audit_logs;
drop policy if exists sales_audit_logs_service_role_all on public.sales_audit_logs;
create policy sales_audit_logs_service_role_all on public.sales_audit_logs
  for all to service_role using (true) with check (true);

-- sales_import_batches (system; service-role only)
drop policy if exists phx_sales_import_batches_service_role on public.sales_import_batches;
drop policy if exists sales_import_batches_service_role_all on public.sales_import_batches;
create policy sales_import_batches_service_role_all on public.sales_import_batches
  for all to service_role using (true) with check (true);

-- sales_role_overrides (governance; service-role only)
drop policy if exists phx_sales_role_overrides_service_role on public.sales_role_overrides;
drop policy if exists sales_role_overrides_service_role_all on public.sales_role_overrides;
create policy sales_role_overrides_service_role_all on public.sales_role_overrides
  for all to service_role using (true) with check (true);

-- sales_target_batches (system; service-role only)
drop policy if exists phx_sales_target_batches_service_role on public.sales_target_batches;
drop policy if exists sales_target_batches_service_role_all on public.sales_target_batches;
create policy sales_target_batches_service_role_all on public.sales_target_batches
  for all to service_role using (true) with check (true);

-- sales_targets (system; service-role only)
drop policy if exists phx_sales_targets_service_role on public.sales_targets;
drop policy if exists sales_targets_service_role_all on public.sales_targets;
create policy sales_targets_service_role_all on public.sales_targets
  for all to service_role using (true) with check (true);
