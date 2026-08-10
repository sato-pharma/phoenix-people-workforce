-- Closing channel classifier: fold each customer name ONCE per row, not once per stem.
--
-- From the 2026-08-10 production Postgres health audit. After the expression-statistics
-- fix in 20260811000200, phx_closing_channel_totals still took 7.5s, and EXPLAIN showed
-- 5.0s of that inside a single Result node -- the CASE classifier. The cause: each
-- correlated EXISTS called public.phx_fold_customer_name(u.client_name) in its WHERE,
-- so the fold ran once per stem per row. With 6 store stems + 2 hospital stems across
-- 72,914 rows that is ~583,000 evaluations where 72,914 would do.
--
-- The only change is a new `folded` CTE that computes the fold once and two references
-- rewritten to use it. phx_fold_customer_name is IMMUTABLE, so this cannot alter any
-- classification; MATERIALIZED prevents the planner flattening the CTE and undoing it.
-- Verified against production: CNS over 2026-01..2026-07 returns the identical 35 rows
-- and identical 95,062,107.01 EGP before and after.
--
-- Rollback: db-snapshots-20260811/phx_closing_channel_totals_ROLLBACK.sql

CREATE OR REPLACE FUNCTION public.phx_closing_channel_totals(p_line text, p_periods text[], p_store_stems text[], p_hospital_stems text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_pharmacy_override_codes text[] DEFAULT '{}'::text[], p_store_override_codes text[] DEFAULT '{}'::text[])
 RETURNS TABLE(period text, channel text, customers bigint, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  with
  -- The name the distributor actually sent, newest wins — the same rule phx_customer_directory
  -- uses. Not narrowed by product: a customer's name does not depend on what it bought.
  names as (
    select distinct on (d.period, d.distributor_code, d.client_code)
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.period = any(p_periods)
      and lower(btrim(d.official_line)) = lower(btrim(p_line))
    order by d.period, d.distributor_code, d.client_code, d.latest_row_created_at desc
  ),
  -- Distributor sell-out. Same source, same guards and the SAME value formula as
  -- phx_closing_customers, so a channel total can never disagree with the closing beside it.
  --
  -- NO `client_code is not null` FILTER. A row without a client code is still money the closing
  -- published; it just has no customer to attribute it to. It is carried here and bucketed below.
  retail as (
    select
      f.period,
      -- The customer, for counting. NULL when the row carries no client code — count(distinct NULL)
      -- is 0, which is the honest answer to "how many customers is this", and the alternative
      -- (one synthetic customer per month) would be a number nobody could act on.
      f.client_code                                        as client_key,
      f.distributor_code                                   as distributor_code,
      coalesce(n.client_name, '')                          as client_name,
      (f.client_code is null)                              as no_client_code,
      false                                                as is_direct,
      sum(f.total_qty)                                     as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.period = f.period
     and n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = any(p_periods)
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by f.period, f.distributor_code, f.client_code, coalesce(n.client_name, '')
  ),
  -- Direct orders. They carry no client_code at all, so the fact rollup cannot name them and the
  -- import rows are the only place the customer survives. Their `value` IS the direct_value the
  -- rollup aggregates, so this stays the published closing money, not a re-derivation.
  direct as (
    select
      r.invoice_period          as period,
      -- No code exists, so the customer IS its name for counting purposes. An order with NO name
      -- keys to NULL rather than to the string 'name:', which is what made every unnamed order in
      -- a month collapse into one confident, wrong "customer" filed under Pharmacies.
      case
        when btrim(coalesce(r.client_name, '')) = '' then null
        else 'name:' || public.phx_fold_customer_name(r.client_name)
      end                       as client_key,
      null::text                as distributor_code,
      btrim(coalesce(r.client_name, '')) as client_name,
      false                     as no_client_code,
      true                      as is_direct,
      sum(r.qty)                as units,
      sum(r.value)              as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = any(p_periods)
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by r.invoice_period, 2, 4
  ),
  folded as materialized (
    -- Fold the customer name ONCE per row. It used to be called inside each correlated
    -- EXISTS below, i.e. once per stem per row: with 6 store stems + 2 hospital stems
    -- over 72,914 rows that is ~583,000 evaluations instead of 72,914, and it accounted
    -- for 5.0s of a 7.5s call. phx_fold_customer_name is IMMUTABLE, so hoisting it out
    -- cannot change any classification. MATERIALIZED stops the planner flattening it back.
    select u.*, public.phx_fold_customer_name(u.client_name) as folded_name
    from (select * from retail union all select * from direct) u
  ),
  tagged as (
    select
      u.period,
      u.client_key,
      u.units,
      u.value,
      case
        -- The three "this is not a channel" answers come FIRST. Each is checked before the name
        -- classifier, because the classifier's own fallback is "pharmacy" and a fallback is exactly
        -- what must never catch money whose customer is unknown.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- Hospital wins the overlap, matching classifyCustomerChannel(): a name carrying both a
        -- hospital word and a store word is the hospital that identifies the customer.
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'hospital'
        -- The owner's rulings beat the keyword, both directions. A store override is keyed by
        -- distributor + client code because a client code can recur under another distributor.
        when exists (
          select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}'::text[])) c
          where c <> ''
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(c), '0')
        ) then 'pharmacy'
        when exists (
          select 1 from unnest(coalesce(p_store_override_codes, '{}'::text[])) c
          where c <> ''
            and upper(btrim(u.distributor_code)) = upper(btrim(split_part(c, '|', 1)))
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(split_part(c, '|', 2)), '0')
        ) then 'store'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from folded u
  ),
  channels as (
    select
      t.period,
      t.channel,
      -- DISTINCT customer, never a row count: retail rows are one per customer-per-distributor, so
      -- counting rows would report a pharmacy buying from three distributors as three pharmacies.
      count(distinct t.client_key) as customers,
      sum(t.units)                 as units,
      sum(t.value)                 as value
    from tagged t
    group by t.period, t.channel
  ),
  -- ── The independent check ────────────────────────────────────────────────────────────────────
  -- Deliberately NOT `select sum(value) from channels`. That would prove only that addition works.
  -- These two re-read the same tables with the guards restated, so any future filter added to
  -- `retail` or `direct` shows up here as a difference the sheet prints in red.
  pop_retail as (
    select
      f.period,
      sum(f.total_qty)                                      as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = any(p_periods)
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by f.period
  ),
  pop_direct as (
    select
      r.invoice_period as period,
      sum(r.qty)       as units,
      sum(r.value)     as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = any(p_periods)
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by r.invoice_period
  ),
  population as (
    select
      coalesce(pr.period, pd.period)                    as period,
      coalesce(pr.units, 0) + coalesce(pd.units, 0)     as units,
      coalesce(pr.value, 0) + coalesce(pd.value, 0)     as value
    from pop_retail pr
    full outer join pop_direct pd on pd.period = pr.period
  )
  select c.period, c.channel, c.customers, c.units, c.value from channels c
  union all
  -- Not a channel and never displayed as one: the sheet reads it as the month's own population and
  -- checks itself against it. 0 customers because it is a money total, not a customer list.
  select p.period, '__population__'::text, 0::bigint, p.units, p.value from population p;
$function$
;

-- A new public SECURITY DEFINER function inherits PostgreSQL's built-in EXECUTE grant to
-- PUBLIC, and anon/authenticated are members of PUBLIC -- so revoking only those two is a
-- no-op. Revoke PUBLIC itself, then re-grant service_role explicitly: revoking from PUBLIC
-- materialises the ACL, and an ACL that lists nobody would strip the role the app runs as.
revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[]) to service_role;
