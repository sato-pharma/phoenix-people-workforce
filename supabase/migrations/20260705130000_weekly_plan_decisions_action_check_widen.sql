-- The edit-request migration (20260702160000_weekly_plans_edit_request.sql) and the
-- visit-details migration (20260629110000_weekly_plans_visit_details.sql) both taught
-- phx_weekly_plan_next_status() and the employee_plan_headers status constraint about
-- their new actions/statuses, but neither updated this table's action check constraint.
-- Result: every insert into employee_plan_decisions for request_edit,
-- approve_edit_request, reject_edit_request, request_visit_details, or
-- submit_visit_details violated employee_plan_decisions_action_check, so the whole RPC
-- transaction rolled back — the employee-facing action failed outright (silently, from
-- the employee's point of view — just a generic error) and no downstream notification
-- ever ran. Discovered live in production 2026-07-04 when an employee's "Request to
-- Edit" click failed with no visible cause.

begin;

alter table public.employee_plan_decisions
  drop constraint employee_plan_decisions_action_check,
  add constraint employee_plan_decisions_action_check check (action in (
    'submit',
    'request_edit',
    'approve_edit_request',
    'reject_edit_request',
    'request_visit_details',
    'submit_visit_details',
    'manager_approve',
    'manager_reject',
    'manager_return',
    'ceo_approve',
    'ceo_reject',
    'ceo_return',
    'hr_acknowledge',
    'revise',
    'cancel'
  ));

notify pgrst, 'reload schema';

commit;
