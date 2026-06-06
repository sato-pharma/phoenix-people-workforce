-- Weekly / Monthly Planning v1.
--
-- Additive layer over the older weekly_plans foundation. This migration does
-- not drop or rewrite existing planning tables. Phoenix uses application-managed
-- auth and server-side service-role access for workflow mutations; direct
-- browser access to these tables stays revoked.

begin;

create extension if not exists pgcrypto;

create table if not exists public.employee_plan_headers (
  id uuid primary key default gen_random_uuid(),
  plan_kind text not null,
  period_key text not null,
  period_start_date date not null,
  period_end_date date not null,
  revision integer not null default 1,
  parent_plan_id uuid null references public.employee_plan_headers(id) on delete set null,
  employee_hr_id text not null,
  employee_name text not null,
  employee_job_title text null,
  manager_hr_id text null,
  manager_name text null,
  status text not null default 'draft',
  manager_decision_at timestamptz null,
  manager_decision_by_hr_id text null,
  manager_decision_comment text null,
  ceo_decision_at timestamptz null,
  ceo_decision_by_hr_id text null,
  ceo_decision_comment text null,
  submitted_at timestamptz null,
  submitted_by_login_id text null,
  final_approved_at timestamptz null,
  google_calendar_sync_status text not null default 'not_ready',
  google_calendar_synced_at timestamptz null,
  google_calendar_last_error text null,
  hierarchy_snapshot jsonb not null default '{}'::jsonb,
  created_by_login_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_plan_headers_plan_kind_check check (plan_kind in ('weekly', 'monthly')),
  constraint employee_plan_headers_status_check check (status in (
    'draft',
    'submitted',
    'manager_approved',
    'manager_rejected',
    'manager_returned',
    'ceo_approved',
    'ceo_rejected',
    'ceo_returned',
    'final_approved',
    'hr_acknowledged',
    'cancelled'
  )),
  constraint employee_plan_headers_calendar_status_check check (
    google_calendar_sync_status in ('not_ready', 'pending', 'synced', 'blocked', 'failed')
  ),
  constraint employee_plan_headers_employee_hr_id_not_blank check (btrim(employee_hr_id) <> ''),
  constraint employee_plan_headers_period_key_not_blank check (btrim(period_key) <> ''),
  constraint employee_plan_headers_period_range check (period_end_date >= period_start_date),
  constraint employee_plan_headers_revision_positive check (revision > 0)
);

create unique index if not exists employee_plan_headers_active_period_uidx
  on public.employee_plan_headers (employee_hr_id, plan_kind, period_key)
  where status in ('submitted', 'manager_approved', 'manager_returned', 'ceo_returned');

create index if not exists employee_plan_headers_employee_period_idx
  on public.employee_plan_headers (employee_hr_id, plan_kind, period_start_date desc);

create index if not exists employee_plan_headers_manager_queue_idx
  on public.employee_plan_headers (manager_hr_id, status, submitted_at desc);

create index if not exists employee_plan_headers_status_period_idx
  on public.employee_plan_headers (status, period_start_date desc);

create table if not exists public.employee_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.employee_plan_headers(id) on delete cascade,
  activity_date date not null,
  start_time time null,
  end_time time null,
  activity_type text not null,
  activity_title text not null,
  objective text null,
  attendees text null,
  location_text text null,
  area text null,
  double_visit_medical_rep_hr_id text null,
  double_visit_medical_rep_name text null,
  notes text not null default '',
  employee_calendar_event_id text null,
  shared_calendar_event_id text null,
  calendar_sync_status text not null default 'not_ready',
  calendar_synced_at timestamptz null,
  calendar_last_error text null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_plan_items_activity_type_check check (activity_type in (
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
  constraint employee_plan_items_calendar_status_check check (
    calendar_sync_status in ('not_ready', 'pending', 'synced', 'blocked', 'failed')
  ),
  constraint employee_plan_items_title_not_blank check (btrim(activity_title) <> ''),
  constraint employee_plan_items_time_order check (
    start_time is null or end_time is null or end_time > start_time
  )
);

create index if not exists employee_plan_items_plan_date_idx
  on public.employee_plan_items (plan_id, activity_date, sort_order);

create table if not exists public.employee_plan_decisions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.employee_plan_headers(id) on delete cascade,
  actor_hr_id text null,
  actor_login_id text null,
  actor_role text not null,
  action text not null,
  from_status text not null,
  to_status text not null,
  comment text null,
  created_at timestamptz not null default now(),
  constraint employee_plan_decisions_action_check check (action in (
    'submit',
    'manager_approve',
    'manager_reject',
    'manager_return',
    'ceo_approve',
    'ceo_reject',
    'ceo_return',
    'hr_acknowledge',
    'revise',
    'cancel'
  ))
);

create index if not exists employee_plan_decisions_plan_created_idx
  on public.employee_plan_decisions (plan_id, created_at desc);

