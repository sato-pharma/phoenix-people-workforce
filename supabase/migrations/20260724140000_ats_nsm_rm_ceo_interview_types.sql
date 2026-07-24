-- Recruitment / ATS re-platform, Phase 2 — NSM/RM/CEO candidate tracking.
--
-- Extends ats_interviews.interview_type to add the three new hiring-round types recorded
-- by National Sales Manager, Regional Manager, and CEO (see src/lib/recruitment/access.ts's
-- hiringManagerInterviewType). No new application-stage gating: Talent Acquisition keeps
-- driving the official pipeline to hired/rejected exactly as today; these are additional
-- interview+feedback records that show up as reference, not new workflow stages. (The
-- workflow registry's app_hire action was already widened to allow the offer_initiated
-- waypoint in the Phase 1 migration.)

begin;

alter table public.ats_interviews drop constraint if exists recruitment_interviews_type_check;
alter table public.ats_interviews drop constraint if exists ats_interviews_type_check;
alter table public.ats_interviews
  add constraint ats_interviews_type_check
  check (interview_type = any (array['phone', 'hr', 'hiring_manager', 'cv', 'rm_interview', 'nsm_interview', 'ceo_interview']));

notify pgrst, 'reload schema';

commit;
