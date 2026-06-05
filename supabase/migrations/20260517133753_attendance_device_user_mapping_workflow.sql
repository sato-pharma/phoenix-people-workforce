alter table public.attendance_device_user_map
  alter column employee_hr_id drop not null;
alter table public.attendance_device_user_map
  add column if not exists last_seen_punch_at timestamptz null;
create index if not exists attendance_device_user_map_last_seen_idx
  on public.attendance_device_user_map (last_seen_punch_at desc)
  where last_seen_punch_at is not null;
alter table public.attendance_device_user_map
  drop constraint if exists attendance_device_user_map_active_requires_employee;
alter table public.attendance_device_user_map
  add constraint attendance_device_user_map_active_requires_employee
  check (is_active = false or employee_hr_id is not null);
comment on column public.attendance_device_user_map.last_seen_punch_at is
  'Latest punch timestamp observed for this device user during raw ingestion. Used to help HR map discovered fingerprint users without storing unmapped raw punches.';
