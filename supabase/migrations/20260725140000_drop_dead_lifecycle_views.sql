-- Cleanup (Cairo/UTC timezone audit follow-up, 2026-07-25): v_lifecycle_dashboard and
-- v_probation_tracker both compute date-derived state (lifecycle_state / days_remaining)
-- against unzoned CURRENT_DATE, which resolves in the DB session's timezone (Supabase
-- default: UTC), not Africa/Cairo — the same bug class fixed elsewhere in the app layer this
-- week. Rather than fix the timezone bug in these two views, drop them: a repo-wide grep
-- confirmed nothing under src/ or app/ queries either view name. The app's lifecycle-risk
-- rollup (src/lib/lifecycle-risk/metrics.ts, already Cairo-aware) and
-- src/lib/admin/command-center.ts / src/lib/overview/service.ts read from
-- employee_probation / platformMetrics.lifecycleRisk directly instead — a docs note claiming
-- src/lib/overview/service.ts still reads v_probation_tracker is stale.

begin;

drop view if exists public.v_lifecycle_dashboard;
drop view if exists public.v_probation_tracker;

notify pgrst, 'reload schema';

commit;
