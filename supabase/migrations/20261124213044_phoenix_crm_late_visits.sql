-- phoenix_crm_late_visits
--
-- WHAT THIS CHANGES: one new table, public.phoenix_crm_late_visits, service role only. A visit a phone held for want
-- of signal that could not be sent inside its window (two hours, or before the 02:00 close) is filed here WHOLE —
-- the very body the press would have sent — instead of waiting on the phone for the person to log it again.
-- It counts in nothing. Only the Super Admin approves it onto the day it was pressed, through the missed-record door
-- that already enters a rep's or a manager's visit on an earlier day, or rejects it.
-- WHY: owner, 24 Nov 2026: "make all things to never any visit to be lost from either a rep or from the manager",
-- then, on what to do with a visit that missed its window: "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN".
-- ROLLBACK: remove the table public.phoenix_crm_late_visits with a new migration. That loses every late visit still
-- waiting for a decision, so read the pending rows out first.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_late_visits (
  -- The held visit's own id, made on the phone at the press: a visit's id, or a manager's single visit's client ref.
  -- No foreign key: a visit that was never saved is the very thing this row exists to keep.
  id uuid primary key,
  kind text not null check (kind in ('territory', 'manager_single')),
  -- Whose phone sent it — the signed-in person, read from the session, never from the body.
  sender_hr_id text not null,
  seat_id text not null,
  customer_id uuid not null,
  customer_name text not null,
  -- The press on the phone's own clock, and the visit day the phone thought it was. Neither is trusted on its own:
  -- the Super Admin reads both beside the arrival before he decides.
  pressed_at_device timestamptz,
  pressed_day date not null,
  arrived_at timestamptz not null default now(),
  -- The whole press, exactly as it would have been sent.
  body jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by_hr_id text,
  decided_at timestamptz,
  -- The visit the approval entered (a territory visit's id), or null.
  approved_visit_id uuid,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'pending' or (decided_by_hr_id is not null and decided_at is not null))
);

comment on table public.phoenix_crm_late_visits is
  'A held visit that missed its window, kept whole until the Super Admin approves it onto its pressed day or rejects it. Counts in nothing until approved. Service role only. See src/lib/phoenix-crm/server/late-visits.ts.';

create index if not exists phoenix_crm_late_visits_pending_idx
  on public.phoenix_crm_late_visits (status, arrived_at desc);

-- Locked to the service role in the same four statements every other table in this module states.
alter table public.phoenix_crm_late_visits enable row level security;
create policy phoenix_crm_late_visits_service_role
  on public.phoenix_crm_late_visits for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_late_visits from public, anon, authenticated;
grant all on table public.phoenix_crm_late_visits to service_role;

notify pgrst, 'reload schema';

commit;
