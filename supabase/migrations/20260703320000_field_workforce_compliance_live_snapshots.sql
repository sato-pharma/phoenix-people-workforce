-- Field Workforce Compliance live snapshots: an auto-maintained, per-month cache of the
-- compliance report computed from the ireports360_visits mirror.
--
-- Unlike field_workforce_compliance_imports (Excel-upload archives, HR-initiated snapshots),
-- rows here are written automatically:
-- - by a one-time historical backfill covering every month the mirror has data for, and
-- - by the visits-report sync (cron + manual backfill) after every run, for whichever
--   month(s) that sync's date range touches — so "current" months self-refresh continuously.
--
-- Reporting/evidence only: this table does not mutate attendance, leave, deductions, payroll,
-- or workflow decisions. Recommendations/decisions for a live-mirror month are stored
-- separately in field_workforce_compliance_decisions, keyed by month_key (see the
-- 20260703170000_field_workforce_compliance_decisions_month_key migration) — not here.

create table if not exists public.field_workforce_compliance_live_snapshots (
  id uuid primary key default gen_random_uuid(),
  month_key text not null,
  month integer not null,
  year integer not null,
  preview jsonb not null,
  employee_count integer not null default 0,
  high_severity_count integer not null default 0,
  review_candidate_count integer not null default 0,
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint field_workforce_compliance_live_snapshots_month_key_unique unique (month_key),
  constraint field_workforce_compliance_live_snapshots_month_check check (month between 1 and 12),
  constraint field_workforce_compliance_live_snapshots_year_check check (year between 2000 and 2100)
);

create index if not exists field_workforce_compliance_live_snapshots_computed_at_idx
  on public.field_workforce_compliance_live_snapshots (computed_at desc);

alter table public.field_workforce_compliance_live_snapshots enable row level security;

revoke all on table public.field_workforce_compliance_live_snapshots from anon, authenticated;

grant select, insert, update, delete on table public.field_workforce_compliance_live_snapshots to service_role;

drop policy if exists field_workforce_compliance_live_snapshots_service_role
  on public.field_workforce_compliance_live_snapshots;
create policy field_workforce_compliance_live_snapshots_service_role
  on public.field_workforce_compliance_live_snapshots
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.field_workforce_compliance_live_snapshots is
  'Auto-maintained, per-month Field Workforce Compliance report computed from the ireports360_visits mirror. Recomputed whenever the visits sync touches that month (cron or manual backfill), plus a one-time historical backfill. Read-only cache for the admin UI month picker — reporting only, no payroll/leave mutation.';

comment on column public.field_workforce_compliance_live_snapshots.preview is
  'Full serialized FieldWorkforcePreviewResult for this month, as produced by buildFieldWorkforceCompliancePreviewFromVisitsReport.';
