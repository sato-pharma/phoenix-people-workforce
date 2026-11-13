-- daily_deductions_one_row_per_day
--
-- WHAT THIS CHANGES: a released daily deduction can now be ONE DAY — its own row, never merged.
--   * daily_deductions_lines gains deduction_date (date, nullable). A row released by the Daily
--     Deductions page carries the one day it charges here, and `dates` is exactly that day.
--   * The snapshot's unique key widens from (publication, employee, category) to
--     (publication, employee, category, deduction_date) NULLS NOT DISTINCT — so the 9th, the 10th and
--     the 11th of one employee's unpaid leave are three rows, while a row written the old way (no
--     deduction_date, every day of the range in one row) is still unique per employee x category.
--   * phx_release_daily_deduction_lines(...) upserts on the widened key, files a dated row under its
--     own day, and REFUSES:
--       - a dated row whose `dates` is not exactly its deduction_date;
--       - a dated row for a day already inside an older whole-range row of the same employee x
--         category (it would charge that day twice);
--       - a whole-range row for an employee x category that already has a day released on its own
--         inside that range (same reason, the other way round).
--
-- WHY: the owner, 2026-11-13: "never group a group of deductions ... Ahmad Sharaf Din have a 3 days
-- unpaid vacation, 9, 10, 11 ... I can select day 9 alone and release, or day 10 alone and release ...
-- Never group them. I want each deduction to be single." A merged row also let a later release replace
-- days released earlier (the money review of PR 323): one row per day can only ever replace itself.
--
-- Additive: one nullable column, one index swapped for a wider one, one function re-created. The 7
-- rows on production on 2026-11-13 (6 of them multi-day) keep deduction_date null and stay exactly as
-- they are. Nothing here touches salary_records, salary_batches or the deductions_* tables. A dispute
-- (daily_deductions_disputes) keys on the row id, so a dispute on a one-day row is about that day.
--
-- ROLLBACK (only while no two rows share publication x employee x category):
--   drop index if exists public.daily_deductions_lines_pub_employee_category_day_idx;
--   create unique index daily_deductions_lines_pub_employee_category_idx
--     on public.daily_deductions_lines (publication_id, employee_hr_id_compact, category);
--   alter table public.daily_deductions_lines drop column if exists deduction_date;
--   then re-apply 20261012132430_daily_deductions_per_line_release.sql's release function.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.

begin;

alter table public.daily_deductions_lines
  add column if not exists deduction_date date;

comment on column public.daily_deductions_lines.deduction_date is
  'The ONE day this row charges when it was released on its own (owner, 2026-11-13: "I want each deduction to be single"); dates is then exactly this day. Null on a row that carries a whole range.';

create unique index if not exists daily_deductions_lines_pub_employee_category_day_idx
  on public.daily_deductions_lines (publication_id, employee_hr_id_compact, category, deduction_date)
  nulls not distinct;

drop index if exists public.daily_deductions_lines_pub_employee_category_idx;

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
  v_clash text;
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

  -- A one-day row charges exactly its own day.
  select coalesce(line->>'employeeName', line->>'employeeHrId') into v_clash
    from jsonb_array_elements(p_lines) as line
   where nullif(line->>'deductionDate', '') is not null
     and coalesce(line->'dates', '[]'::jsonb) <> jsonb_build_array(line->>'deductionDate')
   limit 1;
  if v_clash is not null then
    raise exception 'phx_release_daily_deduction_lines: the one-day deduction for % must list exactly its own day', v_clash;
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

  -- Never charge one day twice: a day released on its own may not sit inside an older whole-range
  -- row of the same employee x category, and a whole-range row may not cover a day already out alone.
  select coalesce(line->>'employeeName', line->>'employeeHrId') || ' on ' || (line->>'deductionDate') into v_clash
    from jsonb_array_elements(p_lines) as line
    join public.daily_deductions_lines l
      on l.publication_id = v_publication.id
     and l.employee_hr_id_compact = line->>'employeeHrIdCompact'
     and l.category = line->>'category'
     and l.deduction_date is null
     and l.dates ? (line->>'deductionDate')
   where nullif(line->>'deductionDate', '') is not null
   limit 1;
  if v_clash is not null then
    raise exception 'phx_release_daily_deduction_lines: % is already released inside an earlier whole-range deduction', v_clash;
  end if;

  select coalesce(line->>'employeeName', line->>'employeeHrId') || ' on ' || l.deduction_date::text into v_clash
    from jsonb_array_elements(p_lines) as line
    join public.daily_deductions_lines l
      on l.publication_id = v_publication.id
     and l.employee_hr_id_compact = line->>'employeeHrIdCompact'
     and l.category = line->>'category'
     and l.deduction_date is not null
     and coalesce(line->'dates', '[]'::jsonb) ? l.deduction_date::text
   where nullif(line->>'deductionDate', '') is null
   limit 1;
  if v_clash is not null then
    raise exception 'phx_release_daily_deduction_lines: % is already released on its own, so the whole range cannot be released over it', v_clash;
  end if;

  insert into public.daily_deductions_lines (
    publication_id, category, employee_hr_id, employee_hr_id_compact, employee_name,
    unit, raw_days_count, days_count, amount, dates, source_system, reason, hr_note,
    released_at, released_by, range_start, range_end, deduction_date
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
    -- A one-day row is filed under its own day, never the window that was counted.
    coalesce(nullif(line->>'deductionDate', '')::date, p_range_start),
    coalesce(nullif(line->>'deductionDate', '')::date, p_range_end),
    nullif(line->>'deductionDate', '')::date
  from jsonb_array_elements(p_lines) as line
  on conflict (publication_id, employee_hr_id_compact, category, deduction_date) do update
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
  'Daily Deductions module: merge the given rows into the one active snapshot (creating it when none is active). A row is keyed by employee x category x deduction_date (null for a whole-range row); a row already released under the same key is replaced, every other row is untouched, and a day is never charged by both a one-day row and a whole-range row. SECURITY DEFINER, service_role only.';

revoke execute on function public.phx_release_daily_deduction_lines(date, date, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.phx_release_daily_deduction_lines(date, date, jsonb, text, text) to service_role;

commit;
