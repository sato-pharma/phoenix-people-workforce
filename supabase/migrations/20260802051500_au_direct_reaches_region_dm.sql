-- Direct sales reach their region's District Manager.
--
-- Owner ruling 2026-08-02, from a worked example: Anti Infective / July / Royafloxacin / Cairo
-- reads retail 201 and direct 200, and "direct should be calculated to dm total".
--
-- 20260801150000_au_direct_counts_toward_achievement.sql got Direct INTO achievement, but
-- deliberately stopped at the line: it grouped every Direct row as (line, NULL area, product) and
-- left the seat join keyed on area, so dm_hr_id stayed NULL and no District Manager was credited.
-- That reasoning is correct for REPS and wrong for DMs:
--
--   * Direct carries no brick and no area, so crediting a REP would be inventing an area split.
--     Unchanged here — rep_seat_id / rep_hr_id stay NULL for every Direct row.
--   * Direct DOES carry a REGION (measured on production 2026-07, Anti Infective / RO001:
--     CA 200u, D1 300u, UE 300u), and every (line, region) in au.line_area_map resolves to
--     exactly ONE dm_seat_id — verified across all 22 live line x region pairs, zero exceptions.
--     So region -> DM is an exact lookup, not an allocation rule.
--
--     CAVEAT, measured rather than assumed: the SoS sheet and the seat model do not share a
--     region vocabulary everywhere. Anti Infective splits Upper Egypt into UE-1 and UE-2 (two
--     DMs) while the Direct sheet tags a single 'UE', so that one pair has no unambiguous DM.
--     Across all 7 loaded periods it is the ONLY unresolved pair — 3,110 units / 208,652.40 EGP:
--
--       line             region   status              units      value
--       anti_infective   UE       NO DM (ambiguous)   3,110      208,652.40
--       (every other line x region pair resolves; ~6.04M EGP of Direct now reaches a DM)
--
--     Those rows keep dm_seat_id / dm_hr_id NULL here. Splitting them across UE-1 and UE-2 would
--     be inventing an allocation, which is the very thing this migration refuses to do for reps.
--     Pending an owner ruling, they stay at line level — visible, not silently reassigned.
--
-- Two things therefore change:
--
--  1. The actuals grouping carries the region for area-less rows. Without it, one line's Direct
--     collapses into a single (line, NULL, product) blob — July's Royafloxacin would fuse
--     CA 200 + D1 300 + UE 300 into 800 units that can never split back out to three different
--     DMs. The region is carried ONLY when area_code is null; an area row already reaches its DM
--     through the seat map, and carrying its region too would split it needlessly.
--
--  2. dm_seat_id / dm_hr_id fall back to the region's DM when the seat map has no area match.
--
-- What deliberately does NOT change:
--
--  * "Others" areas keep their own pseudo-DM. Owner ruling 2026-08-02 on Down town (CA5), which
--    is other_type = line_specific / carries_target = false for this line: "if it goes to others
--    then should be calculated with others but it laying under cairo" — the sales attribute to
--    the Others bucket while the area still displays under Cairo's geography. That already falls
--    out of the seat map (CA5 -> SEAT-AIF-OTHERS), so no special case is needed here. It is why
--    the Cairo DM's Royafloxacin total is 113 + 200 = 313, while the Closing Matrix's
--    "Cairo (Region)" row is 201 + 200 = 401. Both are right; they answer different questions.
--  * Rep-level readers. loadClosingByEmployee drops rows with no rep_hr_id, and Direct still has
--    none, so no rep's number moves.
--
-- CREATE OR REPLACE silently drops SET clauses, so SECURITY DEFINER / search_path / STABLE are
-- re-declared verbatim from the live definition.

begin;

