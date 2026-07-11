-- Allow direct managers to return an excuse request to the employee for edits.
-- This only widens check constraints; it does not update or delete existing data.

alter table public.v2_excuse_requests
  drop constraint if exists v2_excuse_requests_status_check;

alter table public.v2_excuse_requests
  add constraint v2_excuse_requests_status_check
  check (status in ('pending_manager', 'approved', 'rejected', 'returned_to_employee'));

alter table public.v2_excuse_requests
  drop constraint if exists v2_excuse_requests_manager_decision_check;

alter table public.v2_excuse_requests
  add constraint v2_excuse_requests_manager_decision_check
  check (manager_decision is null or manager_decision in ('approved', 'rejected', 'returned_to_employee'));

do $$
begin
  if to_regclass('public.v2_employee_excuse_requests') is not null then
    execute 'alter table public.v2_employee_excuse_requests drop constraint if exists v2_employee_excuse_requests_status_check';
    execute 'alter table public.v2_employee_excuse_requests add constraint v2_employee_excuse_requests_status_check check (status in (''pending_manager'', ''approved'', ''rejected'', ''returned_to_employee''))';
    execute 'alter table public.v2_employee_excuse_requests drop constraint if exists v2_employee_excuse_requests_manager_decision_check';
    execute 'alter table public.v2_employee_excuse_requests add constraint v2_employee_excuse_requests_manager_decision_check check (manager_decision is null or manager_decision in (''approved'', ''rejected'', ''returned_to_employee''))';
  end if;
end $$;

notify pgrst, 'reload schema';
