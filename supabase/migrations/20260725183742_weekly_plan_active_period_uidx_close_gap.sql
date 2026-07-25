-- 20260725183742_weekly_plan_active_period_uidx_close_gap.sql
--
-- employee_plan_headers_active_period_uidx (added in
-- 20260606125715_weekly_monthly_plans_v1.sql, widened in
-- 20260702160000_weekly_plans_edit_request.sql) only protected the
-- pre-approval statuses: submitted, edit_requested, manager_approved,
-- manager_returned, ceo_returned. Once a plan reached final_approved or
-- hr_acknowledged, the index stopped blocking a second, unrelated header for
-- the same employee/plan_kind/period.
--
-- Incident: employee B-122 had a weekly plan for 2026-07-05..2026-07-09
-- reach hr_acknowledged, then wanted to add a note to one visit. The
-- existing "revise" flow (updateEmployeePlan on a closed plan, which chains
-- the new row via parent_plan_id) was not used; instead a brand-new,
-- unrelated header was created for the same period and pushed through the
-- whole approval chain again. Nothing blocked it, producing two independent
-- hr_acknowledged headers for the same week, both rendered on the shared
-- Planning Calendar (loadSubmittedPlanItems has no dedup logic).
--
-- Widen the WHERE clause to cover every status except the true dead ends —
-- cancelled, manager_rejected, ceo_rejected — which never became "the plan
-- of record" for their period, so a fresh submission after one of them is
-- not a duplicate. 'draft' is also kept excluded, preserving the original
-- index's own design: an unsubmitted draft is a private scratchpad, not a
-- claim on the period, and staging has pre-existing stray/abandoned drafts
-- that would otherwise wrongly conflict. Every other status — including
-- final_approved and hr_acknowledged, the actual gap this migration closes —
-- now blocks a second unlinked header. This is paired with an
-- application-level check (assertNoActivePlanForSamePeriod in
-- src/lib/weekly-planning/service.ts) that surfaces a clearer error before
-- ever reaching this constraint; this index is the authoritative guarantee
-- against races and any other insert path.

begin;

drop index if exists public.employee_plan_headers_active_period_uidx;
create unique index employee_plan_headers_active_period_uidx
  on public.employee_plan_headers (employee_hr_id, plan_kind, period_key)
  where status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected');

commit;
