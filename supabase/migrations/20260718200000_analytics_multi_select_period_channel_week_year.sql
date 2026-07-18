-- ============================================================================
-- Analytics module: multi-select for Period / Channel / Week / Year filters
--
-- Owner ask: "I want to be able to choose multiple in the same filter." Scoped
-- to Period (exact-period picker), Channel, Week, and Year — the 4 analytics
-- filters that were still single-value. From-Period/To-Period are left as
-- scalars: they define a continuous range, and multi-selecting a "from" and a
-- "to" independently has no coherent meaning.
--
-- Mechanical change only: every other analytics filter (lines, regions,
-- distributors, products, families, client_codes, batch_status) already uses
-- the `(p_x is null or col = any(p_x))` array pattern below. This migration
-- extends that SAME proven pattern to p_period/p_channel/p_week_start/p_year.
-- No column, join, grouping, or ordering logic changes in any function —
-- only the affected parameter's type (scalar -> array) and its one WHERE
-- predicate (`= $1` -> `= any($1)`).
--
-- All 7 functions are STABLE SECURITY DEFINER, read-only (plain SELECT, no
-- writes), scoped to the `analytics` schema's own fact/dimension tables.
--
-- Postgres does not allow CREATE OR REPLACE to change a parameter's type —
-- changing text -> text[] changes the function's identity signature, so the
-- old signature must be dropped first or it becomes a separate overload.
-- ============================================================================

-- ── analytics_sos_by_period ────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean);

create function public.analytics_sos_by_period(
  p_periods              text[]  default null,
  p_period_from          text    default null,
  p_period_to            text    default null,
  p_channels             text[]  default null,
  p_lines                text[]  default null,
  p_distributors         text[]  default null,
  p_regions              text[]  default null,
  p_areas                text[]  default null,
  p_products             text[]  default null,
  p_families             text[]  default null,
  p_client_codes         text[]  default null,
  p_exclude_head_office  boolean default true
)
returns table(period text, year integer, month integer, channel text, units numeric, bonus_units numeric, value numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, channel,
         sum(units)       as units,
         sum(bonus_units) as bonus_units,
         sum(value)       as value
  from   analytics.sos_fact
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
  group by period, year, month, channel
  order by period, channel;
$function$;

-- ── analytics_sos_by_line ──────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_line(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]);

create function public.analytics_sos_by_line(
  p_periods       text[] default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_channels      text[] default null,
  p_lines         text[] default null,
  p_distributors  text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null,
  p_products      text[] default null,
  p_families      text[] default null,
  p_client_codes  text[] default null
)
returns table(period text, year integer, month integer, line text, channel text, units numeric, value numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, line, channel
  order by period, value desc;
$function$;

-- ── analytics_sos_by_area ──────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean);

create function public.analytics_sos_by_area(
  p_periods              text[]  default null,
  p_period_from          text    default null,
  p_period_to            text    default null,
  p_channels             text[]  default null,
  p_lines                text[]  default null,
  p_distributors         text[]  default null,
  p_regions              text[]  default null,
  p_areas                text[]  default null,
  p_products             text[]  default null,
  p_families             text[]  default null,
  p_client_codes         text[]  default null,
  p_exclude_head_office  boolean default true
)
returns table(period text, year integer, month integer, region_code text, region_name text, area_code text, area_name text, channel text, units numeric, value numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, region_code, region_name, area_code, area_name, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
  group by period, year, month, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name;
$function$;

-- ── analytics_sos_by_product ───────────────────────────────────────────────
drop function if exists public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]);

