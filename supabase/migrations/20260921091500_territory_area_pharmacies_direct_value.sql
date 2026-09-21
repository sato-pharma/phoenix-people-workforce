-- Territory Management's area pharmacies list takes a direct order's value as it is from the
-- source — never units × factory price.
--
-- Owner rule (locked, 2026-08-04; restated 2026-09-05 in his words: "Direct orders are never
-- calculated with X factory ... the value as they are from the source. As they are.").
--
-- Source of Sales fix backlog, re-measured 2026-09-18, "Found while measuring": #122's defect in a
-- sibling function. 20260905104500 gave source_of_sales_customer_directory_rollup a direct_value
-- column and taught phx_exec_customers to read it; phx_territory_area_pharmacies reads the same
-- rollup and was never updated, so it still priced EVERY row, direct ones included, at
--     r.effective_units * coalesce(p.factory_price, 0)
--
-- MEASURED ON PRODUCTION BEFORE THIS RAN (ozucdzovmcqvepbozvqf, 2026-09-21, read-only):
--   · 2026-08: 26 direct rows, shown 325,071.25 EGP, source value 303,514.77 (+21,556.48 overstated)
--   · 2026-09: 18 direct rows, shown 387,278.00 EGP, source value 356,004.20 (+31,273.80 overstated)
--   · 2026-06 and 2026-07: no direct row carries a client code — nothing moves
--   · non-direct rows: unchanged, still effective units × factory price
--
-- ONE SMALLER FIX RIDES ALONG: the product-master join was raw (on p.product_code = r.product_code),
-- the defect 20260905101500 and 20260905104500 fixed in four sibling RPCs. Measured: 30 master rows,
-- 30 distinct raw codes, 30 distinct normalised codes (no fan-out), and 0 rollup rows unmastered
-- either way, so the join changes nothing today.
--
-- The area predicate is kept byte-for-byte: sos_customer_directory_rollup_area_period_idx
-- (20260816070000) is an expression index that matches it exactly (tests/territory-area-index.test.ts).

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
      r.total_qty,
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
           sum(total_qty) as units, sum(row_value) as value
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
