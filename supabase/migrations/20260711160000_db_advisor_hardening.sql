-- Database security-advisor hardening (additive, non-destructive).
--
-- 1) Remove direct anon/authenticated EXECUTE on SECURITY DEFINER RPCs that are only
--    ever invoked by the app via the service-role client (getSupabaseAdmin, which
--    bypasses grants). This closes the "signed-in users can call a SECURITY DEFINER
--    function via /rest/v1/rpc" advisory without affecting the application, which never
--    calls these through an authenticated user session.
--      - sales_ops_dashboard: no application call site.
--      - import_marketing_request_atomic: called via getSupabaseAdmin (bulk-import.ts).
--      - phx_employee_insert_reconcile_stale_vacancies_trigger: a TRIGGER function; the
--        trigger still fires regardless of EXECUTE grant.
-- 2) Pin search_path on three plain (non-SECURITY-DEFINER) helper functions flagged for a
--    role-mutable search_path.
--
-- NOTE: the RLS "current_access_*" helper functions are intentionally left callable by
-- authenticated — they are used inside RLS policy expressions. The many
-- "rls_enabled_no_policy" INFO advisories are by-design: those tables are accessed with
-- the service-role client and RLS-enabled-with-no-policy is deny-all for anon/authenticated.

revoke execute on function public.sales_ops_dashboard(p_period text) from anon, authenticated;
revoke execute on function public.import_marketing_request_atomic(p_request jsonb, p_products jsonb, p_pharmacies jsonb, p_steps jsonb) from anon, authenticated;
revoke execute on function public.phx_employee_insert_reconcile_stale_vacancies_trigger() from anon, authenticated;

alter function public.phx_coaching_item_definition(p_key text) set search_path = public, pg_temp;
alter function public.phx_coaching_zone(p_percent numeric) set search_path = public, pg_temp;
alter function public.phx_weekly_plan_next_status(current_status text, action text, has_comment boolean) set search_path = public, pg_temp;
