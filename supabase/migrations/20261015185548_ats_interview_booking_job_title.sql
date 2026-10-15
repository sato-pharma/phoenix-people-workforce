-- ats_interview_booking_job_title
--
-- WHAT THIS CHANGES: adds one nullable text column, `interview_job_title`, to
--   public.ats_interview_bookings — the job the interview is FOR.
-- WHY: a booking recorded the sales Area and Line but nothing naming the role, so a candidate the
--   calendar creates (ats_candidates.source = 'interview_calendar') was written with
--   applied_for_job_title NULL and never appeared in that round's pile. Measured on production
--   2026-10-15: of the 68 interviews from 1 September on, 28 sit on a candidate with no job title.
--   The booking is where the role is known — it is chosen when the interview is booked — so it is
--   stored here and carried onto the candidate at creation.
-- ROLLBACK: alter table public.ats_interview_bookings drop column interview_job_title;
--   (that discards whatever roles have been recorded since; nothing else reads the column)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
--
-- Additive and nullable: no existing row changes, no default is written, no backfill is attempted.
-- The old bookings stay as they are — nobody can say now what role an interview held in September
-- was for, and a guess written into the table would read exactly like a recorded fact.

begin;

alter table public.ats_interview_bookings
  add column if not exists interview_job_title text;

comment on column public.ats_interview_bookings.interview_job_title is
  'The job this interview is for, as free text — chosen from offer_job_titles where the role is in that catalogue, typed otherwise. Carried onto a candidate the calendar creates as ats_candidates.applied_for_job_title.';

commit;
