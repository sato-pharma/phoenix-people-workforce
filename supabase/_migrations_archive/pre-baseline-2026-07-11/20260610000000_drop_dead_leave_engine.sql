-- Drop the dead/legacy leave engine.
--
-- Background: earlier migrations (20260512235948 leave_management_engine,
-- 20260513100825 leave_production_readiness, 20260514135726 leave_business_policy_corrections)
-- built a SECOND, fully self-contained leave engine: public.leave_* tables,
-- employee_leave_balances, and the phx_leave_* atomic RPCs. None of these are referenced by
-- any runtime code under src/** or app/** — the LIVE leave/vacation feature runs entirely on
-- the independent v2_vacation_* engine (see src/lib/vacation/service.ts). This migration removes
-- the dead engine to eliminate confusing, unused schema/RLS surface.
--
-- SAFETY NOTES:
--   * The LIVE v2_vacation_* tables/functions/policies are NOT touched here.
--   * The "leave-attachments" storage bucket is intentionally PRESERVED — the live v2 engine
--     reuses it for sick/compensatory evidence (vacationAttachmentBucket in service.ts). No
--     storage changes are made.
--   * The workflow-registry module key string "leave_requests" (src/lib/vacation/workflow.ts)
--     is a registry key, NOT this DB table, and is unaffected by SQL.
--   * Out of scope (NOT dropped): the empty RLS-baseline compatibility stubs
--     public.leave_notification_attempts and public.leave_request_events created by
--     20260522124354_secure_public_rls_cleanup_baseline.sql. They belong to the RLS-cleanup
--     baseline, not the dead leave engine.
--
-- All statements are idempotent (IF EXISTS); CASCADE clears each table's policies, indexes,
-- foreign keys, and sequences.

begin;

-- 1) Drop every dead phx_leave_* function (public schema only). A set-based DO block is used
--    instead of explicit signatures because these functions were redefined/overloaded across
--    migrations; this drops them all regardless of argument list. The live engine uses
--    phx_vacation_* functions, never phx_leave_*, so this is precise and safe.
do $$
declare
  fn record;
begin
  for fn in
    select n.nspname as schema_name,
           p.proname  as func_name,
           pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'phx_leave_%'
  loop
    execute format(
      'drop function if exists %I.%I(%s) cascade;',
      fn.schema_name, fn.func_name, fn.identity_args
    );
  end loop;
end
$$;

-- 2) Drop the dead leave tables, child -> parent. CASCADE removes their dependent policies,
--    indexes, FKs, and sequences. IF EXISTS keeps this safe whether or not the object is present.
drop table if exists public.leave_attachment_objects cascade;
drop table if exists public.leave_accrual_runs cascade;
drop table if exists public.leave_audit_logs cascade;
drop table if exists public.leave_approvals cascade;
drop table if exists public.leave_transactions cascade;
drop table if exists public.leave_requests cascade;
drop table if exists public.employee_leave_balances cascade;
drop table if exists public.leave_policies cascade;
drop table if exists public.leave_types cascade;
drop table if exists public.public_holidays cascade;

-- Ask PostgREST to refresh its schema cache now that the dead objects are gone.
notify pgrst, 'reload schema';

commit;
