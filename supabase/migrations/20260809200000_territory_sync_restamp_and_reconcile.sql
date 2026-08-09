-- Territory & Sales Drilldown — one-button "Sync" support.
--
-- The Territory Drilldown reads source_of_sales_customer_directory_rollup, whose geography
-- (brick_id/area_code/region_code) is a materialised copy of source_of_sales_import_rows. When a
-- brick is moved between areas, relocateBrick (src/lib/sales/master-data/import-service.ts) only
-- re-stamps source_of_sales_customer_map — the import rows and every rollup keep the OLD area, so
-- the drilldown attributes those sales to yesterday's geography. The owner's standing rule is
-- "today's geography always".
--
-- The canonical fix already exists per-customer: sos_reconcile_import_rows_from_customer_map
-- re-points one (distributor, customer)'s import rows from the ACTIVE customer_map, and the caller
-- then refreshes that batch's rollups (phx_refresh_sos_fact_rollup +
-- phx_refresh_sos_customer_directory_rollup + phx_refresh_marketing_roi_facts). Running that
-- per-customer across ~52k mappings would be ~52k round trips, so this migration adds a single
-- SET-BASED equivalent plus a read-only reconciliation proof the "Sync" button can show.
--
-- 1) phx_sync_sos_restamp_import_rows(p_periods) — set-based re-stamp of import_rows from the
--    active customer_map (byte-for-byte the same column logic as
--    sos_reconcile_import_rows_from_customer_map, just without the single-customer WHERE). Returns
--    updated_rows + affected_batch_ids so the app can refresh exactly the touched batches. It is
--    idempotent: only rows whose brick actually differs are written, so pressing Sync when the
--    data is already correct updates nothing. Safe because there is exactly one active mapping per
--    (distributor, customer) (unique-verified 2026-08-09: 0 pairs with >1 active row), so the join
--    cannot fan out.
--
-- 2) phx_sync_sos_reconciliation(p_periods) — read-only proof. Per official_line x period it sums
--    the rebuilt directory rollup against the raw validated import rows on the SAME grain
--    (total_qty, effective_units, row_count). After a successful sync the two sides must match
--    exactly; any drift is a real inconsistency the caller surfaces instead of hiding.
--
-- Both are service_role-only, matching every other phx_* SoS RPC.

create or replace function public.phx_sync_sos_restamp_import_rows(
  p_periods text[] default null
)
returns table (updated_rows integer, affected_batch_ids uuid[])
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
    -- One active mapping per (distributor, customer) — see the migration header for why this
    -- cannot fan out. Mirrors sos_reconcile_import_rows_from_customer_map's target CTE exactly.
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
      -- Only touch rows whose geography actually moved — keeps the write set (and the affected
      -- batch list, and therefore the rollup refresh) minimal and makes repeat runs a no-op.
      and r.brick_id is distinct from t.brick_id
      and (p_periods is null or r.invoice_period = any (p_periods))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$function$;

revoke execute on function public.phx_sync_sos_restamp_import_rows(text[]) from public, anon, authenticated;
grant execute on function public.phx_sync_sos_restamp_import_rows(text[]) to service_role;

create or replace function public.phx_sync_sos_reconciliation(
  p_periods text[] default null
)
returns table (
  official_line          text,
  period                 text,
  rollup_total_qty       numeric,
  raw_total_qty          numeric,
  rollup_effective_units numeric,
  raw_effective_units    numeric,
  rollup_row_count       bigint,
  raw_row_count          bigint
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
  with roll as (
    select
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      r.period,
      sum(r.total_qty)       as total_qty,
      sum(r.effective_units) as effective_units,
      sum(r.row_count)::bigint as row_count
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where (p_periods is null or r.period = any (p_periods))
      and nullif(btrim(r.client_code), '') is not null
    group by 1, 2
  ),
  raw as (
    -- The exact grain and filters phx_refresh_sos_customer_directory_rollup rebuilds from, so a
    -- faithful rollup reconciles to zero difference here.
    select
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.invoice_period), ''), '')       as period,
      sum(coalesce(r.qty, 0))                                       as total_qty,
      sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0)))       as effective_units,
      count(*)::bigint                                              as row_count
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where (p_periods is null or coalesce(nullif(btrim(r.invoice_period), ''), '') = any (p_periods))
      and nullif(btrim(r.client_code), '') is not null
    group by 1, 2
  )
  select
    coalesce(roll.official_line, raw.official_line)  as official_line,
    coalesce(roll.period, raw.period)                as period,
    coalesce(roll.total_qty, 0)                      as rollup_total_qty,
    coalesce(raw.total_qty, 0)                       as raw_total_qty,
    coalesce(roll.effective_units, 0)                as rollup_effective_units,
    coalesce(raw.effective_units, 0)                 as raw_effective_units,
    coalesce(roll.row_count, 0)                      as rollup_row_count,
    coalesce(raw.row_count, 0)                       as raw_row_count
  from roll
  full outer join raw using (official_line, period);
$function$;

revoke execute on function public.phx_sync_sos_reconciliation(text[]) from public, anon, authenticated;
grant execute on function public.phx_sync_sos_reconciliation(text[]) to service_role;
