-- Compatibility baseline for outstation migrations on preview branches.

begin;

create table if not exists public.outstation_expense_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete restrict,
  trip_start_date date,
  trip_end_date date,
  status text not null default 'draft',
  offline_captured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outstation_policy_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text unique,
  rule_value jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outstation_location_audit_logs (
  id uuid primary key default gen_random_uuid(),
  expense_request_id uuid references public.outstation_expense_requests(id) on update cascade on delete cascade,
  employee_hr_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.outstation_expense_requests enable row level security;
alter table public.outstation_policy_rules enable row level security;
alter table public.outstation_location_audit_logs enable row level security;

notify pgrst, 'reload schema';

commit;
