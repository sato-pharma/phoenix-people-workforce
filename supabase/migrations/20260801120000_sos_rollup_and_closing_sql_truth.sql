-- Three SQL-layer defects behind wrong customer totals and stale attribution.
--
-- 1. DIRECT PRICED AT LIST. phx_closing_customers sums
--        sum(f.effective_units * coalesce(p.factory_price, 0))
--    with no `is_direct` branch, so Direct rows are re-priced at list instead of using the value the
--    sheet actually carried (f.direct_value) -- and Direct is folded in with distributor rows. Every
--    other reader of the rollup branches on is_direct (analytics.sos_fact, phx_exec_sos_trend).
--    Measured on production, Direct-at-list minus Direct-stored:
--
--        2026-01   +64,872      2026-02   +66,254      2026-03  +276,690
--        2026-04  -108,154      2026-06  +191,437
--
--    Note it errs in BOTH directions -- April is understated -- so this is a mis-pricing, not a
--    consistent overstatement, and it cannot be reasoned away as a rounding bias.
--
-- 2. BACKFILL CANNOT TRIGGER A ROLLUP REFRESH. sos_backfill_import_rows_from_customer_map moves an
--    import row's brick/area/region and returns only a row COUNT, so its caller
--    (backfillCustomerRows in normalizer/mapping.ts) has no way to know which batches to refresh.
--    The fact rollup therefore keeps the old geography and the sale keeps the old owner. Its sibling
--    sos_reconcile_import_rows_from_customer_map already solves this by returning affected_batch_ids,
--    and its caller refreshes per batch -- this brings the two into line.
--
--    Worth recording precisely, because the audit overstated it: this function only touches rows
--    where `r.brick_id is null`. It fills gaps, it never re-points an existing brick. So it is NOT
--    what produced the 1,698 rows currently disagreeing with the active customer map (154 of them in
--    a different AREA, i.e. a different rep, 585,776 EGP) -- that is the reconcile path's territory.
--    The defect here is real but narrower: a gap-fill silently fails to reach the rollup.
--
-- 3. FAILED ROWS COUNTED AS SALES. phx_refresh_sos_fact_rollup has no validation_state predicate, so
--    a row that failed validation would still roll up as revenue, while the import dashboard's geo
--    RPC excludes it. Production is 100% 'valid' today, so this is latent -- but it is one predicate
--    inside a function being rewritten anyway.
--
-- DELIBERATELY NOT CHANGED: the `r.invoice_period = b.period` join in phx_refresh_sos_fact_rollup,
-- which silently drops any row whose own period differs from its batch's. Removing it means choosing
-- whether the ROW's period or the BATCH's period is authoritative, and a batch spanning two months
-- carries a range string ("2026-06 to 2026-07") that is not a valid period key at all. 0 rows are
-- affected today, so guessing wrong would be strictly worse than the latent bug. Instead this adds
-- phx_sos_period_drift_count() so the landmine is monitorable and a future fix has a signal to
-- verify against.

begin;

-- ── 1. phx_closing_customers: price Direct as Direct ─────────────────────────
-- Same signature, so CREATE OR REPLACE -- but statement_timeout and search_path MUST be re-declared;
-- CREATE OR REPLACE silently drops them (the regression 20260728100500 exists to repair).
create or replace function public.phx_closing_customers(p_line text, p_period text)
returns table(client_code text, client_name text, distributor_code text, region_code text,
              area_code text, brick_id text, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with agg as (
    select
      f.client_code,
      f.distributor_code,
      max(f.region_code)  as rollup_region,
      max(f.area_code)    as rollup_area,
      max(f.brick_id)     as rollup_brick,
      sum(f.total_qty)    as units,
      -- Direct carries the value the sheet stated; only distributor rows are re-priced from the
      -- product master. This is the same branch analytics.sos_fact and phx_exec_sos_trend use.
      sum(
        case
          when coalesce(f.is_direct, false) then coalesce(f.direct_value, 0)
          else f.effective_units * coalesce(p.factory_price, 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by f.client_code, f.distributor_code
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(cm.region_code, a.rollup_region)  as region_code,
    coalesce(cm.area_code,   a.rollup_area)    as area_code,
    coalesce(cm.brick_id,    a.rollup_brick)   as brick_id,
    a.units,
    a.value
  -- Safe against fan-out: (distributor_code, customer_code) has 0 duplicate ACTIVE rows in
  -- production, verified before this change. If that ever stops being true this join doubles a
  -- customer's value, which is what the partial unique index tracked for a later phase prevents.
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$function$;

revoke execute on function public.phx_closing_customers(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_customers(text, text) to service_role;

-- ── 2. Backfill returns the batches it touched ───────────────────────────────
-- Return type changes, so the old signature must be dropped rather than replaced.
drop function if exists public.sos_backfill_import_rows_from_customer_map(text, text);

create function public.sos_backfill_import_rows_from_customer_map(
  p_distributor text,
  p_customer text
)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
begin
  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id    = m.brick_id,
        area_code   = b.area_code,
        area_name   = coalesce(a.area_name, r.area_name),
        region_code = b.region_code,
        region_name = coalesce(g.region_name, r.region_name)
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.distributor_code = p_distributor
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
      and r.distributor_code = p_distributor
      and r.client_code = p_customer
      -- Unchanged: this fills a MISSING brick, it never re-points an existing one. Re-pointing is
      -- sos_reconcile_import_rows_from_customer_map's job.
      and r.brick_id is null
    returning r.batch_id
  )
  select count(*)::integer, coalesce(array_agg(distinct batch_id), '{}')
  into v_count, v_batches
  from updated;

  updated_rows := v_count;
  affected_batch_ids := v_batches;
  return next;
end;
$function$;

revoke execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  to service_role;

-- ── 3. The rollup must not count failed rows ─────────────────────────────────
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
    -- A row that failed validation is not revenue. The import dashboard's geo RPC already excludes
    -- these; the rollup did not, so the two could disagree. 100% of production rows are 'valid'
    -- today, so this is a no-op now and a guard later.
    and coalesce(r.validation_state, 'valid') <> 'failed'
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
  where r.batch_id = p_batch_id
    and r.client_code is not null
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by
    r.batch_id, b.period, r.client_code, coalesce(r.official_line, ''), coalesce(r.region_code, '');
end;
$function$;

revoke execute on function public.phx_refresh_sos_fact_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_fact_rollup(uuid) to service_role;

-- ── 4. Make the period-drift landmine monitorable ────────────────────────────
-- Rows whose own invoice_period differs from their batch's period are silently excluded from BOTH
-- rollups by the join above. 0 today. This turns "silently wrong later" into a number something can
-- alert on, without guessing which period is authoritative.
create or replace function public.phx_sos_period_drift_count()
returns table(batch_period text, row_period text, rows bigint, value numeric)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  select b.period, r.invoice_period, count(*)::bigint, coalesce(sum(r.value), 0)
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id and b.status = 'validated'
  where coalesce(r.invoice_period, '~') <> coalesce(b.period, '~')
  group by b.period, r.invoice_period
  order by 3 desc;
$function$;

revoke execute on function public.phx_sos_period_drift_count() from public, anon, authenticated;
grant execute on function public.phx_sos_period_drift_count() to service_role;

commit;

notify pgrst, 'reload schema';
