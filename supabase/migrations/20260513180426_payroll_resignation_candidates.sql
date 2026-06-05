create extension if not exists pgcrypto;
create table if not exists public.payroll_resignation_candidates (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  employee_name text not null,
  name_ar text,
  job_title text,
  line_name text,
  area_name text,
  hire_date date,
  last_payout_month integer not null,
  last_payout_year integer not null,
  source_file_name text,
  source_row integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  constraint payroll_resignation_candidates_hr_id_key unique (hr_id),
  constraint payroll_resignation_candidates_month_check check (last_payout_month between 1 and 12),
  constraint payroll_resignation_candidates_year_check check (last_payout_year between 2000 and 2100)
);
create index if not exists payroll_resignation_candidates_payout_idx
  on public.payroll_resignation_candidates (last_payout_year desc, last_payout_month desc);
create index if not exists payroll_resignation_candidates_line_idx
  on public.payroll_resignation_candidates (line_name);
alter table public.payroll_resignation_candidates enable row level security;
drop policy if exists payroll_resignation_candidates_service_role_all
  on public.payroll_resignation_candidates;
create policy payroll_resignation_candidates_service_role_all
on public.payroll_resignation_candidates
for all
to service_role
using (true)
with check (true);
