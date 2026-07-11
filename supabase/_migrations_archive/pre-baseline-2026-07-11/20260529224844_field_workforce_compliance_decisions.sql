-- Field Workforce Compliance Phase 3 decisions.
--
-- Scope:
-- - Persist HR decision-support notes/statuses for archive-derived recommendations.
-- - Keep execution out of scope: no payroll mutation, no leave balance mutation,
--   no approval workflow engine, and no notifications.

create table if not exists public.field_workforce_compliance_decisions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.field_workforce_compliance_imports(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  month_key text not null,
  recommendation_key text not null,
  recommendation_type text not null,
  source_type text not null,
  dates jsonb not null default '[]'::jsonb,
  days_count integer not null default 0,
  severity text not null default 'Review',
  recommendation_reason text not null,
  existing_coverage_status text not null default 'not_applicable',
  estimated_amount numeric(14, 2) null,
  decision_status text not null default 'Pending',
  hr_note text not null default '',
  decided_by text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint field_workforce_decisions_employee_code_not_blank check (btrim(employee_code) <> ''),
  constraint field_workforce_decisions_employee_name_not_blank check (btrim(employee_name) <> ''),
  constraint field_workforce_decisions_month_key_not_blank check (btrim(month_key) <> ''),
  constraint field_workforce_decisions_key_not_blank check (btrim(recommendation_key) <> ''),
  constraint field_workforce_decisions_type_check check (recommendation_type in ('leave_reconciliation', 'payroll_deduction')),
  constraint field_workforce_decisions_source_check check (source_type in ('calendar_av', 'n_retroactive_candidate', 'no_activity_candidate')),
  constraint field_workforce_decisions_days_non_negative check (days_count >= 0),
  constraint field_workforce_decisions_severity_check check (severity in ('Low', 'Medium', 'High', 'Review')),
  constraint field_workforce_decisions_coverage_check check (existing_coverage_status in ('already_covered', 'needs_reconciliation', 'leave_source_not_connected', 'payroll_calculation_required', 'not_applicable')),
  constraint field_workforce_decisions_status_check check (decision_status in ('Pending', 'Approved for Leave Adjustment Report', 'Approved for Payroll Deduction Report', 'Do Not Take Action', 'Needs Follow-up', 'Cancelled')),
  constraint field_workforce_decisions_dates_array check (jsonb_typeof(dates) = 'array')
);
create unique index if not exists field_workforce_decisions_import_key_uidx
  on public.field_workforce_compliance_decisions (import_id, recommendation_key);
create index if not exists field_workforce_decisions_import_id_idx
  on public.field_workforce_compliance_decisions (import_id);
create index if not exists field_workforce_decisions_month_key_idx
  on public.field_workforce_compliance_decisions (month_key, employee_code);
create index if not exists field_workforce_decisions_type_status_idx
  on public.field_workforce_compliance_decisions (import_id, recommendation_type, decision_status);
alter table public.field_workforce_compliance_decisions enable row level security;
revoke all on table public.field_workforce_compliance_decisions from anon, authenticated;
grant select, insert, update, delete on table public.field_workforce_compliance_decisions to service_role;
drop policy if exists field_workforce_decisions_service_role_all
  on public.field_workforce_compliance_decisions;
create policy field_workforce_decisions_service_role_all
  on public.field_workforce_compliance_decisions
  for all
  to service_role
  using (true)
  with check (true);
comment on table public.field_workforce_compliance_decisions is
  'HR decision-support statuses for Field Workforce Compliance recommendations. Reporting only; no payroll or leave mutation.';
