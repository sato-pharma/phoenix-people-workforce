-- Phase 1 / Performance: refresh + backfill for the SoS fact rollup.
--
-- phx_refresh_sos_fact_rollup(batch) recomputes the two rollups for ONE batch.
-- It is idempotent (delete-then-insert its own batch) and replicates the EXACT
-- predicate used by the live exec/SI functions: b.status='validated' AND
-- r.invoice_period = b.period, with NO validation_state filter.

create or replace function public.phx_refresh_sos_fact_rollup(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from public.source_of_sales_fact_rollup where batch_id = p_batch_id;
  delete from public.source_of_sales_customer_presence_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_fact_rollup
    (batch_id, period, distributor_code, official_line, region_code, area_code, brick_id,
     product_code, product_name, is_direct,
     effective_units, total_qty, total_bonus_qty, direct_value, row_count)
  select
    r.batch_id,
    b.period,
    r.distributor_code,
    r.official_line,
    r.region_code,
    r.area_code,
    r.brick_id,
    r.product_code,
    max(r.product_name),
    coalesce(r.is_direct, false),
    sum(r.qty * (1 - coalesce(r.discount, 0))),
    sum(r.qty),
    sum(coalesce(r.bonus_qty, 0)),
    sum(case when coalesce(r.is_direct, false) then r.value else 0 end),
    count(*)
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
  where r.batch_id = p_batch_id
  group by
    r.batch_id, b.period, r.distributor_code, r.official_line, r.region_code,
    r.area_code, r.brick_id, r.product_code, coalesce(r.is_direct, false);

  insert into public.source_of_sales_customer_presence_rollup
    (batch_id, period, client_code, official_line, region_code, present_any, present_nonexcluded)
  select
    r.batch_id,
    b.period,
    r.client_code,
    coalesce(r.official_line, ''),
    coalesce(r.region_code, ''),
    true,
    -- a customer is "non-excluded present" if any of their rows survives the
    -- canonical confidential-product filter; a NULL product never survives it.
    bool_or(coalesce(upper(btrim(r.product_code)) <> all (array['LA003','LA004','SS001']), false))
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
  where r.batch_id = p_batch_id and r.client_code is not null
  group by
    r.batch_id, b.period, r.client_code, coalesce(r.official_line, ''), coalesce(r.region_code, '');
end;
$function$;

revoke all on function public.phx_refresh_sos_fact_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_fact_rollup(uuid) to service_role;

-- Full rebuild across every validated batch (one-shot backfill + safety reconcile).
create or replace function public.phx_backfill_sos_fact_rollup()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  rec record;
begin
  for rec in
    select id
    from public.source_of_sales_import_batches
    where status = 'validated' and period is not null
  loop
    perform public.phx_refresh_sos_fact_rollup(rec.id);
  end loop;
end;
$function$;

revoke all on function public.phx_backfill_sos_fact_rollup() from public, anon, authenticated;
grant execute on function public.phx_backfill_sos_fact_rollup() to service_role;
