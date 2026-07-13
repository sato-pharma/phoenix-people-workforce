-- Fix: RETURNS TABLE out-params (line_code, etc.) shadowed the CTE column refs in the keys union.
-- #variable_conflict use_column tells plpgsql to prefer the column; keys columns fully qualified.
create or replace function au.f_monthly_achievement(p_period text)
returns table (
  period text, line_code text, region_code text, area_code text, area_state text, is_other boolean,
  rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text,
  actual_units numeric, actual_value numeric, target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric, has_target boolean, has_actual boolean
)
language plpgsql stable security definer set search_path to 'au','public'
as $$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with actuals as (
    select a.line_code, a.area_code, a.product_code,
           sum(a.sales_units) as actual_units, sum(a.sales_value) as actual_value
    from au.f_monthly_attribution(p_period) a
    where a.channel = 'indirect'
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
  )
  select
    p_period,
    k.line_code,
    lam.operational_region_code,
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, rep.occupant_hr_id,
    lam.dm_seat_id, dm.occupant_hr_id,
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
  left join actuals ac on ac.line_code = k.line_code and ac.area_code = k.area_code and ac.product_code = k.product_code
  left join tgt tg on tg.line_code = k.line_code and tg.area_code = k.area_code and tg.product_code = k.product_code
  left join au.line_area_map lam on lam.line_code = k.line_code and lam.area_code = k.area_code
  left join lateral (
    select oh.occupant_hr_id from au.occupancy_history oh
    where oh.seat_id = lam.rep_seat_id
    order by (oh.effective_from <= v_period_end and (oh.effective_to is null or oh.effective_to > v_period_end)) desc,
             oh.effective_from asc
    limit 1
  ) rep on true
  left join lateral (
    select oh.occupant_hr_id from au.occupancy_history oh
    where oh.seat_id = lam.dm_seat_id
    order by (oh.effective_from <= v_period_end and (oh.effective_to is null or oh.effective_to > v_period_end)) desc,
             oh.effective_from asc
    limit 1
  ) dm on true;
end;
$$;
