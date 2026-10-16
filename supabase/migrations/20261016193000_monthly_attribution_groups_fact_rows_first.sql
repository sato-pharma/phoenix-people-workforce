-- au.f_monthly_attribution: group the fact rows on their RAW keys first, then clean the keys.
--
-- SPEED ONLY. Every figure it returns is identical, proven on production before it was applied
-- (below). Nothing about who is credited, which area or region a sale lands in, or what it is
-- worth changes.
--
-- WHY THIS IS THE SALES VS TARGET PAGE'S SPEED. au.f_monthly_achievement serves a month from
-- au.monthly_attribution_rollup only while that month's stored fingerprint matches today's
-- configuration. A PUBLISHED month's rollup is frozen (au.f_refresh_monthly_attribution refuses
-- it), so after any later configuration change — an area move, a store-split rebuild — its
-- fingerprint never matches again, and every read of that month recomputes it live through this
-- function. Measured on production 16 Oct 2026: July, August and September 2026 were all three on
-- that live path, at 378 ms a month against 44 ms for a month served from the rollup, and they are
-- exactly the months Sales vs Target, Targets and the Business Review show.
--
-- WHERE THE TIME WENT. Of this function's 338 ms for September, 255 ms was the `priced` step:
-- 31,990 fact rows, each passed through upper(btrim(...)) for the product (three times: the
-- exclusion filter, the folded code, the price join) and lower(btrim(...)) for the line. Those
-- 21,510 surviving rows fall into only 1,079 distinct raw key combinations, and every one of
-- those text functions depends on the raw keys alone.
--
-- THE CHANGE. A new `fact_raw` step sums total_qty, effective_units and direct_value per raw
-- (official_line, region_code, area_code, product_code, is_direct), and `fact` then cleans the
-- keys of ~1,100 groups instead of ~32,000 rows. Every other line of the body is unchanged.
--
-- WHY THE FIGURES CANNOT MOVE.
--   1. All three amounts are `numeric` (scale 6): addition and multiplication are exact, so a sum
--      of group sums equals the sum of the rows, and sum(units_i) x price equals
--      sum(units_i x price) when the price is one value per product — digit for digit, scale
--      included.
--   2. Every key the later steps join or group on is a function of the five raw keys, so each
--      row reaches exactly the same downstream groups as the group it was folded into.
--   3. Every downstream use of these rows is a sum. A count, avg, min or max would see fewer rows;
--      none exists in this body, and tests/monthly-attribution-groups-fact-rows-first.test.ts
--      refuses one.
--   4. A group whose amounts are all null sums to null, which a later sum ignores exactly as it
--      ignored each null row.
--
-- PROVEN ON PRODUCTION (ozucdzovmcqvepbozvqf), 16 Oct 2026, before applying: this body was
-- created as a temporary function and compared with the live au.f_monthly_attribution for all
-- eleven periods 2026-01 to 2026-11, row for row on all sixteen columns, each row compared as text
-- so a numeric scale difference would also count — 0 rows on either side without a twin. Figures
-- in docs/sales-vs-target-speed.md.
--
-- Built on 20260929191509_price_cte_qualify_product_code.sql, the last definition, whose body is
-- live on production with its comments stripped (md5 8eec74035dbb3d35612c9c35afe7cc29 measured
-- 16 Oct 2026). CREATE OR REPLACE keeps the function's grants, so none are restated.
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
    select c.code,
           coalesce(
             (select h.factory_price from public.source_of_sales_product_price_history h
               where upper(btrim(h.product_code)) = c.code
                 and h.effective_period <= p_period
               order by h.effective_period desc limit 1),
             (select pr.factory_price from public.source_of_sales_products pr
               where upper(btrim(pr.product_code)) = c.code limit 1)
           ) as factory_price
    from (
      select upper(btrim(pm.product_code)) as code from public.source_of_sales_products pm
      union
      select upper(btrim(ph.product_code)) as code from public.source_of_sales_product_price_history ph
    ) c
  ),
  fact_raw as (
    -- One row per RAW key combination, summed. The text cleanup below then runs per group, not
    -- per fact row. Every amount is numeric, so these sums are exact.
    select f.official_line, f.region_code, f.area_code, f.product_code, f.is_direct,
           sum(f.total_qty) as total_qty,
           sum(f.effective_units) as effective_units,
           sum(f.direct_value) as direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
    group by f.official_line, f.region_code, f.area_code, f.product_code, f.is_direct
  ),
  fact as (
    select fr.official_line, fr.region_code as sos_region_code,
           nullif(btrim(fr.area_code),'') as sos_area_code,
           upper(btrim(coalesce(fr.product_code,''))) as product_code,
           fr.is_direct, fr.total_qty, fr.effective_units, fr.direct_value
    from fact_raw fr
    where upper(btrim(coalesce(fr.product_code,''))) not in ('LA003','LA004','SS001')
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
