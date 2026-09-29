-- Resolve the factory price ONCE PER PRODUCT instead of once per fact row — the attribution engine.
--
-- Companion to 20260929185741_closing_customers_price_once_per_product.sql. Same regression, same
-- cause, bigger blast radius: au.f_monthly_attribution is what public.phx_sales_vs_target_range
-- and public.phx_monthly_attribution both read, and those two spent 2,678 and 373 seconds of
-- database time in three days.
--
-- MEASURED ON PRODUCTION, 2026-08 (32,304 fact rows):
--     before   2,105 ms   47,442 shared buffers
--     after      354 ms    3,530 shared buffers
--
-- Two call sites of public.phx_factory_price were per-row here: one in `priced` (once per fact
-- row) and one in `ind_agg` (once per line/area/product key). Both take the same p_period, so a
-- single 30-row `price` CTE serves both.
--
-- 🔴 NO PRICE VALUE CHANGES. The CTE is the body of public.phx_factory_price verbatim — the
-- history override for the period if one exists, else the master price. SA001 stays 111.15
-- through 2026-09 and 170.52 from 2026-10, the owner's locked ruling. phx_factory_price itself
-- is untouched and keeps its other callers.
--
-- SAFE TO JOIN RATHER THAN CALL: upper(btrim(product_code)) is UNIQUE across all 30 rows of
-- source_of_sales_products, and (product_code, effective_period) is unique in the price history,
-- so neither join can fan out. Verified immediately before this was written — a duplicate folded
-- code is exactly how a whole line was doubled once before. The two
-- `left join public.source_of_sales_products pp` this replaces were dead: `pp` was never
-- referenced in either CTE's select list.
--
-- PROVEN IDENTICAL BEFORE APPLYING. The new body was created as au.f_monthly_attribution_v2 and
-- compared against the live definition for three periods; then the live function was replaced and
-- compared against v2 again, to catch a transcription error rather than assume there was none:
--
--     period    rows   value            EXCEPT both directions
--     2026-07    926   10,675,199.09    0 / 0
--     2026-08    937   17,425,158.03    0 / 0
--     2026-09     22      579,055.85    0 / 0
--
-- 2026-07 and 2026-08 are PUBLISHED months, so those two figures are the ones that must not move.
create or replace function au.f_monthly_attribution(p_period text)
 returns table(period text, channel text, line_code text, region_code text, area_code text, area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text, sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text)
 language plpgsql stable parallel safe security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with price as (
    -- One row per product. Identical to public.phx_factory_price(code, p_period), evaluated
    -- 30 times instead of once per fact row.
    select upper(btrim(pr.product_code)) as code,
           coalesce(
             (select h.factory_price from public.source_of_sales_product_price_history h
               where upper(btrim(h.product_code)) = upper(btrim(pr.product_code))
                 and h.effective_period <= p_period
               order by h.effective_period desc limit 1),
             pr.factory_price) as factory_price
    from public.source_of_sales_products pr
  ),
  fact as (
    select f.official_line, f.region_code as sos_region_code,
           nullif(btrim(f.area_code),'') as sos_area_code,
           upper(btrim(coalesce(f.product_code,''))) as product_code,
           f.is_direct, f.total_qty, f.effective_units, f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  ),
  priced as (
    select fa.sos_region_code, fa.product_code, fa.is_direct, fa.total_qty, fa.effective_units,
           fa.direct_value, lm.line_code, cw.canonical_area_code,
           coalesce(pp.factory_price,0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw on cw.sos_area_code = fa.sos_area_code
    left join price pp on pp.code = upper(btrim(fa.product_code))
  ),
  alloc as (
    select a.line_code, a.sos_region_code, a.target_region_code,
           a.weight / sum(a.weight) over (partition by a.line_code, a.sos_region_code) as share
    from au.direct_region_allocation a
  ),
  lam_asof as materialized (
    select l.line_code, l.area_code, l.operational_region_code, l.area_state, l.other_type,
           l.dm_seat_id, l.rep_seat_id,
           au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
           au.f_seat_occupant_asof(l.dm_seat_id, v_period_end) as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  ind_base as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q, sum(pr.effective_units) as eu
    from priced pr
    where not pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  ),
  split as (
    select s.line_code, s.area_code, s.product_code, s.net_qty, s.net_effective_units
    from au.monthly_store_split_net s where s.period = p_period
  ),
  ind_keys as (
    select b.line_code, b.canonical_area_code as area_code, b.product_code from ind_base b
    union
    select s.line_code, s.area_code, s.product_code from split s
  ),
  ind_agg as (
    select k.line_code, k.area_code as canonical_area_code, k.product_code,
           coalesce(b.q,0) + coalesce(s.net_qty,0) as q,
           (coalesce(b.eu,0) + coalesce(s.net_effective_units,0)) * coalesce(pp.factory_price,0) as v
    from ind_keys k
    left join ind_base b on b.line_code=k.line_code and b.canonical_area_code=k.area_code and b.product_code=k.product_code
    left join split s on s.line_code=k.line_code and s.area_code=k.area_code and s.product_code=k.product_code
    left join price pp on pp.code = upper(btrim(k.product_code))
  ),
  dir_agg as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q, sum(pr.direct_value) as v
    from priced pr
    where pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  )
  select p_period, 'indirect'::text, lam.line_code, lam.operational_region_code, lam.area_code,
         lam.area_state, (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
         lam.dm_seat_id, lam.dm_occupant_hr_id, ia.product_code, ia.q, ia.v, true, null::text
  from ind_agg ia
  join lam_asof lam on lam.line_code = ia.line_code and lam.area_code = ia.canonical_area_code
  union all
  select p_period, 'direct'::text, lam.line_code, lam.operational_region_code, lam.area_code,
         lam.area_state, (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
         lam.dm_seat_id, lam.dm_occupant_hr_id, da.product_code, da.q, da.v, true, null::text
  from dir_agg da
  join lam_asof lam on lam.line_code = da.line_code and lam.area_code = da.canonical_area_code
  union all
  select p_period, 'direct'::text, pr.line_code,
         coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')),
         null, null, false, null, null, null, null, pr.product_code,
         sum(pr.total_qty * coalesce(alloc.share, 1)),
         sum(pr.direct_value * coalesce(alloc.share, 1)), true, null::text
  from priced pr
  left join lam_asof lam on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  left join alloc on alloc.line_code = pr.line_code
                 and alloc.sos_region_code = coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')
  where pr.is_direct and pr.line_code is not null
    and (pr.canonical_area_code is null or lam.line_code is null)
  group by pr.line_code,
           coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''),'NATIONAL')),
           pr.product_code
  union all
  select p_period, 'unmapped'::text, pr.line_code, null, pr.canonical_area_code, null, false,
         null, null, null, null, pr.product_code,
         sum(pr.total_qty),
         sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
         false,
         case when pr.line_code is null then 'unmapped_line'
              when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
              when (not pr.is_direct) then 'no_area_map'
              else 'unmapped_other' end
  from priced pr
  left join lam_asof lam on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  where pr.line_code is null
     or ((not pr.is_direct) and (pr.canonical_area_code is null or lam.line_code is null))
  group by pr.line_code, pr.canonical_area_code, pr.is_direct,
           case when pr.line_code is null then 'unmapped_line'
                when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
                when (not pr.is_direct) then 'no_area_map'
                else 'unmapped_other' end,
           pr.product_code;
end;
$function$;
