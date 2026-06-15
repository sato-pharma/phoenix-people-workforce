-- ============================================================================
-- Add covering indexes for unindexed foreign keys
-- ----------------------------------------------------------------------------
-- Finding (Medium/Low, performance advisor unindexed_foreign_keys): 17 foreign
-- keys have no covering index. Low urgency at current row counts, but unindexed
-- FKs make the referenced-side DELETE/UPDATE scan the child table and slow down
-- JOINs on the FK column — cheap to fix now, before these tables grow.
--
-- All column names verified against pg_constraint on production
-- (ref ozucdzovmcqvepbozvqf). Plain CREATE INDEX (not CONCURRENTLY) because
-- apply_migration runs inside a transaction and every target table is currently
-- low-volume; IF NOT EXISTS keeps it idempotent / replay-safe. Purely additive.
-- ============================================================================

create index if not exists deduction_monthly_summary_lines_candidate_id_idx
  on public.deduction_monthly_summary_lines (candidate_id);
create index if not exists deduction_monthly_summary_lines_decision_id_idx
  on public.deduction_monthly_summary_lines (decision_id);
create index if not exists deduction_payroll_import_jobs_batch_id_idx
  on public.deduction_payroll_import_jobs (batch_id);
create index if not exists employee_contracts_hr_id_idx
  on public.employee_contracts (hr_id);
create index if not exists employee_plan_headers_parent_plan_id_idx
  on public.employee_plan_headers (parent_plan_id);
create index if not exists outstation_expense_requests_workload_source_import_id_idx
  on public.outstation_expense_requests (workload_source_import_id);
create index if not exists recruitment_applications_converted_employee_hr_id_idx
  on public.recruitment_applications (converted_employee_hr_id);
create index if not exists recruitment_applications_current_owner_hr_id_idx
  on public.recruitment_applications (current_owner_hr_id);
create index if not exists recruitment_interviews_interviewer_hr_id_idx
  on public.recruitment_interviews (interviewer_hr_id);
create index if not exists recruitment_offer_letters_application_id_idx
  on public.recruitment_offer_letters (application_id);
create index if not exists recruitment_onboarding_items_file_id_idx
  on public.recruitment_onboarding_items (file_id);
create index if not exists recruitment_requisitions_recruitment_owner_hr_id_idx
  on public.recruitment_requisitions (recruitment_owner_hr_id);
create index if not exists sales_targets_batch_id_idx
  on public.sales_targets (batch_id);
create index if not exists workflow_drafts_base_version_id_idx
  on public.workflow_drafts (base_version_id);
create index if not exists workflow_publish_history_from_version_id_idx
  on public.workflow_publish_history (from_version_id);
create index if not exists workflow_publish_history_to_version_id_idx
  on public.workflow_publish_history (to_version_id);
create index if not exists workflow_versions_superseded_by_version_id_idx
  on public.workflow_versions (superseded_by_version_id);
