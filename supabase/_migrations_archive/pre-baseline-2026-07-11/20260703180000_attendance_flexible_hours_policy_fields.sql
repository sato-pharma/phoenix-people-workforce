-- Flexible-hours policy fields for the weekly-digest model.
--
-- Extends attendance_policy_groups so a policy can express the owner-confirmed
-- flexible-hours rule (see the flexible-hours engine + spec):
--   • flex_minutes         — arrival grace past scheduled_start before lateness
--                            is counted (30 = free until 09:30).
--   • required_minutes     — minimum required presence (470 = 7h50m).
--   • half_day_split_minutes — minute-of-day that splits an AM/PM half-day leave
--                            (780 = 13:00).
--   • judgment_mode        — how often the policy applies:
--                            every_working_day (head-office staff) vs
--                            office_days_only (NSM/GPM/PM, judged only on a
--                            plan-office day that also has a punch).
--
-- All columns are additive and backward-safe: when flex_minutes / required_minutes
-- are null the engine falls back to the legacy scheduled-duration + grace model,
-- so existing policies keep behaving exactly as before until reconfigured.

begin;

alter table public.attendance_policy_groups
  add column if not exists flex_minutes integer null
    check (flex_minutes is null or (flex_minutes >= 0 and flex_minutes <= 240)),
  add column if not exists required_minutes integer null
    check (required_minutes is null or (required_minutes >= 0 and required_minutes <= 1440)),
  add column if not exists half_day_split_minutes integer not null default 780
    check (half_day_split_minutes >= 0 and half_day_split_minutes <= 1440),
  add column if not exists judgment_mode text not null default 'every_working_day'
    check (judgment_mode in ('every_working_day', 'office_days_only'));

comment on column public.attendance_policy_groups.flex_minutes is
  'Arrival flexibility in minutes past scheduled_start before lateness is counted (30 = free until 09:30). Null falls back to the legacy grace model.';
comment on column public.attendance_policy_groups.required_minutes is
  'Minimum required presence in minutes (470 = 7h50m). Null falls back to the legacy scheduled-duration model.';
comment on column public.attendance_policy_groups.half_day_split_minutes is
  'Minute-of-day boundary that splits an AM/PM half-day leave (default 780 = 13:00).';
comment on column public.attendance_policy_groups.judgment_mode is
  'every_working_day = judged every working day (head office); office_days_only = judged only on plan-office days with a punch (NSM/GPM/PM).';

notify pgrst, 'reload schema';

commit;
