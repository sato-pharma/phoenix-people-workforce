-- Direct sales count toward achievement.
--
-- Owner ruling 2026-08-01: the 2026 targets were SET INCLUDING the Direct channel. So excluding
-- Direct from actuals is not a conservative choice, it is a mismatch — every line with Direct sales
-- is measured against a target that already assumed them.
--
-- au.f_monthly_achievement gathered actuals as:
--
--     where a.channel = 'indirect'
--        or (a.channel = 'direct' and a.area_code is not null)
--
-- The second arm reads as "keep Direct when we know its area", which sounds safe. In practice it
-- keeps NOTHING: Direct sales carry no brick and no area at all, so every Direct row emerges from
-- au.f_monthly_attribution with `area_code IS NULL`. Measured on production for 2026-06 — 29 Direct
-- rows, 29 of them area-less, so the arm matched zero rows and 2,122,106 EGP never reached
-- achievement at all:
--
--     line             in achievement    Direct excluded    % of the line missing
--     pedia               2,434,469          1,797,514              42.5%
--     anti_infective        696,563            324,593              31.8%
--     cns                 4,109,042                  —                  —
--
-- Dropping the area predicate lets those rows through. What follows from that is deliberate:
--
--  * They group as (line_code, NULL area, product_code), so Direct forms its own rows rather than
--    being spread across areas. Attribution is geographic (owner ruling: sales are wired to areas,
--    and the person wired to the area inherits them) — Direct has no area, so it belongs to the
--    line, not to any rep. Inventing an area split would be fabricating attribution.
--  * The Direct row's key has a NULL area_code, and SQL's `=` is never true for two NULLs. So the
--    final SELECT must rejoin actuals/tgt with `area_code IS NOT DISTINCT FROM` (NULL matches NULL),
--    or the Direct key in `keys` cannot find its own actuals row and the value is silently dropped
--    right back out — which is exactly what a plain `=` join did (measured on staging: total stayed
--    9,362,180-minus-Direct until the join was made NULL-safe). The target side stays unmatched for
--    Direct (there is no area-level Direct target), so it carries a NULL target and NULL ratio at row
--    level; the line-level rollup is where the actual meets the target that already included it.
--  * The `left join lam_asof` likewise does not match, so rep_seat_id / rep_occupant_hr_id /
--    dm_occupant_hr_id stay NULL. Direct is credited to nobody, which is why rep-level readers such
--    as loadClosingByEmployee (which drops rows with no rep_hr_id) are unaffected.
--
-- Nothing else in the function changes. CREATE OR REPLACE silently drops SET clauses, so the
-- security and search_path settings below are re-declared verbatim from the live definition.

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
  with actuals as (
    select a.line_code, a.area_code, a.product_code,
           sum(a.sales_units) as actual_units, sum(a.sales_value) as actual_value
    from au.f_monthly_attribution(p_period) a
    -- Direct is kept regardless of area. It has none — that is the nature of the channel, not a
    -- data gap — and the targets it is measured against already include it.
    where a.channel in ('indirect', 'direct')
    group by a.line_code, a.area_code, a.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, t.product_code, t.target_units, t.target_value
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.line_code, actuals.area_code, actuals.product_code from actuals
    union
    select tgt.line_code, tgt.area_code, tgt.product_code from tgt
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
  )
  select
    p_period,
    k.line_code,
    lam.operational_region_code,
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    lam.dm_seat_id, lam.dm_occupant_hr_id,
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
  -- area_code IS NOT DISTINCT FROM (not `=`): the Direct key has a NULL area, and `NULL = NULL` is
  -- never true, so a plain `=` would drop every Direct row straight back out of the result. lam is
  -- deliberately still `=` on area — a NULL-area Direct row has no seat/rep, which is correct.
  left join actuals ac
    on ac.line_code = k.line_code
   and ac.area_code is not distinct from k.area_code
   and ac.product_code = k.product_code
  left join tgt tg
    on tg.line_code = k.line_code
   and tg.area_code is not distinct from k.area_code
   and tg.product_code = k.product_code
  left join lam_asof lam on lam.line_code = k.line_code and lam.area_code = k.area_code;
end;
$function$;

revoke execute on function au.f_monthly_achievement(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement(text) to service_role;

commit;

notify pgrst, 'reload schema';
