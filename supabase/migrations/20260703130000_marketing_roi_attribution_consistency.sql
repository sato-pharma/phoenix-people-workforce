-- Marketing ROI attribution consistency fix.
--
-- Audit finding: phx_marketing_request_roi_actuals, phx_marketing_request_roi_actuals_v2, and
-- phx_marketing_request_view_sales are all already exact-customer-code-only (no brick/geography
-- fallback) — confirmed by reading their live production definitions directly. But
-- phx_refresh_marketing_roi_facts (which populates marketing_roi_*_facts, the tables that
-- phx_marketing_roi_fast reads) still has a brick/geography fallback path
-- (fallback_bricks/fallback_hits, unioned into all_hits). As of this migration, 76 of 107 rows
-- in marketing_roi_request_facts (71%) are 'mixed' or 'brick_fallback' attribution quality — i.e.
-- the fast/fact-table dashboard can show materially different actual-sales totals than the live
-- per-request ROI Tracking report / View Sales / Explain ROI for the SAME request.
--
-- Source of truth per owner directive (20260620140000_marketing_roi_customer_code_only.sql):
-- exact customer-code attribution ONLY. This migration removes the fallback path from
-- phx_refresh_marketing_roi_facts so every actual-sales surface uses identical attribution logic.
--
-- No SoS table is touched. No data is mutated or reset by this migration — it only redefines the
-- function. Existing fact-table rows keep whatever numbers were last computed (possibly including
-- fallback-inclusive totals) until the next refresh run recomputes them; triggering that refresh is
-- a separate, explicitly-approved data-mutation action, not part of this migration.

