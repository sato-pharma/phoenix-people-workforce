-- Deduct from leave balance — a CRM day or a CRM half day can be taken from the employee's annual
-- leave instead of from salary. Owner request 2026-10-09, in his words: "if someone have a crm with
-- no record or half day day, instead of deducting from salary, add a button deduct from leave
-- balance / entitlement, and when it appears in his leave report it must show him the comment that
-- I will write."
--
-- Answers he gave in chat the same day:
--   - balance = ANNUAL only
--   - when the balance is shorter than the deduction: take what is there, the rest stays on salary
--   - the comment is REQUIRED and the employee sees it exactly as written (no notification)
--   - it can be undone: a "Return to salary" button gives the days back and puts the row back to Pending
--
-- WHY THE SAME LEDGER. attendance_annual_balance_charges is already the place every annual balance
-- read sums to learn what leave was spent on a deduction: the app's attendanceChargedDaysInPeriod
-- and the three database functions (phx_attendance_balance_inputs, phx_attendance_settle_digest_line,
-- phx_apply_vacation_paid_approval) all total its `days` by employee and work_date inside the
-- balance period. Rows written here are counted by every one of them with NO function redefined, so a
-- leave request approved tomorrow cannot spend the days a CRM deduction took today, and a reversal
-- (a negative row, exactly as the dispute centre's give-back) nets itself out of every reader.
--
-- WHAT CHANGES, and what still holds:
--   - `source` says who wrote a row. 'weekly_review' (every existing row) keeps its exact shape;
--     'deductions' is new and carries the deduction it paid (deduction_candidate_id), the comment the
--     Super Admin wrote, and no settlement and no digest line.
--   - A deductions charge is positive and needs a non-empty comment. Its reversal is negative,
--     mirrors it exactly, and carries a reason — the same shape the dispute centre's give-back has.
--   - One weekly-review charge per employee-day still holds (the index now says so). A deductions
--     charge is NOT limited that way: it can be returned and made again, and the RPC refuses a second
--     live charge for one deduction instead.
--   - Insert-only still holds: the immutability trigger is untouched.
--
-- Rollback (nothing else depends on it):
--   drop function public.phx_deductions_charge_leave_balance(uuid, text, date, numeric, text, text, date, date, numeric, numeric, numeric);
--   drop function public.phx_deductions_return_leave_balance(uuid, text, text);
--   -- then restore the checks and index from 20261009120000_dispute_center.sql section 7, after
--   -- deleting the source = 'deductions' rows (their balance days are given back by that delete).

begin;

-- The reversal columns and their guard come from 20261009120000_dispute_center.sql, section 7. They are
-- repeated here, all idempotent, so this file stands on its own wherever that one has not run yet
-- (production on 2026-10-09 had the dispute tables but not section 7). If that migration is applied
-- AFTER this one, its days_check replaces the one below and a deductions charge is refused — apply
-- it first, or re-run this file after it.
alter table public.attendance_annual_balance_charges
  add column if not exists reverses_charge_id bigint references public.attendance_annual_balance_charges (id),
  add column if not exists reversal_reason text;
create unique index if not exists attendance_annual_balance_charges_one_reversal_idx
  on public.attendance_annual_balance_charges (reverses_charge_id) where reverses_charge_id is not null;
alter table public.attendance_annual_balance_charges alter column settlement_id drop not null;

alter table public.attendance_annual_balance_charges
  add column if not exists source text not null default 'weekly_review',
  add column if not exists deduction_candidate_id uuid references public.deductions_candidates (id),
  add column if not exists comment text;

alter table public.attendance_annual_balance_charges drop constraint if exists attendance_annual_balance_charges_source_check;
alter table public.attendance_annual_balance_charges
  add constraint attendance_annual_balance_charges_source_check check (source in ('weekly_review', 'deductions'));

alter table public.attendance_annual_balance_charges alter column digest_line_id drop not null;

alter table public.attendance_annual_balance_charges drop constraint if exists attendance_annual_balance_charges_days_check;
alter table public.attendance_annual_balance_charges add constraint attendance_annual_balance_charges_days_check
  check (
    -- a weekly-review charge: exactly the shape it has always had
    (days > 0 and reverses_charge_id is null and reversal_reason is null
      and source = 'weekly_review' and settlement_id is not null and digest_line_id is not null
      and deduction_candidate_id is null)
    -- a deductions charge: the deduction it paid and the comment the employee will read
    or (days > 0 and reverses_charge_id is null and reversal_reason is null
      and source = 'deductions' and settlement_id is null and digest_line_id is null
      and deduction_candidate_id is not null and comment is not null and btrim(comment) <> '')
    -- a reversal of either: negative, points at its charge, says why, has no settlement
    or (days < 0 and reverses_charge_id is not null and settlement_id is null and reversal_reason is not null)
  );

-- One WEEKLY-REVIEW charge per employee-day, as before. A deductions charge is excluded: a returned
-- deduction can be charged again, and a partial index cannot see that its first charge was reversed.
drop index if exists public.attendance_annual_balance_charges_employee_day_idx;
create unique index if not exists attendance_annual_balance_charges_employee_day_idx
  on public.attendance_annual_balance_charges (lower(employee_hr_id), work_date)
  where days > 0 and source = 'weekly_review';

create index if not exists attendance_annual_balance_charges_candidate_idx
  on public.attendance_annual_balance_charges (deduction_candidate_id)
  where deduction_candidate_id is not null;

-- The reversal must mirror its charge. The comparisons that named the digest line now use
-- `is distinct from`, because a deductions charge has no line and `<>` on two nulls proves nothing.
create or replace function public.phx_attendance_balance_reversal_shape()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_charge public.attendance_annual_balance_charges;
begin
  if new.reverses_charge_id is null then
    return new;
  end if;
  select * into v_charge from public.attendance_annual_balance_charges where id = new.reverses_charge_id;
  if not found or v_charge.days <= 0 then
    raise exception 'A reversal must reverse a charge.' using errcode = '23514';
  end if;
  if new.days <> -v_charge.days
     or new.digest_line_id is distinct from v_charge.digest_line_id
     or new.deduction_candidate_id is distinct from v_charge.deduction_candidate_id
     or new.source is distinct from v_charge.source
     or lower(new.employee_hr_id) <> lower(v_charge.employee_hr_id)
     or new.work_date <> v_charge.work_date
     or new.period_start <> v_charge.period_start
     or new.period_end <> v_charge.period_end then
    raise exception 'A reversal must mirror the charge it reverses exactly.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.phx_attendance_balance_reversal_shape() from public, anon, authenticated;

do $do$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.attendance_annual_balance_charges'::regclass
      and tgname = 'attendance_annual_balance_charges_reversal_shape' and not tgisinternal
  ) then
    create trigger attendance_annual_balance_charges_reversal_shape
      before insert on public.attendance_annual_balance_charges
      for each row execute function public.phx_attendance_balance_reversal_shape();
  end if;
