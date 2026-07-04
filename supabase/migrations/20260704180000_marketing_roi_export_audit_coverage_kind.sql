-- Fix: marketing_roi_export_audit.kind's CHECK constraint only allows ('report', 'request'),
-- but the coverage-report export route has been writing kind = 'coverage_report' since it
-- shipped (app/api/marketing-requests/coverage-report/export/route.ts). writeMarketingRoiExportAudit
-- is deliberately best-effort (wrapped in a bare catch — an audit write must never fail a
-- successful export), so every coverage-report export's audit insert has been silently
-- failing the CHECK constraint. This widens the constraint to the value already in use;
-- no data migration needed since no 'coverage_report' rows exist yet (they all failed).
--
-- APPROVAL-GATED — NOT YET APPLIED: stage to staging, verify, then apply to production with
-- explicit per-migration approval.

alter table public.marketing_roi_export_audit
  drop constraint if exists marketing_roi_export_audit_kind_check;

alter table public.marketing_roi_export_audit
  add constraint marketing_roi_export_audit_kind_check
  check (kind in ('report', 'request', 'coverage_report'));

notify pgrst, 'reload schema';
