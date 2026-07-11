-- Report It — drop the submitter foreign key
--
-- report_it_reports.submitted_by_hr_id is DENORMALISED attribution data (the
-- table also stores submitted_by_name / submitted_by_role). The original FK
-- did a raw, case-sensitive exact match against employees(hr_id), which broke
-- submissions whenever the session hr_id differed in case/format from the
-- stored employee row (e.g. "ADMIN-HR" vs "admin-HR") or the authenticated
-- principal had no employees row at all (synthetic admin/system accounts).
--
-- report_it_audit_logs.actor_hr_id is already plain text with no FK for the
-- same reason. Drop the constraint; keep the column. RLS-respecting reads and
-- the per-user self-filter in the service layer are unaffected (they compare
-- the stored hr_id string directly, not via the FK).
--
-- Applied to production 2026-06-10 via MCP (version 20260610123725).

begin;

alter table if exists public.report_it_reports
  drop constraint if exists report_it_reports_submitted_by_hr_id_fkey;

notify pgrst, 'reload schema';

commit;
