-- Packaged verbatim from staging (cifwmndunmlxjhyjugxa) migration 20260713133806 for Phase-9
-- production apply (see 20260713133641_au_sales_source_breakdown_rpcs.sql for why these were missing).
--
-- Whole-line source breakdown (all areas) for the Excel audit export.
create or replace function au.f_sales_source_breakdown_line(p_period text, p_line_code text)
returns table (
  area_code text, product_code text, product_name text,
  distributor_name text, brick_name text, units numeric, value numeric
)
language sql stable security definer set search_path to 'au','public'
as $$
  select
    f.area_code,
    upper(btrim(f.product_code)) as product_code,
    max(coalesce(p.product_name, f.product_name)) as product_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and not f.is_direct
    and nullif(btrim(f.area_code),'') is not null
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by f.area_code, upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)'),
           coalesce(nullif(btrim(b.brick_name), ''), '(no brick)')
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(p.factory_price,0)) <> 0
  order by f.area_code, value desc;
$$;

create or replace function public.phx_sales_source_breakdown_line(p_period text, p_line_code text)
returns table (area_code text, product_code text, product_name text, distributor_name text, brick_name text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_source_breakdown_line(p_period, p_line_code); $$;

revoke all on function au.f_sales_source_breakdown_line(text,text) from public, anon, authenticated;
revoke all on function public.phx_sales_source_breakdown_line(text,text) from public, anon, authenticated;
grant execute on function au.f_sales_source_breakdown_line(text,text) to service_role;
grant execute on function public.phx_sales_source_breakdown_line(text,text) to service_role;
