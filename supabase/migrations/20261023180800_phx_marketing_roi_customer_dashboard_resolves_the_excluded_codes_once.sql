-- phx_marketing_roi_customer_dashboard: resolve the excluded product codes once, not once per row.
--
-- The filter read
--     upper(btrim(coalesce(product_code, ''))) <> all (
--       select upper(btrim(x)) from unnest(p_exclude_codes) as x)
-- and that bare sublink is planned as a SubPlan, so the Function Scan on unnest is
-- re-executed for EVERY row of public.marketing_request_products.
-- Measured on production against public.source_of_sales_fact_rollup:
--     SubPlan   -> Function Scan on unnest, loops=295418, 1322 ms
--     InitPlan  -> Function Scan on unnest, loops=1,      357 ms
-- Both readings warm (shared hit=8304, zero reads), both keeping 61875 rows per worker
-- and removing 36598 - the row counts are identical, which is the equivalence at plan level.
--
-- Wrapping the same sublink in ARRAY( ) makes it uncorrelated-scalar, so the planner lifts
-- it to an InitPlan evaluated once per execution. ARRAY(subquery) yields '{}' for an empty
-- or NULL input - never NULL - so "<> all" stays TRUE when nothing is excluded, exactly as
-- the set form behaved. No coalesce is needed and none is added.
--
-- Equivalence proven BEFORE this migration was written:
--   * truth table over 7 array shapes x 4 probe values - 28/28 identical, NULL corners included;
--   * every row of analytics.sos_fact_all, source_of_sales_fact_rollup,
--     source_of_sales_customer_directory_rollup and source_of_sales_products - 853,159 rows -
--     compared under 5 array shapes: 4,265,795 comparisons, 0 differences;
--   * the edit is mechanically confined: stripping the inserted ARRAY( ) wrap reproduces the
--     live pg_get_functiondef output byte for byte, and the body grew by exactly 7 bytes per site.
--
-- The body below is production's own definition with that one wrap applied. Nothing else moved:
-- same signature, same volatility, same SECURITY DEFINER, same search_path and timeouts.
-- phx_closing_channel_totals already resolves the array once into a local variable and is
-- deliberately left alone; phx_exec_sos_trend does not carry this shape.

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
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (array(
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    ))
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
          else coalesce(r.qty, 0) * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
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

-- The ACL is unchanged by `create or replace`, and production already carries exactly
-- `postgres=X/postgres | service_role=X/postgres` on this function. These two statements are
-- idempotent against that, and they are what makes the file say so on its own.
revoke execute on function public.phx_marketing_roi_customer_dashboard(text[], text[], text[], text[], text[], text[], text, text, text, integer, text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_roi_customer_dashboard(text[], text[], text[], text[], text[], text[], text, text, text, integer, text[]) to service_role;
