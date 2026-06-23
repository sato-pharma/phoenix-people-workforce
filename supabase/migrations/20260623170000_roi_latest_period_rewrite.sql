-- perf: rewrite phx_marketing_roi_latest_validated_period to query the tiny
-- source_of_sales_import_batches table instead of scanning the full 410MB
-- source_of_sales_import_rows table.
-- The latest validated period = the period of the latest validated batch.
-- source_of_sales_import_batches has ~10-50 rows; the original query scanned millions.

create or replace function public.phx_marketing_roi_latest_validated_period()
returns text
language sql
stable
set search_path to 'public'
as $function$
  select max(period)
  from public.source_of_sales_import_batches
  where status = 'validated';
$function$;
