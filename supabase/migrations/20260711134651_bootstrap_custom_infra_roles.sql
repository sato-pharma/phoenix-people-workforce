-- Six custom Postgres roles were found to exist on production (metabase, analytics_readonly,
-- analytics_privileged, cli_login_postgres, supabase_etl_admin, supabase_privileged_role) with no
-- corresponding migration file -- created outside the documented pipeline (docs/migrations.md:
-- "Never use the Supabase Dashboard to make schema changes"). This migration makes them
-- reproducible for schema-rebuild purposes. Roles are created NOLOGIN regardless of their real
-- attributes on production; this migration does not grant or alter any login credential. The
-- IF NOT EXISTS guard is a pure no-op everywhere the role already exists (including on production
-- and staging today), so it never touches existing login/password state.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_privileged') THEN
    CREATE ROLE analytics_privileged NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_readonly') THEN
    CREATE ROLE analytics_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cli_login_postgres') THEN
    CREATE ROLE cli_login_postgres NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase') THEN
    CREATE ROLE metabase NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_etl_admin') THEN
    CREATE ROLE supabase_etl_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_privileged_role') THEN
    CREATE ROLE supabase_privileged_role NOLOGIN;
  END IF;
END $$;
