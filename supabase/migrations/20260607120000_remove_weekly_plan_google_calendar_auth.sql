-- Remove Weekly / Monthly Plan Google Calendar OAuth/sync integration.
--
-- This intentionally targets only the employee planning module. Other Google
-- Calendar usage, such as public-holiday lookup, is left untouched.

begin;

drop table if exists public.google_calendar_connections;
drop function if exists public.phx_touch_google_calendar_connections();

alter table if exists public.employee_plan_headers
  drop constraint if exists employee_plan_headers_calendar_status_check,
  drop column if exists google_calendar_sync_status,
  drop column if exists google_calendar_synced_at,
  drop column if exists google_calendar_last_error;

alter table if exists public.employee_plan_items
  drop constraint if exists employee_plan_items_calendar_status_check,
  drop column if exists employee_calendar_event_id,
  drop column if exists shared_calendar_event_id,
  drop column if exists calendar_sync_status,
  drop column if exists calendar_synced_at,
  drop column if exists calendar_last_error;

comment on table public.employee_plan_headers is
  'Weekly / Monthly Plan module headers. Approval workflow only; never mutates payroll or leave balances.';

comment on table public.employee_plan_items is
  'Structured dated activities for Weekly / Monthly Plans.';

notify pgrst, 'reload schema';

commit;
