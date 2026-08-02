-- au.f_monthly_attribution applies au.direct_region_allocation to area-less Direct rows.
--
-- Branch B2 (Direct that carries a region but no area) previously emitted one row per
-- (line, region, product) and stopped there. When the sheet's region is ambiguous — Anti
-- Infective 'UE', which the seat model splits into UE-1 and UE-2 — that row reached no DM,
-- because 'UE' is not a region any DM seat is mapped to.
--
-- Now the branch LEFT JOINs the allocation table and fans the row out across its target regions
-- by share. Nothing else in the function changes.
--
-- Once the row emerges tagged UE-1 / UE-2, au.f_monthly_achievement's existing region_dm lookup
-- resolves it to the DM with no further change — those regions already exist in au.line_area_map.
--
-- CONSERVATION, by construction:
--   share = weight / sum(weight) over (line_code, sos_region_code)
-- so the shares within a group always sum to exactly 1 and the fanned rows reproduce the
-- original value. A (line, region) with no allocation row LEFT JOINs to NULL, coalesce(share,1)
-- makes it a single unchanged row, and the branch behaves exactly as before — so CNS, Pedia and
-- every non-'UE' region are provably untouched.
--
-- NOTE the value basis is unchanged: Direct is still valued at direct_value (the sheet value),
-- never recomputed from factory price. Only the region label and the split differ.

begin;

create or replace function au.f_monthly_attribution(p_period text)
returns table(
  period text, channel text, line_code text, region_code text, area_code text,
  area_state text, is_other boolean, rep_seat_id text, rep_hr_id text,
  dm_seat_id text, dm_hr_id text, product_code text,
  sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text
)
language plpgsql
stable
security definer
set search_path to 'au', 'public'
as $function$
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
  ),
  -- Owner-set split of an ambiguous Direct region across the DM territories inside it.
  -- Normalised here so the weights in the table can be any positive scale.
  alloc as (
    select
      a.line_code,
      a.sos_region_code,
      a.target_region_code,
      a.weight / sum(a.weight) over (partition by a.line_code, a.sos_region_code) as share
    from au.direct_region_allocation a
  ),
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
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
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.effective_units * pr.factory_price),
    true,
    null::text
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where not pr.is_direct
    and pr.line_code is not null
    and pr.canonical_area_code is not null
  group by lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
           (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
           lam.dm_seat_id, lam.dm_occupant_hr_id, pr.product_code

  union all
  -- Branch B1: DIRECT sales that carry an area -> attribute to the (line, area) seat.
  select
    p_period,
    'direct'::text,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.direct_value),
    true,
    null::text
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where pr.is_direct
    and pr.line_code is not null
    and pr.canonical_area_code is not null
  group by lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
           (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
           lam.dm_seat_id, lam.dm_occupant_hr_id, pr.product_code

  union all
  -- Branch B2: DIRECT sales with NO area (or an area with no seat map) -> region level, no rep.
  -- Fanned across the allocation's target regions when one is configured for this
  -- (line, sos_region); emitted unchanged when it is not.
  select
    p_period,
    'direct'::text,
    pr.line_code,
    coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')),
    null, null, false,
    null, null, null, null,
    pr.product_code,
    sum(pr.total_qty    * coalesce(alloc.share, 1)),
    sum(pr.direct_value * coalesce(alloc.share, 1)),
    true,
    null::text
  from priced pr
  left join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  left join alloc
    on alloc.line_code = pr.line_code
   and alloc.sos_region_code = coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')
  where pr.is_direct
    and pr.line_code is not null
    and (pr.canonical_area_code is null or lam.line_code is null)
  group by pr.line_code,
           coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''),'NATIONAL')),
           pr.product_code

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
  left join lam_asof lam
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
$function$;

revoke execute on function au.f_monthly_attribution(text) from public, anon, authenticated;
grant execute on function au.f_monthly_attribution(text) to service_role;

commit;

notify pgrst, 'reload schema';
