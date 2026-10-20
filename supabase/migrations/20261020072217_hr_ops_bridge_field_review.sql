-- hr_ops_bridge_field_review
--
-- WHAT THIS CHANGES: how a decision taken in the HR Operations Specialist's Daily & Weekly Reports
--   (src/lib/hr-ops-reports/, tables from 20261020065354_hr_ops_reports.sql) reaches the weekly
--   attendance review and, through it, payroll. The app side is src/lib/hr-ops-reports/bridge.ts.
--   1. One new weekly-review day kind on public.attendance_digest_lines.status: field_review — a
--      field day the Super Admin decided in the HR ops report ("Field Day (Reviewed)"). Paid through
--      the CRM column, by its own deduction category below. An OFFICE day gets no kind of its own: its
--      decision is set on the fingerprint day the daily job already holds, through the tick path, and
--      the month-end Fingerprint connector stays that day's only deduction writer.
--   2. Three columns on public.attendance_digest_lines saying a day came from that report:
--      hr_ops_line_id (the report line, unique, nulled if the line is ever deleted),
--      hr_ops_decided_by_hr_id and hr_ops_decided_at (who decided it, and when).
--   3. The deduction category `field_review` ("Field Day (Reviewed)"): the CHECK on
--      public.deductions_categories and its row — approval required, paid through `crm`, sort 10.
--   4. phx_attendance_sync_digest_days — the daily job that brings a week up to date — never
--      refreshes, overwrites or removes a day the bridge wrote or set (hr_ops_line_id set, or a
--      field_review day). Everything else in it is byte-for-byte the body of
--      20260917120000_weekly_review_live_weeks.sql (md5 175dafd3e3b0da7682581514af63cff6 on production
--      on 2026-10-20, identical to the repo).
--   5. phx_attendance_settle_digest_line — the annual-balance double-charge guard reads the day's
--      `field_review` deduction for a field_review day, and the `fingerprint` one for every other day
--      (unchanged). Everything else is the body of 20260915210000_weekly_digest_release_and_balance_choice.sql.
--   6. phx_hr_ops_bridge_digest_day — the one narrow write the bridge makes: under the same advisory
--      lock and row locks the daily job, a tick and a release take, it either sets an existing waiting
--      day to the decided days through phx_attendance_mark_digest_line (the existing tick path), or —
--      for a FIELD day only — adds the day to the week waiting for release, ticked, at the decided days.
--      It never adds an office day: one the review does not hold yet waits for the daily job to add it.
--      It refuses a day in a released week, a day already answered, and days that differ from the
--      recorded decision.
-- WHY: owner, 2026-10-20 — the HR ops reports are reviewed by her and decided by him "in days only",
--   and a decision must reach the employee's weekly attendance review and payroll the way a fingerprint
--   day does: the employee chooses salary or annual balance, may dispute, and the answer is applied to
--   the month-end deduction by digest-bridge.ts through recordDecision.
-- ROLLBACK:
--   drop function public.phx_hr_ops_bridge_digest_day(uuid, text, text, date, text, integer, date, date, numeric, numeric, text, jsonb, text, timestamptz, boolean);
--   re-run section 3 of 20260917120000_weekly_review_live_weeks.sql (the sync) and the settle function
--   of 20260915210000_weekly_digest_release_and_balance_choice.sql;
--   the status CHECK, the category CHECK and the category row can only go back once no row uses them
--   (a field_review day, a field_review candidate) — those rows are payroll history and
--   are not deleted by a rollback. The three columns can be dropped once nothing reads them.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: no row is written or changed; two CHECKs are widened, three nullable columns are
-- added, one category row is inserted, and three functions are replaced or added.

begin;

-- ---------------------------------------------------------------------------
-- 1. The one new day kind
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_lines drop constraint if exists attendance_digest_lines_status_check;
alter table public.attendance_digest_lines
  add constraint attendance_digest_lines_status_check check (
    status = any (array['late', 'short_hours', 'early_leave', 'missing_punch', 'field_review']::text[])
  );

