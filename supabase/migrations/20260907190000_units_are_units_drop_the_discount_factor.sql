-- Units are units. The discount factor comes out of every value in the database.
--
-- OWNER RULE, 2026-09-07, asked and answered twice. First: "in other distributors do we consider
-- bonus? or value? what we consider" — then, on being shown that the code reduced units by a
-- discount column: "we fucken neglect the bonus and the value in any distributor sheet we take the
-- units and multiply by factory", and then "effective_units = qty x (1 - discount) delete this rule
-- from every where".
--
-- So the rule is now, everywhere and without exception:
--
--     sales value  =  paid units  x  factory price
--
-- Bonus was ALREADY excluded and stays excluded — it is carried in its own column and never folded
-- into units. The sheet's own `value` column was ALREADY unused for the closing and stays unused.
-- What changes is the third input: a `discount` column in a distributor's sheet no longer reduces
-- the units they are credited with.
--
-- ── What this was, and why it looked harmless ────────────────────────────────────────────────
-- `effective_units = qty x (1 - discount)` was documented in one comment in
-- src/lib/sales/monthly-closing-details.ts and implemented in TEN database functions. Exactly one
-- distributor has ever sent a discount — RM — so for the other sixteen the factor multiplied by one
-- and was invisible. Measured on production today:
--
--     2026-01  7%          15.40 units removed
--     2026-02  1.5-7%      17.93
--     2026-03  7%           6.65
--     2026-04  7-8%      1,602.73
--     2026-07  1%           0.03
--
-- El Qema, whose August invoice is 79.8% of list, sends NO discount column at all: their 8,768
-- Pedia units are credited in full, which is what the owner's rule asks for and what production
-- already does. The discount column and the invoiced value are two different things, and only the
-- first was ever wired to anything.
--
-- ── The ten functions, and why marketing is in the list ──────────────────────────────────────
-- Five feed the Source-of-Sales closing (fact rollup, customer directory rollup and its backfill,
-- the reconciliation sync, customer sales). Five feed Marketing ROI, which prices the same invoice
-- rows to decide whether a marketing spend paid for itself. Leaving those five would mean one rule
-- for the closing and another for ROI over the same rows — "delete this rule from every where" was
-- the instruction, and a half-applied rule is worse than the rule.
--
-- Each function is replaced with its own current definition, textually, with only the factor
-- removed — extracted with pg_get_functiondef and transformed mechanically rather than retyped, so
-- nothing else in these bodies can drift while the change is made.
--
-- ── NO STORED ROW IS REWRITTEN BY THIS MIGRATION, deliberately ───────────────────────────────
-- The rollups keep the numbers they already hold until something rebuilds them. That is the owner's
-- standing rule that a published and announced month is never corrected: 2026-07 is published AND
-- LOCKED, and its 0.03-unit difference would otherwise be the first thing to move. 2026-01 to
-- 2026-04 hold 1,642.71 units of discount reduction between them and are left exactly as they are.
-- A rebuild of any of those periods will now produce the new number; that is a decision for the
-- owner, per month, not a side effect of a migration.
--
-- CREATE OR REPLACE keeps each function's existing ACL, so no grant is re-issued here.

begin;

-- ── phx_backfill_sos_customer_directory_rollup ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_backfill_sos_customer_directory_rollup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
begin
  delete from public.source_of_sales_customer_directory_rollup;

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
    sum(coalesce(r.qty, 0)) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where nullif(btrim(r.client_code), '') is not null
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), ''),
    coalesce(r.is_direct, false);
end;
$function$;

revoke execute on function public.phx_backfill_sos_customer_directory_rollup() from public, anon, authenticated;
grant execute on function public.phx_backfill_sos_customer_directory_rollup() to service_role;

-- ── phx_customer_sales ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(invoice_period text, product_code text, product_name text, official_line text, brick_id text, area_code text, region_code text, client_name text, client_address text, qty numeric, line_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
    r.area_code, r.region_code, r.client_name, r.client_address, r.qty,
    r.qty * coalesce(p.factory_price, 0) as line_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and r.distributor_code = p_distributor_code
    and r.client_code = p_client_code
    and (p_from_period is null or r.invoice_period >= p_from_period)
    and (p_to_period is null or r.invoice_period <= p_to_period)
    and upper(btrim(coalesce(r.product_code, ''))) <> all (
      select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
    )
  order by r.invoice_period, r.product_name;
$function$;

revoke execute on function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text, p_to_period text, p_exclude_codes text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text, p_to_period text, p_exclude_codes text[]) to service_role;

