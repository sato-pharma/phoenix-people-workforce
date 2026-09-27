-- Move 10 stray point-in-time backup tables out of public
--
-- WHAT THIS CHANGES: no data, no columns, no rows. Ten tables move from `public` into five dated
-- backup schemas, one per domain, following docs/security/backup-table-placement.md — the same
-- pattern the SoS work used on 2026-07-28 (sos_backup_20260728 and its three siblings, 41 tables,
-- none ever exposed). Each new schema has anon/authenticated USAGE revoked, same as that precedent.
--
-- WHY: `pnpm run check:schema-shape` has been failing on PRODUCTION for this reason since at least
-- 2026-09-23 (the drift check catches it nightly, but nothing gates a merge on it — migrations are
-- one of the two things CI never sees, AGENTS.md §7). Two separate errors, same root cause:
--
--   missing_primary_key:      10 tables with no primary key (these ten)
--   snapshot_table_in_public: 7 of them are snapshot-shaped and sitting where PostgREST can reach
--                              them if a grant is ever added — the exact failure mode
--                              docs/security/backup-table-placement.md exists to document.
--
-- None of them is reachable today — checked has_table_privilege('anon', …) and
-- has_table_privilege('authenticated', …) for all ten on production: false, on every one. This is
-- PLACEMENT, not an active exposure, exactly as the drift check's own wording says. But that safety
-- rests on grants staying exactly as they are, and a missing primary key separately blocks any
-- later migration that adds a foreign key referencing one of these tables — the 2026-07-11 fault.
--
-- CHECKED BEFORE MOVING (production): no view, trigger, foreign key or RLS policy depends on any of
-- the ten (pg_depend, deptype in ('n','a'), positive-control-verified against milestone_notice_marks
-- which correctly returned 12; each of these ten returned 0, except one column-default 'a' entry on
-- phx_plan_delete_backup_20260926, which is its own gen_random_uuid()/now() default and moves with
-- the table). No application code references any of the ten names (grepped src/, app/, scripts/,
-- tests/, supabase/). Nothing reads or writes these on staging — the tables do not exist there, so
-- this migration is a clean no-op on cifwmndunmlxjhyjugxa and only production has anything to move.
--
-- WHY FIVE SCHEMAS AND NOT ONE: the doc's own convention is `<domain>_backup_YYYYMMDD` — the date is
-- the expiry note, and lumping five different sessions' work under one artificial umbrella schema
-- would erase which backup belongs to which incident and when each one stops being needed:
--
--   activity_events_dev_preview_backup_20260921   (2 tables — a dev-preview activity feed backup)
--   attendance_map_backup_20260923                (2 tables — attendance device/last-seen map, "_pre")
--   bk_qershaya_backup_20260923                   (3 tables — a brick/geocoding import, "bk_qershaya")
--   phx_plan_delete_backup_20260926               (1 table  — already named as its own backup)
--   wa_backup_20260921                            (2 tables — WhatsApp prompts/screening backup)
--
-- WHY `alter table ... set schema` rather than drop-and-recreate: it is the documented repair
-- (docs/security/backup-table-placement.md), it is a catalog-only operation (no data is read,
-- copied or rewritten), and it takes an ACCESS EXCLUSIVE lock for a moment, not a table rewrite —
-- with a 5s lock_timeout so a genuinely busy table (none of these should be) fails loud rather than
-- queuing behind something.
--
-- NEVER GIVEN A PRIMARY KEY: docs/security/backup-table-placement.md is explicit that a moved
-- snapshot is sealed, not resurrected as a live table — see the "Move it, do not give it a primary
-- key" line the drift check itself prints.
--
-- ROLLBACK (moves every table back to public, in one transaction; drops no schema so nothing here
-- is destroyed if reverted):
--   begin;
--   alter table activity_events_dev_preview_backup_20260921.activity_events_dev_preview_backup_20260921 set schema public;
--   alter table activity_events_dev_preview_backup_20260921.activity_events_dev_preview_backup_20260921_all set schema public;
--   alter table attendance_map_backup_20260923.attendance_map_device48_pre_20260923 set schema public;
--   alter table attendance_map_backup_20260923.attendance_map_last_seen_pre_20260923 set schema public;
--   alter table bk_qershaya_backup_20260923.bk_qershaya_brick_20260923 set schema public;
--   alter table bk_qershaya_backup_20260923.bk_qershaya_imports_20260923 set schema public;
--   alter table bk_qershaya_backup_20260923.bk_qershaya_map_20260923 set schema public;
--   alter table phx_plan_delete_backup_20260926.phx_plan_delete_backup_20260926 set schema public;
--   alter table wa_backup_20260921.wa_prompts_backup_20260921 set schema public;
--   alter table wa_backup_20260921.wa_screening_backup_20260921 set schema public;
--   commit;
--
-- Verification after apply:
--   select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
--     and c.relname in (<the ten names above>);                                          -- 0
--   select schemaname, tablename from pg_tables
--     where tablename in (<the ten names above>) order by 1, 2;                          -- 10 rows,
--                                                                                          -- in the 5 new schemas
--   select has_schema_privilege('anon', s, 'usage'), has_schema_privilege('authenticated', s, 'usage')
--     from unnest(array[
--       'activity_events_dev_preview_backup_20260921','attendance_map_backup_20260923',
--       'bk_qershaya_backup_20260923','phx_plan_delete_backup_20260926','wa_backup_20260921'
--     ]) s;                                                                                -- false, false, x5
--   -- row counts unchanged for every table (compare to the pre-move select count(*) taken before
--   -- applying, which is why this migration reads before it moves — see the DO block below).