-- ---------------------------------------------------------------------------
-- 2. Where a day came from
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_lines
  add column if not exists hr_ops_line_id uuid null references public.hr_ops_report_lines (id) on delete set null;
alter table public.attendance_digest_lines add column if not exists hr_ops_decided_by_hr_id text null;
alter table public.attendance_digest_lines add column if not exists hr_ops_decided_at timestamptz null;

-- One review day per HR ops decision: a bridge run that fires twice finds its own day instead of adding
-- a second one.
create unique index if not exists attendance_digest_lines_hr_ops_line_idx
  on public.attendance_digest_lines (hr_ops_line_id)
  where hr_ops_line_id is not null;

comment on column public.attendance_digest_lines.hr_ops_line_id is
  'The HR operations report line (hr_ops_report_lines) whose decision set or added this day. The daily job never refreshes, overwrites or removes such a day (phx_attendance_sync_digest_days).';
comment on column public.attendance_digest_lines.hr_ops_decided_by_hr_id is
  'Who decided this day in the HR operations report.';
comment on column public.attendance_digest_lines.hr_ops_decided_at is
  'When this day was decided in the HR operations report.';

-- ---------------------------------------------------------------------------
-- 3. The deduction category `field_review`
-- ---------------------------------------------------------------------------
-- Two gates, both opened (see 20261012120000_deductions_no_weekly_plan_category.sql): the CHECK below,
-- and the row, because deductions_candidates, deductions_publication_lines and daily_deductions_lines
-- reference deductions_categories(category). The list is the live constraint read on production on
-- 2026-10-20 plus the one new value; nothing is dropped.
alter table public.deductions_categories
  drop constraint if exists deductions_categories_category_check;

alter table public.deductions_categories
  add constraint deductions_categories_category_check check (
    category = any (array[
      'fingerprint',
      'crm',
      'crm_half_day',
      'no_records_activity',
      'unpaid_vacation',
      'insufficient_balance_vacation',
      'no_weekly_plan',
      'loan',
      'other',
      'field_review'
    ]::text[])
  );

-- Approval required: nothing is charged until the weekly review's answer is applied to it (or a person
-- decides it). Paid through the CRM column, beside crm and crm_half_day.
insert into public.deductions_categories (category, label, detection_engine, requires_approval, salary_records_column, sort_order)
values ('field_review', 'Field Day (Reviewed)', 'hr_ops_report', true, 'crm', 10)
on conflict (category) do update
  set label = excluded.label,
      detection_engine = excluded.detection_engine,
      requires_approval = excluded.requires_approval,
      salary_records_column = excluded.salary_records_column,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 4. The daily job never touches a day the bridge wrote or set
