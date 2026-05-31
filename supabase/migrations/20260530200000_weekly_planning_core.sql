-- Weekly Planning module foundation.
--
-- Scope:
-- - Persist employee weekly plan submissions for eligible senior/hybrid roles.
-- - Persist daily activity entries per plan.
-- - Persist stateless email approval tokens for manager and CEO decisions.
--
-- Strict boundaries:
-- - No trigger or application path may auto-mutate payroll (salary_records)
--   or employee leave balances from these tables.
-- - Vacation activity marks needs_leave_reconciliation for manual HR review.
-- - Planning and governance only.
--
-- Security model:
-- Phoenix uses application-managed auth and service-role server APIs for admin
-- workflows. These tables are not exposed directly to anon/authenticated
-- clients. RLS is enabled as defense in depth with service_role-only policies.

-- employee_hr_id references public.employees(hr_id) and is enforced at the
-- application layer. The FK is intentionally omitted from the migration to
-- avoid order-dependency issues when this migration runs against schemas that
-- have not yet applied all employee table changes.

create table if not exists public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  employee_name text not null,
  week_key text not null,
  week_start_date date not null,
  week_end_date date not null,
  month_key text not null,
  month integer not null,
  year integer not null,
  status text not null default 'draft',
  manager_hr_id text null,
  manager_name text null,
  manager_decision text null,
  manager_decision_at timestamptz null,
  manager_decision_by_hr_id text null,
  manager_decision_comment text null,
  ceo_decision text null,
  ceo_decision_at timestamptz null,
  ceo_decision_by_hr_id text null,
  ceo_decision_comment text null,
  finalized_at timestamptz null,
  submitted_at timestamptz null,
  submitted_by_login_id text null,
  workflow_notes text not null default '',
  hierarchy_snapshot jsonb not null default '{}'::jsonb,
  job_title_at_submission text null,
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_plans_status_check check (status in (
    'draft',
    'submitted',
    'manager_approved',
    'manager_returned',
    'ceo_approved',
    'ceo_returned',
    'final_approved',
    'cancelled'
  )),
  constraint weekly_plans_manager_decision_check check (
    manager_decision is null or manager_decision in ('approved', 'returned')
  ),
  constraint weekly_plans_ceo_decision_check check (
    ceo_decision is null or ceo_decision in ('approved', 'returned')
  ),
  constraint weekly_plans_month_range check (month between 1 and 12),
  constraint weekly_plans_year_range check (year between 2000 and 2100),
  constraint weekly_plans_employee_hr_id_not_blank check (btrim(employee_hr_id) <> ''),
  constraint weekly_plans_week_key_not_blank check (btrim(week_key) <> ''),
  constraint weekly_plans_month_key_not_blank check (btrim(month_key) <> '')
);

-- One non-cancelled active plan per (employee_hr_id, week_key).
-- Allows multiple drafts and cancelled plans.
-- Only one submitted/approved/returned active plan at a time.
create unique index if not exists weekly_plans_active_week_uidx
  on public.weekly_plans (employee_hr_id, week_key)
  where status not in ('draft', 'cancelled');

create index if not exists weekly_plans_employee_week_start_idx
  on public.weekly_plans (employee_hr_id, week_start_date desc);

create index if not exists weekly_plans_status_created_idx
  on public.weekly_plans (status, created_at desc);

create index if not exists weekly_plans_month_manager_status_idx
  on public.weekly_plans (month_key, manager_hr_id, status);

create index if not exists weekly_plans_week_key_status_idx
  on public.weekly_plans (week_key, status);

create table if not exists public.weekly_plan_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  day_date date not null,
  day_number integer not null,
  activity_type text not null,
  activity_code text not null,
  location text null,
  area text null,
  accompanied_by_hr_id text null,
  accompanied_by_name text null,
  objective text null,
  expected_output text null,
  notes text not null default '',
  is_public_holiday boolean not null default false,
  public_holiday_name text null,
  is_weekend boolean not null default false,
  needs_leave_reconciliation boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_plan_days_day_number_range check (day_number between 1 and 7),
  constraint weekly_plan_days_activity_type_check check (activity_type in (
    'Office',
    'Field',
    'Double Visit',
    'Training',
    'Meeting',
    'Event',
    'Travel',
    'Admin',
    'Remote',
    'Vacation',
    'Other'
  )),
  constraint weekly_plan_days_activity_code_check check (activity_code in (
    'OF',
    'FD',
    'DV',
    'TR',
    'MT',
    'EV',
    'TV',
    'AD',
    'RW',
    'AV',
    'OT'
  )),
  constraint weekly_plan_days_plan_date_unique unique (plan_id, day_date)
);

