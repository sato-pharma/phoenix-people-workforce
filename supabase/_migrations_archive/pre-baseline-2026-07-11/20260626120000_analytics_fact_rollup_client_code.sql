-- Delta: add client_code dimension to the SoS fact rollup.
--
-- The original 20260624090000 migration created source_of_sales_fact_rollup without
-- client_code in the grain (the column already existed in source_of_sales_import_rows
-- but was not forwarded). This migration:
--   1. Adds the client_code column to the rollup table.
--   2. Drops the old 8-column grain uniqueness index and replaces it with a 9-column
--      one that includes client_code — so per-customer granularity is preserved when
--      the same (dist, line, region, area, brick, product, is_direct) combination
--      appears for multiple customers.
--   3. Re-deploys phx_refresh_sos_fact_rollup to INSERT/GROUP BY client_code.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.

begin;

-- ── 1. Add client_code column ─────────────────────────────────────────────────

alter table public.source_of_sales_fact_rollup
  add column if not exists client_code text;

-- ── 2. Rebuild grain uniqueness index to include client_code ──────────────────

drop index if exists source_of_sales_fact_rollup_grain_uniq;

create unique index if not exists source_of_sales_fact_rollup_grain_uniq
  on public.source_of_sales_fact_rollup
  (batch_id, distributor_code, official_line, region_code, area_code, brick_id,
   client_code, product_code, is_direct)
  nulls not distinct;

-- ── 3. Re-deploy phx_refresh_sos_fact_rollup with client_code ─────────────────

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
     client_code, product_code, product_name, is_direct,
     effective_units, total_qty, total_bonus_qty, direct_value, row_count)
  select
    r.batch_id,
    b.period,
    r.distributor_code,
    r.official_line,
    r.region_code,
    r.area_code,
    r.brick_id,
    r.client_code,
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
    r.area_code, r.brick_id, r.client_code, r.product_code, coalesce(r.is_direct, false);

  insert into public.source_of_sales_customer_presence_rollup
    (batch_id, period, client_code, official_line, region_code, present_any, present_nonexcluded)
  select
    r.batch_id,
    b.period,
    r.client_code,
    coalesce(r.official_line, ''),
    coalesce(r.region_code, ''),
    true,
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

commit;