create or replace function au.f_monthly_achievement(p_period text)
returns table(
  period text,
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
  actual_units numeric,
  actual_value numeric,
  target_units numeric,
  target_value numeric,
  achievement_value numeric,
  achievement_units numeric,
  has_target boolean,
  has_actual boolean
)
language plpgsql
stable
security definer
set search_path to 'au', 'public'
as $function$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with attribution as (
    select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
    from au.f_monthly_attribution(p_period) a
    -- Direct is kept regardless of area. It has none — that is the nature of the channel, not a
    -- data gap — and the targets it is measured against already include it.
    where a.channel in ('indirect', 'direct')
  ),
  actuals as (
    select
      at.line_code,
      at.area_code,
      -- Carried ONLY for area-less rows (the Direct channel), so each region's Direct forms its
      -- own row and can reach its own DM. Area rows already resolve through the seat map.
      case when at.area_code is null then at.region_code end as direct_region_code,
      at.product_code,
      sum(at.sales_units) as actual_units,
      sum(at.sales_value) as actual_value
    from attribution at
    group by at.line_code, at.area_code,
             case when at.area_code is null then at.region_code end,
             at.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, null::text as direct_region_code,
           t.product_code, t.target_units, t.target_value
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.line_code, actuals.area_code, actuals.direct_region_code, actuals.product_code from actuals
    union
    select tgt.line_code, tgt.area_code, tgt.direct_region_code, tgt.product_code from tgt
  ),
  -- Same as f_monthly_attribution: the mapping in force at period end plus each seat's
  -- occupant as of that date, resolved once rather than once per (area, product) key.
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
  ),
  -- Every (line, region) resolves to exactly one DM seat in the live model (verified: 22 of 22
  -- pairs, zero exceptions), so an area-less Direct row maps to its region's DM by lookup rather
  -- than by any allocation rule. min() is a deterministic pick over that single value, and would
  -- not silently fan out if a second DM were ever added to a region.
  --
  -- A Direct region the seat model does not carry under that name (today: Anti Infective 'UE',
  -- which the model splits into UE-1/UE-2) simply finds no row here and stays DM-less. That is
  -- the intended fail-safe: no DM is credited with sales that could belong to either of two.
  region_dm as (
    select
      lam.line_code,
      lam.operational_region_code,
      min(lam.dm_seat_id)          as dm_seat_id,
      min(lam.dm_occupant_hr_id)   as dm_occupant_hr_id
    from lam_asof lam
    where lam.operational_region_code is not null
    group by lam.line_code, lam.operational_region_code
  )
  select
    p_period,
    k.line_code,
    -- An area row takes its region from the seat map; an area-less Direct row keeps the region
    -- it arrived with, so the channel is never reported as region-less.
    coalesce(lam.operational_region_code, k.direct_region_code),
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    -- Rep stays unmatched for Direct: no area means no rep seat, and inventing one would
    -- fabricate attribution.
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    coalesce(lam.dm_seat_id, rdm.dm_seat_id),
    coalesce(lam.dm_occupant_hr_id, rdm.dm_occupant_hr_id),
    k.product_code,
    coalesce(ac.actual_units, 0), coalesce(ac.actual_value, 0),
    tg.target_units, tg.target_value,
    case when tg.target_value is not null and tg.target_value <> 0
         then coalesce(ac.actual_value, 0) / tg.target_value end,
    case when tg.target_units is not null and tg.target_units <> 0
         then coalesce(ac.actual_units, 0) / tg.target_units end,
    (tg.line_code is not null),
    (ac.line_code is not null)
  from keys k
  -- area_code / direct_region_code use IS NOT DISTINCT FROM (not `=`): both are NULL on one side
  -- or the other, and `NULL = NULL` is never true, so a plain `=` drops every Direct row straight
  -- back out of the result.
  left join actuals ac
    on ac.line_code = k.line_code
   and ac.area_code is not distinct from k.area_code
   and ac.direct_region_code is not distinct from k.direct_region_code
   and ac.product_code = k.product_code
  left join tgt tg
    on tg.line_code = k.line_code
   and tg.area_code is not distinct from k.area_code
   and tg.direct_region_code is not distinct from k.direct_region_code
   and tg.product_code = k.product_code
  -- Still a plain `=` on area: a NULL-area Direct row must match no seat, so it is credited to
  -- no REP. Its DM arrives from region_dm below instead.
  left join lam_asof lam
    on lam.line_code = k.line_code
   and lam.area_code = k.area_code
  left join region_dm rdm
    on rdm.line_code = k.line_code
   and rdm.operational_region_code = k.direct_region_code;
end;
$function$;

revoke execute on function au.f_monthly_achievement(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement(text) to service_role;

commit;

notify pgrst, 'reload schema';
