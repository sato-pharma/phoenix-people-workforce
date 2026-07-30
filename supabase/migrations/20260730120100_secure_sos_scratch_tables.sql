begin;

-- The 2026-07-28/29 Source-of-Sales brick merge / rescue / area-fix work left 33 ad-hoc tables
-- behind in `public`. Every one of them had RLS off AND SELECT granted to `anon` — and `public`
-- is the schema PostgREST exposes, so all 33 were readable over the internet with the publishable
-- anon key that ships to every browser. Verified live before writing this migration:
--
--   GET /rest/v1/_import_snapshot_dupmerge_20260728  -> HTTP 206, Content-Range 0-0/3909
--   GET /rest/v1/_full_brick_master                  -> HTTP 206, Content-Range 0-0/781
--
-- That is customer -> brick mapping and raw invoice-line data (client names, addresses, values).
--
-- Classified by column shape, not by name:
--   * 20 tables are the genuine undo trail for those merges — row-for-row copies of
--     source_of_sales_import_rows / _bricks / _customer_map, plus the dead_id -> keep_id merge
--     maps you would need to reverse a merge. These MOVE to a private schema, matching the
--     posture already used by sos_backup_20260728 / sos_mapping_backup_20260728 /
--     sos_master_backup_20260728 (all anon+authenticated USAGE = false).
--   * 13 tables are derived working sets — candidate lists, count rollups, review scratch — all
--     reproducible by re-querying the live tables, and none referenced by any code
--     (grepped: no src/ or app/ reference to any of them). These are DROPPED.
--
-- Guarded with to_regclass throughout so the migration is a no-op on staging, where none of
-- these tables were ever created.

create schema if not exists sos_merge_undo_20260728;

comment on schema sos_merge_undo_20260728 is
  'Undo trail for the 2026-07-28/29 Source-of-Sales brick merge, rescue and area-fix operations. '
  'Private: never granted to anon/authenticated, never exposed via PostgREST. '
  'See supabase/migrations/20260730120100_secure_sos_scratch_tables.sql.';

-- Deny by default, and make sure a future default-privilege grant on this schema cannot
-- silently re-expose it the way the public-schema default ACL did.
revoke all on schema sos_merge_undo_20260728 from public, anon, authenticated;

do $$
declare
  keep_tables text[] := array[
    -- full row-for-row copies of source_of_sales_import_rows
    '_import_snapshot_ownerlist_20260728',
    '_import_snapshot_dupmerge_20260728',
    '_import_snapshot_dupmerge2_20260728',
    '_import_snapshot_areafix_20260728',
    '_import_snapshot_rescue_20260728',
    '_import_snapshot_rescue2_20260728',
    '_feb_map_fix_snapshot_20260729',
    -- full row-for-row copies of source_of_sales_customer_map
    '_cmap_snapshot_ownerlist_20260728',
    '_cmap_snapshot_areafix_20260728',
    -- full row-for-row copies of source_of_sales_bricks (retired / deleted rows)
    '_bricks_snapshot_retire_20260728',
    '_bricks_deleted_20260728',
    '_bricks_deleted_dup3_20260728',
    '_bricks_deleted_dup3b_20260728',
    -- dead_id -> keep_id merge maps: without these a merge cannot be reversed
    '_dupmerge_plan_20260728',
    '_dupmerge2_plan',
    '_dup3_plan',
    '_dup3b_plan',
    '_rescue_plan',
    '_rescue2',
    '_dup_stranded'
  ];
  drop_tables text[] := array[
    -- derived brick listings with customer/unit counts — re-derivable from source_of_sales_bricks
    '_allbk', '_bk', '_brickkey', '_old_bricks', '_full_brick_master',
    -- duplicate/near-miss candidate lists — inputs to the *_plan maps that are kept above
    '_dup3', '_dup_fuzzy2', '_bricks_to_delete',
    -- one-off analysis and review scratch
    '_upload_oldbricks', '_missing_places', '_samename_review', '_samename_review2',
    '_areafix_batches'
  ];
  t text;
begin
  foreach t in array keep_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I set schema sos_merge_undo_20260728', t);
      -- SET SCHEMA carries the old ACL across, so strip the inherited anon/authenticated grants.
      execute format('revoke all on table sos_merge_undo_20260728.%I from public, anon, authenticated', t);
    end if;
  end loop;

  foreach t in array drop_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop table public.%I', t);
    end if;
  end loop;
end
$$;

commit;
