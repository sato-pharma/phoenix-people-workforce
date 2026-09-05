-- Direct orders take their units and their VALUE as they are from the source — never × factory.
--
-- Owner ruling, 2026-09-05, asked directly and answered in his own words: "Direct orders are never
-- calculated with X factory. Direct orders take the units as they are ... and the value as they are
-- from the source. As they are." That restates the standing locked rule for the Direct Orders
-- module, whose memory note is explicit that the factory price is banned there "for anything".
--
-- SoS audit finding `db:public.phx_exec_customers:15`, re-verified live on 2026-09-05.
--
-- WHAT WAS WRONG
--
-- `source_of_sales_customer_directory_rollup` carries no value column at all, so
-- `phx_exec_customers` derived one for EVERY row:
--
--     r.effective_units * coalesce(p.factory_price, 0) as line_value
--
-- with no `is_direct` branch. Its two siblings already do the right thing —
-- phx_exec_distributor_product and phx_exec_sos_trend both read
-- `case when f.is_direct then f.direct_value else … end` off `source_of_sales_fact_rollup`,
-- which stores it as `sum(case when a.is_direct then a.value else 0 end)`: the source row's own
-- value. The customer path was the one surface that could not do that, because its rollup had
-- nowhere to put it.
--
-- MEASURED ON PRODUCTION BEFORE THIS RAN (ozucdzovmcqvepbozvqf, 2026-09-05):
--   · direct rows in the directory rollup: 23, all in ONE batch (DirectReq / direct-orders-2026-08)
--   · 2026-08 direct shown today, factory-priced : 307,455.75 EGP
--   · 2026-08 direct per the source value        : 293,837.57 EGP
--   · so the exec customer view OVERSTATES direct sales by 13,618.18 EGP, and that is the only
--     period affected — every other period has no direct row carrying a client code
--
-- This one DOES move a number, deliberately: 13,618.18 EGP off the 2026-08 customer view, bringing
-- it into line with the fact rollup, the closing and the Direct Orders module itself.
--
-- TWO SMALLER FIXES RIDE ALONG, both in functions this migration already rewrites:
--
--   · `phx_exec_customers` joined the product master raw (`on p.product_code = r.product_code`).
--     That is the same defect 20260905101500 fixed in three sibling RPCs; this is the fourth
--     instance, missed by that sweep only because it aliases the rollup `r` rather than `f`.
--   · `phx_refresh_sos_customer_directory_rollup` applied NO validation_state filter while
--     `phx_refresh_sos_fact_rollup` excludes `failed` — SoS audit finding
--     `db:public.phx_refresh_sos_customer_directory_rollup:52`. The two now use the identical
--     predicate, copied verbatim rather than re-invented. Measured: inside validated batches every
--     row is 'valid' (349,599 rows / 407.5M EGP), so this changes nothing today and stops the two
--     rollups drifting the first time a failed row survives.

-- ── 1. somewhere to put the source value ─────────────────────────────────────────────────────
-- NOT NULL DEFAULT 0 is metadata-only on PG11+, and 0 is already correct for every non-direct row.
alter table public.source_of_sales_customer_directory_rollup
  add column if not exists direct_value numeric not null default 0;

comment on column public.source_of_sales_customer_directory_rollup.direct_value is
  'Sum of the SOURCE row value for is_direct rows, 0 otherwise — the same definition '
  'source_of_sales_fact_rollup.direct_value uses. Direct orders are never priced at factory '
  '(owner rule, locked): consumers must read this for a direct row, never units x factory_price.';

-- ── 2. populate it on every refresh ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_refresh_sos_customer_directory_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
begin
  delete from public.source_of_sales_customer_directory_rollup
  where batch_id = p_batch_id;

  insert into public.source_of_sales_customer_directory_rollup (
    batch_id,
    period,
    distributor_code,
    client_code,
    product_code,
    is_direct,
    client_name,
    client_address,
    brick_id,
    area_code,
    region_code,
    official_line,
    latest_row_created_at,
    effective_units,
    total_qty,
    direct_value,
    row_count
  )
  select
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), '') as period,
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
    nullif(btrim(r.client_code), '') as client_code,
    coalesce(nullif(upper(btrim(r.product_code)), ''), '') as product_code,
    coalesce(r.is_direct, false) as is_direct,
    (array_agg(nullif(btrim(r.client_name), '') order by (nullif(btrim(r.client_name), '') is null), r.created_at desc nulls last))[1] as client_name,
    (array_agg(nullif(btrim(r.client_address), '') order by (nullif(btrim(r.client_address), '') is null), r.created_at desc nulls last))[1] as client_address,
    (array_agg(nullif(btrim(r.brick_id), '') order by (nullif(btrim(r.brick_id), '') is null), r.created_at desc nulls last))[1] as brick_id,
    (array_agg(nullif(btrim(r.area_code), '') order by (nullif(btrim(r.area_code), '') is null), r.created_at desc nulls last))[1] as area_code,
    (array_agg(nullif(btrim(r.region_code), '') order by (nullif(btrim(r.region_code), '') is null), r.created_at desc nulls last))[1] as region_code,
    (array_agg(nullif(btrim(r.official_line), '') order by (nullif(btrim(r.official_line), '') is null), r.created_at desc nulls last))[1] as official_line,
    max(coalesce(r.created_at, b.created_at, 'epoch'::timestamptz)) as latest_row_created_at,
    sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0))) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    -- Identical to source_of_sales_fact_rollup.direct_value: the SOURCE value, as it is.
    sum(case when coalesce(r.is_direct, false) then coalesce(r.value, 0) else 0 end) as direct_value,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where r.batch_id = p_batch_id
    and nullif(btrim(r.client_code), '') is not null
    -- Same predicate phx_refresh_sos_fact_rollup uses, verbatim.
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), ''),
    coalesce(r.is_direct, false);
end;
$function$;

-- ── 3. read it, instead of pricing direct at factory ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_exec_customers(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '96MB'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      r.client_code,
      r.client_name,
      r.distributor_code,
      r.region_code,
      r.area_code,
      r.brick_id,
      r.latest_row_created_at,
      r.total_qty,
      -- A direct row's value is the source value, as it is. Only distributor rows are priced.
      case when r.is_direct
           then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(p.factory_price, 0)
      end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(r.product_code, ''))) <> all (
             select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty)  as units,
      sum(line_value) as value
    from filtered
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
end;
$function$;

-- ── 4. re-assert the SECURITY DEFINER grants (replay safety) ─────────────────────────────────
-- CREATE OR REPLACE keeps the live ACL, so these are a no-op here; on a fresh database they stop
-- the default ACL granting EXECUTE to PUBLIC. anon/authenticated inherit through PUBLIC, and
-- revoking PUBLIC on a default ACL also strips service_role — hence the explicit re-grant.
revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_refresh_sos_customer_directory_rollup(uuid) from public, anon, authenticated;
grant  execute on function public.phx_refresh_sos_customer_directory_rollup(uuid) to service_role;

-- ── 5. backfill the rows that already exist ──────────────────────────────────────────────────
-- Only batches that actually carry a direct row need it: every other row's direct_value is 0, which
-- the column default already gives them. Selected by predicate rather than by a hard-coded batch id
-- so a replay finds whatever that database holds. On production this resolved to ONE batch
-- (DirectReq / direct-orders-2026-08, 23 rows).
do $$
declare
  v_batch uuid;
begin
  for v_batch in
    select distinct batch_id
    from public.source_of_sales_customer_directory_rollup
    where is_direct = true
  loop
    perform public.phx_refresh_sos_customer_directory_rollup(v_batch);
  end loop;
end
$$;
