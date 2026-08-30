-- C7 · Retire the legacy deductions-governance database surface (tables + RPCs + trigger fn).
--
-- Background
--   The deductions-governance CODE module was removed in C6 (PR #2733, live in
--   production 2026-08-30, revision 8004a4bec). The unified src/lib/deductions/
--   module — which uses the PLURAL deductions_* tables — is the live source that
--   feeds salary_records. The governance module's SINGULAR deduction_* tables and
--   its functions are now dead. Verified against production 2026-08-30:
--     • no runtime or test DB-access reference to any of the 7 singular tables
--       (the only code mentions are prose comments and negative regression guards
--       that assert these strings are ABSENT from source — they keep passing);
--     • no view/matview depends on them;
--     • no OTHER function references them, and no trigger fires beyond their own;
--     • the two RPCs are EXECUTE-granted to service_role only and their callers
--       (the deductions-governance API routes) were deleted in C6.
--
-- What this does
--   RENAMES the dead objects into an archive schema instead of dropping them, so
--   real governance history is preserved verbatim (deduction_candidates carries
--   206 rows, deduction_decisions 118; the other five are empty). ALTER ... SET
--   SCHEMA moves each table WITH its indexes, constraints, RLS policies, triggers
--   and grants intact, and removes it from the public (PostgREST-exposed) surface.
--   Fully reversible — see the ROLLBACK block at the foot of this file.
--
-- The one inbound FK,
--   private_calendar_no_activity_clarifications.deduction_candidate_id
--     -> deduction_candidates,
--   is intentionally left in place. Postgres FKs bind by table OID and support
--   cross-schema references, and a SET SCHEMA does NOT rewrite the referencing
--   table, so the constraint stays valid and enforced across the move. That
--   Private-Calendar table is itself dead in code but belongs to a different
--   feature area and is out of scope for this governance retirement.

create schema if not exists deductions_governance_backup_20260830;

comment on schema deductions_governance_backup_20260830 is
  'Retired 2026-08-30 (C7): legacy deductions-governance tables, RPCs and trigger '
  'function, superseded by the unified src/lib/deductions module (plural '
  'deductions_* tables). Governance code removed in PR #2733. Reversible via '
  'ALTER ... SET SCHEMA public.';

-- Tables — order is immaterial; the governance-internal FKs follow by OID and stay
-- within the archive schema.
alter table public.deduction_candidates            set schema deductions_governance_backup_20260830;
alter table public.deduction_comments              set schema deductions_governance_backup_20260830;
alter table public.deduction_decisions             set schema deductions_governance_backup_20260830;
alter table public.deduction_exports               set schema deductions_governance_backup_20260830;
alter table public.deduction_monthly_summaries     set schema deductions_governance_backup_20260830;
alter table public.deduction_monthly_summary_lines set schema deductions_governance_backup_20260830;
alter table public.deduction_payroll_import_jobs   set schema deductions_governance_backup_20260830;

-- Trigger function bound ONLY to the governance deduction_decisions table. The live
-- plural deductions_decisions uses a different function (deductions_decisions_touch_updated_at),
-- and deductions_candidates uses deductions_candidates_guard_locked — neither is touched here.
alter function public.phx_touch_deduction_decisions()
  set schema deductions_governance_backup_20260830;

-- Dead RPCs — their callers were removed in C6; EXECUTE was service_role only.
alter function public.phx_finalize_monthly_deductions(
  p_month_key text, p_month integer, p_year integer, p_finalized_by text,
  p_candidate_count integer, p_employee_count integer, p_total_days numeric,
  p_total_amount numeric, p_source_counts jsonb, p_notes text, p_lines jsonb,
  p_decision_ids uuid[]
) set schema deductions_governance_backup_20260830;

alter function public.phx_import_deductions_governance_to_payroll(
  p_summary_id uuid, p_import_job_id uuid, p_actor_login_id text
) set schema deductions_governance_backup_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter table deductions_governance_backup_20260830.deduction_candidates            set schema public;
--   alter table deductions_governance_backup_20260830.deduction_comments              set schema public;
--   alter table deductions_governance_backup_20260830.deduction_decisions             set schema public;
--   alter table deductions_governance_backup_20260830.deduction_exports               set schema public;
--   alter table deductions_governance_backup_20260830.deduction_monthly_summaries     set schema public;
--   alter table deductions_governance_backup_20260830.deduction_monthly_summary_lines set schema public;
--   alter table deductions_governance_backup_20260830.deduction_payroll_import_jobs   set schema public;
--   alter function deductions_governance_backup_20260830.phx_touch_deduction_decisions() set schema public;
--   alter function deductions_governance_backup_20260830.phx_finalize_monthly_deductions(
--     p_month_key text, p_month integer, p_year integer, p_finalized_by text,
--     p_candidate_count integer, p_employee_count integer, p_total_days numeric,
--     p_total_amount numeric, p_source_counts jsonb, p_notes text, p_lines jsonb,
--     p_decision_ids uuid[]) set schema public;
--   alter function deductions_governance_backup_20260830.phx_import_deductions_governance_to_payroll(
--     p_summary_id uuid, p_import_job_id uuid, p_actor_login_id text) set schema public;
-- ─────────────────────────────────────────────────────────────────────────────
