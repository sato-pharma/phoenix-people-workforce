-- Marketing ROI fact-table RLS hardening.
--
-- Purpose:
-- The production audit showed the marketing ROI fact-table family exists in the
-- public schema with RLS disabled. These tables are intended for server-side
-- access only: dashboard/read RPCs and refresh paths use service_role-backed
-- code, while adjacent ROI support tables already follow an explicit deny-all
-- RLS pattern.
--
-- This migration:
-- 1. Enables RLS on the 9 affected marketing ROI tables.
-- 2. Adds explicit deny-all policies to block direct anon/authenticated access.
-- 3. Revokes public / anon / authenticated table grants.
-- 4. Grants required table privileges only to service_role.
--
-- Operational note:
-- Apply to staging first. Validate all service-role-backed ROI routes before any
-- production rollout.

alter table public.marketing_roi_refresh_runs enable row level security;
alter table public.marketing_roi_request_facts enable row level security;
alter table public.marketing_roi_trend_facts enable row level security;
alter table public.marketing_roi_line_facts enable row level security;
alter table public.marketing_roi_product_facts enable row level security;
alter table public.marketing_roi_region_facts enable row level security;
alter table public.marketing_roi_distributor_facts enable row level security;
alter table public.marketing_roi_customer_facts enable row level security;
alter table public.marketing_roi_distributor_rollup enable row level security;

drop policy if exists marketing_roi_refresh_runs_no_direct_access on public.marketing_roi_refresh_runs;
create policy marketing_roi_refresh_runs_no_direct_access
  on public.marketing_roi_refresh_runs for all using (false) with check (false);

drop policy if exists marketing_roi_request_facts_no_direct_access on public.marketing_roi_request_facts;
create policy marketing_roi_request_facts_no_direct_access
  on public.marketing_roi_request_facts for all using (false) with check (false);

drop policy if exists marketing_roi_trend_facts_no_direct_access on public.marketing_roi_trend_facts;
create policy marketing_roi_trend_facts_no_direct_access
  on public.marketing_roi_trend_facts for all using (false) with check (false);

drop policy if exists marketing_roi_line_facts_no_direct_access on public.marketing_roi_line_facts;
create policy marketing_roi_line_facts_no_direct_access
  on public.marketing_roi_line_facts for all using (false) with check (false);

drop policy if exists marketing_roi_product_facts_no_direct_access on public.marketing_roi_product_facts;
create policy marketing_roi_product_facts_no_direct_access
  on public.marketing_roi_product_facts for all using (false) with check (false);

drop policy if exists marketing_roi_region_facts_no_direct_access on public.marketing_roi_region_facts;
create policy marketing_roi_region_facts_no_direct_access
  on public.marketing_roi_region_facts for all using (false) with check (false);

drop policy if exists marketing_roi_distributor_facts_no_direct_access on public.marketing_roi_distributor_facts;
create policy marketing_roi_distributor_facts_no_direct_access
  on public.marketing_roi_distributor_facts for all using (false) with check (false);

drop policy if exists marketing_roi_customer_facts_no_direct_access on public.marketing_roi_customer_facts;
create policy marketing_roi_customer_facts_no_direct_access
  on public.marketing_roi_customer_facts for all using (false) with check (false);

drop policy if exists marketing_roi_distributor_rollup_no_direct_access on public.marketing_roi_distributor_rollup;
create policy marketing_roi_distributor_rollup_no_direct_access
  on public.marketing_roi_distributor_rollup for all using (false) with check (false);

revoke all on table public.marketing_roi_refresh_runs from public, anon, authenticated;
revoke all on table public.marketing_roi_request_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_trend_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_line_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_product_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_region_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_distributor_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_customer_facts from public, anon, authenticated;
revoke all on table public.marketing_roi_distributor_rollup from public, anon, authenticated;

grant all on table public.marketing_roi_refresh_runs to service_role;
grant all on table public.marketing_roi_request_facts to service_role;
grant all on table public.marketing_roi_trend_facts to service_role;
grant all on table public.marketing_roi_line_facts to service_role;
grant all on table public.marketing_roi_product_facts to service_role;
grant all on table public.marketing_roi_region_facts to service_role;
grant all on table public.marketing_roi_distributor_facts to service_role;
grant all on table public.marketing_roi_customer_facts to service_role;
grant all on table public.marketing_roi_distributor_rollup to service_role;

notify pgrst, 'reload schema';
