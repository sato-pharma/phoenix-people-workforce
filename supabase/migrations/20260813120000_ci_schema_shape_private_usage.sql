-- Teach phx_ci_schema_shape() to report USAGE on schema `private`.
--
-- WHY. On 2026-08-12 staging was found with pg_namespace.nspacl = NULL on `private` —
-- no grants at all — while production had `authenticated=U | service_role=U`. EXECUTE on
-- the individual helpers was intact on BOTH: phx_current_hr_id, phx_visible_hr_ids,
-- phx_resigned_hr_ids, phx_has_company_access, phx_can_manage_payroll and
-- phx_can_manage_outstation all reported has_function_privilege(..., 'EXECUTE') = true on
-- staging. That is what made the gap invisible — every grant a reviewer thinks to check
-- was present. Without USAGE on the CONTAINING SCHEMA the call still raises 42501
-- "permission denied for schema private" before the function is ever entered.
--
-- 67 RLS policies across 19 tables in `public` are built on those helpers, so on staging
-- NO policy that uses one could be exercised by impersonating `authenticated`. Staging
-- looked testable and was not — the same false-green as the pre-data-only restore in the
-- header of .github/workflows/migration-drift-check.yml, and exactly what
-- scripts/check-schema-shape.ts exists to catch. The grant itself has been in migration
-- history the whole time (20260711135352_phoenix_production_schema_baseline.sql:39245);
-- staging had the version RECORDED and not the effect, which is why check #1 stayed green
-- and was right to. Repair of the staging instance is
-- supabase/staging_private_schema_usage_restore_20260813.sql; this migration is the
-- DETECTION that makes a recurrence fail a check instead of waiting for a person.
--
-- The whole function body is written out in full rather than patched via
-- pg_get_functiondef(): a catalog-driven rewrite leaves no record in the repo of what it
-- actually replaced, which makes the next drift investigation start from nothing. The body
-- below is the live 2026-08-13 definition (as left by
-- 20260809181000_ci_schema_shape_default_acl.sql) plus two new keys.
--
-- `private_schema_usage` is NULL when schema `private` does not exist, rather than raising:
-- the oid-form of has_schema_privilege() is fed from a subquery that returns no rows. The
-- TypeScript side treats a null/absent key as "not measurable here" and stays silent, the
-- same contract `default_acl_leaks` and `stale_snapshot_schemas` already use.
--
-- `policies_using_private_schema` is what turns this from a golden snapshot into an
-- invariant: the check only demands USAGE while policies actually depend on it. A database
-- that legitimately has no such policies raises nothing and needs no allowlist.
--
-- Reads only catalogs that are world-readable, so `security invoker` (the default, and what
-- the original used) still works for the service_role caller. No behaviour change to any
-- existing key.

