-- Employee monthly excuse requests.
-- Additive only: employee portal submits a fixed 2-hour morning/afternoon excuse
-- and direct managers approve/reject from a secure email token link.

create table if not exists public.v2_employee_excuse_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  employee_name text not null,
  employee_work_email text null,
  employee_line_name text null,
  employee_department_name text null,
  manager_hr_id text null,
  manager_name text null,
  manager_work_email text null,
  excuse_date date not null,
  excuse_type text not null check (excuse_type in ('morning', 'afternoon')),
  duration_hours numeric(4,2) not null default 2 check (duration_hours > 0),
  status text not null default 'pending_manager' check (status in ('pending_manager', 'approved', 'rejected')),
  submitted_by_hr_id text null,
  submitted_by_login_id text null,
  manager_decision text null check (manager_decision is null or manager_decision in ('approved', 'rejected')),
  manager_decision_by_hr_id text null,
  manager_decision_at timestamptz null,
  manager_decision_comment text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.v2_employee_excuse_email_tokens (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_employee_excuse_requests(id) on update cascade on delete cascade,
  token_hash text not null unique,
  manager_hr_id text null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists v2_employee_excuse_requests_employee_month_idx
  on public.v2_employee_excuse_requests (employee_hr_id, excuse_date desc, status);

create index if not exists v2_employee_excuse_requests_manager_idx
  on public.v2_employee_excuse_requests (manager_hr_id, status, created_at desc);

create index if not exists v2_employee_excuse_email_tokens_request_idx
  on public.v2_employee_excuse_email_tokens (request_id, used_at, expires_at);

alter table public.v2_employee_excuse_requests enable row level security;
alter table public.v2_employee_excuse_email_tokens enable row level security;

revoke all on table public.v2_employee_excuse_requests from anon, authenticated;
revoke all on table public.v2_employee_excuse_email_tokens from anon, authenticated;

grant select, insert, update, delete on table public.v2_employee_excuse_requests to service_role;
grant select, insert, update, delete on table public.v2_employee_excuse_email_tokens to service_role;

drop policy if exists v2_employee_excuse_requests_service_role_all on public.v2_employee_excuse_requests;
create policy v2_employee_excuse_requests_service_role_all
  on public.v2_employee_excuse_requests
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists v2_employee_excuse_email_tokens_service_role_all on public.v2_employee_excuse_email_tokens;
create policy v2_employee_excuse_email_tokens_service_role_all
  on public.v2_employee_excuse_email_tokens
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';
create table if not exists public.v2_excuse_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  employee_name text not null,
  employee_work_email text,
  department_name text,
  line_name text,
  manager_hr_id text,
  manager_name text,
  manager_work_email text,
  excuse_date date not null,
  excuse_type text not null check (excuse_type in ('morning', 'afternoon')),
  duration_hours numeric(4, 2) not null default 2 check (duration_hours > 0),
  status text not null default 'pending_manager' check (status in ('pending_manager', 'approved', 'rejected')),
  submitted_by_hr_id text,
  submitted_by_login_id text,
  manager_decision text check (manager_decision in ('approved', 'rejected')),
  manager_decision_by_hr_id text,
  manager_decision_at timestamptz,
  manager_decision_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.v2_excuse_email_tokens (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_excuse_requests(id) on delete cascade,
  token_hash text not null unique,
  manager_hr_id text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_v2_excuse_requests_employee_month
  on public.v2_excuse_requests (employee_hr_id, excuse_date desc);

create index if not exists idx_v2_excuse_requests_manager_status
  on public.v2_excuse_requests (manager_hr_id, status, excuse_date desc);

create index if not exists idx_v2_excuse_requests_status_date
  on public.v2_excuse_requests (status, excuse_date desc);

create index if not exists idx_v2_excuse_email_tokens_request
  on public.v2_excuse_email_tokens (request_id);

alter table public.v2_excuse_requests enable row level security;
alter table public.v2_excuse_email_tokens enable row level security;

revoke all on table public.v2_excuse_requests from anon, authenticated;
revoke all on table public.v2_excuse_email_tokens from anon, authenticated;

grant select, insert, update, delete on table public.v2_excuse_requests to service_role;
grant select, insert, update, delete on table public.v2_excuse_email_tokens to service_role;

drop policy if exists "service role manages excuse requests" on public.v2_excuse_requests;
create policy "service role manages excuse requests"
  on public.v2_excuse_requests
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role manages excuse tokens" on public.v2_excuse_email_tokens;
create policy "service role manages excuse tokens"
  on public.v2_excuse_email_tokens
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';
