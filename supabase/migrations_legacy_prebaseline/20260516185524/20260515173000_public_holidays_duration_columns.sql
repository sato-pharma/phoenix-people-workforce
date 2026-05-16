-- Adds display metadata for National Vacations.
-- Do not apply automatically from Codex. Review and apply through the controlled Supabase migration process.

alter table public.public_holidays
  add column if not exists end_date date,
  add column if not exists duration_days numeric(6, 2);

update public.public_holidays
set
  end_date = coalesce(end_date, date),
  duration_days = coalesce(duration_days, 1)
where end_date is null or duration_days is null;

alter table public.public_holidays
  alter column end_date set default current_date,
  alter column duration_days set default 1;

alter table public.public_holidays
  drop constraint if exists public_holidays_duration_days_check,
  add constraint public_holidays_duration_days_check check (duration_days > 0);

alter table public.public_holidays
  drop constraint if exists public_holidays_end_date_check,
  add constraint public_holidays_end_date_check check (end_date >= date);
