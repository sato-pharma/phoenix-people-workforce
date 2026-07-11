alter table public.attendance_policy_rules
  drop constraint if exists attendance_policy_rules_event_type_check;
alter table public.attendance_policy_rules
  add constraint attendance_policy_rules_event_type_check
  check (event_type in ('late', 'early_leave', 'single_punch', 'absence', 'exception'));
comment on table public.attendance_policy_rules is
  'Attendance policy rule brackets for late arrival, early leave, single punch, absence, and manual exception actions. Deduction fields are report recommendations only.';
