-- 20260629120000_plan_national_vacation_excuse_activity.sql
--
-- Weekly/Monthly plans — extend the activity-type check constraint with two
-- new values used by the linkage + workweek features:
--   * 'National Vacation' — a manually selectable public-holiday day.
--   * 'Excuse'            — an approved 2-hour morning/afternoon permission,
--                           auto-filled (locked) from v2_excuse_requests.
--
-- SAFE: constraint swap only (drop-if-exists + re-add). No data is modified;
-- every existing activity_type value remains valid. Forward-compatible.

begin;

alter table public.employee_plan_items
  drop constraint if exists employee_plan_items_activity_type_check;

alter table public.employee_plan_items
  add constraint employee_plan_items_activity_type_check check (activity_type in (
    'Office',
    'Field',
    'Double Visit',
    'Training',
    'Meeting',
    'Event',
    'Travel',
    'Admin',
    'Remote',
    'Vacation',
    'National Vacation',
    'Excuse',
    'Other'
  ));

commit;
