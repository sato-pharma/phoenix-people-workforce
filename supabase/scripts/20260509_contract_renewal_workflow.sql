-- Phoenix Workforce contract renewal workflow.
-- Idempotent: safe to run more than once.

create extension if not exists pgcrypto;

alter table public.employees
  add column if not exists contract_renewal_date date null;

create table if not exists public.employee_contracts (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  contract_signed_date date null,
  contract_start_date date null,
  contract_end_date date null,
  contract_renewal_date date null,
  document_url text null,
  document_name text null,
  signed_document_url text null,
  signed_document_name text null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text null,
  constraint employee_contracts_status_check
    check (status in ('draft', 'active', 'expired', 'not_renewed', 'cancelled'))
);

alter table public.employee_contracts add column if not exists employee_hr_id text null;
alter table public.employee_contracts add column if not exists contract_signed_date date null;
alter table public.employee_contracts add column if not exists contract_start_date date null;
alter table public.employee_contracts add column if not exists contract_end_date date null;
alter table public.employee_contracts add column if not exists contract_renewal_date date null;
alter table public.employee_contracts add column if not exists document_url text null;
alter table public.employee_contracts add column if not exists document_name text null;
alter table public.employee_contracts add column if not exists signed_document_url text null;
alter table public.employee_contracts add column if not exists signed_document_name text null;
alter table public.employee_contracts add column if not exists status text not null default 'active';
alter table public.employee_contracts add column if not exists created_at timestamptz not null default now();
alter table public.employee_contracts add column if not exists updated_at timestamptz not null default now();
alter table public.employee_contracts add column if not exists created_by text null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_contracts'
      and column_name = 'hr_id'
  ) then
    execute 'update public.employee_contracts set employee_hr_id = hr_id where employee_hr_id is null and hr_id is not null';
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_contracts'
      and column_name = 'employee_id'
  ) then
    execute 'update public.employee_contracts set employee_hr_id = employee_id::text where employee_hr_id is null and employee_id is not null';
  end if;
end $$;

create index if not exists employee_contracts_employee_hr_id_idx
  on public.employee_contracts (employee_hr_id);

create index if not exists employee_contracts_renewal_date_idx
  on public.employee_contracts (contract_renewal_date);

create table if not exists public.contract_renewal_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  current_contract_id text null,
  employee_name text not null default '',
  job_title text null,
  line_name text null,
  area_name text null,
  current_renewal_date date null,
  requested_renewal_date date not null,
  proposed_start_date date null,
  proposed_end_date date null,
  new_contract_document_url text null,
  new_contract_document_name text null,
  signed_contract_url text null,
  signed_contract_name text null,
  signed_at timestamptz null,
  workflow_notes text null,
  status text not null default 'requested',
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  manager_reviewed_at timestamptz null,
  manager_reviewed_by text null,
  hr_reviewed_at timestamptz null,
  hr_reviewed_by text null,
  decision_at timestamptz null,
  decision_by text null,
  decision_reason text null,
  completed_contract_id text null,
  constraint contract_renewal_requests_status_check
    check (status in ('requested', 'manager_review', 'hr_review', 'renewed', 'not_renewed', 'cancelled'))
);

create index if not exists contract_renewal_requests_employee_hr_id_idx
  on public.contract_renewal_requests (employee_hr_id);

create index if not exists contract_renewal_requests_status_idx
  on public.contract_renewal_requests (status);

create index if not exists contract_renewal_requests_requested_date_idx
  on public.contract_renewal_requests (requested_renewal_date);

create table if not exists public.contract_renewal_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.contract_renewal_requests(id) on update cascade on delete set null,
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  action text not null,
  old_renewal_date date null,
  new_renewal_date date null,
  actor text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists contract_renewal_history_employee_hr_id_idx
  on public.contract_renewal_history (employee_hr_id, created_at desc);

alter table public.employee_contracts enable row level security;
alter table public.contract_renewal_requests enable row level security;
alter table public.contract_renewal_history enable row level security;

revoke all on public.employee_contracts from anon, authenticated;
revoke all on public.contract_renewal_requests from anon, authenticated;
revoke all on public.contract_renewal_history from anon, authenticated;

grant all on public.employee_contracts to service_role;
grant all on public.contract_renewal_requests to service_role;
grant all on public.contract_renewal_history to service_role;

drop policy if exists phx_employee_contracts_service_role on public.employee_contracts;
create policy phx_employee_contracts_service_role
  on public.employee_contracts
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_contract_renewal_requests_service_role on public.contract_renewal_requests;
create policy phx_contract_renewal_requests_service_role
  on public.contract_renewal_requests
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_contract_renewal_history_service_role on public.contract_renewal_history;
create policy phx_contract_renewal_history_service_role
  on public.contract_renewal_history
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';
