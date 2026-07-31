-- CI infrastructure: expose the SHAPE of the public schema so a scheduled job can
-- assert it, the way 20260720000000 exposed migration bookkeeping.
--
-- WHY THIS EXISTS. On 2026-07-31 two staging faults were found that every existing
-- check reported as green:
--
--   1. (2026-07-30) Every grant in staging's `public` schema was removed out of
--      band. Caught only by accident -- the migration drift check happened to need
--      one of the revoked grants and started erroring.
--   2. (2026-07-11) Staging had been restored with only the PRE-data section of a
--      dump. CHECK constraints matched production exactly (492/492) while primary
--      keys were 105/282, foreign keys 0/278, indexes 138/1096, triggers 0/33 and
--      RLS policies 0/359 -- with RLS switched OFF on all 284 tables. It went
--      unnoticed for three weeks, during which every RLS and permission test run
--      against staging was vacuous.
--
-- Fault 2 was invisible to the drift check BY DESIGN: that check compares migration
-- bookkeeping, and staging's `schema_migrations` was fully populated the whole time.
-- A database can have a perfect migration history and no constraints, no indexes and
-- no row-level security whatsoever. Nothing in this repo asserted otherwise.
--
-- WHAT THIS RETURNS is deliberately shape, not data: counts and object NAMES, no row
-- contents. The dangerous combination it exists to surface is
-- `tables_exposed_without_rls` -- a table that anon or authenticated can read while
-- RLS is disabled on it. Grants are only ever safe because RLS bounds them; that
-- pairing is the actual security boundary, and it is exactly what was untrue on
-- staging between 2026-07-11 and 2026-07-31.
--
-- SECURITY INVOKER, not DEFINER -- same reasoning as phx_ci_migration_versions: this
-- repo has hit the "new SECURITY DEFINER function accidentally executable by
-- anon/authenticated" leak class repeatedly (20260719160500/170000/190000), and
-- INVOKER sidesteps the category entirely. Every catalog this reads is world-readable
-- in Postgres, so INVOKER is sufficient; the grant below is what limits the caller.

begin;

create or replace function public.phx_ci_schema_shape()
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_catalog'
as $function$
  with rel as (
    select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  ),
  reachable as (
    -- "Reachable" = a browser-facing role holds ANY table privilege. Deliberately not
    -- SELECT-only: INSERT/UPDATE/DELETE on an unprotected table is just as much a hole.
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
    -- THE ONE THAT MATTERS: reachable by a browser-facing role with RLS off.
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
                                    where p.schemaname = 'public' and p.tablename = r.relname)), '[]'::jsonb)
  );
$function$;

comment on function public.phx_ci_schema_shape() is
  'Read-only shape of the public schema (counts + object names, never row data) for the scheduled schema-drift monitor. See scripts/check-schema-shape.ts.';

revoke all on function public.phx_ci_schema_shape() from public;
revoke all on function public.phx_ci_schema_shape() from anon;
revoke all on function public.phx_ci_schema_shape() from authenticated;
grant execute on function public.phx_ci_schema_shape() to service_role;

notify pgrst, 'reload schema';

commit;