create table if not exists public.employee_plan_hr_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.employee_plan_headers(id) on delete cascade,
  hr_id text not null,
  login_id text null,
  role_label text null,
  comment text null,
  acknowledged_at timestamptz not null default now(),
  constraint employee_plan_hr_ack_plan_hr_uidx unique (plan_id, hr_id)
);

create index if not exists employee_plan_hr_ack_plan_idx
  on public.employee_plan_hr_acknowledgements (plan_id, acknowledged_at desc);

create table if not exists public.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  hr_id text null,
  google_email text null,
  calendar_id text not null default 'primary',
  access_token_encrypted text null,
  refresh_token_encrypted text null,
  token_expires_at timestamptz null,
  scope text null,
  status text not null default 'connected',
  last_error text null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint google_calendar_connections_user_id_unique unique (user_id),
  constraint google_calendar_connections_status_check check (status in ('connected', 'disabled', 'failed'))
);

create index if not exists google_calendar_connections_hr_id_idx
  on public.google_calendar_connections (hr_id);

create or replace function public.phx_touch_employee_plan_headers()
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

revoke all on function public.phx_touch_employee_plan_headers() from public, anon, authenticated;
grant execute on function public.phx_touch_employee_plan_headers() to service_role;

drop trigger if exists employee_plan_headers_touch on public.employee_plan_headers;
create trigger employee_plan_headers_touch
  before update on public.employee_plan_headers
  for each row
  execute function public.phx_touch_employee_plan_headers();

create or replace function public.phx_touch_employee_plan_items()
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

revoke all on function public.phx_touch_employee_plan_items() from public, anon, authenticated;
grant execute on function public.phx_touch_employee_plan_items() to service_role;

drop trigger if exists employee_plan_items_touch on public.employee_plan_items;
create trigger employee_plan_items_touch
  before update on public.employee_plan_items
  for each row
  execute function public.phx_touch_employee_plan_items();

create or replace function public.phx_touch_google_calendar_connections()
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

revoke all on function public.phx_touch_google_calendar_connections() from public, anon, authenticated;
grant execute on function public.phx_touch_google_calendar_connections() to service_role;

drop trigger if exists google_calendar_connections_touch on public.google_calendar_connections;
create trigger google_calendar_connections_touch
  before update on public.google_calendar_connections
  for each row
  execute function public.phx_touch_google_calendar_connections();

alter table public.employee_plan_headers enable row level security;
alter table public.employee_plan_items enable row level security;
alter table public.employee_plan_decisions enable row level security;
alter table public.employee_plan_hr_acknowledgements enable row level security;
alter table public.google_calendar_connections enable row level security;

revoke all on table public.employee_plan_headers from anon, authenticated;
revoke all on table public.employee_plan_items from anon, authenticated;
revoke all on table public.employee_plan_decisions from anon, authenticated;
revoke all on table public.employee_plan_hr_acknowledgements from anon, authenticated;
revoke all on table public.google_calendar_connections from anon, authenticated;

grant select, insert, update, delete on table public.employee_plan_headers to service_role;
grant select, insert, update, delete on table public.employee_plan_items to service_role;
grant select, insert, update, delete on table public.employee_plan_decisions to service_role;
grant select, insert, update, delete on table public.employee_plan_hr_acknowledgements to service_role;
grant select, insert, update, delete on table public.google_calendar_connections to service_role;

drop policy if exists employee_plan_headers_service_role_all on public.employee_plan_headers;
create policy employee_plan_headers_service_role_all
  on public.employee_plan_headers for all to service_role using (true) with check (true);

drop policy if exists employee_plan_items_service_role_all on public.employee_plan_items;
create policy employee_plan_items_service_role_all
  on public.employee_plan_items for all to service_role using (true) with check (true);

drop policy if exists employee_plan_decisions_service_role_all on public.employee_plan_decisions;
create policy employee_plan_decisions_service_role_all
  on public.employee_plan_decisions for all to service_role using (true) with check (true);

drop policy if exists employee_plan_hr_ack_service_role_all on public.employee_plan_hr_acknowledgements;
create policy employee_plan_hr_ack_service_role_all
  on public.employee_plan_hr_acknowledgements for all to service_role using (true) with check (true);

drop policy if exists google_calendar_connections_service_role_all on public.google_calendar_connections;
create policy google_calendar_connections_service_role_all
  on public.google_calendar_connections for all to service_role using (true) with check (true);

comment on table public.employee_plan_headers is
  'Weekly / Monthly Plan module headers. Approval workflow only; final approval may sync to Google Calendar but never mutates payroll or leave balances.';

comment on table public.employee_plan_items is
  'Structured dated activities for Weekly / Monthly Plans, including per-item Google Calendar sync state.';

comment on table public.google_calendar_connections is
  'Encrypted Google Calendar OAuth token storage for employee-owned calendar sync.';

notify pgrst, 'reload schema';

commit;
