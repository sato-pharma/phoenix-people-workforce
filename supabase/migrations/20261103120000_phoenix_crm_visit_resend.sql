-- phoenix_crm_visit_resend
--
-- WHAT THIS CHANGES: one column on the capture provenance table, one new table, and one switch on the
-- settings row. All additive. `phoenix_crm_save_visit` is deliberately NOT re-emitted and must read the same
-- `md5(prosrc)` before and after: the save dates a browser's visit at arrival and nothing here changes that.
--
-- WHY IT EXISTS (owner, 3 Nov 2026: build the visit retry). A rep who pressed Log visit where the signal dropped
-- lost the visit, comment and all. The press is now held on the phone and sent again while Phoenix is open,
-- for up to two hours and never across 02:00 (src/lib/phoenix-crm/visit-resend-rules.ts).
--
--   1. `queued_seconds`: how long the phone held a save before it arrived. A DURATION and never a date, and it
--      never reaches the save function. Without it a late save reads as a wrong phone clock and as impossible
--      travel, which would be a false flag against a rep who did nothing wrong. It is filed after the save,
--      where `fix_age_seconds` already is. Null is the normal case: a save that was never held.
--
--   2. `phoenix_crm_visit_resend_log`: how each held visit ended. Nothing recorded a press before, so "pressed
--      and never saved" had only a floor. Joined to `phoenix_crm_visits` it becomes a count. It undercounts a
--      phone that never reopens, and a rep's own Remove counts too: read it as "no visit saved", never as "lost".
--
--   3. `visit_resend_enabled`: the off switch, so stopping this never needs a merge.
--
-- 🔴 NOTHING HERE REFUSES A VISIT OR REACHES A REP, the same shape as the capture provenance table beside it.
--
-- REVERSIBILITY:
--   alter table public.phoenix_crm_visit_capture_provenance drop column queued_seconds;
--   drop table public.phoenix_crm_visit_resend_log;
--   alter table public.phoenix_crm_settings drop column visit_resend_enabled;
-- restores the previous schema exactly. Deploy the code that stops reading them first.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_visit_capture_provenance
  add column if not exists queued_seconds integer
    check (queued_seconds is null or queued_seconds between 1 and 7200);

comment on column public.phoenix_crm_visit_capture_provenance.queued_seconds is
  'Seconds the phone held this save before it arrived, measured on the phone''s own clock. A duration, never a date, and never read by the save. NULL is a save that was never held. Service role only.';

-- The travel check reads one rep's held saves on every capture, and they are rare, so the index holds only them.
create index if not exists phoenix_crm_visit_capture_provenance_queued_idx
  on public.phoenix_crm_visit_capture_provenance (rep_hr_id, captured_at desc)
  where queued_seconds is not null;

create table if not exists public.phoenix_crm_visit_resend_log (
  -- The visit's own id, made on the phone at the press. Deliberately no foreign key: a visit that was never
  -- saved is the very thing this row exists to count.
  visit_id uuid primary key,
  rep_hr_id text not null,
  seat_id text not null,
  customer_id uuid not null,
  -- The press, on the phone's own clock.
  pressed_at_device timestamptz,
  outcome text not null
    check (outcome in ('landed_late', 'already_saved', 'refused', 'timed_out', 'removed', 'relogged')),
  refusal_code text,
  queued_seconds integer check (queued_seconds is null or queued_seconds between 1 and 7200),
  attempts integer not null default 0 check (attempts >= 0),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.phoenix_crm_visit_resend_log is
  'How each visit a phone held for want of signal ended. Service role only; no rep-facing screen reads it and it refuses nothing. See src/lib/phoenix-crm/server/visit-resend-log.ts.';

create index if not exists phoenix_crm_visit_resend_log_rep_idx
  on public.phoenix_crm_visit_resend_log (rep_hr_id, created_at desc);

-- Locked to the service role in the same four statements every other table in this module states.
alter table public.phoenix_crm_visit_resend_log enable row level security;
create policy phoenix_crm_visit_resend_log_service_role
  on public.phoenix_crm_visit_resend_log for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_resend_log from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_resend_log to service_role;

alter table public.phoenix_crm_settings
  add column if not exists visit_resend_enabled boolean not null default true;

comment on column public.phoenix_crm_settings.visit_resend_enabled is
  'The visit retry''s off switch. Off, a press behaves as it did before the queue existed and nothing held is sent by itself.';

notify pgrst, 'reload schema';

commit;
