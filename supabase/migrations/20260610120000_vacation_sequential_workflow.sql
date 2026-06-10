-- Sequential vacation approval workflow (Annual / Other / Compensatory).
--
-- Adds:
--   1. `step_order` on v2_vacation_approval_steps so the engine can gate management approvals
--      sequentially (1 = direct manager, 2 = manager-of-manager, 3 = HR acknowledgement).
--   2. A new `needs_assignment` request status, used when a sequential-workflow request has no
--      resolvable first management approver (broken reporting line). HR assigns an approver from
--      the Vacation Action Center to resume the flow.
--
-- Emergency and Sick keep the legacy parallel flow. This migration is additive and
-- non-destructive (existing rows keep working); idempotent on re-run.

begin;

-- 1) Step ordering for sequential gating. Backfill existing rows from their step_key.
alter table public.v2_vacation_approval_steps
  add column if not exists step_order smallint;

update public.v2_vacation_approval_steps
set step_order = case step_key
  when 'direct_manager' then 1
  when 'manager_of_manager' then 2
  when 'hr' then 3
  else step_order
end
where step_order is null;

-- 2) Allow the new `needs_assignment` status (keeps all existing values).
alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_status_check;

alter table public.v2_vacation_requests
  add constraint v2_vacation_requests_status_check
    check (status in ('needs_assignment', 'pending_manager', 'pending_hr', 'approved', 'rejected'));

notify pgrst, 'reload schema';

commit;
