-- Permanent root-cause hardening for the "anon can EXECUTE new public functions" class of leak.
--
-- Root cause (confirmed live via pg_proc.proacl on both staging cifwmndunmlxjhyjugxa and production
-- ozucdzovmcqvepbozvqf): a newly created function in `public` inherits the built-in PostgreSQL default
-- grant of EXECUTE to PUBLIC (the `=X/postgres` ACL entry). Because every login role is a member of
-- PUBLIC, that makes each new SECURITY DEFINER function callable by the anonymous public key unless a
-- migration explicitly revokes it — which is exactly how the orphaned analytics_* overloads leaked
-- (see 20260719160500). Prior hardening passes revoked EXECUTE on specific functions but never changed
-- the default, so the hole reopened for every function added afterward.
--
-- This flips the default to deny-by-default: future functions in `public` created by the migration
-- role will NOT grant EXECUTE to PUBLIC/anon/authenticated — a caller must be granted explicitly
-- (service_role keeps its own default grant, so the app's service-role access is unaffected). It is
-- SAFE to apply: ALTER DEFAULT PRIVILEGES only affects objects created AFTER it runs, so nothing
-- currently working can break. This app uses application-managed auth (not Supabase Auth) and reaches
-- the DB via the service-role admin client for privileged work and the anon key only for RLS-scoped
-- TABLE reads — it does not rely on PUBLIC/anon EXECUTE on SECURITY DEFINER functions.
--
-- Defensive body: the migration role (postgres) owns the functions that leaked, so altering ITS
-- default is the operative fix and will succeed. The FOR ROLE supabase_admin attempt is best-effort
-- (the migration role may lack privilege to alter a platform role's defaults, and Supabase may
-- re-manage platform defaults); a failure there logs a notice and the migration still succeeds. The
-- RELIABLE, in-repo guarantee against recurrence is the CI test
-- tests/migrations-secdef-revoke-guard.test.ts (every migration that creates a public SECURITY DEFINER
-- function must also REVOKE EXECUTE from PUBLIC) — this migration is the database-side defense on top.
--
-- Verify after applying (staging then production): re-create a throwaway public function and confirm
-- its proacl has no `=X` (PUBLIC) entry, or simply re-run mcp__Supabase__get_advisors (security) after
-- the next function-creating migration and confirm no new anon_security_definer_function_executable
-- findings appear.

-- 1) The current migration role's own default — the operative fix (functions created by migrations
--    are owned by this role). Revoke from PUBLIC (the built-in default grantee) + the two API roles.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 2) Best-effort for the platform roles that can also own public objects; must not fail the migration.
do $$
declare
  r text;
begin
  foreach r in array array['supabase_admin', 'postgres']
  loop
    begin
      execute format(
        'alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated;',
        r
      );
      raise notice 'hardened default EXECUTE privileges for role % in schema public', r;
    exception when insufficient_privilege or others then
      raise notice 'could not alter default privileges for role % (%): relying on explicit revokes + CI guard', r, sqlerrm;
    end;
  end loop;
end $$;
