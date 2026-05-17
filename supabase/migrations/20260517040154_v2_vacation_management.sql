-- New simple Vacation Management module.
-- Additive only: does not alter, drop, or backfill legacy leave/vacation objects.

create table if not exists public.v2_vacation_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  employee_name text not null,
  employee_work_email text null,
  employee_hire_date date null,
  department_name text null,
  line_name text null,
  manager_hr_id text null,
  manager_name text null,
  manager_of_manager_hr_id text null,
  manager_of_manager_name text null,
  vacation_type text not null check (vacation_type in ('annual', 'emergency', 'sick', 'personal')),
  day_part text not null check (day_part in ('full_day', 'am_only', 'pm_only')),
  start_date date not null,
  end_date date not null,
  duration_days numeric(8,2) not null check (duration_days > 0),
  payment_status text not null check (payment_status in ('paid', 'unpaid')),
  unpaid_reason text null check (unpaid_reason is null or unpaid_reason in ('first_six_months', 'insufficient_balance', 'missing_hire_date')),
  entitlement_days numeric(8,2) not null default 0,
  used_paid_days numeric(8,2) not null default 0,
  balance_before_days numeric(8,2) not null default 0,
  balance_after_days numeric(8,2) not null default 0,
  period_start date null,
  period_end date null,
  status text not null default 'pending_manager' check (status in ('pending_manager', 'approved', 'rejected')),
  submitted_by_hr_id text null,
  submitted_by_login_id text null,
  manager_decision text null check (manager_decision is null or manager_decision in ('approved', 'rejected')),
  manager_decision_by_hr_id text null,
  manager_decision_at timestamptz null,
  manager_decision_comment text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_requests_date_order check (end_date >= start_date)
);

create table if not exists public.v2_vacation_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.v2_vacation_requests(id) on update cascade on delete cascade,
  event_type text not null,
  actor_hr_id text null,
  actor_login_id text null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.v2_vacation_email_tokens (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_vacation_requests(id) on update cascade on delete cascade,
  token_hash text not null unique,
  manager_hr_id text null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists v2_vacation_requests_employee_idx
  on public.v2_vacation_requests (employee_hr_id, start_date desc);

create index if not exists v2_vacation_requests_manager_idx
  on public.v2_vacation_requests (manager_hr_id, status, created_at desc);

create index if not exists v2_vacation_requests_manager_of_manager_idx
  on public.v2_vacation_requests (manager_of_manager_hr_id, created_at desc);

create index if not exists v2_vacation_requests_report_idx
  on public.v2_vacation_requests (status, payment_status, vacation_type, start_date desc);

create index if not exists v2_vacation_request_events_request_idx
  on public.v2_vacation_request_events (request_id, created_at desc);

create index if not exists v2_vacation_email_tokens_request_idx
  on public.v2_vacation_email_tokens (request_id, used_at, expires_at);

alter table public.v2_vacation_requests enable row level security;
alter table public.v2_vacation_request_events enable row level security;
alter table public.v2_vacation_email_tokens enable row level security;

revoke all on table public.v2_vacation_requests from anon, authenticated;
revoke all on table public.v2_vacation_request_events from anon, authenticated;
revoke all on table public.v2_vacation_email_tokens from anon, authenticated;

grant select, insert, update, delete on table public.v2_vacation_requests to service_role;
grant select, insert, update, delete on table public.v2_vacation_request_events to service_role;
grant select, insert, update, delete on table public.v2_vacation_email_tokens to service_role;
grant usage, select on sequence public.v2_vacation_request_events_id_seq to service_role;

drop policy if exists v2_vacation_requests_service_role_all on public.v2_vacation_requests;
create policy v2_vacation_requests_service_role_all
  on public.v2_vacation_requests
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists v2_vacation_request_events_service_role_all on public.v2_vacation_request_events;
create policy v2_vacation_request_events_service_role_all
  on public.v2_vacation_request_events
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists v2_vacation_email_tokens_service_role_all on public.v2_vacation_email_tokens;
create policy v2_vacation_email_tokens_service_role_all
  on public.v2_vacation_email_tokens
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';
