-- Give the 6 zz_backup_* ad-hoc backup tables on PRODUCTION a primary key.
--
-- WHY. The schema-shape leg of .github/workflows/migration-drift-check.yml raises
-- `missing_primary_key` at severity "error" (scripts/check-schema-shape.ts), and these 6 are the
-- entire content of that error as of 2026-08-27. They are pre-repair snapshots from three recent
-- sessions -- the 2026-08-24 CV-import identity-overwrite fix (4 ATS tables), the 2026-08-26 EZ
-- distributor crediting work (`sos_dpr_ez`), and the 2026-08-27 weekly branch-map name/code-swap
-- fix (`is_stock_branch_map`) -- and may be the only copy of the pre-fix state each holds. Nothing
-- here drops, truncates, or rewrites a row.
--
-- SAME SHAPE AS 20260823130000_zz_backup_tables_primary_keys.sql, which the owner resolved by
-- adding natural keys in place rather than relocating the tables out of `public`. This migration
-- follows that precedent rather than the older 20260805204502_move_adhoc_snapshots_out_of_public
-- pattern, because that older pattern was written for tables that anon could actually read -- these
-- are not. Checked before writing this: all 6 carry relacl {postgres, service_role}. No anon, no
-- authenticated -- confirmed both by reading pg_class.relacl directly and by testing
-- `set local role anon` / `set local role authenticated` against every one of them, which returned
-- `permission denied` on all 6, not rows. NOT a repeat of the 2026-08-01 incident.
--
-- WHY A NATURAL KEY AND NOT A SURROGATE. Same reasoning as the precedent: these exist to be
-- restored, typically `insert into <target> select * from zz_backup_...`, and an added identity
-- column would silently break that. All 6 already carry an `id` column that is unique and fully
-- populated, verified by counting before any DDL ran:
--
--   zz_backup_ats_candidate_cv_extractions_20260824   id (uuid)     15 rows, 15 non-null, 15 distinct
--   zz_backup_ats_candidates_20260824                 id (uuid)      7 rows,  7 non-null,  7 distinct
--   zz_backup_ats_cv_intake_events_20260824           id (uuid)     18 rows, 18 non-null, 18 distinct
--   zz_backup_ats_files_20260824                      id (uuid)     18 rows, 18 non-null, 18 distinct
--   zz_backup_sos_dpr_ez_20260826                     id (bigint)  802 rows, 802 non-null, 802 distinct
--   zz_backup_is_stock_branch_map_20260827            id (uuid)     26 rows, 26 non-null, 26 distinct
--
-- The only change beyond the constraint is the implicit SET NOT NULL that ADD PRIMARY KEY applies
-- to `id`. Every one is already fully populated, so no row changes and no default is invented.
-- 886 rows total: the ACCESS EXCLUSIVE lock is measured in milliseconds.
--
-- GUARDED, because these tables exist on PRODUCTION ONLY -- none of the 6 were created by a
-- committed migration (git grep and app-code grep both return nothing for all 6 names), so an
-- unconditional ALTER TABLE would fail on staging and any fresh environment with 42P01 and take
-- the whole migration down. It is also idempotent: a table that already has a primary key is left
-- exactly as it is, never re-keyed.
--
-- ROLLBACK: alter table public.<name> drop constraint <name>_pkey;  (per table, no data effect.)

do $$
declare
  target record;
  rel     regclass;
begin
  for target in
    select * from (values
      ('zz_backup_ats_candidate_cv_extractions_20260824', 'id'),
      ('zz_backup_ats_candidates_20260824',                'id'),
      ('zz_backup_ats_cv_intake_events_20260824',          'id'),
      ('zz_backup_ats_files_20260824',                     'id'),
      ('zz_backup_sos_dpr_ez_20260826',                    'id'),
      ('zz_backup_is_stock_branch_map_20260827',           'id')
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
