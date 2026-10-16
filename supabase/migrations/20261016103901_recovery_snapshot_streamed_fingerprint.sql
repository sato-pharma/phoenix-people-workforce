-- recovery_snapshot_streamed_fingerprint
--
-- WHAT THIS CHANGES: recovery.take_snapshots() stops building every protected table's full JSON
-- copy each hour just to learn whether it changed. It fingerprints the table in one streamed pass
-- instead (an md5 per row, the row hashes joined in primary-key order and hashed again, stored as
-- 'r2:<md5>'), and builds the copy only for a table whose fingerprint moved. The copy and the
-- fingerprint stored beside it now come out of ONE statement, so they always describe the same
-- reading of the table. The payload is never cast to text any more: its size is the sum of the
-- row texts plus the array's own punctuation, which is byte-identical to octet_length(payload::text).
-- What is stored, what is restored and every retention rule are unchanged.
--
-- WHY: the old body ran recovery.canonical_payload() on all seven tables every hour, then cast
-- each payload to text TWICE (once for its size, once for md5). monthly_closing_locks alone is
-- 28,457,501 bytes today (53 rows, measured 2026-10-16; the design note's 13 MB from 2026-09-29
-- has more than doubled), so every :05 held a ~28 MB jsonb plus two ~28 MB strings in one backend
-- on a 2 GB compute — whether or not anything had changed.
--
-- The runs that took longest are the minutes production stalled (recovery.snapshot_runs against
-- edge_logs and app_error_events, read 2026-10-16):
--   2026-10-08 16:05 Cairo   50.4 s   server renders timing out at 16:06
--   2026-10-11 13:05 Cairo   36.1 s   edge requests fell from ~360 to 26-32 per 10 s from 10:05:10
--                                     to 10:05:30 UTC, 11 "Supabase request timed out" renders
--   2026-10-14 17:05 Cairo   45.2 s   ZERO edge requests completed in 14:05:20-14:05:30 UTC, 17 in
--                                     the next 10 s at 9 s average, PostgREST lost its pool
--                                     (PGRST001) and reconnected at 14:05:44 — the run ended 14:05:45
-- and the 2026-10-10 11:05 instance restart killed the run that had started at 11:05:00
-- (cron.job_run_details: 'server restarted'). Overnight the same function takes 3.6-5.5 s. Every
-- one of those bursts is what the Error Monitor shows as React error #441 (a server render that
-- threw "Supabase request timed out."), #412 and PGRST002. Seen-together is not proof that this
-- run is the whole cause — the host-level restarts are Supabase's to explain — but it is the one
-- piece of hourly work that scales with the biggest table, and it no longer needs to.
--
-- AN UNCHANGED HOUR NOW HOLDS ONE ROW AT A TIME. A changed table still costs one payload build,
-- exactly as before, and nothing more.
--
-- THE HASH SCHEME MOVES, AND NOTHING IS RE-CAPTURED FOR IT. A version stored before this ran
-- carries md5(payload::text), which a streamed fingerprint cannot equal. The first run after this
-- re-fingerprints each table's NEWEST stored version once, from that version's own payload, and
-- writes the 'r2:' value onto that row — so an unchanged table is recognised as unchanged and no
-- duplicate copy evicts real history (monthly_closing_locks keeps only 12). Verified on production
-- before writing this, on public.salary_batches: the streamed fingerprint of the live table and
-- the fingerprint recomputed from its newest stored payload were identical
-- (fa18d14ef2632a8c43f15b90190778be), and the size formula gave 5,060 = octet_length(payload::text).
-- content_hash is read by take_snapshots() and nothing else.
--
-- ROLLBACK: re-run the take_snapshots() definition from
-- 20260929203100_recovery_total_order_on_snapshots.sql, then drop the two helpers below. The old
-- body would treat every 'r2:' hash as a change and capture each table once more, which costs one
-- extra version per table and loses nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This replaces three function bodies and touches no data except the one content_hash per table
-- described above.

begin;

-- One reading of a protected table: its row count, the exact byte size its canonical payload
-- would have, its 'r2:' fingerprint, and — only when asked — the payload itself, identical to
-- recovery.canonical_payload(). All four come from one statement, so one snapshot.
--
-- The two OFFSET 0 fences are load-bearing: without them the planner flattens the subqueries and
-- evaluates to_jsonb(t) and its ::text once per reference, doubling the work this exists to cut.
create or replace function recovery.fingerprint_table(
  p_schema text,
  p_table text,
  p_pk text[],
  p_with_payload boolean default false)
