-- attendance_review_day_decided_at_month_end
--
-- WHAT THIS CHANGES: a weekly attendance review day gets one more state, 'month_end_decided', and
-- phx_attendance_take_out_month_end_decided_days() moves an employee's still-waiting days on the
-- given dates into it, inside weeks that have NOT been released yet (status awaiting_release, real
-- weeks only). A released week, an answered day and a trial-run week are never touched.
-- WHY: owner, 24 Nov 2026 ("donot make this block deduction"; then "Take it out"). Approving a
-- month-end fingerprint deduction no longer waits for its week to be released. Once approved, the
-- day leaves the weekly review: the release step neither clears it (an unticked day is cleared on
-- release, which would contradict the approval) nor asks the employee about it, and the daily
-- builder leaves it alone (it refreshes only 'pending' days). No settlement row is written, so the
-- digest bridge has nothing to apply and the month-end decision is the only record of the money.
-- ROLLBACK:
--   update public.attendance_digest_lines set action = 'pending', acted_at = null, updated_at = now()
--     where action = 'month_end_decided';
--   drop function if exists public.phx_attendance_take_out_month_end_decided_days(text, date[]);
--   then re-add attendance_digest_lines_action_check without 'month_end_decided'.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one constraint widened, one new function, no row written.

begin;

alter table public.attendance_digest_lines drop constraint if exists attendance_digest_lines_action_check;
alter table public.attendance_digest_lines add constraint attendance_digest_lines_action_check
  check (action = any (array[
    'pending', 'removed', 'salary', 'annual_balance', 'auto_salary', 'disputed',
    'dispute_upheld', 'dispute_rejected', 'confirmed', 'month_end_decided'
  ]::text[]));

create or replace function public.phx_attendance_take_out_month_end_decided_days(
  p_employee_hr_id text,
  p_work_dates date[]
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hr text := btrim(coalesce(p_employee_hr_id, ''));
  v_digest public.attendance_weekly_digests;
  v_moved integer;
  v_total integer := 0;
  v_total_days numeric;
  v_total_value numeric;
  v_unpriced boolean;
begin
  if v_hr = '' or p_work_dates is null or coalesce(array_length(p_work_dates, 1), 0) = 0 then
    return 0;
  end if;

  -- Each waiting week is locked the way a tick, a release and the daily builder lock it, so a
  -- release running at the same moment either finishes first (the day is then no longer waiting and
  -- is left alone) or waits for this.
  for v_digest in
    select g.*
    from public.attendance_weekly_digests g
    where upper(g.employee_hr_id) = upper(v_hr)
      and g.status = 'awaiting_release'
      and g.dry_run = false
      and exists (
        select 1 from public.attendance_digest_lines l
        where l.digest_id = g.id and l.action = 'pending' and l.work_date = any(p_work_dates)
      )
    order by g.id
    for update
  loop
    update public.attendance_digest_lines set
      action = 'month_end_decided',
      acted_at = now(),
      updated_at = now()
    where digest_id = v_digest.id
      and action = 'pending'
      and work_date = any(p_work_dates);
    get diagnostics v_moved = row_count;
    v_total := v_total + v_moved;

    -- The same totals the daily builder keeps on a waiting week.
    select
      coalesce(sum(deduction_days) filter (where action <> 'removed' and (deduct or action <> 'pending')), 0),
      coalesce(sum(deduction_value) filter (where action <> 'removed' and (deduct or action <> 'pending')), 0),
      coalesce(bool_or(deduction_value is null) filter (where action <> 'removed' and (deduct or action <> 'pending')), false)
    into v_total_days, v_total_value, v_unpriced
    from public.attendance_digest_lines
    where digest_id = v_digest.id;

    update public.attendance_weekly_digests set
      total_deduction_days = round(v_total_days, 3),
      total_deduction_value = case when v_unpriced then null else round(v_total_value, 2) end,
      has_unpriced_day = v_unpriced,
      updated_at = now()
    where id = v_digest.id;
  end loop;

  return v_total;
end;
$function$;

revoke execute on function public.phx_attendance_take_out_month_end_decided_days(text, date[]) from public, anon, authenticated;
grant execute on function public.phx_attendance_take_out_month_end_decided_days(text, date[]) to service_role;

commit;
