-- make_it_happen_brick_forecast
--
-- WHAT THIS CHANGES: two additive objects for Make It Happen's per-brick forecast (owner,
-- 2026-11-06: "I want the forecast to be per product per brick ... make the calculation based on
-- this brick sales history for this product").
--   1. public.phx_make_it_happen_brick_units(p_period, p_line_codes, p_area_codes) — one month's units per (line, area, rep,
--      brick, product), read from the same validated fact rollup, line map, area crosswalk and
--      seat-occupant-as-of the Sales vs Target brick read (au.f_sales_brick_detail) uses. It is
--      that read with the product kept and two things left out: direct orders (they are booked on
--      no brick) and El Qema (QM), whose rows must leave no trace for anyone but the Super Admin.
--      Units only — the planner values a forecast at the product's price itself. The two arrays
--      narrow the read to the viewer's lines and areas (null = every one) so a rep's page reads his
--      own bricks, not the company's ~5,500 rows a month; the app still applies the exact bound.
--   2. public.sales_forecast_plans.brick_units — a saved plan's units per product per brick,
--      product_code -> brick_id -> whole units. Defaults to {} so every existing plan reads as
--      "split by each brick's pace", which is what the planner shows for a product nobody typed
--      per brick.
-- WHY: a rep plans where he sells — by brick. Each brick's pace is read from its own months.
-- ROLLBACK:
--   drop function if exists public.phx_make_it_happen_brick_units(text, text[], text[]);
--   alter table public.sales_forecast_plans drop column if exists brick_units;
--   (the column drop loses the per-brick split of plans saved since; their product totals stay)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: a new function and a new column with a constant default.

begin;

-- The one-argument draft of this function lived on staging and production for minutes on 2026-11-06
-- before the scope arrays were added; nothing ever called it.
drop function if exists public.phx_make_it_happen_brick_units(text);

create or replace function public.phx_make_it_happen_brick_units(
  p_period text,
  p_line_codes text[] default null,
  p_area_codes text[] default null
)
returns table(
  period text, line_code text, area_code text, rep_hr_id text, dm_hr_id text,
  brick_id text, brick_name text, product_code text, units numeric
)
language sql
stable
security definer
set search_path to 'au', 'public'
set statement_timeout to '45s'
as $function$
  with bounds as (
    select (date_trunc('month', to_date(p_period || '-01', 'YYYY-MM-DD'))
            + interval '1 month - 1 day')::date as period_end
    where p_period ~ '^\d{4}-\d{2}$'
      and to_date(p_period || '-01', 'YYYY-MM-DD') >= date '2026-07-01'
  ),
  fact as materialized (
    select
      f.official_line,
      nullif(btrim(f.area_code), '')                as sos_area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')   as brick_id,
      upper(btrim(coalesce(f.product_code, '')))    as product_code,
      f.total_qty
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and exists (select 1 from bounds)
      and not f.is_direct
      and nullif(btrim(coalesce(f.brick_id, '')), '') is not null
      and upper(btrim(coalesce(f.distributor_code, ''))) <> 'QM'
      and upper(btrim(coalesce(f.product_code, ''))) not in ('', 'LA003', 'LA004', 'SS001')
  ),
  lam_asof as materialized (
    select
      l.line_code, l.area_code,
      au.f_seat_occupant_asof(l.rep_seat_id, bo.period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, bo.period_end)  as dm_occupant_hr_id
    from bounds bo
    cross join lateral au.f_line_area_map_asof(bo.period_end) l
    where (p_line_codes is null or l.line_code = any (p_line_codes))
      and (p_area_codes is null or l.area_code = any (p_area_codes))
  )
  select
    p_period,
    lam.line_code,
    lam.area_code,
    lam.rep_occupant_hr_id,
    lam.dm_occupant_hr_id,
    fa.brick_id,
    sb.brick_name,
    fa.product_code,
    sum(fa.total_qty)
  from fact fa
  join au.sos_official_line_map lm
    on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
  join au.sos_area_crosswalk cw
    on cw.sos_area_code = fa.sos_area_code
  join lam_asof lam
    on lam.line_code = lm.line_code and lam.area_code = cw.canonical_area_code
  left join public.source_of_sales_bricks sb
    on sb.brick_id = fa.brick_id
  group by
    lam.line_code, lam.area_code, lam.rep_occupant_hr_id, lam.dm_occupant_hr_id,
    fa.brick_id, sb.brick_name, fa.product_code;
$function$;

revoke execute on function public.phx_make_it_happen_brick_units(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_make_it_happen_brick_units(text, text[], text[]) to service_role;

alter table public.sales_forecast_plans
  add column if not exists brick_units jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_forecast_plans_brick_units_object'
  ) then
    alter table public.sales_forecast_plans
      add constraint sales_forecast_plans_brick_units_object check (jsonb_typeof(brick_units) = 'object');
  end if;
end $$;

comment on column public.sales_forecast_plans.brick_units is
  'Make It Happen: product_code -> brick_id -> whole units. {} = each product split by its bricks'' own pace.';

commit;
