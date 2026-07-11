-- Tighten public tables that should only be accessed through server-side
-- service-role code. These tables are in the exposed public schema, so RLS
-- must be enabled before leaving any role-level grants in place.

alter table if exists public.employee_salary_structure enable row level security;
alter table if exists public.leave_notification_attempts enable row level security;
alter table if exists public.leave_request_events enable row level security;
alter table if exists public.salary_allowance_defaults enable row level security;
revoke all on table public.employee_salary_structure from anon, authenticated;
revoke all on table public.leave_notification_attempts from anon, authenticated;
revoke all on table public.leave_request_events from anon, authenticated;
revoke all on table public.salary_allowance_defaults from anon, authenticated;
grant select, insert, update, delete on table public.employee_salary_structure to service_role;
grant select, insert, update, delete on table public.leave_notification_attempts to service_role;
grant select, insert, update, delete on table public.leave_request_events to service_role;
grant select, insert, update, delete on table public.salary_allowance_defaults to service_role;
drop policy if exists employee_salary_structure_service_role_all on public.employee_salary_structure;
create policy employee_salary_structure_service_role_all
  on public.employee_salary_structure
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists leave_notification_attempts_service_role_all on public.leave_notification_attempts;
create policy leave_notification_attempts_service_role_all
  on public.leave_notification_attempts
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists leave_request_events_service_role_all on public.leave_request_events;
create policy leave_request_events_service_role_all
  on public.leave_request_events
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists salary_allowance_defaults_service_role_all on public.salary_allowance_defaults;
create policy salary_allowance_defaults_service_role_all
  on public.salary_allowance_defaults
  for all
  to service_role
  using (true)
  with check (true);
-- Earlier local work created these empty duplicate excuse tables under a
-- longer name. The application uses public.v2_excuse_* instead.
drop table if exists public.v2_employee_excuse_email_tokens;
drop table if exists public.v2_employee_excuse_requests;
notify pgrst, 'reload schema';
