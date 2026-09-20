-- ats_interview_outcome_didnt_come_reasons
--
-- WHAT THIS CHANGES: widens the closed list on public.ats_interview_bookings.outcome from six words to
-- nine, adding the three reasons that sit under "Didn't come": will_reschedule, no_answer, withdrew.
-- Every word already allowed stays allowed, so no existing row is touched or invalidated. No grant
-- changes; the table stays service-role only.
-- WHY: the owner, 2026-09-20 — the outcome picker is now two steps ("if attended cascade its options,
-- and if didn't come cascade its options"); asked what should appear under Didn't come, he chose
-- Will reschedule / No answer / Withdrew. They mark the interview only.
-- ROLLBACK: put the six-word check back —
--   alter table public.ats_interview_bookings drop constraint ats_interview_bookings_outcome_valid;
--   alter table public.ats_interview_bookings add constraint ats_interview_bookings_outcome_valid
--     check (outcome is null or outcome in ('attended','did_not_come','shortlisted','backup','rejected','prioritized'));
-- (it fails while any row already holds one of the three new words — clear those to NULL first).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one only widens a check: additive, touches no row.

begin;

alter table public.ats_interview_bookings
  drop constraint if exists ats_interview_bookings_outcome_valid;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_outcome_valid
    check (
      outcome is null
      or outcome in (
        'attended', 'shortlisted', 'backup', 'rejected', 'prioritized',
        'did_not_come', 'will_reschedule', 'no_answer', 'withdrew'
      )
    );

comment on column public.ats_interview_bookings.outcome is
  'What happened at the interview. Attended, or one of its decisions (shortlisted, backup, rejected, prioritized); Didn''t come (did_not_come), or one of its reasons (will_reschedule, no_answer, withdrew). NULL until the interviewer (or the calendar owner) records it.';

commit;
