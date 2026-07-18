-- Reconcile helper: attributed (mapped+unmapped) vs raw fact totals, per line.
create or replace function au.f_monthly_attribution_reconcile(p_period text)
returns table (
  line_code text,
  mapped_value numeric,
  unmapped_value numeric,
  attributed_value numeric,
  raw_value numeric,
  diff numeric
)
language sql
stable
security definer
set search_path to 'au','public'
as $$
  with att as (
    select coalesce(a.line_code,'(unmapped)') as line_code,
           sum(a.sales_value) filter (where a.mapped)     as mapped_value,
           sum(a.sales_value) filter (where not a.mapped)  as unmapped_value,
           sum(a.sales_value)                              as attributed_value
    from au.f_monthly_attribution(p_period) a
    group by coalesce(a.line_code,'(unmapped)')
  ),
  raw as (
    select coalesce(lm.line_code,'(unmapped)') as line_code,
           sum(case when f.is_direct then f.direct_value
                    else f.effective_units * coalesce(pp.factory_price,0) end) as raw_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line))
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
    group by coalesce(lm.line_code,'(unmapped)')
  )
  select
    coalesce(att.line_code, raw.line_code)          as line_code,
    coalesce(att.mapped_value,0)                    as mapped_value,
    coalesce(att.unmapped_value,0)                  as unmapped_value,
    coalesce(att.attributed_value,0)                as attributed_value,
    coalesce(raw.raw_value,0)                       as raw_value,
    coalesce(att.attributed_value,0) - coalesce(raw.raw_value,0) as diff
  from att
  full join raw on raw.line_code = att.line_code
  order by 1;
$$;

-- Public (PostgREST-callable) wrappers — service_role only, since au is not an exposed schema.
create or replace function public.phx_monthly_attribution(p_period text)
returns table (
  period text, channel text, line_code text, region_code text, area_code text,
  area_state text, is_other boolean, rep_seat_id text, rep_hr_id text,
  dm_seat_id text, dm_hr_id text, product_code text,
  sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text
)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_monthly_attribution(p_period); $$;

create or replace function public.phx_monthly_attribution_reconcile(p_period text)
returns table (
  line_code text, mapped_value numeric, unmapped_value numeric,
  attributed_value numeric, raw_value numeric, diff numeric
)
language sql stable security definer set search_path to 'au','public'
as $$ select * from au.f_monthly_attribution_reconcile(p_period); $$;

revoke all on function au.f_monthly_attribution_reconcile(text) from public, anon, authenticated;
revoke all on function public.phx_monthly_attribution(text) from public, anon, authenticated;
revoke all on function public.phx_monthly_attribution_reconcile(text) from public, anon, authenticated;
grant execute on function au.f_monthly_attribution_reconcile(text) to service_role;
grant execute on function public.phx_monthly_attribution(text) to service_role;
grant execute on function public.phx_monthly_attribution_reconcile(text) to service_role;
