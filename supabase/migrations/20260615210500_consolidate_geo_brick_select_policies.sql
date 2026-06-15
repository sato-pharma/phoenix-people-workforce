-- ============================================================================
-- Consolidate overlapping authenticated SELECT policies on geo/brick tables
-- ----------------------------------------------------------------------------
-- Finding (perf advisor 0006 multiple_permissive_policies): each of the 5
-- geo/brick tables has TWO permissive policies that both apply to
-- role=authenticated, cmd=SELECT, so Postgres evaluates both on every row:
--   * <t>_select_access  FOR SELECT  using (<read scope>)
--   * <t>_write_access   FOR ALL     using (private.phx_can_manage_geo())
-- (`FOR ALL` also covers SELECT, hence the overlap.)
--
-- Fix is behaviour-preserving. Effective read set BEFORE =
--   (<read scope>) OR private.phx_can_manage_geo()
-- We fold phx_can_manage_geo() into the single SELECT policy and re-scope the
-- write policy to INSERT/UPDATE/DELETE only, leaving exactly ONE permissive
-- SELECT policy per table for authenticated. Read set AFTER = identical; write
-- authorization (phx_can_manage_geo) unchanged; the service_role policy is
-- untouched.
--
-- IMPORTANT: the geo/brick tables and the private.phx_can_manage_geo() helper
-- are currently PROD-MANAGED and not yet defined by repo migrations (tracked
-- drift; see docs/security/supabase-advisor-baseline.md). This migration is
-- therefore GUARDED: on a from-scratch build (Supabase preview branch / staging
-- rebuild) where that subsystem is absent it logs and no-ops; on production
-- (and anywhere the subsystem exists) it runs idempotently (every target policy
-- is dropped-if-exists before recreation, so re-running is safe). Full baseline
-- capture of the geo/brick tables + helpers is the tracked follow-up.
--
-- Live SELECT quals captured from prod (ref ozucdzovmcqvepbozvqf) are preserved
-- verbatim below and OR'd with phx_can_manage_geo().
-- ============================================================================

