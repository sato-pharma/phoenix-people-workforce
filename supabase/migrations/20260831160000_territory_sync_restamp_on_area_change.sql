-- Territory re-stamp fires only when brick_id changes, so an area re-parent never reaches sales rows.
--
-- WHAT IS WRONG. All three functions that re-stamp source_of_sales_import_rows build a `target` CTE
-- that computes the CORRECT geography for a customer — brick_id, area_code, region_code and their
-- names — by joining customer_map to the brick master. The SET clause then writes all five columns.
-- But the WHERE clause gates the whole UPDATE on ONE of them:
--
--     and r.brick_id is distinct from t.brick_id
--
-- So a customer whose brick was RE-PARENTED — same brick, new area — is skipped. The brick master is
-- updated (source_of_sales_bricks.area_code cascades from blocks, which cascades from areas, both
-- ON UPDATE CASCADE), the target CTE computes the new area correctly, and the row is then never
-- touched because its brick_id still matches. Block Master's "Edit Area Code" re-parent is a live
-- admin action, and no trigger and no other writer compensates: sos_backfill_import_rows_from_
-- customer_map only fills a MISSING brick, never re-points an existing one.
--
-- The stale stamp is not cosmetic. phx_sos_rows_attributed reads area_code/region_code straight off
-- import_rows, so it lands verbatim in source_of_sales_fact_rollup and every rollup built from it.
-- And phx_sync_sos_reconciliation groups by (official_line, period) only, so the proof cannot see an
-- area error — the sync reports restamped_rows = 0 and "all lines reconcile" while the rows are wrong.
--
-- Measured on production 2026-08-31, rows whose brick matches but whose stamped CODE does not:
--
--   period    line             brick     stamped -> brick master   rows   EGP
--   2026-07   Anti Infective   B193-M1   D14     -> D15               1    111.15
--   2026-07   Anti Infective   B220-2    CA1     -> CA2              13  5,163.75
--                                                                    14  5,274.90
--
-- Region is unchanged in both cases (D1, CA), so this is an area-level re-parent inside one region.
--
-- THE FIX. Fire the UPDATE when the brick OR the area code OR the region code differs.
--
-- WHY THE NAME COLUMNS ARE DELIBERATELY NOT IN THE PREDICATE. area_name/region_name on import_rows
-- disagree with the brick master on a further 8,824 rows across 2026-01..07 — almost all of them a
-- pre-split snapshot ("Fayoum-Beni Suef" where the master now says "Fayoum" or "Beni Suef", on ALL
-- four lines including Head Office). Those are NOT re-stamped here, for a measured reason: none of
-- the four rollups — fact, customer_directory, channel, distributor_product — carries area_name or
-- region_name at all. They key on the CODES, and display names are resolved from
-- source_of_sales_areas/_regions by code at read time. So a stale NAME on import_rows reaches no
-- report and no closing, while a stale CODE reaches all of them. Adding the names to the predicate
-- would rewrite 8,824 rows of closed history for no downstream effect and would put a large, noisy,
-- un-reviewable write in front of the 14 rows that actually matter.
--
-- The names still follow a row that IS re-stamped: the SET clause is unchanged, so when a code moves
-- its name moves with it. That is required — leaving CA2 labelled with CA1's old name would be worse
-- than either state on its own.
--
-- Signatures and return types are unchanged, so CREATE OR REPLACE is correct here (unlike the
-- reconciliation function in 20260831143000, whose return type gained columns). CREATE OR REPLACE
-- preserves the existing ACL; the grants below are re-applied explicitly so this file states the
-- intended end state rather than depending on it. Both match production today: service_role only.

-- 1) The main entry point: re-stamp, then rebuild the rollups for every batch it touched.
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
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

-- 2) Re-stamp only, no rollup rebuild. Same predicate, or the two drift apart.
create or replace function public.phx_sync_sos_restamp_import_rows(p_periods text[] default null::text[])
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
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
      and (   r.brick_id    is distinct from t.brick_id
           or r.area_code   is distinct from t.area_code
           or r.region_code is distinct from t.region_code )
      and (p_periods is null or r.invoice_period = any (p_periods))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$function$;

-- 3) Single-customer reconcile, called from the mapping editor after a customer's brick is set.
create or replace function public.sos_reconcile_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
begin
  with target as (
    select m.brick_id, b.area_code, b.region_code, a.area_name, g.region_name
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.distributor_code = p_distributor
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
    limit 1
  ),
  updated as (
    update public.source_of_sales_import_rows r
    set brick_id = t.brick_id,
        area_code = t.area_code,
        area_name = coalesce(t.area_name, r.area_name),
        region_code = t.region_code,
        region_name = coalesce(t.region_name, r.region_name)
    from target t
    where r.distributor_code = p_distributor
      and r.client_code = p_customer
      and (   r.brick_id    is distinct from t.brick_id
           or r.area_code   is distinct from t.area_code
           or r.region_code is distinct from t.region_code )
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$function$;

revoke execute on function public.phx_sync_sos_run(text[]) from public, anon, authenticated;
grant  execute on function public.phx_sync_sos_run(text[]) to service_role;

revoke execute on function public.phx_sync_sos_restamp_import_rows(text[]) from public, anon, authenticated;
grant  execute on function public.phx_sync_sos_restamp_import_rows(text[]) to service_role;

revoke execute on function public.sos_reconcile_import_rows_from_customer_map(text, text) from public, anon, authenticated;
grant  execute on function public.sos_reconcile_import_rows_from_customer_map(text, text) to service_role;

comment on function public.phx_sync_sos_run(text[]) is
  'Re-stamps source_of_sales_import_rows from the customer map + brick master, then rebuilds the '
  'rollups for every batch touched. The UPDATE fires when the brick OR the area code OR the region '
  'code differs — gating on brick alone let an area re-parent (same brick, new area) go un-stamped '
  'forever, which stranded 14 rows / EGP 5,274.90 in 2026-07 while the sync reported 0 re-stamped. '
  'area_name/region_name are written but deliberately NOT in the predicate: no rollup carries a name.';
