-- ============================================================================
-- PR 4 — phx_marketing_roi_fast: fast read-only dashboard RPC
--
-- Same signature and JSON return shape as phx_marketing_roi_customer_dashboard.
-- Reads from the pre-computed fact tables (populated by PR 3 refresh function)
-- instead of re-running the 40+ CTE monster on every page load.
--
-- Performance target: < 500ms for the common unfiltered case.
-- The old RPC is NOT modified — it remains available as the fallback.
--
-- Key differences from the original:
--   • Adds 'freshness' sub-object inside 'summary' (safe — TypeScript normalizer
--     ignores unknown keys).
--   • 'activePharmacies' in summary = 0 (not pre-computed; acceptable).
--   • 'customerImpact' grain = marketing_customer (original = pharmacy-level).
--   • 'attributionHealth.unmatchedMappingWarnings' = 0 (not pre-computed).
--   • 'requestReport' JOINs to marketing_requests for status/payDate/duration.
--   • Dimension actual_sales_value is accurate for period-only filters; for
--     cross-dimension filters (region filter affecting line breakdown etc.)
--     it reflects all requests in those periods, not just the filtered subset.
--     This is acceptable for initial deployment and matches how most users
--     interact with the dashboard.
-- ============================================================================

create or replace function public.phx_marketing_roi_fast(
  p_lines               text[]  default '{}',
  p_regions             text[]  default '{}',
  p_products            text[]  default '{}',
  p_roi_statuses        text[]  default '{}',
  p_from_month          text    default null,
  p_to_month            text    default null,
  p_customer_search     text    default null,
  p_distributors        text[]  default '{}',
  p_attribution_qualities text[] default '{}',
  p_limit               integer default 100,
  p_exclude_codes       text[]  default '{}'
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $func$
with
-- ---- Freshness metadata ----
last_refresh as (
  select
    max(r.finished_at) filter (where r.status = 'success') as last_success_at,
    bool_or(r.status = 'running')                          as is_refreshing,
    bool_or(
      r.status = 'failed'
      and r.started_at > coalesce(
        (select max(r2.finished_at) from marketing_roi_refresh_runs r2
         where r2.status = 'success'),
        '1970-01-01'::timestamptz
      )
    ) as has_recent_failure,
    (
      select max(b.updated_at)
      from source_of_sales_import_batches b
      where b.status = 'validated'
    ) as latest_sos_at
  from marketing_roi_refresh_runs r
),

-- ---- Filter request facts ----
-- Applies all supported filter params. The subqueries on marketing_request_products
-- and marketing_request_pharmacies are run against small tables (~220 × avg_products)
-- and are only active when the respective filter array is non-empty.
fr as materialized (
  select rf.*
  from marketing_roi_request_facts rf
  where
    -- Period range
    (p_from_month is null or p_from_month = '' or rf.pay_month >= p_from_month)
    and (p_to_month   is null or p_to_month = ''   or rf.pay_month <= p_to_month)
    -- Line
    and (cardinality(p_lines) = 0
         or rf.line_label = any(p_lines))
    -- ROI status
    and (cardinality(p_roi_statuses) = 0
         or rf.actual_roi_status = any(p_roi_statuses))
    -- Attribution quality
    and (cardinality(p_attribution_qualities) = 0
         or rf.attribution_quality = any(p_attribution_qualities))
    -- Customer search (fuzzy name match)
    and (p_customer_search is null or p_customer_search = ''
         or lower(btrim(coalesce(rf.customer_name,''))) like
            '%' || lower(btrim(p_customer_search)) || '%')
    -- Exclude confidential product codes — hide the entire request if any of its
    -- products match an excluded code (e.g., LA003, LA004).
    and (
      cardinality(p_exclude_codes) = 0
      or not exists (
        select 1 from marketing_request_products mrp
        join marketing_products mp on mp.id = mrp.product_id
        left join source_of_sales_products sp
          on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
        where mrp.request_id = rf.request_id
          and upper(btrim(coalesce(sp.product_code,''))) = any(p_exclude_codes)
      )
    )
    -- Product filter: request must include at least one of the specified products
    and (
      cardinality(p_products) = 0
      or exists (
        select 1 from marketing_request_products mrp
        join marketing_products mp on mp.id = mrp.product_id
        left join source_of_sales_products sp
          on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
        where mrp.request_id = rf.request_id
          and upper(btrim(coalesce(sp.product_code,''))) = any(p_products)
      )
    )
    -- Distributor filter: request must have at least one pharmacy under this distributor
    and (
      cardinality(p_distributors) = 0
      or exists (
        select 1 from marketing_request_pharmacies mrph
        join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
        join marketing_distributors md on md.id = mpdc.distributor_id
        join marketing_roi_distributor_rollup ru
          on ru.marketing_normalized_name = md.normalized_name
        where mrph.request_id = rf.request_id
          and ru.parent_distributor_code = any(p_distributors)
      )
    )
    -- Region filter: request must have at least one pharmacy mapped to this region
    and (
      cardinality(p_regions) = 0
      or exists (
        select 1 from marketing_request_pharmacies mrph
        join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
        left join lateral (
          select cmx.region_code
          from source_of_sales_customer_map cmx
          where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g')))
                  = mpdc.normalized_pharmacy_code
            and cmx.active
          limit 1
        ) cm on true
        where mrph.request_id = rf.request_id
          and cm.region_code = any(p_regions)
      )
    )
),

-- ---- Dashboard summary ----
ds as (
  select
    count(*)::integer                                                as request_count,
    count(*) filter (where actual_roi_status != 'no_data')::integer as paid_count,
    count(distinct customer_id)::integer                            as active_customers,
    coalesce(sum(estimated_cost),0)::numeric                        as total_cost,
    coalesce(sum(required_roi_value),0)::numeric                    as req_roi,
    coalesce(sum(expected_roi_value),0)::numeric                    as exp_roi,
    coalesce(sum(actual_sales_value),0)::numeric                    as actual_val,
    coalesce(sum(actual_sales_units),0)::numeric                    as actual_units,
    coalesce(sum(coverage_gap),0)::numeric                          as cov_gap,
    coalesce(sum(expected_gap),0)::numeric                          as exp_gap,
    count(*) filter (where actual_roi_status='on_track')::integer   as on_track,
    count(*) filter (where actual_roi_status='behind')::integer     as behind,
    count(*) filter (where actual_roi_status='no_data')::integer    as no_data,
    count(*) filter (where recommended_action in
      ('high_risk_gap','follow_up','mapping_review'))::integer       as action_req,
    coalesce(sum(estimated_cost) filter (where actual_roi_status in ('behind','no_data')),0)::numeric as spend_at_risk,
    coalesce(sum(estimated_cost) filter (where actual_roi_status='no_data'),0)::numeric               as no_data_spend,
    count(*) filter (where attribution_quality='mixed')::integer     as mixed_req,
    count(*) filter (where attribution_quality='no_sales')::integer  as no_sales_req,
    sum(exact_sales_rows)::integer                                   as exact_rows,
    sum(fallback_sales_rows)::integer                                as fallback_rows
  from fr
),

-- ---- Product allocations for dimension breakdowns ----
-- Used to compute marketing_cost per line / product in the breakdown tables.
-- NOTE: joins on fr.request_id (UUID) — not fr.id (bigint fact-table PK).
rpa as materialized (
  select
    fr.request_id,
    upper(btrim(coalesce(sp.product_code,
           regexp_replace(mp.normalized_name,' ','','g'))))          as product_code,
    coalesce(sp.product_name, mp.product_name,
             mrp.product_name_snapshot)                              as product_name,
    coalesce(nullif(btrim(sp.line),''), nullif(btrim(mp.line),''),
             nullif(btrim(mrp.line_snapshot),''), 'Unassigned')      as line_label,
    case
      when sum(coalesce(nullif(mrp.value_share,0),0))
             over (partition by mrp.request_id) > 0
        then coalesce(nullif(mrp.value_share,0),0)
             / sum(coalesce(nullif(mrp.value_share,0),0))
               over (partition by mrp.request_id)
      when sum(coalesce(mrp.expected_value,0))
             over (partition by mrp.request_id) > 0
        then coalesce(mrp.expected_value,0)
             / sum(coalesce(mrp.expected_value,0))
               over (partition by mrp.request_id)
      else 1.0 / nullif(count(*) over (partition by mrp.request_id), 0)
    end as share
  from fr
  join marketing_request_products mrp on mrp.request_id = fr.request_id
  join marketing_products mp on mp.id = mrp.product_id
  left join source_of_sales_products sp
    on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
  where (
    cardinality(p_exclude_codes) = 0
    or upper(btrim(coalesce(sp.product_code,''))) != all(p_exclude_codes)
  )
),

-- ---- Target allocations for region / distributor breakdowns ----
rta as materialized (
  select
    fr.request_id,
    sd.distributor_code,
    coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
    sd.distributor_code as family_code,
    cm.region_code,
    coalesce(sr.region_name, cm.region_code, 'Unassigned')             as region_name,
    1.0 / nullif(count(*) over (partition by mrph.request_id), 0)      as share
  from fr
  join marketing_request_pharmacies mrph on mrph.request_id = fr.request_id
  join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
  join marketing_distributors md on md.id = mpdc.distributor_id
  join (
    select distinct marketing_normalized_name, parent_distributor_code
    from marketing_roi_distributor_rollup
  ) ru on ru.marketing_normalized_name = md.normalized_name
  join source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
  left join lateral (
    select cmx.region_code
    from source_of_sales_customer_map cmx
    where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g')))
            = mpdc.normalized_pharmacy_code
      and cmx.active
      and (cmx.distributor_code = sd.distributor_code
           or exists (
             select 1 from marketing_roi_distributor_rollup rcm
             where rcm.parent_distributor_code = sd.distributor_code
               and rcm.sos_distributor_code = cmx.distributor_code
           ))
    order by (cmx.distributor_code = sd.distributor_code) desc
    limit 1
  ) cm on true
  left join source_of_sales_regions sr on sr.region_code = cm.region_code
),

-- ---- Dimension actuals from fact tables (period-filtered) ----
-- Accurate when only period or line filters are active.
-- For cross-dimension filters (e.g. region filter affecting line actuals),
-- these values reflect all requests in those periods, not just the filtered set.
line_actuals as (
  select line_label,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units  -- not tracked at line grain
  from marketing_roi_line_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_lines) = 0 or line_label = any(p_lines))
  group by line_label
),
product_actuals as (
  select product_code,
         max(product_name)                as product_name,
         max(line_label)                  as line_label,
         sum(actual_sales_value)::numeric as actual_sales_value,
         sum(actual_sales_units)::numeric as actual_sales_units
  from marketing_roi_product_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_products) = 0 or product_code = any(p_products))
    and (cardinality(p_exclude_codes) = 0 or product_code != all(p_exclude_codes))
  group by product_code
),
region_actuals as (
  select region_code,
         max(region_name)                 as region_name,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units  -- not tracked at region grain
  from marketing_roi_region_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_regions) = 0 or region_code = any(p_regions))
  group by region_code
),
distributor_actuals as (
  select distributor_code,
         family_code,
         max(distributor_name)            as distributor_name,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units  -- not tracked at distributor grain
  from marketing_roi_distributor_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_distributors) = 0 or distributor_code = any(p_distributors))
  group by distributor_code, family_code
),

