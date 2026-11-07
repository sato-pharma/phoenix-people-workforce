-- ats_mr_hiring_phone_and_confirmed_line
--
-- WHAT THIS CHANGES:
--   1. ats_interview_bookings.platform also accepts 'phone' — a phone call is a third way to hold an
--      interview (ats_interview_bookings_platform_valid). A phone call has no Zoom meeting, so the
--      existing ats_interview_bookings_office_has_no_meeting check already holds it to 'not_needed'.
--      Interview SESSIONS keep their two values; a session is one meeting for many candidates.
--   2. ats_mr_hiring_step_results gets two nullable columns the HR 1st-interview result fills:
--      confirmed_area_name (the area the candidate is applying to, as HR confirmed it) and
--      confirmed_line ('pedia', 'anti_infective' or 'cns'). Both stay empty on every other step.
--   No row is touched: every value that was allowed stays allowed, and the new columns start empty.
-- WHY: the owner, 7 Nov 2026 — for the HR 1st interview "add a third option which is phone call";
--   and "after in the outcome of the first interview of the HR, make the HR able to confirm the
--   location … the candidate is applying to, and the line". The line decides the RSM interview: it
--   appears only when HR confirms the Pedia line ("by default, it is not appearing").
--   docs/recruitment-mr-hiring-workflow.md.
-- ROLLBACK:
--   alter table public.ats_mr_hiring_step_results drop column if exists confirmed_line, drop column if exists confirmed_area_name;
--   then re-create ats_interview_bookings_platform_valid as check (platform in ('in_office', 'zoom'))
--   — possible only once no booking carries 'phone', since the check would refuse it. Dropping the
--   two columns loses the confirmations recorded in them.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_platform_valid;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_platform_valid
  check (platform in ('in_office', 'zoom', 'phone'));

-- The table is append-only (a trigger refuses UPDATE and DELETE); adding nullable columns rewrites
-- no row and fires no trigger.
alter table public.ats_mr_hiring_step_results
  add column if not exists confirmed_area_name text null,
  add column if not exists confirmed_line text null;

alter table public.ats_mr_hiring_step_results drop constraint if exists ats_mr_hiring_step_results_confirmed_line_known;
alter table public.ats_mr_hiring_step_results
  add constraint ats_mr_hiring_step_results_confirmed_line_known
  check (confirmed_line is null or confirmed_line in ('pedia', 'anti_infective', 'cns'));

alter table public.ats_mr_hiring_step_results drop constraint if exists ats_mr_hiring_step_results_confirmed_area_length;
alter table public.ats_mr_hiring_step_results
  add constraint ats_mr_hiring_step_results_confirmed_area_length
  check (confirmed_area_name is null or char_length(btrim(confirmed_area_name)) between 1 and 120);

alter table public.ats_mr_hiring_step_results drop constraint if exists ats_mr_hiring_step_results_confirmed_only_hr_first;
alter table public.ats_mr_hiring_step_results
  add constraint ats_mr_hiring_step_results_confirmed_only_hr_first
  check (step = 'hr_first' or (confirmed_area_name is null and confirmed_line is null));

comment on column public.ats_mr_hiring_step_results.confirmed_area_name is
  'The area the candidate is applying to, as HR confirmed it at the 1st interview result. Wins over the workspace filing on the Medical Rep Hiring page.';
comment on column public.ats_mr_hiring_step_results.confirmed_line is
  'The line HR confirmed at the 1st interview result: pedia, anti_infective or cns. Pedia adds the RSM interview.';

commit;
