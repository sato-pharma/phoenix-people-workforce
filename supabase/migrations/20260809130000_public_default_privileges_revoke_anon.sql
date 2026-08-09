-- Stop new tables in `public` from being born readable (and truncatable) by the world.
--
-- WHY THIS EXISTS
-- On 2026-08-09 a security audit found six ad-hoc backup tables sitting in `public`
-- with RLS off and FULL privileges granted to `anon` and `authenticated`:
--
--   zz_backup_sos_july_ro001_price_20260806   (508 rows: client_name, client_address,
--   zz_backup_sos_july_ai_direct_20260806      qty, value, discount — commercial
--   zz_backup_sos_july_reunion_20260806        sales data)
--   zz_backup_sos_july_saly_dup_20260806
--   zz_backup_au_ue9_to_ue1_20260806
--   zz_backup_au_direct_alloc_20260806
--
-- Anyone holding the anon key — which ships inside the browser bundle of the public
-- login page — could SELECT them, and TRUNCATE them. Those tables have since been
-- dropped, so this migration does not need to clean them up.
--
-- Nobody granted anything. Postgres did it automatically: `pg_default_acl` for
-- schema `public`, object type `table`, carried
--
--   anon=arwdDxtm  authenticated=arwdDxtm
--
-- i.e. INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on EVERY table created
-- in `public`. Every real application table survives that only because it also has RLS
-- enabled, which fail-closes the grant. An ad-hoc `create table ... as select` during a
-- data repair does not get RLS, so it is fully exposed from the moment it exists.
--
-- Measured immediately before this migration: 301 tables in `public`, all 301 with RLS
-- enabled, but 82 still carrying an anon SELECT+DELETE grant that only RLS is holding
-- shut. This removes the default so the NEXT repair table is safe by construction
-- rather than by remembering.
--
-- SCOPE / BLAST RADIUS
-- This changes only the DEFAULT applied to tables created from now on. It does not
-- revoke anything from any existing table, and it does not touch RLS or policies.
-- `service_role` — which is what this application actually connects as — keeps its own
-- default and is unaffected, as is `postgres`.
--
-- If a FUTURE migration adds a table that genuinely needs direct anon/authenticated
-- access (rare here: visibility is application-scoped through service_role, not RLS),
-- it must now issue an explicit GRANT. That is the intended trade: access becomes
-- something you opt into, not something you forget to remove.
--
-- BOTH GRANTORS MATTER. ALTER DEFAULT PRIVILEGES only affects the role that runs it,
-- and this database has default ACLs registered for `postgres` AND `supabase_admin`.
-- Revoking for one leaves the other's default intact, so both are handled. The
-- supabase_admin leg is wrapped because a managed platform may not grant membership in
-- that role; if it cannot be altered, the postgres leg still closes the path that the
-- SQL editor, migrations and the MCP actually create tables through.
--
-- Rollback: re-grant the defaults, e.g.
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon;

alter default privileges for role postgres in schema public
  revoke all on tables from authenticated;

do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from authenticated';
exception
  when insufficient_privilege then
    raise notice 'supabase_admin default privileges left unchanged (no membership in that role); the postgres default was still revoked';
  when undefined_object then
    raise notice 'role supabase_admin not present; nothing to revoke for it';
end
$$;
