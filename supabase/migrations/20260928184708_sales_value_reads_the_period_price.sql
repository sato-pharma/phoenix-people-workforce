-- sales_value_reads_the_period_price
--
-- WHAT THIS CHANGES:
--   Repoints every function that turns units into EGP at
--   `public.phx_factory_price(product_code, period)` — the resolver added in
--   20260928184100_period_scoped_factory_prices.sql — instead of reading
--   `source_of_sales_products.factory_price` straight off the product master.
--
--   31 functions: the monthly closing and its detail surfaces, the attribution/achievement engine,
--   the sales dashboards, the executive surfaces, the customer and territory surfaces, market
--   awareness, and the marketing-ROI readers. Each one is byte-identical to what is on production
--   today apart from the price expression, and only where that expression VALUES a row.
--
--   Every edit was made by exact string replacement with an expected occurrence count, and the
--   rewrite aborts rather than write a file if any pattern misses — a silently skipped edit would
--   leave one surface valuing October at the old price, which is the single failure mode nobody
--   would notice from the outside.
--
--   Deliberately NOT repointed, and each for its own reason:
--     * `import_marketing_request_atomic` and `phx_marketing_roi_fast` read a `factory_price_snapshot`
--       column that was stamped when the request was made. A snapshot is already period-correct.
--     * `phx_market_awareness_products` returns the price as a DISPLAY column so a product manager
--       can sanity-check an expected uplift. The current price is the right thing to show there.
--     * `phx_record_factory_price_restatement` is the audit trigger on a price EDIT. It answers
--       "which settled month did this edit restate", which is about the master price, not a period.
--
--   The now-redundant `left join public.source_of_sales_products` in several of these is left in
--   place: the join is on a primary key so it cannot duplicate a row, and most of the functions
--   still read `product_name` or `line` through it. Removing it would widen the diff for nothing.
--
-- WHY:
--   Owner instruction, 2026-09-28, on repricing Saginko: "the sales and target of the retail to be
--   adjusted from 1 October". Without this the resolver exists and nothing consults it.
--
--   With it, a product carrying no override row is valued exactly as before — the resolver falls
--   back to the master price for every period — so this file moves no number on its own. The only
--   number it moves is the one the seed row asks it to: Saginko, from 2026-10.
--
-- ROLLBACK:
--   Re-apply the previous definitions, which are the ones on production before this file. The
--   cheaper and safer undo is to delete the override row instead:
--     delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   That restores the old valuation everywhere without touching a single function.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive: no table, column or row is dropped or rewritten.

begin;

CREATE OR REPLACE FUNCTION au.f_monthly_attribution(p_period text)
 RETURNS TABLE(period text, channel text, line_code text, region_code text, area_code text, area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text, sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with fact as (
    select f.official_line,
           f.region_code as sos_region_code,
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
           coalesce(public.phx_factory_price(fa.product_code, p_period),0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code)) = fa.product_code
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
           sum(pr.total_qty) as q,
           sum(pr.effective_units) as eu
    from priced pr
    where not pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  ),
  split as (
    select s.line_code, s.area_code, s.product_code, s.net_qty, s.net_effective_units
    from au.monthly_store_split_net s
    where s.period = p_period
  ),
  ind_keys as (
    select b.line_code, b.canonical_area_code as area_code, b.product_code from ind_base b
    union
    select s.line_code, s.area_code, s.product_code from split s
  ),
  ind_agg as (
    select k.line_code,
           k.area_code as canonical_area_code,
           k.product_code,
           coalesce(b.q, 0) + coalesce(s.net_qty, 0) as q,
           (coalesce(b.eu, 0) + coalesce(s.net_effective_units, 0)) * coalesce(public.phx_factory_price(k.product_code, p_period), 0) as v
    from ind_keys k
    left join ind_base b
      on b.line_code = k.line_code and b.canonical_area_code = k.area_code and b.product_code = k.product_code
    left join split s
      on s.line_code = k.line_code and s.area_code = k.area_code and s.product_code = k.product_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = k.product_code
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

CREATE OR REPLACE FUNCTION au.f_monthly_attribution_pre_split(p_period text)
 RETURNS TABLE(period text, channel text, line_code text, region_code text, area_code text, area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text, sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with fact as (
    select f.official_line, f.region_code as sos_region_code,
      nullif(btrim(f.area_code),'') as sos_area_code,
      upper(btrim(coalesce(f.product_code,''))) as product_code,
      f.is_direct, f.total_qty, f.effective_units, f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id=f.batch_id and b.status='validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  ),
  priced as (
    select fa.sos_region_code, fa.product_code, fa.is_direct,
           fa.total_qty, fa.effective_units, fa.direct_value,
           lm.line_code, cw.canonical_area_code,
           coalesce(public.phx_factory_price(fa.product_code, p_period),0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line))=lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw on cw.sos_area_code=fa.sos_area_code
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code))=fa.product_code
  ),
  alloc as (
    select a.line_code, a.sos_region_code, a.target_region_code,
      a.weight/sum(a.weight) over (partition by a.line_code, a.sos_region_code) as share
    from au.direct_region_allocation a
  ),
  lam_asof as materialized (
    select l.line_code, l.area_code, l.operational_region_code, l.area_state, l.other_type,
      l.dm_seat_id, l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end) as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  ind_agg as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q, sum(pr.effective_units * pr.factory_price) as v
    from priced pr
    where not pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  ),
  dir_agg as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q, sum(pr.direct_value) as v
    from priced pr
    where pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  )
  select p_period, 'indirect'::text, lam.line_code, lam.operational_region_code, lam.area_code,
    lam.area_state, (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id, lam.dm_seat_id, lam.dm_occupant_hr_id,
    ia.product_code, ia.q, ia.v, true, null::text
  from ind_agg ia
  join lam_asof lam on lam.line_code = ia.line_code and lam.area_code = ia.canonical_area_code

  union all
  select p_period, 'direct'::text, lam.line_code, lam.operational_region_code, lam.area_code,
    lam.area_state, (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id, lam.dm_seat_id, lam.dm_occupant_hr_id,
    da.product_code, da.q, da.v, true, null::text
  from dir_agg da
  join lam_asof lam on lam.line_code = da.line_code and lam.area_code = da.canonical_area_code

  union all
  select p_period, 'direct'::text, pr.line_code,
    coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')),
    null, null, false, null, null, null, null,
    pr.product_code,
    sum(pr.total_qty * coalesce(alloc.share, 1)),
    sum(pr.direct_value * coalesce(alloc.share, 1)),
    true, null::text
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
    case
      when pr.line_code is null then 'unmapped_line'
      when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
      when (not pr.is_direct) then 'no_area_map'
      else 'unmapped_other'
    end
  from priced pr
  left join lam_asof lam on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  where pr.line_code is null
     or ((not pr.is_direct) and (pr.canonical_area_code is null or lam.line_code is null))
  group by pr.line_code, pr.canonical_area_code, pr.is_direct,
           case
             when pr.line_code is null then 'unmapped_line'
             when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
             when (not pr.is_direct) then 'no_area_map'
             else 'unmapped_other'
           end,
           pr.product_code;
end;
$function$;

CREATE OR REPLACE FUNCTION au.f_monthly_attribution_reconcile(p_period text)
 RETURNS TABLE(line_code text, mapped_value numeric, unmapped_value numeric, attributed_value numeric, raw_value numeric, diff numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  with att as (
    select coalesce(a.line_code,'(unmapped)') as line_code,
           sum(a.sales_value) filter (where a.mapped)     as mapped_value,
           sum(a.sales_value) filter (where not a.mapped)  as unmapped_value,
           sum(a.sales_value)                              as attributed_value
    from au.f_monthly_attribution(p_period) a
    group by coalesce(a.line_code,'(unmapped)')
  ),
  raw as (
    select coalesce(lm.line_code,'(unmapped)') as line_code,
           sum(case when f.is_direct then f.direct_value
                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0) end) as raw_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line))
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
    group by coalesce(lm.line_code,'(unmapped)')
  )
  select
    coalesce(att.line_code, raw.line_code)          as line_code,
    coalesce(att.mapped_value,0)                    as mapped_value,
    coalesce(att.unmapped_value,0)                  as unmapped_value,
    coalesce(att.attributed_value,0)                as attributed_value,
    coalesce(raw.raw_value,0)                       as raw_value,
    coalesce(att.attributed_value,0) - coalesce(raw.raw_value,0) as diff
  from att
  full join raw on raw.line_code = att.line_code
  order by 1;
$function$;

CREATE OR REPLACE FUNCTION au.f_sales_brick_detail(p_period text)
 RETURNS TABLE(period text, line_code text, region_code text, area_code text, area_state text, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, brick_id text, brick_name text, block_code text, sales_units numeric, sales_value numeric, direct_value numeric, indirect_value numeric)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
declare
  v_period_end date;
begin
  if p_period !~ '^\d{4}-\d{2}$' then
    return;
  end if;
  if to_date(p_period || '-01', 'YYYY-MM-DD') < date '2026-07-01' then
    return;
  end if;

  v_period_end := (date_trunc('month', to_date(p_period || '-01', 'YYYY-MM-DD'))
                   + interval '1 month - 1 day')::date;

  return query
  with fact as (
    select
      f.official_line,
      nullif(btrim(f.area_code), '')            as sos_area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '') as brick_id,
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  priced as (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(public.phx_factory_price(fa.product_code, p_period), 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = fa.product_code
  ),
  lam_asof as materialized (
    select
      l.line_code, l.area_code, l.operational_region_code, l.area_state,
      l.dm_seat_id, l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  )
  select
    p_period,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.brick_id,
    b.brick_name,
    b.block_code,
    sum(pr.total_qty),
    sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
    sum(case when pr.is_direct then pr.direct_value else 0 end),
    sum(case when pr.is_direct then 0 else pr.effective_units * pr.factory_price end)
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  left join public.source_of_sales_bricks b
    on b.brick_id = pr.brick_id
  where pr.line_code is not null and pr.canonical_area_code is not null
  group by
    lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
    lam.rep_seat_id, lam.rep_occupant_hr_id, lam.dm_seat_id, lam.dm_occupant_hr_id,
    pr.brick_id, b.brick_name, b.block_code;
end;
$function$;

CREATE OR REPLACE FUNCTION au.f_sales_area_trend(p_line_code text, p_area_code text, p_product_code text DEFAULT NULL::text)
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select f.period,
         sum(f.total_qty) as units,
         sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where not f.is_direct and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by f.period
  order by f.period;
$function$;

CREATE OR REPLACE FUNCTION au.f_sales_source_breakdown(p_period text, p_line_code text, p_area_code text, p_product_code text DEFAULT NULL::text)
 RETURNS TABLE(product_code text, product_name text, distributor_name text, brick_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select
    upper(btrim(f.product_code)) as product_code,
    max(coalesce(p.product_name, f.product_name)) as product_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and not f.is_direct
    and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)'),
           coalesce(nullif(btrim(b.brick_name), ''), '(no brick)')
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0)) <> 0
  order by value desc, units desc;
$function$;

CREATE OR REPLACE FUNCTION au.f_sales_source_breakdown_detail(p_period text, p_line_code text, p_area_code text, p_product_code text)
 RETURNS TABLE(brick_name text, distributor_name text, customer_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(cn.customer_name, '(unmapped customer)') as customer_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  left join lateral (
    select cm.customer_name from public.source_of_sales_customer_map cm
    where cm.customer_code = f.client_code and cm.customer_name is not null
    order by (cm.distributor_code = f.distributor_code) desc nulls last
    limit 1
  ) cn on true
  where f.period = p_period and not f.is_direct and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by 1, 2, 3
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0)) <> 0
  order by value desc;
$function$;

CREATE OR REPLACE FUNCTION au.f_sales_source_breakdown_line(p_period text, p_line_code text)
 RETURNS TABLE(area_code text, product_code text, product_name text, distributor_name text, brick_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select
    f.area_code,
    upper(btrim(f.product_code)) as product_code,
    max(coalesce(p.product_name, f.product_name)) as product_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and not f.is_direct
    and nullif(btrim(f.area_code),'') is not null
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by f.area_code, upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)'),
           coalesce(nullif(btrim(b.brick_name), ''), '(no brick)')
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0)) <> 0
  order by f.area_code, value desc;
$function$;

CREATE OR REPLACE FUNCTION public.phx_monthly_closing_matrix(p_line text, p_period text)
 RETURNS TABLE(area_code text, product_code text, sales_units numeric, sales_value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    f.area_code, f.product_code,
    sum(f.total_qty)                                       as sales_units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.area_code, f.product_code;
$function$;

CREATE OR REPLACE FUNCTION public.phx_closing_brick(p_line text, p_period text)
 RETURNS TABLE(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty)                                         as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0))    as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$function$;

