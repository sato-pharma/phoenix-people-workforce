-- Phase 5: automatic monthly closing — SoS fact rollup attributed to the 42-area seat model.
-- Service-role only. Achievement % is out of scope (needs Phase 6 targets).

create or replace function au.f_monthly_attribution(p_period text)
returns table (
  period text,
  channel text,            -- 'indirect' | 'direct' | 'unmapped'
  line_code text,
  region_code text,
  area_code text,
  area_state text,
  is_other boolean,
  rep_seat_id text,
  rep_hr_id text,
  dm_seat_id text,
  dm_hr_id text,
  product_code text,
  sales_units numeric,
  sales_value numeric,
  mapped boolean,
  unmapped_reason text
)
language plpgsql
stable
security definer
set search_path to 'au','public'
as $$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with fact as (
    select
      f.official_line,
      f.region_code                              as sos_region_code,
      nullif(btrim(f.area_code), '')             as sos_area_code,
      upper(btrim(coalesce(f.product_code,'')))  as product_code,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  ),
  priced as (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(pp.factory_price, 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = fa.product_code
  )
  -- Branch A: indirect (distributor) sales mapped to a (line, area) seat.
  select
    p_period,
    'indirect'::text,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id,
    rep.occupant_hr_id,
    lam.dm_seat_id,
    dm.occupant_hr_id,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.effective_units * pr.factory_price),
    true,
    null::text
  from priced pr
  join au.line_area_map lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  left join lateral (
    select oh.occupant_hr_id
    from au.occupancy_history oh
    where oh.seat_id = lam.rep_seat_id
    order by
      (oh.effective_from <= v_period_end and (oh.effective_to is null or oh.effective_to > v_period_end)) desc,
      oh.effective_from asc
    limit 1
  ) rep on true
  left join lateral (
    select oh.occupant_hr_id
    from au.occupancy_history oh
    where oh.seat_id = lam.dm_seat_id
    order by
      (oh.effective_from <= v_period_end and (oh.effective_to is null or oh.effective_to > v_period_end)) desc,
      oh.effective_from asc
    limit 1
  ) dm on true
  where not pr.is_direct
    and pr.line_code is not null
    and pr.canonical_area_code is not null
  group by lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
           (lam.other_type is not null), lam.rep_seat_id, rep.occupant_hr_id,
           lam.dm_seat_id, dm.occupant_hr_id, pr.product_code

  union all
  -- Branch B: direct (company) sales — region level, no area/rep.
  select
    p_period,
    'direct'::text,
    pr.line_code,
    coalesce(nullif(pr.sos_region_code,''), 'NATIONAL'),
    null, null, false,
    null, null, null, null,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.direct_value),
    true,
    null::text
  from priced pr
  where pr.is_direct
    and pr.line_code is not null
  group by pr.line_code, coalesce(nullif(pr.sos_region_code,''),'NATIONAL'), pr.product_code

  union all
  -- Branch C: unmapped — Head Office line, blank area, or a (line,area) with no seat map.
  select
    p_period,
    'unmapped'::text,
    pr.line_code,
    null,
    pr.canonical_area_code,
    null, false,
    null, null, null, null,
    pr.product_code,
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
  left join au.line_area_map lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
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
$$;

revoke all on function au.f_monthly_attribution(text) from public, anon, authenticated;
grant execute on function au.f_monthly_attribution(text) to service_role;
