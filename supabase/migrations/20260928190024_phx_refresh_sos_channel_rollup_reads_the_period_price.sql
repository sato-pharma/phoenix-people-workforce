-- phx_refresh_sos_channel_rollup_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_refresh_sos_channel_rollup` now takes its factory price from
--   public.phx_factory_price(product_code, period) instead of reading
--   source_of_sales_products.factory_price straight off the product master. Byte-identical to the
--   body on production apart from that one expression, and only where it VALUES a row.
--
-- WHY: owner instruction 2026-09-28, repricing Saginko — direct orders from that day, "the sales
--   and target of the retail to be adjusted from 1 October". The resolver falls back to the master
--   price when no override covers the period, so a product without an override row is valued
--   exactly as before and this file moves no number on its own. Rationale, the override table and
--   the resolver: 20260928184100_period_scoped_factory_prices.sql.
--
--   One function per file on purpose: several guards in tests/ resolve "the newest migration that
--   defines X" and then read that whole file, so a bundle of 31 functions makes one function's SQL
--   answer for another's.
--
-- ROLLBACK: re-apply the previous definition. The cheaper undo is to drop the override row —
--   delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   which restores the old valuation everywhere without touching a function.

begin;

create or replace function public.phx_refresh_sos_channel_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
begin
  delete from public.source_of_sales_channel_customer_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_channel_customer_rollup
    (batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
     client_name, folded_name, no_client_code, is_direct,
     units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted)
  with
  names as (
    select distinct on (lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code)
      lower(btrim(d.official_line)) as line_key,
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.batch_id = p_batch_id
    order by lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code,
             d.latest_row_created_at desc
  ),
  retail as (
    select
      f.batch_id,
      lower(btrim(f.official_line))                          as line_key,
      max(f.official_line)                                   as official_line,
      f.period,
      f.distributor_code,
      f.client_code,
      f.client_code                                          as client_key,
      coalesce(n.client_name, '')                            as client_name,
      public.phx_fold_customer_name(coalesce(n.client_name, '')) as folded_name,
      (f.client_code is null)                                as no_client_code,
      false                                                  as is_direct,
      sum(f.total_qty)                                       as units_all,
      sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0))  as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(f.total_qty)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0))
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.line_key = lower(btrim(f.official_line))
     and n.period = f.period
     and n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.batch_id = p_batch_id
      and not coalesce(f.is_direct, false)
    group by f.batch_id, lower(btrim(f.official_line)), f.period, f.distributor_code,
             f.client_code, coalesce(n.client_name, '')
  ),
  direct as (
    select
      r.batch_id,
      lower(btrim(r.official_line))                          as line_key,
      max(r.official_line)                                   as official_line,
      r.invoice_period                                       as period,
      null::text                                             as distributor_code,
      null::text                                             as client_code,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end as client_key,
      btrim(coalesce(r.client_name, ''))                     as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
      false                                                  as no_client_code,
      true                                                   as is_direct,
      sum(r.qty)                                             as units_all,
      sum(r.value)                                           as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(r.qty)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(r.value)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.batch_id = p_batch_id
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
    group by r.batch_id, lower(btrim(r.official_line)), r.invoice_period,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end,
      btrim(coalesce(r.client_name, ''))
  )
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from retail
  union all
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from direct;
end;
$function$;

revoke execute on function public.phx_refresh_sos_channel_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_channel_rollup(uuid) to service_role;

commit;
