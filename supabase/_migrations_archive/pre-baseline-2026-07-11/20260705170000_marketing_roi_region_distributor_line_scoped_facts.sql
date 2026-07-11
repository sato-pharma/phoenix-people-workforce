-- ============================================================================
-- Fix — line-scope the Region / Distributor ROI actuals in the fast dashboard
-- path (phx_marketing_roi_fast + its fact tables).
--
-- Background: PR #841 closed a cross-line leak where a single-line viewer
-- (National Sales Manager / Product Manager / Group Product Manager) could see
-- OTHER lines' products/regions/distributors as actuals-only rows in the ROI
-- portal (/employee-portals/roi). That fix was applied in the application
-- layer (scopeBreakdownRowsToLine in src/lib/sales-marketing-intelligence/
-- service.ts) and remains in place as defense-in-depth — it drops rows with no
-- in-scope request footprint regardless of what the RPC returns.
--
-- This migration closes the residual data-correctness gap PR #841 documented
-- but did not fix: even a KEPT region/distributor row (one that does have an
-- in-scope marketing request) showed that region's/distributor's ENTIRE
-- actual-sales value across ALL lines, not just the viewer's line(s) — because
-- marketing_roi_region_facts / marketing_roi_distributor_facts have no line
-- dimension, so phx_marketing_roi_fast's region_actuals / distributor_actuals
-- CTEs cannot filter them by p_lines at all.
--
-- Root cause confirmed by reading the LIVE function bodies on staging (not the
-- historical migration chain, which patches phx_marketing_roi_customer_dashboard
-- via pg_get_functiondef + string surgery and can drift from any single file):
--   • phx_marketing_roi_customer_dashboard (the original, non-fact-table RPC)
--     is NOT affected — its region/distributor actuals (`actuals_by_region` /
--     `actuals_by_distributor`) are built from `filtered_hits`, which is
--     already joined to `request_rows` (itself gated by the p_lines-derived
--     `filter_lines` predicate). Confirmed NEXT_PUBLIC_SMI_USE_FACT_TABLES is
--     unset in this repo's env files, so this is the RPC actually serving
--     /employee-portals/roi today.
--   • phx_refresh_marketing_roi_facts's OWN `actuals_by_region` /
--     `actuals_by_distributor` CTEs already compute per-hit `ah.line_label`
--     (same column `actuals_by_product` keys on) but then GROUP BY without it,
--     so the fact tables lose the dimension before it ever reaches the read
--     RPC. This is a is a narrow, additive fix — not a new computation.
--   • phx_marketing_roi_fast reads those now-line-blind fact tables and can
--     only filter region_actuals/distributor_actuals by period/region/
--     distributor, never by line — the exact gap this migration closes. This
--     matters if/when NEXT_PUBLIC_SMI_USE_FACT_TABLES is ever flipped on (a
--     prior performance audit recommended doing so), so it is fixed now rather
--     than left as a landmine for that future flip.
--   • marketing_roi_product_facts already HAS a line_label column (a product
--     is intrinsically single-line), but phx_marketing_roi_fast's
--     product_actuals CTE never filters it by p_lines either. That half is a
--     pure RPC fix (no schema change) folded into this migration as
--     defense-in-depth alongside the app-layer product filter from #841 — a
--     product row that passes the app-layer line check already carries only
--     its own single line's actuals, so this does not change any currently
--     displayed number, it just stops relying solely on the app layer.
--
-- Additive, backward compatible:
--   • line_label is a new NULLable column on both fact tables — nothing reads
--     it yet except the updated RPC bodies below.
--   • The grain (unique index) widens to include line_label so a full refresh
--     safely re-populates without unique-constraint violations.
--   • calculation_version is bumped 2 -> 3 (existing rows keep '2' until the
--     backfill at the end of this migration recomputes them; this is purely an
--     audit/traceability stamp, not read by any application code).
--   • A full backfill (`phx_refresh_marketing_roi_facts(null)`) must be run
--     ONCE after this migration, as a SEPARATE step (see section 4 at the
--     bottom) — NOT inside the migration transaction, so a slow refresh on
--     production data cannot roll back the schema/function changes. It
--     repopulates every existing fact row's line_label immediately; without it
--     pre-migration rows have line_label = NULL and are excluded by the new
--     `line_label = any(p_lines)` filter for any line-scoped viewer until the
--     next SoS import triggers a refresh (fail-closed / safe, but needlessly
--     empty in the interim).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema — add the line dimension to both fact tables.
-- ---------------------------------------------------------------------------
alter table public.marketing_roi_region_facts
  add column if not exists line_label text;

