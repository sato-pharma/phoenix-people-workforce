-- Recruitment / ATS — Rules 8 & 9 stages.
-- Adds two non-terminal application stages: manager_interview_completed and
-- backup_candidate. Additive + idempotent.

alter table public.recruitment_applications
  drop constraint if exists recruitment_applications_stage_check;
alter table public.recruitment_applications
  add constraint recruitment_applications_stage_check
  check (stage in (
    'application_received', 'in_candidate_pool', 'cv_screening', 'phone_screening',
    'interview_scheduling', 'hr_interview', 'hiring_manager_interview', 'final_selection',
    'offer_initiated', 'offer_sent', 'offer_accepted', 'offer_declined', 'offer_expired',
    'pre_boarding', 'hired', 'application_rejected', 'application_withdrawn',
    'shortlisted', 'on_hold', 'no_response', 'call_back',
    'manager_interview_completed', 'backup_candidate'
  ));

notify pgrst, 'reload schema';;
