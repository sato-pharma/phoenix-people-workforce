-- Field Workforce Compliance Phase 4 governance enhancements.
--
-- Scope:
-- - Add reporting-only decision reason/dispute metadata.
-- - Snapshot employee hierarchy attributes for archived monthly summaries.
-- - Keep execution out of scope: no payroll mutation and no leave balance mutation.
--
-- Constraint caution:
-- Decision reason requirements are enforced server-side so existing Phase 3 rows
-- cannot be broken by a strict database check during deployment.

alter table public.field_workforce_compliance_decisions
  add column if not exists decision_reason text not null default '',
  add column if not exists resolved_at timestamptz null,
  add column if not exists resolved_by text null;

alter table public.field_workforce_compliance_decisions
  drop constraint if exists field_workforce_decisions_status_check;

alter table public.field_workforce_compliance_decisions
  add constraint field_workforce_decisions_status_check
  check (
    decision_status in (
      'Pending',
      'Approved for Leave Adjustment Report',
      'Approved for Payroll Deduction Report',
      'Do Not Take Action',
      'Needs Follow-up',
      'Disputed',
      'Resolved',
      'Cancelled'
    )
  ) not valid;

alter table public.field_workforce_compliance_decisions
  drop constraint if exists field_workforce_decisions_source_check;

alter table public.field_workforce_compliance_decisions
  add constraint field_workforce_decisions_source_check
  check (
    source_type in (
      'approved_leave_request',
      'calendar_av',
      'n_retroactive_candidate',
      'no_activity_candidate'
    )
  ) not valid;

alter table public.field_workforce_compliance_monthly_summary
  add column if not exists manager_name text null,
  add column if not exists line_name text null,
  add column if not exists area_name text null,
  add column if not exists team_name text null,
  add column if not exists role_name text null,
  add column if not exists employment_status text null,
  add column if not exists no_activity_pattern jsonb not null default '{}'::jsonb;

create index if not exists field_workforce_summary_hierarchy_idx
  on public.field_workforce_compliance_monthly_summary (import_id, line_name, area_name, manager_name);

comment on column public.field_workforce_compliance_decisions.decision_reason is
  'Controlled HR reason for a Field Workforce Compliance report decision. Required by server validation for non-Pending decisions.';

comment on column public.field_workforce_compliance_decisions.resolved_at is
  'Report-only timestamp for Resolved status. Does not execute payroll or leave changes.';

comment on column public.field_workforce_compliance_monthly_summary.no_activity_pattern is
  'Deterministic no-activity pattern signals for HR review prioritization only.';
