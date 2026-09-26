-- ats_interview_booking_panelists
--
-- WHAT THIS CHANGES: one NEW nullable column on ats_interview_bookings — panelist_hr_ids text[] — the
--   ADDITIONAL interviewers on a panel, beyond the lead interviewer (interviewer_hr_id). Everyone in
--   the list sees the interview on their calendar, in their "My interviews" card and in their .ics
--   feed, exactly as the lead does; the lead stays the outcome-setter and the Zoom host.
--
-- WHY: the owner, 2026-09-26 — Tier 1 of making the interview calendar relevant to everyone: real
--   interviews are often a panel, and every member should see it, not only the one lead. An array on
--   the row (not a child table) keeps the read gate a single-row check with no join.
--
-- ROLLBACK:
--   alter table public.ats_interview_bookings drop column panelist_hr_ids;
--   Nothing below deletes or rewrites a row — it only adds a new column with an empty-array default.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This is
-- additive and non-destructive: a new nullable column with a default only. The table's service-role
-- only access is unchanged (RLS was set when the table was created).

begin;

alter table public.ats_interview_bookings
  add column if not exists panelist_hr_ids text[] not null default '{}';

comment on column public.ats_interview_bookings.panelist_hr_ids is
  'Additional panel interviewers beyond the lead (interviewer_hr_id). Each sees the interview on their calendar, My interviews and .ics feed; the lead stays the outcome-setter and Zoom host.';

commit;