create or replace function public.phx_refresh_marketing_roi_facts(p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_run_id           uuid;
  v_lock_key         bigint := abs(hashtext('marketing_roi_refresh')::bigint);
  v_affected_periods text[] := '{}';
  v_affected_ids     uuid[]  := '{}';
  v_source_batch_ids uuid[]  := '{}';
  v_min_period       text;
  v_max_period       text;
  v_cnt_requests     bigint := 0;
  v_cnt_trends       bigint := 0;
  v_cnt_lines        bigint := 0;
  v_cnt_products     bigint := 0;
  v_cnt_regions      bigint := 0;
  v_cnt_distributors bigint := 0;
  v_cnt_customers    bigint := 0;
begin
  -- -------------------------------------------------------------------------
  -- 1. Advisory lock — one refresh at a time
  -- -------------------------------------------------------------------------
  if not pg_try_advisory_xact_lock(v_lock_key) then
    insert into marketing_roi_refresh_runs
      (triggered_by, trigger_batch_id, status, calculation_version)
    values
      (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end,
       p_batch_id, 'skipped', '2')
    returning id into v_run_id;
    return jsonb_build_object('status', 'skipped', 'runId', v_run_id);
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Open audit run record
  -- -------------------------------------------------------------------------
  insert into marketing_roi_refresh_runs
    (triggered_by, trigger_batch_id, status, calculation_version)
  values
    (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end,
     p_batch_id, 'running', '2')
  returning id into v_run_id;

  begin  -- exception block so failures mark the run as failed

    -- -----------------------------------------------------------------------
    -- 3. Determine affected scope
    -- -----------------------------------------------------------------------
    if p_batch_id is not null then
      select
        coalesce(array_agg(distinct invoice_period order by invoice_period), '{}'),
        min(invoice_period),
        max(invoice_period)
      into v_affected_periods, v_min_period, v_max_period
      from source_of_sales_import_rows
      where batch_id = p_batch_id and validation_state = 'valid';

      v_source_batch_ids := array[p_batch_id];

      -- Marketing requests whose ROI window overlaps any of those periods.
      -- Overlap: pay_month <= max_period AND end_of_roi_window >= min_period.
      if v_min_period is not null then
        select coalesce(array_agg(mr.id), '{}')
        into v_affected_ids
        from marketing_requests mr
        where mr.status in ('approved','active','roi_tracking','closed','finance_hold')
          and mr.pay_date is not null
          and to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') <= v_max_period
          and to_char(
                date_trunc('month', mr.pay_date)
                + make_interval(months => greatest(coalesce(mr.roi_duration_months,1),1) - 1),
                'YYYY-MM'
              ) >= v_min_period;
      end if;

    else
      -- Full refresh: all eligible requests and all validated batches
      select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}')
      into v_affected_periods
      from source_of_sales_import_rows
      where validation_state = 'valid';

      select coalesce(array_agg(distinct id), '{}')
      into v_source_batch_ids
      from source_of_sales_import_batches
      where status = 'validated';

      select coalesce(array_agg(mr.id), '{}')
      into v_affected_ids
      from marketing_requests mr
      where mr.status in ('approved','active','roi_tracking','closed','finance_hold')
        and mr.pay_date is not null;
    end if;

    -- Nothing to do
    if coalesce(array_length(v_affected_ids, 1), 0) = 0 then
      update marketing_roi_refresh_runs
      set status = 'success', finished_at = now(),
          affected_periods = v_affected_periods,
          row_counts = '{"requests":0,"trends":0,"lines":0,"products":0,"regions":0,"distributors":0,"customers":0}'::jsonb
      where id = v_run_id;
      return jsonb_build_object('status','success','runId',v_run_id,'affectedRequests',0);
    end if;

    -- -----------------------------------------------------------------------
    -- 4. Delete stale rows (idempotent — DELETE + INSERT replaces each run)
    --
    -- Dimension tables are keyed by request pay_month, not SoS invoice_period.
    -- When a batch is uploaded, affected requests can span multiple pay months.
    -- We delete all fact rows for those pay months and re-compute.
    -- -----------------------------------------------------------------------
    delete from marketing_roi_request_facts
    where request_id = any(v_affected_ids);

    delete from marketing_roi_trend_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );
    delete from marketing_roi_line_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );
    delete from marketing_roi_product_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );
    delete from marketing_roi_region_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );
    delete from marketing_roi_distributor_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );
    delete from marketing_roi_customer_facts
    where period in (
      select distinct to_char(date_trunc('month', pay_date), 'YYYY-MM')
      from marketing_requests where id = any(v_affected_ids)
    );

    -- -----------------------------------------------------------------------
    -- 5. Core computation — one large CTE chain, seven writeable inserts.
    --
    -- CTE ordering (each references only earlier CTEs):
    --   req_raw → req_products_all → req_targets_all → req
    --   → req_products, req_targets
    --   → product_rollups → request_product_allocations
    --   → target_rollups  → request_target_allocations
    --   → periods → target_products
    --   → exact_hits → all_hits (exact_hits only — no brick/geography fallback)
    --   → actuals
    --   → request_rows_base → request_rows
    --   → actuals_by_line / actuals_by_product / actuals_by_region /
    --     actuals_by_distributor / actuals_by_customer_dist
    --     (all JOIN request_rows so pay_month is in scope)
    --   → ins_requests … ins_customers (writeable)
    --   → final SELECT to collect row counts
    -- -----------------------------------------------------------------------
    with
    req_raw as materialized (
      select
        mr.id,
        mr.request_code,
        mr.pay_date,
        to_char(date_trunc('month', mr.pay_date), 'YYYY-MM') as pay_month,
        greatest(coalesce(mr.roi_duration_months,1),1)          as roi_duration_months,
        coalesce(mr.estimated_cost, 0)::numeric                 as estimated_cost,
        coalesce(mr.required_roi_value,
                 coalesce(mr.estimated_cost,0)*10)::numeric     as required_roi_value,
        coalesce(mr.expected_roi_value, 0)::numeric             as expected_roi_value,
        mr.customer_id,
        -- P1: fall back to the requester employee's line when request has no explicit line_id
        coalesce(l.name, 'Unassigned')                          as request_line,
        coalesce(mc.display_name, mr.customer_id::text)         as customer_name,
        mc.customer_code
      from marketing_requests mr
      left join employees emp_req
        on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
      left join lines l
        on l.id = coalesce(mr.line_id, emp_req.line_id)
      left join marketing_customers mc on mc.id = mr.customer_id
      where mr.id = any(v_affected_ids)
    ),
    req_products_all as materialized (
      select distinct
        mrp.request_id,
        upper(btrim(sp.product_code))                           as product_code,
        coalesce(sp.product_name, mp.product_name,
                 mrp.product_name_snapshot)                     as product_name,
        coalesce(nullif(btrim(sp.line),''),
                 nullif(btrim(mp.line),''),
                 nullif(btrim(mrp.line_snapshot),''),
                 'Unassigned')                                  as line_label,
        coalesce(mrp.expected_value, 0)::numeric                as expected_value,
        coalesce(mrp.value_share, 0)::numeric                   as value_share
      from marketing_request_products mrp
      join marketing_products mp on mp.id = mrp.product_id
      left join source_of_sales_products sp
        on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
      where mrp.request_id in (select id from req_raw)
    ),
    req_targets_all as materialized (
      select distinct
        mrph.request_id,
        -- P2: resolve parent distributor code via marketing_roi_distributor_rollup
        sd.distributor_code,
        coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
        sd.distributor_code                                     as family_code,
        mpdc.normalized_pharmacy_code                          as customer_code,
        mph.id                                                  as pharmacy_id,
        coalesce(mph.display_name,
                 mpdc.normalized_pharmacy_code)                 as pharmacy_name,
        cm.brick_id,
        cm.region_code,
        cm.area_code
      from marketing_request_pharmacies mrph
      join marketing_pharmacy_distributor_codes mpdc
        on mpdc.id = mrph.distributor_code_id
      join marketing_distributors md on md.id = mpdc.distributor_id
      join marketing_pharmacies mph on mph.id = mrph.pharmacy_id
      -- Resolve the parent distributor code
      join (
        select distinct marketing_normalized_name, parent_distributor_code
        from marketing_roi_distributor_rollup
      ) ru on ru.marketing_normalized_name = md.normalized_name
      join source_of_sales_distributors sd
        on sd.distributor_code = ru.parent_distributor_code
      -- brick/region metadata retained for display/health-check purposes only — NOT used for
      -- sales attribution (that would reintroduce the geography fallback this migration removes).
      left join lateral (
        select cmx.brick_id, cmx.region_code, cmx.area_code
        from source_of_sales_customer_map cmx
        where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g')))
                = mpdc.normalized_pharmacy_code
          and cmx.active
          and (
            cmx.distributor_code = sd.distributor_code
            or exists (
              select 1 from marketing_roi_distributor_rollup rcm
              where rcm.parent_distributor_code = sd.distributor_code
                and rcm.sos_distributor_code = cmx.distributor_code
            )
          )
        order by (cmx.distributor_code = sd.distributor_code) desc,
                 cmx.region_code nulls last
        limit 1
      ) cm on true
      where mrph.request_id in (select id from req_raw)
        and coalesce(btrim(mpdc.normalized_pharmacy_code),'') <> ''
        and coalesce(mpdc.active, true)
    ),
    req as materialized (
      select
        rr.*,
        coalesce(
          nullif(btrim(rr.request_line),''),
          (select max(rpa.line_label) from req_products_all rpa
           where rpa.request_id = rr.id),
          'Unassigned'
        ) as line_label
      from req_raw rr
    ),
    req_products as materialized (
      select rpa.* from req_products_all rpa
      join req on req.id = rpa.request_id
    ),
    req_targets as materialized (
      select rta.* from req_targets_all rta
      join req on req.id = rta.request_id
    ),
    product_rollups as (
      select
        request_id,
        count(*)::numeric                             as product_count,
        coalesce(sum(nullif(value_share,0)),0)::numeric as value_share_total,
        coalesce(sum(expected_value),0)::numeric      as expected_total
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
        case
          when pr.value_share_total > 0 then rp.value_share / pr.value_share_total
          when pr.expected_total > 0    then rp.expected_value / pr.expected_total
          when pr.product_count > 0     then 1 / pr.product_count
          else 0
        end as share
      from req_products rp
      join product_rollups pr on pr.request_id = rp.request_id
    ),
    target_rollups as (
      select request_id, count(*)::numeric as target_count
      from req_targets group by request_id
    ),
    request_target_allocations as materialized (
      select
        rt.*,
        case when tr.target_count > 0 then 1 / tr.target_count else 0 end as share
      from req_targets rt
      join target_rollups tr on tr.request_id = rt.request_id
    ),
    periods as materialized (
      select req.id,
             array_agg(to_char(g,'YYYY-MM')) as periods
      from req
      cross join lateral generate_series(
        date_trunc('month', req.pay_date),
        date_trunc('month', req.pay_date)
          + make_interval(months => req.roi_duration_months - 1),
        interval '1 month'
      ) as g
      group by req.id
    ),
    target_products as materialized (
      select distinct
        rt.request_id,
        rt.distributor_code,
        rt.customer_code,
        rt.brick_id,
        rpa.product_code
      from req_targets rt
      join request_product_allocations rpa on rpa.request_id = rt.request_id
      where rpa.product_code is not null
    ),
    -- Exact customer-code match ONLY — routes through ALL sos_distributor_codes in the rollup
    -- family. No brick/geography fallback: this keeps the fact-table refresh reconciled with
    -- phx_marketing_request_roi_actuals[_v2] and phx_marketing_request_view_sales, none of which
    -- have ever had a fallback path since 20260620140000_marketing_roi_customer_code_only.sql.
    exact_hits as materialized (
      select distinct
        tp.request_id,
        r.id                                                     as row_id,
        tp.distributor_code,
        coalesce(sd.distributor_name, tp.distributor_code)      as distributor_name,
        lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g'))) as client_code,
        nullif(btrim(r.client_name),'')                         as client_name,
        r.region_code,
        coalesce(sr.region_name, r.region_name, r.region_code)  as region_name,
        nullif(btrim(r.brick_id),'')                            as brick_id,
        upper(btrim(r.product_code))                            as product_code,
        coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
        coalesce(nullif(btrim(sp.line),''),
                 nullif(btrim(r.official_line),''),
                 'Unassigned')                                  as line_label,
        coalesce(r.qty,0)::numeric                              as units,
        (case
          when coalesce(r.is_direct, false) then coalesce(r.value, 0)
          else coalesce(r.qty,0) * (1 - coalesce(r.discount,0)) * coalesce(sp.factory_price,0)
        end)::numeric                                           as sales_value,
        'exact'::text                                           as match_type
      from target_products tp
      join periods on periods.id = tp.request_id
      -- Fan out through all SoS codes that belong to the target's parent distributor
      join marketing_roi_distributor_rollup rr_exact
        on rr_exact.parent_distributor_code = tp.distributor_code
      join source_of_sales_import_rows r
        on r.distributor_code = rr_exact.sos_distributor_code
       and lower(btrim(regexp_replace(coalesce(r.client_code,''),'\s+',' ','g')))
             = tp.customer_code
       and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
       and r.invoice_period = any(periods.periods)
       and r.validation_state = 'valid'
      join source_of_sales_import_batches b
        on b.id = r.batch_id and b.status = 'validated'
      join source_of_sales_products sp
        on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
      left join source_of_sales_distributors sd
        on sd.distributor_code = tp.distributor_code
      left join source_of_sales_regions sr on sr.region_code = r.region_code
    ),
    all_hits as materialized (
      select * from exact_hits
    ),
    actuals as materialized (
      select
        request_id,
        coalesce(sum(sales_value),0)::numeric  as actual_value,
        coalesce(sum(units),0)::numeric         as actual_units,
        count(distinct row_id)::integer                                          as sales_rows,
        count(distinct row_id) filter (where match_type='exact')::integer        as exact_sales_rows,
        count(distinct row_id) filter (where match_type='fallback')::integer     as fallback_sales_rows
      from all_hits
      group by request_id
    ),
    request_rows_base as materialized (
      select
        req.id,
        req.request_code,
        req.pay_month,
        req.roi_duration_months,
        req.estimated_cost,
        req.required_roi_value,
        req.expected_roi_value,
        req.customer_id,
        req.customer_name,
        req.customer_code,
        req.line_label,
        coalesce(a.actual_value, 0)::numeric         as actual_sales_value,
        coalesce(a.actual_units, 0)::numeric          as actual_sales_units,
        coalesce(a.sales_rows, 0)::integer            as sales_rows,
        coalesce(a.exact_sales_rows, 0)::integer      as exact_sales_rows,
        coalesce(a.fallback_sales_rows, 0)::integer   as fallback_sales_rows,
        case
          when coalesce(a.sales_rows,0) = 0 then 'no_sales'
          else 'exact_customer'
        end as attribution_quality,
        case
          when coalesce(a.sales_rows,0) = 0
            then 'no_data'
          when coalesce(a.actual_value,0) >= req.required_roi_value
            then 'on_track'
          else 'behind'
        end as actual_roi_status,
        case
          when req.required_roi_value > 0
            then coalesce(a.actual_value,0) / req.required_roi_value
          when coalesce(a.actual_value,0) > 0 then 1
          else 0
        end as actual_coverage_ratio,
        greatest(req.required_roi_value - coalesce(a.actual_value,0), 0)::numeric as coverage_gap,
        greatest(req.expected_roi_value - coalesce(a.actual_value,0), 0)::numeric as expected_gap
      from req
      left join actuals a on a.request_id = req.id
    ),
    request_rows as materialized (
      select
        rrb.*,
        case
          when rrb.actual_roi_status = 'on_track'         then 'monitor'
          when rrb.attribution_quality = 'no_sales'       then 'mapping_review'
          when rrb.actual_coverage_ratio < 0.5
               and rrb.coverage_gap > 0                   then 'high_risk_gap'
          else 'follow_up'
        end as recommended_action
      from request_rows_base rrb
    ),
    -- Dimension actuals — all include pay_month (via join to request_rows)
    -- so that the aggregates are per-(month, dimension) not cross-month totals.
    actuals_by_line as (
      select
        rr.pay_month,
        ah.line_label,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows rr on rr.id = ah.request_id
      group by rr.pay_month, ah.line_label
    ),
    actuals_by_product as (
      select
        rr.pay_month,
        ah.product_code,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows rr on rr.id = ah.request_id
      group by rr.pay_month, ah.product_code
    ),
    actuals_by_region as (
      select
        rr.pay_month,
        ah.region_code,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows rr on rr.id = ah.request_id
      where ah.region_code is not null
      group by rr.pay_month, ah.region_code
    ),
    actuals_by_distributor as (
      select
        rr.pay_month,
        ah.distributor_code,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows rr on rr.id = ah.request_id
      group by rr.pay_month, ah.distributor_code
    ),
    -- For customer facts: sum actual hits by (customer_id, distributor_code, pay_month)
    actuals_by_customer_dist as (
      select
        rr.pay_month,
        rr.customer_id,
        ah.distributor_code,
        sum(ah.sales_value)::numeric as actual_sales_value,
        sum(ah.units)::numeric       as actual_sales_units
      from all_hits ah
      join request_rows rr on rr.id = ah.request_id
      where rr.customer_id is not null
      group by rr.pay_month, rr.customer_id, ah.distributor_code
    ),
    -- ---- writeable CTEs — one INSERT per fact table ----
    ins_requests as (
      insert into marketing_roi_request_facts (
        refresh_run_id, request_id, request_code, pay_month, line_label,
        customer_id, customer_name, customer_code,
        estimated_cost, required_roi_value, expected_roi_value,
        actual_sales_value, actual_sales_units,
        sales_rows, exact_sales_rows, fallback_sales_rows,
        attribution_quality, actual_roi_status, actual_coverage_ratio,
        coverage_gap, expected_gap, recommended_action,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.id,
        rr.request_code,
        rr.pay_month,
        rr.line_label,
        rr.customer_id,
        rr.customer_name,
        rr.customer_code,
        rr.estimated_cost,
        rr.required_roi_value,
        rr.expected_roi_value,
        rr.actual_sales_value,
        rr.actual_sales_units,
        rr.sales_rows,
        rr.exact_sales_rows,
        rr.fallback_sales_rows,
        rr.attribution_quality,
        rr.actual_roi_status,
        rr.actual_coverage_ratio,
        rr.coverage_gap,
        rr.expected_gap,
        rr.recommended_action,
        v_source_batch_ids,
        p.periods,
        '2'
      from request_rows rr
      left join periods p on p.id = rr.id
      returning 1
    ),
    ins_trends as (
      insert into marketing_roi_trend_facts (
        refresh_run_id, period,
        request_count, marketing_cost, required_roi_value, expected_roi_value,
        actual_sales_value, coverage_gap,
        on_track_requests, behind_requests, no_data_requests,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        pay_month,
        count(*)::integer,
        sum(estimated_cost)::numeric,
        sum(required_roi_value)::numeric,
        sum(expected_roi_value)::numeric,
        sum(actual_sales_value)::numeric,
        sum(coverage_gap)::numeric,
        count(*) filter (where actual_roi_status='on_track')::integer,
        count(*) filter (where actual_roi_status='behind')::integer,
        count(*) filter (where actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows
      group by pay_month
      returning 1
    ),
    ins_lines as (
      insert into marketing_roi_line_facts (
        refresh_run_id, period, line_label,
        request_count, marketing_cost, required_roi_value, expected_roi_value,
        actual_sales_value, coverage_gap,
        on_track_requests, behind_requests, no_data_requests,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.pay_month,
        rpa.line_label,
        count(distinct rr.id)::integer,
        sum(rr.estimated_cost * rpa.share)::numeric,
        sum(rr.required_roi_value * rpa.share)::numeric,
        sum(rr.expected_roi_value * rpa.share)::numeric,
        -- max() is safe: abl is grouped by (pay_month, line_label) so all rows
        -- in this group have the same abl value; max avoids grouping by nullable.
        max(coalesce(abl.actual_sales_value, 0)),
        sum(rr.coverage_gap * rpa.share)::numeric,
        count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows rr
      join request_product_allocations rpa on rpa.request_id = rr.id
      left join actuals_by_line abl
        on abl.line_label = rpa.line_label and abl.pay_month = rr.pay_month
      group by rr.pay_month, rpa.line_label
      returning 1
    ),
    ins_products as (
      insert into marketing_roi_product_facts (
        refresh_run_id, period, product_code, product_name, line_label,
        request_count, marketing_cost, required_roi_value, expected_roi_value,
        actual_sales_value, actual_sales_units, coverage_gap,
        on_track_requests, behind_requests, no_data_requests,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.pay_month,
        rpa.product_code,
        max(rpa.product_name),
        max(rpa.line_label),
        count(distinct rr.id)::integer,
        sum(rr.estimated_cost * rpa.share)::numeric,
        sum(rr.required_roi_value * rpa.share)::numeric,
        sum(rr.expected_roi_value * rpa.share)::numeric,
        max(coalesce(abp.actual_sales_value, 0)),
        coalesce(sum(rr.actual_sales_units * rpa.share), 0)::numeric,
        sum(rr.coverage_gap * rpa.share)::numeric,
        count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows rr
      join request_product_allocations rpa on rpa.request_id = rr.id
      left join actuals_by_product abp
        on abp.product_code = rpa.product_code and abp.pay_month = rr.pay_month
      where rpa.product_code is not null
      group by rr.pay_month, rpa.product_code
      returning 1
    ),
    ins_regions as (
      insert into marketing_roi_region_facts (
        refresh_run_id, period, region_code, region_name,
        request_count, marketing_cost, required_roi_value, expected_roi_value,
        actual_sales_value, coverage_gap,
        on_track_requests, behind_requests, no_data_requests,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.pay_month,
        coalesce(rta.region_code, 'Unassigned'),
        max(coalesce(sr.region_name, rta.region_code, 'Unassigned')),
        count(distinct rr.id)::integer,
        sum(rr.estimated_cost * rta.share)::numeric,
        sum(rr.required_roi_value * rta.share)::numeric,
        sum(rr.expected_roi_value * rta.share)::numeric,
        max(coalesce(abr.actual_sales_value, 0)),
        sum(rr.coverage_gap * rta.share)::numeric,
        count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows rr
      join request_target_allocations rta on rta.request_id = rr.id
      left join source_of_sales_regions sr on sr.region_code = rta.region_code
      left join actuals_by_region abr
        on abr.region_code = rta.region_code and abr.pay_month = rr.pay_month
      group by rr.pay_month, coalesce(rta.region_code, 'Unassigned')
      returning 1
    ),
    ins_distributors as (
      insert into marketing_roi_distributor_facts (
        refresh_run_id, period, distributor_code, family_code, distributor_name,
        request_count, marketing_cost, required_roi_value, expected_roi_value,
        actual_sales_value, coverage_gap,
        on_track_requests, behind_requests, no_data_requests,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.pay_month,
        rta.distributor_code,
        rta.family_code,
        max(rta.distributor_name),
        count(distinct rr.id)::integer,
        sum(rr.estimated_cost * rta.share)::numeric,
        sum(rr.required_roi_value * rta.share)::numeric,
        sum(rr.expected_roi_value * rta.share)::numeric,
        max(coalesce(abd.actual_sales_value, 0)),
        sum(rr.coverage_gap * rta.share)::numeric,
        count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows rr
      join request_target_allocations rta on rta.request_id = rr.id
      left join actuals_by_distributor abd
        on abd.distributor_code = rta.distributor_code and abd.pay_month = rr.pay_month
      group by rr.pay_month, rta.distributor_code, rta.family_code
      returning 1
    ),
    ins_customers as (
      insert into marketing_roi_customer_facts (
        refresh_run_id, period, customer_id, customer_code, customer_name,
        distributor_code, family_code,
        request_count, marketing_cost, required_roi_value,
        actual_sales_value, actual_sales_units,
        exact_sales_rows, fallback_sales_rows,
        attribution_quality, actual_roi_status,
        source_batch_ids, source_periods, calculation_version
      )
      select
        v_run_id,
        rr.pay_month,
        rr.customer_id,
        max(rr.customer_code),
        max(rr.customer_name),
        rta.distributor_code,
        max(rta.family_code),
        count(distinct rr.id)::integer,
        sum(rr.estimated_cost * rta.share)::numeric,
        sum(rr.required_roi_value * rta.share)::numeric,
        -- Use actual SoS hits aggregated by (customer, distributor, pay_month)
        -- not a share-weighted allocation, so the number matches what was truly sold.
        max(coalesce(acbd.actual_sales_value, 0)),
        max(coalesce(acbd.actual_sales_units, 0)),
        sum(rr.exact_sales_rows)::integer,
        sum(rr.fallback_sales_rows)::integer,
        case
          when bool_or(rr.attribution_quality = 'no_sales') then 'no_sales'
          else 'exact_customer'
        end,
        case
          when bool_or(rr.actual_roi_status = 'no_data') then 'no_data'
          when bool_or(rr.actual_roi_status = 'behind')  then 'behind'
          else 'on_track'
        end,
        v_source_batch_ids,
        v_affected_periods,
        '2'
      from request_rows rr
      join request_target_allocations rta on rta.request_id = rr.id
      left join actuals_by_customer_dist acbd
        on acbd.customer_id = rr.customer_id
       and acbd.distributor_code = rta.distributor_code
       and acbd.pay_month = rr.pay_month
      where rr.customer_id is not null
      group by rr.pay_month, rr.customer_id, rta.distributor_code
      returning 1
    )
    select
      (select count(*) from ins_requests)::bigint,
      (select count(*) from ins_trends)::bigint,
      (select count(*) from ins_lines)::bigint,
      (select count(*) from ins_products)::bigint,
      (select count(*) from ins_regions)::bigint,
      (select count(*) from ins_distributors)::bigint,
      (select count(*) from ins_customers)::bigint
    into
      v_cnt_requests, v_cnt_trends, v_cnt_lines, v_cnt_products,
      v_cnt_regions,  v_cnt_distributors, v_cnt_customers;

    -- -----------------------------------------------------------------------
    -- 6. Finalize audit record
    -- -----------------------------------------------------------------------
    update marketing_roi_refresh_runs
    set
      status           = 'success',
      finished_at      = now(),
      affected_periods = v_affected_periods,
      row_counts       = jsonb_build_object(
        'requests',     v_cnt_requests,
        'trends',       v_cnt_trends,
        'lines',        v_cnt_lines,
        'products',     v_cnt_products,
        'regions',      v_cnt_regions,
        'distributors', v_cnt_distributors,
        'customers',    v_cnt_customers
      )
    where id = v_run_id;

    return jsonb_build_object(
      'status',           'success',
      'runId',            v_run_id,
      'affectedRequests', v_cnt_requests,
      'rowCounts', jsonb_build_object(
        'requests',     v_cnt_requests,
        'trends',       v_cnt_trends,
        'lines',        v_cnt_lines,
        'products',     v_cnt_products,
        'regions',      v_cnt_regions,
        'distributors', v_cnt_distributors,
        'customers',    v_cnt_customers
      )
    );

  exception when others then
    -- Mark run as failed and re-raise so the caller sees the error
    update marketing_roi_refresh_runs
    set status = 'failed', finished_at = now(), error = sqlerrm,
        affected_periods = v_affected_periods
    where id = v_run_id;
    raise;
  end;
end;
$function$;

revoke all on function public.phx_refresh_marketing_roi_facts(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_marketing_roi_facts(uuid) to service_role;