-- ── phx_marketing_coverage_export_sales_detail ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_marketing_coverage_export_sales_detail(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT '{LA003,LA004,SS001}'::text[])
 RETURNS TABLE(request_id uuid, distributor_code text, distributor_name text, invoice_period text, product_code text, product_name text, customer_code text, customer_name text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  win as (
    select req.id as request_id, to_char(g, 'YYYY-MM') as period
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) g
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    cross join excl
    where mrp.request_id = any(p_request_ids)
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    -- join source_of_sales_distributors so a rollup code with no SoS distributor row is
    -- dropped IDENTICALLY to phx_marketing_request_roi_actuals / the single-request RPC.
    select distinct
      mrph.request_id,
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  hits as (
    -- dedup per (request, matched SoS row): the SAME underlying sale can legitimately
    -- satisfy more than one request in the batch, but must never appear twice for the
    -- SAME request (mirrors the single-request RPC's `distinct on (r.id)` exactly, just
    -- scoped per request instead of globally, since this now covers many requests at once).
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      r.id as row_id,
      tp.parent_distributor_code,
      r.invoice_period,
      r.product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      tp.customer_code,
      r.client_name as customer_name,
      r.region_name,
      r.qty as qty,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * coalesce(sp.factory_price, 0)
      end as value
    from target_products tp
    join win on win.request_id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = win.period
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    order by tp.request_id, r.id
  )
  select
    hits.request_id,
    hits.parent_distributor_code as distributor_code,
    coalesce(sd.distributor_name, hits.parent_distributor_code) as distributor_name,
    hits.invoice_period,
    hits.product_code,
    hits.product_name,
    hits.customer_code,
    hits.customer_name,
    hits.region_name,
    hits.qty::numeric,
    hits.value::numeric
  from hits
  left join public.source_of_sales_distributors sd on sd.distributor_code = hits.parent_distributor_code
  order by hits.request_id, hits.invoice_period, hits.parent_distributor_code, hits.product_code;
$function$;

revoke execute on function public.phx_marketing_coverage_export_sales_detail(p_request_ids uuid[], p_exclude_product_codes text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_coverage_export_sales_detail(p_request_ids uuid[], p_exclude_product_codes text[]) to service_role;

-- ── phx_marketing_request_roi_actuals ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_marketing_request_roi_actuals(p_request_ids uuid[])
 RETURNS TABLE(request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer, exact_sales_rows integer, fallback_sales_rows integer, attribution_quality text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id = any(p_request_ids)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  exact_hits as (
    select distinct
      tp.request_id,
      r.id as row_id,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * coalesce(sp.factory_price, 0)
      end as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
  ),
  actuals as (
    select
      request_id,
      coalesce(sum(value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows
    from exact_hits
    group by request_id
  )
  select
    req.id as request_id,
    coalesce(actuals.actual_value, 0)::numeric as actual_value,
    coalesce(actuals.actual_units, 0)::numeric as actual_units,
    coalesce(actuals.sales_rows, 0)::integer as sales_rows,
    coalesce(actuals.sales_rows, 0)::integer as exact_sales_rows,
    0::integer as fallback_sales_rows,
    case when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales' else 'exact_customer' end as attribution_quality
  from req
  left join actuals on actuals.request_id = req.id;
$function$;

revoke execute on function public.phx_marketing_request_roi_actuals(p_request_ids uuid[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_roi_actuals(p_request_ids uuid[]) to service_role;

-- ── phx_marketing_request_sales_lines ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_marketing_request_sales_lines(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text)
 RETURNS TABLE(request_id uuid, channel text, source_row_id text, distributor_code text, distributor_name text, customer_code text, customer_name text, product_code text, product_name text, invoice_period text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months,
           coalesce(mr.track_direct_sales, false) as track_direct_sales
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  win as (
    select case
      when p_from_period ~ '^\d{4}-\d{2}$' and p_to_period ~ '^\d{4}-\d{2}$' and p_from_period <= p_to_period
        then array(
          select to_char(g, 'YYYY-MM')
          from generate_series(to_date(p_from_period, 'YYYY-MM'), to_date(p_to_period, 'YYYY-MM'), interval '1 month') g
        )
      else null::text[]
    end as periods
  ),
  pay_periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  periods as (
    select ids.id, coalesce(win.periods, pay_periods.periods) as periods
    from (select distinct u.id from unnest(coalesce(p_request_ids, '{}'::uuid[])) as u(id)) ids
    cross join win
    left join pay_periods on pay_periods.id = ids.id
  ),
  req_products as (
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    cross join excl
    where mrp.request_id = any(p_request_ids)
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  retail_hits as (
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      'retail'::text as channel,
      r.id::text as source_row_id,
      tp.parent_distributor_code::text as distributor_code,
      coalesce(sd.distributor_name, tp.parent_distributor_code)::text as distributor_name,
      tp.customer_code::text as customer_code,
      r.client_name::text as customer_name,
      r.product_code::text as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code)::text as product_name,
      r.invoice_period::text as invoice_period,
      r.region_name::text as region_name,
      r.qty::numeric as qty,
      (case when coalesce(r.is_direct, false)
            then coalesce(r.value, 0)
            else r.qty * coalesce(sp.factory_price, 0)
       end)::numeric as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.parent_distributor_code
    order by tp.request_id, r.id
  ),
  direct_hits as (
    select distinct on (mrph.request_id, dor.id)
      mrph.request_id,
      'direct'::text as channel,
      dor.id::text as source_row_id,
      sd.distributor_code::text as distributor_code,
      sd.distributor_name::text as distributor_name,
      mpdc.normalized_pharmacy_code::text as customer_code,
      null::text as customer_name,
      dor.product_code::text as product_code,
      null::text as product_name,
      dor.sales_month::text as invoice_period,
      null::text as region_name,
      coalesce(dor.qty, 0)::numeric as qty,
      coalesce(dor.sales_value, 0)::numeric as value
    from req
    join periods on periods.id = req.id
    join req_products rp on rp.request_id = req.id
    join public.marketing_request_pharmacies mrph on mrph.request_id = req.id
    join public.marketing_pharmacy_distributor_codes mpdc
      on mpdc.id = mrph.distributor_code_id and coalesce(mpdc.active, true)
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    join public.direct_order_pharmacy_distributor_codes dopdc
      on lower(btrim(dopdc.distributor_code)) = lower(btrim(sd.distributor_code))
     and lower(btrim(regexp_replace(coalesce(dopdc.customer_code, ''), '\s+', ' ', 'g')))
       = lower(btrim(regexp_replace(coalesce(mpdc.normalized_pharmacy_code, ''), '\s+', ' ', 'g')))
    join public.direct_order_requests dor
      on dor.pharmacy_id = dopdc.pharmacy_id
     and dor.status = 'approved'
     and dor.reversal_of_request_id is null
     and dor.sales_month = any(periods.periods)
     and upper(btrim(dor.product_code)) = upper(btrim(rp.product_code))
    where req.track_direct_sales = true
    order by mrph.request_id, dor.id
  )
  select * from retail_hits
  union all
  select * from direct_hits;
$function$;

revoke execute on function public.phx_marketing_request_sales_lines(p_request_ids uuid[], p_exclude_product_codes text[], p_from_period text, p_to_period text) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_sales_lines(p_request_ids uuid[], p_exclude_product_codes text[], p_from_period text, p_to_period text) to service_role;

-- ── phx_marketing_roi_customer_dashboard ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_marketing_roi_customer_dashboard(p_lines text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_distributor_codes text[] DEFAULT '{}'::text[], p_product_codes text[] DEFAULT '{}'::text[], p_roi_statuses text[] DEFAULT '{}'::text[], p_attribution_qualities text[] DEFAULT '{}'::text[], p_customer_search text DEFAULT NULL::text, p_from_month text DEFAULT NULL::text, p_to_month text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with params as (
    select
      greatest(10, least(coalesce(p_limit, 100), 100)) as row_limit,
      nullif(lower(btrim(coalesce(p_customer_search, ''))), '') as customer_search,
      case when coalesce(p_from_month, '') ~ '^\d{4}-\d{2}$' then p_from_month else null end as from_month,
      case when coalesce(p_to_month, '') ~ '^\d{4}-\d{2}$' then p_to_month else null end as to_month,
      public.phx_marketing_roi_latest_validated_period() as sales_as_of
  ),
  filter_lines as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_lines, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_regions as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_regions, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_distributors as materialized (
    select upper(btrim(value)) as value
    from unnest(coalesce(p_distributor_codes, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_products as materialized (
    select upper(btrim(value)) as value
    from unnest(coalesce(p_product_codes, '{}'::text[])) as value
    where btrim(value) <> ''
  ),
  filter_roi_statuses as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_roi_statuses, '{}'::text[])) as value
    where lower(btrim(value)) in ('behind', 'no_data', 'on_track')
  ),
  filter_attribution as materialized (
    select lower(btrim(value)) as value
    from unnest(coalesce(p_attribution_qualities, '{}'::text[])) as value
    where lower(btrim(value)) in ('exact_customer', 'no_sales')
  ),
  req_raw as materialized (
    select
      mr.id,
      mr.request_code,
      mr.status,
      mr.pay_date,
      to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') as pay_month,
      greatest(coalesce(mr.roi_duration_months, 1), 1) as roi_duration_months,
      coalesce(mr.estimated_cost, 0)::numeric as estimated_cost,
      coalesce(mr.required_roi_value, coalesce(mr.estimated_cost, 0) * 10)::numeric as required_roi_value,
      coalesce(mr.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(mr.roi_coverage_ratio, 0)::numeric as expected_coverage_ratio,
      mr.customer_id,
      mr.line_id,
      coalesce(l.name, 'Unassigned') as request_line,
      coalesce(mc.display_name, mr.customer_id::text) as customer_name,
      mc.customer_code,
      params.sales_as_of
    from public.marketing_requests mr
    left join public.employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
    left join public.lines l on l.id = coalesce(mr.line_id, emp_req.line_id)
    left join public.marketing_customers mc on mc.id = mr.customer_id
    cross join params
    where mr.status in ('approved', 'active', 'roi_tracking', 'closed', 'finance_hold')
      and mr.pay_date is not null
      and (params.from_month is null or to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') >= params.from_month)
      and (params.to_month is null or to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') <= params.to_month)
      and (
        params.customer_search is null
        or lower(mr.request_code) like '%' || params.customer_search || '%'
        or lower(coalesce(mc.display_name, '')) like '%' || params.customer_search || '%'
        or lower(coalesce(mc.customer_code, '')) like '%' || params.customer_search || '%'
      )
  ),
  req_products_all as materialized (
    select distinct
      mrp.request_id,
      upper(btrim(sp.product_code)) as product_code,
      coalesce(sp.product_name, mp.product_name, mrp.product_name_snapshot) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(mp.line), ''), nullif(btrim(mrp.line_snapshot), ''), 'Unassigned') as line_label,
      coalesce(mrp.expected_value, 0)::numeric as expected_value,
      coalesce(mrp.value_share, 0)::numeric as value_share,
      (sp.product_code is null) as missing_sales_product_mapping
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    left join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id in (select id from req_raw)
  ),
  req_targets_all as materialized (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
      mpdc.normalized_pharmacy_code as customer_code,
      mph.id as pharmacy_id,
      coalesce(mph.display_name, mpdc.normalized_pharmacy_code) as pharmacy_name,
      cm.brick_id,
      cm.region_code,
      cm.area_code,
      (cm.brick_id is null) as missing_customer_mapping
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_pharmacies mph on mph.id = mrph.pharmacy_id
    join (select distinct marketing_normalized_name, parent_distributor_code from public.marketing_roi_distributor_rollup) ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
    left join lateral (
      select cmx.brick_id, cmx.region_code, cmx.area_code
      from public.source_of_sales_customer_map cmx
      where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
        and cmx.active
        and (cmx.distributor_code = sd.distributor_code
             or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                        where rcm.parent_distributor_code = sd.distributor_code
                          and rcm.sos_distributor_code = cmx.distributor_code))
      order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
      limit 1
    ) cm on true
    where mrph.request_id in (select id from req_raw)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
      and coalesce(mpdc.active, true)
  ),
  req as materialized (
    select
      rr.*,
      coalesce(
        nullif(btrim(rr.request_line), ''),
        (select max(rpa.line_label) from req_products_all rpa where rpa.request_id = rr.id),
        'Unassigned'
      ) as line_label
    from req_raw rr
    where (
        not exists (select 1 from filter_lines)
        or lower(btrim(coalesce(rr.request_line, ''))) in (select value from filter_lines)
        or exists (
          select 1
          from req_products_all rpa
          where rpa.request_id = rr.id
            and lower(btrim(rpa.line_label)) in (select value from filter_lines)
        )
      )
      and (
        not exists (select 1 from filter_regions)
        or exists (
          select 1
          from req_targets_all rta
          where rta.request_id = rr.id
            and lower(btrim(coalesce(rta.region_code, ''))) in (select value from filter_regions)
        )
      )
      and (
        not exists (select 1 from filter_distributors)
        or exists (
          select 1
          from req_targets_all rta
          where rta.request_id = rr.id
            and upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
        )
      )
      and (
        not exists (select 1 from filter_products)
        or exists (
          select 1
          from req_products_all rpa
          where rpa.request_id = rr.id
            and upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
        )
      )
  ),
  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
  ),
  req_targets as materialized (
    select rta.*
    from req_targets_all rta
    join req on req.id = rta.request_id
    where (
        not exists (select 1 from filter_regions)
        or lower(btrim(coalesce(rta.region_code, ''))) in (select value from filter_regions)
      )
      and (
        not exists (select 1 from filter_distributors)
        or upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
      )
  ),
  product_rollups as (
    select
      request_id,
      count(*)::numeric as product_count,
      coalesce(sum(nullif(value_share, 0)), 0)::numeric as value_share_total,
      coalesce(sum(expected_value), 0)::numeric as expected_total
    from req_products
    group by request_id
  ),
  request_product_allocations as materialized (
    select
      rp.request_id,
      rp.product_code,
      rp.product_name,
      rp.line_label,
      rp.expected_value,
      rp.value_share,
      rp.missing_sales_product_mapping,
      case
        when pr.value_share_total > 0 then rp.value_share / pr.value_share_total
        when pr.expected_total > 0 then rp.expected_value / pr.expected_total
        when pr.product_count > 0 then 1 / pr.product_count
        else 0
      end as share
    from req_products rp
    join product_rollups pr on pr.request_id = rp.request_id
  ),
  target_rollups as (
    select request_id, count(*)::numeric as target_count
    from req_targets
    group by request_id
  ),
  request_target_allocations as materialized (
    select
      rt.*,
      case when tr.target_count > 0 then 1 / tr.target_count else 0 end as share
    from req_targets rt
    join target_rollups tr on tr.request_id = rt.request_id
  ),
  periods as materialized (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.roi_duration_months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  target_products as materialized (
    select distinct
      rt.request_id,
      rt.distributor_code,
      rt.customer_code,
      rpa.product_code
    from req_targets rt
    join request_product_allocations rpa on rpa.request_id = rt.request_id
    where rpa.product_code is not null
  ),
  -- Customer-code-only match (same rule as the per-request function).
  exact_hits as materialized (
    select distinct
      tp.request_id,
      r.id as row_id,
      tp.distributor_code,
      coalesce(sd.distributor_name, tp.distributor_code) as distributor_name,
      lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) as client_code,
      nullif(btrim(r.client_name), '') as client_name,
      r.region_code,
      coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
      nullif(btrim(r.brick_id), '') as brick_id,
      upper(btrim(r.product_code)) as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(r.official_line), ''), 'Unassigned') as line_label,
      coalesce(r.qty, 0)::numeric as units,
      (
        case
          when coalesce(r.is_direct, false) then coalesce(r.value, 0)
          else coalesce(r.qty, 0) * coalesce(sp.factory_price, 0)
        end
      )::numeric as sales_value,
      'exact'::text as match_type
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.marketing_roi_distributor_rollup rr on rr.parent_distributor_code = tp.distributor_code
    join public.source_of_sales_import_rows r
      on r.distributor_code = rr.sos_distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.distributor_code
    left join public.source_of_sales_regions sr on sr.region_code = r.region_code
    where (
      not exists (select 1 from filter_regions)
      or lower(btrim(r.region_code)) in (select value from filter_regions)
    )
  ),
  all_hits as materialized (
    select * from exact_hits
  ),
  actuals as materialized (
    select
      request_id,
      coalesce(sum(sales_value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows,
      (count(distinct row_id) filter (where match_type = 'exact'))::integer as exact_sales_rows,
      (count(distinct row_id) filter (where match_type = 'fallback'))::integer as fallback_sales_rows
    from all_hits
    group by request_id
  ),
  request_rows_base as materialized (
    select
      req.id,
      req.request_code,
      req.status,
      req.pay_date,
      req.pay_month,
      req.roi_duration_months,
      req.estimated_cost,
      req.required_roi_value,
      req.expected_roi_value,
      req.expected_coverage_ratio,
      req.customer_id,
      req.customer_name,
      req.customer_code,
      req.line_label,
      coalesce(actuals.actual_value, 0)::numeric as actual_sales_value,
      coalesce(actuals.actual_units, 0)::numeric as actual_sales_units,
      coalesce(actuals.sales_rows, 0)::integer as sales_rows,
      coalesce(actuals.exact_sales_rows, 0)::integer as exact_sales_rows,
      coalesce(actuals.fallback_sales_rows, 0)::integer as fallback_sales_rows,
      case
        when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales'
        else 'exact_customer'
      end as attribution_quality,
      case
        when coalesce(actuals.sales_rows, 0) > 0
             and coalesce(actuals.actual_value, 0) >= req.required_roi_value then 'on_track'
        when req.pay_date is not null
             and req.sales_as_of is not null
             and to_char(
                   req.pay_date + make_interval(months => req.roi_duration_months - 1),
                   'YYYY-MM'
                 ) > req.sales_as_of then 'awaiting_data'
        when coalesce(actuals.sales_rows, 0) > 0 then 'behind'
        else 'no_data'
      end as actual_roi_status,
      case
        when req.required_roi_value > 0 then coalesce(actuals.actual_value, 0) / req.required_roi_value
        when coalesce(actuals.actual_value, 0) > 0 then 1
        else 0
      end as actual_coverage_ratio,
      greatest(req.required_roi_value - coalesce(actuals.actual_value, 0), 0)::numeric as coverage_gap,
      greatest(req.expected_roi_value - coalesce(actuals.actual_value, 0), 0)::numeric as expected_gap
    from req
    left join actuals on actuals.request_id = req.id
  ),
  request_rows as materialized (
    select
      rrb.*,
      case
        when rrb.actual_roi_status = 'on_track' then 'monitor'
        when rrb.attribution_quality = 'no_sales' then 'mapping_review'
        when rrb.actual_coverage_ratio < 0.5 and rrb.coverage_gap > 0 then 'high_risk_gap'
        else 'follow_up'
      end as recommended_action
    from request_rows_base rrb
    where (
        not exists (select 1 from filter_roi_statuses)
        or rrb.actual_roi_status in (select value from filter_roi_statuses)
      )
      and (
        not exists (select 1 from filter_attribution)
        or rrb.attribution_quality in (select value from filter_attribution)
      )
  ),
  filtered_hits as materialized (
    select ah.*
    from all_hits ah
    join request_rows rr on rr.id = ah.request_id
  ),
  actuals_by_line as (
    select line_label, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by line_label
  ),
  actuals_by_region as (
    select region_code, max(region_name) as region_name, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by region_code
  ),
  actuals_by_distributor as (
    select distributor_code, max(distributor_name) as distributor_name, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by distributor_code
  ),
  actuals_by_product as (
    select product_code, max(product_name) as product_name, max(line_label) as line_label, sum(sales_value)::numeric as actual_sales_value, sum(units)::numeric as actual_sales_units
    from filtered_hits
    group by product_code
  ),
  line_request_report as (
    select
      rpa.line_label as value,
      rpa.line_label as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      (select count(distinct pharmacy_id) from request_target_allocations rta join request_rows rrx on rrx.id = rta.request_id where rrx.id in (select request_id from request_product_allocations where line_label = rpa.line_label))::integer as pharmacy_count,
      sum(rr.estimated_cost * rpa.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rpa.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rpa.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_product_allocations rpa on rpa.request_id = rr.id
    group by rpa.line_label
  ),
  product_request_report as (
    select
      rpa.product_code as value,
      max(rpa.product_name) as label,
      max(rpa.line_label) as line_label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      (select count(distinct rta.pharmacy_id)
       from request_target_allocations rta
       join request_rows rrx on rrx.id = rta.request_id
       where rta.request_id in (select request_id from request_product_allocations where product_code = rpa.product_code))::integer as pharmacy_count,
      sum(rr.estimated_cost * rpa.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rpa.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rpa.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_product_allocations rpa on rpa.request_id = rr.id
    where rpa.product_code is not null
    group by rpa.product_code
  ),
  region_request_report as (
    select
      coalesce(rta.region_code, 'Unassigned') as value,
      coalesce(sr.region_name, rta.region_code, 'Unassigned') as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    left join public.source_of_sales_regions sr on sr.region_code = rta.region_code
    group by coalesce(rta.region_code, 'Unassigned'), coalesce(sr.region_name, rta.region_code, 'Unassigned')
  ),
  distributor_request_report as (
    select
      rta.distributor_code as value,
      max(rta.distributor_name) as label,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'on_track')::integer as on_track_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'behind')::integer as behind_requests,
      count(distinct rr.id) filter (where rr.actual_roi_status = 'no_data')::integer as no_data_requests,
      sum(rr.exact_sales_rows)::integer as exact_sales_rows,
      sum(rr.fallback_sales_rows)::integer as fallback_sales_rows
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    group by rta.distributor_code
  ),
  customer_request_report as (
    select
      rta.distributor_code || ':' || rta.customer_code as value,
      max(rta.pharmacy_name) as label,
      max(rta.distributor_code) as distributor_code,
      max(rta.distributor_name) as distributor_name,
      max(coalesce(sr.region_name, rta.region_code)) as region_name,
      count(distinct rr.id)::integer as request_count,
      count(distinct rr.customer_id)::integer as customer_count,
      count(distinct rta.pharmacy_id)::integer as pharmacy_count,
      sum(rr.estimated_cost * rta.share)::numeric as marketing_cost,
      sum(rr.required_roi_value * rta.share)::numeric as required_roi_value,
      sum(rr.expected_roi_value * rta.share)::numeric as expected_roi_value
    from request_rows rr
    join request_target_allocations rta on rta.request_id = rr.id
    left join public.source_of_sales_regions sr on sr.region_code = rta.region_code
    group by rta.distributor_code || ':' || rta.customer_code
  ),
  actuals_by_customer as (
    select
      distributor_code || ':' || client_code as value,
      coalesce(max(client_name), max(nullif(client_code, '')), max(client_code)) as label,
      max(distributor_code) as distributor_code,
      max(distributor_name) as distributor_name,
      max(region_name) as region_name,
      sum(sales_value)::numeric as actual_sales_value,
      sum(units)::numeric as actual_sales_units,
      count(distinct row_id)::integer as sales_rows,
      count(distinct row_id) filter (where match_type = 'exact')::integer as exact_sales_rows,
      count(distinct row_id) filter (where match_type = 'fallback')::integer as fallback_sales_rows
    from filtered_hits
    group by distributor_code || ':' || client_code
  ),
  roi_trend as (
    select
      pay_month as period,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value,
      sum(actual_sales_value)::numeric as actual_sales_value,
      sum(coverage_gap)::numeric as coverage_gap,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count
    from request_rows
    group by pay_month
  ),
  attribution_summary as (
    select
      coalesce(sum(exact_sales_rows), 0)::integer as exact_sales_rows,
      coalesce(sum(fallback_sales_rows), 0)::integer as fallback_sales_rows,
      count(*) filter (where attribution_quality = 'mixed')::integer as mixed_requests,
      count(*) filter (where attribution_quality = 'no_sales')::integer as no_sales_requests,
      (
        select count(*)::integer
        from req_targets rt
        join request_rows rr on rr.id = rt.request_id
        where rt.missing_customer_mapping
      ) + (
        select count(*)::integer
        from req_products rp
        join request_rows rr on rr.id = rp.request_id
        where rp.missing_sales_product_mapping
      ) as unmatched_mapping_count
    from request_rows
  ),
  dashboard_summary as (
    select
      count(*)::integer as marketing_request_count,
      count(*)::integer as paid_request_count,
      count(distinct customer_id)::integer as active_customers,
      (
        select count(distinct rta.pharmacy_id)::integer
        from request_target_allocations rta
        join request_rows rr on rr.id = rta.request_id
      ) as active_pharmacies,
      coalesce(sum(estimated_cost), 0)::numeric as total_marketing_cost,
      coalesce(sum(required_roi_value), 0)::numeric as required_roi_value,
      coalesce(sum(expected_roi_value), 0)::numeric as expected_roi_value,
      coalesce(sum(actual_sales_value), 0)::numeric as actual_sales_value,
      coalesce(sum(actual_sales_units), 0)::numeric as actual_sales_units,
      coalesce(sum(coverage_gap), 0)::numeric as coverage_gap,
      coalesce(sum(expected_gap), 0)::numeric as expected_gap,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count,
      count(*) filter (where recommended_action <> 'monitor')::integer as action_required_count,
      coalesce(sum(estimated_cost) filter (where actual_roi_status in ('behind', 'no_data')), 0)::numeric as spend_at_risk,
      coalesce(sum(estimated_cost) filter (where actual_roi_status = 'no_data'), 0)::numeric as no_data_spend
    from request_rows
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'limits', jsonb_build_object(
      'tableLimit', (select row_limit from params),
      'rawRowsReturned', 0
    ),
    'filters', jsonb_build_object(
      'selected', jsonb_build_object(
        'lines', coalesce(to_jsonb(p_lines), '[]'::jsonb),
        'regions', coalesce(to_jsonb(p_regions), '[]'::jsonb),
        'distributors', coalesce(to_jsonb(p_distributor_codes), '[]'::jsonb),
        'products', coalesce(to_jsonb(p_product_codes), '[]'::jsonb),
        'roiStatuses', coalesce(to_jsonb(p_roi_statuses), '[]'::jsonb),
        'attributionQualities', coalesce(to_jsonb(p_attribution_qualities), '[]'::jsonb),
        'customerSearch', p_customer_search,
        'fromMonth', p_from_month,
        'toMonth', p_to_month
      ),
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object('value', label, 'label', label) order by label), '[]'::jsonb)
        from (
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.source_of_sales_products
          where active
          union
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.marketing_products
          where active
        ) options
      ),
      'regions', (
        select coalesce(jsonb_agg(jsonb_build_object('value', region_code, 'label', region_name) order by region_name), '[]'::jsonb)
        from public.source_of_sales_regions
        where active
      ),
      'distributors', (
        select coalesce(jsonb_agg(jsonb_build_object('value', distributor_code, 'label', distributor_name) order by distributor_name), '[]'::jsonb)
        from public.source_of_sales_distributors
        where active
      ),
      'products', (
        select coalesce(jsonb_agg(jsonb_build_object('value', product_code, 'label', product_name) order by product_name), '[]'::jsonb)
        from public.source_of_sales_products
        where active
      ),
      'roiStatuses', jsonb_build_array(
        jsonb_build_object('value', 'behind', 'label', 'Behind'),
        jsonb_build_object('value', 'no_data', 'label', 'No data'),
        jsonb_build_object('value', 'on_track', 'label', 'On track')
      ),
      'attributionQualities', jsonb_build_array(
        jsonb_build_object('value', 'exact_customer', 'label', 'Exact customer'),
        jsonb_build_object('value', 'no_sales', 'label', 'No sales')
      )
    ),
    'summary', (
      select jsonb_build_object(
        'marketingRequestCount', marketing_request_count,
        'paidRequestCount', paid_request_count,
        'activeCustomers', active_customers,
        'activePharmacies', active_pharmacies,
        'totalMarketingCost', total_marketing_cost,
        'requiredRoiValue', required_roi_value,
        'expectedRoiValue', expected_roi_value,
        'actualAttributedSalesValue', actual_sales_value,
        'actualAttributedSalesUnits', actual_sales_units,
        'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end,
        'coverageGap', coverage_gap,
        'expectedGap', expected_gap,
        'onTrackRequests', on_track_count,
        'behindRequests', behind_count,
        'noDataRequests', no_data_count,
        'actionRequiredRequests', action_required_count,
        'spendAtRisk', spend_at_risk,
        'noDataSpend', no_data_spend
      )
      from dashboard_summary
    ),
    'decisionSummary', (
      select jsonb_build_object(
        'actionRequiredRequests', action_required_count,
        'spendAtRisk', spend_at_risk,
        'coverageGap', coverage_gap,
        'expectedGap', expected_gap,
        'noDataSpend', no_data_spend,
        'topRiskRequest', (
          select coalesce(jsonb_build_object(
            'id', id,
            'requestCode', request_code,
            'customerName', customer_name,
            'line', line_label,
            'estimatedCost', estimated_cost,
            'requiredRoiValue', required_roi_value,
            'actualSalesValue', actual_sales_value,
            'coverageGap', coverage_gap,
            'actualRoiCoverage', actual_coverage_ratio,
            'actualRoiStatus', actual_roi_status,
            'attributionQuality', attribution_quality,
            'recommendedAction', recommended_action
          ), '{}'::jsonb)
          from request_rows
          order by coverage_gap desc, estimated_cost desc
          limit 1
        )
      )
      from dashboard_summary
    ),
    'attributionHealth', (
      select jsonb_build_object(
        'exactSalesRows', exact_sales_rows,
        'fallbackSalesRows', fallback_sales_rows,
        'mixedRequests', mixed_requests,
        'noSalesRequests', no_sales_requests,
        'unmatchedMappingWarnings', unmatched_mapping_count
      )
      from attribution_summary
    ),
    'roiTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', period,
        'requestCount', request_count,
        'marketingCost', marketing_cost,
        'requiredRoiValue', required_roi_value,
        'expectedRoiValue', expected_roi_value,
        'actualSalesValue', actual_sales_value,
        'coverageGap', coverage_gap,
        'onTrackCount', on_track_count,
        'behindCount', behind_count,
        'noDataCount', no_data_count
      ) order by period), '[]'::jsonb)
      from roi_trend
    ),
    'lineRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(lr.value, al.line_label, 'Unassigned'),
          'label', coalesce(lr.label, al.line_label, 'Unassigned'),
          'line', coalesce(lr.label, al.line_label, 'Unassigned'),
          'requestCount', coalesce(lr.request_count, 0),
          'customerCount', coalesce(lr.customer_count, 0),
          'pharmacyCount', coalesce(lr.pharmacy_count, 0),
          'marketingCost', coalesce(lr.marketing_cost, 0),
          'requiredRoiValue', coalesce(lr.required_roi_value, 0),
          'expectedRoiValue', coalesce(lr.expected_roi_value, 0),
          'actualSalesValue', coalesce(al.actual_sales_value, 0),
          'actualSalesUnits', coalesce(al.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(lr.required_roi_value, 0) - coalesce(al.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(lr.required_roi_value, 0) > 0 then coalesce(al.actual_sales_value, 0) / lr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(lr.on_track_requests, 0),
          'behindRequests', coalesce(lr.behind_requests, 0),
          'noDataRequests', coalesce(lr.no_data_requests, 0),
          'exactSalesRows', coalesce(lr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(lr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(lr.required_roi_value, 0) - coalesce(al.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(lr.marketing_cost, 0) as marketing_cost
        from line_request_report lr
        full join actuals_by_line al on lower(btrim(al.line_label)) = lower(btrim(lr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'productRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(pr.value, ap.product_code, 'Unassigned'),
          'label', coalesce(pr.label, ap.product_name, 'Unassigned'),
          'line', coalesce(pr.line_label, ap.line_label, 'Unassigned'),
          'requestCount', coalesce(pr.request_count, 0),
          'customerCount', coalesce(pr.customer_count, 0),
          'pharmacyCount', coalesce(pr.pharmacy_count, 0),
          'marketingCost', coalesce(pr.marketing_cost, 0),
          'requiredRoiValue', coalesce(pr.required_roi_value, 0),
          'expectedRoiValue', coalesce(pr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ap.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ap.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(pr.required_roi_value, 0) - coalesce(ap.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(pr.required_roi_value, 0) > 0 then coalesce(ap.actual_sales_value, 0) / pr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(pr.on_track_requests, 0),
          'behindRequests', coalesce(pr.behind_requests, 0),
          'noDataRequests', coalesce(pr.no_data_requests, 0),
          'exactSalesRows', coalesce(pr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(pr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(pr.required_roi_value, 0) - coalesce(ap.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(pr.marketing_cost, 0) as marketing_cost
        from product_request_report pr
        full join actuals_by_product ap on upper(btrim(ap.product_code)) = upper(btrim(pr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'regionRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(rr.value, ar.region_code, 'Unassigned'),
          'label', coalesce(rr.label, ar.region_name, 'Unassigned'),
          'requestCount', coalesce(rr.request_count, 0),
          'customerCount', coalesce(rr.customer_count, 0),
          'pharmacyCount', coalesce(rr.pharmacy_count, 0),
          'marketingCost', coalesce(rr.marketing_cost, 0),
          'requiredRoiValue', coalesce(rr.required_roi_value, 0),
          'expectedRoiValue', coalesce(rr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ar.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ar.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(rr.required_roi_value, 0) - coalesce(ar.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(rr.required_roi_value, 0) > 0 then coalesce(ar.actual_sales_value, 0) / rr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(rr.on_track_requests, 0),
          'behindRequests', coalesce(rr.behind_requests, 0),
          'noDataRequests', coalesce(rr.no_data_requests, 0),
          'exactSalesRows', coalesce(rr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(rr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(rr.required_roi_value, 0) - coalesce(ar.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(rr.marketing_cost, 0) as marketing_cost
        from region_request_report rr
        full join actuals_by_region ar on lower(btrim(ar.region_code)) = lower(btrim(rr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'distributorRoi', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, marketing_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(dr.value, ad.distributor_code, 'Unassigned'),
          'label', coalesce(dr.label, ad.distributor_name, 'Unassigned'),
          'requestCount', coalesce(dr.request_count, 0),
          'customerCount', coalesce(dr.customer_count, 0),
          'pharmacyCount', coalesce(dr.pharmacy_count, 0),
          'marketingCost', coalesce(dr.marketing_cost, 0),
          'requiredRoiValue', coalesce(dr.required_roi_value, 0),
          'expectedRoiValue', coalesce(dr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ad.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ad.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(dr.required_roi_value, 0) - coalesce(ad.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(dr.required_roi_value, 0) > 0 then coalesce(ad.actual_sales_value, 0) / dr.required_roi_value else 0 end,
          'onTrackRequests', coalesce(dr.on_track_requests, 0),
          'behindRequests', coalesce(dr.behind_requests, 0),
          'noDataRequests', coalesce(dr.no_data_requests, 0),
          'exactSalesRows', coalesce(dr.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(dr.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(dr.required_roi_value, 0) - coalesce(ad.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(dr.marketing_cost, 0) as marketing_cost
        from distributor_request_report dr
        full join actuals_by_distributor ad on upper(btrim(ad.distributor_code)) = upper(btrim(dr.value))
        order by coverage_gap desc, marketing_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'requestReport', (
      select coalesce(jsonb_agg(row_json order by risk_rank asc, coverage_gap desc, estimated_cost desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', id,
          'requestCode', request_code,
          'status', status,
          'payDate', pay_date,
          'payMonth', pay_month,
          'roiDurationMonths', roi_duration_months,
          'customerName', customer_name,
          'customerCode', customer_code,
          'line', line_label,
          'estimatedCost', estimated_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualSalesUnits', actual_sales_units,
          'actualRoiCoverage', actual_coverage_ratio,
          'coverageGap', coverage_gap,
          'expectedGap', expected_gap,
          'actualRoiStatus', actual_roi_status,
          'attributionQuality', attribution_quality,
          'recommendedAction', recommended_action,
          'exactSalesRows', exact_sales_rows,
          'fallbackSalesRows', fallback_sales_rows,
          'salesRows', sales_rows
        ) as row_json,
        case actual_roi_status when 'no_data' then 0 when 'behind' then 1 else 2 end as risk_rank,
        coverage_gap,
        estimated_cost
        from request_rows
        order by risk_rank asc, coverage_gap desc, estimated_cost desc
        limit (select row_limit from params)
      ) rows
    ),
    'customerImpact', (
      select coalesce(jsonb_agg(row_json order by coverage_gap desc, actual_sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', coalesce(cr.value, ac.value, 'Unassigned'),
          'label', coalesce(cr.label, ac.label, 'Unassigned'),
          'distributorCode', coalesce(cr.distributor_code, ac.distributor_code),
          'distributorName', coalesce(cr.distributor_name, ac.distributor_name),
          'regionName', coalesce(cr.region_name, ac.region_name),
          'requestCount', coalesce(cr.request_count, 0),
          'customerCount', coalesce(cr.customer_count, 0),
          'pharmacyCount', coalesce(cr.pharmacy_count, 0),
          'marketingCost', coalesce(cr.marketing_cost, 0),
          'requiredRoiValue', coalesce(cr.required_roi_value, 0),
          'expectedRoiValue', coalesce(cr.expected_roi_value, 0),
          'actualSalesValue', coalesce(ac.actual_sales_value, 0),
          'actualSalesUnits', coalesce(ac.actual_sales_units, 0),
          'coverageGap', greatest(coalesce(cr.required_roi_value, 0) - coalesce(ac.actual_sales_value, 0), 0),
          'actualRoiCoverage', case when coalesce(cr.required_roi_value, 0) > 0 then coalesce(ac.actual_sales_value, 0) / cr.required_roi_value else 0 end,
          'salesRows', coalesce(ac.sales_rows, 0),
          'exactSalesRows', coalesce(ac.exact_sales_rows, 0),
          'fallbackSalesRows', coalesce(ac.fallback_sales_rows, 0)
        ) as row_json,
        greatest(coalesce(cr.required_roi_value, 0) - coalesce(ac.actual_sales_value, 0), 0) as coverage_gap,
        coalesce(ac.actual_sales_value, 0) as actual_sales_value
        from customer_request_report cr
        full join actuals_by_customer ac on ac.value = cr.value
        order by coverage_gap desc, actual_sales_value desc
        limit (select row_limit from params)
      ) rows
    )
  );
$function$;

revoke execute on function public.phx_marketing_roi_customer_dashboard(p_lines text[], p_regions text[], p_distributor_codes text[], p_product_codes text[], p_roi_statuses text[], p_attribution_qualities text[], p_customer_search text, p_from_month text, p_to_month text, p_limit integer, p_exclude_codes text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_roi_customer_dashboard(p_lines text[], p_regions text[], p_distributor_codes text[], p_product_codes text[], p_roi_statuses text[], p_attribution_qualities text[], p_customer_search text, p_from_month text, p_to_month text, p_limit integer, p_exclude_codes text[]) to service_role;

-- ── phx_refresh_marketing_roi_facts ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_refresh_marketing_roi_facts(p_batch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_run_id uuid; v_lock_key bigint := abs(hashtext('marketing_roi_refresh')::bigint);
  v_affected_periods text[] := '{}'; v_affected_ids uuid[] := '{}'; v_source_batch_ids uuid[] := '{}';
  v_min_period text; v_max_period text;
  v_cnt_requests bigint := 0; v_cnt_trends bigint := 0; v_cnt_lines bigint := 0; v_cnt_products bigint := 0;
  v_cnt_regions bigint := 0; v_cnt_distributors bigint := 0; v_cnt_customers bigint := 0; v_cnt_request_geo bigint := 0;
begin
  if not pg_try_advisory_xact_lock(v_lock_key) then
    insert into marketing_roi_refresh_runs (triggered_by, trigger_batch_id, status, calculation_version)
    values (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end, p_batch_id, 'skipped', '3')
    returning id into v_run_id;
    return jsonb_build_object('status', 'skipped', 'runId', v_run_id);
  end if;
  insert into marketing_roi_refresh_runs (triggered_by, trigger_batch_id, status, calculation_version)
  values (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end, p_batch_id, 'running', '3')
  returning id into v_run_id;
  begin
    if p_batch_id is not null then
      select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}'), min(invoice_period), max(invoice_period)
      into v_affected_periods, v_min_period, v_max_period
      from source_of_sales_import_rows where batch_id = p_batch_id and validation_state = 'valid';
      v_source_batch_ids := array[p_batch_id];
      if v_min_period is not null then
        select coalesce(array_agg(mr.id), '{}') into v_affected_ids from marketing_requests mr
        where mr.pay_date is not null
          and to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') <= v_max_period
          and to_char(date_trunc('month', mr.pay_date) + make_interval(months => greatest(coalesce(mr.roi_duration_months,1),1) - 1), 'YYYY-MM') >= v_min_period;
      end if;
    else
      select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}') into v_affected_periods
      from source_of_sales_import_rows where validation_state = 'valid';
      select coalesce(array_agg(distinct id), '{}') into v_source_batch_ids from source_of_sales_import_batches where status = 'validated';
      select coalesce(array_agg(mr.id), '{}') into v_affected_ids from marketing_requests mr where mr.pay_date is not null;
    end if;
    if coalesce(array_length(v_affected_ids, 1), 0) = 0 then
      update marketing_roi_refresh_runs set status = 'success', finished_at = now(), affected_periods = v_affected_periods,
        row_counts = '{"requests":0,"trends":0,"lines":0,"products":0,"regions":0,"distributors":0,"customers":0,"requestGeo":0}'::jsonb
      where id = v_run_id;
      return jsonb_build_object('status','success','runId',v_run_id,'affectedRequests',0);
    end if;
    delete from marketing_roi_request_facts where request_id = any(v_affected_ids);
    delete from marketing_roi_request_geo_facts where request_id = any(v_affected_ids);
    delete from marketing_roi_trend_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_line_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_product_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_region_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_distributor_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    delete from marketing_roi_customer_facts where period in (select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM') from marketing_requests where id = any(v_affected_ids));
    with
    req_raw as materialized (
      select mr.id, mr.request_code, mr.pay_date, to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') as pay_month,
        greatest(coalesce(mr.roi_duration_months,1),1) as roi_duration_months,
        coalesce(mr.estimated_cost, 0)::numeric as estimated_cost,
        coalesce(mr.required_roi_value, coalesce(mr.estimated_cost,0)*10)::numeric as required_roi_value,
        coalesce(mr.expected_roi_value, 0)::numeric as expected_roi_value, mr.customer_id,
        coalesce(l.name, 'Unassigned') as request_line, coalesce(mc.display_name, mr.customer_id::text) as customer_name,
        mc.customer_code, mr.status as request_status, coalesce(mr.track_direct_sales, false) as track_direct_sales
      from marketing_requests mr
      left join employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
      left join lines l on l.id = coalesce(mr.line_id, emp_req.line_id)
      left join marketing_customers mc on mc.id = mr.customer_id
      where mr.id = any(v_affected_ids)
    ),
    req_products_all as materialized (
      select distinct mrp.request_id, upper(btrim(sp.product_code)) as product_code,
        coalesce(sp.product_name, mp.product_name, mrp.product_name_snapshot) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(mp.line),''), nullif(btrim(mrp.line_snapshot),''), 'Unassigned') as line_label,
        coalesce(mrp.expected_value, 0)::numeric as expected_value, coalesce(mrp.value_share, 0)::numeric as value_share
      from marketing_request_products mrp join marketing_products mp on mp.id = mrp.product_id
      left join source_of_sales_products sp on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
      where mrp.request_id in (select id from req_raw)
    ),
    req_targets_all as materialized (
      select distinct mrph.request_id, sd.distributor_code,
        coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
        sd.distributor_code as family_code, mpdc.normalized_pharmacy_code as customer_code,
        mph.id as pharmacy_id, coalesce(mph.display_name, mpdc.normalized_pharmacy_code) as pharmacy_name,
        cm.brick_id, cm.region_code, cm.area_code
      from marketing_request_pharmacies mrph
      join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
      join marketing_distributors md on md.id = mpdc.distributor_id
      join marketing_pharmacies mph on mph.id = mrph.pharmacy_id
      join (select distinct marketing_normalized_name, parent_distributor_code from marketing_roi_distributor_rollup) ru on ru.marketing_normalized_name = md.normalized_name
      join source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
      left join lateral (
        select cmx.brick_id, cmx.region_code, cmx.area_code from source_of_sales_customer_map cmx
        where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g'))) = mpdc.normalized_pharmacy_code
          and cmx.active
          and (cmx.distributor_code = sd.distributor_code or exists (select 1 from marketing_roi_distributor_rollup rcm where rcm.parent_distributor_code = sd.distributor_code and rcm.sos_distributor_code = cmx.distributor_code))
        order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last limit 1
      ) cm on true
      where mrph.request_id in (select id from req_raw) and coalesce(btrim(mpdc.normalized_pharmacy_code),'') <> '' and coalesce(mpdc.active, true)
    ),
    req as materialized (
      select rr.*, coalesce(nullif(btrim(rr.request_line),''), (select max(rpa.line_label) from req_products_all rpa where rpa.request_id = rr.id), 'Unassigned') as line_label
      from req_raw rr
    ),
    req_products as materialized (select rpa.* from req_products_all rpa join req on req.id = rpa.request_id),
    req_targets as materialized (select rta.* from req_targets_all rta join req on req.id = rta.request_id),
    product_rollups as (
      select request_id, count(*)::numeric as product_count, coalesce(sum(nullif(value_share,0)),0)::numeric as value_share_total, coalesce(sum(expected_value),0)::numeric as expected_total
      from req_products group by request_id
    ),
    request_product_allocations as materialized (
      select rp.request_id, rp.product_code, rp.product_name, rp.line_label, rp.expected_value, rp.value_share,
        case when pr.value_share_total > 0 then rp.value_share / pr.value_share_total
             when pr.expected_total > 0 then rp.expected_value / pr.expected_total
             when pr.product_count > 0 then 1 / pr.product_count else 0 end as share
      from req_products rp join product_rollups pr on pr.request_id = rp.request_id
    ),
    target_rollups as (select request_id, count(*)::numeric as target_count from req_targets group by request_id),
    request_target_allocations as materialized (
      select rt.*, case when tr.target_count > 0 then 1 / tr.target_count else 0 end as share
      from req_targets rt join target_rollups tr on tr.request_id = rt.request_id
    ),
    periods as materialized (
      select req.id, array_agg(to_char(g,'YYYY-MM')) as periods from req
      cross join lateral generate_series(date_trunc('month', req.pay_date), date_trunc('month', req.pay_date) + make_interval(months => req.roi_duration_months - 1), interval '1 month') as g
      group by req.id
    ),
    target_products as materialized (
      select distinct rt.request_id, rt.distributor_code, rt.customer_code, rt.brick_id, rpa.product_code
      from req_targets rt join request_product_allocations rpa on rpa.request_id = rt.request_id where rpa.product_code is not null
    ),
    exact_hits as materialized (
      select distinct tp.request_id, r.id::text as row_id, tp.distributor_code,
        coalesce(sd.distributor_name, tp.distributor_code) as distributor_name,
        lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g'))) as client_code,
        nullif(btrim(r.client_name),'') as client_name, r.region_code,
        coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
        nullif(btrim(r.brick_id),'') as brick_id, upper(btrim(r.product_code)) as product_code,
        coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(r.official_line),''), 'Unassigned') as line_label,
        coalesce(r.qty,0)::numeric as units,
        (case when coalesce(r.is_direct, false) then coalesce(r.value, 0) else coalesce(r.qty,0) * coalesce(sp.factory_price,0) end)::numeric as sales_value,
        'exact'::text as match_type
      from target_products tp
      join periods on periods.id = tp.request_id
      join marketing_roi_distributor_rollup rr_exact on rr_exact.parent_distributor_code = tp.distributor_code
      join source_of_sales_import_rows r on r.distributor_code = rr_exact.sos_distributor_code
       and lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g'))) = tp.customer_code
       and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
       and r.invoice_period = any(periods.periods) and r.validation_state = 'valid'
      join source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
      join source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
      left join source_of_sales_distributors sd on sd.distributor_code = tp.distributor_code
      left join source_of_sales_regions sr on sr.region_code = r.region_code
    ),
    direct_hits as materialized (
      select distinct req.id as request_id, dor.id::text as row_id, md.distributor_code as distributor_code,
        coalesce(md.display_name, md.distributor_code) as distributor_name,
        lower(btrim(regexp_replace(coalesce(dopdc.customer_code,''),'\s+',' ','g'))) as client_code,
        nullif(btrim(dph.pharmacy_name),'') as client_name, dopdc.mapped_region_code as region_code,
        coalesce(sr.region_name, dopdc.mapped_region_code) as region_name,
        nullif(btrim(dopdc.mapped_brick_id),'') as brick_id, upper(btrim(dor.product_code)) as product_code,
        coalesce(sp.product_name, dor.product_name, dor.product_code) as product_name,
        coalesce(nullif(btrim(sp.line),''), nullif(btrim(dor.line),''), 'Unassigned') as line_label,
        coalesce(dor.qty,0)::numeric as units, coalesce(dor.sales_value,0)::numeric as sales_value, 'direct'::text as match_type
      from req
      join periods on periods.id = req.id
      join req_products rp on rp.request_id = req.id
      join marketing_request_pharmacies mrph on mrph.request_id = req.id
      join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id and coalesce(mpdc.active, true)
      join marketing_distributors md on md.id = mpdc.distributor_id
      join direct_order_pharmacy_distributor_codes dopdc
        on lower(btrim(dopdc.distributor_code)) = lower(btrim(md.distributor_code))
       and lower(btrim(regexp_replace(coalesce(dopdc.customer_code,''),'\s+',' ','g'))) = lower(btrim(regexp_replace(coalesce(mpdc.normalized_pharmacy_code,''),'\s+',' ','g')))
      join direct_order_pharmacies dph on dph.id = dopdc.pharmacy_id
      join direct_order_requests dor on dor.pharmacy_id = dopdc.pharmacy_id and dor.status = 'approved' and dor.reversal_of_request_id is null
       and dor.sales_month = any(periods.periods) and upper(btrim(dor.product_code)) = upper(btrim(rp.product_code))
      left join source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(dor.product_code))
      left join source_of_sales_regions sr on sr.region_code = dopdc.mapped_region_code
      where req.track_direct_sales = true
    ),
    all_hits as materialized (select * from exact_hits union all select * from direct_hits),
    actuals as materialized (
      select request_id, coalesce(sum(sales_value),0)::numeric as actual_value, coalesce(sum(units),0)::numeric as actual_units,
        count(distinct row_id)::integer as sales_rows,
        count(distinct row_id) filter (where match_type='exact')::integer as exact_sales_rows,
        count(distinct row_id) filter (where match_type='fallback')::integer as fallback_sales_rows
      from all_hits group by request_id
    ),
    request_rows_base as materialized (
      select req.id, req.request_code, req.pay_month, req.roi_duration_months, req.estimated_cost, req.required_roi_value,
        req.expected_roi_value, req.customer_id, req.customer_name, req.customer_code, req.line_label, req.request_status,
        coalesce(a.actual_value, 0)::numeric as actual_sales_value, coalesce(a.actual_units, 0)::numeric as actual_sales_units,
        coalesce(a.sales_rows, 0)::integer as sales_rows, coalesce(a.exact_sales_rows, 0)::integer as exact_sales_rows,
        coalesce(a.fallback_sales_rows, 0)::integer as fallback_sales_rows,
        case when coalesce(a.sales_rows,0) = 0 then 'no_sales' else 'exact_customer' end as attribution_quality,
        case when coalesce(a.sales_rows,0) = 0 then 'no_data' when coalesce(a.actual_value,0) >= req.required_roi_value then 'on_track' else 'behind' end as actual_roi_status,
        case when req.required_roi_value > 0 then coalesce(a.actual_value,0) / req.required_roi_value when coalesce(a.actual_value,0) > 0 then 1 else 0 end as actual_coverage_ratio,
        greatest(req.required_roi_value - coalesce(a.actual_value,0), 0)::numeric as coverage_gap,
        greatest(req.expected_roi_value - coalesce(a.actual_value,0), 0)::numeric as expected_gap
      from req left join actuals a on a.request_id = req.id
    ),
    request_rows as materialized (
      select rrb.*, case when rrb.actual_roi_status = 'on_track' then 'monitor' when rrb.attribution_quality = 'no_sales' then 'mapping_review'
        when rrb.actual_coverage_ratio < 0.5 and rrb.coverage_gap > 0 then 'high_risk_gap' else 'follow_up' end as recommended_action
      from request_rows_base rrb
    ),
    request_rows_approved as materialized (select * from request_rows where request_status in ('approved','active','roi_tracking','closed','finance_hold')),
    actuals_by_line as (select rr.pay_month, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.line_label),
    actuals_by_product as (select rr.pay_month, ah.product_code, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.product_code),
    actuals_by_region as (select rr.pay_month, ah.region_code, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id where ah.region_code is not null group by rr.pay_month, ah.region_code, ah.line_label),
    actuals_by_distributor as (select rr.pay_month, ah.distributor_code, ah.line_label, sum(ah.sales_value)::numeric as actual_sales_value from all_hits ah join request_rows_approved rr on rr.id = ah.request_id group by rr.pay_month, ah.distributor_code, ah.line_label),
    actuals_by_customer_dist as (select rr.pay_month, rr.customer_id, ah.distributor_code, sum(ah.sales_value)::numeric as actual_sales_value, sum(ah.units)::numeric as actual_sales_units from all_hits ah join request_rows_approved rr on rr.id = ah.request_id where rr.customer_id is not null group by rr.pay_month, rr.customer_id, ah.distributor_code),
    actuals_by_request_geo as (select ah.request_id, ah.distributor_code, ah.region_code, sum(ah.sales_value)::numeric as actual_sales_value, sum(ah.units)::numeric as actual_sales_units, count(distinct ah.row_id)::integer as sales_rows from all_hits ah group by ah.request_id, ah.distributor_code, ah.region_code),
    ins_requests as (
      insert into marketing_roi_request_facts (refresh_run_id, request_id, request_code, pay_month, line_label, customer_id, customer_name, customer_code, estimated_cost, required_roi_value, expected_roi_value, actual_sales_value, actual_sales_units, sales_rows, exact_sales_rows, fallback_sales_rows, attribution_quality, actual_roi_status, actual_coverage_ratio, coverage_gap, expected_gap, recommended_action, source_batch_ids, source_periods, calculation_version, request_status)
      select v_run_id, rr.id, rr.request_code, rr.pay_month, rr.line_label, rr.customer_id, rr.customer_name, rr.customer_code, rr.estimated_cost, rr.required_roi_value, rr.expected_roi_value, rr.actual_sales_value, rr.actual_sales_units, rr.sales_rows, rr.exact_sales_rows, rr.fallback_sales_rows, rr.attribution_quality, rr.actual_roi_status, rr.actual_coverage_ratio, rr.coverage_gap, rr.expected_gap, rr.recommended_action, v_source_batch_ids, p.periods, '3', rr.request_status
      from request_rows rr left join periods p on p.id = rr.id returning 1
    ),
    ins_request_geo as (
      insert into marketing_roi_request_geo_facts (refresh_run_id, request_id, distributor_code, region_code, actual_sales_value, actual_sales_units, sales_rows, calculation_version)
      select v_run_id, abrg.request_id, abrg.distributor_code, abrg.region_code, abrg.actual_sales_value, abrg.actual_sales_units, abrg.sales_rows, '3' from actuals_by_request_geo abrg returning 1
    ),
    ins_trends as (
      insert into marketing_roi_trend_facts (refresh_run_id, period, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, pay_month, count(*)::integer, sum(estimated_cost)::numeric, sum(required_roi_value)::numeric, sum(expected_roi_value)::numeric, sum(actual_sales_value)::numeric, sum(coverage_gap)::numeric, count(*) filter (where actual_roi_status='on_track')::integer, count(*) filter (where actual_roi_status='behind')::integer, count(*) filter (where actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved group by pay_month returning 1
    ),
    ins_lines as (
      insert into marketing_roi_line_facts (refresh_run_id, period, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rpa.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rpa.share)::numeric, sum(rr.required_roi_value * rpa.share)::numeric, sum(rr.expected_roi_value * rpa.share)::numeric, max(coalesce(abl.actual_sales_value, 0)), sum(rr.coverage_gap * rpa.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_product_allocations rpa on rpa.request_id = rr.id left join actuals_by_line abl on abl.line_label = rpa.line_label and abl.pay_month = rr.pay_month group by rr.pay_month, rpa.line_label returning 1
    ),
    ins_products as (
      insert into marketing_roi_product_facts (refresh_run_id, period, product_code, product_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, actual_sales_units, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rpa.product_code, max(rpa.product_name), max(rpa.line_label), count(distinct rr.id)::integer, sum(rr.estimated_cost * rpa.share)::numeric, sum(rr.required_roi_value * rpa.share)::numeric, sum(rr.expected_roi_value * rpa.share)::numeric, max(coalesce(abp.actual_sales_value, 0)), coalesce(sum(rr.actual_sales_units * rpa.share), 0)::numeric, sum(rr.coverage_gap * rpa.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_product_allocations rpa on rpa.request_id = rr.id left join actuals_by_product abp on abp.product_code = rpa.product_code and abp.pay_month = rr.pay_month where rpa.product_code is not null group by rr.pay_month, rpa.product_code returning 1
    ),
    ins_regions as (
      insert into marketing_roi_region_facts (refresh_run_id, period, region_code, region_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, coalesce(rta.region_code, 'Unassigned'), max(coalesce(sr.region_name, rta.region_code, 'Unassigned')), rr.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, sum(rr.expected_roi_value * rta.share)::numeric, max(coalesce(abr.actual_sales_value, 0)), sum(rr.coverage_gap * rta.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join source_of_sales_regions sr on sr.region_code = rta.region_code left join actuals_by_region abr on abr.region_code = rta.region_code and abr.pay_month = rr.pay_month and abr.line_label = rr.line_label group by rr.pay_month, coalesce(rta.region_code, 'Unassigned'), rr.line_label returning 1
    ),
    ins_distributors as (
      insert into marketing_roi_distributor_facts (refresh_run_id, period, distributor_code, family_code, distributor_name, line_label, request_count, marketing_cost, required_roi_value, expected_roi_value, actual_sales_value, coverage_gap, on_track_requests, behind_requests, no_data_requests, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rta.distributor_code, rta.family_code, max(rta.distributor_name), rr.line_label, count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, sum(rr.expected_roi_value * rta.share)::numeric, max(coalesce(abd.actual_sales_value, 0)), sum(rr.coverage_gap * rta.share)::numeric, count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer, count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join actuals_by_distributor abd on abd.distributor_code = rta.distributor_code and abd.pay_month = rr.pay_month and abd.line_label = rr.line_label group by rr.pay_month, rta.distributor_code, rta.family_code, rr.line_label returning 1
    ),
    ins_customers as (
      insert into marketing_roi_customer_facts (refresh_run_id, period, customer_id, customer_code, customer_name, distributor_code, family_code, request_count, marketing_cost, required_roi_value, actual_sales_value, actual_sales_units, exact_sales_rows, fallback_sales_rows, attribution_quality, actual_roi_status, source_batch_ids, source_periods, calculation_version)
      select v_run_id, rr.pay_month, rr.customer_id, max(rr.customer_code), max(rr.customer_name), rta.distributor_code, max(rta.family_code), count(distinct rr.id)::integer, sum(rr.estimated_cost * rta.share)::numeric, sum(rr.required_roi_value * rta.share)::numeric, max(coalesce(acbd.actual_sales_value, 0)), max(coalesce(acbd.actual_sales_units, 0)), sum(rr.exact_sales_rows)::integer, sum(rr.fallback_sales_rows)::integer, case when bool_or(rr.attribution_quality = 'no_sales') then 'no_sales' else 'exact_customer' end, case when bool_or(rr.actual_roi_status = 'no_data') then 'no_data' when bool_or(rr.actual_roi_status = 'behind') then 'behind' else 'on_track' end, v_source_batch_ids, v_affected_periods, '3'
      from request_rows_approved rr join request_target_allocations rta on rta.request_id = rr.id left join actuals_by_customer_dist acbd on acbd.customer_id = rr.customer_id and acbd.distributor_code = rta.distributor_code and acbd.pay_month = rr.pay_month where rr.customer_id is not null group by rr.pay_month, rr.customer_id, rta.distributor_code returning 1
    )
    select (select count(*) from ins_requests)::bigint, (select count(*) from ins_trends)::bigint, (select count(*) from ins_lines)::bigint, (select count(*) from ins_products)::bigint, (select count(*) from ins_regions)::bigint, (select count(*) from ins_distributors)::bigint, (select count(*) from ins_customers)::bigint, (select count(*) from ins_request_geo)::bigint
    into v_cnt_requests, v_cnt_trends, v_cnt_lines, v_cnt_products, v_cnt_regions, v_cnt_distributors, v_cnt_customers, v_cnt_request_geo;
    update marketing_roi_refresh_runs set status = 'success', finished_at = now(), affected_periods = v_affected_periods,
      row_counts = jsonb_build_object('requests', v_cnt_requests, 'trends', v_cnt_trends, 'lines', v_cnt_lines, 'products', v_cnt_products, 'regions', v_cnt_regions, 'distributors', v_cnt_distributors, 'customers', v_cnt_customers, 'requestGeo', v_cnt_request_geo)
    where id = v_run_id;
    return jsonb_build_object('status', 'success', 'runId', v_run_id, 'affectedRequests', v_cnt_requests, 'rowCounts', jsonb_build_object('requests', v_cnt_requests, 'trends', v_cnt_trends, 'lines', v_cnt_lines, 'products', v_cnt_products, 'regions', v_cnt_regions, 'distributors', v_cnt_distributors, 'customers', v_cnt_customers, 'requestGeo', v_cnt_request_geo));
  exception when others then
    update marketing_roi_refresh_runs set status = 'failed', finished_at = now(), error = sqlerrm, affected_periods = v_affected_periods where id = v_run_id;
    raise;
  end;
end;
$function$;

revoke execute on function public.phx_refresh_marketing_roi_facts(p_batch_id uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_marketing_roi_facts(p_batch_id uuid) to service_role;

-- ── phx_refresh_sos_customer_directory_rollup ───────────────────────────────────────────────
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
    sum(coalesce(r.qty, 0)) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    sum(case when coalesce(r.is_direct, false) then coalesce(r.value, 0) else 0 end) as direct_value,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where r.batch_id = p_batch_id
    and nullif(btrim(r.client_code), '') is not null
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

revoke execute on function public.phx_refresh_sos_customer_directory_rollup(p_batch_id uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_customer_directory_rollup(p_batch_id uuid) to service_role;

-- ── phx_refresh_sos_fact_rollup ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_refresh_sos_fact_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period text;
  v_drift_rows bigint;
  v_drift_value numeric;
begin
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

revoke execute on function public.phx_refresh_sos_fact_rollup(p_batch_id uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_fact_rollup(p_batch_id uuid) to service_role;

-- ── phx_sync_sos_reconciliation ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_sync_sos_reconciliation(p_periods text[] DEFAULT NULL::text[])
 RETURNS TABLE(official_line text, period text, rollup_total_qty numeric, raw_total_qty numeric, rollup_effective_units numeric, raw_effective_units numeric, rollup_row_count bigint, raw_row_count bigint, geo_mismatch_rows bigint, unrollup_rows bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
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
      sum(coalesce(r.qty, 0))       as effective_units,
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

revoke execute on function public.phx_sync_sos_reconciliation(p_periods text[]) from public, anon, authenticated;
grant execute on function public.phx_sync_sos_reconciliation(p_periods text[]) to service_role;

commit;
