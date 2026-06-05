-- Vacation Module Enterprise Governance Foundation.
-- Additive only: report scoping, evidence review, SLA run tracking, and
-- indexes used by report/export/SLA paths.

begin;
create table if not exists public.v2_vacation_evidence_reviews (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_vacation_requests(id) on update cascade on delete cascade,
  evidence_type text not null,
  status text not null default 'pending',
  reviewed_by_hr_id text null,
  reviewed_at timestamptz null,
  review_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_evidence_reviews_type_check
    check (evidence_type in ('sick', 'compensatory')),
  constraint v2_vacation_evidence_reviews_status_check
    check (status in ('pending', 'accepted', 'rejected', 'needs_follow_up')),
  constraint v2_vacation_evidence_reviews_unique_type
    unique (request_id, evidence_type)
);
create table if not exists public.v2_vacation_sla_settings (
  id boolean primary key default true,
  manager_pending_business_days integer not null default 1,
  hr_pending_business_days integer not null default 2,
  reminder_interval_days integer not null default 1,
  escalate_manager_to_manager_of_manager boolean not null default true,
  escalate_hr_to_super_admin boolean not null default true,
  updated_by_login_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_sla_settings_singleton check (id),
  constraint v2_vacation_sla_settings_manager_days_check check (manager_pending_business_days between 1 and 30),
  constraint v2_vacation_sla_settings_hr_days_check check (hr_pending_business_days between 1 and 30),
  constraint v2_vacation_sla_settings_interval_check check (reminder_interval_days between 1 and 14)
);
insert into public.v2_vacation_sla_settings (id)
values (true)
on conflict (id) do nothing;
create table if not exists public.v2_vacation_sla_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running',
  manager_reminders integer not null default 0,
  manager_escalations integer not null default 0,
  hr_reminders integer not null default 0,
  hr_escalations integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint v2_vacation_sla_runs_status_check check (status in ('running', 'completed', 'failed')),
  constraint v2_vacation_sla_runs_run_date_unique unique (run_date)
);
create index if not exists v2_vacation_evidence_reviews_request_idx
  on public.v2_vacation_evidence_reviews (request_id, evidence_type);
create index if not exists v2_vacation_evidence_reviews_status_idx
  on public.v2_vacation_evidence_reviews (status, reviewed_at desc);
create index if not exists v2_vacation_sla_runs_run_date_idx
  on public.v2_vacation_sla_runs (run_date desc);
create index if not exists v2_vacation_requests_status_idx
  on public.v2_vacation_requests (status);
create index if not exists v2_vacation_requests_employee_start_end_idx
  on public.v2_vacation_requests (employee_hr_id, start_date, end_date);
create index if not exists v2_vacation_requests_manager_status_created_idx
  on public.v2_vacation_requests (manager_hr_id, status, created_at);
create index if not exists v2_vacation_requests_start_created_idx
  on public.v2_vacation_requests (start_date, created_at desc);
create index if not exists v2_vacation_requests_sla_pending_manager_idx
  on public.v2_vacation_requests (created_at, manager_hr_id)
  where status = 'pending_manager';
create index if not exists v2_vacation_requests_sla_pending_hr_idx
  on public.v2_vacation_requests (manager_decision_at, created_at)
  where status = 'pending_hr';
alter table public.v2_vacation_evidence_reviews enable row level security;
alter table public.v2_vacation_sla_settings enable row level security;
alter table public.v2_vacation_sla_runs enable row level security;
revoke all on table public.v2_vacation_evidence_reviews from anon, authenticated;
revoke all on table public.v2_vacation_sla_settings from anon, authenticated;
revoke all on table public.v2_vacation_sla_runs from anon, authenticated;
grant select, insert, update, delete on table public.v2_vacation_evidence_reviews to service_role;
grant select, insert, update, delete on table public.v2_vacation_sla_settings to service_role;
grant select, insert, update, delete on table public.v2_vacation_sla_runs to service_role;
drop policy if exists v2_vacation_evidence_reviews_service_role_all on public.v2_vacation_evidence_reviews;
create policy v2_vacation_evidence_reviews_service_role_all
  on public.v2_vacation_evidence_reviews
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists v2_vacation_sla_settings_service_role_all on public.v2_vacation_sla_settings;
create policy v2_vacation_sla_settings_service_role_all
  on public.v2_vacation_sla_settings
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists v2_vacation_sla_runs_service_role_all on public.v2_vacation_sla_runs;
create policy v2_vacation_sla_runs_service_role_all
  on public.v2_vacation_sla_runs
  for all
  to service_role
  using (true)
  with check (true);
create or replace function public.phx_vacation_report_rows(
  p_visible_employee_hr_ids text[] default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns setof public.v2_vacation_requests
language sql
stable
set search_path = public
as $$
  select requests.*
  from public.v2_vacation_requests requests
  where (
    p_visible_employee_hr_ids is null
    or requests.employee_hr_id = any(p_visible_employee_hr_ids)
  )
  and (
    nullif(p_filters->>'status', '') is null
    or p_filters->>'status' = 'all'
    or requests.status = p_filters->>'status'
  )
  and (
    nullif(p_filters->>'paymentStatus', '') is null
    or p_filters->>'paymentStatus' = 'all'
    or requests.payment_status = p_filters->>'paymentStatus'
  )
  and (
    nullif(p_filters->>'vacationType', '') is null
    or p_filters->>'vacationType' = 'all'
    or requests.vacation_type = p_filters->>'vacationType'
  )
  and (
    nullif(p_filters->>'employee', '') is null
    or requests.employee_hr_id ilike p_filters->>'employee'
  )
  and (
    nullif(p_filters->>'manager', '') is null
    or requests.manager_hr_id ilike p_filters->>'manager'
  )
  and (
    nullif(p_filters->>'department', '') is null
    or requests.department_name = p_filters->>'department'
  )
  and (
    nullif(p_filters->>'line', '') is null
    or requests.line_name = p_filters->>'line'
  )
  and (
    nullif(p_filters->>'dateFrom', '') is null
    or requests.start_date >= (p_filters->>'dateFrom')::date
  )
  and (
    nullif(p_filters->>'dateTo', '') is null
    or requests.start_date <= (p_filters->>'dateTo')::date
  )
  and (
    nullif(p_filters->>'requestId', '') is null
    or requests.id::text = p_filters->>'requestId'
  )
  and (
    nullif(p_filters->>'search', '') is null
    or concat_ws(
      ' ',
      requests.id::text,
      requests.employee_hr_id,
      requests.employee_name,
      requests.manager_hr_id,
      requests.manager_name,
      requests.department_name,
      requests.line_name,
      requests.vacation_type,
      requests.status,
      requests.payment_status
    ) ilike '%' || (p_filters->>'search') || '%'
  )
  order by requests.created_at desc
  limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.phx_vacation_report_rows(text[], jsonb, integer, integer) from public;
revoke all on function public.phx_vacation_report_rows(text[], jsonb, integer, integer) from anon, authenticated;
grant execute on function public.phx_vacation_report_rows(text[], jsonb, integer, integer) to service_role;
notify pgrst, 'reload schema';
commit;
