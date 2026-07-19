-- Production Supabase Advisor Center follow-up pass (2026-07-19).
--
-- Scope: only the findings confirmed as genuine gaps after triaging the full live
-- advisor output (75 security + 428 performance findings). Everything else — the
-- 58 RLS-enabled-no-policy tables (deny-all by design, confirmed no RLS-client read
-- path exists for any of them), the 14 known current_access_*/current_phoenix_role
-- SECURITY DEFINER helpers (they back live RLS policies), the 398 unused-index
-- findings, au.line_area_map's missing primary key, the 10 _au_rollback.* snapshot
-- tables (untracked safety net for the area-unification cutover pending owner
-- sign-off), and the 2 Auth-service dashboard-only settings — is intentionally left
-- untouched. See conversation summary for the full per-item rationale.

begin;

-- 1) public.phx_direct_sales_reconciliation still carries a direct EXECUTE grant to
--    `authenticated` from the public-schema default ACL that predates
--    20260719170000_phx_harden_public_function_default_execute.sql (that migration
--    only changed the default for FUTURE functions; this one was created 30 minutes
--    earlier the same day and was never swept). Confirmed proacl before this fix:
--    {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} — no
--    anon entry, so only the authenticated revoke is needed. Confirmed server-only
--    caller: src/lib/direct-orders/service.ts via getSupabaseAdmin().
revoke execute on function public.phx_direct_sales_reconciliation(text, text) from authenticated;

-- 2) au.enforce_lam_region (line_area_map's region-consistency trigger) predates the
--    au schema's search_path pinning pass and is the only remaining function flagged
--    by function_search_path_mutable. All table references inside are already
--    schema-qualified (au.seats), so this is a pure hardening no-op. Matches the
--    live convention already used by every other au.* function (search_path=au, public).
alter function au.enforce_lam_region() set search_path = 'au', 'public';

-- 3) Covering indexes for the 18 unindexed-foreign-key findings — all on tables
--    created since the 2026-05-31 FK-index sweep (au.* schema, direct_order_requests,
--    payroll_copilot_*, probation_development_actions). Same zero-risk pattern as the
--    three prior FK-index migrations in this project's history.
create index if not exists idx_canonical_areas_code_region_code on au.canonical_areas (code_region_code);
create index if not exists idx_sos_official_line_map_line_code on au.sos_official_line_map (line_code);
create index if not exists idx_sos_area_crosswalk_canonical_area_code on au.sos_area_crosswalk (canonical_area_code);
create index if not exists idx_seats_line_code on au.seats (line_code);
create index if not exists idx_seats_area_code on au.seats (area_code);
create index if not exists idx_seats_region_code on au.seats (region_code);
create index if not exists idx_line_area_map_area_code on au.line_area_map (area_code);
create index if not exists idx_line_area_map_operational_region_code on au.line_area_map (operational_region_code);
create index if not exists idx_occupancy_history_prev_occupancy_id on au.occupancy_history (prev_occupancy_id);
create index if not exists idx_monthly_targets_line_code on au.monthly_targets (line_code);
create index if not exists idx_monthly_targets_area_code on au.monthly_targets (area_code);
create index if not exists idx_direct_order_requests_reversal_of_request_id on public.direct_order_requests (reversal_of_request_id);
create index if not exists idx_direct_order_requests_reversed_by_request_id on public.direct_order_requests (reversed_by_request_id);
create index if not exists idx_payroll_copilot_runs_salary_batch_id on public.payroll_copilot_runs (salary_batch_id);
create index if not exists idx_payroll_copilot_adjustments_recurring_id on public.payroll_copilot_adjustments (recurring_id);
create index if not exists idx_payroll_copilot_expense_decisions_superseded_by on public.payroll_copilot_expense_decisions (superseded_by_decision_id);
create index if not exists idx_payroll_copilot_vacation_settl_superseded_by on public.payroll_copilot_vacation_settlements (superseded_by_settlement_id);
create index if not exists idx_probation_development_actions_dv_day_id on public.probation_development_actions (dv_day_id);

notify pgrst, 'reload schema';

commit;
