-- Weekly attendance review — the Super Admin chooses the days. Owner decision 2026-09-15, the same
-- day the release step shipped (PR 3860):
--
--   "I want to be able to select the week I want. And in the week I select … I can mark on the days
--    that I want them to be deducted. … I want full control."
--
-- Answers he chose in chat the same day:
--   • only the FLAGGED days can be ticked
--   • every day starts UNTICKED — nothing is deducted unless he ticks it; an unticked day is cleared
--   • the week picker covers the current payroll month (a paid month stays closed)
--   • a ticked day's number of days can be edited, DOWN or UP ("Raise too")
--
-- WHAT CHANGES
--   A line now carries `deduct` (his tick) and `detected_days` / `detected_value` (what the
--   fingerprint report found, kept when he changes the figure). `deduction_days` stays the figure
--   everything downstream already reads — the employee's page, the annual balance charge, the
--   settlement — so an edited figure reaches all of them without a second column to keep in step.
--
--   Release is one function per digest. Under the digest row lock it clears every unticked pending
--   day (a `removed` settlement, which the month-end bridge turns into Do Not Take Action), then opens
--   the week. A tick and a release therefore cannot interleave: the tick takes the same lock and
--   refuses once the week is no longer waiting.
--
-- Existing rows: every line gets its detected figures copied from what it has now. On production on
-- 2026-09-15 that is 25 lines (14 in the 7–13 Sep week, 11 in the voided trial week). All start
-- unticked, which is exactly the owner's chosen start state.

begin;

-- ---------------------------------------------------------------------------
-- 1. Lines: the tick, and what was detected
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_lines add column if not exists deduct boolean not null default false;
alter table public.attendance_digest_lines add column if not exists detected_days numeric(8,3) null;
alter table public.attendance_digest_lines add column if not exists detected_value numeric(12,2) null;
alter table public.attendance_digest_lines add column if not exists adjusted_by_hr_id text null;
alter table public.attendance_digest_lines add column if not exists adjusted_at timestamptz null;

comment on column public.attendance_digest_lines.deduct is
  'Ticked by the Super Admin on the weekly review page before release. An unticked pending day is cleared (removed) when the week is released. Owner 2026-09-15: every day starts unticked.';
comment on column public.attendance_digest_lines.detected_days is
  'The days the fingerprint report detected. deduction_days is the figure charged, which the Super Admin may change before release, up or down.';

update public.attendance_digest_lines
set detected_days = deduction_days,
    detected_value = deduction_value
where detected_days is null;

-- ---------------------------------------------------------------------------
-- 2. Ticking a day, and changing its days — before release only
-- ---------------------------------------------------------------------------
create or replace function public.phx_attendance_mark_digest_line(
  p_line_id bigint,
  p_deduct boolean,
  p_days numeric,
  p_actor_hr_id text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_line public.attendance_digest_lines;
  v_digest public.attendance_weekly_digests;
  v_detected_days numeric;
  v_detected_value numeric;
  v_days numeric;
  v_value numeric;
  v_adjusted boolean;
  v_total_days numeric;
  v_total_value numeric;
  v_unpriced boolean;
begin
  if p_deduct is null then
    raise exception 'Say whether this day is deducted.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_actor_hr_id), '') = '' then
    raise exception 'The person making this change is not known.' using errcode = '22023';
  end if;

  -- Lock the WEEK first, then the day — the order release takes them in. The other order deadlocks
  -- a tick against a release of the same employee's week.
  select * into v_digest from public.attendance_weekly_digests
  where id = (select digest_id from public.attendance_digest_lines where id = p_line_id)
  for update;
  if not found then
    raise exception 'That day was not found.' using errcode = 'P0002';
  end if;
  select * into v_line from public.attendance_digest_lines where id = p_line_id and digest_id = v_digest.id for update;
  if not found then
    raise exception 'That day was not found.' using errcode = 'P0002';
  end if;
  if v_digest.dry_run is distinct from false then
    raise exception 'This week was built as a trial run and cannot be changed.' using errcode = '40001';
  end if;
  if v_digest.status <> 'awaiting_release' then
    raise exception 'This week has already been released, so its days can no longer be changed.' using errcode = '40001';
  end if;
  if v_line.action <> 'pending' then
    raise exception 'That day has already been answered — reload and look again.' using errcode = '40001';
  end if;

  v_detected_days := coalesce(v_line.detected_days, v_line.deduction_days);
  v_detected_value := case when v_line.detected_days is null then v_line.deduction_value else v_line.detected_value end;
  v_days := coalesce(round(p_days, 3), v_line.deduction_days);
  -- More than zero (untick instead), at most 3: a typo guard, since he may raise the figure.
  if v_days <= 0 or v_days > 3 then
    raise exception 'One day can deduct more than 0 and at most 3 days.' using errcode = '22023';
  end if;
  v_adjusted := v_days <> v_detected_days;
  -- The estimate follows the days. An unpriced day stays unpriced — NULL is "not yet calculated",
  -- never "free".
  v_value := case
    when not v_adjusted then v_detected_value
    when v_detected_value is null or v_detected_days <= 0 then null
    else round(v_detected_value * v_days / v_detected_days, 2)
  end;

  update public.attendance_digest_lines set
    deduct = p_deduct,
    deduction_days = v_days,
    deduction_value = v_value,
    detected_days = v_detected_days,
    detected_value = v_detected_value,
    adjusted_by_hr_id = case when v_adjusted then p_actor_hr_id else null end,
    adjusted_at = case when v_adjusted then now() else null end,
    updated_at = now()
  where id = v_line.id;

  -- The week's total is what will be asked about: ticked days, plus any day already answered.
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
    'lineId', v_line.id,
    'digestId', v_digest.id,
    'workDate', v_line.work_date,
    'deduct', p_deduct,
    'deductionDays', v_days,
    'deductionValue', v_value,
    'detectedDays', v_detected_days,
    'adjusted', v_adjusted,
    'totalDeductionDays', round(v_total_days, 3),
    'totalDeductionValue', case when v_unpriced then null else round(v_total_value, 2) end,
    'hasUnpricedDay', v_unpriced
  );
end;
$$;

revoke execute on function public.phx_attendance_mark_digest_line(bigint, boolean, numeric, text) from public, anon, authenticated;
grant execute on function public.phx_attendance_mark_digest_line(bigint, boolean, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Releasing one digest — clear the unticked days, then open the week
-- ---------------------------------------------------------------------------
create or replace function public.phx_attendance_release_digest(
  p_digest_id bigint,
  p_actor_hr_id text,
  p_answer_due_on date
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

  select * into v_digest from public.attendance_weekly_digests where id = p_digest_id for update;
  if not found then
    raise exception 'That week was not found.' using errcode = 'P0002';
  end if;
  -- Already released by another click, or a trial run: nothing to do, and nothing is cleared.
  if v_digest.status <> 'awaiting_release' or v_digest.dry_run is distinct from false then
    return jsonb_build_object('released', false, 'status', v_digest.status, 'pendingDays', 0, 'clearedDays', 0);
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

revoke execute on function public.phx_attendance_release_digest(bigint, text, date) from public, anon, authenticated;
grant execute on function public.phx_attendance_release_digest(bigint, text, date) to service_role;

notify pgrst, 'reload schema';

commit;