create function public.analytics_sos_by_product(
  p_periods       text[] default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_channels      text[] default null,
  p_lines         text[] default null,
  p_distributors  text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null,
  p_products      text[] default null,
  p_families      text[] default null,
  p_client_codes  text[] default null
)
returns table(period text, year integer, month integer, product_code text, product_name text, family text, family_code text, line text, channel text, units numeric, value numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, product_code, product_name, family, family_code, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, product_code, product_name, family, family_code, line, channel
  order by period, value desc;
$function$;

-- ── analytics_sos_by_customer (no channel column on this view) ────────────
drop function if exists public.analytics_sos_by_customer(text, text, text, text[], text[], text[]);

create function public.analytics_sos_by_customer(
  p_periods       text[] default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_lines         text[] default null,
  p_regions       text[] default null,
  p_client_codes  text[] default null
)
returns table(period text, year integer, month integer, client_code text, line text, region_code text, region_name text, active_batches bigint)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, client_code, line, region_code, region_name, active_batches
  from   analytics.sos_by_customer
  where  (p_periods is null       or period = any(p_periods))
    and  (p_period_from is null    or period >= p_period_from)
    and  (p_period_to is null      or period <= p_period_to)
    and  (p_lines is null          or line = any(p_lines))
    and  (p_regions is null        or region_code = any(p_regions))
    and  (p_client_codes is null   or client_code = any(p_client_codes))
  order by period desc, region_name, client_code;
$function$;

-- ── analytics_closing_by_employee (live overload only — the one call site
--    actually uses: p_products/p_families/p_batch_status/p_batch_id present.
--    A second, unused legacy overload with a narrower signature also exists
--    in this schema and is left untouched — it is dead code, out of scope
--    for this change.) ────────────────────────────────────────────────────
drop function if exists public.analytics_closing_by_employee(text, text, text, text[], text[], text[], text, text, text[], uuid);

create function public.analytics_closing_by_employee(
  p_periods        text[]  default null,
  p_period_from    text    default null,
  p_period_to      text    default null,
  p_lines          text[]  default null,
  p_products       text[]  default null,
  p_families       text[]  default null,
  p_employee_hr_id text    default null,
  p_territory      text    default null,
  p_batch_status   text[]  default null,
  p_batch_id       uuid    default null
)
returns table(period text, year integer, month integer, batch_id uuid, line text, employee_hr_id text, employee_name text, manager_hr_id text, territory text, sales_value numeric, target_value numeric, sales_units numeric, target_units numeric, achievement_pct numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, batch_id, line,
         employee_hr_id, employee_name, manager_hr_id, territory,
         sum(sales_value)   as sales_value,
         sum(target_value)  as target_value,
         sum(sales_units)   as sales_units,
         sum(target_units)  as target_units,
         case when sum(target_value) > 0
              then round((sum(sales_value) / sum(target_value) * 100)::numeric, 2)
              else null end  as achievement_pct
  from   analytics.closing_fact_all_statuses
  where  (p_periods is null        or period = any(p_periods))
    and  (p_period_from is null   or period >= p_period_from)
    and  (p_period_to is null     or period <= p_period_to)
    and  (p_lines is null         or line = any(p_lines))
    and  (p_products is null      or product_code = any(p_products))
    and  (p_families is null      or family = any(p_families))
    and  (p_employee_hr_id is null or upper(btrim(employee_hr_id)) = upper(btrim(p_employee_hr_id)))
    and  (p_territory is null     or lower(btrim(territory)) like '%' || lower(btrim(p_territory)) || '%')
    and  (p_batch_status is null  or batch_status = any(p_batch_status))
    and  (p_batch_id is null      or batch_id = p_batch_id)
  group by period, year, month, batch_id, line, employee_hr_id, employee_name, manager_hr_id, territory
  order by period, line, sales_value desc;
$function$;

-- ── analytics_weekly_fact ──────────────────────────────────────────────────
drop function if exists public.analytics_weekly_fact(date, integer, text[], text[], text[], text[], text[]);

create function public.analytics_weekly_fact(
  p_week_starts  date[]  default null,
  p_years        integer[] default null,
  p_distributors text[]  default null,
  p_lines        text[]  default null,
  p_regions      text[]  default null,
  p_products     text[]  default null,
  p_families     text[]  default null
)
returns table(week_start date, week_label text, period text, distributor_code text, distributor_name text, region_code text, region_name text, product_code text, product_name text, line text, family text, sales_qty numeric, sales_value numeric, stock_qty numeric)
language sql stable security definer
set search_path to 'analytics', 'public'
as $function$
  select week_start, week_label, period,
         distributor_code, distributor_name,
         region_code, region_name,
         product_code, product_name, line, family,
         sum(sales_qty)   as sales_qty,
         sum(sales_value) as sales_value,
         sum(stock_qty)   as stock_qty
  from   analytics.weekly_fact
  where  (p_week_starts is null  or week_start = any(p_week_starts))
    and  (p_years is null        or year = any(p_years))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_lines is null        or line = any(p_lines))
    and  (p_regions is null      or region_code = any(p_regions))
    and  (p_products is null     or product_code = any(p_products))
    and  (p_families is null     or family = any(p_families))
  group by week_start, week_label, period,
           distributor_code, distributor_name,
           region_code, region_name,
           product_code, product_name, line, family
  order by week_start desc, sales_value desc;
$function$;
