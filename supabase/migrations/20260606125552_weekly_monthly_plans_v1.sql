-- Compatibility migration for the PR #27 Supabase preview branch.
--
-- The planning schema was applied manually to the preview branch before the
-- production-recorded migration version was aligned. Keep this no-op file so
-- Supabase can reconcile the branch's existing migration history. The actual
-- additive planning schema is stored in 20260606125715_weekly_monthly_plans_v1.sql.

begin;

select 1;

commit;
