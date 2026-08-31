-- Territory Sync's reconciliation proof compares quantities only, never geography.
--
-- WHAT IS WRONG. phx_sync_sos_run's re-stamp UPDATE writes ONLY geography — brick_id, area_code,
-- area_name, region_code, region_name. It never touches qty or discount. phx_sync_sos_reconciliation
-- then "proves" the sync by comparing total_qty, effective_units and row_count per
-- (official_line, period). Those three are mathematically INVARIANT under a geography-only update,
-- so the proof cannot fail for any geography, right or wrong — it certifies the one thing the sync
-- does not change and is blind to the only thing it does.
--
-- Measured on production 2026-08-31, on the rollup's exact grain
-- (batch_id, period, distributor_code, client_code, product_code, is_direct):
--
--   period    rows whose brick disagrees with their own rollup row
--   2026-07   947        2026-06   863        2026-05   847        2026-04   802
--   2026-03   753        2026-01    48        2026-02     5        2026-08     0
--
-- 4,265 rows in total — and phx_sync_sos_reconciliation returned reconciled = true for 11 of the
-- 12 line-periods covering them. The operator-facing message reads "Already correct... All lines
-- reconcile." The nightly cron-job.org job (20 3 * * *) has been reporting exactly that.
--
-- THE FIX. Return the geography drift alongside the quantity columns, on the rollup's own grain, so
-- the caller can refuse to call a line reconciled while its rows disagree with the rollup they were
-- summarised into. Two counts, because they answer different questions:
--
--   geo_mismatch_rows    import rows whose brick/area/region differs from their rollup row. The
--                        headline number: these are rows the drilldown presents under the wrong
--                        geography.
--   unrollup_rows        import rows that join to NO rollup row at all — a grain group the rollup
--                        rebuild missed entirely (6 such rows exist in 2026-07). Distinct from a
--                        mismatch, and an inner join would hide it, so it is counted separately.
--
-- Comparison is NULL-safe (`is distinct from`) on trimmed, null-if-blank values, mirroring how
-- phx_refresh_sos_customer_directory_rollup builds the rollup: geography there is
-- array_agg(nullif(btrim(col),'') order by (... is null), created_at desc)[1], i.e. the most recent
-- non-blank value in the group. So a group is consistent exactly when every row already carries
-- that same value.
--
-- The return type gains columns, so this is DROP + CREATE rather than CREATE OR REPLACE. Grants are
-- re-applied below: service_role only, matching every other phx_* SoS RPC.

drop function if exists public.phx_sync_sos_reconciliation(text[]);

create function public.phx_sync_sos_reconciliation(
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
  raw_row_count          bigint,
  geo_mismatch_rows      bigint,
  unrollup_rows          bigint
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
  ),
  -- Every validated import row, keyed on the rollup's exact grain so the left join below is
  -- apples-to-apples with phx_refresh_sos_customer_directory_rollup.
  rows_keyed as (
    select
      r.batch_id,
      coalesce(nullif(btrim(r.invoice_period), ''), '')                       as period,
      coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
      nullif(btrim(r.client_code), '')                                        as client_code,
      coalesce(nullif(upper(btrim(r.product_code)), ''), '')                  as product_code,
      coalesce(r.is_direct, false)                                            as is_direct,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown')                 as official_line,
      nullif(btrim(r.brick_id), '')                                           as brick_id,
      nullif(btrim(r.area_code), '')                                          as area_code,
      nullif(btrim(r.region_code), '')                                        as region_code
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where (p_periods is null or coalesce(nullif(btrim(r.invoice_period), ''), '') = any (p_periods))
      and nullif(btrim(r.client_code), '') is not null
  ),
  geo as (
    select
      k.official_line,
      k.period,
      count(*) filter (
        where d.batch_id is not null
          and (   k.brick_id    is distinct from d.brick_id
               or k.area_code   is distinct from d.area_code
               or k.region_code is distinct from d.region_code )
      )::bigint as geo_mismatch_rows,
      count(*) filter (where d.batch_id is null)::bigint as unrollup_rows
    from rows_keyed k
    left join public.source_of_sales_customer_directory_rollup d
      on  d.batch_id         = k.batch_id
      and d.period           = k.period
      and d.distributor_code = k.distributor_code
      and d.client_code      = k.client_code
      and d.product_code     = k.product_code
      and d.is_direct        = k.is_direct
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
    coalesce(raw.row_count, 0)                       as raw_row_count,
    coalesce(geo.geo_mismatch_rows, 0)               as geo_mismatch_rows,
    coalesce(geo.unrollup_rows, 0)                   as unrollup_rows
  from roll
  full outer join raw using (official_line, period)
  left join geo
    on  geo.official_line = coalesce(roll.official_line, raw.official_line)
    and geo.period        = coalesce(roll.period, raw.period);
$function$;

revoke execute on function public.phx_sync_sos_reconciliation(text[]) from public, anon, authenticated;
grant execute on function public.phx_sync_sos_reconciliation(text[]) to service_role;

comment on function public.phx_sync_sos_reconciliation(text[]) is
  'Read-only proof for Territory Sync. Compares the customer-directory rollup against the raw '
  'validated import rows per official_line x period: quantities (total_qty, effective_units, '
  'row_count) AND geography (geo_mismatch_rows = rows whose brick/area/region differs from their '
  'own rollup row; unrollup_rows = rows with no rollup row at all). The geography columns exist '
  'because the re-stamp changes ONLY geography, so a quantity-only comparison is invariant under '
  'it and certified 4,265 mis-stamped rows as reconciled on 2026-08-31.';
