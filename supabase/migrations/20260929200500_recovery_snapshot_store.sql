-- An hourly, change-based undo log for the money tables. Zero extra cost.
--
-- WHY. Production has NO point-in-time recovery: seven daily backups are the entire story, so a
-- bad UPDATE or DELETE on payroll at 2pm costs everything back to last night, and recovering even
-- that means restoring a backup into a SEPARATE project to extract from. The owner was offered
-- 7-day PITR at ~$100/month on 2026-09-29 and chose a zero-cost design instead, knowing it does
-- not reach a true 10/10 (see "WHAT THIS IS NOT" below).
--
-- WHAT THIS IS. pg_cron runs recovery.take_snapshots() at :05 every hour. For each registered
-- table it builds a canonical JSON payload ordered by primary key, hashes it, and stores a copy
-- ONLY IF THE HASH CHANGED. Storage therefore tracks real edits, not the clock — most hours
-- write nothing at all. Restoring is one command and takes seconds, against one table.
--
-- 🔴 WHAT THIS IS NOT. It is an UNDO LOG, NOT A BACKUP: it lives inside the database it protects.
-- It defends against a bad write, a bad backfill, a bad migration. It does NOT defend against
-- losing the project — that is still the seven daily backups — and it covers only the 7 tables
-- registered below, not the other ~420. Do not let anyone read it as replacing PITR.
--
-- COST. The registered set is about 6 MB of live rows (5,600 rows across 7 tables). Because a
-- copy is written only on change, and retention is bounded three ways (below), the realistic
-- footprint is tens of MB on a 2,500 MB database. pg_cron is a Postgres extension, not a paid
-- Supabase add-on, and this adds no GitHub Actions minutes.
--
-- WHY `recovery` IS UNDATED. This is permanent infrastructure, not a snapshot. The retention
-- policy in scripts/audit-backup-schemas.mjs ages out schemas whose NAME carries a date; this one
-- deliberately carries none, and is also added to that script's exemption list.

create schema if not exists recovery;

-- No browser role may ever see payroll pre-images. PostgREST cannot reach a schema it has no
-- USAGE on, whatever the table grants say.
revoke all on schema recovery from public;
revoke all on schema recovery from anon, authenticated;
grant usage on schema recovery to service_role;

-- ---------------------------------------------------------------- the registry

create table if not exists recovery.protected_tables (
  source_schema text    not null,
  source_table  text    not null,
  pk_columns    text[]  not null,
  enabled       boolean not null default true,
  max_rows      integer not null default 250000,
  note          text,
  primary key (source_schema, source_table)
);

comment on table recovery.protected_tables is
  'Which tables the hourly undo log covers. max_rows is a guard: a table that outgrows it is '
  'skipped with an error on that run rather than quietly multiplying the database size.';

-- The money and org set. Every one has a primary key, so the payload ordering — and therefore
-- the hash — is deterministic. Verified against pg_constraint on 2026-09-29.
insert into recovery.protected_tables (source_schema, source_table, pk_columns, note) values
  ('public', 'salary_records',               array['id'],                                     'payroll rows'),
  ('public', 'salary_batches',               array['id'],                                     'payroll run headers'),
  ('public', 'employees',                    array['hr_id'],                                  'the org roster'),
  ('public', 'monthly_closing_publications', array['id'],                                     'what makes a month published'),
  ('public', 'monthly_closing_locks',        array['id'],                                     'the owner''s month locks'),
  ('au',     'monthly_targets',              array['id'],                                     'the denominator of every achievement'),
  ('au',     'line_area_map',                array['line_code','area_code','effective_from'], 'dated sales geography')
on conflict (source_schema, source_table) do nothing;

-- ---------------------------------------------------------------- the store

create table if not exists recovery.table_snapshots (
  id            bigint generated always as identity primary key,
  taken_at      timestamptz not null default now(),
  source_schema text        not null,
  source_table  text        not null,
  content_hash  text        not null,
  row_count     integer     not null,
  payload       jsonb       not null,
  payload_bytes bigint      not null,
  keep_daily    boolean     not null default false
);

create index if not exists table_snapshots_table_time_idx
  on recovery.table_snapshots (source_schema, source_table, taken_at desc);

comment on column recovery.table_snapshots.keep_daily is
  'True on the first snapshot of a UTC day for that table. Those survive the 72-version window '
  'for 30 days, so a slow-changing table still has older recovery points.';

create table if not exists recovery.snapshot_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null,
  finished_at    timestamptz not null default now(),
  duration_ms    integer     not null,
  tables_checked integer     not null,
  tables_changed integer     not null,
  rows_purged    integer     not null,
  total_bytes    bigint      not null,
  error          text
);

create index if not exists snapshot_runs_started_idx on recovery.snapshot_runs (started_at desc);

create table if not exists recovery.restore_preimages (
  id                      bigint generated always as identity primary key,
  taken_at                timestamptz not null default now(),
  source_schema           text        not null,
  source_table            text        not null,
  payload                 jsonb       not null,
  restored_to_snapshot_id bigint,
  actor                   text        not null default current_user
);