create or replace function public.phx_ci_schema_shape()
returns jsonb
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with rel as (
    select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  ),
  reachable as (
    select r.*,
           (has_table_privilege('anon', r.oid, 'SELECT')
             or has_table_privilege('anon', r.oid, 'INSERT')
             or has_table_privilege('anon', r.oid, 'UPDATE')
             or has_table_privilege('anon', r.oid, 'DELETE')
             or has_table_privilege('authenticated', r.oid, 'SELECT')
             or has_table_privilege('authenticated', r.oid, 'INSERT')
             or has_table_privilege('authenticated', r.oid, 'UPDATE')
             or has_table_privilege('authenticated', r.oid, 'DELETE')) as browser_reachable
    from rel r
  ),
  default_acl as (
    select pg_get_userbyid(d.defaclrole) as granting_role,
           case d.defaclobjtype
             when 'r' then 'TABLES'
             when 'S' then 'SEQUENCES'
             when 'f' then 'FUNCTIONS'
             when 'T' then 'TYPES'
             else d.defaclobjtype::text
           end as obj_type,
           coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee,
           string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclobjtype in ('r', 'S', 'f')
      and (a.grantee = 0
           or a.grantee = to_regrole('anon')
           or a.grantee = to_regrole('authenticated'))
    group by 1, 2, 3
  )
  select jsonb_build_object(
    'tables_total',            (select count(*) from rel),
    'tables_rls_enabled',      (select count(*) from rel where relrowsecurity),
    'tables_force_rls',        (select count(*) from rel where relforcerowsecurity),
    'policies_total',          (select count(*) from pg_policies where schemaname = 'public'),
    'primary_keys_total',      (select count(*) from pg_constraint k join rel r on r.oid = k.conrelid where k.contype = 'p'),
    'unique_total',            (select count(*) from pg_constraint k join rel r on r.oid = k.conrelid where k.contype = 'u'),
    'foreign_keys_total',      (select count(*) from pg_constraint k join rel r on r.oid = k.conrelid where k.contype = 'f'),
    'check_total',             (select count(*) from pg_constraint k join rel r on r.oid = k.conrelid where k.contype = 'c'),
    'indexes_total',           (select count(*) from pg_indexes where schemaname = 'public'),
    'triggers_total',          (select count(*) from pg_trigger t join rel r on r.oid = t.tgrelid where not t.tgisinternal),
    'schema_usage', jsonb_build_object(
      'anon',          has_schema_privilege('anon', 'public', 'USAGE'),
      'authenticated', has_schema_privilege('authenticated', 'public', 'USAGE'),
      'service_role',  has_schema_privilege('service_role', 'public', 'USAGE')
    ),
    -- NULL when schema `private` is absent: the subquery returns no rows rather than
    -- has_schema_privilege() raising 3F000 on a database that never had the schema.
    'private_schema_usage', (
      select jsonb_build_object(
        'anon',          has_schema_privilege('anon',          n.oid, 'USAGE'),
        'authenticated', has_schema_privilege('authenticated', n.oid, 'USAGE'),
        'service_role',  has_schema_privilege('service_role',  n.oid, 'USAGE')
      )
      from pg_namespace n
      where n.nspname = 'private'
    ),
    -- How much RLS actually depends on reaching `private`. Matching on the rendered policy
    -- expression is deliberately broad — ANY reference to a private-schema object needs
    -- USAGE, not just the phx_* helpers — and it is what keeps the check an invariant
    -- rather than a snapshot: no policies, no demand, no allowlist to maintain.
    'policies_using_private_schema', (
      select count(*)
      from pg_policies
      where schemaname = 'public'
        and (coalesce(qual, '') like '%private.%' or coalesce(with_check, '') like '%private.%')
    ),
    'tables_exposed_without_rls',
      coalesce((select jsonb_agg(relname order by relname) from reachable
                 where browser_reachable and not relrowsecurity), '[]'::jsonb),
    'tables_rls_disabled',
      coalesce((select jsonb_agg(relname order by relname) from rel
                 where not relrowsecurity), '[]'::jsonb),
    'tables_without_primary_key',
      coalesce((select jsonb_agg(relname order by relname) from rel r
                 where not exists (select 1 from pg_constraint k
                                    where k.conrelid = r.oid and k.contype = 'p')), '[]'::jsonb),
    'tables_rls_enabled_without_policy',
      coalesce((select jsonb_agg(relname order by relname) from rel r
                 where r.relrowsecurity
                   and not exists (select 1 from pg_policies p
                                    where p.schemaname = 'public' and p.tablename = r.relname)), '[]'::jsonb),
    'default_acl_leaks',
      coalesce((select jsonb_agg(jsonb_build_object(
                          'granting_role', granting_role,
                          'obj_type',      obj_type,
                          'grantee',       grantee,
                          'privs',         privs)
                        order by granting_role, obj_type, grantee)
                from default_acl), '[]'::jsonb)
  );
$function$;

-- Re-assert the grants. CREATE OR REPLACE preserves the existing ACL, so these are no-ops
-- today; they are here so a rebuild from migrations alone lands in the same place, and so a
-- future reader does not have to go looking for where the function got locked down.
revoke all on function public.phx_ci_schema_shape() from public;
revoke all on function public.phx_ci_schema_shape() from anon;
revoke all on function public.phx_ci_schema_shape() from authenticated;
grant execute on function public.phx_ci_schema_shape() to service_role;

notify pgrst, 'reload schema';
