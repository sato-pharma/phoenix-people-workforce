-- ─────────────────────────────────────────────────────────────────────────────
-- Achievement counts EVERY sale the attribution engine produces, including the
-- rows it could not place.
--
-- au.f_monthly_achievement gathered actuals with
--     where a.channel in ('indirect', 'direct')
-- which silently discarded the third channel, 'unmapped' — real invoiced sales the
-- engine could not attribute to an area. Monthly Closing counts them; achievement
-- did not, so the two screens quoted different numbers for the same month:
--
--     2026-07   Monthly Closing        Sales vs Target       dropped
--     cns          8,066,152.47          7,925,997.58      140,154.89
--     pedia        1,996,470.65          1,990,780.40        5,690.25
--     anti_inf       612,194.05            606,909.25        5,284.80
--     (no line)          462.00                  —             462.00
--                                                   total  151,591.94 EGP
--
-- Owner ruling 2026-08-12: include them, matching the closing. This is the standing
-- rule — never silent-drop a sales row; count it, flag it, and let the owner decide.
-- The dashboard flags them as unplaced (they carry no area, so they cannot reach a
-- rep, an area or a target) rather than absorbing them into an achievement %.
--
-- Achievement % is deliberately UNCHANGED by this: an unplaced row has no target
-- beside it, so it lands in the uncovered bucket and never enters the numerator.
-- 2026-07 company achievement stays 52.33% — the headline sales figure is what moves.
--
-- Two joins also become NULL-safe on line_code. 10 of the newly included rows carry
-- no line at all (462.00 EGP), and `ac.line_code = k.line_code` is never true for two
-- NULLs — so those rows would have re-entered `keys` and then joined back to nothing,
-- reporting as a confident zero. That is the same trap the area_code joins were made
-- NULL-safe for on 2026-08-01. product_code gets the same treatment pre-emptively.
--
-- The lam_asof (seat) join stays a strict `=` on purpose: a row with no area matches
-- no seat and is credited to no rep, which is correct, not a bug to fix.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function au.f_monthly_achievement(p_period text)
returns table(
  period text, line_code text, region_code text, area_code text, area_state text,
  is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
  product_code text, actual_units numeric, actual_value numeric,
  target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric,
  has_target boolean, has_actual boolean
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
    -- No channel filter. Every row the engine emits is a sale that happened; the ones
    -- it could not place are reported as unplaced, never dropped.
    select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
    from au.f_monthly_attribution(p_period) a
  ),
  actuals as (
    select
      at.line_code,
      at.area_code,
      case when at.area_code is null then at.region_code end as direct_region_code,
      at.product_code,
      sum(at.sales_units) as actual_units,
      sum(at.sales_value) as actual_value,
      -- has_actual used to be read off `ac.line_code is not null`, which reports a real
      -- sale carrying no line as "no actual". Harmless while line-less rows were filtered
      -- out; this migration lets them through, so the flag needs a marker that cannot be
      -- NULL for a row that exists.
      true as matched
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
    coalesce(lam.operational_region_code, k.direct_region_code),
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
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
    coalesce(ac.matched, false)
  from keys k
  left join actuals ac
    on ac.line_code is not distinct from k.line_code
   and ac.area_code is not distinct from k.area_code
   and ac.direct_region_code is not distinct from k.direct_region_code
   and ac.product_code is not distinct from k.product_code
  left join tgt tg
    on tg.line_code is not distinct from k.line_code
   and tg.area_code is not distinct from k.area_code
   and tg.direct_region_code is not distinct from k.direct_region_code
   and tg.product_code is not distinct from k.product_code
  left join lam_asof lam
    on lam.line_code = k.line_code
   and lam.area_code = k.area_code
  left join region_dm rdm
    on rdm.line_code = k.line_code
   and rdm.operational_region_code = k.direct_region_code;
end;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, but re-declaring it costs nothing and
-- documents the intent. REVOKE ... FROM PUBLIC on a default ACL strips service_role
-- along with it, so the grant below is mandatory, not decorative.
revoke execute on function au.f_monthly_achievement(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement(text) to service_role;
