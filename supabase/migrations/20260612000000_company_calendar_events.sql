-- Company / team calendar events for the employee-portal calendar.
--
-- Self-contained, in-app calendar (no Google / personal-account sign-in). Events
-- are created by HR/Admin (company-wide or line) and managers (their line), and
-- viewed by all staff. Aggregated read sources (public holidays, the viewer's
-- approved leave, plan days, team birthdays) are computed in the service layer
-- and are NOT stored here.
--
-- Security: Phoenix uses application-managed auth and server-side service-role
-- access. This table is never exposed to anon/authenticated clients; RLS is
-- enabled as defense in depth with a service_role-only policy.

create extension if not exists pgcrypto;

create table if not exists public.company_calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text null,
  category text not null default 'event',
  start_date date not null,
  end_date date not null,
  all_day boolean not null default true,
  start_time time null,
  end_time time null,
  location text null,
  audience_scope text not null default 'company',
  line_name text null,
  created_by_hr_id text null,
  created_by_name text null,
  created_by_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_calendar_events_title_not_blank check (btrim(title) <> ''),
  constraint company_calendar_events_category_check check (category in (
    'meeting', 'training', 'event', 'announcement', 'deadline', 'holiday', 'other'
  )),
  constraint company_calendar_events_scope_check check (audience_scope in ('company', 'line')),
  constraint company_calendar_events_line_required check (
    audience_scope <> 'line' or btrim(coalesce(line_name, '')) <> ''
  ),
  constraint company_calendar_events_date_range check (end_date >= start_date)
);

create index if not exists company_calendar_events_range_idx
  on public.company_calendar_events (start_date, end_date);

create index if not exists company_calendar_events_scope_line_idx
  on public.company_calendar_events (audience_scope, line_name);

create or replace function public.phx_touch_company_calendar_events()
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

revoke all on function public.phx_touch_company_calendar_events() from public, anon, authenticated;
grant execute on function public.phx_touch_company_calendar_events() to service_role;

drop trigger if exists company_calendar_events_touch on public.company_calendar_events;
create trigger company_calendar_events_touch
  before update on public.company_calendar_events
  for each row
  execute function public.phx_touch_company_calendar_events();

alter table public.company_calendar_events enable row level security;

revoke all on table public.company_calendar_events from anon, authenticated;
grant select, insert, update, delete on table public.company_calendar_events to service_role;

drop policy if exists company_calendar_events_service_role_all on public.company_calendar_events;
create policy company_calendar_events_service_role_all
  on public.company_calendar_events for all to service_role using (true) with check (true);

comment on table public.company_calendar_events is
  'Employee-portal company/team calendar events. Created by HR/Admin (company or line) and managers (their line); viewed by all staff. Aggregated holiday/leave/plan/birthday items are computed server-side and not stored here.';

notify pgrst, 'reload schema';
