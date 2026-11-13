create table if not exists public.payroll_expense_reports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  row_count integer not null default 0,
  total_expenses numeric(20, 2) not null default 0,
  approved_rows integer not null default 0,
  trip_date_from date null,
  trip_date_to date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_expenses (
  id uuid primary key default gen_random_uuid(),
  report_id uuid null references public.payroll_expense_reports(id) on delete set null,
  trip_id text not null unique,
  specialist text not null,
  hr_id text null,
  expense_date date null,
  to_date date null,
  request_type text null,
  transportation_type text null,
  trip_type text null,
  from_location text null,
  to_location text null,
  location text null,
  travel_cost numeric(20, 2) not null default 0,
  meeting_amount numeric(20, 2) not null default 0,
  allowance numeric(20, 2) not null default 0,
  total numeric(20, 2) not null default 0,
  km numeric(20, 2) not null default 0,
  description text null,
  status text null,
  hr_status text null,
  hr_notes text null,
  am_workload numeric(20, 2) not null default 0,
  pm_workload numeric(20, 2) not null default 0,
  open_status text null,
  hr_approved boolean not null default false,
  hr_comment text not null default '',
  approved_by text null,
  approved_at timestamptz null,
  payout_month integer not null default extract(month from now())::integer,
  payout_year integer not null default extract(year from now())::integer,
  source_file_name text not null default '',
  source_row integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payroll_expenses'
      and column_name = 'employee_code'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payroll_expenses'
      and column_name = 'hr_id'
  ) then
    alter table public.payroll_expenses rename column employee_code to hr_id;
  end if;
end $$;

alter table public.payroll_expenses
  add column if not exists hr_id text null;

create index if not exists payroll_expenses_payout_idx
  on public.payroll_expenses (payout_year, payout_month);

drop index if exists payroll_expenses_employee_idx;

create index if not exists payroll_expenses_hr_id_idx
  on public.payroll_expenses (hr_id);

alter table public.payroll_expenses
  add column if not exists report_id uuid null references public.payroll_expense_reports(id) on delete set null;

create index if not exists payroll_expenses_report_idx
  on public.payroll_expenses (report_id);
