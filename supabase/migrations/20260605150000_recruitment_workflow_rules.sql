-- Recruitment / ATS — Workflow Rules 4/5/6 schema changes.
--
-- Rule 4: candidate-level status (free text; default 'Candidate Created').
-- Rule 5/6: four new non-terminal application stages (shortlisted, on_hold,
-- no_response, call_back) and a new 'cv' interview type for CV screening.
-- Additive + idempotent. The active-application partial unique index needs NO
-- change: it excludes only terminal stages, so the four new non-terminal stages
-- are correctly treated as active.

-- Rule 4 — candidate status -------------------------------------------------
alter table public.recruitment_candidates
  add column if not exists status text not null default 'Candidate Created';
create index if not exists recruitment_candidates_status_idx
  on public.recruitment_candidates (status);

-- Rule 5/6 — new application stages -----------------------------------------
alter table public.recruitment_applications
  drop constraint if exists recruitment_applications_stage_check;
alter table public.recruitment_applications
  add constraint recruitment_applications_stage_check
  check (stage in (
    'application_received', 'in_candidate_pool', 'cv_screening', 'phone_screening',
    'interview_scheduling', 'hr_interview', 'hiring_manager_interview', 'final_selection',
    'offer_initiated', 'offer_sent', 'offer_accepted', 'offer_declined', 'offer_expired',
    'pre_boarding', 'hired', 'application_rejected', 'application_withdrawn',
    'shortlisted', 'on_hold', 'no_response', 'call_back'
  ));

-- Rule 5 — new 'cv' interview type ------------------------------------------
alter table public.recruitment_interviews
  drop constraint if exists recruitment_interviews_type_check;
alter table public.recruitment_interviews
  add constraint recruitment_interviews_type_check
  check (interview_type in ('phone', 'hr', 'hiring_manager', 'cv'));

notify pgrst, 'reload schema';
