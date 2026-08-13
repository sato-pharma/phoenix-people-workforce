-- au.f_monthly_attribution: 461 ms -> 313 ms, output identical to the piastre.
--
-- This is the function PR #2099 measured but deliberately did not touch. It is 64% of
-- au.f_monthly_achievement, which au.f_sales_vs_target_range then calls once per month,
-- so it is the real cost behind the heaviest query the db-health cron reports.
--
-- WHAT WAS SLOW (from EXPLAIN ANALYZE on production, July 2026, 20,062 fact rows):
--   building the `priced` CTE                                  ~256 ms
--   branch 1: Sort of 19,677 rows across 10 GROUP BY keys       ~130 ms   <- avoidable
--   branch 1 aggregate                                           ~15 ms
--   branches 2/3/4 combined                                      ~24 ms
--
-- The sort existed because of a planner misestimate, the same class of bug as
-- 20260811000200: the join of `priced` to `lam_asof` estimated **145 rows where 19,677
-- came back (136x)**, so a GroupAggregate+Sort looked cheaper than a HashAggregate.
--
-- THE FIX, and why it is safe. The old shape joined every one of the 19,677 fact rows to
-- the seat map and THEN grouped down to 838 output rows. It now groups first and joins the
-- 838. That is only equivalent if (line_code, area_code) is unique in
-- au.f_line_area_map_asof -- otherwise the join would fan rows out and the sums would
-- differ. Verified across every period-end the data spans:
--   2026-01-31 .. 2026-08-31, all eight: 150 rows, 150 distinct keys, 0 duplicates, 0 nulls.
-- The GROUP BY also listed all nine lam columns, which (line_code, area_code) functionally
-- determine, so grouping on the two keys is the same partition.
--
-- Also trims `priced` from `fa.*` to the nine columns actually read downstream.
-- official_line and sos_area_code only ever fed the joins that produce line_code and
-- canonical_area_code, and nothing after `priced` references them -- carrying them into the
-- CTE tuplestore cost ~43 ms per call (356 ms -> 313 ms).
--
-- Branches 3 (direct spill to region) and 4 (unmapped) are UNCHANGED, byte for byte. They
-- cost 4 ms and 16 ms; there is nothing to win and they carry the fiddly attribution
-- semantics, so they were left exactly as they were.
--
-- ALSO TRIED AND REJECTED, so nobody repeats it: marking `fact` MATERIALIZED to stop the
-- expressions being recomputed. It is SLOWER -- 203 ms vs 188 ms -- because the tuplestore
-- round trip for 20k rows costs more than recomputing lower/btrim/upper. Measured, not
-- assumed.
--
-- PROOF OF EQUIVALENCE (run on production before this migration was applied, comparing the
-- old live function against the new body under a scratch name):
--   FULL OUTER JOIN on all 14 non-measure columns, across all 8 periods
--   rows compared    5,979
--   only in old          0
--   only in new          0
--   value mismatches     0
--   totals    871,112.169996 units / 70,001,594.19138270 EGP on BOTH sides
-- Downstream au.f_monthly_achievement was fingerprinted before and after: 6,698 rows,
-- md5 94b95b22fa85ffd00831ba50539fdd6f, unchanged.
--
-- The Office allocation golden rule is not touched. This migration changes the ORDER of
-- grouping and joining and the width of one CTE projection; every filter, every join
-- predicate, every sum and every emitted column is character-identical to the previous
-- definition.

create or replace function au.f_monthly_attribution(p_period text)
returns table(period text, channel text, line_code text, region_code text, area_code text,
  area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text,
  dm_hr_id text, product_code text, sales_units numeric, sales_value numeric,
  mapped boolean, unmapped_reason text)
language plpgsql stable parallel safe security definer
set search_path to 'au','public'
as $function$
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
  -- only the nine columns anything downstream actually reads
  priced as (
    select fa.sos_region_code, fa.product_code, fa.is_direct,
           fa.total_qty, fa.effective_units, fa.direct_value,
           lm.line_code, cw.canonical_area_code,
           coalesce(pp.factory_price,0) as factory_price
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
  -- group first, join the seat map to the 838 survivors instead of all 19,677 fact rows
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