-- ---------------------------------------------------------------------------
-- Two lines differ from 20260917120000_weekly_review_live_weeks.sql, each marked "HR ops bridge":
-- the refresh of a waiting day skips it, and the removal of a day the report has since cleared
-- leaves it. A day decided by a person is not the report's to move.
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
      -- HR ops bridge: a day decided in the HR operations report keeps the decision — the report never
      -- refreshes or overwrites it.
      if v_line.hr_ops_line_id is not null or v_line.status = 'field_review' then
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
        -- HR ops bridge: a day decided in the HR operations report is never removed by the report.
        and l.hr_ops_line_id is null and l.status <> 'field_review'
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
-- 5. The balance guard reads the day's own deduction category
-- ---------------------------------------------------------------------------
-- One line differs from 20260915210000_weekly_digest_release_and_balance_choice.sql, marked
-- "HR ops bridge": a field_review day's month-end deduction is a `field_review` candidate, so the guard
-- that refuses annual balance once payroll has decided the day reads that one. Every other day reads
-- `fingerprint`, exactly as before.
create or replace function public.phx_attendance_settle_digest_line(
  p_line_id bigint,
  p_expected_actions text[],
  p_action text,
  p_method text,
  p_actor_hr_id text,
  p_actor_role text,
  p_reviewer_hr_id text,
  p_reason text,
  p_review_notes text,
  p_period_start date,
  p_period_end date,
  p_seen_request_days numeric,
  p_seen_charge_days numeric,
  p_seen_copilot_days numeric
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_line public.attendance_digest_lines;
  v_digest public.attendance_weekly_digests;
  v_charges_balance boolean;
  v_request_days numeric;
  v_charge_days numeric;
  v_copilot_days numeric;
  v_settlement_id bigint;
  v_days numeric;
  v_value numeric;
  v_remaining integer;
begin
  if p_action not in ('salary', 'annual_balance', 'auto_salary', 'dispute_upheld', 'dispute_rejected') then
    raise exception 'Unsupported settlement action %', p_action using errcode = '22023';
  end if;
  if p_method is not null and p_method not in ('salary', 'annual_balance') then
    raise exception 'Unsupported settlement method %', p_method using errcode = '22023';
  end if;

  select * into v_line from public.attendance_digest_lines where id = p_line_id for update;
  if not found then
    raise exception 'Digest line was not found.' using errcode = 'P0002';
  end if;
  if not (v_line.action = any (p_expected_actions)) then
    raise exception 'That day has already been answered — reload and look again.' using errcode = '40001';
  end if;

  select * into v_digest from public.attendance_weekly_digests where id = v_line.digest_id for update;
  if v_digest.status <> 'open' then
    raise exception 'This week is not open for answers.' using errcode = '40001';
  end if;
  -- A trial-run week is never released (owner 2026-09-15), so nothing in one may settle — not an
  -- answer, not a dispute decision, not the deadline sweep. The callers check too; this is the floor.
  if v_digest.dry_run is distinct from false then
    raise exception 'This week was built as a trial run and can never be settled.' using errcode = '40001';
  end if;

  v_charges_balance :=
    p_action = 'annual_balance'
    or (p_action = 'dispute_rejected' and p_method = 'annual_balance');

  v_days := v_line.deduction_days;
  v_value := case
    when p_action = 'dispute_upheld' then 0
    when v_charges_balance then 0
    else v_line.deduction_value
  end;

  if v_charges_balance then
    if p_period_start is null or p_period_end is null then
      raise exception 'An annual balance charge needs its balance period.' using errcode = '22023';
    end if;

    -- Same lock key as phx_apply_vacation_paid_approval, so a leave approval and a balance
    -- charge for one employee can never interleave.
    perform pg_advisory_xact_lock(hashtext(lower(v_digest.employee_hr_id)));

    -- THE DOUBLE-CHARGE GUARD. A balance charge is immutable, and salary is spared only because
    -- digest-bridge.ts later closes the day's month-end deduction with "Do Not Take Action" — which
    -- it can do only while that deduction is still Pending and unlocked. Once someone has decided
    -- it (approved it for payroll, or cleared it) or a publication has locked it, a balance charge
    -- would take the day twice or spend leave on a day payroll never charges. So refuse, and the
    -- employee is left with salary. recordDecision guards the other order: a day already charged
    -- to balance cannot be approved for payroll.
    if exists (
      select 1
      from public.deductions_candidates c
      left join public.deductions_decisions d on d.candidate_id = c.id
      -- HR ops bridge: a reviewed field day is charged by its own `field_review` deduction.
      where c.category = case when v_line.status = 'field_review' then 'field_review' else 'fingerprint' end
        and c.superseded_at is null
        and lower(c.source_record_id) = lower(v_digest.employee_hr_id || ':' || v_line.work_date::text)
        and (c.locked_at is not null or coalesce(d.decision_status, 'Pending') <> 'Pending')
    ) then
      raise exception 'This day has already been decided in the month-end deductions review, so annual balance can no longer be used for it.'
        using errcode = '55000';
    end if;

    select coalesce(sum(paid_duration_days), 0) into v_request_days
    from public.v2_vacation_requests
    where lower(employee_hr_id) = lower(v_digest.employee_hr_id)
      and status = 'approved'
      and vacation_type in ('annual', 'emergency')
      and start_date >= p_period_start
      and start_date <  p_period_end;

    select coalesce(sum(days), 0) into v_charge_days
    from public.attendance_annual_balance_charges
    where lower(employee_hr_id) = lower(v_digest.employee_hr_id)
      and work_date >= p_period_start
      and work_date <  p_period_end;

    select coalesce(sum(balance_days_consumed), 0) into v_copilot_days
    from public.payroll_copilot_vacation_settlements
    where employee_hr_id_compact = regexp_replace(lower(v_digest.employee_hr_id), '[^a-z0-9]+', '', 'g')
      and settlement_method in ('balance', 'partial_balance', 'defer_to_balance')
      and superseded_at is null
      and start_date >= p_period_start
      and start_date <  p_period_end;

    if round(v_request_days, 3) <> round(coalesce(p_seen_request_days, -1), 3)
       or round(v_charge_days, 3) <> round(coalesce(p_seen_charge_days, -1), 3)
       or round(v_copilot_days, 3) <> round(coalesce(p_seen_copilot_days, -1), 3) then
      raise exception 'The annual balance changed while this was being saved. Reload and try again.'
        using errcode = '40001';
    end if;
  end if;

  insert into public.attendance_settlements (
    digest_line_id, employee_hr_id, work_date, action, method,
    deduction_days, deduction_value, actor_hr_id, actor_role, reviewer_hr_id, reason
  ) values (
    v_line.id, v_digest.employee_hr_id, v_line.work_date, p_action,
    case
      when p_action in ('salary', 'auto_salary') then 'salary'
      when p_action = 'annual_balance' then 'annual_balance'
      else p_method
    end,
    case when p_action = 'dispute_upheld' then 0 else v_days end,
    v_value, p_actor_hr_id, p_actor_role, p_reviewer_hr_id, p_reason
  )
  returning id into v_settlement_id;

  if v_charges_balance then
    insert into public.attendance_annual_balance_charges (
      settlement_id, digest_line_id, employee_hr_id, work_date, days, period_start, period_end, created_by
    ) values (
      v_settlement_id, v_line.id, v_digest.employee_hr_id, v_line.work_date, v_days,
      p_period_start, p_period_end, coalesce(p_reviewer_hr_id, p_actor_hr_id)
    );
  end if;

  update public.attendance_digest_lines set
    action = p_action,
    chosen_method = case
      when p_action in ('salary', 'auto_salary') then 'salary'
      when p_action = 'annual_balance' then 'annual_balance'
      -- A rejected dispute records the method actually applied, which is salary when the
      -- balance the employee chose no longer covered the day.
      when p_action = 'dispute_rejected' then coalesce(p_method, chosen_method)
      else chosen_method
    end,
    review_notes = coalesce(p_review_notes, review_notes),
    acted_at = case when p_action in ('dispute_upheld', 'dispute_rejected') then acted_at else now() end,
    updated_at = now()
  where id = v_line.id;

  select count(*) into v_remaining
  from public.attendance_digest_lines
  where digest_id = v_digest.id
    and action in ('pending', 'disputed');
  if v_remaining = 0 then
    update public.attendance_weekly_digests
      set status = 'settled', updated_at = now()
      where id = v_digest.id and status = 'open';
  end if;

  return jsonb_build_object('settlementId', v_settlement_id, 'chargedBalance', v_charges_balance, 'digestSettled', v_remaining = 0);
end;
$$;

revoke execute on function public.phx_attendance_settle_digest_line(bigint, text[], text, text, text, text, text, text, text, date, date, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.phx_attendance_settle_digest_line(bigint, text[], text, text, text, text, text, text, text, date, date, numeric, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The bridge's one write
-- ---------------------------------------------------------------------------
-- Outcomes (jsonb `outcome`):
--   bridged       the day holds the decided days, ticked, in the week waiting for release
--                 (`created` = the bridge added a field day; `alreadyBridged` = a re-run found its own day)
--   waiting       the review holds no such day yet and the bridge may not add it — every office day, and
--                 a field day of a week the review no longer takes days for (p_allow_insert = false) —
--                 nothing written; the day is set once the daily job adds it
--   week_released the day is in a week already released, or already answered — or, with no such day,
--                 the employee's week has already gone out with nothing of it still waiting for
--                 release — nothing written
--   conflict      the day is held by another decision or as the other kind of day — nothing written
create or replace function public.phx_hr_ops_bridge_digest_day(
  p_hr_ops_line_id uuid,
  p_section text,
  p_employee_hr_id text,
  p_work_date date,
  p_cycle_key text,
  p_week_index integer,
  p_week_start date,
  p_week_end date,
  p_days numeric,
  p_value numeric,
  p_reason text,
  p_evidence jsonb,
  p_decided_by_hr_id text,
  p_decided_at timestamptz,
  p_allow_insert boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_hr text := btrim(coalesce(p_employee_hr_id, ''));
  v_actor text := btrim(coalesce(p_decided_by_hr_id, ''));
  v_days numeric := round(p_days, 3);
  v_found_id bigint;
  v_line public.attendance_digest_lines;
  v_digest public.attendance_weekly_digests;
  v_round smallint;
  v_digest_created boolean := false;
  v_total_days numeric;
  v_total_value numeric;
  v_unpriced boolean;
begin
  if p_hr_ops_line_id is null or coalesce(p_section, '') not in ('office', 'field') or v_hr = '' or v_actor = ''
     or p_work_date is null or coalesce(p_cycle_key, '') !~ '^\d{4}-\d{2}$'
     or p_week_index is null or p_week_index not between 1 and 5
     or p_week_start is null or p_week_end is null or p_work_date < p_week_start or p_work_date > p_week_end
     or p_allow_insert is null
     or (p_evidence is not null and jsonb_typeof(p_evidence) <> 'object') then
    raise exception 'The day to carry into the weekly attendance review is not valid.' using errcode = '22023';
  end if;
  -- The same typo guard a tick has: more than 0 (a zero decision deducts nothing) and at most 3.
  if v_days is null or v_days <= 0 or v_days > 3 then
    raise exception 'One day can deduct more than 0 and at most 3 days.' using errcode = '22023';
  end if;
  -- The days carried are the days decided — the database refuses anything else.
  if not exists (
    select 1
    from public.hr_ops_report_lines r
    where r.id = p_hr_ops_line_id
      and r.section = p_section
      and r.work_date = p_work_date
      and (r.hr_key = lower(v_hr) or upper(btrim(r.hr_id)) = upper(v_hr))
      and r.decision = 'approved'
      and round(r.decided_days, 3) = v_days
  ) then
    raise exception 'That HR operations decision was not found, or does not approve these days for this person and day.' using errcode = 'P0002';
  end if;

  -- The same lock the daily job takes for this employee-week, so the two never interleave.
  perform pg_advisory_xact_lock(hashtextextended('attendance_digest_sync:' || upper(v_hr) || ':' || p_cycle_key || ':' || p_week_index::text, 0));

  -- Already carried by an earlier run: the same day, nothing new.
  select l.id into v_found_id from public.attendance_digest_lines l where l.hr_ops_line_id = p_hr_ops_line_id;
  if v_found_id is null then
    -- The employee's day wherever it is — one day is held by one week (the daily job's own rule).
    select l.id into v_found_id
    from public.attendance_digest_lines l
    join public.attendance_weekly_digests g on g.id = l.digest_id
    where upper(g.employee_hr_id) = upper(v_hr)
      and g.dry_run = false
      and l.work_date = p_work_date
    order by l.id
    limit 1;
  end if;

  if v_found_id is not null then
    -- WEEK first, then the day: the order a tick and a release take them in.
    select * into v_digest from public.attendance_weekly_digests
    where id = (select digest_id from public.attendance_digest_lines where id = v_found_id)
    for update;
    select * into v_line from public.attendance_digest_lines where id = v_found_id for update;

    if v_line.hr_ops_line_id = p_hr_ops_line_id then
      -- A re-run (an earlier run wrote the day, then failed on its deduction). The decision is the one
      -- recorded now: while the day still waits for release, a figure that moved since the first run
      -- follows it through the same tick path. A day he unticked on the review page stays unticked.
      if v_digest.status = 'awaiting_release' and v_digest.dry_run = false and v_line.action = 'pending'
         and round(v_line.deduction_days, 3) <> v_days then
        perform public.phx_attendance_mark_digest_line(v_line.id, true, v_days, v_actor);
      end if;
      return jsonb_build_object(
        'outcome', 'bridged', 'lineId', v_line.id, 'digestId', v_digest.id,
        'digestEmployeeHrId', v_digest.employee_hr_id, 'lineStatus', v_line.status,
        'digestStatus', v_digest.status, 'created', false, 'alreadyBridged', true
      );
    end if;
    if v_line.hr_ops_line_id is not null then
      return jsonb_build_object(
        'outcome', 'conflict', 'lineId', v_line.id, 'digestId', v_digest.id,
        'message', 'This day was already decided by another line of the HR operations reports.'
      );
    end if;
    if v_digest.dry_run is distinct from false or v_digest.status <> 'awaiting_release' or v_line.action <> 'pending' then
      return jsonb_build_object(
        'outcome', 'week_released', 'lineId', v_line.id, 'digestId', v_digest.id,
        'digestStatus', v_digest.status, 'lineAction', v_line.action
      );
    end if;
    if (p_section = 'field') <> (v_line.status = 'field_review') then
      return jsonb_build_object(
        'outcome', 'conflict', 'lineId', v_line.id, 'digestId', v_digest.id,
        'message', case
          when p_section = 'field' then 'The weekly attendance review already holds this day as a fingerprint day, so a field decision cannot be added beside it. Decide it on the Weekly Attendance Review page.'
          else 'The weekly attendance review holds this day as a reviewed field day, so an office decision cannot be added beside it.'
        end
      );
    end if;

    update public.attendance_digest_lines set
      hr_ops_line_id = p_hr_ops_line_id,
      hr_ops_decided_by_hr_id = v_actor,
      hr_ops_decided_at = coalesce(p_decided_at, now()),
      updated_at = now()
    where id = v_line.id;
    -- The existing tick path: ticked, at the decided days, recorded as his change when it differs from
    -- what the report detected, and the week's total recomputed.
    perform public.phx_attendance_mark_digest_line(v_line.id, true, v_days, v_actor);

    return jsonb_build_object(
      'outcome', 'bridged', 'lineId', v_line.id, 'digestId', v_digest.id,
      'digestEmployeeHrId', v_digest.employee_hr_id, 'lineStatus', v_line.status,
      'digestStatus', v_digest.status, 'created', false, 'alreadyBridged', false
    );
  end if;

  -- No day yet. An office day is only ever the daily job's to add — the month-end Fingerprint connector
  -- stays its one deduction writer — so the bridge never adds one; nor a field day it may not add.
  if p_section <> 'field' or not p_allow_insert then
    -- The employee's week already went out and nothing of it still waits for release: the decision
    -- arrived too late to be set on a day, and says so rather than waiting.
    if exists (
         select 1 from public.attendance_weekly_digests g
         where upper(g.employee_hr_id) = upper(v_hr) and g.cycle_key = p_cycle_key and g.week_index = p_week_index
           and g.dry_run = false and g.status <> 'awaiting_release'
       )
       and not exists (
         select 1 from public.attendance_weekly_digests g
         where upper(g.employee_hr_id) = upper(v_hr) and g.cycle_key = p_cycle_key and g.week_index = p_week_index
           and g.dry_run = false and g.status = 'awaiting_release'
       ) then
      return jsonb_build_object('outcome', 'week_released', 'lineId', null, 'lineAction', null);
    end if;
    return jsonb_build_object('outcome', 'waiting');
  end if;

  select * into v_digest
  from public.attendance_weekly_digests
  where upper(employee_hr_id) = upper(v_hr)
    and cycle_key = p_cycle_key
    and week_index = p_week_index
    and status = 'awaiting_release'
    and dry_run = false
  order by id
  limit 1
  for update;

  if v_digest.id is null then
    -- Exactly as the daily job opens a week: the next release round, waiting for release.
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
      0, 0, false, false, v_round
    )
    returning * into v_digest;
    v_digest_created := true;
  end if;

  -- Ticked: he has already decided it. It still waits for his release like every other day, and the
  -- employee then chooses salary or annual balance, or disputes it.
  insert into public.attendance_digest_lines (
    digest_id, work_date, status, late_minutes, short_minutes, worked_minutes,
    deduction_days, deduction_value, detected_days, detected_value, reason, evidence, deduct,
    hr_ops_line_id, hr_ops_decided_by_hr_id, hr_ops_decided_at
  ) values (
    v_digest.id, p_work_date, 'field_review', 0, 0, 0,
    v_days, round(p_value, 2), v_days, round(p_value, 2), coalesce(p_reason, ''), coalesce(p_evidence, '{}'::jsonb), true,
    p_hr_ops_line_id, v_actor, coalesce(p_decided_at, now())
  )
  returning * into v_line;

  -- The week's total, counted the way the daily job and a tick count it.
  select
    coalesce(sum(deduction_days), 0),
    coalesce(sum(deduction_value), 0),
    coalesce(bool_or(deduction_value is null), false)
  into v_total_days, v_total_value, v_unpriced
  from public.attendance_digest_lines
  where digest_id = v_digest.id
    and action <> 'removed'
    and (deduct or action <> 'pending');

  update public.attendance_weekly_digests set
    total_deduction_days = round(v_total_days, 3),
    total_deduction_value = case when v_unpriced then null else round(v_total_value, 2) end,
    has_unpriced_day = v_unpriced,
    updated_at = now()
  where id = v_digest.id;

  return jsonb_build_object(
    'outcome', 'bridged', 'lineId', v_line.id, 'digestId', v_digest.id,
    'digestEmployeeHrId', v_digest.employee_hr_id, 'lineStatus', v_line.status,
    'digestStatus', v_digest.status, 'created', true, 'digestCreated', v_digest_created, 'alreadyBridged', false
  );
end;
$$;

revoke execute on function public.phx_hr_ops_bridge_digest_day(uuid, text, text, date, text, integer, date, date, numeric, numeric, text, jsonb, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.phx_hr_ops_bridge_digest_day(uuid, text, text, date, text, integer, date, date, numeric, numeric, text, jsonb, text, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Proof
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'attendance_digest_lines_status_check'
                           and conrelid = 'public.attendance_digest_lines'::regclass)) not like '%field_review%' then
    raise exception 'the digest line status check does not allow the reviewed field day';
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'deductions_categories_category_check'
                           and conrelid = 'public.deductions_categories'::regclass)) not like '%field_review%' then
    raise exception 'the deduction category check does not allow field_review';
  end if;
  if not exists (
    select 1 from public.deductions_categories
    where category = 'field_review' and requires_approval = true and salary_records_column = 'crm'
  ) then
    raise exception 'the field_review category row is missing or wrong';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'attendance_digest_lines_hr_ops_line_idx') then
    raise exception 'the one-day-per-decision index is missing';
  end if;
  if (select prosrc from pg_proc where oid = 'public.phx_attendance_sync_digest_days(text, text, integer, date, date, boolean, jsonb, date[])'::regprocedure)
     not like '%v_line.hr_ops_line_id is not null or v_line.status = ''field_review''%'
     or (select prosrc from pg_proc where oid = 'public.phx_attendance_sync_digest_days(text, text, integer, date, date, boolean, jsonb, date[])'::regprocedure)
     not like '%l.hr_ops_line_id is null and l.status <> ''field_review''%' then
    raise exception 'the daily job does not protect a day decided in the HR operations report';
  end if;
  foreach v_fn in array array[
    'public.phx_attendance_sync_digest_days(text, text, integer, date, date, boolean, jsonb, date[])',
    'public.phx_attendance_settle_digest_line(bigint, text[], text, text, text, text, text, text, text, date, date, numeric, numeric, numeric)',
    'public.phx_hr_ops_bridge_digest_day(uuid, text, text, date, text, integer, date, date, numeric, numeric, text, jsonb, text, timestamptz, boolean)'
  ] loop
    if not (select prosecdef from pg_proc where oid = v_fn::regprocedure) then
      raise exception '% is not SECURITY DEFINER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '% is callable by a browser role', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '% is not callable by the server', v_fn;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
