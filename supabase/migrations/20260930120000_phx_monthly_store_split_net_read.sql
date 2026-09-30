-- Expose au.monthly_store_split_net to the application through a public wrapper.
--
-- WHY. Every achievement surface (the MR keycard, the DM/NSM/RM boards, Employee 360, the
-- incentive tab) reads sales through au.f_monthly_attribution / phx_sales_vs_target_range, whose
-- indirect sales = base fact rows + au.monthly_store_split_net (the wholesaler city split,
-- MATERIALIZED at import). The Monthly Closing tab instead recomputes the SAME split LIVE
-- (loadClosingStoreSplit), so the two disagree the moment a split input (customer map, geography
-- re-stamp) changes without a re-import — measured on 2026-08 Anti Infective / Menoufia 2 (D13):
-- the live split credits Saginko (SA001) with 145 net units but the materialized table holds 135,
-- so the keycard read 84% where the published closing read 85.5%.
--
-- The read path aligns attribution's indirect sales to the LIVE closing split by applying the
-- (live - materialized) delta at loadAchievementRange (src/lib/sales/closing-net-alignment.ts).
-- To compute that delta it must read the materialized net — but PostgREST exposes only public /
-- graphql_public / analytics, so `.schema("au").from("monthly_store_split_net")` answers PGRST106.
-- This wrapper is the sanctioned way the app already reads every other au object.
--
-- ADDITIVE AND READ-ONLY. It creates no data, changes no row, and touches no other object. The
-- behaviour change lives entirely in the application code that consumes it.

create or replace function public.phx_monthly_store_split_net(p_period text)
returns table (
  line_code text,
  area_code text,
  product_code text,
  net_qty numeric,
  net_effective_units numeric
)
language sql
stable
security definer
set search_path to 'au', 'public'
as $function$
  select s.line_code, s.area_code, s.product_code, s.net_qty, s.net_effective_units
  from au.monthly_store_split_net s
  where s.period = p_period;
$function$;

-- Service role only, matching every sibling sales RPC (phx_sales_vs_target_range,
-- phx_write_monthly_store_split_net). The app reads it through getSupabaseAdmin; anon and
-- authenticated must never reach per-area sales movement.
revoke execute on function public.phx_monthly_store_split_net(text) from public;
grant execute on function public.phx_monthly_store_split_net(text) to service_role;

-- Reload PostgREST's schema cache so the app can call the new function immediately (matches the
-- sibling attribution migrations). The read path falls back to the live split until this lands, so a
-- delayed reload degrades the fix rather than breaking safety.
notify pgrst, 'reload schema';
