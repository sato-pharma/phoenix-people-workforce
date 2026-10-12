-- daily_deductions_per_line_release
--
-- WHAT THIS CHANGES: the Daily Deductions snapshot can now be built ONE LINE AT A TIME.
--   * daily_deductions_lines gains released_at / released_by (when and by whom THIS line went out)
--     and range_start / range_end (the window THIS line was counted over).
--   * phx_release_daily_deduction_lines(...) MERGES the given lines into the one active snapshot
--     (creating it when none is active) instead of replacing the snapshot. A line already released for
--     the same employee x category is replaced by the new figures; every other released line is left
--     exactly as it was. The snapshot's range is the hull of its lines' ranges; its counts and
--     category totals are re-derived from the rows.
--   * phx_withdraw_daily_deduction_line(...) takes ONE line back out of the active snapshot, and
--     supersedes the snapshot when its last line goes.
--   * phx_publish_daily_deductions(...) (the replace-everything publish) is re-created unchanged in
--     behaviour, except that it now stamps the four new columns and takes the same lock as the two
--     new functions, so a release and a publish can never interleave.
--
-- WHY: the owner (2026-10-12) wants the Daily Deductions page to behave like the weekly attendance
-- review: select any deduction for any employee, release it alone, and keep the others waiting - not
-- one all-or-nothing "publish this tally". Publish replaced the whole snapshot, so a single line could
-- never go out without dragging the rest of the tally with it.
--
-- Nothing here touches salary_records, salary_batches or the month module's deductions_* tables. On
-- 2026-10-12 both daily_deductions tables held 0 rows on production, so no backfill is needed.
--
-- ROLLBACK:
--   drop function if exists public.phx_withdraw_daily_deduction_line(uuid, text);
--   drop function if exists public.phx_release_daily_deduction_lines(date, date, jsonb, text, text);
--   alter table public.daily_deductions_lines
--     drop column if exists released_at, drop column if exists released_by,
--     drop column if exists range_start, drop column if exists range_end;
--   then re-apply 20260922103738_daily_deductions_module.sql's phx_publish_daily_deductions body.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- (This migration is additive: three new columns on an empty table and two new functions.)

begin;

-- ---------------------------------------------------------------------------
-- Per-line release stamps. released_at defaults to now() so a line written by the
-- replace-everything publish path reads as released at that moment; the range
-- columns are nullable and a reader falls back to the publication's own range.
-- ---------------------------------------------------------------------------

alter table public.daily_deductions_lines
  add column if not exists released_at timestamptz not null default now(),
  add column if not exists released_by text,
  add column if not exists range_start date,
  add column if not exists range_end   date;

comment on column public.daily_deductions_lines.released_at is
  'When THIS line was released into the snapshot (a re-release of the same employee x category refreshes it).';
comment on column public.daily_deductions_lines.released_by is
  'Who released THIS line (HR id or login id of the Super Admin).';
comment on column public.daily_deductions_lines.range_start is
  'First day of the window this line was counted over; null on a line written before per-line release existed.';
comment on column public.daily_deductions_lines.range_end is
  'Last day of the window this line was counted over; null on a line written before per-line release existed.';

-- ---------------------------------------------------------------------------
-- phx_release_daily_deduction_lines - merge lines into the active snapshot.
-- SECURITY DEFINER, service_role only.
-- ---------------------------------------------------------------------------

