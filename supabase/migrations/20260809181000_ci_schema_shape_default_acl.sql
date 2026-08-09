-- Teach phx_ci_schema_shape() to report schema-wide DEFAULT privileges.
--
-- WHY. The existing `tables_exposed_without_rls` key can only see a table that ALREADY
-- exists and is ALREADY exposed. On 2026-08-06 six ad-hoc backup tables were born readable
-- by anon because the schema-wide default privileges on `public` granted anon everything on
-- every new table. The daily drift check did fire — it named all six as
-- `exposed_without_rls` on 08-06, 08-07 and 08-08 — but only AFTER the tables existed and
-- the data was already reachable. This key reports the loaded gun instead of the shot.
--
-- The whole function body is written out in full rather than patched via
-- pg_get_functiondef(): a catalog-driven rewrite leaves no record in the repo of what it
-- actually replaced, which makes the next drift investigation start from nothing. The body
-- below is the live 2026-08-09 definition plus one new key.
--
-- `default_acl_leaks` returns one row per (granting role, object type, grantee) triple in
-- pg_default_acl for schema `public` where the grantee is a browser-facing role — anon,
-- authenticated, or PUBLIC (grantee 0, which reaches both since they are members of it).
-- ALL granting roles are reported, not just `postgres`: the `supabase_admin` row cannot be
-- altered by the migration runner, so it must stay visible daily rather than be remembered.
-- scripts/check-schema-shape.ts grades postgres-owned leaks as errors and supabase_admin's
-- as a warning.
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
