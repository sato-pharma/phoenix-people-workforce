-- iReports360 Visits Report: a full, automatically-synced mirror of every visit recorded in
-- the iReports360 CRM (solo calls, campaign visits, double visits, leave/vacation entries — not
-- just the double-visit subset already captured in double_visit_rows). Reporting/evidence only:
-- this table does not mutate attendance, leave, deductions, payroll, or workflow decisions.

create table if not exists public.ireports360_visits (
  id uuid primary key default gen_random_uuid(),
  crm_visit_id bigint not null,
  visit_date date not null,
  agent_crm_id bigint not null,
  agent_name text null,
  agent_hr_id text null,
  double_crm_id bigint null,
  double_name text null,
  double_hr_id text null,
  contact_crm_id bigint null,
  contact_name text null,
  customer_name text null,
  comment text null,
  visit_type integer null,
  visit_type_description text null,
  call_type integer null,
  ampm text null,
  attendance integer null,
  crm_save_date timestamptz null,
  raw_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ireports360_visits_crm_visit_id_unique unique (crm_visit_id)
);

create index if not exists ireports360_visits_visit_date_idx
  on public.ireports360_visits (visit_date);

create index if not exists ireports360_visits_agent_idx
  on public.ireports360_visits (agent_hr_id, visit_date);

create index if not exists ireports360_visits_double_idx
  on public.ireports360_visits (double_hr_id, visit_date);

-- Sync run log: gives the admin UI (and this team's trust after the missing-data incident)
-- visibility into whether the scheduled pull is actually running and current.
create table if not exists public.ireports360_visits_sync_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null default 'cron',
  date_from date not null,
  date_to date not null,
  status text not null default 'running',
  rows_fetched integer not null default 0,
  rows_upserted integer not null default 0,
  error_message text null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint ireports360_visits_sync_runs_trigger_check
    check (trigger in ('cron', 'manual_backfill', 'manual')),
  constraint ireports360_visits_sync_runs_status_check
    check (status in ('running', 'success', 'failed')),
  constraint ireports360_visits_sync_runs_date_range_check
    check (date_to >= date_from)
);

create index if not exists ireports360_visits_sync_runs_started_idx
  on public.ireports360_visits_sync_runs (started_at desc);

alter table public.ireports360_visits enable row level security;
alter table public.ireports360_visits_sync_runs enable row level security;

revoke all on table public.ireports360_visits from anon, authenticated;
revoke all on table public.ireports360_visits_sync_runs from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_visits to service_role;
grant select, insert, update, delete on table public.ireports360_visits_sync_runs to service_role;

drop policy if exists ireports360_visits_service_role on public.ireports360_visits;
create policy ireports360_visits_service_role
  on public.ireports360_visits
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists ireports360_visits_sync_runs_service_role on public.ireports360_visits_sync_runs;
create policy ireports360_visits_sync_runs_service_role
  on public.ireports360_visits_sync_runs
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_visits is
  'Full mirror of every iReports360 CRM visit record (solo, campaign, double, leave/vacation), synced automatically. crm_visit_id is the CRM''s own stable id — upserts on it make re-syncing overlapping date ranges idempotent.';

comment on table public.ireports360_visits_sync_runs is
  'Audit log of each iReports360 sync attempt (scheduled or manual backfill), so sync freshness/failures are visible instead of silent.';

comment on column public.ireports360_visits.agent_hr_id is
  'Phoenix employee HR ID mapped from agent_crm_id via employees.crm_id, if a match exists. Null when unmapped.';

comment on column public.ireports360_visits.double_hr_id is
  'Phoenix employee HR ID mapped from double_crm_id via employees.crm_id, if a match exists. Null when there is no double visitor (double_crm_id is null/0) or the CRM id is unmapped.';
