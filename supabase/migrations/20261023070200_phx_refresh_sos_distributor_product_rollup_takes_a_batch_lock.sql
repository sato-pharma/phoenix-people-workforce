-- phx_refresh_sos_distributor_product_rollup_takes_a_batch_lock
--
-- WHAT THIS CHANGES: `public.phx_refresh_sos_distributor_product_rollup` takes a transaction-scoped advisory lock keyed on its
--   own name and the batch id before it touches a row. Nothing else in the body changes: it is the
--   definition production runs today (read with pg_get_functiondef on 2026-10-23, identical to
--   20260815160000 apart from line endings and one comment line inside the body, dropped here so
--   the body is byte-for-byte the live one) with one line added after `begin`.
--
-- WHY (technical audit, 2026-10-23, P4-04): this is the per-batch rebuild of source_of_sales_distributor_product_rollup — the Monthly-Closing matrix. It deletes the batch's rows and
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
-- ROLLBACK: re-apply the body from 20260815160000_closing_distributor_product_rollup.sql (and, for the fact rollup, 20261013130000's timeout).

begin;

create or replace function public.phx_refresh_sos_distributor_product_rollup(p_batch_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '120s'
as $function$
begin
  perform pg_advisory_xact_lock(hashtext('phx_refresh_sos_distributor_product_rollup'), hashtext(p_batch_id::text));
  delete from public.source_of_sales_distributor_product_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_distributor_product_rollup
    (batch_id, line_key, official_line, period, distributor_code, region_code, area_code,
     product_code, product_name, units_qty, eff_units)
  select
    f.batch_id,
    lower(btrim(f.official_line))   as line_key,
    max(f.official_line)            as official_line,
    f.period,
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.product_code,
    max(f.product_name)             as product_name,
    sum(f.total_qty)                as units_qty,
    sum(f.effective_units)          as eff_units
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.batch_id = p_batch_id
    and not coalesce(f.is_direct, false)
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.batch_id, lower(btrim(f.official_line)), f.period,
           f.distributor_code, f.region_code, f.area_code, f.product_code;
end;
$function$;

revoke execute on function public.phx_refresh_sos_distributor_product_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_distributor_product_rollup(uuid) to service_role;

commit;
