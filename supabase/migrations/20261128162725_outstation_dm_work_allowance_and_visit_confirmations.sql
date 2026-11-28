-- outstation_dm_work_allowance_and_visit_confirmations
--
-- WHAT THIS CHANGES: one nullable column on outstation_expense_requests and one new table.
--   * outstation_expense_requests.dm_work_allowance jsonb — a District Manager claim filed under the work
--     rules of 28 Nov 2026 carries it (src/lib/outstation/dm-expense-rules.ts): each trip day's AM and PM,
--     its confirmed double visits and the share of the allowance it pays. NULL = a claim filed before the
--     rules, which keeps the allowance it was priced at. Every existing row stays NULL.
--   * outstation_dm_visit_confirmations — a District Manager's confirmation of a double visit a rep logged
--     with him, with where he was when he pressed Confirm. One row per visit, written once.
-- WHY: the owner's District Manager expense policy (28 Nov 2026): "the DM must confirm at least the first
--   and last double visit of every trip day; the confirmation sends the DM's location; without it, that
--   day's allowance is cancelled", and each trip day's allowance is paid by the day's AM and PM work.
-- ROLLBACK: drop table public.outstation_dm_visit_confirmations;
--           alter table public.outstation_expense_requests drop column dm_work_allowance;
--   Both are additive; nothing existing is changed, so the rollback loses only what the new code wrote.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists dm_work_allowance jsonb;

comment on column public.outstation_expense_requests.dm_work_allowance is
  'District Manager work rules (owner, 28 Nov 2026; dm-expense-rules.ts): per trip day AM, PM, confirmed double visits and the share of the allowance paid. NULL = filed before the rules.';

create table if not exists public.outstation_dm_visit_confirmations (
  visit_id uuid primary key references public.phoenix_crm_visits(id) on delete cascade,
  manager_hr_id text not null,
  visit_date date not null,
  confirmed_at timestamptz not null default now(),
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters double precision,
  distance_km double precision,
  created_at timestamptz not null default now()
);

comment on table public.outstation_dm_visit_confirmations is
  'A District Manager confirms a double visit a rep logged with him, with his position at the press (owner, 28 Nov 2026). Read by the outstation work allowance; never shown to the rep.';

create index if not exists outstation_dm_visit_confirmations_manager_day_idx
  on public.outstation_dm_visit_confirmations (manager_hr_id, visit_date);

-- Server-only: the app reads and writes it with the service role. No browser role may touch it.
alter table public.outstation_dm_visit_confirmations enable row level security;
revoke all on table public.outstation_dm_visit_confirmations from public, anon, authenticated;
grant select, insert on table public.outstation_dm_visit_confirmations to service_role;

commit;
