-- phx_refresh_sos_fact_rollup_takes_a_batch_lock
--
-- WHAT THIS CHANGES: `public.phx_refresh_sos_fact_rollup` takes a transaction-scoped advisory lock keyed on its
--   own name and the batch id before it touches a row. Nothing else in the body changes: it is the
--   definition production runs today (read with pg_get_functiondef on 2026-10-23, identical to
--   20260907190000 apart from line endings, plus the 120s statement_timeout 20261013130000 set,
--   restated here because CREATE OR REPLACE resets a function's SET clauses) with one line added after `begin`.
--
-- WHY (technical audit, 2026-10-23, P4-04): this is the per-batch rebuild of source_of_sales_fact_rollup and source_of_sales_customer_presence_rollup — the base every Closing figure is summed from. It deletes the batch's rows and
--   inserts them again, with no lock. Two rebuilds of one batch at the same time — a mapping save
--   and an address correction, a retry beside a slow first attempt — each delete what is committed,
--   then each insert a full set, and the batch counts twice in every figure read from it. That is
--   the mechanism behind the 29 Sep doubled attribution. With the lock, the second rebuild waits
--   for the first to commit, then deletes ITS rows and writes one set — the result is the same as
--   running them one after the other. Different batches never wait on each other.
--
--   Only these three functions write the three rollups (read on production 2026-10-23: every
--   function whose body deletes from, inserts into or updates them). One function per file, because
--   guards in tests/ read "the newest migration that defines X" as a whole file.
--
-- ROLLBACK: re-apply the body from 20260907190000_units_are_units_drop_the_discount_factor.sql (and, for the fact rollup, 20261013130000's timeout).

begin;

CREATE OR REPLACE FUNCTION public.phx_refresh_sos_fact_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_period text;
  v_drift_rows bigint;
  v_drift_value numeric;
begin
  perform pg_advisory_xact_lock(hashtext('phx_refresh_sos_fact_rollup'), hashtext(p_batch_id::text));
  select b.period into v_period
  from public.source_of_sales_import_batches b
  where b.id = p_batch_id;

  delete from public.source_of_sales_fact_rollup where batch_id = p_batch_id;
  delete from public.source_of_sales_customer_presence_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_fact_rollup
    (batch_id, period, distributor_code, official_line, region_code, area_code, brick_id,
     client_code, product_code, product_name, is_direct,
     effective_units, total_qty, total_bonus_qty, direct_value, row_count)
  select
    a.batch_id,
    v_period,
    a.distributor_code,
    a.official_line,
    a.region_code,
    a.area_code,
    a.brick_id,
    a.client_code,
    a.product_code,
    max(a.product_name),
    a.is_direct,
    sum(a.qty),
    sum(a.qty),
    sum(coalesce(a.bonus_qty, 0)),
    sum(case when a.is_direct then a.value else 0 end),
    count(*)
  from public.phx_sos_rows_attributed(v_period) a
  where a.batch_id = p_batch_id
    and coalesce(a.validation_state, 'valid') <> 'failed'
  group by
    a.batch_id, a.distributor_code, a.official_line, a.region_code,
    a.area_code, a.brick_id, a.client_code, a.product_code, a.is_direct;

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

  select count(*), coalesce(sum(coalesce(r.value, 0)), 0)
    into v_drift_rows, v_drift_value
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
    and coalesce(nullif(btrim(r.invoice_period), ''), '') <> coalesce(v_period, '');

  if v_drift_rows > 0 then
    raise warning 'SoS period drift: batch % (period %) has % row(s) worth % on a different invoice_period; they are NOT in source_of_sales_fact_rollup. Run phx_sos_period_drift_count() for the breakdown.',
      p_batch_id, v_period, v_drift_rows, round(v_drift_value, 2);
  end if;
end;
$function$;

revoke execute on function public.phx_refresh_sos_fact_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_fact_rollup(uuid) to service_role;

commit;
