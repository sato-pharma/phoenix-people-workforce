-- Record the RLS that both report share-link tables have in production but no migration creates.
--
-- THE DEFECT (found 2026-08-06 while bringing staging to parity): the two tables that store
-- report share links are created by migrations that add the table, its index and its comments —
-- and stop there. Neither enables RLS, neither creates a policy, neither revokes the default
-- grants:
--
--   20260805040000_direct_order_report_share_links.sql
--   20260805120000_marketing_request_report_share_links.sql
--
-- Production has all three on both tables, applied by hand after the fact and recorded nowhere.
-- Measured the same day:
--
--   production  direct_order_report_share_links      rls=true   policy=..._service_role_all
--   production  marketing_request_report_share_links rls=true   policy=..._service_role_all
--   staging     direct_order_report_share_links      rls=FALSE  policy=(none)   acl=(default)
--
-- Staging was built from these migrations, so staging is what the files actually produce.
--
-- WHY THIS MATTERS MORE THAN A TIDINESS FIX. These rows are bearer credentials. Each holds a
-- `token` that alone unlocks a live report, a `passcode_hash`, the creator-frozen scope the link
-- was minted with, and — for the marketing table — an `allow_files` flag that lets a token stream
-- evidence photographs of a named doctor's clinic. A table of these sitting in `public` with RLS
-- off is the same shape as the defect that made `backup_employee_crm_identity_20260805` readable
-- from the internet (see 20260805195425_drop_finished_backup_snapshots_from_public.sql): anything
-- created in `public` inherits whatever the schema-wide grants allow, and only RLS plus an explicit
-- REVOKE keeps it shut.
--
-- Access to both tables is mediated entirely by server-side code through the service-role client,
-- so a service_role-only policy is the whole intended contract — there is no legitimate direct
-- reader among anon or authenticated.
--
-- This migration is a no-op on production (it already has exactly this) and is the fix everywhere
-- else. Every statement is idempotent, so re-running it is safe.
--
-- Data impact: none. No DML, no schema change — RLS flag, policy and grants only.
-- Rollback:
--   alter table public.<t> disable row level security;
--   drop policy if exists <t>_service_role_all on public.<t>;

begin;

do $mig$
declare
  v_table   text;
  v_tables  text[] := array[
    'direct_order_report_share_links',
    'marketing_request_report_share_links'
  ];
  v_missing text[] := '{}';
begin
  foreach v_table in array v_tables loop
    -- A table this migration is meant to secure must exist. If a rename or drop ever lands
    -- upstream, fail loudly here rather than silently securing nothing.
    if to_regclass('public.' || quote_ident(v_table)) is null then
      v_missing := v_missing || v_table;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', v_table);

    execute format('drop policy if exists %I on public.%I',
                   v_table || '_service_role_all', v_table);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      v_table || '_service_role_all', v_table);

    -- REVOKE FROM PUBLIC also strips whatever service_role held implicitly through the default
    -- ACL, so the GRANT below is not optional — this repo has been bitten by exactly that before.
    execute format('revoke all on table public.%I from anon', v_table);
    execute format('revoke all on table public.%I from authenticated', v_table);
    execute format('revoke all on table public.%I from public', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'share-link table(s) missing, cannot secure: %', array_to_string(v_missing, ', ');
  end if;
end
$mig$;

-- Fail loudly rather than reporting success while a bearer-token table is still open.
do $verify$
declare
  v_table  text;
  v_tables text[] := array[
    'direct_order_report_share_links',
    'marketing_request_report_share_links'
  ];
  v_oid    oid;
begin
  foreach v_table in array v_tables loop
    v_oid := to_regclass('public.' || quote_ident(v_table));

    if not (select relrowsecurity from pg_class where oid = v_oid) then
      raise exception 'RLS is not enabled on public.% — bearer tokens would be unprotected', v_table;
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_table
        and policyname = v_table || '_service_role_all'
    ) then
      raise exception 'policy %_service_role_all is missing on public.%', v_table, v_table;
    end if;

    if has_table_privilege('anon', v_oid, 'SELECT')
       or has_table_privilege('authenticated', v_oid, 'SELECT') then
      raise exception 'anon/authenticated can still read public.% — share tokens are exposed', v_table;
    end if;

    if not has_table_privilege('service_role', v_oid, 'SELECT') then
      raise exception 'service_role lost SELECT on public.% — every server-side reader would break', v_table;
    end if;
  end loop;
end
$verify$;

notify pgrst, 'reload schema';

commit;