returns table (fp_rows integer, fp_bytes bigint, fp_hash text, fp_payload jsonb)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_inner text;
  v_order text;
begin
  select string_agg(format('t.%I', c.col), ', ' order by c.ord),
         string_agg(format('r.%I', c.col), ', ' order by c.ord)
    into v_inner, v_order
  from unnest(p_pk) with ordinality as c(col, ord);

  return query execute format(
    'select count(*)::integer,
            (case when count(*) = 0 then 2
                  else 2 + sum(octet_length(r.recovery_row_text)) + 2 * (count(*) - 1) end)::bigint,
            ''r2:'' || md5(coalesce(string_agg(md5(r.recovery_row_text), '''' order by %1$s), '''')),
            %2$s
     from (select a.*, a.recovery_row_json::text as recovery_row_text
           from (select %3$s, to_jsonb(t) as recovery_row_json from %4$I.%5$I t offset 0) a
           offset 0) r',
    v_order,
    case when p_with_payload
      then format('coalesce(jsonb_agg(r.recovery_row_json order by %s), ''[]''::jsonb)', v_order)
      else 'null::jsonb'
    end,
    v_inner,
    p_schema,
    p_table);
end;
$$;

-- The same fingerprint, computed from a payload already in the store. Used once per table, on the
-- first run after this migration, to carry its newest version onto the 'r2:' scheme. An element of
-- the stored array prints exactly as to_jsonb(t)::text did, and ordinality is primary-key order,
-- so an unchanged table yields the identical value.
create or replace function recovery.payload_fingerprint(p_payload jsonb)
returns text
language sql
immutable
security definer
set search_path to 'pg_catalog', 'public'
as $$
  select 'r2:' || md5(coalesce(string_agg(md5(x.element_text), '' order by e.ord), ''))
  from jsonb_array_elements(p_payload) with ordinality as e(value, ord)
  cross join lateral (select e.value::text as element_text offset 0) x
$$;

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
  v_prev_id    bigint;
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

      -- Has it changed? Answered one row at a time, with nothing table-sized held in memory.
      select f.fp_rows, f.fp_bytes, f.fp_hash
        into v_rows, v_bytes, v_hash
      from recovery.fingerprint_table(v_row.source_schema, v_row.source_table, v_row.pk_columns) f;

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

      v_prev_id := null;
      v_prev_hash := null;
      select s.id, s.content_hash
        into v_prev_id, v_prev_hash
      from recovery.table_snapshots s
      where s.source_schema = v_row.source_schema
        and s.source_table = v_row.source_table
      order by s.taken_at desc, s.id desc
      limit 1;

      -- A newest version stored before the 'r2:' scheme: fingerprint it from its own payload, once,
      -- and keep the result on the row, so the scheme change alone never captures a duplicate.
      if v_prev_id is not null and v_prev_hash not like 'r2:%' then
        select recovery.payload_fingerprint(s.payload)
          into v_prev_hash
        from recovery.table_snapshots s
        where s.id = v_prev_id;

        update recovery.table_snapshots s
        set content_hash = v_prev_hash
        where s.id = v_prev_id;
      end if;

      -- The whole point: unchanged tables cost nothing.
      if v_prev_hash is distinct from v_hash then
        -- Count, size and hash are re-read with the payload, from the same statement, so what is
        -- stored beside the copy describes that copy even if the table moved since the check.
        select f.fp_rows, f.fp_bytes, f.fp_hash, f.fp_payload
          into v_rows, v_bytes, v_hash, v_payload
        from recovery.fingerprint_table(v_row.source_schema, v_row.source_table, v_row.pk_columns, true) f;

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

-- Same posture as the store's own functions: nothing in the recovery schema is callable by a
-- browser role, and the helpers are callable only from inside take_snapshots().
revoke execute on function recovery.fingerprint_table(text, text, text[], boolean) from public, anon, authenticated;
revoke execute on function recovery.payload_fingerprint(jsonb) from public, anon, authenticated;
revoke execute on function recovery.take_snapshots() from public, anon, authenticated;
grant execute on function recovery.take_snapshots() to service_role;

commit;
