-- Phoenix CRM — the PILOT ROSTER.
--
-- WHAT THIS IS. The owner, 2026-09-14: Phoenix CRM is its own space inside Phoenix (Visits, Planning,
-- KPIs) for the medical reps the owner picks, from any line, with no end date until the owner says. Once the pilot
-- is confirmed it merges into Phoenix and the whole company works in it. Until then a rep opens Phoenix
-- CRM only while on this roster — a whole line no longer opens it, and nobody else sees it.
--
-- iReports360 stays the record: nothing here touches an ireports360_* table, and Phoenix CRM's KPIs
-- read only what the pilot reps entered in Phoenix ("start clean from scratch, then later merge the
-- data" — the owner). crm_native_visit_pilots is kept, unread by the gate, so ending the pilot never
-- loses history.
--
-- WHAT IS HERE.
--   crm_native_pilot_reps         one row per rep ever placed on the roster. Removing a rep stamps
--                                 removed_at; adding the rep back clears it. Never deleted.
--   crm_native_pilot_rep_events   append-only: added, removed — who and when.
--
-- PURELY ADDITIVE. RLS on, nothing granted to anon or authenticated; every read and write goes through
-- the service-role client behind the app's own Super Admin check.

begin;

create table if not exists public.crm_native_pilot_reps (
  hr_id text primary key references public.employees (hr_id),
  starts_on date not null,
  added_at timestamptz not null default now(),
  added_by text not null,
  removed_at timestamptz,
  removed_by text,
  updated_at timestamptz not null default now(),
  constraint crm_native_pilot_reps_removal check ((removed_at is null) = (removed_by is null))
);

comment on table public.crm_native_pilot_reps is
  'Phoenix CRM pilot roster: the medical reps the owner picked. A rep opens Phoenix CRM only while on it (removed_at null). Pilot only: nothing reaches pay, deductions, probation or company KPIs.';

create index if not exists crm_native_pilot_reps_active_idx
  on public.crm_native_pilot_reps (hr_id)
  where removed_at is null;

create table if not exists public.crm_native_pilot_rep_events (
  id bigint generated always as identity primary key,
  hr_id text not null references public.employees (hr_id),
  event text not null,
  actor_hr_id text not null,
  created_at timestamptz not null default now(),
  constraint crm_native_pilot_rep_events_event check (event in ('added', 'removed'))
);

comment on table public.crm_native_pilot_rep_events is
  'Append-only history of the Phoenix CRM pilot roster: who added or removed which rep, and when.';

create index if not exists crm_native_pilot_rep_events_rep_idx
  on public.crm_native_pilot_rep_events (hr_id, created_at);

alter table public.crm_native_pilot_reps enable row level security;
alter table public.crm_native_pilot_rep_events enable row level security;

revoke all on table public.crm_native_pilot_reps from anon, authenticated;
revoke all on table public.crm_native_pilot_rep_events from anon, authenticated;
revoke all on sequence public.crm_native_pilot_rep_events_id_seq from anon, authenticated;

commit;

-- ROLLBACK. Both tables are additive. Dropping them closes Phoenix CRM to every pilot rep at once
-- (the gate reads an absent table as an empty roster) and loses who was on it — production has no PITR:
--   begin;
--   drop table if exists public.crm_native_pilot_rep_events;
--   drop table if exists public.crm_native_pilot_reps;
--   commit;
