-- ats_interview_booking_outcome
--
-- WHAT THIS CHANGES: adds three nullable columns to public.ats_interview_bookings — the outcome the
-- interviewer records after an interview (one of six words), who recorded it and when. No existing
-- row is touched: every booking starts with no outcome. No grant changes; the table stays
-- service-role only, exactly as before.
-- WHY: the owner, 2026-09-20 — "an option on every interview: attended, didn't come, shortlisted,
-- back-up, rejected, prioritized". One list of six, set by the interviewer or the calendar's owner.
-- ROLLBACK: alter table public.ats_interview_bookings drop column outcome, drop column outcome_set_by_hr_id,
-- drop column outcome_set_at; (loses only the outcomes recorded since — nothing else reads them).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is additive and touches no existing row.

begin;

alter table public.ats_interview_bookings
  add column if not exists outcome text,
  add column if not exists outcome_set_by_hr_id text,
  add column if not exists outcome_set_at timestamptz;

-- The list is pinned here as well as in code (interview-calendar-types.ts): unlike a candidate
-- status, an outcome is a small closed list the calendar screen and its exports both key on.
alter table public.ats_interview_bookings
  drop constraint if exists ats_interview_bookings_outcome_valid;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_outcome_valid
    check (outcome is null or outcome in ('attended', 'did_not_come', 'shortlisted', 'backup', 'rejected', 'prioritized'));

comment on column public.ats_interview_bookings.outcome is
  'What happened at the interview: attended, did_not_come, shortlisted, backup, rejected or prioritized. NULL until the interviewer (or the calendar owner) records it.';

commit;