create or replace function public.phx_release_daily_deduction_lines(
  p_range_start date,
  p_range_end   date,
  p_lines       jsonb,
  p_actor       text,
  p_notes       text default null
)
returns public.daily_deductions_publications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.daily_deductions_publications;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  if v_actor = '' then
    raise exception 'phx_release_daily_deduction_lines: an actor is required';
  end if;
  if p_range_start is null or p_range_end is null or p_range_start > p_range_end then
    raise exception 'phx_release_daily_deduction_lines: range_start must be <= range_end and neither may be null';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'phx_release_daily_deduction_lines: p_lines must be a non-empty JSON array';
  end if;

  -- One release / withdraw / publish at a time, so the single-active-snapshot index can never race.
  perform pg_advisory_xact_lock(hashtext('daily_deductions_snapshot'));

  select * into v_publication
    from public.daily_deductions_publications
   where status = 'published' and superseded_at is null
   for update;

  if not found then
    insert into public.daily_deductions_publications (range_start, range_end, published_by, notes)
    values (p_range_start, p_range_end, v_actor, nullif(btrim(coalesce(p_notes, '')), ''))
    returning * into v_publication;
  end if;

  insert into public.daily_deductions_lines (
    publication_id, category, employee_hr_id, employee_hr_id_compact, employee_name,
    unit, raw_days_count, days_count, amount, dates, source_system, reason, hr_note,
    released_at, released_by, range_start, range_end
  )
  select
    v_publication.id,
    line->>'category',
    line->>'employeeHrId',
    line->>'employeeHrIdCompact',
    nullif(line->>'employeeName', ''),
    coalesce(nullif(line->>'unit', ''), 'days'),
    coalesce((line->>'rawDaysCount')::numeric, 0),
    coalesce((line->>'daysCount')::numeric, 0),
    coalesce((line->>'amount')::numeric, 0),
    coalesce(line->'dates', '[]'::jsonb),
    coalesce(line->>'sourceSystem', ''),
    nullif(line->>'reason', ''),
    coalesce(line->>'hrNote', ''),
    now(),
    v_actor,
    p_range_start,
    p_range_end
  from jsonb_array_elements(p_lines) as line
  on conflict (publication_id, employee_hr_id_compact, category) do update
    set employee_hr_id = excluded.employee_hr_id,
        employee_name  = excluded.employee_name,
        unit           = excluded.unit,
        raw_days_count = excluded.raw_days_count,
        days_count     = excluded.days_count,
        amount         = excluded.amount,
        dates          = excluded.dates,
        source_system  = excluded.source_system,
        reason         = excluded.reason,
        hr_note        = excluded.hr_note,
        released_at    = excluded.released_at,
        released_by    = excluded.released_by,
        range_start    = excluded.range_start,
        range_end      = excluded.range_end;

  -- Counts, totals and the window are derived from the rows that are actually there.
  update public.daily_deductions_publications p
     set range_start = coalesce((
           select min(coalesce(l.range_start, p.range_start))
             from public.daily_deductions_lines l where l.publication_id = p.id
         ), p.range_start),
         range_end = coalesce((
           select max(coalesce(l.range_end, p.range_end))
             from public.daily_deductions_lines l where l.publication_id = p.id
         ), p.range_end),
         line_count = (
           select count(*)::int from public.daily_deductions_lines where publication_id = p.id
         ),
         employee_count = (
           select count(distinct employee_hr_id_compact)::int
             from public.daily_deductions_lines where publication_id = p.id
         ),
         category_totals = coalesce((
           select jsonb_object_agg(category, cat_total)
             from (
               select category, sum(amount) as cat_total
                 from public.daily_deductions_lines
                where publication_id = p.id
                group by category
             ) c
         ), '{}'::jsonb)
   where p.id = v_publication.id;

  select * into v_publication from public.daily_deductions_publications where id = v_publication.id;
  return v_publication;
end;
$$;

comment on function public.phx_release_daily_deduction_lines(date, date, jsonb, text, text) is
  'Daily Deductions module: merge the given tally lines into the one active snapshot (creating it when none is active). A line already released for the same employee x category is replaced; every other released line is untouched. Counts, totals and the window are re-derived from the rows. SECURITY DEFINER, service_role only.';

