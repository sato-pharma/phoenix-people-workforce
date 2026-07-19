-- Packaged verbatim from staging (cifwmndunmlxjhyjugxa) migration 20260713133641 for Phase-9
-- production apply. Was built live on staging after Phase-8 packaging and never written to the repo;
-- the branch's Targets drill-down/export code calls these RPCs, so production 500s without them.
--
-- Traceability drill-down for the Targets/closing view: decompose each area's sales to source
-- (distributor + brick) so every total is auditable. Reconciles to au.f_monthly_attribution
-- (same validated-batch filter, confidential exclusion, and value = effective_units*factory_price).

-- Indirect (distributor) sales for one (period, line, area[, product]) -> distributor x brick.
create or replace function au.f_sales_source_breakdown(
  p_period text, p_line_code text, p_area_code text, p_product_code text default null)
returns table (
  product_code text, product_name text,
  distributor_name text, brick_name text,
  units numeric, value numeric
)
language sql stable security definer set search_path to 'au','public'
as $$
  select
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
    and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)'),
           coalesce(nullif(btrim(b.brick_name), ''), '(no brick)')
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(p.factory_price,0)) <> 0
  order by value desc, units desc;
$$;

-- Direct (company) channel for one (period, line) -> region x product x distributor (no brick).
create or replace function au.f_sales_direct_breakdown(p_period text, p_line_code text)
returns table (
  region_code text, product_code text, product_name text,
  distributor_name text, units numeric, value numeric
)
language sql stable security definer set search_path to 'au','public'
as $$
  select
    coalesce(nullif(btrim(f.region_code),''),'NATIONAL') as region_code,
    upper(btrim(f.product_code)) as product_code,
    max(coalesce(p.product_name, f.product_name)) as product_name,
    coalesce(d.distributor_name, f.distributor_code, '(direct)') as distributor_name,
    sum(f.total_qty) as units,
    sum(f.direct_value) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and f.is_direct
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by coalesce(nullif(btrim(f.region_code),''),'NATIONAL'), upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(direct)')
  having sum(f.direct_value) <> 0
  order by value desc;
$$;

-- Public (PostgREST) wrappers, service_role only.
create or replace function public.phx_sales_source_breakdown(
  p_period text, p_line_code text, p_area_code text, p_product_code text default null)
returns table (product_code text, product_name text, distributor_name text, brick_name text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_source_breakdown(p_period, p_line_code, p_area_code, p_product_code); $$;

create or replace function public.phx_sales_direct_breakdown(p_period text, p_line_code text)
returns table (region_code text, product_code text, product_name text, distributor_name text, units numeric, value numeric)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_sales_direct_breakdown(p_period, p_line_code); $$;

revoke all on function au.f_sales_source_breakdown(text,text,text,text) from public, anon, authenticated;
revoke all on function au.f_sales_direct_breakdown(text,text) from public, anon, authenticated;
revoke all on function public.phx_sales_source_breakdown(text,text,text,text) from public, anon, authenticated;
revoke all on function public.phx_sales_direct_breakdown(text,text) from public, anon, authenticated;
grant execute on function au.f_sales_source_breakdown(text,text,text,text) to service_role;
grant execute on function au.f_sales_direct_breakdown(text,text) to service_role;
grant execute on function public.phx_sales_source_breakdown(text,text,text,text) to service_role;
grant execute on function public.phx_sales_direct_breakdown(text,text) to service_role;