-- ---- Dimension request aggregates ----
line_agg as (
  select
    rpa.line_label,
    count(distinct fr.request_id)::integer                                          as request_count,
    count(distinct fr.customer_id)::integer                                         as customer_count,
    sum(fr.estimated_cost * rpa.share)::numeric                                     as marketing_cost,
    sum(fr.required_roi_value * rpa.share)::numeric                                 as required_roi_value,
    sum(fr.expected_roi_value * rpa.share)::numeric                                 as expected_roi_value,
    sum(fr.exact_sales_rows)::integer                                               as exact_sales_rows,
    sum(fr.fallback_sales_rows)::integer                                            as fallback_sales_rows,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='on_track')   as on_track,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='behind')     as behind,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='no_data')    as no_data
  from fr join rpa on rpa.request_id = fr.request_id
  group by rpa.line_label
),
product_agg as (
  select
    rpa.product_code,
    max(rpa.product_name)                                                            as product_name,
    max(rpa.line_label)                                                              as line_label,
    count(distinct fr.request_id)::integer                                           as request_count,
    sum(fr.estimated_cost * rpa.share)::numeric                                      as marketing_cost,
    sum(fr.required_roi_value * rpa.share)::numeric                                  as required_roi_value,
    sum(fr.expected_roi_value * rpa.share)::numeric                                  as expected_roi_value,
    sum(fr.exact_sales_rows)::integer                                                as exact_sales_rows,
    sum(fr.fallback_sales_rows)::integer                                             as fallback_sales_rows,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='on_track')    as on_track,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='behind')      as behind,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='no_data')     as no_data
  from fr join rpa on rpa.request_id = fr.request_id
  where rpa.product_code is not null
  group by rpa.product_code
),
region_agg as (
  select
    coalesce(rta.region_code,'Unassigned')                                           as region_code,
    max(rta.region_name)                                                             as region_name,
    count(distinct fr.request_id)::integer                                           as request_count,
    count(distinct fr.customer_id)::integer                                          as customer_count,
    sum(fr.estimated_cost * rta.share)::numeric                                      as marketing_cost,
    sum(fr.required_roi_value * rta.share)::numeric                                  as required_roi_value,
    sum(fr.expected_roi_value * rta.share)::numeric                                  as expected_roi_value,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='on_track')    as on_track,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='behind')      as behind,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='no_data')     as no_data
  from fr join rta on rta.request_id = fr.request_id
  group by coalesce(rta.region_code,'Unassigned')
),
distributor_agg as (
  select
    rta.distributor_code,
    rta.family_code,
    max(rta.distributor_name)                                                        as distributor_name,
    count(distinct fr.request_id)::integer                                           as request_count,
    count(distinct fr.customer_id)::integer                                          as customer_count,
    sum(fr.estimated_cost * rta.share)::numeric                                      as marketing_cost,
    sum(fr.required_roi_value * rta.share)::numeric                                  as required_roi_value,
    sum(fr.expected_roi_value * rta.share)::numeric                                  as expected_roi_value,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='on_track')    as on_track,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='behind')      as behind,
    count(distinct fr.request_id) filter (where fr.actual_roi_status='no_data')     as no_data
  from fr join rta on rta.request_id = fr.request_id
  group by rta.distributor_code, rta.family_code
),

