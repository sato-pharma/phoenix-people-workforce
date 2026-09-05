-- Top Customers omitted Office entirely — the single largest distributor by value.
--
-- Measured on production 2026-09-05 for 2026-07: Office is 3,930,227.33 EGP across 3,591
-- fact_rollup rows, ahead of PS (2,569,253.50), IS (1,637,421.58) and RM (473,202.03). Every other
-- distributor reconciles to the cent between the fact rollup and the Top Customers panel. Office
-- reconciles to zero, and nothing on the page says so.
--
-- WHY IT WAS MISSING, precisely — the audit's stated cause is close but not exact, and the
-- difference decides the fix. It is NOT that Office rows carry a null client_code and are dropped by
-- `r.client_code is not null`: measured, `source_of_sales_customer_directory_rollup` holds **zero**
-- null-client_code rows for 2026-07 and **no Office rows at all**. Office never reaches that table.
-- So no change to the client_code predicate could ever have surfaced it — the row has to come from
-- `source_of_sales_fact_rollup`, which is what the brick panel already reads and where Office's
-- 3,930,227.33 lives.
--
-- Owner's decision, 2026-09-05: show Office as a SINGLE row.
--
-- It is emitted with a synthetic client_code 'OFFICE' and no region, area or brick, because the
-- 3,591 underlying rows span many areas and one row cannot honestly claim one of them. That also
-- means the dashboard's own region/area filters drop it whenever the viewer narrows to a geography
-- — correct, since Office is not attributable to one. With no geography filter, which is the
-- default executive view, it appears.
--
-- This does NOT allocate Office anywhere. The Office allocation golden rule
-- (src/lib/sales/office-allocation.ts, LOCKED) governs spreading Office units across areas by each
-- area's share of the line's non-Office value; a single unallocated aggregate row touches none of
-- that machinery and must never be confused with it.
--
-- Everything in the coded-customer half below is unchanged from the previous definition, including
-- the p_exclude_codes handling restored in 20260905143000.

create or replace function public.phx_exec_customers(
  p_period text default null::text,
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_lines text[] default null::text[],
  p_products text[] default null::text[],
  p_regions text[] default null::text[],
  p_areas text[] default null::text[]
)
returns table(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '45s'
set work_mem to '96MB'
as $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      r.client_code,
      r.client_name,
      r.distributor_code,
      r.region_code,
      r.area_code,
      r.brick_id,
      r.latest_row_created_at,
      r.total_qty,
      case when r.is_direct
           then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(p.factory_price, 0)
      end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(r.product_code, ''))) <> all (
             select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty)  as units,
      sum(line_value) as value
    from filtered
    group by client_code, distributor_code
  ),
  -- Office, as ONE row, from the fact rollup — the only table that carries it.
  office as (
    select
      'OFFICE'::text as client_code,
      'Office'::text as client_name,
      'Office'::text as distributor_code,
      null::text     as region_code,
      null::text     as area_code,
      null::text     as brick_id,
      sum(f.total_qty)                                        as units,
      sum(f.effective_units * coalesce(p.factory_price, 0))   as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where (p_period is null or f.period = p_period)
      and f.is_direct = false
      and upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (
             select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
      and (p_lines    is null or f.official_line = any(p_lines))
      and (p_products is null or f.product_code  = any(p_products))
      and (p_regions  is null or f.region_code   = any(p_regions))
      and (p_areas    is null or f.area_code     = any(p_areas))
    having sum(f.total_qty) is not null
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code)
  union all
  select o.client_code, o.client_name, o.distributor_code,
         o.region_code, o.area_code, o.brick_id, o.units, o.value
  from office o;
end;
$function$;

revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;
