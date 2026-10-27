-- move_20261026_backup_tables_out_of_public
--
-- WHAT THIS CHANGES: moves the 3 backup / pre-image tables taken in `public` on 26 Oct 2026
--   into 2 dated backup schemas, keeping each table's name, rows, RLS state and grants.
--   `alter table ... set schema` relocates the table; no row is read, rewritten or deleted.
--     public.majed_owais_brick_move_backup_20261026          -> brick_move_backup_20261026
--     public.phoenix_crm_photo_point_backup_20261026_places  -> phoenix_crm_backup_20261026
--     public.phoenix_crm_photo_point_backup_20261026_visits  -> phoenix_crm_backup_20261026
--   Measured on production before writing (27 Oct 2026, ~23:55 Cairo): about 1,520 rows in all,
--   none readable by anon or authenticated, and no view, foreign key or other constraint naming
--   any of them. The one code mention (docs/agents-owner-rules.md) is prose naming the pre-image.
-- WHY: these 3 tables are the whole of the `snapshot_table_in_public` error that has failed the
--   daily Migration Drift Check on production since 23 Oct 2026. docs/security/
--   backup-table-placement.md: a snapshot goes in its own dated schema, never in public, and
--   the retention sweep (scripts/audit-backup-schemas.mjs) ages it by that schema's date.
--   The two photo-point tables have row security on and no policy, so they stay in the
--   `rls_enabled_no_policy` count (phx_ci_advisor_counts reads every non-managed schema) until
--   their schema retires; scripts/advisor-baseline.json records that, dated 2026-10-27.
-- STAGING: none of these tables exists there, so every move is skipped by the to_regclass guard
--   and the migration is a no-op on staging (no schema is created either).
-- ROLLBACK: per table, `alter table <schema>.<name> set schema public;` then
--   `drop schema <schema>;` once it is empty. Nothing is lost either way.
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
      ('majed_owais_brick_move_backup_20261026', 'brick_move_backup_20261026'),
      ('phoenix_crm_photo_point_backup_20261026_places', 'phoenix_crm_backup_20261026'),
      ('phoenix_crm_photo_point_backup_20261026_visits', 'phoenix_crm_backup_20261026')
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

-- Timestamp 20261027235603 was minted to sort after every migration already on main.
