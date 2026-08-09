-- Territory Sync — atomic single-round-trip runner.
--
-- The first sync implementation orchestrated the re-stamp and the per-batch rollup refreshes from
-- the app: one RPC for the re-stamp, then N*3 more RPCs (fact + directory + roi per affected batch)
-- in a JS loop. That has two failure modes, both hit in production 2026-08-09:
--   1. The app's Supabase client aborts a request after 15s. The re-stamp UPDATE of a large backlog
--      (~14k rows) exceeds that, so the client throws "request timed out".
--   2. Postgres nonetheless commits the re-stamp, but the client has already errored, so the rollup
--      refresh loop never runs — leaving import_rows on today's geography while the rollups the
--      drilldown reads keep the old geography. A silent half-applied state, with no audit row.
--
-- phx_sync_sos_run collapses the whole operation into ONE plpgsql function — therefore ONE
-- transaction and ONE Atlantic round trip. Either everything commits (re-stamp AND every affected
-- batch's rollups) or nothing does: a timeout now rolls back cleanly instead of half-applying. It
-- reuses the exact same re-stamp logic as phx_sync_sos_restamp_import_rows and the same canonical
-- refresh trio the normalizer uses.

create or replace function public.phx_sync_sos_run(
  p_periods text[] default null
)
returns table (restamped_rows integer, refreshed_batches integer)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
  v_batch uuid;
  v_refreshed integer := 0;
begin
  -- 1) Re-stamp import rows to today's geography (identical column logic to
  --    phx_sync_sos_restamp_import_rows / sos_reconcile_import_rows_from_customer_map).
  with target as (
    select
      m.distributor_code,
      m.customer_code,
      m.brick_id,
      b.area_code,
      b.region_code,
      a.area_name,
      g.region_name
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.active
      and m.brick_id is not null
  ),
  updated as (
    update public.source_of_sales_import_rows r
    set brick_id = t.brick_id,
        area_code = t.area_code,
        area_name = coalesce(t.area_name, r.area_name),
        region_code = t.region_code,
        region_name = coalesce(t.region_name, r.region_name)
    from target t
    where r.distributor_code = t.distributor_code
      and r.client_code = t.customer_code
      and r.brick_id is distinct from t.brick_id
      and (p_periods is null or r.invoice_period = any (p_periods))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  -- 2) Rebuild the canonical refresh trio for exactly the touched batches, in the SAME
  --    transaction as the re-stamp above.
  if array_length(v_batches, 1) is not null then
    foreach v_batch in array v_batches loop
      perform public.phx_refresh_sos_fact_rollup(v_batch);
      perform public.phx_refresh_sos_customer_directory_rollup(v_batch);
      perform public.phx_refresh_marketing_roi_facts(v_batch);
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

revoke execute on function public.phx_sync_sos_run(text[]) from public, anon, authenticated;
grant execute on function public.phx_sync_sos_run(text[]) to service_role;