revoke execute on function public.phx_release_daily_deduction_lines(date, date, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.phx_release_daily_deduction_lines(date, date, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- phx_withdraw_daily_deduction_line - take ONE line back out of the active snapshot.
-- Returns the removed row so the caller can audit exactly what was withdrawn.
-- SECURITY DEFINER, service_role only.
-- ---------------------------------------------------------------------------

create or replace function public.phx_withdraw_daily_deduction_line(
  p_line_id uuid,
  p_actor   text
)
returns public.daily_deductions_lines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.daily_deductions_publications;
  v_line        public.daily_deductions_lines;
  v_remaining   integer;
begin
  if btrim(coalesce(p_actor, '')) = '' then
    raise exception 'phx_withdraw_daily_deduction_line: an actor is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('daily_deductions_snapshot'));

  select * into v_publication
    from public.daily_deductions_publications
   where status = 'published' and superseded_at is null
   for update;
  if not found then
    raise exception 'phx_withdraw_daily_deduction_line: nothing is published, so there is no line to withdraw';
  end if;

  delete from public.daily_deductions_lines
   where id = p_line_id and publication_id = v_publication.id
   returning * into v_line;
  if not found then
    raise exception 'phx_withdraw_daily_deduction_line: line % is not in the active snapshot', p_line_id;
  end if;

  select count(*)::int into v_remaining
    from public.daily_deductions_lines where publication_id = v_publication.id;

  if v_remaining = 0 then
    -- The last released line is gone: the snapshot itself is withdrawn, as the whole-snapshot Withdraw does.
    update public.daily_deductions_publications
       set status = 'superseded', superseded_at = now(),
           line_count = 0, employee_count = 0, category_totals = '{}'::jsonb
     where id = v_publication.id;
  else
    update public.daily_deductions_publications p
       set range_start = coalesce((
             select min(coalesce(l.range_start, p.range_start))
               from public.daily_deductions_lines l where l.publication_id = p.id
           ), p.range_start),
           range_end = coalesce((
             select max(coalesce(l.range_end, p.range_end))
               from public.daily_deductions_lines l where l.publication_id = p.id
           ), p.range_end),
           line_count = v_remaining,
           employee_count = (
             select count(distinct employee_hr_id_compact)::int
               from public.daily_deductions_lines where publication_id = p.id
           ),
           category_totals = coalesce((
             select jsonb_object_agg(category, cat_total)
               from (
                 select category, sum(amount) as cat_total
                   from public.daily_deductions_lines
                  where publication_id = p.id
                  group by category
               ) c
           ), '{}'::jsonb)
     where p.id = v_publication.id;
  end if;

  return v_line;
end;
$$;

comment on function public.phx_withdraw_daily_deduction_line(uuid, text) is
  'Daily Deductions module: remove ONE line from the active snapshot, re-derive its counts and window, and supersede the snapshot when no line is left. Returns the removed row. SECURITY DEFINER, service_role only.';

revoke execute on function public.phx_withdraw_daily_deduction_line(uuid, text) from public, anon, authenticated;
grant execute on function public.phx_withdraw_daily_deduction_line(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- phx_publish_daily_deductions - the replace-everything publish. Same behaviour as
-- 20260922103738, plus: it stamps the per-line columns and takes the shared lock.
-- ---------------------------------------------------------------------------

create or replace function public.phx_publish_daily_deductions(
  p_range_start date,
  p_range_end   date,
  p_lines       jsonb,
  p_actor       text,
  p_notes       text default null
)
returns public.daily_deductions_publications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.daily_deductions_publications;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  if v_actor = '' then
    raise exception 'phx_publish_daily_deductions: an actor is required';
  end if;
  if p_range_start is null or p_range_end is null or p_range_start > p_range_end then
    raise exception 'phx_publish_daily_deductions: range_start must be <= range_end and neither may be null';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'phx_publish_daily_deductions: p_lines must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtext('daily_deductions_snapshot'));

  update public.daily_deductions_publications
     set status = 'superseded', superseded_at = now()
   where status = 'published' and superseded_at is null;

  insert into public.daily_deductions_publications (range_start, range_end, published_by, notes)
  values (p_range_start, p_range_end, v_actor, nullif(btrim(coalesce(p_notes, '')), ''))
  returning * into v_publication;

  update public.daily_deductions_publications
     set superseded_by_publication_id = v_publication.id
   where status = 'superseded' and superseded_at is not null
     and superseded_by_publication_id is null
     and id <> v_publication.id;

  insert into public.daily_deductions_lines (
    publication_id, category, employee_hr_id, employee_hr_id_compact, employee_name,
    unit, raw_days_count, days_count, amount, dates, source_system, reason, hr_note,
    released_at, released_by, range_start, range_end
  )
  select
    v_publication.id,
    line->>'category',
    line->>'employeeHrId',
    line->>'employeeHrIdCompact',
    nullif(line->>'employeeName', ''),
    coalesce(nullif(line->>'unit', ''), 'days'),
    coalesce((line->>'rawDaysCount')::numeric, 0),
    coalesce((line->>'daysCount')::numeric, 0),
    coalesce((line->>'amount')::numeric, 0),
    coalesce(line->'dates', '[]'::jsonb),
    coalesce(line->>'sourceSystem', ''),
    nullif(line->>'reason', ''),
    coalesce(line->>'hrNote', ''),
    now(),
    v_actor,
    p_range_start,
    p_range_end
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;

  update public.daily_deductions_publications p
     set line_count = (
           select count(*)::int
           from public.daily_deductions_lines
           where publication_id = v_publication.id
         ),
         employee_count = (
           select count(distinct employee_hr_id_compact)::int
           from public.daily_deductions_lines
           where publication_id = v_publication.id
         ),
         category_totals = coalesce((
           select jsonb_object_agg(category, cat_total)
           from (
             select category, sum(amount) as cat_total
             from public.daily_deductions_lines
             where publication_id = v_publication.id
             group by category
           ) c
         ), '{}'::jsonb)
   where p.id = v_publication.id;

  select * into v_publication from public.daily_deductions_publications where id = v_publication.id;
  return v_publication;
end;
$$;

revoke execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) to service_role;

commit;
