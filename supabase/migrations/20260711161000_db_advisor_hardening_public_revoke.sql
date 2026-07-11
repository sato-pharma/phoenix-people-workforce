-- Corrective follow-up to 20260711160000_db_advisor_hardening.sql.
--
-- That migration revoked EXECUTE on phx_employee_insert_reconcile_stale_vacancies_trigger()
-- from anon, authenticated only. But this trigger function still carried an EXECUTE grant to
-- PUBLIC, and anon/authenticated inherit EXECUTE through PUBLIC membership — so the
-- "anon can execute a SECURITY DEFINER function via /rest/v1/rpc" advisory persisted.
-- REVOKE ... FROM anon, authenticated does NOT remove a PUBLIC grant.
--
-- The sibling migration for the other trigger function
-- (20260527153731_revoke_terminal_vacancy_trigger_execute.sql) got this right by revoking
-- FROM public, anon, authenticated. This migration brings the newly-hardened trigger function
-- to the same state.
--
-- Safe: this is a TRIGGER function (returns trigger, no args). The trigger fires internally as
-- the table owner regardless of any role's EXECUTE grant, and service_role/postgres retain
-- EXECUTE, so the application and the reconcile trigger are unaffected.

revoke execute on function public.phx_employee_insert_reconcile_stale_vacancies_trigger() from public, anon, authenticated;
