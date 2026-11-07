-- ats_mr_hiring_rsm_round
--
-- WHAT THIS CHANGES: adds 'rsm' — the Regional Sales Manager's interview — to the two lists of
--   allowed values the Medical Rep workflow keeps: the interview round on ats_interview_bookings
--   (ats_interview_bookings_round_known) and the step a result is recorded at on
--   ats_mr_hiring_step_results (ats_mr_hiring_step_results_step_known). Nothing else changes, and
--   no row is touched: every value that was allowed stays allowed.
-- WHY: the owner's added section of the 8 November 2026 workflow (7 Nov 2026): "Regional Sales
--   Manager (RSM) Interview – If Applicable. Candidates who pass the DSM interview will proceed to an
--   RSM interview (Pedia Line). The RSM will receive the interview details through Phoenix and must
--   submit their evaluation in the system." docs/recruitment-mr-hiring-workflow.md.
-- ROLLBACK: re-create both constraints with their earlier lists (20261107123708_ats_mr_hiring_workflow.sql)
--   — possible only once no row carries 'rsm', since the check would refuse it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_round_known;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_round_known
  check (interview_round is null or interview_round in ('hr_first', 'dsm', 'rsm', 'hr_manager', 'nsm_final', 'joint_final'));

alter table public.ats_mr_hiring_step_results drop constraint if exists ats_mr_hiring_step_results_step_known;
alter table public.ats_mr_hiring_step_results
  add constraint ats_mr_hiring_step_results_step_known
  check (step in ('hr_screening', 'hr_first', 'dsm', 'rsm', 'hr_manager', 'nsm_final', 'joint_final', 'final_decision'));

commit;
