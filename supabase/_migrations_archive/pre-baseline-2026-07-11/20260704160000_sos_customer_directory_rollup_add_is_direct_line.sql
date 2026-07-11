-- Rollup-completion (PR 2): extend source_of_sales_customer_directory_rollup's grain so
-- it can fully serve phx_si_customers / phx_si_customer_product (both filter is_direct =
-- false, and both filter by line). The table previously blended direct + indirect rows
-- together with no official_line, which made it unusable for those two raw-scanning
-- functions. Both new columns follow the table's existing conventions:
--   - is_direct becomes a GRAIN dimension (like product_code already is), splitting the
--     per-batch aggregation instead of blending it.
--   - official_line becomes a "picked latest attribute" (same array_agg-ordered-by-recency
--     pattern already used for brick_id / area_code / region_code / client_name), since a
--     product effectively belongs to one line and this only needs a stable pick.
-- This migration only changes schema + the two refresh functions; it does NOT touch
-- existing row data (fully rebuilt by the paired backfill migration that follows).

alter table public.source_of_sales_customer_directory_rollup
  add column if not exists is_direct boolean not null default false,
  add column if not exists official_line text;

alter table public.source_of_sales_customer_directory_rollup
  drop constraint source_of_sales_customer_directory_rollup_pkey;

alter table public.source_of_sales_customer_directory_rollup
  add constraint source_of_sales_customer_directory_rollup_pkey
  primary key (batch_id, period, distributor_code, client_code, product_code, is_direct);

create or replace function public.phx_refresh_sos_customer_directory_rollup(p_batch_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $function$
begin
  delete from public.source_of_sales_customer_directory_rollup
  where batch_id = p_batch_id;

  insert into public.source_of_sales_customer_directory_rollup (
    batch_id,
    period,
    distributor_code,
    client_code,
    product_code,
    is_direct,
    client_name,
    client_address,
    brick_id,
    area_code,
    region_code,
    official_line,
    latest_row_created_at,
    effective_units,
    total_qty,
    row_count
  )
  select
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), '') as period,
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
    nullif(btrim(r.client_code), '') as client_code,
    coalesce(nullif(upper(btrim(r.product_code)), ''), '') as product_code,
    coalesce(r.is_direct, false) as is_direct,
    (array_agg(nullif(btrim(r.client_name), '') order by (nullif(btrim(r.client_name), '') is null), r.created_at desc nulls last))[1] as client_name,
    (array_agg(nullif(btrim(r.client_address), '') order by (nullif(btrim(r.client_address), '') is null), r.created_at desc nulls last))[1] as client_address,
    (array_agg(nullif(btrim(r.brick_id), '') order by (nullif(btrim(r.brick_id), '') is null), r.created_at desc nulls last))[1] as brick_id,
    (array_agg(nullif(btrim(r.area_code), '') order by (nullif(btrim(r.area_code), '') is null), r.created_at desc nulls last))[1] as area_code,
    (array_agg(nullif(btrim(r.region_code), '') order by (nullif(btrim(r.region_code), '') is null), r.created_at desc nulls last))[1] as region_code,
    (array_agg(nullif(btrim(r.official_line), '') order by (nullif(btrim(r.official_line), '') is null), r.created_at desc nulls last))[1] as official_line,
    max(coalesce(r.created_at, b.created_at, 'epoch'::timestamptz)) as latest_row_created_at,
    sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0))) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where r.batch_id = p_batch_id
    and nullif(btrim(r.client_code), '') is not null
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), ''),
    coalesce(r.is_direct, false);
end;
$function$;

create or replace function public.phx_backfill_sos_customer_directory_rollup()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '120s'
as $function$
begin
  delete from public.source_of_sales_customer_directory_rollup;

  insert into public.source_of_sales_customer_directory_rollup (
    batch_id,
    period,
    distributor_code,
    client_code,
    product_code,
    is_direct,
    client_name,
    client_address,
    brick_id,
    area_code,
    region_code,
    official_line,
    latest_row_created_at,
    effective_units,
    total_qty,
    row_count
  )
  select
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), '') as period,
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
    nullif(btrim(r.client_code), '') as client_code,
    coalesce(nullif(upper(btrim(r.product_code)), ''), '') as product_code,
    coalesce(r.is_direct, false) as is_direct,
    (array_agg(nullif(btrim(r.client_name), '') order by (nullif(btrim(r.client_name), '') is null), r.created_at desc nulls last))[1] as client_name,
    (array_agg(nullif(btrim(r.client_address), '') order by (nullif(btrim(r.client_address), '') is null), r.created_at desc nulls last))[1] as client_address,
    (array_agg(nullif(btrim(r.brick_id), '') order by (nullif(btrim(r.brick_id), '') is null), r.created_at desc nulls last))[1] as brick_id,
    (array_agg(nullif(btrim(r.area_code), '') order by (nullif(btrim(r.area_code), '') is null), r.created_at desc nulls last))[1] as area_code,
    (array_agg(nullif(btrim(r.region_code), '') order by (nullif(btrim(r.region_code), '') is null), r.created_at desc nulls last))[1] as region_code,
    (array_agg(nullif(btrim(r.official_line), '') order by (nullif(btrim(r.official_line), '') is null), r.created_at desc nulls last))[1] as official_line,
    max(coalesce(r.created_at, b.created_at, 'epoch'::timestamptz)) as latest_row_created_at,
    sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0))) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where nullif(btrim(r.client_code), '') is not null
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), ''),
    coalesce(r.is_direct, false);
end;
$function$;