-- ---- Customer impact ----
-- Grain: marketing_customer (not individual pharmacies like the original RPC).
-- The 'value' key is customer_id::text; 'label' is customer_name.
-- Uses WHERE IN on the filtered customer_id set to avoid M×N fan-out from
-- joining fact rows (per-period) directly to request rows (per-request).
customer_agg as (
  select
    cf.customer_id::text                                                     as value,
    max(cf.customer_name)                                                    as label,
    cf.distributor_code,
    max(coalesce(sd.distributor_name, cf.distributor_code))                  as distributor_name,
    null::text                                                               as region_name,
    count(distinct cf.period)::integer                                       as request_count,
    1::integer                                                               as customer_count,
    0::integer                                                               as pharmacy_count,
    sum(cf.marketing_cost)::numeric                                          as marketing_cost,
    sum(cf.required_roi_value)::numeric                                      as required_roi_value,
    0::numeric                                                               as expected_roi_value,
    sum(cf.actual_sales_value)::numeric                                      as actual_sales_value,
    sum(cf.actual_sales_units)::numeric                                      as actual_sales_units,
    sum(cf.exact_sales_rows)::integer                                        as exact_sales_rows,
    sum(cf.fallback_sales_rows)::integer                                     as fallback_sales_rows,
    (sum(cf.exact_sales_rows) + sum(cf.fallback_sales_rows))::integer        as sales_rows
  from marketing_roi_customer_facts cf
  left join source_of_sales_distributors sd on sd.distributor_code = cf.distributor_code
  where cf.customer_id in (select distinct customer_id from fr where customer_id is not null)
    and (p_from_month is null or p_from_month = '' or cf.period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or cf.period <= p_to_month)
  group by cf.customer_id, cf.distributor_code
)

