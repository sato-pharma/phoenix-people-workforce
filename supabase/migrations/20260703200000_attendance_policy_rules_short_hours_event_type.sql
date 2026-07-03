-- Add 'short_hours' as an allowed attendance_policy_rules.event_type.
--
-- The flexible-hours model (weekly-digest generator) needs brackets keyed by
-- minutes SHORT of the required presence (required_minutes), which is a
-- distinct concept from the legacy 'early_leave' bracket (minutes before the
-- fixed scheduled_end). Reusing 'early_leave' for both would silently conflate
-- two different measurements for any policy shared between the old and new
-- engines. This migration is purely additive: it widens the CHECK constraint
-- to also allow 'short_hours'; every existing row and every existing value
-- keeps working exactly as before.

begin;

alter table public.attendance_policy_rules
  drop constraint if exists attendance_policy_rules_event_type_check;

alter table public.attendance_policy_rules
  add constraint attendance_policy_rules_event_type_check
  check (event_type in ('late', 'early_leave', 'single_punch', 'absence', 'exception', 'short_hours'));

comment on column public.attendance_policy_rules.event_type is
  'late/early_leave/single_punch/absence/exception = legacy fixed-schedule engine; short_hours = flexible-hours engine bracket keyed by minutes short of attendance_policy_groups.required_minutes.';

notify pgrst, 'reload schema';

commit;