alter table public.marketing_roi_distributor_facts
  add column if not exists line_label text;

drop index if exists public.marketing_roi_region_facts_grain_uniq;
create unique index if not exists marketing_roi_region_facts_grain_uniq
  on public.marketing_roi_region_facts (period, region_code, line_label)
  nulls not distinct;

create index if not exists marketing_roi_region_facts_line_idx
  on public.marketing_roi_region_facts (line_label);

drop index if exists public.marketing_roi_distributor_facts_grain_uniq;
create unique index if not exists marketing_roi_distributor_facts_grain_uniq
  on public.marketing_roi_distributor_facts (period, distributor_code, family_code, line_label)
  nulls not distinct;

create index if not exists marketing_roi_distributor_facts_line_idx
  on public.marketing_roi_distributor_facts (line_label);

-- ---------------------------------------------------------------------------
-- 2. phx_refresh_marketing_roi_facts — populate the new column.
--
-- Full current body captured live from staging (pg_get_functiondef) on
-- 2026-07-05, with three deltas, each marked "LINE-SCOPE FIX" below:
--   a) actuals_by_region / actuals_by_distributor: group by the sales-hit's
--      own line_label (ah.line_label) in addition to region/distributor code
--      — the same column actuals_by_product already keys on.
--   b) ins_regions / ins_distributors: insert the REQUEST's own line_label
--      (rr.line_label — every request resolves to exactly one line, same
--      value ins_lines/ins_products already group by) and join to the actuals
--      CTE on that line in addition to region/distributor + period.
--   c) calculation_version bumped '2' -> '3'.
-- ---------------------------------------------------------------------------
create or replace function public.phx_refresh_marketing_roi_facts(
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
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
  v_cnt_request_geo  bigint := 0;
begin
  -- -------------------------------------------------------------------------
  -- 1. Advisory lock — one refresh at a time
  -- -------------------------------------------------------------------------
  if not pg_try_advisory_xact_lock(v_lock_key) then
    insert into marketing_roi_refresh_runs
      (triggered_by, trigger_batch_id, status, calculation_version)
    values
      (case when p_batch_id is not null then 'sos_import' else 'admin_manual' end,
       p_batch_id, 'skipped', '3')
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
     p_batch_id, 'running', '3')
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
        -- Coverage broadening: per-request facts cover ALL statuses; the 6
        -- period-aggregate tables stay approved-only downstream via the
        -- request_rows_approved CTE, so the SMI dashboard is unaffected.
        where mr.pay_date is not null
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
      -- Coverage broadening: per-request facts cover ALL statuses.
      where mr.pay_date is not null;
    end if;

    -- Nothing to do
    if coalesce(array_length(v_affected_ids, 1), 0) = 0 then
      update marketing_roi_refresh_runs
      set status = 'success', finished_at = now(),
          affected_periods = v_affected_periods,
          row_counts = '{"requests":0,"trends":0,"lines":0,"products":0,"regions":0,"distributors":0,"customers":0,"requestGeo":0}'::jsonb
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

    delete from marketing_roi_request_geo_facts
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
    -- 5. Core computation — one large CTE chain, eight writeable inserts.
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
        coalesce(l.name, 'Unassigned')                          as request_line,
        coalesce(mc.display_name, mr.customer_id::text)         as customer_name,
        mc.customer_code,
        mr.status                                               as request_status
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
      join (
        select distinct marketing_normalized_name, parent_distributor_code
        from marketing_roi_distributor_rollup
      ) ru on ru.marketing_normalized_name = md.normalized_name
      join source_of_sales_distributors sd
        on sd.distributor_code = ru.parent_distributor_code
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
        req.request_status,
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
    -- Approved-only subset of request_rows. The per-request fact tables
    -- (marketing_roi_request_facts, marketing_roi_request_geo_facts) are written
    -- from the ALL-status request_rows / all_hits so the Coverage Report can read
    -- them; the 6 period-AGGREGATE tables below are written from THIS subset so
    -- the Sales-Marketing-Intelligence dashboard's numbers stay exactly as today.
    request_rows_approved as materialized (
      select *
      from request_rows
      where request_status in ('approved','active','roi_tracking','closed','finance_hold')
    ),
    actuals_by_line as (
      select
        rr.pay_month,
        ah.line_label,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows_approved rr on rr.id = ah.request_id
      group by rr.pay_month, ah.line_label
    ),
    actuals_by_product as (
      select
        rr.pay_month,
        ah.product_code,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows_approved rr on rr.id = ah.request_id
      group by rr.pay_month, ah.product_code
    ),
    -- LINE-SCOPE FIX (a): group by the hit's own line_label too, so the fact
    -- table can carry a per-line actual value instead of one company-wide
    -- total per region/month.
    actuals_by_region as (
      select
        rr.pay_month,
        ah.region_code,
        ah.line_label,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows_approved rr on rr.id = ah.request_id
      where ah.region_code is not null
      group by rr.pay_month, ah.region_code, ah.line_label
    ),
    -- LINE-SCOPE FIX (a): same as actuals_by_region above.
    actuals_by_distributor as (
      select
        rr.pay_month,
        ah.distributor_code,
        ah.line_label,
        sum(ah.sales_value)::numeric as actual_sales_value
      from all_hits ah
      join request_rows_approved rr on rr.id = ah.request_id
      group by rr.pay_month, ah.distributor_code, ah.line_label
    ),
    actuals_by_customer_dist as (
      select
        rr.pay_month,
        rr.customer_id,
        ah.distributor_code,
        sum(ah.sales_value)::numeric as actual_sales_value,
        sum(ah.units)::numeric       as actual_sales_units
      from all_hits ah
      join request_rows_approved rr on rr.id = ah.request_id
      where rr.customer_id is not null
      group by rr.pay_month, rr.customer_id, ah.distributor_code
    ),
    -- ---- NEW: per-request, per-(distributor, region) actuals — the grain
    -- phx_marketing_roi_fast needs to recompute a request's on-track/behind/
    -- no-data status under a region/distributor filter. Sourced from all_hits
    -- (already computed above), just not previously materialized without
    -- collapsing request_id.
    actuals_by_request_geo as (
      select
        ah.request_id,
        ah.distributor_code,
        ah.region_code,
        sum(ah.sales_value)::numeric        as actual_sales_value,
        sum(ah.units)::numeric              as actual_sales_units,
        count(distinct ah.row_id)::integer  as sales_rows
      from all_hits ah
      group by ah.request_id, ah.distributor_code, ah.region_code
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
        source_batch_ids, source_periods, calculation_version,
        request_status
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
        '3',
        rr.request_status
      from request_rows rr
      left join periods p on p.id = rr.id
      returning 1
    ),
    ins_request_geo as (
      insert into marketing_roi_request_geo_facts (
        refresh_run_id, request_id, distributor_code, region_code,
        actual_sales_value, actual_sales_units, sales_rows, calculation_version
      )
      select
        v_run_id,
        abrg.request_id,
        abrg.distributor_code,
        abrg.region_code,
        abrg.actual_sales_value,
        abrg.actual_sales_units,
        abrg.sales_rows,
        '3'
      from actuals_by_request_geo abrg
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
        '3'
      from request_rows_approved
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
        max(coalesce(abl.actual_sales_value, 0)),
        sum(rr.coverage_gap * rpa.share)::numeric,
        count(distinct rr.id) filter (where rr.actual_roi_status='on_track')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='behind')::integer,
        count(distinct rr.id) filter (where rr.actual_roi_status='no_data')::integer,
        v_source_batch_ids,
        v_affected_periods,
        '3'
      from request_rows_approved rr
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
        '3'
      from request_rows_approved rr
      join request_product_allocations rpa on rpa.request_id = rr.id
      left join actuals_by_product abp
        on abp.product_code = rpa.product_code and abp.pay_month = rr.pay_month
      where rpa.product_code is not null
      group by rr.pay_month, rpa.product_code
      returning 1
    ),
    -- LINE-SCOPE FIX (b): include the REQUEST's own line_label (rr.line_label
    -- — every request resolves to exactly one line, same value ins_lines /
    -- ins_products already group by) in both the grouping and the actuals
    -- join, so each fact row carries ONE line's actual value, not the whole
    -- region's cross-line total.
    ins_regions as (
      insert into marketing_roi_region_facts (
        refresh_run_id, period, region_code, region_name, line_label,
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
        rr.line_label,
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
        '3'
      from request_rows_approved rr
      join request_target_allocations rta on rta.request_id = rr.id
      left join source_of_sales_regions sr on sr.region_code = rta.region_code
      left join actuals_by_region abr
        on abr.region_code = rta.region_code
       and abr.pay_month = rr.pay_month
       and abr.line_label = rr.line_label
      group by rr.pay_month, coalesce(rta.region_code, 'Unassigned'), rr.line_label
      returning 1
    ),
    -- LINE-SCOPE FIX (b): same as ins_regions above.
    ins_distributors as (
      insert into marketing_roi_distributor_facts (
        refresh_run_id, period, distributor_code, family_code, distributor_name,
        line_label,
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
        rr.line_label,
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
        '3'
      from request_rows_approved rr
      join request_target_allocations rta on rta.request_id = rr.id
      left join actuals_by_distributor abd
        on abd.distributor_code = rta.distributor_code
       and abd.pay_month = rr.pay_month
       and abd.line_label = rr.line_label
      group by rr.pay_month, rta.distributor_code, rta.family_code, rr.line_label
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
        '3'
      from request_rows_approved rr
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
      (select count(*) from ins_customers)::bigint,
      (select count(*) from ins_request_geo)::bigint
    into
      v_cnt_requests, v_cnt_trends, v_cnt_lines, v_cnt_products,
      v_cnt_regions,  v_cnt_distributors, v_cnt_customers, v_cnt_request_geo;

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
        'customers',    v_cnt_customers,
        'requestGeo',   v_cnt_request_geo
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
        'customers',    v_cnt_customers,
        'requestGeo',   v_cnt_request_geo
      )
    );

  exception when others then
    update marketing_roi_refresh_runs
    set status = 'failed', finished_at = now(), error = sqlerrm,
        affected_periods = v_affected_periods
    where id = v_run_id;
    raise;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. phx_marketing_roi_fast — filter region/distributor/product actuals by
--    p_lines now that the fact tables carry (or already carried, for
--    products) a line dimension. Full current body captured live from
--    staging on 2026-07-05; every other CTE is byte-for-byte unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.phx_marketing_roi_fast(
  p_lines               text[]  default '{}',
  p_regions              text[]  default '{}',
  p_products             text[]  default '{}',
  p_roi_statuses         text[]  default '{}',
  p_from_month           text    default null,
  p_to_month             text    default null,
  p_customer_search      text    default null,
  p_distributors         text[]  default '{}',
  p_attribution_qualities text[] default '{}',
  p_limit                integer default 100,
  p_exclude_codes        text[]  default '{}'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
with
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

fr_raw as materialized (
  select
    rf.id, rf.refresh_run_id, rf.request_id, rf.request_code, rf.pay_month, rf.line_label,
    rf.customer_id, rf.customer_name, rf.customer_code,
    rf.estimated_cost, rf.required_roi_value, rf.expected_roi_value,
    rf.factory_price_snapshot, rf.exact_sales_rows, rf.fallback_sales_rows,
    rf.source_batch_ids, rf.source_periods, rf.calculation_version, rf.calculated_at,
    case when cardinality(p_regions) = 0 and cardinality(p_distributors) = 0
         then rf.actual_sales_value else coalesce(geo.scoped_value, 0) end as actual_sales_value,
    case when cardinality(p_regions) = 0 and cardinality(p_distributors) = 0
         then rf.actual_sales_units else coalesce(geo.scoped_units, 0) end as actual_sales_units,
    case when cardinality(p_regions) = 0 and cardinality(p_distributors) = 0
         then rf.sales_rows else coalesce(geo.scoped_rows, 0) end as sales_rows
  from marketing_roi_request_facts rf
  left join lateral (
    select
      sum(g.actual_sales_value) as scoped_value,
      sum(g.actual_sales_units) as scoped_units,
      sum(g.sales_rows)::integer as scoped_rows
    from marketing_roi_request_geo_facts g
    where g.request_id = rf.request_id
      and (cardinality(p_regions) = 0 or g.region_code = any(p_regions))
      and (cardinality(p_distributors) = 0 or g.distributor_code = any(p_distributors))
  ) geo on true
  where
    -- Dashboard-safety guard: marketing_roi_request_facts now also holds
    -- pending/rejected requests (for the Coverage Report). The SMI dashboard
    -- must stay approved-only, so ignore non-approved fact rows here. Legacy
    -- rows written before the request_status column existed are null and are
    -- treated as approved (they were), keeping the pre-refresh window safe.
    (rf.request_status is null
       or rf.request_status in ('approved','active','roi_tracking','closed','finance_hold'))
    and (p_from_month is null or p_from_month = '' or rf.pay_month >= p_from_month)
    and (p_to_month   is null or p_to_month = ''   or rf.pay_month <= p_to_month)
    and (cardinality(p_lines) = 0
         or rf.line_label = any(p_lines))
    and (cardinality(p_roi_statuses) = 0
         or rf.actual_roi_status = any(p_roi_statuses))
    and (cardinality(p_attribution_qualities) = 0
         or rf.attribution_quality = any(p_attribution_qualities))
    and (p_customer_search is null or p_customer_search = ''
         or lower(btrim(coalesce(rf.customer_name,''))) like
            '%' || lower(btrim(p_customer_search)) || '%')
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

fr_status as materialized (
  select
    fr_raw.*,
    case
      when fr_raw.sales_rows = 0 then 'no_data'
      when fr_raw.actual_sales_value >= fr_raw.required_roi_value then 'on_track'
      else 'behind'
    end as actual_roi_status,
    case
      when fr_raw.sales_rows = 0 then 'no_sales'
      else 'exact_customer'
    end as attribution_quality,
    case
      when fr_raw.required_roi_value > 0 then fr_raw.actual_sales_value / fr_raw.required_roi_value
      when fr_raw.actual_sales_value > 0 then 1
      else 0
    end as actual_coverage_ratio,
    greatest(fr_raw.required_roi_value - fr_raw.actual_sales_value, 0) as coverage_gap,
    greatest(fr_raw.expected_roi_value - fr_raw.actual_sales_value, 0) as expected_gap
  from fr_raw
),
fr as materialized (
  select
    fr_status.*,
    case
      when fr_status.actual_roi_status = 'on_track'   then 'monitor'
      when fr_status.attribution_quality = 'no_sales' then 'mapping_review'
      when fr_status.actual_coverage_ratio < 0.5
           and fr_status.coverage_gap > 0              then 'high_risk_gap'
      else 'follow_up'
    end as recommended_action
  from fr_status
),

ds as (
  select
    count(*)::integer                                                as request_count,
    count(distinct customer_id)::integer                            as active_customers,
    -- Distinct pharmacies matching the SAME region/distributor filter, not just
    -- "any pharmacy belonging to a qualifying request" — mirrors req_targets'
    -- pharmacy-level filtering in the original RPC exactly.
    (
      select count(distinct mrph.pharmacy_id)::integer
      from marketing_request_pharmacies mrph
      join marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
      join marketing_distributors md on md.id = mpdc.distributor_id
      left join (
        select distinct marketing_normalized_name, parent_distributor_code
        from marketing_roi_distributor_rollup
      ) ru on ru.marketing_normalized_name = md.normalized_name
      left join lateral (
        select cmx.region_code
        from source_of_sales_customer_map cmx
        where lower(btrim(regexp_replace(coalesce(cmx.customer_code,''),'\s+',' ','g')))
                = mpdc.normalized_pharmacy_code
          and cmx.active
        limit 1
      ) cm on true
      where mrph.request_id in (select request_id from fr)
        and (cardinality(p_regions) = 0 or cm.region_code = any(p_regions))
        and (cardinality(p_distributors) = 0 or ru.parent_distributor_code = any(p_distributors))
    )                                                                as active_pharmacies,
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

line_actuals as (
  select line_label,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units
  from marketing_roi_line_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_lines) = 0 or line_label = any(p_lines))
  group by line_label
),
-- LINE-SCOPE FIX: marketing_roi_product_facts already carries line_label (a
-- product is intrinsically single-line) but this CTE never filtered by
-- p_lines. Defense-in-depth alongside the app-layer scopeBreakdownRowsToLine
-- filter — a product row that survives that filter already carries only its
-- own line's actuals, so this changes no currently displayed number.
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
    and (cardinality(p_lines) = 0 or line_label = any(p_lines))
  group by product_code
),
-- LINE-SCOPE FIX: filter by p_lines now that marketing_roi_region_facts
-- carries a line_label (populated by this migration). Grouping stays by
-- region_code alone — the sum is now correctly restricted to in-scope
-- lines instead of every line sharing that region.
region_actuals as (
  select region_code,
         max(region_name)                 as region_name,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units
  from marketing_roi_region_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_regions) = 0 or region_code = any(p_regions))
    and (cardinality(p_lines) = 0 or line_label = any(p_lines))
  group by region_code
),
-- LINE-SCOPE FIX: same as region_actuals above.
distributor_actuals as (
  select distributor_code,
         family_code,
         max(distributor_name)            as distributor_name,
         sum(actual_sales_value)::numeric as actual_sales_value,
         0::numeric                       as actual_sales_units
  from marketing_roi_distributor_facts
  where (p_from_month is null or p_from_month = '' or period >= p_from_month)
    and (p_to_month   is null or p_to_month   = '' or period <= p_to_month)
    and (cardinality(p_distributors) = 0 or distributor_code = any(p_distributors))
    and (cardinality(p_lines) = 0 or line_label = any(p_lines))
  group by distributor_code, family_code
),

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
      'paidRequestCount',           ds.request_count,
      'activeCustomers',            ds.active_customers,
      'activePharmacies',           ds.active_pharmacies,
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
$function$;

-- ---------------------------------------------------------------------------
-- 4. Backfill — MUST be run ONCE after this migration, as a SEPARATE step:
--
--     select public.phx_refresh_marketing_roi_facts(null);
--
--    It is intentionally NOT run inside this migration transaction. A full
--    refresh on production data can approach the function's 60s
--    statement_timeout; if it did, running it here would roll back the schema
--    and function changes along with it. Running it separately lets the DDL +
--    function replacement commit cleanly first, then repopulates every fact row
--    so line_label is set immediately (rather than waiting for the next SoS
--    import to trigger an incremental refresh). The refresh is idempotent
--    (DELETE + INSERT per request), so it is safe to run and to re-run.
--
--    Until the backfill runs, pre-migration region/distributor fact rows have
--    line_label = NULL and are excluded by the new `line_label = any(p_lines)`
--    filter for any line-scoped viewer — fail-closed / safe (empty), never a
--    leak. Only the original `phx_marketing_roi_customer_dashboard` RPC serves
--    the dashboard today (NEXT_PUBLIC_SMI_USE_FACT_TABLES is unset), and it is
--    unaffected by these fact tables, so there is no user-visible gap in the
--    interim regardless.
-- ---------------------------------------------------------------------------
