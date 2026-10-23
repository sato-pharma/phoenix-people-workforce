-- move_october_10_preimages_out_of_public
--
-- WHAT THIS CHANGES: moves the last 5 dated pre-image tables left in `public` on production into
--   three dated backup schemas, keeping every table's name, rows and grants. `alter table ... set
--   schema` relocates the table; no row is read, rewritten or deleted. Measured on production
--   before applying (23 Oct 2026, ~02:50 Cairo): 249 rows in all (sos_map_unmap 85, sos_map 60,
--   ez_sep 49, railways_sep 49, ez_sep_roster 6), none readable by anon or authenticated, and no
--   view, foreign key, function body, policy or pg_cron job naming any of them.
-- WHY: after 20261023023133 these 5 were the whole of the `missing_primary_key` error the daily
--   Migration Drift Check raises on production. The `_preimage_` naming slips past
--   phx_ci_snapshot_tables_in_public(), so 20261023023133's list of 70 did not include them.
-- STAGING: guarded by to_regclass, so any table that does not exist there is skipped.
-- ROLLBACK: per table, `alter table <schema>.<name> set schema public;`. Nothing is lost.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

do $$
declare
  m record;
begin
  for m in
    select * from (values
      ('sos_map_unmap_preimage_20261010', 'sos_backup_20261010'),
      ('sos_map_preimage_20261010', 'sos_backup_20261010'),
      ('railways_sep_preimage_20261010', 'railways_backup_20261010'),
      ('ez_sep_preimage_20261010', 'ez_backup_20261010'),
      ('ez_sep_roster_preimage_20261010', 'ez_backup_20261010')
    ) as v(tbl, sch)
  loop
    if to_regclass(format('public.%I', m.tbl)) is null then
      continue;
    end if;
    execute format('create schema if not exists %I', m.sch);
    execute format('revoke all on schema %I from public, anon, authenticated', m.sch);
    execute format('alter table public.%I set schema %I', m.tbl, m.sch);
  end loop;
end
$$;

commit;

-- Timestamp 20261023023603 was minted to sort after every migration already on main.
