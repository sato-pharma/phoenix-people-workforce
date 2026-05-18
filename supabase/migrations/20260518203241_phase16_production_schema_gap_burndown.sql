-- Phase 16 production schema gap burn-down.
-- Idempotent fixes for disposable mutation smoke readiness only.

create extension if not exists pgcrypto;

alter table if exists public.employees
  add column if not exists probation_end_date date null,
  add column if not exists payroll_eligible boolean default true,
  add column if not exists organogram_visible boolean default true;

create table if not exists public.employee_probation (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text null,
  probation_start_date date null,
  probation_end_date date null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_probation add column if not exists employee_hr_id text null;
alter table public.employee_probation add column if not exists probation_start_date date null;
alter table public.employee_probation add column if not exists probation_end_date date null;
alter table public.employee_probation add column if not exists status text not null default 'active';
alter table public.employee_probation add column if not exists created_at timestamptz not null default now();
alter table public.employee_probation add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_probation'
      and column_name = 'hr_id'
  ) then
    execute 'update public.employee_probation set employee_hr_id = hr_id where employee_hr_id is null and hr_id is not null';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_probation'
      and column_name = 'employee_id'
  ) then
    execute 'update public.employee_probation set employee_hr_id = employee_id::text where employee_hr_id is null and employee_id is not null';
  end if;
end $$;

create index if not exists employee_probation_employee_hr_id_idx
  on public.employee_probation (employee_hr_id);

create index if not exists employee_probation_end_date_idx
  on public.employee_probation (probation_end_date);

create table if not exists public.probation_evaluations (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  probation_id text null,
  employee_name text not null default '',
  job_title text null,
  line_name text null,
  area_name text null,
  probation_end_date date not null,
  evaluation_scores jsonb not null default '{}'::jsonb,
  manager_feedback text null,
  hr_recommendation text null,
  decision text null check (decision in ('pass', 'extend', 'terminate')),
  extension_end_date date null,
  decision_reason text null,
  probation_letter_url text null,
  probation_letter_name text null,
  workflow_notes text null,
  status text not null default 'evaluation_requested'
    check (status in ('evaluation_requested', 'manager_feedback', 'hr_recommendation', 'approved', 'completed', 'cancelled')),
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  manager_reviewed_at timestamptz null,
  manager_reviewed_by text null,
  hr_reviewed_at timestamptz null,
  hr_reviewed_by text null,
  approved_at timestamptz null,
  approved_by text null,
  completed_at timestamptz null,
  completed_by text null
);

create index if not exists probation_evaluations_employee_hr_id_idx
  on public.probation_evaluations (employee_hr_id);

create index if not exists probation_evaluations_status_idx
  on public.probation_evaluations (status);

create index if not exists probation_evaluations_end_date_idx
  on public.probation_evaluations (probation_end_date);

create table if not exists public.probation_history (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid null references public.probation_evaluations(id) on update cascade on delete set null,
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  action text not null,
  old_status text null,
  new_status text null,
  actor text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists probation_history_employee_hr_id_idx
  on public.probation_history (employee_hr_id, created_at desc);

alter table public.employee_probation enable row level security;
alter table public.probation_evaluations enable row level security;
alter table public.probation_history enable row level security;

revoke all on public.employee_probation from anon, authenticated;
revoke all on public.probation_evaluations from anon, authenticated;
revoke all on public.probation_history from anon, authenticated;

grant all on public.employee_probation to service_role;
grant all on public.probation_evaluations to service_role;
grant all on public.probation_history to service_role;

drop policy if exists phx_employee_probation_service_role on public.employee_probation;
create policy phx_employee_probation_service_role
  on public.employee_probation
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_probation_evaluations_service_role on public.probation_evaluations;
create policy phx_probation_evaluations_service_role
  on public.probation_evaluations
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_probation_history_service_role on public.probation_history;
create policy phx_probation_history_service_role
  on public.probation_history
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.phx_enforce_terminal_employee_lifecycle_flags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive') then
    new.payroll_eligible := false;
    new.organogram_visible := false;
  elsif lower(coalesce(new.employment_status, 'active')) in ('active', 'on_leave') then
    new.payroll_eligible := coalesce(new.payroll_eligible, true);
    new.organogram_visible := coalesce(new.organogram_visible, true);
  end if;

  return new;
end;
$$;

drop trigger if exists phx_employee_terminal_lifecycle_flags on public.employees;

create trigger phx_employee_terminal_lifecycle_flags
before insert or update of employment_status, payroll_eligible, organogram_visible
on public.employees
for each row
execute function public.phx_enforce_terminal_employee_lifecycle_flags();

update public.employees
set
  payroll_eligible = false,
  organogram_visible = false,
  updated_at = now()
where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and (
    payroll_eligible is distinct from false
    or organogram_visible is distinct from false
  );

notify pgrst, 'reload schema';
