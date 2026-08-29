-- Correcting a hire date now re-anchors the open probation case, and retires the reminders the
-- old date scheduled (2026-08-29).
--
-- THE DEFECT, IN TWO HALVES. 20260829213000 made provisioning fire on UPDATE, but deliberately
-- left the other half open: `on conflict (employee_hr_id) do nothing` means a hire-date
-- correction creates nothing and changes nothing, so an existing case keeps its ORIGINAL window.
-- That is half one, and it was known. Half two was not: the probation reminder rows written by
-- getProbationReminderSchedule (src/lib/probation/service.ts) carry an event_key of
-- `<HR_ID>:probation:<reminder_type>:<scheduled_for>`, and scheduled_for is derived from the
-- employee's hire date. Change the hire date and every key changes with it, so the next sweep
-- INSERTS a fresh set under the new keys while the old rows stay `pending` -- the upsert is
-- `on conflict (event_key) ignore duplicates`, which cannot see that the old row is now wrong.
-- The manager, NSM and HR then get the same probation feedback request TWICE, days apart.
--
-- MEASURED ON PRODUCTION 2026-08-29, after two hire dates were corrected earlier the same day:
--   AI-0009 Omayma Wael  hire 2026-08-20 -> 2026-08-17
--     correct: 09-16 / 10-16 / 10-31      stale and still pending: 09-19 / 10-19 / 11-03
--   AI-0012 Hanan Safwat hire 2026-08-17 -> 2026-08-11
--     correct: 09-10 / 10-10 / 10-25      stale and still pending: 09-16 / 10-16 / 10-31
-- Six stale rows, and a full-table sweep found no others anywhere in the system -- so this is a
-- defect that only bites when someone corrects a hire date, which is exactly what the companion
-- migration made routine.
--
-- WHAT CHANGES. One new function and one AFTER UPDATE OF (hire_date) trigger, doing two things
-- inside the same transaction as the hire-date change, so no sweep can observe a half-updated
-- state:
--   1. Re-anchor the open case: hire_date, probation_start_date, probation_end_date = hire + 90.
--   2. Cancel probation reminder rows whose scheduled_for is not one of hire + 30 / 60 / 75.
-- The offsets are lifecycleRiskWindows (src/lib/lifecycle-risk/metrics.ts): probationDays 90 less
-- warning 60, critical 30, risk 15 -> 30, 60, 75. Confirmed against live rows before writing.
--
-- WHY THE RE-ANCHOR IS NARROW. It updates only a case that is `status = 'active'` AND
-- `decision is null` AND still sitting on the window the OLD hire date implies. A decided,
-- cancelled or completed case is never touched -- moving the goalposts after a verdict would
-- rewrite history. The "still on the old system window" test is what protects a deliberately
-- overridden window: nothing in the app sets one today (probationStartDate is always called
-- without an explicit start), but if a human ever adjusts a window by hand, a later hire-date
-- correction must not silently discard that judgement.
--
-- WHY CANCEL RATHER THAN DELETE. `status = 'cancelled'` is the house pattern -- it is exactly
-- what src/lib/probation/service.ts does to outstanding probation events when a decision lands.
-- The sweep selects `status in ('pending','scheduled')`, so cancelling removes the row from
-- delivery while leaving it readable for audit. Nothing is destroyed.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not touch `status` on the case. If a hire date is
-- corrected backwards far enough that the 90 days have already elapsed, the case is re-dated but
-- stays active and still needs a human decision -- deciding a probation is not a trigger's job.
-- It also never un-cancels or re-sends anything: a reminder already delivered under the old dates
-- stays delivered, because re-emitting a past reminder would be worse than the duplicate this
-- fixes.
--
-- ONE-TIME CLEANUP. The same predicate is applied once to existing rows at the bottom of this
-- file. It is written as a general rule joined to employees, not as six named ids, so it is
-- self-limiting and correct on any environment: on production it matches exactly the six rows
-- listed above, and on a database where no hire date was ever corrected it matches nothing.
--
-- CREATE OR REPLACE FUNCTION preserves the OID and ACLs, but per
-- tests/migrations-secdef-revoke-guard.test.ts every SECURITY DEFINER migration must carry its
-- own revoke rather than relying on an earlier one. The revoke is at the bottom.
--
-- NOT APPLIED as part of authoring this file. Rehearsed on staging first, then applied to
-- production with the owner's approval, and verified against pg_trigger / pg_proc directly.

