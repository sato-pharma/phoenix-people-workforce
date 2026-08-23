-- Enable deny-all RLS on the zz_* ad-hoc backup tables on PRODUCTION.
--
-- WHY. Companion to 20260823130000_zz_backup_tables_primary_keys.sql, which cleared the
-- `missing_primary_key` ERROR that had kept the schema-shape leg of migration-drift-check.yml red.
-- This clears the `rls_disabled` WARNING that was left behind on 7 of the 8. Owner instruction,
-- 2026-08-23, immediately after the primary keys landed.
--
-- A warning, not a breach, and the check says so itself: nothing browser-facing can reach these
-- tables today. All 8 carry relacl {postgres, service_role} — no anon, no authenticated. The
-- reason to do it anyway is the sentence the check adds: it "removes the safety net if a grant is
-- ever added". On 2026-08-01 three backup tables created out-of-band had exactly this shape minus
-- the safety net, and anon could SELECT and DELETE all 8 rows in them
-- (20260804..._secure_adhoc_backup_tables_enable_rls). Four OTHER backups from the same day did
-- have RLS on and returned 0 rows to anon. That contrast is the whole argument: the safe pattern
-- was already the norm, and these 7 simply missed it.
--
-- NO POLICY IS CREATED, AND THAT IS THE POINT. RLS enabled with zero policies denies everything to
-- every non-bypassing role — it is the strictest possible state, not an unfinished migration. It
-- will show up in check-schema-shape.ts as `rls_enabled_without_policy` (a WARNING, alongside 76
-- tables already in that state), which is the correct classification.
--
-- VERIFIED SAFE FOR RESTORES BEFORE WRITING THIS. These tables exist to be read back during a
-- rollback, so locking them would defeat their purpose. pg_roles on production:
--
--   postgres        rolbypassrls = true      <- migration runner and table owner
--   service_role    rolbypassrls = true      <- what every app code path actually uses
--   authenticated   rolbypassrls = false
--   anon            rolbypassrls = false
--
-- So this blocks precisely the two browser roles and changes nothing for a restore. Note also that
-- FORCE ROW LEVEL SECURITY is deliberately NOT set: without it, the table owner is exempt too.
--
-- GUARDED and IDEMPOTENT for the same reasons as the primary-key file. These tables exist on
-- PRODUCTION ONLY — staging (cifwmndunmlxjhyjugxa) has zero zz_* tables — so an unconditional
-- ALTER TABLE would fail there with 42P01. A table that already has RLS enabled is skipped, which
-- is why zz_backup_weekly_ignore_rows_20260815 is listed here despite already having it on: the
-- list is the full set of 8, and the guard decides.
--
-- ROLLBACK: alter table public.<name> disable row level security;  (per table, no data effect.)

do $$
declare
  target text;
  rel    regclass;
begin
  foreach target in array array[
    'zz_area_assign_2026_08_19',
    'zz_area_options_2026_08_19',
    'zz_backup_weekly_ignore_rows_20260815',
    'zz_rollback_ambiguous_codes_2026_08_19',
    'zz_rollback_flagged_areas_2026_08_19',
    'zz_rollback_region_areas_2026_08_19',
    'zz_rollback_resolver_2026_08_19',
    'zz_rollback_unowned_areas_2026_08_19'
  ]
  loop
    rel := to_regclass('public.' || quote_ident(target));

    -- Absent: every environment except production. Nothing to secure.
    if rel is null then
      raise notice 'zz-rls: public.% absent, skipped', target;
      continue;
    end if;

    -- Already on: leave it exactly as it is.
    if (select c.relrowsecurity from pg_class c where c.oid = rel) then
      raise notice 'zz-rls: public.% already has RLS enabled, skipped', target;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', target);
    raise notice 'zz-rls: public.% now deny-all (RLS on, no policy)', target;
  end loop;
end
$$;