CREATE OR REPLACE FUNCTION public.phx_closing_channel_breakdown(p_line text, p_period text, p_store_stems text[], p_hospital_stems text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_pharmacy_override_codes text[] DEFAULT '{}'::text[], p_store_override_codes text[] DEFAULT '{}'::text[], p_rule jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public', 'au'
 SET statement_timeout TO '60s'
AS $function$
  with
  rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_codes, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  names as (
    select r.distributor_code, r.client_code, r.client_name, r.folded_name
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = p_period
      and not r.is_direct
      and r.client_code is not null
  ),
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      f.client_code                                   as client_key,
      f.distributor_code                              as distributor_code,
      coalesce(n.client_name, '')                     as client_name,
      coalesce(n.folded_name, '')                     as folded_name,
      (f.client_code is null)                         as no_client_code,
      false                                           as is_direct,
      f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      case when p_period <> '2026-07'
           then nullif(btrim(coalesce(r.area_code, '')), '') end as area_code,
      case when p_period <> '2026-07'
           then nullif(btrim(coalesce(r.brick_id, '')), '') end  as brick_id,
      null::text                                      as client_key,
      null::text                                      as distributor_code,
      btrim(coalesce(r.client_name, ''))              as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
      false                                           as no_client_code,
      true                                            as is_direct,
      r.value                                         as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = p_period
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  tagged as (
    select
      u.*,
      case
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        else public.phx_customer_channel(
               u.client_name, u.client_key, u.distributor_code, p_period, p_line, rule.payload)
      end as channel
    from (select * from retail union all select * from direct) u
    cross join rule
  ),
  seated as (
    select
      t.*,
      s.seat_id,
      ca.area_name as seat_area_name,
      oh.occupant_hr_id
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(p_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
    left join au.occupancy_history oh
      on oh.seat_id = s.seat_id and oh.effective_to is null
    left join au.canonical_areas ca
      on ca.area_code = s.area_code
  ),
  keyed as (
    select 'product' as dimension,
           coalesce(nullif(sd.product_code, ''), '__NO_PRODUCT__') as key,
           coalesce(sd.product_name, '')                           as label,
           sd.channel, sd.value
    from seated sd
    union all
    select 'area',
           case when sd.area_code is not null then sd.area_code
                when sd.is_direct then '__DIRECT__'
                else '__NO_AREA__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'brick',
           case when sd.brick_id is not null then sd.brick_id
                when sd.is_direct then '__DIRECT__'
                else '__NO_BRICK__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'rep',
           case when sd.occupant_hr_id is not null then sd.occupant_hr_id::text
                when sd.seat_id is not null then '__VACANT__:' || sd.seat_id::text
                when sd.is_direct then '__DIRECT__'
                else '__NO_SEAT__' end,
           case when sd.occupant_hr_id is not null then coalesce(e.full_name, '')
                when sd.seat_id is not null then coalesce(sd.seat_area_name, '')
                else '' end,
           sd.channel, sd.value
    from seated sd
    left join public.employees e on e.hr_id = sd.occupant_hr_id
  ),
  grids as (
    select
      k.dimension,
      k.key,
      coalesce(max(nullif(k.label, '')), '')                                       as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)              as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)                 as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)              as pharmacy,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_code'), 0)  as unidentified_no_code,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_name'), 0)  as unidentified_no_name,
      coalesce(sum(k.value) filter (where k.channel = 'direct_unnamed'), 0)        as direct_unnamed,
      coalesce(sum(k.value), 0)                                                    as total
    from keyed k
    group by k.dimension, k.key
  ),
  area_reps as (
    select distinct
      x.sos_area_code as area_code,
      case when oh.occupant_hr_id is not null then oh.occupant_hr_id::text
           when s.seat_id is not null then '__VACANT__:' || s.seat_id::text
           else '__NO_SEAT__' end as rep_key,
      case when oh.occupant_hr_id is not null then coalesce(e.full_name, '')
           when s.seat_id is not null then coalesce(ca.area_name, '')
           else '' end as rep_label
    from au.sos_area_crosswalk x
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(p_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
    left join au.occupancy_history oh
      on oh.seat_id = s.seat_id and oh.effective_to is null
    left join au.canonical_areas ca
      on ca.area_code = s.area_code
    left join public.employees e on e.hr_id = oh.occupant_hr_id
    where x.effective_to is null
      and x.sos_area_code is not null
  ),
  brick_area as (
    select
      case when sd.brick_id is null then '__NO_BRICK__' else sd.brick_id end as brick_key,
      coalesce(sd.area_code, '__NO_AREA__')                                  as area_key,
      sum(sd.value) filter (where sd.channel = 'store')                      as store
    from seated sd
    where not sd.is_direct
    group by 1, 2
    having coalesce(sum(sd.value) filter (where sd.channel = 'store'), 0) <> 0
  ),
  population as (
    select
      (
        select coalesce(sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)), 0)
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b
          on b.id = f.batch_id and b.status = 'validated'
        left join public.source_of_sales_products p
          on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
        where f.period = p_period
          and lower(btrim(f.official_line)) = lower(btrim(p_line))
          and not coalesce(f.is_direct, false)
          and upper(btrim(coalesce(f.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      )
      +
      (
        select coalesce(sum(r.value), 0)
        from public.source_of_sales_import_rows r
        join public.source_of_sales_import_batches b
          on b.id = r.batch_id and b.status = 'validated'
        where r.invoice_period = p_period
          and lower(btrim(r.official_line)) = lower(btrim(p_line))
          and coalesce(r.is_direct, false)
          and r.validation_state = 'valid'
          and upper(btrim(coalesce(r.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      ) as value
  ),
  emitted as (
    select g.dimension, g.key, g.label,
           g.hospital, g.store, g.pharmacy,
           g.unidentified_no_code, g.unidentified_no_name, g.direct_unnamed,
           g.total,
           null::text as rep_key,
           null::text as area_key
    from grids g
    union all
    select 'area_rep', a.area_code, a.rep_label,
           0, 0, 0, 0, 0, 0, 0,
           a.rep_key, null::text
    from area_reps a
    union all
    select 'brick_area', ba.brick_key, '',
           0, ba.store, 0, 0, 0, 0,
           ba.store,
           null::text, ba.area_key
    from brick_area ba
    union all
    select 'population', 'TOTAL', '',
           0, 0, 0, 0, 0, 0, p.value,
           null::text, null::text
    from population p
  )
  select coalesce(jsonb_agg(row_to_json(e) order by e.dimension, e.total desc, e.key), '[]'::jsonb)
  from emitted e;
$function$;

CREATE OR REPLACE FUNCTION public.phx_closing_corrections(p_period text)
 RETURNS TABLE(kind text, period text, other_period text, line text, distributor_code text, area_code text, product_code text, product_name text, client_name text, units numeric, value numeric, other_units numeric, other_value numeric, region_code text, other_net_units numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
with periods as (
  select p_period as cur,
         to_char((p_period || '-01')::date - interval '1 month', 'YYYY-MM') as prev,
         to_char((p_period || '-01')::date + interval '1 month', 'YYYY-MM') as next
),
-- Per-distributor cells. Used by reversal_pair ONLY, where the distributor is the point: the
-- pattern is one distributor posting in one month and retracting in the next. A Direct row with no
-- area is keyed by its region, as the closing books it (see closing_cells).
cells as (
  select f.period as cell_period, f.official_line as cell_line, b.distributor_code as cell_dist,
         f.area_code as cell_area, f.product_code as cell_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cell_region,
         max(f.product_name) as cell_product_name,
         sum(f.total_qty) as cell_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cell_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code
),
-- One pharmacy's own net in a per-distributor cell, per month. Its buys and returns inside the SAME
-- month net here first: a line posted twice and taken back leaves the month's own total right and
-- undoes nothing in the month before. Client codes are unique per distributor only, which the
-- distributor key already respects. A blank client code is no identity, so it never matches (the
-- same rule late_return applies).
clients as (
  select f.period as cl_period, f.official_line as cl_line, b.distributor_code as cl_dist,
         f.area_code as cl_area, f.product_code as cl_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cl_region,
         btrim(f.client_code) as cl_client,
         sum(f.total_qty) as cl_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cl_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and nullif(btrim(f.client_code), '') is not null
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code, btrim(f.client_code)
),
-- What a cell's month TOOK BACK from the month before: each pharmacy that nets negative this month,
-- matched to its OWN purchase in the same cell the month before, capped at what it bought then.
-- Ordinary sales to other pharmacies that month cannot hide it. The value is the return's own
-- value, prorated when the cap cuts it.
taken_back as (
  select ret.cl_period as tb_period, ret.cl_line as tb_line, ret.cl_dist as tb_dist,
         ret.cl_area as tb_area, ret.cl_region as tb_region, ret.cl_product as tb_product,
         sum(least(-ret.cl_units, buy.cl_units)) as tb_units,
         sum(ret.cl_value * least(-ret.cl_units, buy.cl_units) / (-ret.cl_units)) as tb_value
  from clients ret
  join clients buy
    on buy.cl_line = ret.cl_line
   and buy.cl_dist = ret.cl_dist
   and buy.cl_area = ret.cl_area
   and buy.cl_region is not distinct from ret.cl_region
   and buy.cl_product = ret.cl_product
   and buy.cl_client = ret.cl_client
   and buy.cl_period = to_char((ret.cl_period || '-01')::date - interval '1 month', 'YYYY-MM')
  where ret.cl_units < 0
    and buy.cl_units > 0
  group by ret.cl_period, ret.cl_line, ret.cl_dist, ret.cl_area, ret.cl_region, ret.cl_product
),
-- THE CLOSING'S OWN CELL: area x product, every distributor together, exactly as
-- phx_monthly_closing_matrix groups it. This is what "the closing shows a negative there" means.
--
-- A direct row with NO AREA is the one exception, because the closing does not put it in an area
-- cell at all: phx_monthly_closing_direct returns it by REGION, and injectDirectIntoMatrix gives each
-- region its own "Direct" row. So such a row is keyed by its region here too (cell_region). Every
-- other row, a direct row that carries an area included, keeps cell_region NULL and groups by area
-- exactly as before, because the closing folds that direct money into the area's own row.
closing_cells as (
  select f.period as cell_period, f.official_line as cell_line,
         f.area_code as cell_area, f.product_code as cell_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cell_region,
         max(f.product_name) as cell_product_name,
         sum(f.total_qty) as cell_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cell_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period = pr.cur
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code
)
-- A pair is found two ways, with the same thresholds: the next month's whole cell nets below zero
-- (the original test, kept so nothing it found is lost), OR the same pharmacies took back that much
-- (taken_back), however much else the cell sold that month. When the pharmacies' take-back
-- qualifies, it is what the row reports, because the cell's net understates it by exactly the other
-- sales. other_net_units is always the next month's whole-cell net for this distributor, so the
-- page can say how much of the take-back that month's own figures show.
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       case when h.clients_hit then -tb.tb_units else neg.cell_units end,
       round((case when h.clients_hit then tb.tb_value else neg.cell_value end)::numeric, 2),
       pos.cell_region,
       neg.cell_units
from cells pos
join cells neg
  on neg.cell_line = pos.cell_line
 and neg.cell_dist = pos.cell_dist
 and neg.cell_area = pos.cell_area
 and neg.cell_region is not distinct from pos.cell_region
 and neg.cell_product = pos.cell_product
 and neg.cell_period = to_char((pos.cell_period || '-01')::date + interval '1 month', 'YYYY-MM')
left join taken_back tb
  on tb.tb_line = neg.cell_line
 and tb.tb_dist = neg.cell_dist
 and tb.tb_area = neg.cell_area
 and tb.tb_region is not distinct from neg.cell_region
 and tb.tb_product = neg.cell_product
 and tb.tb_period = neg.cell_period
cross join lateral (
  select coalesce(tb.tb_units, 0) between 0.5 * pos.cell_units and 1.5 * pos.cell_units as clients_hit
) h
cross join periods pr
where pos.cell_units >= 50
  and ((neg.cell_units < 0
        and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)
       or h.clients_hit)
  and (pos.cell_period = pr.cur or neg.cell_period = pr.cur)

union all
-- distributor_code is NULL here on purpose: this row is the whole cell, not one distributor's
-- share of it, and naming any single distributor would be the bug this replaced.
select 'net_negative'::text, c.cell_period, null, c.cell_line, null::text, c.cell_area,
       c.cell_product, c.cell_product_name, null,
       c.cell_units, round(c.cell_value::numeric, 2), null, null, c.cell_region, null::numeric
from closing_cells c
where c.cell_units < -20 or c.cell_value < -1000

union all
select 'late_return'::text, neg.neg_period, origin.origin_period, neg.neg_line, neg.neg_dist,
       neg.neg_area, neg.neg_product, neg.neg_product_name, neg.neg_client_name,
       neg.neg_units, round(neg.neg_value::numeric, 2), origin.origin_units, null, null::text, null::numeric
from (
  select b.period as neg_period, r.official_line as neg_line, b.distributor_code as neg_dist,
         r.area_code as neg_area, r.product_code as neg_product,
         max(r.product_name) as neg_product_name,
         btrim(r.client_code) as neg_client_code,
         max(r.client_name) as neg_client_name,
         sum(r.qty) as neg_units, sum(r.value) as neg_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  cross join periods pr
  where b.period = pr.cur
    and nullif(btrim(r.client_code), '') is not null
    and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by b.period, r.official_line, b.distributor_code, r.area_code, r.product_code, btrim(r.client_code)
  having sum(r.qty) <= -10 or sum(r.value) <= -1000
) neg
left join lateral (
  select b2.period as origin_period, sum(r2.qty) as origin_units
  from public.source_of_sales_import_rows r2
  join public.source_of_sales_import_batches b2 on b2.id = r2.batch_id and b2.status = 'validated'
  where b2.period < neg.neg_period
    and b2.distributor_code = neg.neg_dist
    and btrim(r2.client_code) = neg.neg_client_code
    and upper(btrim(r2.product_code)) = upper(btrim(neg.neg_product))
    and r2.qty > 0
  group by b2.period
  order by b2.period desc
  limit 1
) origin on true;
$function$;

CREATE OR REPLACE FUNCTION public.phx_closing_customers(p_line text, p_period text)
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with agg as (
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
          else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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

CREATE OR REPLACE FUNCTION public.phx_closing_distributor_product(p_line text, p_period text)
 RETURNS TABLE(distributor_code text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    r.distributor_code,
    r.region_code,
    r.area_code,
    r.product_code,
    max(r.product_name)                                     as product_name,
    sum(r.units_qty)                                        as units,
    sum(r.eff_units * coalesce(public.phx_factory_price(r.product_code, p_period), 0))         as value
  from public.source_of_sales_distributor_product_rollup r
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where r.period = p_period
    and r.line_key = lower(btrim(p_line))
  group by r.distributor_code, r.region_code, r.area_code, r.product_code;
$function$;

CREATE OR REPLACE FUNCTION public.phx_closing_publication_snapshot(p_line text, p_period text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cells as (
    select f.area_code, f.product_code, coalesce(f.is_direct, false) as is_direct,
           sum(f.total_qty) as units,
           sum(case when coalesce(f.is_direct, false)
                    then coalesce(f.direct_value, 0)
                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
               end) as value
    from source_of_sales_fact_rollup f
    left join source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(regexp_replace(f.official_line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
    group by 1, 2, 3
    having sum(f.total_qty) <> 0
  )
  select jsonb_build_object(
    'units', coalesce((select sum(units) from cells), 0),
    'value', coalesce((select sum(value) from cells), 0),
    'cells', (select count(*) from cells),
    'breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('a', area_code, 'p', product_code, 'd', is_direct,
                                          'u', units, 'v', value)
                       order by area_code, product_code, is_direct)
      from cells
    ), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.phx_lock_monthly_closing(p_line text, p_period text, p_actor text DEFAULT NULL::text)
 RETURNS monthly_closing_locks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_norm text := lower(btrim(coalesce(p_line, '')));
  v_row  public.monthly_closing_locks;
  v_units numeric;
  v_cells integer;
begin
  if v_norm = '' or btrim(coalesce(p_period, '')) = '' then
    raise exception 'A line and a period are required to lock a closing.';
  end if;

  select coalesce(sum(total_qty), 0), count(*)
    into v_units, v_cells
    from public.source_of_sales_fact_rollup
   where period = p_period and lower(btrim(coalesce(official_line, ''))) = v_norm;

  insert into public.monthly_closing_locks
    (line, normalized_line, period, locked_by, snapshot_units, snapshot_cells, snapshot_breakdown)
  values
    (btrim(p_line), v_norm, btrim(p_period), p_actor, v_units, v_cells,
     (select jsonb_agg(jsonb_build_object('a', f.area_code, 'p', f.product_code, 'd', f.is_direct,
                                          'u', f.total_qty,
                                          'v', case when coalesce(f.is_direct, false)
                                                    then coalesce(f.direct_value, 0)
                                                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
                                               end))
        from public.source_of_sales_fact_rollup f
        left join public.source_of_sales_products pr
          on upper(btrim(pr.product_code)) = upper(btrim(f.product_code))
       where f.period = p_period and lower(btrim(coalesce(f.official_line, ''))) = v_norm))
  returning * into v_row;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_exec_brick(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  return query
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (
           select upper(btrim(x)) from unnest(p_exclude_codes) as x)
    )
    and (p_lines    is null or f.official_line = any(p_lines))
    and (p_products is null or f.product_code  = any(p_products))
    and (p_regions  is null or f.region_code   = any(p_regions))
    and (p_areas    is null or f.area_code     = any(p_areas))
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_exec_customers(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '96MB'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code, r.brick_id,
      r.latest_row_created_at, r.total_qty,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(r.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(total_qty) as units, sum(line_value) as value
    from filtered group by client_code, distributor_code
  ),
  office as (
    select
      'OFFICE'::text as client_code,
      'Office'::text as client_name,
      'Office'::text as distributor_code,
      null::text as region_code,
      null::text as area_code,
      null::text as brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where (p_period is null or f.period = p_period)
      and f.is_direct = false
      and upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      and (p_lines    is null or f.official_line = any(p_lines))
      and (p_products is null or f.product_code  = any(p_products))
      and (p_regions  is null or f.region_code   = any(p_regions))
      and (p_areas    is null or f.area_code     = any(p_areas))
    having sum(f.total_qty) is not null
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a join latest l using (client_code, distributor_code)
  union all
  select o.client_code, o.client_name, o.distributor_code,
         o.region_code, o.area_code, o.brick_id, o.units, o.value
  from office o;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_exec_distributor_product(p_period text DEFAULT NULL::text, p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if p_period is null then
    return query
    select
      f.distributor_code,
      f.official_line,
      f.region_code,
      coalesce(nullif(f.area_code, ''), 'DIRECT') as area_code,
      f.product_code,
      max(f.product_name) as product_name,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  else
    return query
    select
      f.distributor_code,
      f.official_line,
      f.region_code,
      coalesce(nullif(f.area_code, ''), 'DIRECT') as area_code,
      f.product_code,
      max(f.product_name) as product_name,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_exec_sos_trend(p_periods text[] DEFAULT '{}'::text[], p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
declare
  -- Normalised ONCE, exactly as the old per-row sub-selects normalised them.
  v_lines         text[] := array(select lower(btrim(x)) from unnest(p_lines) as x);
  v_distributors  text[] := array(select upper(btrim(x)) from unnest(p_distributors) as x);
  v_regions       text[] := array(select upper(btrim(x)) from unnest(p_regions) as x);
  v_areas         text[] := array(select upper(btrim(x)) from unnest(p_areas) as x);
  v_products      text[] := array(select upper(btrim(x)) from unnest(p_products) as x);
  v_exclude_codes text[] := array(select upper(btrim(x)) from unnest(p_exclude_codes) as x);
begin
  if cardinality(p_lines) > 0 and not coalesce('' = any(v_lines), false) then
    -- Line-scoped and no blank line asked for: read only those lines' rows, on the line index.
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(public.phx_factory_price(g.product_code, g.period), 0) end) as value
    from (
      select
        f.period,
        f.official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where lower(btrim(f.official_line)) = any (v_lines)
        and (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  else
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(public.phx_factory_price(g.product_code, g.period), 0) end) as value
    from (
      select
        f.period,
        case when cardinality(p_lines) = 0 then null else f.official_line end as official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_customer_directory(p_region_codes text[] DEFAULT NULL::text[], p_area_codes text[] DEFAULT NULL::text[], p_brick_codes text[] DEFAULT NULL::text[], p_distributor_codes text[] DEFAULT NULL::text[], p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(client_code text, client_name text, client_address text, distributor_code text, brick_id text, area_code text, region_code text, total_units numeric, total_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '128MB'
AS $function$
  with filtered as materialized (
    select
      c.client_code,
      c.client_name,
      c.client_address,
      c.distributor_code,
      c.brick_id,
      c.area_code,
      c.region_code,
      c.latest_row_created_at,
      c.total_qty,
      c.effective_units * coalesce(public.phx_factory_price(c.product_code, c.period), 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code,
      distributor_code,
      client_name,
      client_address,
      brick_id,
      area_code,
      region_code
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty) as total_units,
      sum(line_value) as total_value
    from filtered
    group by client_code, distributor_code
  )
  select
    a.client_code,
    l.client_name,
    coalesce(
      nullif(btrim(l.client_address), ''),
      nullif(btrim(m.address), ''),
      ''
    ) as client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code)
  left join public.source_of_sales_customer_map m
    on m.distributor_code = a.distributor_code
   and m.customer_code = a.client_code
   and m.active;
$function$;

CREATE OR REPLACE FUNCTION public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(invoice_period text, product_code text, product_name text, official_line text, brick_id text, area_code text, region_code text, client_name text, client_address text, qty numeric, line_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
    r.area_code, r.region_code, r.client_name, r.client_address, r.qty,
    r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0) as line_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and r.distributor_code = p_distributor_code
    and r.client_code = p_client_code
    and (p_from_period is null or r.invoice_period >= p_from_period)
    and (p_to_period is null or r.invoice_period <= p_to_period)
    and upper(btrim(coalesce(r.product_code, ''))) <> all (
      select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
    )
  order by r.invoice_period, r.product_name;
$function$;

CREATE OR REPLACE FUNCTION public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[])
 RETURNS TABLE(brick_id text, client_code text, client_name text, official_line text, product_code text, product_name text, period text, units numeric, value numeric, scope_total_units numeric, scope_total_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      r.effective_units as row_units,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) end as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(row_units) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_sales_channels_by_rep(p_store_stems text[], p_hospital_stems text[], p_excluded_product_codes text[], p_period text DEFAULT NULL::text, p_store_override_keys text[] DEFAULT '{}'::text[], p_pharmacy_override_codes text[] DEFAULT '{}'::text[], p_rule jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text, hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric, hospital_customers bigint, store_customers bigint, pharmacy_customers bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'au'
 SET statement_timeout TO '60s'
AS $function$
  with rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_keys, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  rows_in_scope as (
    -- The closing's value: a distributor row is its paid units x factory price, and a direct order
    -- keeps its own order value. The sheet's typed value is never read for a distributor row.
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           r.invoice_period,
           r.client_name,
           case
             when coalesce(r.is_direct, false) then coalesce(r.value, 0)
             else coalesce(r.qty, 0) * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
           end as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code)
  ),
  tagged as (
    select t.client_code,
           t.distributor_code,
           t.area_code,
           t.official_line,
           t.value,
           public.phx_customer_channel(
             t.client_name, t.client_code, t.distributor_code,
             t.invoice_period, t.official_line, rule.payload
           ) as channel
    from rows_in_scope t
    cross join rule
  ),
  seated as (
    select t.channel,
           t.value,
           t.client_code,
           t.distributor_code,
           s.seat_id,
           s.line_code,
           s.area_code as seat_area_code
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(t.official_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
  ),
  repped as (
    select sd.*, oh.occupant_hr_id
    from seated sd
    left join au.occupancy_history oh
      on oh.seat_id = sd.seat_id and oh.effective_to is null
  )
  select
    rp.seat_id::text                                                             as seat_id,
    rp.occupant_hr_id::text                                                      as rep_hr_id,
    e.full_name::text                                                            as rep_name,
    rp.line_code::text                                                           as line_code,
    rp.seat_area_code::text                                                      as area_code,
    ca.area_name::text                                                           as area_name,
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)            as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)               as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)            as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                   as total_value,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'hospital')                                     as hospital_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'store')                                        as store_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'pharmacy')                                     as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$function$;

CREATE OR REPLACE FUNCTION public.phx_refresh_sos_channel_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
begin
  delete from public.source_of_sales_channel_customer_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_channel_customer_rollup
    (batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
     client_name, folded_name, no_client_code, is_direct,
     units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted)
  with
  names as (
    select distinct on (lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code)
      lower(btrim(d.official_line)) as line_key,
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.batch_id = p_batch_id
    order by lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code,
             d.latest_row_created_at desc
  ),
  retail as (
    select
      f.batch_id,
      lower(btrim(f.official_line))                          as line_key,
      max(f.official_line)                                   as official_line,
      f.period,
      f.distributor_code,
      f.client_code,
      f.client_code                                          as client_key,
      coalesce(n.client_name, '')                            as client_name,
      public.phx_fold_customer_name(coalesce(n.client_name, '')) as folded_name,
      (f.client_code is null)                                as no_client_code,
      false                                                  as is_direct,
      sum(f.total_qty)                                       as units_all,
      sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0))  as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(f.total_qty)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0))
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.line_key = lower(btrim(f.official_line))
     and n.period = f.period
     and n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.batch_id = p_batch_id
      and not coalesce(f.is_direct, false)
    group by f.batch_id, lower(btrim(f.official_line)), f.period, f.distributor_code,
             f.client_code, coalesce(n.client_name, '')
  ),
  direct as (
    select
      r.batch_id,
      lower(btrim(r.official_line))                          as line_key,
      max(r.official_line)                                   as official_line,
      r.invoice_period                                       as period,
      null::text                                             as distributor_code,
      null::text                                             as client_code,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end as client_key,
      btrim(coalesce(r.client_name, ''))                     as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
      false                                                  as no_client_code,
      true                                                   as is_direct,
      sum(r.qty)                                             as units_all,
      sum(r.value)                                           as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(r.qty)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(r.value)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.batch_id = p_batch_id
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
    group by r.batch_id, lower(btrim(r.official_line)), r.invoice_period,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end,
      btrim(coalesce(r.client_name, ''))
  )
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from retail
  union all
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from direct;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_market_awareness_tracking(p_line_code text, p_from_period text, p_to_period text, p_area_code text, p_brick_ids text[], p_product_codes text[])
 RETURNS TABLE(period text, scope text, indirect_units numeric, indirect_value numeric, direct_units numeric, direct_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with rows_in_window as (
    select
      f.period,
      f.area_code,
      f.brick_id,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value,
      f.product_code
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period between p_from_period and p_to_period
      and lower(btrim(f.official_line)) in (
        select lower(btrim(m.official_line))
        from au.sos_official_line_map m
        where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      )
      and upper(btrim(f.product_code)) = any (
        select upper(btrim(code)) from unnest(p_product_codes) as code
      )
      and (
        not f.is_direct
        or upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      )
      and not (f.is_direct and f.period = '2026-07')
  ),
  priced as (
    select
      r.*,
      r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) as indirect_value
    from rows_in_window r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  ),
  scoped as (
    select 'brick'::text as scope, * from priced
     where brick_id = any (p_brick_ids)
    union all
    select 'area'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
    union all
    select 'area_bricked'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
       and brick_id is not null
       and btrim(brick_id) <> ''
  )
  select
    s.period,
    s.scope,
    coalesce(sum(s.total_qty)      filter (where not s.is_direct), 0) as indirect_units,
    coalesce(sum(s.indirect_value) filter (where not s.is_direct), 0) as indirect_value,
    coalesce(sum(s.total_qty)      filter (where s.is_direct), 0)     as direct_units,
    coalesce(sum(s.direct_value)   filter (where s.is_direct), 0)     as direct_value
  from scoped s
  group by s.period, s.scope;
$function$;

CREATE OR REPLACE FUNCTION public.phx_marketing_coverage_export_sales_detail(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT '{LA003,LA004,SS001}'::text[])
 RETURNS TABLE(request_id uuid, distributor_code text, distributor_name text, invoice_period text, product_code text, product_name text, customer_code text, customer_name text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  win as (
    select req.id as request_id, to_char(g, 'YYYY-MM') as period
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) g
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    cross join excl
    where mrp.request_id = any(p_request_ids)
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    -- join source_of_sales_distributors so a rollup code with no SoS distributor row is
    -- dropped IDENTICALLY to phx_marketing_request_roi_actuals / the single-request RPC.
    select distinct
      mrph.request_id,
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  hits as (
    -- dedup per (request, matched SoS row): the SAME underlying sale can legitimately
    -- satisfy more than one request in the batch, but must never appear twice for the
    -- SAME request (mirrors the single-request RPC's `distinct on (r.id)` exactly, just
    -- scoped per request instead of globally, since this now covers many requests at once).
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      r.id as row_id,
      tp.parent_distributor_code,
      r.invoice_period,
      r.product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      tp.customer_code,
      r.client_name as customer_name,
      r.region_name,
      r.qty as qty,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
      end as value
    from target_products tp
    join win on win.request_id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = win.period
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    order by tp.request_id, r.id
  )
  select
    hits.request_id,
    hits.parent_distributor_code as distributor_code,
    coalesce(sd.distributor_name, hits.parent_distributor_code) as distributor_name,
    hits.invoice_period,
    hits.product_code,
    hits.product_name,
    hits.customer_code,
    hits.customer_name,
    hits.region_name,
    hits.qty::numeric,
    hits.value::numeric
  from hits
  left join public.source_of_sales_distributors sd on sd.distributor_code = hits.parent_distributor_code
  order by hits.request_id, hits.invoice_period, hits.parent_distributor_code, hits.product_code;
$function$;

CREATE OR REPLACE FUNCTION public.phx_marketing_request_roi_actuals(p_request_ids uuid[])
 RETURNS TABLE(request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer, exact_sales_rows integer, fallback_sales_rows integer, attribution_quality text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id = any(p_request_ids)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  exact_hits as (
    select distinct
      tp.request_id,
      r.id as row_id,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
      end as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
  ),
  actuals as (
    select
      request_id,
      coalesce(sum(value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows
    from exact_hits
    group by request_id
  )
  select
    req.id as request_id,
    coalesce(actuals.actual_value, 0)::numeric as actual_value,
    coalesce(actuals.actual_units, 0)::numeric as actual_units,
    coalesce(actuals.sales_rows, 0)::integer as sales_rows,
    coalesce(actuals.sales_rows, 0)::integer as exact_sales_rows,
    0::integer as fallback_sales_rows,
    case when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales' else 'exact_customer' end as attribution_quality
  from req
  left join actuals on actuals.request_id = req.id;
$function$;

CREATE OR REPLACE FUNCTION public.phx_marketing_request_sales_lines(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text)
 RETURNS TABLE(request_id uuid, channel text, source_row_id text, distributor_code text, distributor_name text, customer_code text, customer_name text, product_code text, product_name text, invoice_period text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months,
           coalesce(mr.track_direct_sales, false) as track_direct_sales
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  win as (
    select case
      when p_from_period ~ '^\d{4}-\d{2}$' and p_to_period ~ '^\d{4}-\d{2}$' and p_from_period <= p_to_period
        then array(
          select to_char(g, 'YYYY-MM')
          from generate_series(to_date(p_from_period, 'YYYY-MM'), to_date(p_to_period, 'YYYY-MM'), interval '1 month') g
        )
      else null::text[]
    end as periods
  ),
  pay_periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  periods as (
    select ids.id, coalesce(win.periods, pay_periods.periods) as periods
    from (select distinct u.id from unnest(coalesce(p_request_ids, '{}'::uuid[])) as u(id)) ids
    cross join win
    left join pay_periods on pay_periods.id = ids.id
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    cross join excl
    where mrp.request_id = any(p_request_ids)
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  retail_hits as (
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      'retail'::text as channel,
      r.id::text as source_row_id,
      tp.parent_distributor_code::text as distributor_code,
      coalesce(sd.distributor_name, tp.parent_distributor_code)::text as distributor_name,
      tp.customer_code::text as customer_code,
      r.client_name::text as customer_name,
      r.product_code::text as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code)::text as product_name,
      r.invoice_period::text as invoice_period,
      r.region_name::text as region_name,
      r.qty::numeric as qty,
      (case when coalesce(r.is_direct, false)
            then coalesce(r.value, 0)
            else r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
       end)::numeric as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.parent_distributor_code
    order by tp.request_id, r.id
  ),
  direct_hits as (
    select distinct on (mrph.request_id, dor.id)
      mrph.request_id,
      'direct'::text as channel,
      dor.id::text as source_row_id,
      sd.distributor_code::text as distributor_code,
      sd.distributor_name::text as distributor_name,
      mpdc.normalized_pharmacy_code::text as customer_code,
      null::text as customer_name,
      dor.product_code::text as product_code,
      null::text as product_name,
      dor.sales_month::text as invoice_period,
      null::text as region_name,
      coalesce(dor.qty, 0)::numeric as qty,
      coalesce(dor.sales_value, 0)::numeric as value
    from req
    join periods on periods.id = req.id
    join req_products rp on rp.request_id = req.id
    join public.marketing_request_pharmacies mrph on mrph.request_id = req.id
    join public.marketing_pharmacy_distributor_codes mpdc
      on mpdc.id = mrph.distributor_code_id and coalesce(mpdc.active, true)
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    join public.direct_order_pharmacy_distributor_codes dopdc
      on lower(btrim(dopdc.distributor_code)) = lower(btrim(sd.distributor_code))
     and lower(btrim(regexp_replace(coalesce(dopdc.customer_code, ''), '\s+', ' ', 'g')))
       = lower(btrim(regexp_replace(coalesce(mpdc.normalized_pharmacy_code, ''), '\s+', ' ', 'g')))
    join public.direct_order_requests dor
      on dor.pharmacy_id = dopdc.pharmacy_id
     and dor.status = 'approved'
     and dor.reversal_of_request_id is null
     and dor.sales_month = any(periods.periods)
     and upper(btrim(dor.product_code)) = upper(btrim(rp.product_code))
    where req.track_direct_sales = true
    order by mrph.request_id, dor.id
  )
  select * from retail_hits
  union all
  select * from direct_hits;
$function$;

CREATE OR REPLACE FUNCTION public.phx_marketing_roi_customer_dashboard(p_lines text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_distributor_codes text[] DEFAULT '{}'::text[], p_product_codes text[] DEFAULT '{}'::text[], p_roi_statuses text[] DEFAULT '{}'::text[], p_attribution_qualities text[] DEFAULT '{}'::text[], p_customer_search text DEFAULT NULL::text, p_from_month text DEFAULT NULL::text, p_to_month text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with params as (
    select
      greatest(10, least(coalesce(p_limit, 100), 100)) as row_limit,
      nullif(lower(btrim(coalesce(p_customer_search, ''))), '') as customer_search,
      case when coalesce(p_from_month, '') ~ '^\d{4}-\d{2}$' then p_from_month else null end as from_month,
      case when coalesce(p_to_month, '') ~ '^\d{4}-\d{2}$' then p_to_month else null end as to_month,
      public.phx_marketing_roi_latest_validated_period() as sales_as_of
  ),
  filter_lines as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_lines, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_regions as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_regions, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_distributors as materialized (
    select upper(btrim(value)) as value
    from unnest(coalesce(p_distributor_codes, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_products as materialized (
    select upper(btrim(value)) as value
    from unnest(coalesce(p_product_codes, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_roi_statuses as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_roi_statuses, '{}'::text[])) as value
    where lower(btrim(value)) in ('behind', 'no_data', 'on_track')
  ),
  filter_attribution as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_attribution_qualities, '{}'::text[])) as value
    where lower(btrim(value)) in ('exact_customer', 'no_sales')
  ),
  req_raw as materialized (
    select
      mr.id,
      mr.request_code,
      mr.status,
      mr.pay_date,
      to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') as pay_month,
      greatest(coalesce(mr.roi_duration_months, 1), 1) as roi_duration_months,
      coalesce(mr.estimated_cost, 0)::numeric as estimated_cost,
      coalesce(mr.required_roi_value, coalesce(mr.estimated_cost, 0) * 10)::numeric as required_roi_value,
      coalesce(mr.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(mr.roi_coverage_ratio, 0)::numeric as expected_coverage_ratio,
      mr.customer_id,
      mr.line_id,
      coalesce(l.name, 'Unassigned') as request_line,
      coalesce(mc.display_name, mr.customer_id::text) as customer_name,
      mc.customer_code,
      params.sales_as_of
    from public.marketing_requests mr
    left join public.employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
    left join public.lines l on l.id = coalesce(mr.line_id, emp_req.line_id)
    left join public.marketing_customers mc on mc.id = mr.customer_id
    cross join params
    where mr.status in ('approved', 'active', 'roi_tracking', 'closed', 'finance_hold')
      and mr.pay_date is not null
      and (params.from_month is null or to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') >= params.from_month)
      and (params.to_month is null or to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') <= params.to_month)
      and (
        params.customer_search is null
        or lower(mr.request_code) like '%' || params.customer_search || '%'
        or lower(coalesce(mc.display_name, '')) like '%' || params.customer_search || '%'
        or lower(coalesce(mc.customer_code, '')) like '%' || params.customer_search || '%'
      )
  ),
  req_products_all as materialized (
    select distinct
      mrp.request_id,
      upper(btrim(sp.product_code)) as product_code,
      coalesce(sp.product_name, mp.product_name, mrp.product_name_snapshot) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(mp.line), ''), nullif(btrim(mrp.line_snapshot), ''), 'Unassigned') as line_label,
      coalesce(mrp.expected_value, 0)::numeric as expected_value,
      coalesce(mrp.value_share, 0)::numeric as value_share,
      (sp.product_code is null) as missing_sales_product_mapping
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    left join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id in (select id from req_raw)
  ),
  req_targets_all as materialized (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
      mpdc.normalized_pharmacy_code as customer_code,
      mph.id as pharmacy_id,
      coalesce(mph.display_name, mpdc.normalized_pharmacy_code) as pharmacy_name,
      cm.brick_id,
      cm.region_code,
      cm.area_code,
      (cm.brick_id is null) as missing_customer_mapping
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_pharmacies mph on mph.id = mrph.pharmacy_id
    join (select distinct marketing_normalized_name, parent_distributor_code from public.marketing_roi_distributor_rollup) ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
    left join lateral (
      select cmx.brick_id, cmx.region_code, cmx.area_code
      from public.source_of_sales_customer_map cmx
      where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
        and cmx.active
        and (cmx.distributor_code = sd.distributor_code
             or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                        where rcm.parent_distributor_code = sd.distributor_code
                          and rcm.sos_distributor_code = cmx.distributor_code))
      order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
      limit 1
    ) cm on true
    where mrph.request_id in (select id from req_raw)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
      and coalesce(mpdc.active, true)
  ),
  req as materialized (
    select
      rr.*,
      coalesce(
        nullif(btrim(rr.request_line), ''),
        (select max(rpa.line_label) from req_products_all rpa where rpa.request_id = rr.id),
        'Unassigned'
      ) as line_label
    from req_raw rr
    where (
        not exists (select 1 from filter_lines)
        or lower(btrim(coalesce(rr.request_line, ''))) in (select value from filter_lines)
        or exists (
          select 1
          from req_products_all rpa
          where rpa.request_id = rr.id
            and lower(btrim(rpa.line_label)) in (select value from filter_lines)
        )
      )
      and (
        not exists (select 1 from filter_regions)
        or exists (
          select 1
          from req_targets_all rta
          where rta.request_id = rr.id
            and lower(btrim(coalesce(rta.region_code, ''))) in (select value from filter_regions)
        )
      )
      and (
        not exists (select 1 from filter_distributors)
        or exists (
          select 1
          from req_targets_all rta
          where rta.request_id = rr.id
            and upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
        )
      )
      and (
        not exists (select 1 from filter_products)
        or exists (
          select 1
          from req_products_all rpa
          where rpa.request_id = rr.id
            and upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
        )
      )
  ),
  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
  ),
  req_targets as materialized (
    select rta.*
    from req_targets_all rta
    join req on req.id = rta.request_id
    where (
        not exists (select 1 from filter_regions)
        or lower(btrim(coalesce(rta.region_code, ''))) in (select value from filter_regions)
      )
      and (
        not exists (select 1 from filter_distributors)
        or upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
      )
  ),
  product_rollups as (
    select
      request_id,
      count(*)::numeric as product_count,
      coalesce(sum(nullif(value_share, 0)), 0)::numeric as value_share_total,
      coalesce(sum(expected_value), 0)::numeric as expected_total
    from req_products
    group by request_id
  ),
  request_product_allocations as materialized (
    select
      rp.request_id,
      rp.product_code,
      rp.product_name,
      rp.line_label,
      rp.expected_value,
      rp.value_share,
      rp.missing_sales_product_mapping,
      case
        when pr.value_share_total > 0 then rp.value_share / pr.value_share_total
        when pr.expected_total > 0 then rp.expected_value / pr.expected_total
        when pr.product_count > 0 then 1 / pr.product_count
        else 0
      end as share
    from req_products rp
    join product_rollups pr on pr.request_id = rp.request_id
  ),
  target_rollups as (
    select request_id, count(*)::numeric as target_count
    from req_targets
    group by request_id
  ),
  request_target_allocations as materialized (
    select
      rt.*,
      case when tr.target_count > 0 then 1 / tr.target_count else 0 end as share
    from req_targets rt
    join target_rollups tr on tr.request_id = rt.request_id
  ),
  periods as materialized (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.roi_duration_months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  target_products as materialized (
    select distinct
      rt.request_id,
      rt.distributor_code,
      rt.customer_code,
      rpa.product_code
    from req_targets rt
    join request_product_allocations rpa on rpa.request_id = rt.request_id
    where rpa.product_code is not null
  ),
  -- Customer-code-only match (same rule as the per-request function).
  exact_hits as materialized (
    select distinct
      tp.request_id,
      r.id as row_id,
      tp.distributor_code,
      coalesce(sd.distributor_name, tp.distributor_code) as distributor_name,
      lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) as client_code,
      nullif(btrim(r.client_name), '') as client_name,
      r.region_code,
      coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
      nullif(btrim(r.brick_id), '') as brick_id,
      upper(btrim(r.product_code)) as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(r.official_line), ''), 'Unassigned') as line_label,
      coalesce(r.qty, 0)::numeric as units,
      (
        case
          when coalesce(r.is_direct, false) then coalesce(r.value, 0)
          else coalesce(r.qty, 0) * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
        end
      )::numeric as sales_value,
      'exact'::text as match_type
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.marketing_roi_distributor_rollup rr on rr.parent_distributor_code = tp.distributor_code
    join public.source_of_sales_import_rows r
      on r.distributor_code = rr.sos_distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.distributor_code
    left join public.source_of_sales_regions sr on sr.region_code = r.region_code
    where (
      not exists (select 1 from filter_regions)
      or lower(btrim(r.region_code)) in (select value from filter_regions)
    )
  ),
  all_hits as materialized (
    select * from exact_hits
  ),
  actuals as materialized (
    select
      request_id,
      coalesce(sum(sales_value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows,
      (count(distinct row_id) filter (where match_type = 'exact'))::integer as exact_sales_rows,
      (count(distinct row_id) filter (where match_type = 'fallback'))::integer as fallback_sales_rows
    from all_hits
    group by request_id
  ),
  request_rows_base as materialized (
    select
      req.id,
      req.request_code,
      req.status,
      req.pay_date,
      req.pay_month,
      req.roi_duration_months,
      req.estimated_cost,
      req.required_roi_value,
      req.expected_roi_value,
      req.expected_coverage_ratio,
      req.customer_id,
      req.customer_name,
      req.customer_code,
      req.line_label,
      coalesce(actuals.actual_value, 0)::numeric as actual_sales_value,
      coalesce(actuals.actual_units, 0)::numeric as actual_sales_units,
      coalesce(actuals.sales_rows, 0)::integer as sales_rows,
      coalesce(actuals.exact_sales_rows, 0)::integer as exact_sales_rows,
      coalesce(actuals.fallback_sales_rows, 0)::integer as fallback_sales_rows,
      case
        when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales'
        else 'exact_customer'
      end as attribution_quality,
      case
        when coalesce(actuals.sales_rows, 0) > 0
             and coalesce(actuals.actual_value, 0) >= req.required_roi_value then 'on_track'
        when req.pay_date is not null
             and req.sales_as_of is not null
             and to_char(
                   req.pay_date + make_interval(months => req.roi_duration_months - 1),
                   'YYYY-MM'
                 ) > req.sales_as_of then 'awaiting_data'
        when coalesce(actuals.sales_rows, 0) > 0 then 'behind'
        else 'no_data'
      end as actual_roi_status,
      case
        when req.required_roi_value > 0 then coalesce(actuals.actual_value, 0) / req.required_roi_value
        when coalesce(actuals.actual_value, 0) > 0 then 1
        else 0
      end as actual_coverage_ratio,
      greatest(req.required_roi_value - coalesce(actuals.actual_value, 0), 0)::numeric as coverage_gap,
      greatest(req.expected_roi_value - coalesce(actuals.actual_value, 0), 0)::numeric as expected_gap
    from req
    left join actuals on actuals.request_id = req.id
  ),
  request_rows as materialized (
    select
      rrb.*,
      case
        when rrb.actual_roi_status = 'on_track' then 'monitor'
        when rrb.attribution_quality = 'no_sales' then 'mapping_review'
        when rrb.actual_coverage_ratio < 0.5 and rrb.coverage_gap > 0 then 'high_risk_gap'
        else 'follow_up'
      end as recommended_action
    from request_rows_base rrb
    where (
        not exists (select 1 from filter_roi_statuses)
        or rrb.actual_roi_status in (select value from filter_roi_statuses)
      )
      and (
        not exists (select 1 from filter_attribution)
        or rrb.attribution_quality in (select value from filter_attribution)
      )
  ),
  filtered_hits as materialized (
    select ah.*
    from all_hits ah
    join request_rows rr on rr.id = ah.request_id
  ),
  actuals_by_line as (
    select line_label, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by line_label
  ),
  actuals_by_region as (
    select region_code, max(region_name) as region_name, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by region_code
  ),
  actuals_by_distributor as (
    select distributor_code, max(distributor_name) as distributor_name, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by distributor_code
  ),
  actuals_by_product as (
    select product_code, max(product_name) as product_name, max(line_label) as line_label, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by product_code
  ),
  line_request_report as (
    select
      rpa.line_label as value,
      rpa.line_label as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      (select count(distinct pharmacy_id) from request_target_allocations rta join request_rows rrx on rrx.id = rta.request_id where rrx.id in (select request_id from request_product_allocations where line_label = rpa.line_label))::integer as pharmacy_count,
      sum(rr.estimated_cost * rpa.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rpa.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rpa.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_product_allocations rpa on rpa.request_id = rr.id
    group by rpa.line_label
  ),
  product_request_report as (
    select
      rpa.product_code as value,
      max(rpa.product_name) as label,
      max(rpa.line_label) as line_label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      (select count(distinct rta.pharmacy_id)
       from request_target_allocations rta
       join request_rows rrx on rrx.id = rta.request_id
       where rta.request_id in (select request_id from request_product_allocations where product_code = rpa.product_code))::integer as pharmacy_count,
      sum(rr.estimated_cost * rpa.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rpa.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rpa.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_product_allocations rpa on rpa.request_id = rr.id
    where rpa.product_code is not null
    group by rpa.product_code
  ),
  region_request_report as (
    select
      coalesce(rta.region_code, 'Unassigned') as value,
      coalesce(sr.region_name, rta.region_code, 'Unassigned') as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    left join public.source_of_sales_regions sr on sr.region_code = rta.region_code
    group by coalesce(rta.region_code, 'Unassigned'), coalesce(sr.region_name, rta.region_code, 'Unassigned')
  ),
  distributor_request_report as (
    select
      rta.distributor_code as value,
      max(rta.distributor_name) as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    group by rta.distributor_code
  ),
  customer_request_report as (
    select
      rta.distributor_code || ':' || rta.customer_code as value,
      max(rta.pharmacy_name) as label,
      max(rta.distributor_code) as distributor_code,
      max(rta.distributor_name) as distributor_name,
      max(coalesce(sr.region_name, rta.region_code)) as region_name,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    left join public.source_of_sales_regions sr on sr.region_code = rta.region_code
    group by rta.distributor_code || ':' || rta.customer_code
  ),
  actuals_by_customer as (
    select
      distributor_code || ':' || client_code as value,
      coalesce(max(client_name), max(nullif(client_code, '')), max(client_code)) as label,
      max(distributor_code) as distributor_code,
      max(distributor_name) as distributor_name,
      max(region_name) as region_name,
      sum(sales_value)::numeric as actual_sales_value,
      sum(units)::numeric as actual_sales_units,
      count(distinct row_id)::integer as sales_rows,
      count(distinct row_id) filter (where match_type = 'exact')::integer as exact_sales_rows,
      count(distinct row_id) filter (where match_type = 'fallback')::integer as fallback_sales_rows
    from filtered_hits
    group by distributor_code || ':' || client_code
  ),
  roi_trend as (
    select
      pay_month as period,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value,
      sum(actual_sales_value)::numeric as actual_sales_value,
      sum(coverage_gap)::numeric as coverage_gap,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count
    from request_rows
    group by pay_month
  ),
  attribution_summary as (
    select
      coalesce(sum(exact_sales_rows), 0)::integer as exact_sales_rows,
      coalesce(sum(fallback_sales_rows), 0)::integer as fallback_sales_rows,
      count(*) filter (where attribution_quality = 'mixed')::integer as mixed_requests,
      count(*) filter (where attribution_quality = 'no_sales')::integer as no_sales_requests,
      (
        select count(*)::integer
        from req_targets rt
        join request_rows rr on rr.id = rt.request_id
        where rt.missing_customer_mapping
      ) + (
        select count(*)::integer
        from req_products rp
        join request_rows rr on rr.id = rp.request_id
        where rp.missing_sales_product_mapping
      ) as unmatched_mapping_count
    from request_rows
  ),
  dashboard_summary as (
    select
      count(*)::integer as marketing_request_count,
      count(*)::integer as paid_request_count,
      count(distinct customer_id)::integer as active_customers,
      (
        select count(distinct rta.pharmacy_id)::integer
        from request_target_allocations rta
        join request_rows rr on rr.id = rta.request_id
      ) as active_pharmacies,
      coalesce(sum(estimated_cost), 0)::numeric as total_marketing_cost,
      coalesce(sum(required_roi_value), 0)::numeric as required_roi_value,
      coalesce(sum(expected_roi_value), 0)::numeric as expected_roi_value,
      coalesce(sum(actual_sales_value), 0)::numeric as actual_sales_value,
      coalesce(sum(actual_sales_units), 0)::numeric as actual_sales_units,
      coalesce(sum(coverage_gap), 0)::numeric as coverage_gap,
      coalesce(sum(expected_gap), 0)::numeric as expected_gap,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count,
      count(*) filter (where recommended_action <> 'monitor')::integer as action_required_count,
      coalesce(sum(estimated_cost) filter (where actual_roi_status in ('behind', 'no_data')), 0)::numeric as spend_at_risk,
      coalesce(sum(estimated_cost) filter (where actual_roi_status = 'no_data'), 0)::numeric as no_data_spend
    from request_rows
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'limits', jsonb_build_object(
      'tableLimit', (select row_limit from params),
      'rawRowsReturned', 0
    ),
    'filters', jsonb_build_object(
      'selected', jsonb_build_object(
        'lines', coalesce(to_jsonb(p_lines), '[]'::jsonb),
        'regions', coalesce(to_jsonb(p_regions), '[]'::jsonb),
        'distributors', coalesce(to_jsonb(p_distributor_codes), '[]'::jsonb),
        'products', coalesce(to_jsonb(p_product_codes), '[]'::jsonb),
        'roiStatuses', coalesce(to_jsonb(p_roi_statuses), '[]'::jsonb),
        'attributionQualities', coalesce(to_jsonb(p_attribution_qualities), '[]'::jsonb),
        'customerSearch', p_customer_search,
        'fromMonth', p_from_month,
        'toMonth', p_to_month
      ),
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object('value', label, 'label', label) order by label), '[]'::jsonb)
        from (
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.source_of_sales_products
          where active
          union
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.marketing_products
          where active
        ) options
      ),
      'regions', (
        select coalesce(jsonb_agg(jsonb_build_object('value', region_code, 'label', region_name) order by region_name), '[]'::jsonb)
        from public.source_of_sales_regions
        where active
      ),
      'distributors', (
        select coalesce(jsonb_agg(jsonb_build_object('value', distributor_code, 'label', distributor_name) order by distributor_name), '[]'::jsonb)
        from public.source_of_sales_distributors
        where active
      ),
      'products', (
        select coalesce(jsonb_agg(jsonb_build_object('value', product_code, 'label', product_name) order by product_name), '[]'::jsonb)
        from public.source_of_sales_products
        where active
      ),
      'roiStatuses', jsonb_build_array(
        jsonb_build_object('value', 'behind', 'label', 'Behind'),
        jsonb_build_object('value', 'no_data', 'label', 'No data'),
        jsonb_build_object('value', 'on_track', 'label', 'On track')
      ),
      'attributionQualities', jsonb_build_array(
        jsonb_build_object('value', 'exact_customer', 'label', 'Exact customer'),
        jsonb_build_object('value', 'no_sales', 'label', 'No sales')
      )
    ),
    'summary', (
      select jsonb_build_object(
        'marketingRequestCount', marketing_request_count,
        'paidRequestCount', paid_request_count,
        'activeCustomers', active_customers,
        'activePharmacies', active_pharmacies,
        'totalMarketingCost', total_marketing_cost,
        'requiredRoiValue', required_roi_value,
        'expectedRoiValue', expected_roi_value,
        'actualAttributedSalesValue', actual_sales_value,
        'actualAttributedSalesUnits', actual_sales_units,
        'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end,
        'coverageGap', coverage_gap,
        'expectedGap', expected_gap,
        'onTrackRequests', on_track_count,
        'behindRequests', behind_count,
        'noDataRequests', no_data_count,
        'actionRequiredRequests', action_required_count,
        'spendAtRisk', spend_at_risk,
        'noDataSpend', no_data_spend
      )
      from dashboard_summary
    ),
    'decisionSummary', (
      select jsonb_build_object(
        'actionRequiredRequests', action_required_count,
        'spendAtRisk', spend_at_risk,
        'coverageGap', coverage_gap,
        'expectedGap', expected_gap,
        'noDataSpend', no_data_spend,
        'topRiskRequest', (
          select coalesce(jsonb_build_object(
            'id', id,
            'requestCode', request_code,
            'customerName', customer_name,
            'line', line_label,
            'estimatedCost', estimated_cost,
            'requiredRoiValue', required_roi_value,
            'actualSalesValue', actual_sales_value,
            'coverageGap', coverage_gap,
            'actualRoiCoverage', actual_coverage_ratio,
            'actualRoiStatus', actual_roi_status,
            'attributionQuality', attribution_quality,
            'recommendedAction', recommended_action
          ), '{}'::jsonb)
          from request_rows
          order by coverage_gap desc, estimated_cost desc
          limit 1
        )
      )
      from dashboard_summary
    ),
    'attributionHealth', (
      select jsonb_build_object(
        'exactSalesRows', exact_sales_rows,
        'fallbackSalesRows', fallback_sales_rows,
        'mixedRequests', mixed_requests,
        'noSalesRequests', no_sales_requests,
        'unmatchedMappingWarnings', unmatched_mapping_count
      )
      from attribution_summary
    ),
    'roiTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', period,
        'requestCount', request_count,
        'marketingCost', marketing_cost,
        'requiredRoiValue', required_roi_value,
        'expectedRoiValue', expected_roi_value,
        'actualSalesValue', actual_sales_value,
        'coverageGap', coverage_gap,
        'onTrackCount', on_track_count,
        'behindCount', behind_count,
        'noDataCount', no_data_count
      ) order by period), '[]'::jsonb)
      from roi_trend
    ),
    'lineRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(lr.value, al.line_label, 'Unassigned'),
          'label', coalesce(lr.label, al.line_label, 'Unassigned'),
          'line', coalesce(lr.label, al.line_label, 'Unassigned'),
          'requestCount', coalesce(lr.request_count, 0),
          'customerCount', coalesce(lr.customer_count, 0),
          'pharmacyCount', coalesce(lr.pharmacy_count, 0),
          'marketingCost', coalesce(lr.marketing_cost, 0),
          'requiredRoiValue', coalesce(lr.required_roi_value, 0),
          'expectedRoiValue', coalesce(lr.expected_roi_value, 0),
          'actualSalesValue', coalesce(al.actual_sales_value, 0),
          'actualSalesUnits', coalesce(al.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(lr.required_roi_value, 0) - coalesce(al.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(lr.required_roi_value, 0) > 0 then coalesce(al.actual_sales_value, 0) / lr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(lr.on_track_requests, 0),
          'behindRequests', coalesce(lr.behind_requests, 0),
          'noDataRequests', coalesce(lr.no_data_requests, 0),
          'exactSalesRows', coalesce(lr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(lr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(lr.required_roi_value, 0) - coalesce(al.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(lr.marketing_cost, 0) as marketing_cost
        from line_request_report lr
        full join actuals_by_line al on lower(btrim(al.line_label)) = lower(btrim(lr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'productRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(pr.value, ap.product_code, 'Unassigned'),
          'label', coalesce(pr.label, ap.product_name, 'Unassigned'),
          'line', coalesce(pr.line_label, ap.line_label, 'Unassigned'),
          'requestCount', coalesce(pr.request_count, 0),
          'customerCount', coalesce(pr.customer_count, 0),
          'pharmacyCount', coalesce(pr.pharmacy_count, 0),
          'marketingCost', coalesce(pr.marketing_cost, 0),
          'requiredRoiValue', coalesce(pr.required_roi_value, 0),
          'expectedRoiValue', coalesce(pr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ap.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ap.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(pr.required_roi_value, 0) - coalesce(ap.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(pr.required_roi_value, 0) > 0 then coalesce(ap.actual_sales_value, 0) / pr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(pr.on_track_requests, 0),
          'behindRequests', coalesce(pr.behind_requests, 0),
          'noDataRequests', coalesce(pr.no_data_requests, 0),
          'exactSalesRows', coalesce(pr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(pr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(pr.required_roi_value, 0) - coalesce(ap.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(pr.marketing_cost, 0) as marketing_cost
        from product_request_report pr
        full join actuals_by_product ap on upper(btrim(ap.product_code)) = upper(btrim(pr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'regionRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(rr.value, ar.region_code, 'Unassigned'),
          'label', coalesce(rr.label, ar.region_name, 'Unassigned'),
          'requestCount', coalesce(rr.request_count, 0),
          'customerCount', coalesce(rr.customer_count, 0),
          'pharmacyCount', coalesce(rr.pharmacy_count, 0),
          'marketingCost', coalesce(rr.marketing_cost, 0),
          'requiredRoiValue', coalesce(rr.required_roi_value, 0),
          'expectedRoiValue', coalesce(rr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ar.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ar.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(rr.required_roi_value, 0) - coalesce(ar.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(rr.required_roi_value, 0) > 0 then coalesce(ar.actual_sales_value, 0) / rr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(rr.on_track_requests, 0),
          'behindRequests', coalesce(rr.behind_requests, 0),
          'noDataRequests', coalesce(rr.no_data_requests, 0),
          'exactSalesRows', coalesce(rr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(rr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(rr.required_roi_value, 0) - coalesce(ar.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(rr.marketing_cost, 0) as marketing_cost
        from region_request_report rr
        full join actuals_by_region ar on lower(btrim(ar.region_code)) = lower(btrim(rr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'distributorRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(dr.value, ad.distributor_code, 'Unassigned'),
          'label', coalesce(dr.label, ad.distributor_name, 'Unassigned'),
          'requestCount', coalesce(dr.request_count, 0),
          'customerCount', coalesce(dr.customer_count, 0),
          'pharmacyCount', coalesce(dr.pharmacy_count, 0),
          'marketingCost', coalesce(dr.marketing_cost, 0),
          'requiredRoiValue', coalesce(dr.required_roi_value, 0),
          'expectedRoiValue', coalesce(dr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ad.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ad.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(dr.required_roi_value, 0) - coalesce(ad.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(dr.required_roi_value, 0) > 0 then coalesce(ad.actual_sales_value, 0) / dr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(dr.on_track_requests, 0),
          'behindRequests', coalesce(dr.behind_requests, 0),
          'noDataRequests', coalesce(dr.no_data_requests, 0),
          'exactSalesRows', coalesce(dr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(dr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(dr.required_roi_value, 0) - coalesce(ad.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(dr.marketing_cost, 0) as marketing_cost
        from distributor_request_report dr
        full join actuals_by_distributor ad on upper(btrim(ad.distributor_code)) = upper(btrim(dr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'requestReport', (
      select coalesce(jsonb_agg(row_json order by risk_rank asc, coverage_gap desc, estimated_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', id,
          'requestCode', request_code,
          'status', status,
          'payDate', pay_date,
          'payMonth', pay_month,
          'roiDurationMonths', roi_duration_months,
          'customerName', customer_name,
          'customerCode', customer_code,
          'line', line_label,
          'estimatedCost', estimated_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualSalesUnits', actual_sales_units,
          'actualRoiCoverage', actual_coverage_ratio,
          'coverageGap', coverage_gap,
          'expectedGap', expected_gap,
          'actualRoiStatus', actual_roi_status,
          'attributionQuality', attribution_quality,
          'recommendedAction', recommended_action,
          'exactSalesRows', exact_sales_rows,
          'fallbackSalesRows', fallback_sales_rows,
          'salesRows', sales_rows
        ) as row_json,
        case actual_roi_status when 'no_data' then 0 when 'behind' then 1 else 2 end as risk_rank,
        coverage_gap,
        estimated_cost
        from request_rows
        order by risk_rank asc, coverage_gap desc, estimated_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'customerImpact', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, actual_sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(cr.value, ac.value, 'Unassigned'),
          'label', coalesce(cr.label, ac.label, 'Unassigned'),
          'distributorCode', coalesce(cr.distributor_code, ac.distributor_code),
          'distributorName', coalesce(cr.distributor_name, ac.distributor_name),
          'regionName', coalesce(cr.region_name, ac.region_name),
          'requestCount', coalesce(cr.request_count, 0),
          'customerCount', coalesce(cr.customer_count, 0),
          'pharmacyCount', coalesce(cr.pharmacy_count, 0),
          'marketingCost', coalesce(cr.marketing_cost, 0),
          'requiredRoiValue', coalesce(cr.required_roi_value, 0),
          'expectedRoiValue', coalesce(cr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ac.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ac.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(cr.required_roi_value, 0) - coalesce(ac.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(cr.required_roi_value, 0) > 0 then coalesce(ac.actual_sales_value, 0) / cr.required_roi_value else 0 end,
          'salesRows', coalesce(ac.sales_rows, 0),
          'exactSalesRows', coalesce(ac.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(ac.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(cr.required_roi_value, 0) - coalesce(ac.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(ac.actual_sales_value, 0) as actual_sales_value
        from customer_request_report cr
        full join actuals_by_customer ac on ac.value = cr.value
        order by coverage_gap desc, actual_sales_value desc
        limit (select row_limit from params)
      ) rows
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.phx_refresh_marketing_roi_facts(p_batch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_run_id uuid; v_lock_key bigint := abs(hashtext('marketing_roi_refresh')::bigint);
  v_affected_periods text[] := '{}'; v_affected_ids uuid[] := '{}'; v_source_batch_ids uuid[] := '{}';
  v_min_period text; v_max_period text;
  v_cnt_requests bigint := 0; v_cnt_trends bigint := 0; v_cnt_lines bigint := 0; v_cnt_products bigint := 0;
  v_cnt_regions bigint := 0; v_cnt_distributors bigint := 0; v_cnt_customers bigint := 0; v_cnt_request_geo bigint := 0;
begin
  if not pg_try_advisory_xact_lock(v_lock_key) then
    insert into marketing_roi_refresh_runs (triggered_by, trigger_batch_id, status, calculation_version)
    values (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end, p_batch_id, 'skipped', '3')
    returning id into v_run_id;
    return jsonb_build_object('status', 'skipped', 'runId', v_run_id);
  end if;
  insert into marketing_roi_refresh_runs (triggered_by, trigger_batch_id, status, calculation_version)
  values (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end, p_batch_id, 'running', '3')
  returning id into v_run_id;
  begin
    if p_batch_id is not null then
      select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}'), min(invoice_period), max(invoice_period)
      into v_affected_periods, v_min_period, v_max_period
      from source_of_sales_import_rows where batch_id = p_batch_id and validation_state = 'valid';
      v_source_batch_ids := array[p_batch_id];
      if v_min_period is not null then
        select coalesce(array_agg(mr.id), '{}') into v_affected_ids from marketing_requests mr
        where mr.pay_date is not null
          and to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') <= v_max_period
          and to_char(date_trunc('month', mr.pay_date) + make_interval(months => greatest(coalesce(mr.roi_duration_months,1),1) - 1), 'YYYY-MM') >= v_min_period;
      end if;
    else
      select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}') into v_affected_periods
      from source_of_sales_import_rows where validation_state = 'valid';
      select coalesce(array_agg(distinct id), '{}') into v_source_batch_ids from source_of_sales_import_batches where status = 'validated';
      select coalesce(array_agg(mr.id), '{}') into v_affected_ids from marketing_requests mr where mr.pay_date is not null;
    end if;
    if coalesce(array_length(v_affected_ids, 1), 0) = 0 then
      update marketing_roi_refresh_runs set status = 'success', finished_at = now(), affected_periods = v_affected_periods,
        row_counts = '{"requests":0,"trends":0,"lines":0,"products":0,"regions":0,"distributors":0,"customers":0,"requestGeo":0}'::jsonb
      where id = v_run_id;
      return jsonb_build_object('status','success','runId',v_run_id,'affectedRequests',0);
    end if;
    delete from marketing_roi_request_facts where request_id = any(v_affected_ids);
    delete from marketing_roi_request_geo_facts where request_id = any(v_affected_ids);
    delete from marketing_roi_trend_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_line_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_product_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_region_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_distributor_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_customer_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    with
    req_raw as materialized (
      select mr.id, mr.request_code, mr.pay_date, to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') as pay_month,
        greatest(coalesce(mr.roi_duration_months,1),1) as roi_duration_months,
        coalesce(mr.estimated_cost, 0)::numeric as estimated_cost,
        coalesce(mr.required_roi_value, coalesce(mr.estimated_cost,0)*10)::numeric as required_roi_value,
        coalesce(mr.expected_roi_value, 0)::numeric as expected_roi_value, mr.customer_id,
        coalesce(l.name, 'Unassigned') as request_line, coalesce(mc.display_name, mr.customer_id::text) as customer_name,
        mc.customer_code, mr.status as request_status, coalesce(mr.track_direct_sales, false) as track_direct_sales
      from marketing_requests mr
      left join employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
      left join lines l on l.id = coalesce(mr.line_id, emp_req.line_id)
      left join marketing_customers mc on mc.id = mr.customer_id
      where mr.id = any(v_affected_ids)
    ),
    req_products_all as materialized (
      select distinct mrp.request_id, upper(btrim(sp.product_code)) as product_code,
        coalesce(sp.product_name, mp.product_name, mrp.product_name_snapshot) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(mp.line),''), nullif(btrim(mrp.line_snapshot),''), 'Unassigned') as line_label,
        coalesce(mrp.expected_value, 0)::numeric as expected_value, coalesce(mrp.value_share, 0)::numeric as value_share
      from marketing_request_products mrp join marketing_products mp on mp.id = mrp.product_id
      left join source_of_sales_products sp on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
      where mrp.request_id in (select id from req_raw)
    ),
    req_targets_all as materialized (
      select distinct mrph.request_id, sd.distributor_code,
        coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
        sd.distributor_code as family_code, mpdc.normalized_pharmacy_code as customer_code,
        mph.id as pharmacy_id, coalesce(mph.display_name, mpdc.normalized_pharmacy_code) as pharmacy_name,
        cm.brick_id, cm.region_code, cm.area_code
      from marketing_request_pharmacies mrph
      join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
      join marketing_distributors md on md.id = mpdc.distributor_id
      join marketing_pharmacies mph on mph.id = mrph.pharmacy_id
      join (select distinct marketing_normalized_name, parent_distributor_code from marketing_roi_distributor_rollup) ru on ru.marketing_normalized_name = md.normalized_name
      join source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
      left join lateral (
        select cmx.brick_id, cmx.region_code, cmx.area_code from source_of_sales_customer_map cmx
        where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g'))) = mpdc.normalized_pharmacy_code
          and cmx.active
          and (cmx.distributor_code = sd.distributor_code or exists (select 1 from marketing_roi_distributor_rollup rcm where rcm.parent_distributor_code = sd.distributor_code and rcm.sos_distributor_code = cmx.distributor_code))
        order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last limit 1
      ) cm on true
      where mrph.request_id in (select id from req_raw) and coalesce(btrim(mpdc.normalized_pharmacy_code),'') <> '' and coalesce(mpdc.active, true)
    ),
    req as materialized (
      select rr.*, coalesce(nullif(btrim(rr.request_line),''), (select max(rpa.line_label) from req_products_all rpa where rpa.request_id = rr.id), 'Unassigned') as line_label
      from req_raw rr
    ),
    req_products as materialized (select rpa.* from req_products_all rpa join req on req.id = rpa.request_id),
    req_targets as materialized (select rta.* from req_targets_all rta join req on req.id = rta.request_id),
    product_rollups as (
      select request_id, count(*)::numeric as product_count, coalesce(sum(nullif(value_share,0)),0)::numeric as value_share_total, coalesce(sum(expected_value),0)::numeric as expected_total
      from req_products group by request_id
    ),
    request_product_allocations as materialized (
      select rp.request_id, rp.product_code, rp.product_name, rp.line_label, rp.expected_value, rp.value_share,
        case when pr.value_share_total > 0 then rp.value_share / pr.value_share_total
             when pr.expected_total > 0 then rp.expected_value / pr.expected_total
             when pr.product_count > 0 then 1 / pr.product_count else 0 end as share
      from req_products rp join product_rollups pr on pr.request_id = rp.request_id
    ),
    target_rollups as (select request_id, count(*)::numeric as target_count from req_targets group by request_id),
    request_target_allocations as materialized (
      select rt.*, case when tr.target_count > 0 then 1 / tr.target_count else 0 end as share
      from req_targets rt join target_rollups tr on tr.request_id = rt.request_id
    ),
    periods as materialized (
      select req.id, array_agg(to_char(g,'YYYY-MM')) as periods from req
      cross join lateral generate_series(date_trunc('month', req.pay_date), date_trunc('month', req.pay_date) + make_interval(months => req.roi_duration_months - 1), interval '1 month') as g
      group by req.id
    ),
    target_products as materialized (
      select distinct rt.request_id, rt.distributor_code, rt.customer_code, rt.brick_id, rpa.product_code
      from req_targets rt join request_product_allocations rpa on rpa.request_id = rt.request_id where rpa.product_code is not null
    ),
    exact_hits as materialized (
      select distinct tp.request_id, r.id::text as row_id, tp.distributor_code,
        coalesce(sd.distributor_name, tp.distributor_code) as distributor_name,
        lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g'))) as client_code,
        nullif(btrim(r.client_name),'') as client_name, r.region_code,
        coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
        nullif(btrim(r.brick_id),'') as brick_id, upper(btrim(r.product_code)) as product_code,
        coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(r.official_line),''), 'Unassigned') as line_label,
        coalesce(r.qty,0)::numeric as units,
        (case when coalesce(r.is_direct, false) then coalesce(r.value, 0) else coalesce(r.qty,0) * coalesce(public.phx_factory_price(r.product_code, r.invoice_period),0) end)::numeric as sales_value,
        'exact'::text as match_type
      from target_products tp
      join periods on periods.id = tp.request_id
      join marketing_roi_distributor_rollup rr_exact on rr_exact.parent_distributor_code = tp.distributor_code
      join source_of_sales_import_rows r on r.distributor_code = rr_exact.sos_distributor_code
       and lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g'))) = tp.customer_code
       and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
       and r.invoice_period = any(periods.periods) and r.validation_state = 'valid'
      join source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
      join source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
      left join source_of_sales_distributors sd on sd.distributor_code = tp.distributor_code
      left join source_of_sales_regions sr on sr.region_code = r.region_code
    ),
    direct_hits as materialized (
      select distinct req.id as request_id, dor.id::text as row_id, md.distributor_code as distributor_code,
        coalesce(md.display_name, md.distributor_code) as distributor_name,
        lower(btrim(regexp_replace(coalesce(dopdc.customer_code,''),'\s+',' ','g'))) as client_code,
        nullif(btrim(dph.pharmacy_name),'') as client_name, dopdc.mapped_region_code as region_code,
        coalesce(sr.region_name, dopdc.mapped_region_code) as region_name,
        nullif(btrim(dopdc.mapped_brick_id),'') as brick_id, upper(btrim(dor.product_code)) as product_code,
        coalesce(sp.product_name, dor.product_name, dor.product_code) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(dor.line),''), 'Unassigned') as line_label,
        coalesce(dor.qty,0)::numeric as units, coalesce(dor.sales_value,0)::numeric as sales_value, 'direct'::text as match_type
      from req
      join periods on periods.id = req.id
      join req_products rp on rp.request_id = req.id
      join marketing_request_pharmacies mrph on mrph.request_id = req.id
      join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id and coalesce(mpdc.active, true)
      join marketing_distributors md on md.id = mpdc.distributor_id
      join direct_order_pharmacy_distributor_codes dopdc
        on lower(btrim(dopdc.distributor_code)) = lower(btrim(md.distributor_code))
       and lower(btrim(regexp_replace(coalesce(dopdc.customer_code,''),'\s+',' ','g'))) = lower(btrim(regexp_replace(coalesce(mpdc.normalized_pharmacy_code,''),'\s+',' ','g')))
      join direct_order_pharmacies dph on dph.id = dopdc.pharmacy_id
      join direct_order_requests dor on dor.pharmacy_id = dopdc.pharmacy_id and dor.status = 'approved' and dor.reversal_of_request_id is null
       and dor.sales_month = any(periods.periods) and upper(btrim(dor.product_code)) = upper(btrim(rp.product_code))
      left join source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(dor.product_code))
      left join source_of_sales_regions sr on sr.region_code = dopdc.mapped_region_code
      where req.track_direct_sales = true
    ),
    all_hits as materialized (select * from exact_hits union all select * from direct_hits),
    actuals as materialized (
      select request_id, coalesce(sum(sales_value),0)::numeric as actual_value, coalesce(sum(units),0)::numeric as actual_units,
        count(distinct row_id)::integer as sales_rows,
        count(distinct row_id) filter (where match_type='exact')::integer as exact_sales_rows,
        count(distinct row_id) filter (where match_type='fallback')::integer as fallback_sales_rows
      from all_hits group by request_id
    ),
    request_rows_base as materialized (
      select req.id, req.request_code, req.pay_month, req.roi_duration_months, req.estimated_cost, req.required_roi_value,
        req.expected_roi_value, req.customer_id, req.customer_name, req.customer_code, req.line_label, req.request_status,
        coalesce(a.actual_value, 0)::numeric as actual_sales_value, coalesce(a.actual_units, 0)::numeric as actual_sales_units,
        coalesce(a.sales_rows, 0)::integer as sales_rows, coalesce(a.exact_sales_rows, 0)::integer as exact_sales_rows,
        coalesce(a.fallback_sales_rows, 0)::integer as fallback_sales_rows,
        case when coalesce(a.sales_rows,0) = 0 then 'no_sales' else 'exact_customer' end as attribution_quality,
        case when coalesce(a.sales_rows,0) = 0 then 'no_data' when coalesce(a.actual_value,0) >= req.required_roi_value then 'on_track' else 'behind' end as actual_roi_status,
        case when req.required_roi_value > 0 then coalesce(a.actual_value,0) / req.required_roi_value when coalesce(a.actual_value,0) > 0 then 1 else 0 end as actual_coverage_ratio,
        greatest(req.required_roi_value - coalesce(a.actual_value,0), 0)::numeric as coverage_gap,
        greatest(req.expected_roi_value - coalesce(a.actual_value,0), 0)::numeric as expected_gap
      from req left join actuals a on a.request_id = req.id
    ),
    request_rows as materialized (
      select rrb.*, case when rrb.actual_roi_status = 'on_track' then 'monitor' when rrb.attribution_quality = 'no_sales' then 'mapping_review'
        when rrb.actual_coverage_ratio < 0.5 and rrb.coverage_gap > 0 then 'high_risk_gap' else 'follow_up' end as recommended_action
      from request_rows_base rrb
    ),
    request_rows_approved as materialized (select * from request_rows where request_status in ('approved','active','roi_tracking','closed','finance_hold')),
    actuals_by_line as (select rr.pay_month, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.line_label),
    actuals_by_product as (select rr.pay_month, ah.product_code, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.product_code),
    actuals_by_region as (select rr.pay_month, ah.region_code, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id where ah.region_code is not null group by rr.pay_month, ah.region_code, ah.line_label),
    actuals_by_distributor as (select rr.pay_month, ah.distributor_code, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.distributor_code, ah.line_label),
    actuals_by_customer_dist as (select rr.pay_month, rr.customer_id, ah.distributor_code, sum(ah.sales_value)::numeric as actual_sales_value, sum(ah.units)::numeric as actual_sales_units from all_hits ah join request_rows_approved rr on rr.id = ah.request_id where rr.customer_id is not null group by rr.pay_month, rr.customer_id, ah.distributor_code),
    actuals_by_request_geo as (select ah.request_id, ah.distributor_code, ah.region_code, sum(ah.sales_value)::numeric as actual_sales_value, sum(ah.units)::numeric as actual_sales_units, count(distinct ah.row_id)::integer as sales_rows from all_hits ah group by ah.request_id, ah.distributor_code, ah.region_code),
    ins_requests as (
      insert into marketing_roi_request_facts (refresh_run_id, request_id, request_code, pay_month, line_label, customer_id, customer_name, customer_code, estimated_cost, required_roi_value, expected_roi_value, actual_sales_value, actual_sales_units, sales_rows, exact_sales_rows, fallback_sales_rows, attribution_quality, actual_roi_status, actual_coverage_ratio, coverage_gap, expected_gap, recommended_action, source_batch_ids, source_periods, calculation_version, request_status)
      select v_run_id, rr.id, rr.request_code, rr.pay_month, rr.line_label, rr.customer_id, rr.customer_name, rr.customer_code, rr.estimated_cost, rr.required_roi_value, rr.expected_roi_value, rr.actual_sales_value, rr.actual_sales_units, rr.sales_rows, rr.exact_sales_rows, rr.fallback_sales_rows, rr.attribution_quality, rr.actual_roi_status, rr.actual_coverage_ratio, rr.coverage_gap, rr.expected_gap, rr.recommended_action, v_source_batch_ids, p.periods, '3', rr.request_status
      from request_rows rr left join periods p on p.id = rr.id returning 1
    ),
    ins_request_geo as (
      insert into marketing_roi_request_geo_facts (refresh_run_id, request_id, distributor_code, region_code, actual_sales_value, actual_sales_units, sales_rows, calculation_version)
      select v_run_id, abrg.request_id, abrg.distributor_code, abrg.region_code, abrg.actual_sales_value, abrg.actual_sales_units, abrg.sales_rows, '3' from actuals_by_request_geo abrg returning 1
    ),
    ins_trends as (
      insert into marketing_roi_trend_facts (refresh_run_id, period, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, pay_month, count(*)::integer, sum(estimated_cost)::numeric, sum(required_roi_value)::numeric, sum(expected_roi_value)::numeric, sum(actual_sales_value)::numeric, sum(coverage_gap)::numeric, count(*) filter (where actual_roi_status='on_track')::integer, count(*) filter (where actual_roi_status='behind')::integer, count(*) filter (where actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved group by pay_month returning 1
    ),
    ins_lines as (
      insert into marketing_roi_line_facts (refresh_run_id, period, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rpa.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rpa.share)::numeric, sum(rr.required_roi_value * rpa.share)::numeric, sum(rr.expected_roi_value * rpa.share)::numeric, max(coalesce(abl.actual_sales_value, 0)), sum(rr.coverage_gap * rpa.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_product_allocations rpa on rpa.request_id = rr.id left join actuals_by_line abl on abl.line_label = rpa.line_label and abl.pay_month = rr.pay_month group by rr.pay_month, rpa.line_label returning 1
    ),
    ins_products as (
      insert into marketing_roi_product_facts (refresh_run_id, period, product_code, product_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, actual_sales_units, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rpa.product_code, max(rpa.product_name), max(rpa.line_label), count(distinct rr.id)::integer, sum(rr.estimated_cost * rpa.share)::numeric, sum(rr.required_roi_value * rpa.share)::numeric, sum(rr.expected_roi_value * rpa.share)::numeric, max(coalesce(abp.actual_sales_value, 0)), coalesce(sum(rr.actual_sales_units * rpa.share), 0)::numeric, sum(rr.coverage_gap * rpa.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_product_allocations rpa on rpa.request_id = rr.id left join actuals_by_product abp on abp.product_code = rpa.product_code and abp.pay_month = rr.pay_month where rpa.product_code is not null group by rr.pay_month, rpa.product_code returning 1
    ),
    ins_regions as (
      insert into marketing_roi_region_facts (refresh_run_id, period, region_code, region_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, coalesce(rta.region_code, 'Unassigned'), max(coalesce(sr.region_name, rta.region_code, 'Unassigned')), rr.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, sum(rr.expected_roi_value * rta.share)::numeric, max(coalesce(abr.actual_sales_value, 0)), sum(rr.coverage_gap * rta.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join source_of_sales_regions sr on sr.region_code = rta.region_code left join actuals_by_region abr on abr.region_code = rta.region_code and abr.pay_month = rr.pay_month and abr.line_label = rr.line_label group by rr.pay_month, coalesce(rta.region_code, 'Unassigned'), rr.line_label returning 1
    ),
    ins_distributors as (
      insert into marketing_roi_distributor_facts (refresh_run_id, period, distributor_code, family_code, distributor_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rta.distributor_code, rta.family_code, max(rta.distributor_name), rr.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, sum(rr.expected_roi_value * rta.share)::numeric, max(coalesce(abd.actual_sales_value, 0)), sum(rr.coverage_gap * rta.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join actuals_by_distributor abd on abd.distributor_code = rta.distributor_code and abd.pay_month = rr.pay_month and abd.line_label = rr.line_label group by rr.pay_month, rta.distributor_code, rta.family_code, rr.line_label returning 1
    ),
    ins_customers as (
      insert into marketing_roi_customer_facts (refresh_run_id, period, customer_id, customer_code, customer_name, distributor_code, family_code, request_count, marketing_cost, required_roi_value, actual_sales_value, actual_sales_units, exact_sales_rows, fallback_sales_rows, attribution_quality, actual_roi_status, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rr.customer_id, max(rr.customer_code), max(rr.customer_name), rta.distributor_code, max(rta.family_code), count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, max(coalesce(acbd.actual_sales_value, 0)), max(coalesce(acbd.actual_sales_units, 0)), sum(rr.exact_sales_rows)::integer, sum(rr.fallback_sales_rows)::integer, case when bool_or(rr.attribution_quality = 'no_sales') then 'no_sales' else 'exact_customer' end, case when bool_or(rr.actual_roi_status = 'no_data') then 'no_data' when bool_or(rr.actual_roi_status = 'behind') then 'behind' else 'on_track' end, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join actuals_by_customer_dist acbd on acbd.customer_id = rr.customer_id and acbd.distributor_code = rta.distributor_code and acbd.pay_month = rr.pay_month where rr.customer_id is not null group by rr.pay_month, rr.customer_id, rta.distributor_code returning 1
    )
    select (select count(*) from ins_requests)::bigint, (select count(*) from ins_trends)::bigint, (select count(*) from ins_lines)::bigint, (select count(*) from ins_products)::bigint, (select count(*) from ins_regions)::bigint, (select count(*) from ins_distributors)::bigint, (select count(*) from ins_customers)::bigint, (select count(*) from ins_request_geo)::bigint
    into v_cnt_requests, v_cnt_trends, v_cnt_lines, v_cnt_products, v_cnt_regions, v_cnt_distributors, v_cnt_customers, v_cnt_request_geo;
    update marketing_roi_refresh_runs set status = 'success', finished_at = now(), affected_periods = v_affected_periods,
      row_counts = jsonb_build_object('requests', v_cnt_requests, 'trends', v_cnt_trends, 'lines', v_cnt_lines, 'products', v_cnt_products, 'regions', v_cnt_regions, 'distributors', v_cnt_distributors, 'customers', v_cnt_customers, 'requestGeo', v_cnt_request_geo)
    where id = v_run_id;
    return jsonb_build_object('status', 'success', 'runId', v_run_id, 'affectedRequests', v_cnt_requests, 'rowCounts', jsonb_build_object('requests', v_cnt_requests, 'trends', v_cnt_trends, 'lines', v_cnt_lines, 'products', v_cnt_products, 'regions', v_cnt_regions, 'distributors', v_cnt_distributors, 'customers', v_cnt_customers, 'requestGeo', v_cnt_request_geo));
  exception when others then
    update marketing_roi_refresh_runs set status = 'failed', finished_at = now(), error = sqlerrm, affected_periods = v_affected_periods where id = v_run_id;
    raise;
  end;
end;
$function$;

-- ── Grants, restated exactly as they already stand ──────────────────────────────────────────
-- CREATE OR REPLACE preserves a function's ACL, so none of this changes who may call what: every
-- one of these already reads `postgres=X/postgres | service_role=X/postgres` on production, and
-- the closing matrix additionally carries analytics_readonly. They are restated because the
-- required `validate` job reads the FILE, and a file that replaces a public SECURITY DEFINER
-- function without a visible revoke-from-PUBLIC cannot be told apart from one that creates a new
-- function and leaves it callable with the anon key.
revoke execute on function public.phx_monthly_closing_matrix(p_line text, p_period text) from public, anon, authenticated;
grant  execute on function public.phx_monthly_closing_matrix(p_line text, p_period text) to service_role;
grant  execute on function public.phx_monthly_closing_matrix(p_line text, p_period text) to analytics_readonly;
revoke execute on function public.phx_closing_brick(p_line text, p_period text) from public, anon, authenticated;
grant  execute on function public.phx_closing_brick(p_line text, p_period text) to service_role;
revoke execute on function public.phx_closing_channel_breakdown(p_line text, p_period text, p_store_stems text[], p_hospital_stems text[], p_exclude_codes text[], p_pharmacy_override_codes text[], p_store_override_codes text[], p_rule jsonb) from public, anon, authenticated;
grant  execute on function public.phx_closing_channel_breakdown(p_line text, p_period text, p_store_stems text[], p_hospital_stems text[], p_exclude_codes text[], p_pharmacy_override_codes text[], p_store_override_codes text[], p_rule jsonb) to service_role;
revoke execute on function public.phx_closing_corrections(p_period text) from public, anon, authenticated;
grant  execute on function public.phx_closing_corrections(p_period text) to service_role;
revoke execute on function public.phx_closing_customers(p_line text, p_period text) from public, anon, authenticated;
grant  execute on function public.phx_closing_customers(p_line text, p_period text) to service_role;
revoke execute on function public.phx_closing_distributor_product(p_line text, p_period text) from public, anon, authenticated;
grant  execute on function public.phx_closing_distributor_product(p_line text, p_period text) to service_role;
revoke execute on function public.phx_closing_publication_snapshot(p_line text, p_period text) from public, anon, authenticated;
grant  execute on function public.phx_closing_publication_snapshot(p_line text, p_period text) to service_role;
revoke execute on function public.phx_lock_monthly_closing(p_line text, p_period text, p_actor text) from public, anon, authenticated;
grant  execute on function public.phx_lock_monthly_closing(p_line text, p_period text, p_actor text) to service_role;
revoke execute on function public.phx_exec_brick(p_period text, p_exclude_codes text[], p_lines text[], p_products text[], p_regions text[], p_areas text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_brick(p_period text, p_exclude_codes text[], p_lines text[], p_products text[], p_regions text[], p_areas text[]) to service_role;
revoke execute on function public.phx_exec_customers(p_period text, p_exclude_codes text[], p_lines text[], p_products text[], p_regions text[], p_areas text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_customers(p_period text, p_exclude_codes text[], p_lines text[], p_products text[], p_regions text[], p_areas text[]) to service_role;
revoke execute on function public.phx_exec_distributor_product(p_period text, p_lines text[], p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_exclude_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_distributor_product(p_period text, p_lines text[], p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_exclude_codes text[]) to service_role;
revoke execute on function public.phx_exec_sos_trend(p_periods text[], p_lines text[], p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_exclude_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_sos_trend(p_periods text[], p_lines text[], p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_exclude_codes text[]) to service_role;
revoke execute on function public.phx_customer_directory(p_region_codes text[], p_area_codes text[], p_brick_codes text[], p_distributor_codes text[], p_from_period text, p_to_period text, p_exclude_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_customer_directory(p_region_codes text[], p_area_codes text[], p_brick_codes text[], p_distributor_codes text[], p_from_period text, p_to_period text, p_exclude_codes text[]) to service_role;
revoke execute on function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text, p_to_period text, p_exclude_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text, p_to_period text, p_exclude_codes text[]) to service_role;
revoke execute on function public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[]) from public, anon, authenticated;
grant  execute on function public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[]) to service_role;
revoke execute on function public.phx_sales_channels_by_rep(p_store_stems text[], p_hospital_stems text[], p_excluded_product_codes text[], p_period text, p_store_override_keys text[], p_pharmacy_override_codes text[], p_rule jsonb) from public, anon, authenticated;
grant  execute on function public.phx_sales_channels_by_rep(p_store_stems text[], p_hospital_stems text[], p_excluded_product_codes text[], p_period text, p_store_override_keys text[], p_pharmacy_override_codes text[], p_rule jsonb) to service_role;
revoke execute on function public.phx_refresh_sos_channel_rollup(p_batch_id uuid) from public, anon, authenticated;
grant  execute on function public.phx_refresh_sos_channel_rollup(p_batch_id uuid) to service_role;
revoke execute on function public.phx_market_awareness_tracking(p_line_code text, p_from_period text, p_to_period text, p_area_code text, p_brick_ids text[], p_product_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_market_awareness_tracking(p_line_code text, p_from_period text, p_to_period text, p_area_code text, p_brick_ids text[], p_product_codes text[]) to service_role;
revoke execute on function public.phx_marketing_roi_customer_dashboard(p_lines text[], p_regions text[], p_distributor_codes text[], p_product_codes text[], p_roi_statuses text[], p_attribution_qualities text[], p_customer_search text, p_from_month text, p_to_month text, p_limit integer, p_exclude_codes text[]) from public, anon, authenticated;
grant  execute on function public.phx_marketing_roi_customer_dashboard(p_lines text[], p_regions text[], p_distributor_codes text[], p_product_codes text[], p_roi_statuses text[], p_attribution_qualities text[], p_customer_search text, p_from_month text, p_to_month text, p_limit integer, p_exclude_codes text[]) to service_role;
revoke execute on function public.phx_refresh_marketing_roi_facts(p_batch_id uuid) from public, anon, authenticated;
grant  execute on function public.phx_refresh_marketing_roi_facts(p_batch_id uuid) to service_role;

commit;
