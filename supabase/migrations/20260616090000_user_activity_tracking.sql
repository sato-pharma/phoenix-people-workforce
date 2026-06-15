-- User activity tracking foundation for the Admin Activity Control Center.
-- Captures lightweight, privacy-conscious page-view events (which module a
-- logged-in user opened and for how long). NEVER stores keystrokes, form
-- contents, or screen captures. Session start/end/duration is already covered by
-- app_sessions; this table only adds in-app navigation + dwell time.
-- Server-only (service_role); never exposed to browser/anon/authenticated roles.

begin;

create extension if not exists pgcrypto;

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  login_id text null,
  hr_id text null,
  session_id uuid null,
  event_type text not null default 'page_view'
    check (event_type in ('page_view')),
  -- The exact in-app path (stored for future drill-down) and its resolved,
  -- human-friendly module grouping (what the dashboard shows by default).
  path text not null,
  module_key text not null,
  module_label text not null,
  -- Dwell time on the page in milliseconds. Capped/sanitised in the app layer.
  duration_ms integer not null default 0 check (duration_ms >= 0),
  role text null,
  user_agent text null,
  entered_at timestamptz null,
  created_at timestamptz not null default now()
);

-- Per-user timeline (the "what did this person do today" drill-down).
create index if not exists activity_events_hr_created_idx
  on public.activity_events (hr_id, created_at desc);

-- Company-wide time-range scans (KPIs, trends).
create index if not exists activity_events_created_idx
  on public.activity_events (created_at desc);

-- Per-session correlation (stitch a single visit together).
create index if not exists activity_events_session_idx
  on public.activity_events (session_id, created_at);

-- Module popularity aggregation ("what modules are employees interested in").
create index if not exists activity_events_module_created_idx
  on public.activity_events (module_key, created_at desc);

-- Fallback identity lookup when hr_id is absent (login-only sessions).
create index if not exists activity_events_login_created_idx
  on public.activity_events (login_id, created_at desc);

alter table public.activity_events enable row level security;

revoke all on table public.activity_events from anon, authenticated;
grant select, insert, delete on table public.activity_events to service_role;

drop policy if exists activity_events_service_role_all
  on public.activity_events;

create policy activity_events_service_role_all
  on public.activity_events
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.activity_events is
  'Lightweight in-app navigation/dwell events feeding the Admin Activity Control Center. Module-level usage only (no keystrokes/contents). Server-only; never exposed to browser roles. Retention is enforced by the daily scheduled cleanup.';

notify pgrst, 'reload schema';

commit;
