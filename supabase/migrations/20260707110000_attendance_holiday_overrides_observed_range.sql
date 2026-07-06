-- Some national vacations span more than one day (e.g. an extended Eid
-- break), so a single "observed date" isn't enough to record what a System
-- Admin confirmed. Add an observed_end_date so the confirmed observed period
-- is a range (observed_date..observed_end_date), defaulting to a single day
-- when not set. Backfill existing rows to a single-day range so every row is
-- always fully populated (no NULL-coalescing needed in application code).

begin;

alter table public.attendance_holiday_overrides
  add column if not exists observed_end_date date null;

update public.attendance_holiday_overrides
  set observed_end_date = observed_date
  where observed_end_date is null;

alter table public.attendance_holiday_overrides
  alter column observed_end_date set not null;

alter table public.attendance_holiday_overrides
  add constraint attendance_holiday_overrides_observed_range_check
  check (observed_end_date >= observed_date);

create index if not exists attendance_holiday_overrides_observed_range_idx
  on public.attendance_holiday_overrides (observed_date, observed_end_date);

notify pgrst, 'reload schema';

commit;
