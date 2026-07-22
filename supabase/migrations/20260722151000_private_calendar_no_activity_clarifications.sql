-- Private Calendar — "No Activity Recorded" day clarifications.
--
-- On any day the Private Calendar shows as "No Activity Recorded" (see
-- src/lib/private-calendar/logic.ts derivePrivateCalendarExceptions), the
-- employee can clarify what actually happened — a note plus where a Super
-- Admin can verify it, or an explicit confirmation that no work happened that
-- day. Every no-activity day (across the whole company, not just field-force
-- titles) is later reviewed in a dedicated Super Admin report and decided
-- per-day: deducted or not. A day the employee never clarified defaults to
-- the "should be deducted" recommendation in that report, but deduction is
-- NEVER automatic — a Super Admin must explicitly act, individually or in
-- bulk, before anything reaches payroll.
--
-- A deduction decision here writes into the SAME deduction_candidates /
-- deduction_decisions tables the rest of the Deductions Governance Center
-- uses (source_module = 'MANUAL_HR', deduction_type = 'no_activity') so
-- there is exactly one payroll ledger, never a parallel one. See
-- src/lib/deductions-governance/calculations.ts (payrollColumnForDeduction)
-- and src/lib/payroll/copilot/deductions-review.ts (buildApprovedDeductionTotals)
-- for the MANUAL_HR wiring into the existing pipeline.
--
-- Tables (all RLS-enabled with NO policies -> service-role-only; the browser
-- never reads these directly, the server uses getSupabaseAdmin()):

begin;

create table if not exists public.private_calendar_no_activity_clarifications (
    id uuid primary key default gen_random_uuid(),
    employee_hr_id text not null,
    employee_name text,
    activity_date date not null,
    -- Null/empty clarification_text with confirmed_no_activity = true means the
    -- employee explicitly admitted nothing happened. Null clarification_text
    -- with confirmed_no_activity = false means the employee has not responded
    -- at all yet (distinct from an explicit admission).
    clarification_text text,
    source_pointer_text text,
    confirmed_no_activity boolean not null default false,
    submitted_at timestamptz,
    status text not null default 'pending_review',
    resolution text,
    deduction_candidate_id uuid references public.deduction_candidates(id),
    admin_hr_id text,
    admin_note text,
    decided_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint private_calendar_no_activity_status_check
        check (status in ('pending_review', 'resolved')),
    constraint private_calendar_no_activity_resolution_check
        check (resolution is null or resolution in ('deducted', 'not_deducted')),
    constraint private_calendar_no_activity_resolved_fields_check
        check (
            (status = 'pending_review' and resolution is null and admin_hr_id is null and decided_at is null)
            or (status = 'resolved' and resolution is not null and admin_hr_id is not null and decided_at is not null)
        )
);

comment on table public.private_calendar_no_activity_clarifications is
    'Employee clarifications for Private Calendar "No Activity Recorded" days, and the Super Admin deduct/not-deduct decision. One row per employee/day; the admin decision writes a MANUAL_HR deduction_candidates + deduction_decisions row so payroll reads a single ledger.';

-- One clarification/decision row per employee per day.
create unique index if not exists private_calendar_no_activity_clarifications_day_uidx
    on public.private_calendar_no_activity_clarifications (employee_hr_id, activity_date);

create index if not exists private_calendar_no_activity_clarifications_status_idx
    on public.private_calendar_no_activity_clarifications (status)
    where status = 'pending_review';

alter table public.private_calendar_no_activity_clarifications enable row level security;

notify pgrst, 'reload schema';

commit;
