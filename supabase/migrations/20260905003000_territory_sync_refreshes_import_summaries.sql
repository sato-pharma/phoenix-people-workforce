-- Source of Sales: the nightly territory re-stamp refreshed six rollups and forgot the seventh.
--
-- THE DEFECT
-- `phx_sync_sos_run` re-stamps region_code / area_code / brick_id on source_of_sales_import_rows
-- from the live customer map, then loops over every touched batch and refreshes:
--
--     phx_refresh_sos_fact_rollup                 -- Monthly Closing, achievement, incentives
--     phx_refresh_sos_customer_directory_rollup
--     phx_refresh_marketing_roi_facts
--     phx_refresh_sos_channel_rollup
--     phx_refresh_sos_distributor_product_rollup
--     phx_refresh_monthly_attribution
--
-- It does NOT refresh `source_of_sales_import_summaries`. That is the table the Source of Sales
-- DASHBOARD reads (buildSourceOfSalesDashboard's byArea / byRegion / byBrick / byLine / byProduct,
-- and the geoSource fallback in src/lib/sales/monthly-distributor-import.ts).
--
-- So a mapping correction rebuilt everything the closing reads and nothing the dashboard reads.
-- The re-map succeeds everywhere except the one table on screen, which means a correct fix looks
-- like it never took. It recurs on every nightly run and never self-heals.
--
-- This is the same class of defect as migration 20260831000500, which created
-- phx_refresh_sos_import_summaries precisely because the summaries had no update path at all.
-- That function has existed since 2026-08-31 00:05. phx_sync_sos_run was last edited at
-- 20260831160000 — sixteen hours LATER — and still did not call it.
--
-- MEASURED ON PRODUCTION, 2026-09-04 (ozucdzovmcqvepbozvqf), validated batches only:
--
--     period    areas wrong    value under the wrong area
--     2026-01        37                    147,688.12
--     2026-02        32                     65,245.20
--     2026-03        28                    188,838.74
--     2026-04        25                    123,628.74
--     2026-05        27                    122,211.79
--     2026-06        39                    203,867.72
--     2026-07        41                    219,363.71
--     2026-08         0                          0.00   (imported after the last re-stamp)
--                                        ------------
--                                          1,070,845.02
--
-- Seven months, not the three an earlier note claimed. For 2026-07: 30 areas gained exactly what
-- 11 areas lost, the net is 0.00 and the row-count net is 0. The month TOTAL is right on both
-- sides to the penny (61,641,432.23) — only the split is wrong. No value is lost or invented
-- anywhere; it is credited to the wrong area name.
--
-- WHO SEES IT, AND WHY IT IS THE WORST POSSIBLE AUDIENCE
-- loadSourceOfSalesDashboard calls the live-geography RPC only when the viewer CANNOT see
-- restricted products or the Head Office line. Super Admin and the CEO fail that condition, so
-- they fall back to these stale summaries. The SFE Manager, who is filtered, gets the re-stamped
-- rows. The privilege gradient is inverted: the two people who sign off the month see the stale
-- split, and nothing on either page says the two views differ.
--
-- THE FIX
-- One statement inside the existing per-batch loop, using the same call convention
-- phx_finalize_sos_batch already uses (`perform public.phx_refresh_sos_import_summaries(...)`).
--
-- NOT CHANGED, DELIBERATELY: phx_rebuild_direct_order_sos_batch. It calls
-- phx_finalize_sos_batch, which already refreshes the summaries — adding a second call there
-- would be redundant. Verified against the live function body, not assumed.
--
-- The rest of this body is the live 2026-08-31 definition reproduced verbatim.

create or replace function public.phx_sync_sos_run(p_periods text[] default null::text[])
returns table(restamped_rows integer, refreshed_batches integer)
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
      -- Any of the three CODES, not brick alone: a re-parented brick keeps its id and changes area.
      and (   r.brick_id    is distinct from t.brick_id
           or r.area_code   is distinct from t.area_code
           or r.region_code is distinct from t.region_code )
      and (p_periods is null or r.invoice_period = any (p_periods))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  if array_length(v_batches, 1) is not null then
    foreach v_batch in array v_batches loop
      perform public.phx_refresh_sos_fact_rollup(v_batch);
      perform public.phx_refresh_sos_customer_directory_rollup(v_batch);
      perform public.phx_refresh_marketing_roi_facts(v_batch);
      perform public.phx_refresh_sos_channel_rollup(v_batch);
      perform public.phx_refresh_sos_distributor_product_rollup(v_batch);
      perform public.phx_refresh_monthly_attribution(v_batch);
      -- THE FIX. The dashboard's own aggregate, refreshed from the rows this run just re-stamped,
      -- exactly as phx_finalize_sos_batch does at import time. Without it the six refreshes above
      -- correct every number the closing reads and none of the numbers on screen.
      --
      -- Period-safe: phx_refresh_sos_import_summaries recomputes ONLY from this batch's own rows
      -- (its single outward join is to source_of_sales_bricks, for the brick NAME). It never
      -- resolves geography at the run date, so it cannot re-date a closed month — the period
      -- filtering stays where it already is, on the re-stamp above.
      perform public.phx_refresh_sos_import_summaries(v_batch);
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

-- CREATE OR REPLACE preserves the live ACL, so these two lines change nothing on an existing
-- database. They are required for a FRESH replay: on a new database the function is created with
-- the default ACL, which grants EXECUTE to PUBLIC, and anon/authenticated inherit through PUBLIC
-- membership — so revoking only those two is a no-op. Revoking PUBLIC on a default ACL also strips
-- service_role, hence the explicit re-grant. Same pattern as 20260831160000, this body's source.
revoke execute on function public.phx_sync_sos_run(text[]) from public, anon, authenticated;
grant  execute on function public.phx_sync_sos_run(text[]) to service_role;

comment on function public.phx_sync_sos_run(text[]) is
  'Re-stamps source_of_sales_import_rows from the customer map + brick master, then rebuilds the '
  'rollups for every batch touched. The UPDATE fires when the brick OR the area code OR the region '
  'code differs — gating on brick alone let an area re-parent (same brick, new area) go un-stamped '
  'forever, which stranded 14 rows / EGP 5,274.90 in 2026-07 while the sync reported 0 re-stamped. '
  'area_name/region_name are written but deliberately NOT in the predicate: no rollup carries a name. '
  'Refreshes SEVEN rollups, not six: source_of_sales_import_summaries is the Source of Sales '
  'dashboard''s own aggregate, and it was omitted until 20260905003000 — so a mapping correction '
  'rebuilt everything the monthly closing reads and nothing the dashboard reads.';
