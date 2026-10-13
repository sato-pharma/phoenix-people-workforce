-- Rep bulk-order dependency analytic.
--
-- Flags every rep whose achievement is at/above 100% but drops BELOW 100% once
-- their single largest "bulk" is removed. A bulk is the larger of:
--   * their biggest single DIRECT order   (one product, valued at its invoiced value), or
--   * their biggest single WHALE customer  (one indirect client, valued unit x factory price).
--
-- This is a READ-ONLY wrapper over public.phx_sales_vs_target_range(from,to). ALL attribution
-- -- Office value-share spread, area re-assignment, the golden rule -- stays inside that RPC and
-- is NOT touched or re-implemented here. Product -> line is taken from the RPC's own output map,
-- so no line label is hard-coded.
--
-- CAVEAT (documented on purpose): removing a whale removes only that customer's own purchases.
-- It does NOT re-simulate the Office value-share reallocation that a big customer pulls into its
-- area, so Office-heavy cases (e.g. the EZ warehouse on CNS) are UNDERSTATED here -- the true
-- dependency is higher than the number shown.
--
-- Output is gated to PUBLISHED (line, period) closings only, matching the live dashboard rule:
-- an unpublished month is intentionally absent, never shown at a misleading value.
--
-- Security mirrors phx_sales_vs_target_range exactly: SECURITY DEFINER, execute to service_role
-- only (anon/authenticated have no access).