comment on table recovery.restore_preimages is
  'The contents of a table immediately BEFORE a restore overwrote it. Mandatory, because there '
  'is no point-in-time recovery behind a restore that turns out to be the wrong choice.';

revoke all on all tables in schema recovery from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema recovery to service_role;

-- ---------------------------------------------------------------- functions
--
-- 🔴 EVERY COLUMN INSIDE THESE plpgsql BODIES IS QUALIFIED OR PREFIXED. A plpgsql function's
-- declared variables and OUT parameters are in scope for every query in the body, so a bare
-- column name that collides with one compiles clean and fails at CALL time with 42702. That
-- happened on this database earlier today and broke au.f_monthly_attribution for 2m46s, because
-- CREATE OR REPLACE reports success on a plpgsql function it has not planned.

create or replace function recovery.canonical_payload(p_schema text, p_table text, p_pk text[])
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_payload jsonb;
  v_order   text;
  v_sql     text;
begin
  select string_agg(format('t.%I', c.col), ', ') into v_order from unnest(p_pk) as c(col);
  v_sql := format(
    'select coalesce(jsonb_agg(to_jsonb(t) order by %s), ''[]''::jsonb) from %I.%I t',
    v_order, p_schema, p_table);
  execute v_sql into v_payload;
  return v_payload;
end;
$function$;

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
  -- Rule 1 and 2: keep the newest 72 versions per table, plus any daily marker inside 30 days.
  -- Rule 3 is the important one: the NEWEST row for a table is never deleted, at any age. A
  -- table that has not changed in a year must still be restorable, so a purely time-based purge
  -- would delete the only copy of au.line_area_map, which changes about monthly.
  with ranked as (
    select s.id,
           row_number() over (partition by s.source_schema, s.source_table order by s.taken_at desc) as rn,
           s.keep_daily,
           s.taken_at
    from recovery.table_snapshots s
  )
  delete from recovery.table_snapshots d
  using ranked r
  where d.id = r.id
    and r.rn > 72
    and not (r.keep_daily and r.taken_at >= now() - interval '30 days');
  get diagnostics v_hit = row_count;
  v_purged := v_purged + v_hit;

  -- Rule 4: a global byte ceiling, so a mis-registered table cannot grow the database without
  -- bound. Deletes oldest-first and still never the newest row for a table.
  while pg_total_relation_size('recovery.table_snapshots') > 512 * 1024 * 1024 loop
    with ranked as (
      select s.id,
             row_number() over (partition by s.source_schema, s.source_table order by s.taken_at desc) as rn,
             s.taken_at
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

create or replace function recovery.take_snapshots()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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
      order by s.taken_at desc
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

-- ---------------------------------------------------------------- the restore

create or replace function recovery.restore_table(
  p_schema  text,
  p_table   text,
  p_as_of   timestamptz,
  p_dry_run boolean default true
)
returns table (
  snapshot_id       bigint,
  snapshot_taken_at timestamptz,
  rows_now          integer,
  rows_in_snapshot  integer,
  applied           boolean,
  note              text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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
  order by s.taken_at desc
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

revoke execute on function recovery.canonical_payload(text, text, text[]) from public, anon, authenticated;
revoke execute on function recovery.purge_snapshots() from public, anon, authenticated;
revoke execute on function recovery.take_snapshots() from public, anon, authenticated;
revoke execute on function recovery.restore_table(text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function recovery.take_snapshots() to service_role;
grant execute on function recovery.restore_table(text, text, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------- the dead-man's switch
--
-- The only object this migration puts in `public`, so scripts/check-schema-shape.ts can read the
-- undo log's health through PostgREST on its existing daily run — no new Actions minutes. A
-- snapshot store that quietly stopped is worse than none, because it looks like protection.

create or replace function public.phx_ci_recovery_health()
returns table (
  source_schema      text,
  source_table       text,
  enabled            boolean,
  snapshots_held     integer,
  newest_snapshot_at timestamptz,
  ever_captured      boolean
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select pt.source_schema,
         pt.source_table,
         pt.enabled,
         coalesce(count(s.id), 0)::integer as snapshots_held,
         max(s.taken_at) as newest_snapshot_at,
         count(s.id) > 0 as ever_captured
  from recovery.protected_tables pt
  left join recovery.table_snapshots s
    on s.source_schema = pt.source_schema and s.source_table = pt.source_table
  group by pt.source_schema, pt.source_table, pt.enabled
  order by pt.source_schema, pt.source_table;
$function$;

revoke execute on function public.phx_ci_recovery_health() from public, anon, authenticated;
grant execute on function public.phx_ci_recovery_health() to service_role;

comment on function public.phx_ci_recovery_health() is
  'Liveness of the hourly recovery undo log, for scripts/check-schema-shape.ts. Service role '
  'only. Returns counts and timestamps, never payload contents.';
