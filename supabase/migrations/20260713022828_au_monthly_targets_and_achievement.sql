-- Phase 6: Targets on the 42-area seat model. Grain = one target per (month, line, area, product).
-- Area-keyed (NOT person-keyed) so a target rides the seat: a new hire inherits it, a vacant area
-- still carries a target, "Other" areas carry none. Achievement = actuals (SoS attribution) / targets.

create table if not exists au.monthly_targets (
  id            uuid primary key default gen_random_uuid(),
  period        text not null,                                   -- 'YYYY-MM'
  line_code     text not null references au.lines(line_code),
  area_code     text not null references au.canonical_areas(area_code),
  product_code  text not null,
  target_units  numeric,
  target_value  numeric,
  batch_id      uuid,
  source        text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint monthly_targets_period_fmt check (period ~ '^\d{4}-\d{2}$'),
  constraint monthly_targets_has_number check (target_units is not null or target_value is not null),
  constraint monthly_targets_unique unique (period, line_code, area_code, product_code)
);

create index if not exists idx_monthly_targets_period on au.monthly_targets(period);

-- Defense-in-depth: RLS on with no policy => only owner/service_role (which bypass RLS) can touch it.
-- The app writes/reads via service_role; the achievement function is SECURITY DEFINER (owner).
alter table au.monthly_targets enable row level security;

-- Achievement engine: join SoS indirect actuals to targets on (period, line, area, product),
-- resolving org attributes (region/rep/DM) from line_area_map + occupancy (authoritative, so
-- target-bearing products with zero sales still surface under their rep/region). Direct channel has
-- no per-area target and is excluded. Rows appear when there is a target OR an actual (full key union).
create or replace function au.f_monthly_achievement(p_period text)
returns table (
  period text, line_code text, region_code text, area_code text, area_state text, is_other boolean,
  rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text,
  actual_units numeric, actual_value numeric, target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric, has_target boolean, has_actual boolean
)
language plpgsql stable security definer set search_path to 'au','public'
as $$
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
    select line_code, area_code, product_code from actuals
    union
    select line_code, area_code, product_code from tgt
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
  left join actuals ac using (line_code, area_code, product_code)
  left join tgt tg using (line_code, area_code, product_code)
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

-- Public (PostgREST-callable) read wrappers — service_role only.
create or replace function public.phx_monthly_achievement(p_period text)
returns table (
  period text, line_code text, region_code text, area_code text, area_state text, is_other boolean,
  rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text,
  actual_units numeric, actual_value numeric, target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric, has_target boolean, has_actual boolean
)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_monthly_achievement(p_period); $$;

revoke all on function au.f_monthly_achievement(text) from public, anon, authenticated;
revoke all on function public.phx_monthly_achievement(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement(text) to service_role;
grant execute on function public.phx_monthly_achievement(text) to service_role;
