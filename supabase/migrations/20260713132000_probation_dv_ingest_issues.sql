-- Probation DV ingest issues (Phase 3, P3-T08 review queue).
--
-- The spec forbids silently discarding invalid/unresolved CRM records. DV-Days that DO resolve to
-- an employee + evaluator but fail validation are persisted as probation_dv_days rows with a
-- non-terminal dv_status (rejected/invalid/duplicate) — already reviewable. But raw CRM rows that
-- can't even form a DV-Day (no employee, no evaluator, or no crm_visit_id) have no natural home in
-- probation_dv_days (employee_hr_id is NOT NULL there). This table captures those so an authorized
-- admin can review them with a reason.
--
-- Additive, idempotent, service-role-only (RLS on, no policies) — same posture as the domain tables.

begin;

create table if not exists public.probation_dv_ingest_issues (
  id uuid primary key default gen_random_uuid(),
  crm_visit_id bigint,
  employee_hr_id text,
  evaluator_hr_id text,
  dv_date date,
  reason text not null,
  raw jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  -- Idempotency: re-syncs must not pile up duplicates. crm_visit_id is often NULL (missing-id case),
  -- and a plain UNIQUE treats NULLs as distinct, so (null, reason) would insert a fresh row on EVERY
  -- sync. NULLS NOT DISTINCT (PG15+) makes NULL crm_visit_id match NULL, and the content columns
  -- (employee_hr_id, evaluator_hr_id, dv_date) then dedup identity-less rows by the underlying record.
  -- For rows WITH a crm_visit_id, that id already makes the tuple distinct — the extra columns are
  -- consistent for the same visit, so real rows still collapse correctly.
  constraint probation_dv_ingest_issues_unique
    unique nulls not distinct (crm_visit_id, reason, employee_hr_id, evaluator_hr_id, dv_date)
);

create index if not exists idx_probation_dv_ingest_issues_unresolved
  on public.probation_dv_ingest_issues (created_at) where resolved_at is null;

alter table public.probation_dv_ingest_issues enable row level security;

notify pgrst, 'reload schema';

commit;
