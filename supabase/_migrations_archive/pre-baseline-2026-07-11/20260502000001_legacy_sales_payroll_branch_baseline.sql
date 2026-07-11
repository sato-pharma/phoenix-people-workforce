-- Compatibility baseline for rebuilding Supabase preview branches from the
-- repository migration chain.
--
-- These legacy sales/payroll tables existed in production before the current
-- migration history was made fully replayable. Several early governance
-- migrations reference them before any local migration creates them. Keep this
-- migration additive and idempotent so it is safe on databases where the
-- legacy tables already exist.

begin;

create table if not exists public.payroll_expense_reports (
  id uuid primary key default gen_random_uuid(),
  file_name text null,
  status text not null default 'draft',
  uploaded_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_expenses (
  id uuid primary key default gen_random_uuid(),
  report_id uuid null references public.payroll_expense_reports(id) on delete cascade,
  hr_id text null,
  specialist text null,
  description text null,
  trip_id text null,
  total numeric(20, 2) not null default 0,
  hr_status text null,
  status text null,
  hr_approved boolean not null default false,
  payout_month integer null,
  payout_year integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payroll_expenses_trip_id_key
  on public.payroll_expenses (trip_id)
  where trip_id is not null;

create table if not exists public.sales_import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text null,
  status text not null default 'uploaded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_records (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid null references public.sales_import_batches(id) on delete set null,
  employee_hr_id text null,
  employee_name text null,
  manager_hr_id text null,
  product text null,
  sales_value numeric(20, 2) not null default 0,
  target_value numeric(20, 2) not null default 0,
  year integer null,
  month integer null,
  link_status text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_target_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text null,
  status text not null default 'uploaded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_targets (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid null references public.sales_target_batches(id) on delete set null,
  employee_hr_id text null,
  employee_name text null,
  manager_hr_id text null,
  product text null,
  target_value numeric(20, 2) not null default 0,
  year integer null,
  month integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor text null,
  action text not null default 'system',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_role_overrides (
  id uuid primary key default gen_random_uuid(),
  login_id text null,
  hr_id text null,
  role_name text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payroll_expense_reports enable row level security;
alter table public.payroll_expenses enable row level security;
alter table public.sales_import_batches enable row level security;
alter table public.sales_records enable row level security;
alter table public.sales_target_batches enable row level security;
alter table public.sales_targets enable row level security;
alter table public.sales_audit_logs enable row level security;
alter table public.sales_role_overrides enable row level security;

drop policy if exists "employee can see own expenses" on public.payroll_expenses;
create policy "employee can see own expenses"
  on public.payroll_expenses
  for select
  using (true);

drop policy if exists "employee can see own sales" on public.sales_records;
create policy "employee can see own sales"
  on public.sales_records
  for select
  using (true);

drop policy if exists sales_records_dynamic_read on public.sales_records;
create policy sales_records_dynamic_read
  on public.sales_records
  for select
  using (true);

drop policy if exists sales_records_hr_admin_write on public.sales_records;
create policy sales_records_hr_admin_write
  on public.sales_records
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_import_batches_service_role on public.sales_import_batches;
create policy phx_sales_import_batches_service_role
  on public.sales_import_batches
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_records_service_role on public.sales_records;
create policy phx_sales_records_service_role
  on public.sales_records
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_targets_service_role on public.sales_targets;
create policy phx_sales_targets_service_role
  on public.sales_targets
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_target_batches_service_role on public.sales_target_batches;
create policy phx_sales_target_batches_service_role
  on public.sales_target_batches
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_audit_logs_service_role on public.sales_audit_logs;
create policy phx_sales_audit_logs_service_role
  on public.sales_audit_logs
  for all
  using (true)
  with check (true);

drop policy if exists phx_sales_role_overrides_service_role on public.sales_role_overrides;
create policy phx_sales_role_overrides_service_role
  on public.sales_role_overrides
  for all
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
