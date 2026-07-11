-- ============================================================================
-- Lock down EXECUTE on phx_terminate_employee_for_non_renewal to service_role
-- ----------------------------------------------------------------------------
-- Finding (High): public.phx_terminate_employee_for_non_renewal(uuid, text) is
-- a SECURITY DEFINER plpgsql function that TERMINATES an employee and opens a
-- replacement vacancy. It performs NO internal authorization check — it only
-- validates inputs and the renewal-request status. The authoritative migration
-- (20260531120000_contract_non_renewal_terminal_lifecycle.sql) correctly did
-- `revoke all ... from public; grant execute ... to service_role;`.
--
-- HOWEVER, on live production (verified via information_schema.routine_privileges)
-- the EXECUTE grant list is { service_role, authenticated, postgres } — i.e.
-- `authenticated` somehow regained EXECUTE (likely a blanket
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, or an
-- out-of-band re-create). That means any signed-in user holding a Supabase Auth
-- JWT (the auth bridge issues real ones) could call
-- /rest/v1/rpc/phx_terminate_employee_for_non_renewal and irreversibly
-- terminate an employee whose contract row is in `not_renewed` status.
--
-- Fix: re-assert the intended grant — service_role only. The application invokes
-- this RPC exclusively through the service-role admin client, so revoking
-- `authenticated`/`anon`/`public` has zero application impact.
-- Reversible (re-grant below) but you should not re-grant authenticated.
-- ============================================================================

revoke execute on function public.phx_terminate_employee_for_non_renewal(uuid, text) from public;
revoke execute on function public.phx_terminate_employee_for_non_renewal(uuid, text) from anon;
revoke execute on function public.phx_terminate_employee_for_non_renewal(uuid, text) from authenticated;
grant  execute on function public.phx_terminate_employee_for_non_renewal(uuid, text) to service_role;
