-- service_role_only_tables_and_functions
--
-- WHAT THIS CHANGES:
--   1. Row-level security is switched on for the three application tables that did not have it:
--      ats_whatsapp_message_templates, ats_whatsapp_template_sends, business_card_requests. No policy
--      is added: like the other application tables they are read and written only by the server
--      (service_role, which bypasses row-level security). Neither browser role holds a privilege on
--      them today; this keeps it that way if a grant is ever added by accident.
--   2. EXECUTE on every application function in `public` that the anonymous role could run (41 on
--      production on 13 Nov 2026: 32 trigger functions and 9 helpers) is taken from PUBLIC and anon.
--      service_role is re-granted explicitly, and `authenticated` is re-granted wherever it could run
--      the function before, so the only role that changes is anon. Extension functions are left alone.
--
-- WHY: S01 audit, REC-058 (F-DB-008, F-DB-009). Every caller was reviewed first:
--   * the app calls none of the 9 helpers through the browser key; every writer of
--     report_it_reports (default generate_report_it_number) and device_assignments (check
--     phx_custody_item_values_valid) uses the service-role client;
--   * a trigger function's EXECUTE is checked when the trigger is created, not when it fires, so
--     revoking it changes no write;
--   * the three tables are reached only through getSupabaseAdmin() / recruitmentDb().
--
-- ROLLBACK:
--   alter table public.ats_whatsapp_message_templates disable row level security;  (and the other two)
--   grant execute on function public.<fn>(<args>) to public;  for each function this revoked — the
--   NOTICE below prints the count, and the 41 are the anon-executable list read on 13 Nov 2026.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_whatsapp_message_templates enable row level security;
alter table public.ats_whatsapp_template_sends enable row level security;
alter table public.business_card_requests enable row level security;

do $$
declare
  r record;
  revoked integer := 0;
begin
  for r in
    select p.oid::regprocedure as signature,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_had_it
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
    if r.authenticated_had_it then
      execute format('grant execute on function %s to authenticated', r.signature);
    end if;
    revoked := revoked + 1;
  end loop;
  raise notice 'anon EXECUTE revoked on % application functions', revoked;
end
$$;

commit;
