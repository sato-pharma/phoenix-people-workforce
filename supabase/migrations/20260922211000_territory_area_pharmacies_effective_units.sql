-- RENAMED 2026-09-22: this file was 20260922210000_*. #4259 and #4263 each picked 20260922210000
-- independently and both merged, so `main` itself went red on check:migrations and every open PR
-- with it. THIS file moved rather than the other one, deliberately: 20260922213000_job_offer_house_
-- variant widens the very constraint 20260922210000_job_offer_sato_variant sets, and both ledgers
-- already hold the house migration under an EARLIER version than any new slot the sato file could
-- take — so renaming THAT one would let a later `db push` re-run it out of order and narrow the
-- constraint back, dropping 'house'. This migration is a bare CREATE OR REPLACE of the newest
-- definition of phx_territory_area_pharmacies, with nothing after it, so a re-run under the new
-- version simply re-establishes what is already live.
--
-- Territory Management's area pharmacies list must count a row's UNITS on the same basis it values
-- it: the credited-to-area effective units, never the raw total quantity.
--
-- THE DEFECT. phx_territory_area_pharmacies returned
--     units = sum(total_qty)                         -- the RAW quantity on the row
--     value = sum(effective_units * factory_price)   -- the CREDITED-to-area quantity, × price
-- so for any customer whose sale is split across areas — El Qema's warehouse bands and the city
-- rule (both locked) — the two columns came from different unit bases and disagreed. A wholesaler
-- read one number of units beside a value worth a different number, and the per-area total did not
-- reconcile with the closing, which credits by effective units.
--
-- MEASURED ON PRODUCTION BEFORE THIS RAN (ozucdzovmcqvepbozvqf, 2026-09-22, read-only):
--   · exactly 41 rows diverge, every one non-direct, all in split (El Qema) attributions; total gap
--     1,772.08 units. Example: client 3743 (الفرسان بنها جملة), LA001, D11, 2026-08 — total_qty 4,532
--     shown against a value built from effective_units 3,625.6.
--   · 0 direct rows diverge (a direct order is never split, so effective_units == total_qty there);
--     direct value stays source-valued, untouched by this change.
--   · effective_units is NEVER NULL where total_qty is populated (0 rows), so no row is zeroed.
--   · every other one of the ~234,000 rows already has total_qty == effective_units, so nothing but
--     those 41 split rows moves.
--
-- THE FIX is the one line: units = sum(effective_units), so units and value share the credited
-- basis and the drilldown reconciles to the same scope total it already sums. The value expression
-- (the locked direct-order rule), the product-master join, the area predicate that the expression
-- index sos_customer_directory_rollup_area_period_idx matches byte-for-byte, and the grants are all
-- kept exactly as they were live.

CREATE OR REPLACE FUNCTION public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[])
 RETURNS TABLE(brick_id text, client_code text, client_name text, official_line text, product_code text, product_name text, period text, units numeric, value numeric, scope_total_units numeric, scope_total_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      -- The credited-to-area units, the SAME basis the value below uses. A split customer (El Qema
      -- bands, the city rule) has effective_units below its raw total_qty; total_qty here disagreed
      -- with value and overcounted the area.
      r.effective_units as row_units,
      -- A direct order is valued as it is from the source, never × factory (owner rule, locked).
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(p.factory_price, 0) end as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(row_units) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

-- Grants stay exactly as they were live (service_role only); stated here so the file is complete.
revoke execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) to service_role;
