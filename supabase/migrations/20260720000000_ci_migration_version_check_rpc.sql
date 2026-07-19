-- Permanent CI check infrastructure: closes the "migration merged but never applied"
-- gap found 2026-07-19 (3 migrations sat unapplied for up to a week, two causing real
-- production bugs, before a manual audit caught it). This RPC lets a scheduled CI job
-- compare the repo's supabase/migrations/*.sql filenames against what's actually
-- recorded as applied, without needing a new raw-Postgres credential in CI.
--
-- service_role does NOT have direct access to the supabase_migrations schema by
-- default (verified live: has_schema_privilege('service_role','supabase_migrations',
-- 'USAGE') = false, has_table_privilege(...,'schema_migrations','SELECT') = false) —
-- so this grants it explicit, narrow SELECT on just the migration-history bookkeeping
-- table (schema evolution metadata, not business/user data; service_role already has
-- broad access to everything else in this database by design) and wraps it in a
-- SECURITY INVOKER function. INVOKER, not DEFINER: this repo has hit the "new
-- SECURITY DEFINER function accidentally executable by anon/authenticated" leak class
-- three times in the last week (20260719160500/170000/190000) — INVOKER sidesteps
-- that whole risk category since the function only ever runs with the CALLING role's
-- own privileges, which only service_role (via the explicit grant below) actually has.

begin;

grant usage on schema supabase_migrations to service_role;
grant select on supabase_migrations.schema_migrations to service_role;

create or replace function public.phx_ci_migration_versions()
returns table (version text, name text)
language sql
stable
security invoker
set search_path to 'public', 'supabase_migrations'
as $function$
  select version::text, name::text from supabase_migrations.schema_migrations order by version;
$function$;

revoke all on function public.phx_ci_migration_versions() from public;
revoke all on function public.phx_ci_migration_versions() from anon;
revoke all on function public.phx_ci_migration_versions() from authenticated;
grant execute on function public.phx_ci_migration_versions() to service_role;

notify pgrst, 'reload schema';

commit;
