-- Delta: expand filter parameters on all analytics RPCs.
--
-- Changes vs 20260625156000 + 20260625160000:
--   SoS RPCs (analytics_sos_by_period/line/area/product): old narrower signatures
--   lacked area, product, family, and client_code filter params. Drop old signatures
--   and re-create with all 11 params (now that sos_fact has client_code).
--   Also fixes analytics_sos_by_line which was missing p_lines entirely.
--
--   analytics.closing_fact_all_statuses: add product_code via lateral join
--   (matches the same fix applied to analytics.closing_fact in 20260626130000).
--
--   analytics_closing_by_employee: add p_products and p_families filter params
--   to support product-level drill-down on the monthly closing screen.

begin;

-- ── SoS by period — drop old 7-param signature, re-create with 11 ────────────

drop function if exists public.analytics_sos_by_period(text, text, text, text, text[], text[], text[]);

create or replace function public.analytics_sos_by_period(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null
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
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, channel
  order by period, channel;
$$;

revoke all on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) to service_role;

-- ── SoS by line — drop old 6-param signature (was also missing p_lines), re-create ─

drop function if exists public.analytics_sos_by_line(text, text, text, text, text[], text[]);

create or replace function public.analytics_sos_by_line(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null
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
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, line, channel
  order by period, value desc;
$$;

revoke all on function public.analytics_sos_by_line(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_line(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) to service_role;

-- ── SoS by area — drop old 8-param signature, re-create with 11 ──────────────

drop function if exists public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[]);

create or replace function public.analytics_sos_by_area(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null
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
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name;
$$;

revoke all on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) to service_role;

-- ── SoS by product — drop old 8-param signature, re-create with 11 ────────────

drop function if exists public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[]);

create or replace function public.analytics_sos_by_product(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null
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
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
  group by period, year, month, product_code, product_name, family, family_code, line, channel
  order by period, value desc;
$$;

revoke all on function public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_product(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]) to service_role;

-- ── closing_fact_all_statuses — add product_code lateral join ─────────────────

create or replace view analytics.closing_fact_all_statuses as
select
  r.year,
  r.month,
  lpad(r.month::text, 2, '0')                          as month_str,
  r.year::text || '-' || lpad(r.month::text, 2, '0')   as period,
  b.id                                                  as batch_id,
  b.file_name                                           as batch_file,
  b.status                                              as batch_status,
  b.line,
  r.employee_hr_id,
  r.employee_name,
  r.manager_hr_id,
  r.territory,
  r.sales_type,
  p.product_code,
  r.product,
  r.family,
  r.sales_units,
  r.sales_value,
  r.target_units,
  r.target_value,
  r.validation_state,
  r.link_status,
  case
    when r.target_value > 0
    then round((r.sales_value / r.target_value * 100)::numeric, 2)
    else null
  end as achievement_pct
from public.sales_records r
left join public.sales_import_batches b on b.id = r.batch_id
left join lateral (
  select sp.product_code
  from public.source_of_sales_products sp
  where lower(btrim(sp.product_name)) = lower(btrim(r.product))
  order by sp.active desc, sp.product_code
  limit 1
) p on true
where
  lower(btrim(r.product)) not in ('lacto basic 1', 'lacto basic 2', 'satoslim');

-- Intentionally NOT granted to analytics_readonly (Metabase uses closing_fact, approved-only).

-- ── analytics_closing_by_employee — add p_products, p_families filter params ──

drop function if exists public.analytics_closing_by_employee(text, text, text, text[], text, text, text[], uuid);
drop function if exists public.analytics_closing_by_employee(text, text, text, text[], text[], text[], text, text, text[], uuid);

create or replace function public.analytics_closing_by_employee(
  p_period         text   default null,
  p_period_from    text   default null,
  p_period_to      text   default null,
  p_lines          text[] default null,
  p_products       text[] default null,
  p_families       text[] default null,
  p_employee_hr_id text   default null,
  p_territory      text   default null,
  p_batch_status   text[] default null,
  p_batch_id       uuid   default null
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
  from   analytics.closing_fact_all_statuses
  where  (p_period is null         or period = p_period)
    and  (p_period_from is null    or period >= p_period_from)
    and  (p_period_to is null      or period <= p_period_to)
    and  (p_lines is null          or line = any(p_lines))
    and  (p_products is null       or product_code = any(p_products))
    and  (p_families is null       or family = any(p_families))
    and  (p_employee_hr_id is null or upper(btrim(employee_hr_id)) = upper(btrim(p_employee_hr_id)))
    and  (p_territory is null      or lower(btrim(territory)) like '%' || lower(btrim(p_territory)) || '%')
    and  (p_batch_status is null   or batch_status = any(p_batch_status))
    and  (p_batch_id is null       or batch_id = p_batch_id)
  group by period, year, month, batch_id, line, employee_hr_id, employee_name, manager_hr_id, territory
  order by period, line, sales_value desc;
$$;

revoke all on function public.analytics_closing_by_employee(text, text, text, text[], text[], text[], text, text, text[], uuid) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_closing_by_employee(text, text, text, text[], text[], text[], text, text, text[], uuid) to service_role;

commit;