begin;
set local lock_timeout = '5s';

do $$
declare
  v_moves jsonb := '[
    {"schema": "activity_events_dev_preview_backup_20260921", "table": "activity_events_dev_preview_backup_20260921"},
    {"schema": "activity_events_dev_preview_backup_20260921", "table": "activity_events_dev_preview_backup_20260921_all"},
    {"schema": "attendance_map_backup_20260923", "table": "attendance_map_device48_pre_20260923"},
    {"schema": "attendance_map_backup_20260923", "table": "attendance_map_last_seen_pre_20260923"},
    {"schema": "bk_qershaya_backup_20260923", "table": "bk_qershaya_brick_20260923"},
    {"schema": "bk_qershaya_backup_20260923", "table": "bk_qershaya_imports_20260923"},
    {"schema": "bk_qershaya_backup_20260923", "table": "bk_qershaya_map_20260923"},
    {"schema": "phx_plan_delete_backup_20260926", "table": "phx_plan_delete_backup_20260926"},
    {"schema": "wa_backup_20260921", "table": "wa_prompts_backup_20260921"},
    {"schema": "wa_backup_20260921", "table": "wa_screening_backup_20260921"}
  ]'::jsonb;
  v_move record;
  v_schema text;
  v_rows_before bigint;
  v_rows_after bigint;
begin
  -- One schema per domain, created up front so every move below has somewhere to land. Idempotent:
  -- a schema left behind by a partial prior run is reused rather than recreated.
  for v_schema in
    select distinct value ->> 'schema' from jsonb_array_elements(v_moves)
  loop
    execute format('create schema if not exists %I', v_schema);
    execute format('revoke all on schema %I from public, anon, authenticated', v_schema);
  end loop;

  for v_move in select value ->> 'schema' as schema, value ->> 'table' as tbl
                from jsonb_array_elements(v_moves)
  loop
    -- Idempotent: if this table is not sitting in public (already moved, or never existed on this
    -- project — staging has none of the ten), skip it rather than erroring.
    if not exists (
      select 1 from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relname = v_move.tbl
        and c.relkind = 'r'
    ) then
      raise notice 'skip %.% — not in public (already moved, or never existed on this project)', v_move.schema, v_move.tbl;
      continue;
    end if;

    execute format('select count(*) from public.%I', v_move.tbl) into v_rows_before;

    execute format('alter table public.%I set schema %I', v_move.tbl, v_move.schema);

    execute format('select count(*) from %I.%I', v_move.schema, v_move.tbl) into v_rows_after;
    if v_rows_after is distinct from v_rows_before then
      raise exception 'row count changed moving %: % -> %', v_move.tbl, v_rows_before, v_rows_after;
    end if;

    raise notice 'moved %.% (% row(s))', v_move.schema, v_move.tbl, v_rows_after;
  end loop;
end;
$$;

commit;