do $$
begin
  if to_regclass('public.brick_reference_imports') is null
     or to_regclass('public.brick_reference_rows') is null
     or to_regclass('public.geo_bricks') is null
     or to_regclass('public.geo_locations') is null
     or to_regclass('public.geo_trip_routes') is null
     or to_regprocedure('private.phx_can_manage_geo()') is null then
    raise notice 'geo/brick subsystem not present (fresh build) - skipping SELECT-policy consolidation';
    return;
  end if;

  -- brick_reference_imports ---------------------------------------------------
  execute 'drop policy if exists brick_reference_imports_select_access on public.brick_reference_imports';
  execute 'drop policy if exists brick_reference_imports_write_access  on public.brick_reference_imports';
  execute 'drop policy if exists brick_reference_imports_write_insert  on public.brick_reference_imports';
  execute 'drop policy if exists brick_reference_imports_write_update  on public.brick_reference_imports';
  execute 'drop policy if exists brick_reference_imports_write_delete  on public.brick_reference_imports';
  execute 'create policy brick_reference_imports_select_access on public.brick_reference_imports for select to authenticated using (private.phx_has_company_access() or private.phx_can_access_line(line) or private.phx_can_manage_geo())';
  execute 'create policy brick_reference_imports_write_insert on public.brick_reference_imports for insert to authenticated with check (private.phx_can_manage_geo())';
  execute 'create policy brick_reference_imports_write_update on public.brick_reference_imports for update to authenticated using (private.phx_can_manage_geo()) with check (private.phx_can_manage_geo())';
  execute 'create policy brick_reference_imports_write_delete on public.brick_reference_imports for delete to authenticated using (private.phx_can_manage_geo())';

  -- brick_reference_rows ------------------------------------------------------
  execute 'drop policy if exists brick_reference_rows_select_access on public.brick_reference_rows';
  execute 'drop policy if exists brick_reference_rows_write_access  on public.brick_reference_rows';
  execute 'drop policy if exists brick_reference_rows_write_insert  on public.brick_reference_rows';
  execute 'drop policy if exists brick_reference_rows_write_update  on public.brick_reference_rows';
  execute 'drop policy if exists brick_reference_rows_write_delete  on public.brick_reference_rows';
  execute 'create policy brick_reference_rows_select_access on public.brick_reference_rows for select to authenticated using (private.phx_has_company_access() or private.phx_can_access_line(line) or private.phx_can_access_employee(dsm_hr_id) or private.phx_can_manage_geo())';
  execute 'create policy brick_reference_rows_write_insert on public.brick_reference_rows for insert to authenticated with check (private.phx_can_manage_geo())';
  execute 'create policy brick_reference_rows_write_update on public.brick_reference_rows for update to authenticated using (private.phx_can_manage_geo()) with check (private.phx_can_manage_geo())';
  execute 'create policy brick_reference_rows_write_delete on public.brick_reference_rows for delete to authenticated using (private.phx_can_manage_geo())';

  -- geo_bricks ----------------------------------------------------------------
  execute 'drop policy if exists geo_bricks_select_access on public.geo_bricks';
  execute 'drop policy if exists geo_bricks_write_access  on public.geo_bricks';
  execute 'drop policy if exists geo_bricks_write_insert  on public.geo_bricks';
  execute 'drop policy if exists geo_bricks_write_update  on public.geo_bricks';
  execute 'drop policy if exists geo_bricks_write_delete  on public.geo_bricks';
  execute 'create policy geo_bricks_select_access on public.geo_bricks for select to authenticated using (private.phx_has_company_access() or private.phx_can_access_line(line) or private.phx_can_access_employee(employee_hr_id) or private.phx_can_manage_geo())';
  execute 'create policy geo_bricks_write_insert on public.geo_bricks for insert to authenticated with check (private.phx_can_manage_geo())';
  execute 'create policy geo_bricks_write_update on public.geo_bricks for update to authenticated using (private.phx_can_manage_geo()) with check (private.phx_can_manage_geo())';
  execute 'create policy geo_bricks_write_delete on public.geo_bricks for delete to authenticated using (private.phx_can_manage_geo())';

  -- geo_locations -------------------------------------------------------------
  execute 'drop policy if exists geo_locations_select_access on public.geo_locations';
  execute 'drop policy if exists geo_locations_write_access  on public.geo_locations';
  execute 'drop policy if exists geo_locations_write_insert  on public.geo_locations';
  execute 'drop policy if exists geo_locations_write_update  on public.geo_locations';
  execute 'drop policy if exists geo_locations_write_delete  on public.geo_locations';
  execute 'create policy geo_locations_select_access on public.geo_locations for select to authenticated using (private.phx_has_company_access() or private.phx_can_access_line(line) or private.phx_can_manage_geo())';
  execute 'create policy geo_locations_write_insert on public.geo_locations for insert to authenticated with check (private.phx_can_manage_geo())';
  execute 'create policy geo_locations_write_update on public.geo_locations for update to authenticated using (private.phx_can_manage_geo()) with check (private.phx_can_manage_geo())';
  execute 'create policy geo_locations_write_delete on public.geo_locations for delete to authenticated using (private.phx_can_manage_geo())';

  -- geo_trip_routes -----------------------------------------------------------
  execute 'drop policy if exists geo_trip_routes_select_access on public.geo_trip_routes';
  execute 'drop policy if exists geo_trip_routes_write_access  on public.geo_trip_routes';
  execute 'drop policy if exists geo_trip_routes_write_insert  on public.geo_trip_routes';
  execute 'drop policy if exists geo_trip_routes_write_update  on public.geo_trip_routes';
  execute 'drop policy if exists geo_trip_routes_write_delete  on public.geo_trip_routes';
  execute 'create policy geo_trip_routes_select_access on public.geo_trip_routes for select to authenticated using (private.phx_has_company_access() or private.phx_can_access_employee(employee_hr_id) or private.phx_can_manage_geo())';
  execute 'create policy geo_trip_routes_write_insert on public.geo_trip_routes for insert to authenticated with check (private.phx_can_manage_geo())';
  execute 'create policy geo_trip_routes_write_update on public.geo_trip_routes for update to authenticated using (private.phx_can_manage_geo()) with check (private.phx_can_manage_geo())';
  execute 'create policy geo_trip_routes_write_delete on public.geo_trip_routes for delete to authenticated using (private.phx_can_manage_geo())';
end $$;

notify pgrst, 'reload schema';
