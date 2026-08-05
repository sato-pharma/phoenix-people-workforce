-- Monthly Closing — Channel Comparison (Hospitals / Stores / Pharmacies) across months.
--
-- WHY AN RPC AND NOT THE EXISTING LOADERS: the workbook's Channel Comparison sheet compares every
-- month of the line, and the channel is derived from the customer's NAME. Nothing already in the
-- system can supply both halves of that:
--
--   * phx_closing_customers returns the MAPPED name (coalesce(customer_map.customer_name, '')),
--     which is blank for ~25% of customers — 434 of 1,733 on Anti Infective 2026-01, worth
--     148,263 EGP. Those all fall to "pharmacy" and understate the store channel badly.
--   * phx_closing_customers also drops DIRECT rows entirely (`client_code is not null`), and
--     phx_monthly_closing_direct groups direct by region and product with no customer at all —
--     yet direct orders are placed by named customers, and some of those customers are stores
--     (مخزن النيل, الخليل فارما, بيتا فارما). Attributing every direct order to pharmacies
--     understated stores by 20,783 / 16,000 / 12,026 / 7,418 / 8,294 EGP in Feb-Jun 2026 on
--     Anti Infective alone.
--
-- So this reads the SAME money the closing publishes and attaches the RAW distributor-sent name to
-- it, which is the name every other channel consumer already classifies on (the Store Split sheet
-- via store-sales-city-split.ts, and the Customer Directory via phx_customer_directory).
--
-- WHY THE KEYWORDS ARE PARAMETERS AND NOT LITERALS IN HERE:
-- src/lib/sales/customer-channel.ts declares itself THE single edit point for the channel rule —
-- "adding an entry re-classifies all history". A second copy of those words in SQL would break
-- that promise the first time someone edits one list and not the other. The caller passes the
-- stems in, already folded by normalizeCustomerName(). This function owns the JOIN, never the
-- vocabulary. (Not hypothetical: a hand-transcribed copy of those words mis-stated the store
-- channel by 8.7M EGP and 94 customers before it was caught.)
--
-- The confidential product list is a parameter for the same reason: src/lib/sales/access-scope.ts
-- owns it, and the rule is not a flat exclusion — the codes are stripped by default for everyone
-- and only a CEO or Super Admin who opts in may reveal them. Passing '{}' reveals everything.

-- Fold a customer name to the form the stems are compared against. Mirrors normalizeCustomerName()
-- in src/lib/sales/customer-channel.ts: harakat/tatweel/superscript-alef stripped, interchangeable
-- letters unified, latin lowercased, whitespace collapsed. Kept as its own IMMUTABLE function so
-- the coupling is one readable place rather than smeared through a query.
create or replace function public.phx_fold_customer_name(p_name text)
returns text
language sql
immutable
parallel safe
as $function$
  select btrim(regexp_replace(
           lower(translate(
             regexp_replace(coalesce(p_name, ''), '[ً-ْـٰ]', '', 'g'),
             'أإآٱةىیک', 'ااااهييك')),
           '\s+', ' ', 'g'));
$function$;

comment on function public.phx_fold_customer_name(text) is
  'Folds an Arabic customer name for channel matching. Mirrors normalizeCustomerName() in '
  'src/lib/sales/customer-channel.ts — keep the two in step; tests/sales-monthly-closing-channels.test.ts pins the vocabulary.';

-- One row per (period, channel). Deliberately aggregated in SQL rather than returning customers:
-- the sheet compares every month of the line, and shipping every customer of every month to the
-- app would be tens of thousands of rows for one small block of the workbook. Every DB round trip
-- here crosses the Atlantic (Railway sfo -> Supabase eu-central-1), so the whole sheet is ONE call.
create or replace function public.phx_closing_channel_totals(
  p_line text,
  p_periods text[],
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003', 'LA004', 'SS001']
)
returns table (
  period text,
  channel text,
  customers bigint,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
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
  retail as (
    select
      f.period,
      f.client_code                                   as client_key,
      coalesce(n.client_name, '')                     as client_name,
      sum(f.total_qty)                                as units,
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
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by f.period, f.client_code, coalesce(n.client_name, '')
  ),
  -- Direct orders. They carry no client_code at all, so the fact rollup cannot name them and the
  -- import rows are the only place the customer survives. Their `value` IS the direct_value the
  -- rollup aggregates (verified equal to phx_monthly_closing_direct on all seven 2026 months of
  -- Anti Infective), so this stays the published closing money, not a re-derivation.
  direct as (
    select
      r.invoice_period          as period,
      -- No code exists, so the customer IS its name for counting purposes. A direct order with no
      -- name at all collapses into one "unnamed" bucket rather than inflating the customer count.
      'name:' || public.phx_fold_customer_name(r.client_name) as client_key,
      btrim(coalesce(r.client_name, '')) as client_name,
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
    group by r.invoice_period, 2, 3
  ),
  tagged as (
    select
      u.period,
      u.client_key,
      u.units,
      u.value,
      case
        -- Hospital wins the overlap, matching classifyCustomerChannel(): a name carrying both a
        -- hospital word and a store word is the hospital that identifies the customer.
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'hospital'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from (select * from retail union all select * from direct) u
  )
  select
    t.period,
    t.channel,
    -- DISTINCT customer, never a row count: retail rows are one per customer-per-distributor, so
    -- counting rows would report a pharmacy buying from three distributors as three pharmacies.
    count(distinct t.client_key) as customers,
    sum(t.units)                 as units,
    sum(t.value)                 as value
  from tagged t
  group by t.period, t.channel;
$function$;

comment on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) is
  'Monthly Closing Channel Comparison: hospital/store/pharmacy units, value and distinct customers '
  'per period for one line. Channel vocabulary and the confidential-product list are parameters — '
  'src/lib/sales/customer-channel.ts and src/lib/sales/access-scope.ts remain their single sources.';

revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) to service_role;
