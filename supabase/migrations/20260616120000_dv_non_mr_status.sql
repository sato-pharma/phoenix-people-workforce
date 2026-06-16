-- Add 'non_mr' to the double_visit_rows visited_employee_status check constraint.
-- These rows represent CRM data errors where the visited "employee" is actually a manager
-- (DSM/RM/NSM/PM/GPM/TM) rather than a Medical Rep. They are excluded from all DV counts
-- at both import time and runtime.

alter table public.double_visit_rows
  drop constraint if exists double_visit_rows_status_check;

alter table public.double_visit_rows
  add constraint double_visit_rows_status_check
    check (visited_employee_status in ('active_mapped', 'blank_hr_id', 'non_mr', 'vacant', 'resigned', 'unmapped'));
