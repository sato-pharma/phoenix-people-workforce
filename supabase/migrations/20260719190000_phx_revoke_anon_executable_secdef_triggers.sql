-- Lock down the remaining anon/authenticated-executable SECURITY DEFINER functions in `public`.
--
-- Companion to 20260719160500 (which closed the analytics_* anon RPC leak). A live pg_proc scan of
-- both staging (cifwmndunmlxjhyjugxa) and production (ozucdzovmcqvepbozvqf) — after the analytics_*
-- revokes — found the only remaining anon-executable SECURITY DEFINER functions are two TRIGGER
-- functions, each carrying the built-in PUBLIC EXECUTE grant (`=X/postgres`, which anon inherits via
-- PUBLIC membership) plus a direct `authenticated` grant:
--   * public.probation_provision_case_on_hire()                     (anon-exec on production)
--   * public.phx_employee_insert_reconcile_stale_vacancies_trigger() (anon-exec on staging — drift; it
--       was revoked on production by 20260711160000/20260711161000 but staging regained the grant)
--
-- Both are fired by INSERT triggers on the employee table. A trigger fires in the context of the
-- statement that fired it and does NOT require any role to hold EXECUTE on the trigger function, and
-- PostgREST does not expose `trigger`-returning functions as /rest/v1/rpc endpoints — so practical
-- exploitability is low, but the security advisor flags them and there is no reason for
-- PUBLIC/anon/authenticated to hold EXECUTE. Revoking is SAFE: the triggers keep firing unchanged
-- (verified: service_role retains EXECUTE, and the triggers stay wired). No app code calls either
-- function as an RPC.
--
-- Explicit revokes for the two known functions (audit-friendly) + a scoped sweep over any other
-- anon/authenticated-executable SECURITY DEFINER TRIGGER function, so future trigger drift can't
-- silently re-open the class. Scoped to trigger-returning functions because those provably never need
-- an EXECUTE grant; non-trigger SECURITY DEFINER functions are deliberately left to explicit,
-- reviewed revokes (a real RPC may legitimately need a grant). Idempotent — a no-op where already
-- revoked. Applied to staging then production and verified (afterward: zero anon-executable SECURITY
-- DEFINER functions remain in `public` on either DB).

revoke execute on function public.probation_provision_case_on_hire() from public, anon, authenticated;
revoke execute on function public.phx_employee_insert_reconcile_stale_vacancies_trigger() from public, anon, authenticated;

-- Drift guard: sweep any remaining anon/authenticated-executable SECURITY DEFINER trigger functions.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype = 'pg_catalog.trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated;', fn.sig);
    raise notice 'swept: revoked PUBLIC/anon/authenticated EXECUTE on trigger function %', fn.sig;
  end loop;
end $$;
