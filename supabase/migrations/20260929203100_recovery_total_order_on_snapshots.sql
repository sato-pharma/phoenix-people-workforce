-- Tie-break every snapshot ordering by id. The "newest survives" guarantee did not hold.
--
-- 🔴 FOUND BY EXERCISING THE PURGE ON A THROWAWAY TABLE, 2026-09-29, BEFORE THIS SHIPPED.
-- Four changed versions of a test table (v1, v2, v3, v4) were captured with max_versions = 2.
-- The purge kept **v1 and v2** — the two OLDEST — and deleted v3 and v4. The live table held v4
-- and the snapshot ranked "newest" reported v1. A restore to "now" would have written the
-- ORIGINAL contents back over the current ones.
--
-- Cause: `taken_at default now()`. In Postgres now() is the TRANSACTION timestamp, so every
-- snapshot taken inside one transaction carries an identical taken_at. `order by taken_at desc`
-- is then a tie, row_number() assigns rn = 1 arbitrarily, and the rule that rn = 1 is never
-- purged silently protects an arbitrary version instead of the newest one.
--
-- Why it was not caught: the hourly cron runs each snapshot in its own transaction, so production
-- timestamps are distinct and the bug is invisible there. It appears the moment two snapshots share
-- a transaction — a manual `select recovery.take_snapshots()` next to the scheduled one, a
-- backfill, or any future caller that loops. The source-pinning test asserted the `rn > cap`
-- SHAPE, which was present and correct the whole time; only running it revealed the ordering
-- underneath was not total.
--
-- Two fixes, deliberately belt-and-braces:
--   1. taken_at defaults to clock_timestamp(), which advances inside a transaction and is also the
--      more truthful record of when the copy was actually taken.
--   2. Every ordering tie-breaks on id, which is a monotonic bigint identity. This is what protects
--      the rows ALREADY stored with tied timestamps, and any caller that sets taken_at explicitly.
--
-- Nothing else in the bodies is changed: they were read back with pg_get_functiondef and only the
-- five ORDER BY clauses rewritten.

alter table recovery.table_snapshots  alter column taken_at set default clock_timestamp();
alter table recovery.restore_preimages alter column taken_at set default clock_timestamp();
alter table recovery.snapshot_runs     alter column finished_at set default clock_timestamp();

-- A total order needs the tiebreaker to be indexed alongside the ranking key.
create index if not exists table_snapshots_table_taken_id_idx
  on recovery.table_snapshots (source_schema, source_table, taken_at desc, id desc);

