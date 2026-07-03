-- iReports360 GPS check-ins: synced alongside ireports360_visits from the same CRM API
-- session (GET /api/ReportsApi/checkins). Best-effort correlation with visits by
-- (agent, same calendar day) — the vendor's own data model has no shared key between
-- Visits and VisitChecks, so this is never a guaranteed exact join. Reporting/evidence
-- only: does not mutate attendance, leave, deductions, payroll, or workflow decisions.

create table if not exists public.ireports360_checkins (
  id uuid primary key default gen_random_uuid(),
  crm_checkin_id bigint not null,
  agent_crm_id bigint not null,
  agent_hr_id text null,
  contact_crm_id bigint null,
  contact_name text null,
  lat double precision null,
  lon double precision null,
  address text null,
  check_date timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ireports360_checkins_crm_checkin_id_unique unique (crm_checkin_id)
);

create index if not exists ireports360_checkins_agent_date_idx
  on public.ireports360_checkins (agent_crm_id, check_date);

create index if not exists ireports360_checkins_agent_hr_id_idx
  on public.ireports360_checkins (agent_hr_id, check_date);

alter table public.ireports360_checkins enable row level security;

revoke all on table public.ireports360_checkins from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_checkins to service_role;

drop policy if exists ireports360_checkins_service_role on public.ireports360_checkins;
create policy ireports360_checkins_service_role
  on public.ireports360_checkins
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_checkins is
  'GPS check-ins mirrored from iReports360, synced alongside ireports360_visits. crm_checkin_id is the CRM''s own stable id — upserts on it make re-syncing overlapping date ranges idempotent. Correlated with visits by (agent_crm_id, same calendar day) as a best-effort overlay, not a guaranteed 1:1 join.';

-- visit_date (date-only) already exists for date-range filtering; add the full timestamp
-- separately so the check-in correlation can pick the check-in closest in time to each visit,
-- not just "same day". Existing rows will be null here until re-synced (idempotent upsert
-- naturally backfills it on the next sync of that date range).
alter table public.ireports360_visits
  add column if not exists visit_date_time timestamptz null;

comment on column public.ireports360_visits.visit_date_time is
  'Full visitDate timestamp from iReports360 (visit_date is the date-only slice used for range filtering). Used to pick the nearest GPS check-in by time, not just by calendar day.';
