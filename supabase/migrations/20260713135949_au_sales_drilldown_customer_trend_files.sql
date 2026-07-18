-- Packaged verbatim from staging (cifwmndunmlxjhyjugxa) migration 20260713135949 for Phase-9
-- production apply (see 20260713133641_au_sales_source_breakdown_rpcs.sql for why these were missing).
--
-- Deeper drill-down: customer/pharmacy grain, area month-over-month trend, and source-file provenance.

-- 1) Customer-grain source: brick -> distributor -> customer (named). Reconciles to the cell total.
create or replace function au.f_sales_source_breakdown_detail(
  p_period text, p_line_code text, p_area_code text, p_product_code text)
returns table (brick_name text, distributor_name text, customer_name text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$
  select
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(cn.customer_name, '(unmapped customer)') as customer_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  left join lateral (
    select cm.customer_name from public.source_of_sales_customer_map cm
    where cm.customer_code = f.client_code and cm.customer_name is not null
    order by (cm.distributor_code = f.distributor_code) desc nulls last
    limit 1
  ) cn on true
  where f.period = p_period and not f.is_direct and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by 1, 2, 3
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(p.factory_price,0)) <> 0
  order by value desc;
$$;

-- 2) Month-over-month trend for one (line, area[, product]) across all loaded months.
create or replace function au.f_sales_area_trend(p_line_code text, p_area_code text, p_product_code text default null)
returns table (period text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$
  select f.period,
         sum(f.total_qty) as units,
         sum(f.effective_units * coalesce(p.factory_price,0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where not f.is_direct and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by f.period
  order by f.period;
$$;

-- 3) Source-file provenance: the validated distributor uploads that fed a month.
-- NOTE (known LOW follow-up, tracked in the audit): total_qty/total_value here are the whole-file
-- batch totals and do NOT strip confidential products (LA003/LA004/SS001), unlike every sibling
-- function above. This is batch-level metadata already visible to sales:import holders on the upload
-- surface, so it is not a new audience — but if the confidential circle tightens, recompute these
-- totals from source_of_sales_fact_rollup with the same NOT IN (...) filter. Left verbatim here to
-- preserve staging parity; change to be applied + reconciled on staging first.
create or replace function au.f_sales_source_files(p_period text)
returns table (distributor_name text, file_name text, uploaded_by text, uploaded_at timestamptz,
               total_qty numeric, total_value numeric, importable_rows integer, status text)
language sql stable security definer set search_path to 'au','public'
as $$
  select coalesce(ib.distributor_name, ib.distributor_code, '(unknown)') as distributor_name,
         ib.file_name, ib.uploaded_by, ib.created_at,
         ib.total_qty, ib.total_value, ib.importable_rows, ib.status
  from public.source_of_sales_import_batches ib
  where ib.period = p_period and ib.status = 'validated'
  order by coalesce(ib.distributor_name, ib.distributor_code), ib.created_at;
$$;

-- Public wrappers (service_role only).
create or replace function public.phx_sales_source_breakdown_detail(p_period text, p_line_code text, p_area_code text, p_product_code text)
returns table (brick_name text, distributor_name text, customer_name text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_source_breakdown_detail(p_period, p_line_code, p_area_code, p_product_code); $$;

create or replace function public.phx_sales_area_trend(p_line_code text, p_area_code text, p_product_code text)
returns table (period text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_area_trend(p_line_code, p_area_code, p_product_code); $$;

create or replace function public.phx_sales_source_files(p_period text)
returns table (distributor_name text, file_name text, uploaded_by text, uploaded_at timestamptz, total_qty numeric, total_value numeric, importable_rows integer, status text)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_source_files(p_period); $$;

revoke all on function au.f_sales_source_breakdown_detail(text,text,text,text) from public, anon, authenticated;
revoke all on function au.f_sales_area_trend(text,text,text) from public, anon, authenticated;
revoke all on function au.f_sales_source_files(text) from public, anon, authenticated;
revoke all on function public.phx_sales_source_breakdown_detail(text,text,text,text) from public, anon, authenticated;
revoke all on function public.phx_sales_area_trend(text,text,text) from public, anon, authenticated;
revoke all on function public.phx_sales_source_files(text) from public, anon, authenticated;
grant execute on function au.f_sales_source_breakdown_detail(text,text,text,text) to service_role;
grant execute on function au.f_sales_area_trend(text,text,text) to service_role;
grant execute on function au.f_sales_source_files(text) to service_role;
grant execute on function public.phx_sales_source_breakdown_detail(text,text,text,text) to service_role;
grant execute on function public.phx_sales_area_trend(text,text,text) to service_role;
grant execute on function public.phx_sales_source_files(text) to service_role;