end $do$;

comment on column public.attendance_annual_balance_charges.source is
  'Who wrote the row: weekly_review (the attendance review settle function) or deductions (the Deductions workspace "Deduct from leave balance" button).';
comment on column public.attendance_annual_balance_charges.deduction_candidate_id is
  'The deduction a deductions-source charge paid (and the reversal that gives it back).';
comment on column public.attendance_annual_balance_charges.comment is
  'The Super Admin''s comment on a deductions-source charge, shown to the employee exactly as written in their Vacation Report.';

-- ---------------------------------------------------------------------------
-- Charging one deduction to annual leave — atomic
-- ---------------------------------------------------------------------------
-- The balance arithmetic lives in TypeScript (calculatePaymentForRequest) and is NOT copied here.
-- What this function guarantees is that nothing moved between that read and this write: under the
-- same per-employee advisory lock phx_apply_vacation_paid_approval takes, it re-sums the three
-- figures a concurrent writer could change and refuses with 40001 if any differs from what the
-- caller saw. The caller re-reads and tries again.
create or replace function public.phx_deductions_charge_leave_balance(
  p_candidate_id uuid,
  p_employee_hr_id text,
  p_work_date date,
  p_days numeric,
  p_comment text,
  p_actor_hr_id text,
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
  v_candidate public.deductions_candidates;
  v_request_days numeric;
  v_charge_days numeric;
  v_copilot_days numeric;
  v_already numeric;
  v_id bigint;
begin
  if coalesce(btrim(p_comment), '') = '' then
    raise exception 'Write the comment the employee will read.' using errcode = '22023';
  end if;
  if p_days is null or p_days <= 0 then
    raise exception 'There are no days to charge to the leave balance.' using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null or p_work_date is null then
    raise exception 'A leave balance charge needs its balance period.' using errcode = '22023';
  end if;

  -- Same lock key as phx_apply_vacation_paid_approval, so a leave approval and this charge for one
  -- employee can never interleave.
  perform pg_advisory_xact_lock(hashtext(lower(p_employee_hr_id)));

  select * into v_candidate from public.deductions_candidates where id = p_candidate_id for update;
  if not found then
    raise exception 'That deduction was not found.' using errcode = 'P0002';
  end if;
  if v_candidate.superseded_at is not null then
    raise exception 'That deduction was replaced by a newer one — reload and look again.' using errcode = '40001';
  end if;
  if v_candidate.locked_at is not null then
    raise exception 'That deduction is locked by a publication and can no longer be changed.' using errcode = '55000';
  end if;
  if v_candidate.category not in ('crm', 'crm_half_day') then
    raise exception 'Only a CRM or CRM half-day deduction can be charged to the leave balance.' using errcode = '22023';
  end if;
  if lower(coalesce(v_candidate.employee_hr_id, '')) <> lower(p_employee_hr_id) then
    raise exception 'That deduction belongs to a different employee.' using errcode = '22023';
  end if;

  select coalesce(sum(days), 0) into v_already
  from public.attendance_annual_balance_charges
  where deduction_candidate_id = p_candidate_id;
  if v_already > 0.0005 then
    raise exception 'That deduction is already charged to the leave balance — reload and look again.' using errcode = '40001';
  end if;

  select coalesce(sum(paid_duration_days), 0) into v_request_days
  from public.v2_vacation_requests
  where lower(employee_hr_id) = lower(p_employee_hr_id)
    and status = 'approved'
    and vacation_type in ('annual', 'emergency')
    and start_date >= p_period_start
    and start_date <  p_period_end;

  select coalesce(sum(days), 0) into v_charge_days
  from public.attendance_annual_balance_charges
  where lower(employee_hr_id) = lower(p_employee_hr_id)
    and work_date >= p_period_start
    and work_date <  p_period_end;

  select coalesce(sum(balance_days_consumed), 0) into v_copilot_days
  from public.payroll_copilot_vacation_settlements
  where employee_hr_id_compact = regexp_replace(lower(p_employee_hr_id), '[^a-z0-9]+', '', 'g')
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

  insert into public.attendance_annual_balance_charges (
    source, deduction_candidate_id, employee_hr_id, work_date, days, period_start, period_end, created_by, comment
  ) values (
    'deductions', p_candidate_id, p_employee_hr_id, p_work_date, round(p_days, 3),
    p_period_start, p_period_end, p_actor_hr_id, btrim(p_comment)
  )
  returning id into v_id;

  return jsonb_build_object('chargeId', v_id, 'days', round(p_days, 3));
end;
$$;

revoke execute on function public.phx_deductions_charge_leave_balance(uuid, text, date, numeric, text, text, date, date, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.phx_deductions_charge_leave_balance(uuid, text, date, numeric, text, text, date, date, numeric, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Returning a deduction to salary — atomic
-- ---------------------------------------------------------------------------
-- One negative row per live charge, mirroring it, so every balance read nets the days back. Refused
-- once a publication has locked the deduction.
create or replace function public.phx_deductions_return_leave_balance(
  p_candidate_id uuid,
  p_reason text,
  p_actor_hr_id text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_candidate public.deductions_candidates;
  v_charge public.attendance_annual_balance_charges;
  v_employee text;
  v_returned numeric := 0;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why this is going back to salary.' using errcode = '22023';
  end if;

  select employee_hr_id into v_employee
  from public.attendance_annual_balance_charges
  where deduction_candidate_id = p_candidate_id
  order by id
  limit 1;
  if v_employee is null then
    raise exception 'That deduction was never charged to the leave balance.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext(lower(v_employee)));

  select * into v_candidate from public.deductions_candidates where id = p_candidate_id for update;
  if found and v_candidate.locked_at is not null then
    raise exception 'That deduction is locked by a publication and can no longer be changed.' using errcode = '55000';
  end if;

  for v_charge in
    select c.*
    from public.attendance_annual_balance_charges c
    where c.deduction_candidate_id = p_candidate_id
      and c.days > 0
      and not exists (
        select 1 from public.attendance_annual_balance_charges r where r.reverses_charge_id = c.id
      )
    order by c.id
    for update
  loop
    insert into public.attendance_annual_balance_charges (
      source, deduction_candidate_id, employee_hr_id, work_date, days, period_start, period_end,
      created_by, reverses_charge_id, reversal_reason
    ) values (
      'deductions', v_charge.deduction_candidate_id, v_charge.employee_hr_id, v_charge.work_date,
      -v_charge.days, v_charge.period_start, v_charge.period_end, p_actor_hr_id, v_charge.id, btrim(p_reason)
    );
    v_returned := v_returned + v_charge.days;
  end loop;

  if v_returned <= 0 then
    raise exception 'That deduction is not charged to the leave balance any more — reload and look again.' using errcode = '40001';
  end if;

  return jsonb_build_object('returnedDays', v_returned);
end;
$$;

revoke execute on function public.phx_deductions_return_leave_balance(uuid, text, text) from public, anon, authenticated;
grant execute on function public.phx_deductions_return_leave_balance(uuid, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
