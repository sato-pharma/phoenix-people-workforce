-- Give the 8 zz_* ad-hoc backup tables on PRODUCTION a primary key.
--
-- WHY. The schema-shape leg of .github/workflows/migration-drift-check.yml raises
-- `missing_primary_key` at severity "error" (scripts/check-schema-shape.ts), and these 8 were the
-- entire content of that error. The workflow had been red on every scheduled run since
-- 2026-08-11; the migration-drift leg was cleared on 2026-08-23 (#2328, #2330) and this is the
-- other half. Owner decision, same day: KEEP ALL EIGHT, add the keys. They are pre-surgery
-- snapshots from the 2026-08-19 area/marketing work and the 2026-08-15 weekly backup, and may be
-- the only copy of the state they hold — so nothing here drops, truncates, or rewrites a row.
--
-- NOT a repeat of the 2026-08-01 incident, which is what a red schema-shape leg meant last time
-- (three backup tables readable AND deletable by the public anon key — see
-- 20260804..._secure_adhoc_backup_tables_enable_rls). Checked before writing this: all 8 carry
-- relacl {postgres, service_role}. No anon, no authenticated. The safe pattern held.
--
-- WHY A NATURAL KEY AND NOT A SURROGATE. Every column in all 8 tables is nullable — they were
-- built by CREATE TABLE AS SELECT, which copies types and nothing else. The tempting fix is to
-- add an identity column, and it would be WRONG: these exist to be restored, and a restore is
-- typically `insert into <target> select * from zz_...`. An extra leading column silently breaks
-- that. Each table already carried a column that is unique and fully populated, verified by
-- counting before any DDL ran:
--
--   zz_area_assign_2026_08_19               id (uuid)     31 rows, 31 non-null, 31 distinct
--   zz_area_options_2026_08_19              area_id       39 rows, 39 non-null, 39 distinct
--   zz_backup_weekly_ignore_rows_20260815   id (bigint)  470 rows, 470 non-null, 470 distinct
--   zz_rollback_ambiguous_codes_2026_08_19  id (uuid)     17 rows, 17 non-null, 17 distinct
--   zz_rollback_flagged_areas_2026_08_19    id (uuid)      2 rows, 2 non-null, 2 distinct
--   zz_rollback_region_areas_2026_08_19     id (uuid)     18 rows, 18 non-null, 18 distinct
--   zz_rollback_resolver_2026_08_19         signature      1 row, 1 non-null, 1 distinct
--   zz_rollback_unowned_areas_2026_08_19    id (uuid)     31 rows, 31 non-null, 31 distinct
--
-- The only change beyond the constraint is the implicit SET NOT NULL that ADD PRIMARY KEY applies
-- to the key column. Every one of those columns is already fully populated, so no row changes and
-- no default is invented. 609 rows total: the ACCESS EXCLUSIVE lock is measured in milliseconds.
--
-- GUARDED, because these tables exist on PRODUCTION ONLY. Staging (cifwmndunmlxjhyjugxa) has zero
-- zz_* tables — confirmed live before writing this — so an unconditional ALTER TABLE would fail
-- there with 42P01 and take the whole migration down. It is also idempotent: a table that already
-- has a primary key is left exactly as it is, never re-keyed.
--
-- ROLLBACK: alter table public.<name> drop constraint <name>_pkey;  (per table, no data effect.)

do $$
declare
  target record;
  rel     regclass;
begin
  for target in
    select * from (values
      ('zz_area_assign_2026_08_19',              'id'),
      ('zz_area_options_2026_08_19',             'area_id'),
      ('zz_backup_weekly_ignore_rows_20260815',  'id'),
      ('zz_rollback_ambiguous_codes_2026_08_19', 'id'),
      ('zz_rollback_flagged_areas_2026_08_19',   'id'),
      ('zz_rollback_region_areas_2026_08_19',    'id'),
      ('zz_rollback_resolver_2026_08_19',        'signature'),
      ('zz_rollback_unowned_areas_2026_08_19',   'id')
    ) as t(tbl, col)
  loop
    rel := to_regclass('public.' || quote_ident(target.tbl));

    -- Absent: every environment except production. Nothing to key.
    if rel is null then
      raise notice 'zz-pk: public.% absent, skipped', target.tbl;
      continue;
    end if;

    -- Already keyed: leave whatever is there alone rather than assuming this file owns it.
    if exists (select 1 from pg_constraint k where k.conrelid = rel and k.contype = 'p') then
      raise notice 'zz-pk: public.% already has a primary key, skipped', target.tbl;
      continue;
    end if;

    execute format(
      'alter table public.%I add constraint %I primary key (%I)',
      target.tbl, target.tbl || '_pkey', target.col
    );
    raise notice 'zz-pk: public.% keyed on (%)', target.tbl, target.col;
  end loop;
end
$$;
