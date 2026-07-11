-- Analytics RPC filters v2: batch-status/batch-id filtering for Monthly Closing,
-- and a new SoS-by-customer RPC.
--
-- Additive only — does not touch the two already-committed analytics migrations.
--
-- Design notes:
--   • SoS and Weekly RPCs intentionally do NOT get a batch-status filter: their
--     underlying views (sos_fact / weekly_fact) are validated-only by design, and
--     widening them would surface rejected/unvalidated rows to executives. Only
--     Monthly Closing — where staged/approved/rejected is a real workflow state —
--     gets one, via a new "_all_statuses" view that is NOT granted to
--     analytics_readonly (Metabase keeps seeing approved-only data via the
--     existing analytics.closing_fact view; only the new RPC, service_role-only,
--     can see pre-approval batches).
--   • analytics_sos_by_customer exposes the already-existing analytics.sos_by_customer
--     view (customer presence, not invoice rows) as a filterable RPC.

begin;

-- ── Monthly closing fact, all batch statuses (service_role / RPC only) ─────────

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
where
  -- Strip confidential products by normalized name (same rule as analytics.closing_fact)
  lower(btrim(r.product)) not in ('lacto basic 1', 'lacto basic 2', 'satoslim');

-- Intentionally NOT granted to analytics_readonly — Metabase keeps using
-- analytics.closing_fact (approved-only). This view is for the service-role RPC below.

-- ── Monthly closing by employee — widened with batch status / batch id ─────────

drop function if exists public.analytics_closing_by_employee(text, text, text, text[], text, text);

create or replace function public.analytics_closing_by_employee(
  p_period         text   default null,
  p_period_from    text   default null,
  p_period_to      text   default null,
  p_lines          text[] default null,
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
    and  (p_employee_hr_id is null or upper(btrim(employee_hr_id)) = upper(btrim(p_employee_hr_id)))
    and  (p_territory is null      or lower(btrim(territory)) like '%' || lower(btrim(p_territory)) || '%')
    and  (p_batch_status is null   or batch_status = any(p_batch_status))
    and  (p_batch_id is null       or batch_id = p_batch_id)
  group by period, year, month, batch_id, line, employee_hr_id, employee_name, manager_hr_id, territory
  order by period, line, sales_value desc;
$$;

revoke all on function public.analytics_closing_by_employee(text, text, text, text[], text, text, text[], uuid) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_closing_by_employee(text, text, text, text[], text, text, text[], uuid) to service_role;

-- ── SoS by customer (presence, not invoice rows) ────────────────────────────────

create or replace function public.analytics_sos_by_customer(
  p_period       text    default null,
  p_period_from  text    default null,
  p_period_to    text    default null,
  p_lines        text[]  default null,
  p_regions      text[]  default null,
  p_client_codes text[]  default null
)
returns table (
  period         text,
  year           integer,
  month          integer,
  client_code    text,
  line           text,
  region_code    text,
  region_name    text,
  active_batches bigint
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, client_code, line, region_code, region_name, active_batches
  from   analytics.sos_by_customer
  where  (p_period is null         or period = p_period)
    and  (p_period_from is null    or period >= p_period_from)
    and  (p_period_to is null      or period <= p_period_to)
    and  (p_lines is null          or line = any(p_lines))
    and  (p_regions is null        or region_code = any(p_regions))
    and  (p_client_codes is null   or client_code = any(p_client_codes))
  order by period desc, region_name, client_code;
$$;

revoke all on function public.analytics_sos_by_customer(text, text, text, text[], text[], text[]) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_customer(text, text, text, text[], text[], text[]) to service_role;

commit;
