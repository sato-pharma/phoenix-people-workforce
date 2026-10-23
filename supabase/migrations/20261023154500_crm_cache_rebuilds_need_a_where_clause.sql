-- The two 23 Oct cache rebuilds open with an unqualified DELETE, and that blocks every write to
-- `employees` and `phoenix_crm_team_starts` made through PostgREST.
--
-- WHAT BROKE. A candidate submitted his joining form on 2026-10-23 at 13:11:46.471 Cairo and no
-- employee record was created (`offer_joining_form_hire_failed`, release 429ef7187). The thrown
-- error was not from our code at all:
--
--   Error: DELETE requires a WHERE clause
--
-- `employees` carries the AFTER STATEMENT trigger `crm_person_by_hr_key_sync`, added the same day
-- with the person cache (20261023153000). It calls `crm_person_by_hr_key_rebuild()`, which opens
-- `delete from public.crm_person_by_hr_key_cache;` — no WHERE. PostgREST connects as
-- `authenticator`, which preloads `safeupdate`, and `safeupdate` refuses any DELETE or UPDATE with
-- no WHERE clause. So the trigger kills the whole INSERT, and with it every employee write the app
-- makes: the joining form, HR's Add Employee, every edit, every status change.
--
-- It is invisible by hand. A direct SQL session (psql / the SQL editor / MCP) preloads `supautils`
-- alone, so the rebuild succeeds there every time — which is exactly how both migrations were
-- verified. This repository has paid for that divergence once already, on 2026-08-29, when
-- `phx_refresh_expense_claims()` failed on its first PostgREST call for the same reason; the fix
-- then, and the fix here, is `where true`. See
-- 20260829190000_expense_claims_refresh_runnable_over_http.sql for the full account.
--
-- THE FIX. `where true` on both unqualified deletes. Semantically identical — `safeupdate` objects
-- to the absent clause, not to the row count — so each rebuild still empties its cache exactly as
-- before. Everything else in both function bodies is byte-for-byte what 20261023091035 and
-- 20261023153000 installed.
--
-- `phoenix_crm_rep_entry_days_rebuild()` has the same defect and is reached the same way, from the
-- `phoenix_crm_rep_entry_days_team_start` trigger on `phoenix_crm_team_starts` — a rarer write than
-- `employees`, but the same dead end. Both are fixed here.
--
-- NOT fixed here, deliberately: `phx_admin_reset_module_data()` carries nineteen unqualified
-- deletes and is called over PostgREST from src/lib/admin/data-reset.ts, so the admin module reset
-- is dead on the same error. That one FAILS CLOSED on a wholesale delete of the sales and marketing
-- tables, which is the safer state to leave it in; re-arming a destructive path is the owner's call,
-- not a side effect of an incident fix. `phx_backfill_sos_customer_directory_rollup()` has one too
-- and is hand-run only, never called from the app.

-- -- 1. The employee-row cache (20261023153000) -----------------------------------------------------
create or replace function public.crm_person_by_hr_key_rebuild()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  delete from public.crm_person_by_hr_key_cache where true;
  insert into public.crm_person_by_hr_key_cache (hr_key, hr_id, crm_id, full_name, full_name_nz)
  select c.hr_key, c.hr_id, c.crm_id, c.full_name, c.full_name_nz
    from public.crm_person_by_hr_key_calc() c;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$function$;

-- -- 2. The rep entry-days cache (20261023091035) ---------------------------------------------------
create or replace function public.phoenix_crm_rep_entry_days_rebuild()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  delete from public.phoenix_crm_rep_entry_days_cache where true;
  insert into public.phoenix_crm_rep_entry_days_cache (hr_key, entry_day, agent_crm_id)
  select c.hr_key, c.entry_day, c.agent_crm_id
    from public.phoenix_crm_rep_entry_days_calc() c
  on conflict (hr_key, entry_day) do update
    set agent_crm_id = excluded.agent_crm_id,
        refreshed_at = now();
  select count(*) into v_rows from public.phoenix_crm_rep_entry_days_cache;
  return v_rows;
end
$function$;

-- -- 3. Grants ---------------------------------------------------------------------------------------
-- `create or replace function` preserves the existing ACL, so production and staging already read
-- `{postgres=X/postgres,service_role=X/postgres}`. These are restated verbatim from 20261023091035
-- and 20261023153000 so a replay on a fresh database lands in the same place, and so this file
-- stands on its own: anon/authenticated inherit EXECUTE through PUBLIC, and revoking PUBLIC on a
-- default ACL also strips service_role, so the re-grant is not optional.
revoke execute on function public.crm_person_by_hr_key_rebuild() from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_rebuild() to service_role;

revoke execute on function public.phoenix_crm_rep_entry_days_rebuild() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_rebuild() to service_role;
