-- ats_interview_booking_shared_with
--
-- WHAT THIS CHANGES: one NEW column on ats_interview_bookings — shared_with_hr_ids text[] — the
--   people the calendar's owner shared THIS ONE interview with (view only). Each sees the interview on
--   their calendar and can open the CV on it; they cannot book, move, comment or share.
--
-- WHY: the owner, 2026-10-26 — "choose Ali Muhammad Ali and choose Zahra, the PDA Cairo district
--   manager, and share. Only the interviews related to them appear." A national manager's interviews
--   cover several regions; each district manager should see only the ones for their own region, not
--   the whole calendar (a calendar share). An array on the row keeps the read gate a single-row check
--   with no join, exactly like panelist_hr_ids.
--
-- ROLLBACK:
--   alter table public.ats_interview_bookings drop column shared_with_hr_ids;
--   Nothing below deletes or rewrites a row — it only adds a new column with an empty-array default.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This is
-- additive and non-destructive: a new column with a default only. The table's service-role only
-- access is unchanged (RLS was set when the table was created).

begin;

alter table public.ats_interview_bookings
  add column if not exists shared_with_hr_ids text[] not null default '{}';

comment on column public.ats_interview_bookings.shared_with_hr_ids is
  'People the calendar owner shared this one interview with, view only: it shows on their calendar and they can open its CV. They cannot book, move, comment or share.';

commit;
