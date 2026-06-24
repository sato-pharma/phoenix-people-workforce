-- Analytics RPC helpers: thin security-definer wrappers over the analytics schema views.
-- These let the service role call named RPCs that apply filter parameters, which is
-- simpler than building dynamic SQL in application code and keeps the analytics schema
-- fully server-side only.
--
-- All functions: SECURITY DEFINER, search_path = analytics, public
-- All accessible ONLY to service_role (Phoenix app) — NOT to analytics_readonly.
-- analytics_readonly connects to Metabase and queries views directly.

begin;

-- ── SoS by period (trend) ─────────────────────────────────────────────────────

create or replace function public.analytics_sos_by_period(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null
)
returns table (
  period       text,
  year         integer,
  month        integer,
  channel      text,
  units        numeric,
  bonus_units  numeric,
  value        numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, channel,
         sum(units)       as units,
         sum(bonus_units) as bonus_units,
         sum(value)       as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
  group by period, year, month, channel
  order by period, channel;
$$;

revoke all on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[]) to service_role;

-- ── SoS by line ──────────────────────────────────────────────────────────────

create or replace function public.analytics_sos_by_line(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_distributors text[] default null,
  p_regions     text[]  default null
)
returns table (
  period  text,
  year    integer,
  month   integer,
  line    text,
  channel text,
  units   numeric,
  value   numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
  group by period, year, month, line, channel
  order by period, value desc;
$$;

revoke all on function public.analytics_sos_by_line(text, text, text, text, text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_line(text, text, text, text, text[], text[]) to service_role;

-- ── SoS by area ──────────────────────────────────────────────────────────────

create or replace function public.analytics_sos_by_area(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null
)
returns table (
  period      text,
  year        integer,
  month       integer,
  region_code text,
  region_name text,
  area_code   text,
  area_name   text,
  channel     text,
  units       numeric,
  value       numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, region_code, region_name, area_code, area_name, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
  group by period, year, month, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name;
$$;

revoke all on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[]) to service_role;

-- ── SoS by product ────────────────────────────────────────────────────────────

create or replace function public.analytics_sos_by_product(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_products    text[]  default null,
  p_families    text[]  default null
)
returns table (
  period       text,
  year         integer,
  month        integer,
  product_code text,
  product_name text,
  family       text,
  family_code  text,
  line         text,
  channel      text,
  units        numeric,
  value        numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, product_code, product_name, family, family_code, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
  group by period, year, month, product_code, product_name, family, family_code, line, channel
  order by period, value desc;
$$;

revoke all on function public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[]) to service_role;

-- ── Monthly closing by employee ───────────────────────────────────────────────

create or replace function public.analytics_closing_by_employee(
  p_period        text   default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_lines         text[] default null,
  p_employee_hr_id text  default null,
  p_territory     text   default null
)
returns table (
  period           text,
  year             integer,
  month            integer,
  batch_id         uuid,
  line             text,
  employee_hr_id   text,
  employee_name    text,
  manager_hr_id    text,
  territory        text,
  sales_value      numeric,
  target_value     numeric,
  sales_units      numeric,
  target_units     numeric,
  achievement_pct  numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, batch_id, line,
         employee_hr_id, employee_name, manager_hr_id, territory,
         sum(sales_value)   as sales_value,
         sum(target_value)  as target_value,
         sum(sales_units)   as sales_units,
         sum(target_units)  as target_units,
         case when sum(target_value) > 0
              then round((sum(sales_value) / sum(target_value) * 100)::numeric, 2)
              else null end  as achievement_pct
  from   analytics.closing_fact
  where  (p_period is null        or period = p_period)
    and  (p_period_from is null   or period >= p_period_from)
    and  (p_period_to is null     or period <= p_period_to)
    and  (p_lines is null         or line = any(p_lines))
    and  (p_employee_hr_id is null or upper(btrim(employee_hr_id)) = upper(btrim(p_employee_hr_id)))
    and  (p_territory is null     or lower(btrim(territory)) like '%' || lower(btrim(p_territory)) || '%')
  group by period, year, month, batch_id, line, employee_hr_id, employee_name, manager_hr_id, territory
  order by period, line, sales_value desc;
$$;

revoke all on function public.analytics_closing_by_employee(text, text, text, text[], text, text) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_closing_by_employee(text, text, text, text[], text, text) to service_role;

-- ── Weekly fact ───────────────────────────────────────────────────────────────

create or replace function public.analytics_weekly_fact(
  p_week_start   date    default null,
  p_year         integer default null,
  p_distributors text[]  default null,
  p_lines        text[]  default null,
  p_regions      text[]  default null,
  p_products     text[]  default null,
  p_families     text[]  default null
)
returns table (
  week_start       date,
  week_label       text,
  period           text,
  distributor_code text,
  distributor_name text,
  region_code      text,
  region_name      text,
  product_code     text,
  product_name     text,
  line             text,
  family           text,
  sales_qty        numeric,
  sales_value      numeric,
  stock_qty        numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select week_start, week_label, period,
         distributor_code, distributor_name,
         region_code, region_name,
         product_code, product_name, line, family,
         sum(sales_qty)   as sales_qty,
         sum(sales_value) as sales_value,
         sum(stock_qty)   as stock_qty
  from   analytics.weekly_fact
  where  (p_week_start is null   or week_start = p_week_start)
    and  (p_year is null         or year = p_year)
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
$$;

revoke all on function public.analytics_weekly_fact(date, integer, text[], text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_weekly_fact(date, integer, text[], text[], text[], text[], text[]) to service_role;

-- ── Cross-source comparison ───────────────────────────────────────────────────

create or replace function public.analytics_cross_source(
  p_period_from text   default null,
  p_period_to   text   default null,
  p_lines       text[] default null
)
returns table (
  period                   text,
  line                     text,
  sos_value                numeric,
  sos_units                numeric,
  closing_value            numeric,
  closing_units            numeric,
  target_value             numeric,
  weekly_value             numeric,
  weekly_units             numeric,
  closing_achievement_pct  numeric,
  closing_vs_sos_gap_pct   numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, line,
         sos_value, sos_units,
         closing_value, closing_units, target_value,
         weekly_value, weekly_units,
         closing_achievement_pct, closing_vs_sos_gap_pct
  from   analytics.cross_source_period_line
  where  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_lines is null       or line = any(p_lines))
  order by period desc, line;
$$;

revoke all on function public.analytics_cross_source(text, text, text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_cross_source(text, text, text[]) to service_role;

commit;
