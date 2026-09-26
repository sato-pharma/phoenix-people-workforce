-- ats_interview_bookings: interviewer confirmation + a change-history table
--
-- WHAT THIS CHANGES (Tier 3, owner 2026-09-26):
--   1. FOUR new NULLABLE columns on public.ats_interview_bookings:
--        interviewer_confirmation          text  -- 'confirmed' | 'declined', NULL = not answered yet
--        interviewer_confirmation_at       timestamptz
--        interviewer_confirmation_by_hr_id text
--        decline_reason                    text  -- why the interviewer declined
--      The chosen interviewer confirms ("I'll conduct it") or declines ("I can't") the assignment.
--      A decline keeps the row visible so it can be reassigned, and stops the reminders to him.
--   2. one NEW table — ats_interview_booking_changes — the change history of a booking: one row per
--      recorded change (booked, rescheduled, interviewer set, confirmed, declined, CV replaced,
--      outcome recorded …), with who did it and a short human summary.
--
-- WHY: the owner, 2026-09-26 (Tier 3) — the last of the interview-calendar upskill. Confirm/decline
--   lets an interviewer answer the assignment; the history makes every change on an interview
--   auditable in the detail view.
--
-- ROLLBACK:
--   drop table public.ats_interview_booking_changes;
--   alter table public.ats_interview_bookings
--     drop column decline_reason,
--     drop column interviewer_confirmation_by_hr_id,
--     drop column interviewer_confirmation_at,
--     drop column interviewer_confirmation;
--   Nothing below deletes or rewrites an existing row — the columns are added NULL and the table is
--   new and empty.
--
-- Service-role only for the new table: RLS on, no policy, nothing to anon/authenticated — the same
-- shape as the other ats_interview_* tables. Production has NO point-in-time recovery (7 daily
-- backups); this change is additive and non-destructive.

begin;

alter table public.ats_interview_bookings
  add column if not exists interviewer_confirmation text,
  add column if not exists interviewer_confirmation_at timestamptz,
  add column if not exists interviewer_confirmation_by_hr_id text,
  add column if not exists decline_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ats_interview_bookings_confirmation_valid'
  ) then
    alter table public.ats_interview_bookings
      add constraint ats_interview_bookings_confirmation_valid
      check (interviewer_confirmation is null or interviewer_confirmation in ('confirmed', 'declined'));
  end if;
end $$;

comment on column public.ats_interview_bookings.interviewer_confirmation is
  'The chosen interviewer''s answer to the assignment: confirmed | declined | NULL (not answered). A decline keeps the row for reassignment and stops the reminders to that interviewer.';

create table if not exists public.ats_interview_booking_changes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ats_interview_bookings(id) on delete cascade,
  actor_hr_id text,
  kind text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create index if not exists ats_interview_booking_changes_booking_idx
  on public.ats_interview_booking_changes (booking_id, created_at desc);

comment on table public.ats_interview_booking_changes is
  'The change history of one interview booking: one row per recorded change (booked, rescheduled, interviewer set, confirmed, declined, CV replaced, outcome recorded …), with who did it and a short human summary. Append-only; written server-side after an app-level check.';

alter table public.ats_interview_booking_changes enable row level security;

revoke all on table public.ats_interview_booking_changes from anon, authenticated;

grant all on table public.ats_interview_booking_changes to service_role;

commit;