-- ---- Final JSON assembly ----
select jsonb_build_object(
  'generatedAt', (select last_success_at from last_refresh),
  'limits', jsonb_build_object(
    'rawRowsReturned', (select count(*) from fr),
    'tableLimit', p_limit
  ),
  'filters', jsonb_build_object(
    'selected', jsonb_build_object(
      'attributionQualities', to_jsonb(p_attribution_qualities),
      'customerSearch',       to_jsonb(coalesce(p_customer_search,'')),
      'distributors',         to_jsonb(p_distributors),
      'fromMonth',            to_jsonb(coalesce(p_from_month,'')),
      'limit',                to_jsonb(p_limit),
      'lines',                to_jsonb(p_lines),
      'products',             to_jsonb(p_products),
      'regions',              to_jsonb(p_regions),
      'roiStatuses',          to_jsonb(p_roi_statuses),
      'toMonth',              to_jsonb(coalesce(p_to_month,''))
    ),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object('value',name,'label',name) order by name),'[]'::jsonb)
      from public.lines
    ),
    'regions', (
      select coalesce(jsonb_agg(jsonb_build_object('value',region_code,'label',region_name) order by region_name),'[]'::jsonb)
      from public.source_of_sales_regions
    ),
    'distributors', (
      select coalesce(jsonb_agg(jsonb_build_object('value',distributor_code,'label',distributor_name) order by distributor_name),'[]'::jsonb)
      from public.source_of_sales_distributors where active
    ),
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object('value',product_code,'label',product_name) order by product_name),'[]'::jsonb)
      from public.source_of_sales_products where active
    ),
    'roiStatuses', jsonb_build_array(
      jsonb_build_object('value','behind','label','Behind'),
      jsonb_build_object('value','no_data','label','No data'),
      jsonb_build_object('value','on_track','label','On track')
    ),
    'attributionQualities', jsonb_build_array(
      jsonb_build_object('value','exact_customer','label','Exact customer'),
      jsonb_build_object('value','brick_fallback','label','Brick fallback'),
      jsonb_build_object('value','mixed','label','Mixed'),
      jsonb_build_object('value','no_sales','label','No sales')
    )
  ),
  'summary', (
    select jsonb_build_object(
      'marketingRequestCount',      ds.request_count,
      'paidRequestCount',           ds.paid_count,
      'activeCustomers',            ds.active_customers,
      'activePharmacies',           0,
      'totalMarketingCost',         ds.total_cost,
      'requiredRoiValue',           ds.req_roi,
      'expectedRoiValue',           ds.exp_roi,
      'actualAttributedSalesValue', ds.actual_val,
      'actualAttributedSalesUnits', ds.actual_units,
      'actualRoiCoverage',          case when ds.req_roi > 0 then ds.actual_val / ds.req_roi else 0 end,
      'coverageGap',                ds.cov_gap,
      'expectedGap',                ds.exp_gap,
      'onTrackRequests',            ds.on_track,
      'behindRequests',             ds.behind,
      'noDataRequests',             ds.no_data,
      'actionRequiredRequests',     ds.action_req,
      'spendAtRisk',                ds.spend_at_risk,
      'noDataSpend',                ds.no_data_spend,
      'freshness', jsonb_build_object(
        'status', case
          when lr.is_refreshing                                                         then 'refreshing'
          when lr.has_recent_failure                                                    then 'failed'
          when lr.last_success_at is null                                               then 'stale'
          when lr.latest_sos_at is not null and lr.latest_sos_at > lr.last_success_at  then 'stale'
          else 'fresh'
        end,
        'lastRefreshedAt', lr.last_success_at
      )
    )
    from ds, last_refresh lr
  ),
  'decisionSummary', (
    select jsonb_build_object(
      'actionRequiredRequests', ds.action_req,
      'spendAtRisk',            ds.spend_at_risk,
      'coverageGap',            ds.cov_gap,
      'expectedGap',            ds.exp_gap,
      'noDataSpend',            ds.no_data_spend,
      'topRiskRequest', (
        select jsonb_build_object(
          'id',                 fr.request_id,
          'requestCode',        fr.request_code,
          'customerName',       coalesce(fr.customer_name,'Unassigned'),
          'line',               fr.line_label,
          'estimatedCost',      fr.estimated_cost,
          'requiredRoiValue',   fr.required_roi_value,
          'actualSalesValue',   fr.actual_sales_value,
          'coverageGap',        fr.coverage_gap,
          'actualRoiCoverage',  fr.actual_coverage_ratio,
          'actualRoiStatus',    fr.actual_roi_status,
          'attributionQuality', fr.attribution_quality,
          'recommendedAction',  fr.recommended_action
        )
        from fr
        order by fr.coverage_gap desc, fr.estimated_cost desc
        limit 1
      )
    )
    from ds
  ),
  'attributionHealth', (
    select jsonb_build_object(
      'exactSalesRows',            ds.exact_rows,
      'fallbackSalesRows',         ds.fallback_rows,
      'mixedRequests',             ds.mixed_req,
      'noSalesRequests',           ds.no_sales_req,
      'unmatchedMappingWarnings',  0
    )
    from ds
  ),
  'roiTrend', (
    select coalesce(jsonb_agg(row_data order by period), '[]'::jsonb)
    from (
      select
        pay_month as period,
        jsonb_build_object(
          'period',          pay_month,
          'requestCount',    count(*)::integer,
          'marketingCost',   sum(estimated_cost)::numeric,
          'requiredRoiValue',sum(required_roi_value)::numeric,
          'expectedRoiValue',sum(expected_roi_value)::numeric,
          'actualSalesValue',sum(actual_sales_value)::numeric,
          'coverageGap',     sum(coverage_gap)::numeric,
          'onTrackCount',    (count(*) filter (where actual_roi_status='on_track'))::integer,
          'behindCount',     (count(*) filter (where actual_roi_status='behind'))::integer,
          'noDataCount',     (count(*) filter (where actual_roi_status='no_data'))::integer
        ) as row_data
      from fr
      group by pay_month
    ) t
  ),
  'lineRoi', (
    select coalesce(
      jsonb_agg(row_data order by cov_gap desc, marketing_cost desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'value',             coalesce(la.line_label, la2.line_label, 'Unassigned'),
        'label',             coalesce(la.line_label, la2.line_label, 'Unassigned'),
        'line',              coalesce(la.line_label, la2.line_label, 'Unassigned'),
        'requestCount',      coalesce(la.request_count,0),
        'customerCount',     coalesce(la.customer_count,0),
        'pharmacyCount',     0,
        'marketingCost',     coalesce(la.marketing_cost,0),
        'requiredRoiValue',  coalesce(la.required_roi_value,0),
        'expectedRoiValue',  coalesce(la.expected_roi_value,0),
        'actualSalesValue',  coalesce(la2.actual_sales_value,0),
        'actualSalesUnits',  coalesce(la2.actual_sales_units,0),
        'coverageGap',       greatest(coalesce(la.required_roi_value,0)-coalesce(la2.actual_sales_value,0),0),
        'actualRoiCoverage', case when coalesce(la.required_roi_value,0)>0
                               then coalesce(la2.actual_sales_value,0)/la.required_roi_value else 0 end,
        'onTrackRequests',   coalesce(la.on_track,0),
        'behindRequests',    coalesce(la.behind,0),
        'noDataRequests',    coalesce(la.no_data,0),
        'exactSalesRows',    coalesce(la.exact_sales_rows,0),
        'fallbackSalesRows', coalesce(la.fallback_sales_rows,0)
      ) as row_data,
      greatest(coalesce(la.required_roi_value,0)-coalesce(la2.actual_sales_value,0),0) as cov_gap,
      coalesce(la.marketing_cost,0) as marketing_cost
      from line_agg la
      full join line_actuals la2 on lower(btrim(la2.line_label)) = lower(btrim(la.line_label))
      limit p_limit
    ) x
  ),
  'productRoi', (
    select coalesce(
      jsonb_agg(row_data order by cov_gap desc, marketing_cost desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'value',             coalesce(pa.product_code, pa2.product_code, 'Unassigned'),
        'label',             coalesce(pa2.product_name, pa.product_name, pa.product_code, 'Unassigned'),
        'line',              coalesce(pa.line_label, pa2.line_label),
        'requestCount',      coalesce(pa.request_count,0),
        'customerCount',     0,
        'pharmacyCount',     0,
        'marketingCost',     coalesce(pa.marketing_cost,0),
        'requiredRoiValue',  coalesce(pa.required_roi_value,0),
        'expectedRoiValue',  coalesce(pa.expected_roi_value,0),
        'actualSalesValue',  coalesce(pa2.actual_sales_value,0),
        'actualSalesUnits',  coalesce(pa2.actual_sales_units,0),
        'coverageGap',       greatest(coalesce(pa.required_roi_value,0)-coalesce(pa2.actual_sales_value,0),0),
        'actualRoiCoverage', case when coalesce(pa.required_roi_value,0)>0
                               then coalesce(pa2.actual_sales_value,0)/pa.required_roi_value else 0 end,
        'onTrackRequests',   coalesce(pa.on_track,0),
        'behindRequests',    coalesce(pa.behind,0),
        'noDataRequests',    coalesce(pa.no_data,0),
        'exactSalesRows',    coalesce(pa.exact_sales_rows,0),
        'fallbackSalesRows', coalesce(pa.fallback_sales_rows,0)
      ) as row_data,
      greatest(coalesce(pa.required_roi_value,0)-coalesce(pa2.actual_sales_value,0),0) as cov_gap,
      coalesce(pa.marketing_cost,0) as marketing_cost
      from product_agg pa
      full join product_actuals pa2 on upper(btrim(pa2.product_code)) = upper(btrim(pa.product_code))
      limit p_limit
    ) x
  ),
  'regionRoi', (
    select coalesce(
      jsonb_agg(row_data order by cov_gap desc, marketing_cost desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'value',             coalesce(ra.region_code, ra2.region_code, 'Unassigned'),
        'label',             coalesce(ra.region_name, ra2.region_name, ra.region_code, 'Unassigned'),
        'line',              null,
        'requestCount',      coalesce(ra.request_count,0),
        'customerCount',     coalesce(ra.customer_count,0),
        'pharmacyCount',     0,
        'marketingCost',     coalesce(ra.marketing_cost,0),
        'requiredRoiValue',  coalesce(ra.required_roi_value,0),
        'expectedRoiValue',  coalesce(ra.expected_roi_value,0),
        'actualSalesValue',  coalesce(ra2.actual_sales_value,0),
        'actualSalesUnits',  coalesce(ra2.actual_sales_units,0),
        'coverageGap',       greatest(coalesce(ra.required_roi_value,0)-coalesce(ra2.actual_sales_value,0),0),
        'actualRoiCoverage', case when coalesce(ra.required_roi_value,0)>0
                               then coalesce(ra2.actual_sales_value,0)/ra.required_roi_value else 0 end,
        'onTrackRequests',   coalesce(ra.on_track,0),
        'behindRequests',    coalesce(ra.behind,0),
        'noDataRequests',    coalesce(ra.no_data,0),
        'exactSalesRows',    0,
        'fallbackSalesRows', 0
      ) as row_data,
      greatest(coalesce(ra.required_roi_value,0)-coalesce(ra2.actual_sales_value,0),0) as cov_gap,
      coalesce(ra.marketing_cost,0) as marketing_cost
      from region_agg ra
      full join region_actuals ra2 on lower(btrim(ra2.region_code)) = lower(btrim(ra.region_code))
      limit p_limit
    ) x
  ),
  'distributorRoi', (
    select coalesce(
      jsonb_agg(row_data order by cov_gap desc, marketing_cost desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'value',             coalesce(da.distributor_code, da2.distributor_code, 'Unassigned'),
        'label',             coalesce(da.distributor_name, da2.distributor_name, da.distributor_code, 'Unassigned'),
        'line',              null,
        'requestCount',      coalesce(da.request_count,0),
        'customerCount',     coalesce(da.customer_count,0),
        'pharmacyCount',     0,
        'marketingCost',     coalesce(da.marketing_cost,0),
        'requiredRoiValue',  coalesce(da.required_roi_value,0),
        'expectedRoiValue',  coalesce(da.expected_roi_value,0),
        'actualSalesValue',  coalesce(da2.actual_sales_value,0),
        'actualSalesUnits',  coalesce(da2.actual_sales_units,0),
        'coverageGap',       greatest(coalesce(da.required_roi_value,0)-coalesce(da2.actual_sales_value,0),0),
        'actualRoiCoverage', case when coalesce(da.required_roi_value,0)>0
                               then coalesce(da2.actual_sales_value,0)/da.required_roi_value else 0 end,
        'onTrackRequests',   coalesce(da.on_track,0),
        'behindRequests',    coalesce(da.behind,0),
        'noDataRequests',    coalesce(da.no_data,0),
        'exactSalesRows',    0,
        'fallbackSalesRows', 0
      ) as row_data,
      greatest(coalesce(da.required_roi_value,0)-coalesce(da2.actual_sales_value,0),0) as cov_gap,
      coalesce(da.marketing_cost,0) as marketing_cost
      from distributor_agg da
      full join distributor_actuals da2
        on upper(btrim(da2.distributor_code)) = upper(btrim(da.distributor_code))
       and da2.family_code is not distinct from da.family_code
      limit p_limit
    ) x
  ),
  'requestReport', (
    select coalesce(
      jsonb_agg(row_data order by risk_rank asc, cov_gap desc, cost desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'id',                 fr.request_id,
        'requestCode',        fr.request_code,
        'status',             coalesce(mr.status, 'unknown'),
        'payDate',            mr.pay_date,
        'payMonth',           fr.pay_month,
        'roiDurationMonths',  coalesce(mr.roi_duration_months, 1),
        'customerName',       coalesce(fr.customer_name,'Unassigned'),
        'customerCode',       fr.customer_code,
        'line',               fr.line_label,
        'estimatedCost',      fr.estimated_cost,
        'requiredRoiValue',   fr.required_roi_value,
        'expectedRoiValue',   fr.expected_roi_value,
        'actualSalesValue',   fr.actual_sales_value,
        'actualSalesUnits',   fr.actual_sales_units,
        'actualRoiCoverage',  fr.actual_coverage_ratio,
        'coverageGap',        fr.coverage_gap,
        'expectedGap',        fr.expected_gap,
        'actualRoiStatus',    fr.actual_roi_status,
        'attributionQuality', fr.attribution_quality,
        'recommendedAction',  fr.recommended_action,
        'exactSalesRows',     fr.exact_sales_rows,
        'fallbackSalesRows',  fr.fallback_sales_rows,
        'salesRows',          fr.sales_rows
      ) as row_data,
      case fr.actual_roi_status
        when 'no_data' then 0 when 'behind' then 1 else 2
      end as risk_rank,
      fr.coverage_gap as cov_gap,
      fr.estimated_cost as cost
      from fr
      left join marketing_requests mr on mr.id = fr.request_id
      order by risk_rank asc, cov_gap desc, cost desc
      limit p_limit
    ) x
  ),
  'customerImpact', (
    select coalesce(
      jsonb_agg(row_data order by cov_gap desc, actual_sales_value desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
        'value',             ca.value,
        'label',             ca.label,
        'distributorCode',   ca.distributor_code,
        'distributorName',   ca.distributor_name,
        'regionName',        ca.region_name,
        'requestCount',      ca.request_count,
        'customerCount',     ca.customer_count,
        'pharmacyCount',     ca.pharmacy_count,
        'marketingCost',     ca.marketing_cost,
        'requiredRoiValue',  ca.required_roi_value,
        'expectedRoiValue',  ca.expected_roi_value,
        'actualSalesValue',  ca.actual_sales_value,
        'actualSalesUnits',  ca.actual_sales_units,
        'coverageGap',       greatest(ca.required_roi_value-ca.actual_sales_value,0),
        'actualRoiCoverage', case when ca.required_roi_value>0
                               then ca.actual_sales_value/ca.required_roi_value else 0 end,
        'salesRows',         ca.sales_rows,
        'exactSalesRows',    ca.exact_sales_rows,
        'fallbackSalesRows', ca.fallback_sales_rows
      ) as row_data,
      greatest(ca.required_roi_value-ca.actual_sales_value,0) as cov_gap,
      ca.actual_sales_value
      from customer_agg ca
      order by cov_gap desc, ca.actual_sales_value desc
      limit p_limit
    ) x
  )
)
$func$;

-- Grant: same access rules as the original dashboard function.
-- The server-side service uses getSupabaseAdmin() to call both.
revoke all on function public.phx_marketing_roi_fast(text[],text[],text[],text[],text,text,text,text[],text[],integer,text[]) from public;
grant execute on function public.phx_marketing_roi_fast(text[],text[],text[],text[],text,text,text,text[],text[],integer,text[]) to service_role;

notify pgrst, 'reload schema';
