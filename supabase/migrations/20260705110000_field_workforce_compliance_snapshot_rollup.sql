-- Adds a compact per-employee-per-month rollup to field_workforce_compliance_live_snapshots,
-- so a cross-month trend view can read N months cheaply (a lean projection) instead of
-- parsing N full `preview` JSONB blobs. Additive/nullable — no backfill in the migration
-- itself; existing rows get employee_rollup populated by a one-time backfill script, and all
-- future saves populate it as part of the normal snapshot-save path (see
-- src/lib/field-workforce-compliance/live-snapshots.ts).

alter table public.field_workforce_compliance_live_snapshots
  add column if not exists employee_rollup jsonb;

comment on column public.field_workforce_compliance_live_snapshots.employee_rollup is
  'Compact per-employee array ({hrId, employeeName, compliancePercent, noActivityCandidates, highSeverityCount, matchStatus}) for cross-month trend reads without touching the full preview JSONB. Null on rows saved before this column existed, until the one-time backfill runs.';
