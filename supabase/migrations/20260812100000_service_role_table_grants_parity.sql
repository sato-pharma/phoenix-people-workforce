-- Give `service_role` the table grants two tables never received, so a REBUILT environment can
-- reach them. Idempotent, and a no-op against production.
--
-- WHY THIS EXISTS. Found 2026-08-12 while reconciling staging against production. Two tables in
-- staging's `public` schema carried no `service_role` privilege at all:
--
--   direct_order_pharmacy_validations   relacl = {postgres=arwdDxtm/postgres}
--   monthly_closing_locks               relacl = NULL   (owner-only default)
--
-- against production, where both read {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
-- That was 2 of staging's 301 public tables; production grants service_role on all 303.
--
-- WHY IT MATTERS. The application connects as `service_role` (getSupabaseAdmin()). service_role has
-- rolbypassrls = true on both databases, so RLS was never the blocker — the missing table privilege
-- was. Anyone exercising pharmacy validation or the monthly-closing lock against a rebuilt
-- environment would hit a bare permission error that reads like an application bug.
--
-- WHY THE CREATING MIGRATIONS DID NOT DO THIS. Neither
-- 20260805024500_direct_order_pharmacy_validation.sql nor 20260810140000_monthly_closing_lock.sql
-- grants service_role on its table; both relied on the schema's DEFAULT privileges, which on
-- production hand service_role arwdDxtm and on a fresh project hand out nothing. The companion
-- migration 20260812100100 fixes that default going forward. This one repairs the two tables that
-- were already created under it.
--
-- BLAST RADIUS
--   * Production: NO-OP. Both tables already carry exactly this grant (verified 2026-08-12 against
--     pg_class.relacl, not the migration ledger).
--   * Staging: already applied out-of-band 2026-08-12 and verified; re-running is harmless.
--   * A fresh rebuild: this is the repair.
-- Nothing here touches RLS, any policy, or anon/authenticated. anon and authenticated are
-- deliberately NOT granted — 20260809170000_revoke_inert_anon_grants.sql exists to take exactly
-- that away from this table family, and nothing in the browser queries PostgREST.
--
-- GUARDED because migration order is not guaranteed on a partial rebuild: a table that does not
-- exist yet is skipped with a notice rather than failing the whole run.
--
-- Rollback:
--   revoke all on table public.direct_order_pharmacy_validations from service_role;
--   revoke all on table public.monthly_closing_locks from service_role;

do $$
declare
  target text;
  granted int := 0;
  skipped text[] := '{}';
  targets text[] := array[
    'direct_order_pharmacy_validations',
    'monthly_closing_locks'
  ];
begin
  foreach target in array targets loop
    if to_regclass(format('public.%I', target)) is null then
      skipped := skipped || target;
      continue;
    end if;
    execute format('grant all on table public.%I to service_role', target);
    granted := granted + 1;
  end loop;

  raise notice 'service_role_table_grants_parity: granted on %, skipped % (table absent)',
    granted, coalesce(array_length(skipped, 1), 0);
end
$$;

notify pgrst, 'reload schema';
