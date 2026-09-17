-- Weekly attendance review — live weeks, released in rounds. Owner decisions 2026-09-17, after he found
-- the review "not calculating deduction correct and not up to date":
--
--   • "Show live, release any time" — a week is on the review page from its first day and holds the days
--     up to yesterday. He can release the days so far in the middle of the week; later days go out in a
--     second release.
--   • "Rebuild it as a real week" — the 31 Aug–6 Sep trial copy is replaced by a real week waiting for
--     his release. Nothing is sent.
--   • "1–30 September" — from October the review's weeks follow the calendar month, like payroll
--     (digest-weeks.ts). September 2026 has weeks 2 to 5, so week_index now runs to 5.
--
-- WHY THE WEEK WAS OUT OF DATE. A week was built once, the morning after it closed (06:23 Cairo, hours
-- before that day's punches arrive), and never looked at again: a later punch, an approved excuse or
-- leave never reached it, and the running week did not exist at all until it closed.
--
-- WHAT CHANGES
--   1. release_round. One employee can now have several digests in one week: the first holds the days
--      released first, the next the days that arrived after. At most ONE waits for release at a time.
--   2. phx_attendance_sync_digest_days brings one employee's week up to date from the fingerprint report,
--      under the digest row lock the tick and the release take. It adds new flagged days (unticked),
--      refreshes the figures of days still waiting, and removes a waiting day the report has cleared. It
--      never touches a released, answered or cleared day, and never a day already in another digest.
--   3. phx_attendance_release_digest now takes the days the page showed, and refuses when a waiting day
--      is not among them — a day that arrived after the page loaded would otherwise be cleared on release
--      without him ever seeing it.
--   4. The trial copy is backed up, then deleted.
--
-- PRODUCTION DATA (2026-09-17): six trial digests (all void, dry run, never released, no settlement) and
-- their eleven days are deleted after being copied into attendance_backup_20260917.trial_digests. The seven
-- real digests of 7–13 Sep are not touched.

begin;

-- ---------------------------------------------------------------------------
-- 1. Weeks 1..5, and rounds
-- ---------------------------------------------------------------------------
alter table public.attendance_weekly_digests add column if not exists release_round smallint not null default 1;

comment on column public.attendance_weekly_digests.release_round is
  'Which release of this employee''s week this digest is: 1 for the days released first, 2 for days that arrived after, and so on. Owner 2026-09-17: "Show live, release any time".';

alter table public.attendance_weekly_digests drop constraint if exists attendance_weekly_digests_release_round_check;
alter table public.attendance_weekly_digests add constraint attendance_weekly_digests_release_round_check check (release_round >= 1);

alter table public.attendance_weekly_digests drop constraint if exists attendance_weekly_digests_week_index_check;
alter table public.attendance_weekly_digests add constraint attendance_weekly_digests_week_index_check check (week_index between 1 and 5);

alter table public.attendance_weekly_digests drop constraint if exists attendance_weekly_digests_employee_hr_id_cycle_key_week_ind_key;
alter table public.attendance_weekly_digests drop constraint if exists attendance_weekly_digests_employee_week_round_key;
alter table public.attendance_weekly_digests
  add constraint attendance_weekly_digests_employee_week_round_key unique (employee_hr_id, cycle_key, week_index, release_round);

-- One real digest waiting for release per employee-week: the sync adds to it, and a release closes it.
create unique index if not exists attendance_weekly_digests_one_awaiting_idx
  on public.attendance_weekly_digests (employee_hr_id, cycle_key, week_index)
  where status = 'awaiting_release' and dry_run = false;

-- ---------------------------------------------------------------------------
-- 2. The trial copy: back up, then delete
-- ---------------------------------------------------------------------------
-- A dated schema of its own, never `public`: PostgREST does not expose it and no browser role can use
-- it (docs/security/backup-table-placement.md). Drop the schema once the week is released.
create schema if not exists attendance_backup_20260917;
revoke all on schema attendance_backup_20260917 from public, anon, authenticated;

create table if not exists attendance_backup_20260917.trial_digests (
  id            bigserial   primary key,
  source_table  text        not null,
  source_id     bigint      not null,
  row_data      jsonb       not null,
  backed_up_at  timestamptz not null default now()
);

comment on table attendance_backup_20260917.trial_digests is
  'The void trial-run weekly attendance digests and their days, copied before the 2026-09-17 live-weeks migration deleted them (owner: "Rebuild it as a real week").';

revoke all on table attendance_backup_20260917.trial_digests from public, anon, authenticated;

-- A trial digest that was never released and has no settlement on any of its days. A settlement row is
-- immutable and points at its day, so a digest with one could not be deleted — and must not be.
create temporary table weekly_review_trial_ids on commit drop as
select d.id
from public.attendance_weekly_digests d
where d.dry_run = true
  and d.status = 'void'
  and d.released_at is null
  and not exists (
    select 1
    from public.attendance_digest_lines l
    join public.attendance_settlements s on s.digest_line_id = l.id
    where l.digest_id = d.id
  );

insert into attendance_backup_20260917.trial_digests (source_table, source_id, row_data)
select 'attendance_weekly_digests', d.id, to_jsonb(d)
from public.attendance_weekly_digests d
where d.id in (select id from weekly_review_trial_ids);

insert into attendance_backup_20260917.trial_digests (source_table, source_id, row_data)
select 'attendance_digest_lines', l.id, to_jsonb(l)
from public.attendance_digest_lines l
where l.digest_id in (select id from weekly_review_trial_ids);

-- The days go with their digest (on delete cascade).
delete from public.attendance_weekly_digests
where id in (select id from weekly_review_trial_ids);

-- ---------------------------------------------------------------------------
-- 3. Bringing one employee's week up to date
-- ---------------------------------------------------------------------------
create or replace function public.phx_attendance_sync_digest_days(
  p_employee_hr_id text,
  p_cycle_key text,
  p_week_index integer,
  p_week_start date,
  p_week_end date,
  p_dry_run boolean,
  p_days jsonb,
  p_cleared_dates date[]
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_hr text := btrim(coalesce(p_employee_hr_id, ''));
  v_days_json jsonb := coalesce(p_days, '[]'::jsonb);
  v_cleared_dates date[] := coalesce(p_cleared_dates, '{}'::date[]);
  v_digest public.attendance_weekly_digests;
  v_line public.attendance_digest_lines;
  v_day record;
  v_round smallint;
  v_created boolean := false;
  v_added integer := 0;
  v_updated integer := 0;
  v_cleared integer := 0;
  v_elsewhere integer := 0;
  v_removed_digest boolean := false;
  v_days numeric;
  v_value numeric;
  v_line_count integer;
  v_total_days numeric;
  v_total_value numeric;
  v_unpriced boolean;
begin
  if v_hr = '' or p_cycle_key !~ '^\d{4}-\d{2}$' or p_week_index is null or p_week_index not between 1 and 5
     or p_week_start is null or p_week_end is null or p_week_start > p_week_end or p_dry_run is null
     or jsonb_typeof(v_days_json) <> 'array' then
    raise exception 'The week to bring up to date is not valid.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_days_json) as d(work_date date, deduction_days numeric)
    where d.work_date is null
       or d.work_date < p_week_start
       or d.work_date > p_week_end
       or coalesce(d.deduction_days, 0) <= 0
       or d.work_date = any(v_cleared_dates)
  ) then
    raise exception 'A flagged day is outside its week, deducts nothing, or is also listed as cleared.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_to_recordset(v_days_json) as d(work_date date))
     <> (select count(distinct d.work_date) from jsonb_to_recordset(v_days_json) as d(work_date date)) then
    raise exception 'A flagged day is listed twice.' using errcode = '22023';
  end if;

  -- One sync of one employee-week at a time, whichever server runs it.
  perform pg_advisory_xact_lock(hashtextextended('attendance_digest_sync:' || upper(v_hr) || ':' || p_cycle_key || ':' || p_week_index::text, 0));

  -- The digest waiting for release, locked the way a tick and a release lock it.
  select * into v_digest
  from public.attendance_weekly_digests
  where upper(employee_hr_id) = upper(v_hr)
    and cycle_key = p_cycle_key
    and week_index = p_week_index
    and status = 'awaiting_release'
    and dry_run = p_dry_run
  order by id
  limit 1
  for update;

  for v_day in
    select *
    from jsonb_to_recordset(v_days_json) as d(
      work_date date,
      status text,
      late_minutes integer,
      short_minutes integer,
      worked_minutes integer,
      deduction_days numeric,
      deduction_value numeric,
      reason text,
      evidence jsonb
    )
    order by work_date
  loop
    -- A day already in another digest of this employee belongs to that digest: released, answered or
    -- cleared there. It is never asked about twice.
    if exists (
      select 1
      from public.attendance_digest_lines l
      join public.attendance_weekly_digests g on g.id = l.digest_id
      where upper(g.employee_hr_id) = upper(v_hr)
        and g.dry_run = p_dry_run
        and l.work_date = v_day.work_date
        and g.id is distinct from v_digest.id
    ) then
      v_elsewhere := v_elsewhere + 1;
      continue;
    end if;

    v_line := null;
    if v_digest.id is not null then
      select * into v_line
      from public.attendance_digest_lines
      where digest_id = v_digest.id and work_date = v_day.work_date
      for update;
    end if;

    if v_line.id is not null then
      -- Only a day still waiting is refreshed.
      if v_line.action <> 'pending' then
        continue;
      end if;
      -- A day whose days the Super Admin changed keeps his figure; its estimate follows the new detection.
      -- Otherwise the charge follows what the report detects now. The tick is kept either way.
      if v_line.adjusted_by_hr_id is not null then
        v_days := v_line.deduction_days;
        v_value := case
          when v_day.deduction_value is null then null
          when v_days = round(v_day.deduction_days, 3) then round(v_day.deduction_value, 2)
          else round(v_day.deduction_value * v_days / v_day.deduction_days, 2)
        end;
      else
        v_days := round(v_day.deduction_days, 3);
        v_value := round(v_day.deduction_value, 2);
      end if;

      if (v_line.status, v_line.late_minutes, v_line.short_minutes, v_line.worked_minutes, v_line.deduction_days,
          v_line.deduction_value, v_line.detected_days, v_line.detected_value, v_line.reason, v_line.evidence)
         is distinct from
         (v_day.status, coalesce(v_day.late_minutes, 0), coalesce(v_day.short_minutes, 0), coalesce(v_day.worked_minutes, 0), v_days,
          v_value, round(v_day.deduction_days, 3), round(v_day.deduction_value, 2), coalesce(v_day.reason, ''), coalesce(v_day.evidence, '{}'::jsonb)) then
        update public.attendance_digest_lines set
          status = v_day.status,
          late_minutes = coalesce(v_day.late_minutes, 0),
          short_minutes = coalesce(v_day.short_minutes, 0),
          worked_minutes = coalesce(v_day.worked_minutes, 0),
          deduction_days = v_days,
          deduction_value = v_value,
          detected_days = round(v_day.deduction_days, 3),
          detected_value = round(v_day.deduction_value, 2),
          reason = coalesce(v_day.reason, ''),
          evidence = coalesce(v_day.evidence, '{}'::jsonb),
          updated_at = now()
        where id = v_line.id;
        v_updated := v_updated + 1;
      end if;
    else
      if v_digest.id is null then
        select coalesce(max(release_round), 0) + 1 into v_round
        from public.attendance_weekly_digests
        where upper(employee_hr_id) = upper(v_hr)
          and cycle_key = p_cycle_key
          and week_index = p_week_index;

        insert into public.attendance_weekly_digests (
          employee_hr_id, cycle_key, week_index, week_start, week_end, status,
          total_deduction_days, total_deduction_value, has_unpriced_day, dry_run, release_round
        ) values (
          v_hr, p_cycle_key, p_week_index, p_week_start, p_week_end, 'awaiting_release',
          0, 0, false, p_dry_run, v_round
        )
        returning * into v_digest;
        v_created := true;
      end if;

      -- A new day starts unticked (owner, 2026-09-15): nothing is deducted unless he ticks it.
      insert into public.attendance_digest_lines (
        digest_id, work_date, status, late_minutes, short_minutes, worked_minutes,
        deduction_days, deduction_value, detected_days, detected_value, reason, evidence, deduct
      ) values (
        v_digest.id, v_day.work_date, v_day.status, coalesce(v_day.late_minutes, 0), coalesce(v_day.short_minutes, 0),
        coalesce(v_day.worked_minutes, 0), round(v_day.deduction_days, 3), round(v_day.deduction_value, 2),
        round(v_day.deduction_days, 3), round(v_day.deduction_value, 2), coalesce(v_day.reason, ''),
        coalesce(v_day.evidence, '{}'::jsonb), false
      );
      v_added := v_added + 1;
    end if;
  end loop;

  if v_digest.id is null then
    return jsonb_build_object(
      'digestId', null, 'releaseRound', null, 'created', false, 'added', 0, 'updated', 0,
      'cleared', 0, 'alreadyElsewhere', v_elsewhere, 'removedDigest', false
    );
  end if;

  -- A waiting day the report now clears — an approved excuse, leave, or a corrected punch — is removed.
  -- Only a day the report positively cleared: a day missing from the report is left alone.
  if array_length(v_cleared_dates, 1) is not null then
    with gone as (
      delete from public.attendance_digest_lines l
      where l.digest_id = v_digest.id
        and l.action = 'pending'
        and l.work_date = any(v_cleared_dates)
        and not exists (select 1 from public.attendance_settlements s where s.digest_line_id = l.id)
      returning 1
    )
    select count(*) into v_cleared from gone;
  end if;

  select
    count(*),
    coalesce(sum(deduction_days) filter (where action <> 'removed' and (deduct or action <> 'pending')), 0),
    coalesce(sum(deduction_value) filter (where action <> 'removed' and (deduct or action <> 'pending')), 0),
    coalesce(bool_or(deduction_value is null) filter (where action <> 'removed' and (deduct or action <> 'pending')), false)
  into v_line_count, v_total_days, v_total_value, v_unpriced
  from public.attendance_digest_lines
  where digest_id = v_digest.id;

  if v_line_count = 0 then
    -- Every day it held was cleared: nothing is left to release.
    delete from public.attendance_weekly_digests where id = v_digest.id and status = 'awaiting_release';
    v_removed_digest := true;
  elsif v_created or v_added > 0 or v_updated > 0 or v_cleared > 0 then
    update public.attendance_weekly_digests set
      total_deduction_days = round(v_total_days, 3),
      total_deduction_value = case when v_unpriced then null else round(v_total_value, 2) end,
      has_unpriced_day = v_unpriced,
      updated_at = now()
    where id = v_digest.id;
  end if;

  return jsonb_build_object(
    'digestId', case when v_removed_digest then null else v_digest.id end,
    'releaseRound', v_digest.release_round,
    'created', v_created and not v_removed_digest,
    'added', v_added,
    'updated', v_updated,
    'cleared', v_cleared,
    'alreadyElsewhere', v_elsewhere,
    'removedDigest', v_removed_digest and not v_created
  );
end;
$$;

revoke execute on function public.phx_attendance_sync_digest_days(text, text, integer, date, date, boolean, jsonb, date[]) from public, anon, authenticated;
grant execute on function public.phx_attendance_sync_digest_days(text, text, integer, date, date, boolean, jsonb, date[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Releasing one digest — only the days the page showed
-- ---------------------------------------------------------------------------
drop function if exists public.phx_attendance_release_digest(bigint, text, date);

create or replace function public.phx_attendance_release_digest(
  p_digest_id bigint,
  p_actor_hr_id text,
  p_answer_due_on date,
  p_seen_line_ids bigint[],
  p_seen_days numeric[]
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_digest public.attendance_weekly_digests;
  v_line public.attendance_digest_lines;
  v_reason constant text := 'Not ticked for deduction when the week was released.';
  v_cleared integer := 0;
  v_pending integer;
  v_disputed integer;
  v_kept integer;
  v_total_days numeric;
  v_total_value numeric;
  v_unpriced boolean;
  v_status text;
begin
  if p_answer_due_on is null or coalesce(btrim(p_actor_hr_id), '') = '' then
    raise exception 'A release needs who released it and the answer deadline.' using errcode = '22023';
  end if;
  if p_seen_line_ids is null or p_seen_days is null
     or coalesce(array_length(p_seen_line_ids, 1), 0) <> coalesce(array_length(p_seen_days, 1), 0) then
    raise exception 'The release did not say which days were on the page.' using errcode = '22023';
  end if;

  select * into v_digest from public.attendance_weekly_digests where id = p_digest_id for update;
  if not found then
    raise exception 'That week was not found.' using errcode = 'P0002';
  end if;
  -- Already released by another click, or a trial run: nothing to do, and nothing is cleared.
  if v_digest.status <> 'awaiting_release' or v_digest.dry_run is distinct from false then
    return jsonb_build_object('released', false, 'status', v_digest.status, 'pendingDays', 0, 'clearedDays', 0);
  end if;

  -- The days waiting now must be the days the page showed, at the figures it showed. The daily job adds
  -- days to a waiting week; one that arrived after the page loaded would be cleared below, unticked,
  -- without the Super Admin ever seeing it — so the whole release is refused and the page reloads.
  if exists (
    select 1
    from public.attendance_digest_lines l
    where l.digest_id = v_digest.id
      and l.action = 'pending'
      and not exists (
        select 1
        from unnest(p_seen_line_ids, p_seen_days) as seen(line_id, days)
        where seen.line_id = l.id
          and round(seen.days, 3) = round(l.deduction_days, 3)
      )
  ) then
    raise exception 'New or changed days arrived in this week after the page was loaded. Reload the page, check the days, then release again.' using errcode = '40001';
  end if;

  -- Every unticked day is cleared. The 'removed' settlement is the record payroll acts on: the bridge
  -- turns it into Do Not Take Action, and recordDecision refuses to approve the day.
  for v_line in
    select * from public.attendance_digest_lines
    where digest_id = v_digest.id and action = 'pending' and deduct = false
    order by work_date
    for update
  loop
    insert into public.attendance_settlements (
      digest_line_id, employee_hr_id, work_date, action, method,
      deduction_days, deduction_value, actor_hr_id, actor_role, reviewer_hr_id, reason
    ) values (
      v_line.id, v_digest.employee_hr_id, v_line.work_date, 'removed', null,
      0, 0, p_actor_hr_id, 'reviewer', p_actor_hr_id, v_reason
    );

    update public.attendance_digest_lines set
      action = 'removed',
      removed_at = now(),
      removed_by_hr_id = p_actor_hr_id,
      remove_reason = v_reason,
      updated_at = now()
    where id = v_line.id;

    v_cleared := v_cleared + 1;
  end loop;

  select
    count(*) filter (where action = 'pending'),
    count(*) filter (where action = 'disputed'),
    count(*) filter (where action <> 'removed'),
    coalesce(sum(deduction_days) filter (where action <> 'removed'), 0),
    coalesce(sum(deduction_value) filter (where action <> 'removed'), 0),
    coalesce(bool_or(deduction_value is null) filter (where action <> 'removed'), false)
  into v_pending, v_disputed, v_kept, v_total_days, v_total_value, v_unpriced
  from public.attendance_digest_lines
  where digest_id = v_digest.id;

  -- Nothing left: void, and nobody is told. Only days answered before the release step existed:
  -- settled. Otherwise open, with the deadline running.
  v_status := case
    when v_kept = 0 then 'void'
    when v_pending = 0 and v_disputed = 0 then 'settled'
    else 'open'
  end;

  update public.attendance_weekly_digests set
    status = v_status,
    released_at = case when v_status = 'void' then null else now() end,
    released_by_hr_id = case when v_status = 'void' then null else p_actor_hr_id end,
    answer_due_on = case when v_status = 'void' then null else p_answer_due_on end,
    total_deduction_days = round(v_total_days, 3),
    total_deduction_value = case when v_unpriced then null else round(v_total_value, 2) end,
    has_unpriced_day = v_unpriced,
    updated_at = now()
  where id = v_digest.id;

  return jsonb_build_object(
    'released', v_status <> 'void',
    'status', v_status,
    'pendingDays', v_pending,
    'clearedDays', v_cleared
  );
end;
$$;

revoke execute on function public.phx_attendance_release_digest(bigint, text, date, bigint[], numeric[]) from public, anon, authenticated;
grant execute on function public.phx_attendance_release_digest(bigint, text, date, bigint[], numeric[]) to service_role;

notify pgrst, 'reload schema';

commit;
