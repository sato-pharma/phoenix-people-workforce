-- Harden the price CTE so a code that exists ONLY in the price history still prices.
--
-- 20260929185741 and 20260929190322 built the CTE from source_of_sales_products alone.
-- public.phx_factory_price does not: it reads the dated override FIRST and falls back to the
-- master price, so a product code present only in source_of_sales_product_price_history would
-- get its override from the function and 0 from the CTE. No such code exists today - every
-- history code has a master row and the only history row is SA001 - so nothing moves now.
-- This closes the case before the next repricing can bring one.
--
-- THE FIRST VERSION OF THIS MIGRATION BROKE au.f_monthly_attribution FOR 2 MINUTES 46 SECONDS
-- ON PRODUCTION (19:12:23 to 19:15:09 UTC). It selected the code with a bare column name
-- inside the union, and product_code is also an OUT parameter of that plpgsql function's
-- RETURNS TABLE, so every call raised 42702 'column reference product_code is ambiguous'.
-- CREATE OR REPLACE succeeded; nothing failed until something called it. The aliases below
-- are the fix, recorded separately in the ledger as 20260929191509.
--
-- public.phx_closing_customers was never affected: LANGUAGE SQL has no plpgsql variable scope
-- and its RETURNS TABLE does not name product_code. It is re-created here so the file matches
-- what is live.
--
-- Values re-verified on production after the fix, all unchanged:
--   attribution  2026-07 10,675,199.09 | 2026-08 17,425,158.03 (937 rows) | 2026-09 579,055.85
--   closing      CNS 4,277,306.58 (10,554 rows) | Pedia 3,651,911.80 | Anti Infective 480,176.15
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
    -- One row per code KNOWN TO EITHER TABLE. phx_factory_price reads the dated override
    -- first and falls back to the master price, so a code present only in the history must
    -- still price rather than fall to zero.
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
      -- ALIASED, DELIBERATELY. A bare product_code here is ambiguous with the OUT parameter of
      -- the same name in a plpgsql RETURNS TABLE, and it fails at CALL time, not CREATE time.
      select upper(btrim(pm.product_code)) as code from public.source_of_sales_products pm
      union
      select upper(btrim(ph.product_code)) as code from public.source_of_sales_product_price_history ph
    ) c
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

create or replace function public.phx_closing_customers(p_line text, p_period text)
 returns table(client_code text, client_name text, distributor_code text, region_code text,
               area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable parallel safe security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with price as (
    -- One row per code KNOWN TO EITHER TABLE. phx_factory_price reads the dated override
    -- first and falls back to the master price, so a code present only in the history must
    -- still price rather than fall to zero.
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
      -- ALIASED, DELIBERATELY. A bare product_code here is ambiguous with the OUT parameter of
      -- the same name in a plpgsql RETURNS TABLE, and it fails at CALL time, not CREATE time.
      select upper(btrim(pm.product_code)) as code from public.source_of_sales_products pm
      union
      select upper(btrim(ph.product_code)) as code from public.source_of_sales_product_price_history ph
    ) c
  ),
  agg as (
    select
      f.client_code,
      f.distributor_code,
      nullif(f.region_code, '') as fact_region,
      nullif(f.area_code, '')   as fact_area,
      nullif(f.brick_id, '')    as fact_brick,
      sum(f.total_qty) as units,
      sum(
        case
          when coalesce(f.is_direct, false) then coalesce(f.direct_value, 0)
          else f.effective_units * coalesce(pp.factory_price, 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join price pp
      on pp.code = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by
      f.client_code, f.distributor_code,
      nullif(f.region_code, ''), nullif(f.area_code, ''), nullif(f.brick_id, '')
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(a.fact_region, cm.region_code) as region_code,
    coalesce(a.fact_area,   cm.area_code)   as area_code,
    coalesce(a.fact_brick,  cm.brick_id)    as brick_id,
    a.units,
    a.value
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$function$;

revoke execute on function public.phx_closing_customers(text, text) from public;
grant execute on function public.phx_closing_customers(text, text) to service_role;

comment on function public.phx_closing_customers(text, text) is
  'Closing detail by customer for one line and period. Resolves the factory price once per '
  'product (30 rows) rather than once per fact row — the per-row form measured 1,374 ms against '
  '140 ms on 2026-08. Price arithmetic is identical to public.phx_factory_price.';