begin;

create or replace function public.probation_reanchor_on_hire_date_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_end date;
  v_new_start date;
  v_new_end date;
begin
  if new.hr_id is null or new.hire_date is null then
    return new;
  end if;
  if old.hire_date is not distinct from new.hire_date then
    return new;
  end if;

  v_old_end := (old.hire_date + interval '90 days')::date;
  v_new_start := new.hire_date;
  v_new_end := (new.hire_date + interval '90 days')::date;

  -- 1. Re-anchor the open case, only while it still sits on the old system-derived window.
  begin
    update public.probation_cases
       set hire_date = new.hire_date,
           probation_start_date = v_new_start,
           probation_end_date = v_new_end,
           updated_at = now()
     where lower(employee_hr_id) = lower(new.hr_id)
       and status = 'active'
       and decision is null
       and hire_date is not distinct from old.hire_date
       and probation_start_date is not distinct from old.hire_date
       and probation_end_date is not distinct from v_old_end;
  exception when others then
    begin
      insert into public.probation_provisioning_failures (employee_hr_id, source, error_message)
      values (new.hr_id, 'reanchor_trigger', sqlerrm);
    exception when others then null;
    end;
  end;

  -- 2. Retire reminder rows the OLD hire date scheduled. Never touches a sent or failed row.
  begin
    update public.notification_events
       set status = 'cancelled',
           updated_at = now()
     where category = 'probation'
       and lower(employee_hr_id) = lower(new.hr_id)
       and status in ('pending', 'scheduled')
       and metadata->>'reminder_type' in (
             'probation_day_30_check',
             'probation_30_days_remaining',
             'probation_15_days_remaining')
       and scheduled_for not in (
             new.hire_date + 30,
             new.hire_date + 60,
             new.hire_date + 75);
  exception when others then
    begin
      insert into public.probation_provisioning_failures (employee_hr_id, source, error_message)
      values (new.hr_id, 'reanchor_trigger_reminders', sqlerrm);
    exception when others then null;
    end;
  end;

  return new;
end;
$$;

drop trigger if exists trg_probation_reanchor_on_hire_date on public.employees;
create trigger trg_probation_reanchor_on_hire_date
after update of hire_date on public.employees
for each row
when (old.hire_date is distinct from new.hire_date)
execute function public.probation_reanchor_on_hire_date_change();

-- One-time cleanup of reminders stranded by hire-date corrections made BEFORE this trigger
-- existed. Same rule as the trigger, expressed against current employee hire dates.
update public.notification_events ne
   set status = 'cancelled',
       updated_at = now()
  from public.employees e
 where ne.category = 'probation'
   and lower(ne.employee_hr_id) = lower(e.hr_id)
   and ne.status in ('pending', 'scheduled')
   and ne.metadata->>'reminder_type' in (
         'probation_day_30_check',
         'probation_30_days_remaining',
         'probation_15_days_remaining')
   and e.hire_date is not null
   and ne.scheduled_for not in (
         e.hire_date + 30,
         e.hire_date + 60,
         e.hire_date + 75);

-- Self-contained revoke (policy: see header / tests/migrations-secdef-revoke-guard.test.ts).
-- PUBLIC is the operative grantee -- every login role, anon and authenticated included, is a
-- member of PUBLIC, so revoking only those two would be a no-op against the default PUBLIC grant.
revoke execute on function public.probation_reanchor_on_hire_date_change() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
