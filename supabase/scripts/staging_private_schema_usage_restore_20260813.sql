-- =============================================================================
-- STAGING REPAIR — restore USAGE on schema `private` to authenticated + service_role
-- =============================================================================
-- Target:  STAGING ONLY  (cifwmndunmlxjhyjugxa / Phoenix-HR-Staging)
-- Author:  generated 2026-08-13 by reading PRODUCTION's live catalog read-only.
-- Status:  idempotent, self-guarding, GRANT-only. Safe to re-run.
--
-- -----------------------------------------------------------------------------
-- WHAT IS WRONG
-- -----------------------------------------------------------------------------
-- Staging's `private` schema has NO grants at all — pg_namespace.nspacl is NULL,
-- i.e. owner-only. Production has:
--
--   production  nspacl = postgres=UC/postgres | authenticated=U/postgres
--                        | service_role=U/postgres
--   staging     nspacl = NULL   (owner only)
--
--   has_schema_privilege(..., 'private', 'USAGE')   production   staging
--     authenticated                                    TRUE       FALSE
--     service_role                                     TRUE       FALSE
--     anon                                             FALSE      FALSE   (correct on both)
--
-- EXECUTE on the individual helpers is intact on staging — phx_current_hr_id,
-- phx_visible_hr_ids, phx_resigned_hr_ids, phx_has_company_access,
-- phx_can_manage_payroll and phx_can_manage_outstation all report
-- has_function_privilege('authenticated', …, 'EXECUTE') = true. That is what makes
-- this gap so quiet: the grants that a reviewer thinks to check are all present.
-- Without USAGE on the CONTAINING SCHEMA, though, the call raises 42501
-- "permission denied for schema private" before the function is ever reached.
--
-- -----------------------------------------------------------------------------
-- WHY IT MATTERS
-- -----------------------------------------------------------------------------
-- 67 RLS policies across 19 tables in `public` are built on private.phx_* helpers.
-- On staging, impersonating `authenticated` to exercise ANY of them fails
-- immediately with a permission error, so no RLS policy that uses a private helper
-- can be meaningfully tested there. Staging looks testable and is not — the same
-- class of false-green as the ledger row in PR #2058 and the pre-data-only restore
-- described in the header of .github/workflows/migration-drift-check.yml.
--
-- -----------------------------------------------------------------------------
-- WHY NOT A MIGRATION
-- -----------------------------------------------------------------------------
-- The grant is ALREADY in migration history and always has been:
--
--   supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql:39245
--     GRANT USAGE ON SCHEMA private TO authenticated;
--   …:39246
--     GRANT USAGE ON SCHEMA private TO service_role;
--
-- and before the baseline squash, in the archived
-- _migrations_archive/pre-baseline-2026-07-11/20260512235948_leave_management_engine.sql
-- and …/20260531120234_close_local_rls_advisory_tables.sql.
--
-- Staging has version 20260711135352 RECORDED in supabase_migrations.schema_migrations
-- and does not have its effect. This is therefore a DRIFT REPAIR, not a missing
-- migration: it is the 2026-07-11 restore that applied only the pre-data section of a
-- dump, the same event that left staging with 0 RLS policies and 0 foreign keys. A new
-- forward migration would be redundant on any database rebuilt from history and would
-- freeze one day's grant snapshot into permanent schema history — the reasoning already
-- recorded in staging_public_grants_restore_20260731.sql, which repaired the `public`
-- half of this same damage and did not cover `private`.
--
-- Detection, unlike repair, DOES belong in migrations: see
-- 20260813120000_ci_schema_shape_private_usage.sql, which teaches phx_ci_schema_shape()
-- to report this so the daily check fails instead of a human noticing a year later.
--
-- -----------------------------------------------------------------------------
-- SAFETY
-- -----------------------------------------------------------------------------
--  * GRANT-only. Nothing is revoked or dropped; re-running changes nothing.
--  * Self-guarding. The block below ABORTS if `authenticated` already has USAGE on
--    `private` — so on a healthy database (production) this is a no-op that REFUSES
--    to run. It cannot widen access anywhere that is not already broken.
--  * `anon` is deliberately NOT granted. Production does not grant it and neither
--    does this. Staging's NULL nspacl already denies anon; that stays true.
--  * A schema grant is permission to REACH an object. RLS still decides which rows
--    are visible — restoring this weakens no policy. It makes the policies that are
--    already written start being enforced against a role that can reach them at all.
--
-- Apply with:
--   node scripts/apply-sql-file.mjs \
--     supabase/staging_private_schema_usage_restore_20260813.sql staging
-- =============================================================================

begin;

-- --- Guard: refuse to run against a database that is not damaged --------------
do $$
begin
  if has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception
      'REFUSING TO RUN: authenticated already has USAGE on schema private, so this '
      'database is not the damaged one. This repair is for the STAGING project '
      '(cifwmndunmlxjhyjugxa) only. Nothing has been changed.';
  end if;
end
$$;

-- --- Restore production's nspacl ---------------------------------------------
grant usage on schema private to authenticated;
grant usage on schema private to service_role;

commit;

-- =============================================================================
-- VERIFY (read-only; run after the commit above)
-- =============================================================================
-- Expected on STAGING afterwards, identical to production:
--   anon = false, authenticated = true, service_role = true
--
--   select has_schema_privilege('anon',          'private', 'USAGE') as anon,
--          has_schema_privilege('authenticated', 'private', 'USAGE') as authenticated,
--          has_schema_privilege('service_role',  'private', 'USAGE') as service_role,
--          (select array_to_string(nspacl, E'\n') from pg_namespace where nspname = 'private') as nspacl;
--
-- And the test that actually matters — a private helper reached AS `authenticated`.
-- NOTE the setting name: private.phx_current_hr_id() reads
-- current_setting('request.jwt.claim.hr_id') — SINGULAR `claim`, a flat setting.
-- Setting the plural JSON `request.jwt.claims` resolves to nobody, every query returns
-- zero rows, and any comparison passes vacuously. Assert the identity RESOLVED and that
-- a real subject sees a NON-ZERO row count:
--
--   begin;
--     select set_config('request.jwt.claim.hr_id', '<a real, active hr_id>', true);
--     set local role authenticated;
--     select private.phx_current_hr_id() as resolved;              -- must be non-null
--     select count(*) from public.employees;                        -- must be > 0
--   rollback;
-- =============================================================================
