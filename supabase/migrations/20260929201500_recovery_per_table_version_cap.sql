-- Give each protected table its own version cap, because one of them is 200x heavier than the rest.
--
-- MEASURED ON THE FIRST REAL RUN, 2026-09-29. Snapshot payload per table:
--
--     public.monthly_closing_locks           28 rows   13 MB     <- 80% of the whole store
--     au.monthly_targets                  4,333 rows   1,525 kB
--     public.salary_records                 896 rows     877 kB
--     public.employees                      199 rows     422 kB
--     public.monthly_closing_publications     6 rows      73 kB
--     au.line_area_map                      171 rows      57 kB
--     public.salary_batches                   8 rows   4,540 bytes
--
-- monthly_closing_locks carries `snapshot_breakdown jsonb` — a full closing breakdown per lock
-- row. On disk it TOASTs down to 1,648 kB; as canonical JSON it expands to 13 MB. A flat 72
-- versions for that table is up to 936 MB on a 2,500 MB database, which would drive the global
-- 512 MB ceiling and start evicting the OTHER tables' history — the cheap, useful history — to
-- make room for one expensive table.
--
-- So the cap becomes per-table. Twelve versions of monthly_closing_locks is ~156 MB worst case
-- and, since a month lock changes a handful of times a month rather than hourly, in practice
-- spans many months. The other six keep 72.
--
-- The column is added rather than the value hardcoded, so the next heavy table is a registry
-- edit and not a function rewrite.

alter table recovery.protected_tables
  add column if not exists max_versions integer not null default 72;

comment on column recovery.protected_tables.max_versions is
  'How many changed versions to keep for this table before the daily-marker rule takes over. '
  'Lower it for a table with a large payload: measured 2026-09-29, monthly_closing_locks is '
  '13 MB per version against 4,540 bytes for salary_batches.';

update recovery.protected_tables
set max_versions = 12,
    note = coalesce(note, '') || ' — 13 MB per version (snapshot_breakdown jsonb), so fewer kept'
where source_schema = 'public' and source_table = 'monthly_closing_locks';

-- Honour the per-table cap instead of the flat 72.
create or replace function recovery.purge_snapshots()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_purged integer := 0;
  v_hit    integer;
begin
  -- Rules 1 and 2: keep each table's newest max_versions, plus any daily marker inside 30 days.
  -- Rule 3, the important one: a table's NEWEST row is never deleted, at any age. A table that
  -- has not changed in a year must still be restorable, so a purely time-based purge would drop
  -- the only copy of au.line_area_map, which changes about monthly.
  with ranked as (
    select s.id,
           s.keep_daily,
           s.taken_at,
           row_number() over (
             partition by s.source_schema, s.source_table order by s.taken_at desc) as rn,
           coalesce(pt.max_versions, 72) as cap
    from recovery.table_snapshots s
    left join recovery.protected_tables pt
      on pt.source_schema = s.source_schema and pt.source_table = s.source_table
  )
  delete from recovery.table_snapshots d
  using ranked r
  where d.id = r.id
    and r.rn > greatest(r.cap, 1)
    and not (r.keep_daily and r.taken_at >= now() - interval '30 days');
  get diagnostics v_hit = row_count;
  v_purged := v_purged + v_hit;

  -- Rule 4: a global byte ceiling, so a mis-registered table cannot grow the database without
  -- bound. Oldest first, and still never a table's newest row.
  while pg_total_relation_size('recovery.table_snapshots') > 512 * 1024 * 1024 loop
    with ranked as (
      select s.id,
             s.taken_at,
             row_number() over (
               partition by s.source_schema, s.source_table order by s.taken_at desc) as rn
      from recovery.table_snapshots s
    ),
    victims as (
      select r.id from ranked r where r.rn > 1 order by r.taken_at asc limit 10
    )
    delete from recovery.table_snapshots d using victims v where d.id = v.id;
    get diagnostics v_hit = row_count;
    exit when v_hit = 0;
    v_purged := v_purged + v_hit;
  end loop;

  -- Rule 5: the run log and the restore pre-images keep 90 days.
  delete from recovery.snapshot_runs sr where sr.started_at < now() - interval '90 days';
  get diagnostics v_hit = row_count;
  v_purged := v_purged + v_hit;

  delete from recovery.restore_preimages rp where rp.taken_at < now() - interval '90 days';
  get diagnostics v_hit = row_count;
  v_purged := v_purged + v_hit;

  return v_purged;
end;
$function$;

revoke execute on function recovery.purge_snapshots() from public, anon, authenticated;