CREATE OR REPLACE FUNCTION recovery.purge_snapshots()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
             partition by s.source_schema, s.source_table order by s.taken_at desc, s.id desc) as rn,
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
               partition by s.source_schema, s.source_table order by s.taken_at desc, s.id desc) as rn
      from recovery.table_snapshots s
    ),
    victims as (
      select r.id from ranked r where r.rn > 1 order by r.taken_at asc, r.id asc limit 10
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

CREATE OR REPLACE FUNCTION recovery.restore_table(p_schema text, p_table text, p_as_of timestamp with time zone, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(snapshot_id bigint, snapshot_taken_at timestamp with time zone, rows_now integer, rows_in_snapshot integer, applied boolean, note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_snap     record;
  v_pk       text[];
  v_now_rows integer;
  v_sql      text;
  v_pre      jsonb;
begin
  select pt.pk_columns into v_pk
  from recovery.protected_tables pt
  where pt.source_schema = p_schema and pt.source_table = p_table;

  if v_pk is null then
    raise exception 'recovery.restore_table: %.% is not a protected table', p_schema, p_table;
  end if;

  -- "The state at time T" is the newest snapshot AT OR BEFORE T. Because unchanged hours write
  -- nothing, the gaps are correct rather than missing: no snapshot between two points means the
  -- table did not change between them.
  select s.id, s.taken_at, s.row_count, s.payload
  into v_snap
  from recovery.table_snapshots s
  where s.source_schema = p_schema and s.source_table = p_table and s.taken_at <= p_as_of
  order by s.taken_at desc, s.id desc
  limit 1;

  if v_snap.id is null then
    raise exception 'recovery.restore_table: no snapshot of %.% at or before %', p_schema, p_table, p_as_of;
  end if;

  execute format('select count(*)::integer from %I.%I', p_schema, p_table) into v_now_rows;

  if p_dry_run then
    return query select v_snap.id, v_snap.taken_at, v_now_rows, v_snap.row_count, false,
      format('DRY RUN. Would replace %s live row(s) with %s row(s) from %s. '
             'Re-run with p_dry_run => false to apply. A pre-image is taken automatically.',
             v_now_rows, v_snap.row_count, v_snap.taken_at)::text;
    return;
  end if;

  -- Mandatory undo for the undo. There is no PITR behind a restore that was the wrong call.
  v_pre := recovery.canonical_payload(p_schema, p_table, v_pk);
  insert into recovery.restore_preimages (source_schema, source_table, payload, restored_to_snapshot_id)
  values (p_schema, p_table, v_pre, v_snap.id);

  -- DELETE, not TRUNCATE: TRUNCATE ignores deferred foreign keys, and check-migrations.mjs
  -- refuses an unannotated one.
  set constraints all deferred;
  execute format('delete from %I.%I', p_schema, p_table);
  execute format(
    'insert into %I.%I select * from jsonb_populate_recordset(null::%I.%I, $1)',
    p_schema, p_table, p_schema, p_table) using v_snap.payload;

  return query select v_snap.id, v_snap.taken_at, v_now_rows, v_snap.row_count, true,
    format('APPLIED. %s row(s) replaced by %s row(s) from %s. Pre-image kept in '
           'recovery.restore_preimages. Check any identity sequence before inserting again.',
           v_now_rows, v_snap.row_count, v_snap.taken_at)::text;
end;
$function$;

CREATE OR REPLACE FUNCTION recovery.take_snapshots()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_row        record;
  v_payload    jsonb;
  v_hash       text;
  v_prev_hash  text;
  v_rows       integer;
  v_bytes      bigint;
  v_started    timestamptz := clock_timestamp();
  v_checked    integer := 0;
  v_changed    integer := 0;
  v_purged     integer := 0;
  v_error      text := null;
  v_keep_daily boolean;
  v_total      bigint;
begin
  for v_row in
    select pt.source_schema, pt.source_table, pt.pk_columns, pt.max_rows
    from recovery.protected_tables pt
    where pt.enabled
    order by pt.source_schema, pt.source_table
  loop
    begin
      v_checked := v_checked + 1;
      v_payload := recovery.canonical_payload(v_row.source_schema, v_row.source_table, v_row.pk_columns);
      v_rows := jsonb_array_length(v_payload);
      v_bytes := octet_length(v_payload::text);

      if v_rows > v_row.max_rows then
        v_error := coalesce(v_error, '') ||
          format('%s.%s skipped: %s rows exceeds max_rows %s. ',
                 v_row.source_schema, v_row.source_table, v_rows, v_row.max_rows);
        continue;
      end if;

      if v_bytes > 64 * 1024 * 1024 then
        v_error := coalesce(v_error, '') ||
          format('%s.%s skipped: payload %s bytes exceeds the 64 MB ceiling. ',
                 v_row.source_schema, v_row.source_table, v_bytes);
        continue;
      end if;

      v_hash := md5(v_payload::text);

      select s.content_hash into v_prev_hash
      from recovery.table_snapshots s
      where s.source_schema = v_row.source_schema
        and s.source_table = v_row.source_table
      order by s.taken_at desc, s.id desc
      limit 1;

      -- The whole point: unchanged tables cost nothing.
      if v_prev_hash is distinct from v_hash then
        v_keep_daily := not exists (
          select 1 from recovery.table_snapshots s
          where s.source_schema = v_row.source_schema
            and s.source_table = v_row.source_table
            and s.taken_at >= date_trunc('day', now())
        );
        insert into recovery.table_snapshots
          (source_schema, source_table, content_hash, row_count, payload, payload_bytes, keep_daily)
        values
          (v_row.source_schema, v_row.source_table, v_hash, v_rows, v_payload, v_bytes, v_keep_daily);
        v_changed := v_changed + 1;
      end if;
    exception when others then
      -- One bad table must not lose the run for the other six.
      v_error := coalesce(v_error, '') ||
        format('%s.%s: %s %s. ', v_row.source_schema, v_row.source_table, sqlstate, sqlerrm);
    end;
  end loop;

  v_purged := recovery.purge_snapshots();
  select coalesce(sum(s.payload_bytes), 0) into v_total from recovery.table_snapshots s;

  insert into recovery.snapshot_runs
    (started_at, duration_ms, tables_checked, tables_changed, rows_purged, total_bytes, error)
  values
    (v_started, (extract(epoch from clock_timestamp() - v_started) * 1000)::integer,
     v_checked, v_changed, v_purged, v_total, v_error);

  return jsonb_build_object(
    'checked', v_checked, 'changed', v_changed, 'purged', v_purged,
    'total_bytes', v_total, 'error', v_error);
end;
$function$;
