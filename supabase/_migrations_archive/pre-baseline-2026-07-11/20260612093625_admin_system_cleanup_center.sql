begin;

create extension if not exists pgcrypto;

create table if not exists public.admin_cleanup_events (
  id uuid primary key default gen_random_uuid(),
  actor_login_id text not null default 'system',
  actor_hr_id text null,
  actor_role text null,
  module_key text not null check (module_key in ('vacation_requests', 'outstation_expenses', 'weekly_plans')),
  record_id text not null,
  employee_hr_id text null,
  employee_name text null,
  action text not null check (action in ('delete')),
  reason text not null check (char_length(btrim(reason)) >= 10),
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed', 'blocked')),
  safety_level text not null default 'standard' check (safety_level in ('standard', 'blocked', 'payroll_locked')),
  block_reason text null,
  impact_summary jsonb not null default '{}'::jsonb,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists admin_cleanup_events_employee_created_idx
  on public.admin_cleanup_events (employee_hr_id, created_at desc);

create index if not exists admin_cleanup_events_module_record_idx
  on public.admin_cleanup_events (module_key, record_id, created_at desc);

create index if not exists admin_cleanup_events_actor_created_idx
  on public.admin_cleanup_events (actor_login_id, created_at desc);

alter table public.admin_cleanup_events enable row level security;

revoke all on table public.admin_cleanup_events from anon, authenticated;
grant select, insert, update on table public.admin_cleanup_events to service_role;

drop policy if exists admin_cleanup_events_service_role_all
  on public.admin_cleanup_events;

create policy admin_cleanup_events_service_role_all
  on public.admin_cleanup_events
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.admin_cleanup_events is
  'Super Admin cleanup history for controlled removal of test or incorrect workflow records. Server-only; never exposed directly to browser roles.';

notify pgrst, 'reload schema';

commit;
