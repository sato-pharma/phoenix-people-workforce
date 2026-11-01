-- revoke_browser_execute_on_marketing_roi_health
--
-- WHAT THIS CHANGES: public.phx_marketing_roi_health() stops being executable by PUBLIC, anon and
-- authenticated. service_role keeps it, re-granted so the end state is stated, not assumed. The
-- function body and its declared limit are untouched; no data is read or written.
--
-- WHY: the function declares statement_timeout=120s, and measured on PostgREST 14.5 (1 Nov 2026) a
-- function's own limit replaces the caller's role limit on /rest/v1/rpc: one declaring 6 s, called
-- with the anon key (role limit 3 s), slept 4 s and answered 200 at 4,490 ms. It was the only
-- function in public with a declared limit that anon and authenticated could execute.
--
-- WHAT STOOD IN THE WAY UNTIL NOW: the table grants, and nothing else. The function is not SECURITY
-- DEFINER and neither role can read marketing_request_products, so on staging both were refused at
-- statement 1 with 42501 inside a 5 s limit, before this revoke. One future SELECT grant on the
-- tables it reads would have opened the 120 s hold to the public key in the browser bundle. This
-- closes that at the function, so the browser roles no longer depend on those grants staying as
-- they are.
--
-- Its one caller is scripts/verify-marketing-roi.ts (pnpm run marketing:roi-verify), through
-- getSupabaseAdmin, the service-role client. Nothing in src/ or app/ names it, and no function body,
-- view, policy or cron job calls it, on either database.
--
-- PUBLIC has to be named: the ACL read {=X/postgres,...}, and anon held EXECUTE through that entry
-- alone, so revoking only anon would change nothing. That also takes it from the other roles that
-- held it through PUBLIC. Of those, supabase_etl_admin, supabase_read_only_user and pg_read_all_data
-- can read the tables, so a direct call from one of them would now be refused; none is a known
-- caller, and each can still read the tables themselves.
--
-- ROLLBACK: grant execute on function public.phx_marketing_roi_health() to public, anon, authenticated;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

revoke execute on function public.phx_marketing_roi_health() from public, anon, authenticated;
grant  execute on function public.phx_marketing_roi_health() to service_role;

-- Fail loudly rather than leave a half-state.
do $guard$
declare
  v_sig text := 'public.phx_marketing_roi_health()';
begin
  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    raise exception '%: anon still holds EXECUTE, so the revoke did not take', v_sig;
  end if;

  if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
    raise exception '%: authenticated still holds EXECUTE, so the revoke did not take', v_sig;
  end if;

  if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    raise exception '%: service_role lost EXECUTE, and scripts/verify-marketing-roi.ts runs as that role', v_sig;
  end if;
end $guard$;

commit;