create index if not exists weekly_plan_days_plan_date_idx
  on public.weekly_plan_days (plan_id, day_date);

create index if not exists weekly_plan_days_plan_activity_idx
  on public.weekly_plan_days (plan_id, activity_type);

create table if not exists public.weekly_plan_approval_tokens (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  recipient_hr_id text not null,
  role text not null,
  token_hash text not null,
  decision text null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint weekly_plan_approval_tokens_role_check check (role in ('manager', 'ceo')),
  constraint weekly_plan_approval_tokens_decision_check check (
    decision is null or decision in ('approved', 'returned')
  ),
  constraint weekly_plan_approval_tokens_token_hash_unique unique (token_hash)
);

create index if not exists weekly_plan_approval_tokens_plan_role_used_idx
  on public.weekly_plan_approval_tokens (plan_id, role, used_at);

create index if not exists weekly_plan_approval_tokens_hash_unused_idx
  on public.weekly_plan_approval_tokens (token_hash)
  where used_at is null;

-- updated_at trigger functions following the phx_touch_* pattern.

create or replace function public.phx_touch_weekly_plans()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.phx_touch_weekly_plans() from public, anon, authenticated;
grant execute on function public.phx_touch_weekly_plans() to service_role;

drop trigger if exists weekly_plans_touch on public.weekly_plans;
create trigger weekly_plans_touch
  before update on public.weekly_plans
  for each row
  execute function public.phx_touch_weekly_plans();

create or replace function public.phx_touch_weekly_plan_days()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.phx_touch_weekly_plan_days() from public, anon, authenticated;
grant execute on function public.phx_touch_weekly_plan_days() to service_role;

drop trigger if exists weekly_plan_days_touch on public.weekly_plan_days;
create trigger weekly_plan_days_touch
  before update on public.weekly_plan_days
  for each row
  execute function public.phx_touch_weekly_plan_days();

-- RLS: deny-by-default for anon/authenticated; service_role has full access.

alter table public.weekly_plans enable row level security;
alter table public.weekly_plan_days enable row level security;
alter table public.weekly_plan_approval_tokens enable row level security;

revoke all on table public.weekly_plans from anon, authenticated;
revoke all on table public.weekly_plan_days from anon, authenticated;
revoke all on table public.weekly_plan_approval_tokens from anon, authenticated;

grant select, insert, update, delete on table public.weekly_plans to service_role;
grant select, insert, update, delete on table public.weekly_plan_days to service_role;
grant select, insert, update, delete on table public.weekly_plan_approval_tokens to service_role;

drop policy if exists weekly_plans_service_role_all
  on public.weekly_plans;
create policy weekly_plans_service_role_all
  on public.weekly_plans
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists weekly_plan_days_service_role_all
  on public.weekly_plan_days;
create policy weekly_plan_days_service_role_all
  on public.weekly_plan_days
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists weekly_plan_approval_tokens_service_role_all
  on public.weekly_plan_approval_tokens;
create policy weekly_plan_approval_tokens_service_role_all
  on public.weekly_plan_approval_tokens
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.weekly_plans is
  'Weekly Planning module: employee weekly plan submissions for eligible senior/hybrid roles. Planning and governance only. No trigger or application path may auto-mutate payroll (salary_records) or employee leave balances from this table.';

comment on table public.weekly_plan_days is
  'Weekly Planning module: daily activity entries per weekly plan. Governance/review only. Attendance overlay is read-only and advisory.';

comment on table public.weekly_plan_approval_tokens is
  'Weekly Planning module: stateless email approval tokens for manager and CEO weekly plan decisions.';

comment on column public.weekly_plan_days.needs_leave_reconciliation is
  'Set true when activity_type=Vacation and no approved leave request found at submission time. Requires manual HR reconciliation. Does not trigger automatic leave deduction.';

comment on column public.weekly_plans.employee_hr_id is
  'References employees.hr_id; enforced at the application layer, not via FK constraint.';
