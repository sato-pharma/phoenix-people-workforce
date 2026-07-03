-- Bulk holiday calendar: admin-configured observed/postponed dates for
-- official holidays. The national-holiday source (Google Calendar + the
-- COMPANY_HOLIDAYS code list, see src/lib/vacation/national-holidays.ts)
-- gives the OFFICIAL date a holiday falls on; this table lets an admin
-- record the date the company actually observed it (e.g. a Friday holiday
-- postponed to the following Sunday). Attendance calendar resolution
-- (buildAttendanceCalendarContext) applies these overrides on top of the
-- raw source so reconciliation judges the real day off, not the official one.

begin;

create table if not exists public.attendance_holiday_overrides (
  id                bigserial primary key,
  official_date     date        not null,
  observed_date     date        not null,
  holiday_name      text        not null,
  notes             text        null,
  created_by_hr_id  text        null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (official_date)
);

create index if not exists attendance_holiday_overrides_observed_idx
  on public.attendance_holiday_overrides (observed_date);

alter table public.attendance_holiday_overrides enable row level security;

revoke all on table public.attendance_holiday_overrides from anon, authenticated;

grant select, insert, update, delete on table public.attendance_holiday_overrides to service_role;
grant usage, select on sequence public.attendance_holiday_overrides_id_seq to service_role;

create policy attendance_holiday_overrides_service_role_all on public.attendance_holiday_overrides
  for all to service_role using (true) with check (true);

notify pgrst, 'reload schema';

commit;
