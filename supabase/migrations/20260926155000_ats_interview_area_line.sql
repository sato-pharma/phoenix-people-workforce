-- ats_interview_area_line
--
-- WHAT THIS CHANGES: two NEW nullable columns on ats_interview_bookings — interview_area and
--   interview_line — the sales Area and Line an interview is for. Both optional. They show in the
--   calendar and on the public share link next to the interviewer, so from outside one can read the
--   interviewer, the area and the line at a glance.
--
-- WHY: the owner, 2026-09-26. They auto-fill from the chosen interviewer's own org seat (a District
--   Manager's area & line), and stay editable — stored on the booking so they are stable even if the
--   interviewer's seat later changes, and so an interview with no seated interviewer can still carry
--   them. Plain text, holding the canonical area_name / line_name the picker and the seat supply.
--
-- ROLLBACK:
--   alter table public.ats_interview_bookings drop column interview_area, drop column interview_line;
--   Nothing below deletes or rewrites a row — it only adds two nullable columns.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This is
-- additive and non-destructive. The table's service-role-only access is unchanged.

begin;

alter table public.ats_interview_bookings
  add column if not exists interview_area text,
  add column if not exists interview_line text;

comment on column public.ats_interview_bookings.interview_area is
  'The sales Area the interview is for (canonical area_name). Optional; auto-filled from the interviewer''s seat, editable. Shown in the calendar and share link.';
comment on column public.ats_interview_bookings.interview_line is
  'The sales Line the interview is for (canonical line_name). Optional; auto-filled from the interviewer''s seat, editable. Shown in the calendar and share link.';

commit;