create or replace function public.phx_rep_bulk_dependency(
  p_from text default null,
  p_to   text default null
)
returns table (
  period                   text,
  rep_hr_id                text,
  rep_name                 text,
  line_code                text,
  region_code              text,
  area_code                text,
  area_name                text,
  actual_value             numeric,
  covered_actual           numeric,
  target_value             numeric,
  achievement_pct          numeric,
  bulk_type                text,     -- 'direct_order' | 'whale_customer'
  bulk_ref                 text,     -- product_code (direct) | customer_code (whale)
  bulk_name                text,     -- product name  (direct) | customer name (whale)
  bulk_value               numeric,
  bulk_share_pct           numeric,  -- bulk_value as a % of the rep's total actual
  achievement_without_pct  numeric,  -- achievement with the single bulk removed
  flips                    boolean   -- true when >=100% falls to <100% without the bulk
)
language sql
stable
security definer
set search_path = public, au
as $$
  with params as (
    -- default range = the full published window (currently only 2026-07)
    select coalesce(p_from, (select min(mcp.period) from public.monthly_closing_publications mcp)) as p_from,
           coalesce(p_to,   (select max(mcp.period) from public.monthly_closing_publications mcp)) as p_to
  ),
  pub as (
    -- published (line_code, period) gate: normalized_line 'anti infective' -> 'anti_infective'
    select distinct replace(mcp.normalized_line, ' ', '_') as line_code, mcp.period
    from public.monthly_closing_publications mcp
  ),
  phx as (
    select r.*
    from params pm, lateral public.phx_sales_vs_target_range(pm.p_from, pm.p_to) r
  ),
  prod_line as (
    -- product -> line_code, straight from the RPC's own attribution (Head Office = null line, dropped)
    select distinct product_code, line_code
    from phx
    where line_code is not null and product_code is not null
  ),
  prod_direct as (
    select fr.period, fr.product_code,
           sum(fr.direct_value)    as direct_value,
           sum(fr.effective_units) as direct_units
    from public.source_of_sales_fact_rollup fr, params pm
    where fr.period between pm.p_from and pm.p_to
      and fr.is_direct
    group by fr.period, fr.product_code
  ),
  prod_actual as (
    select period, product_code,
           sum(actual_value) as actual_value,
           sum(actual_units) as actual_units
    from phx
    where product_code is not null
    group by period, product_code
  ),
  price as (
    -- factory price per product = (total actual - direct portion) / (total units - direct units)
    select pa.period, pa.product_code,
           case when (pa.actual_units - coalesce(pd.direct_units, 0)) > 0
                then (pa.actual_value - coalesce(pd.direct_value, 0))
                   / (pa.actual_units - coalesce(pd.direct_units, 0))
                else 0 end as unit_price
    from prod_actual pa
    left join prod_direct pd
      on pd.period = pa.period and pd.product_code = pa.product_code
  ),
  rep_tot as (
    -- rep <-> (line, area) is 1:1; covered_actual counts only cells that carry a target
    select period, rep_hr_id, line_code, region_code, area_code,
           sum(actual_value)                           as actual_value,
           sum(actual_value) filter (where has_target) as covered_actual,
           sum(target_value)                           as target_value
    from phx
    where rep_hr_id is not null and line_code is not null
    group by period, rep_hr_id, line_code, region_code, area_code
  ),
  direct_cand as (
    select fr.period, pl.line_code, fr.area_code, fr.product_code,
           max(fr.product_name) as product_name,
           sum(fr.direct_value) as bulk_value
    from public.source_of_sales_fact_rollup fr
    join prod_line pl on pl.product_code = fr.product_code
    cross join params pm
    where fr.period between pm.p_from and pm.p_to
      and fr.is_direct
    group by fr.period, pl.line_code, fr.area_code, fr.product_code
  ),
  direct_final as (
    select distinct on (period, line_code, area_code)
           period, line_code, area_code,
           'direct_order'::text as bulk_type,
           product_code as bulk_ref, product_name as bulk_name, bulk_value
    from direct_cand
    order by period, line_code, area_code, bulk_value desc
  ),
  whale_cand as (
    select fr.period, pl.line_code, fr.area_code, fr.client_code,
           sum(fr.effective_units * pr.unit_price) as bulk_value
    from public.source_of_sales_fact_rollup fr
    join prod_line pl on pl.product_code = fr.product_code
    join price pr on pr.period = fr.period and pr.product_code = fr.product_code
    cross join params pm
    where fr.period between pm.p_from and pm.p_to
      and not fr.is_direct
      and fr.client_code is not null
    group by fr.period, pl.line_code, fr.area_code, fr.client_code
  ),
  whale_final as (
    select distinct on (period, line_code, area_code)
           period, line_code, area_code,
           'whale_customer'::text as bulk_type,
           client_code as bulk_ref, null::text as bulk_name, bulk_value
    from whale_cand
    order by period, line_code, area_code, bulk_value desc
  ),
  biggest_bulk as (
    -- per (period, line, area): keep the larger of the direct vs whale bulk
    select coalesce(d.period, w.period)       as period,
           coalesce(d.line_code, w.line_code) as line_code,
           coalesce(d.area_code, w.area_code) as area_code,
           case when coalesce(d.bulk_value, 0) >= coalesce(w.bulk_value, 0)
                then d.bulk_type else w.bulk_type end as bulk_type,
           case when coalesce(d.bulk_value, 0) >= coalesce(w.bulk_value, 0)
                then d.bulk_ref  else w.bulk_ref  end as bulk_ref,
           case when coalesce(d.bulk_value, 0) >= coalesce(w.bulk_value, 0)
                then d.bulk_name else w.bulk_name end as bulk_name,
           greatest(coalesce(d.bulk_value, 0), coalesce(w.bulk_value, 0)) as bulk_value
    from direct_final d
    full join whale_final w
      on w.period = d.period and w.line_code = d.line_code and w.area_code = d.area_code
  )
  select
    t.period,
    t.rep_hr_id,
    e.full_name as rep_name,
    t.line_code,
    t.region_code,
    t.area_code,
    ca.area_name,
    round(t.actual_value, 2)   as actual_value,
    round(t.covered_actual, 2) as covered_actual,
    round(t.target_value, 2)   as target_value,
    round(100 * t.covered_actual / nullif(t.target_value, 0), 1) as achievement_pct,
    b.bulk_type,
    b.bulk_ref,
    coalesce(b.bulk_name, cm.customer_name) as bulk_name,
    round(b.bulk_value, 2) as bulk_value,
    round(100 * b.bulk_value / nullif(t.actual_value, 0), 1) as bulk_share_pct,
    round(100 * (t.covered_actual - coalesce(b.bulk_value, 0)) / nullif(t.target_value, 0), 1)
      as achievement_without_pct,
    (t.covered_actual / nullif(t.target_value, 0) >= 1
      and (t.covered_actual - coalesce(b.bulk_value, 0)) / nullif(t.target_value, 0) < 1) as flips
  from rep_tot t
  join pub
    on pub.line_code = t.line_code and pub.period = t.period
  left join biggest_bulk b
    on b.period = t.period and b.line_code = t.line_code and b.area_code = t.area_code
  left join public.employees e
    on e.hr_id = t.rep_hr_id
  left join au.canonical_areas ca
    on ca.area_code = t.area_code
  left join lateral (
    -- one row per customer_code, even if the map holds several distributor rows for it
    select m.customer_name
    from public.source_of_sales_customer_map m
    where b.bulk_type = 'whale_customer' and m.customer_code = b.bulk_ref
    order by m.confidence desc nulls last
    limit 1
  ) cm on true
  order by achievement_pct desc nulls last;
$$;

revoke execute on function public.phx_rep_bulk_dependency(text, text) from public, anon, authenticated;
grant execute on function public.phx_rep_bulk_dependency(text, text) to service_role;

-- Parameterless convenience view: the concentration board for the current published window.
create or replace view public.phx_v_rep_bulk_dependency as
  select * from public.phx_rep_bulk_dependency();

revoke all on public.phx_v_rep_bulk_dependency from public, anon, authenticated;
grant select on public.phx_v_rep_bulk_dependency to service_role;

comment on function public.phx_rep_bulk_dependency(text, text) is
  'Per-rep bulk-order dependency: achievement with vs without each rep''s single largest direct '
  'order or whale customer. Read-only wrapper over phx_sales_vs_target_range; does NOT re-simulate '
  'the Office value-share spread (Office-heavy cases are understated). Gated to published closings.';
