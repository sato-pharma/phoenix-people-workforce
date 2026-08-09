-- Extract ONE shared sales-lines function behind both Marketing ROI engines.
--
-- WHY ------------------------------------------------------------------------------------------
-- Two per-request engines compute a marketing request's realized sales and are supposed to agree:
--
--   phx_marketing_request_roi_actuals_v2  -- the authoritative ROI number (ROI Tracking, KPI band)
--   phx_marketing_request_view_sales      -- the View Sales screen, its XLSX export, ROI Explain
--
-- Until now each carried its OWN copy of the retail matching rule: the distributor rollup hop, the
-- normalized customer-code equality, the product name-bridge, the period window, the
-- validation_state='valid' + batch status='validated' gates, and the value formula. Two copies of
-- one rule is two things that drift, and they have drifted before -- 20260719151000 added a
-- direct-order branch to the actuals RPC only, and 20260808231742 then had to repair that branch's
-- distributor join after it shipped dead (it compared marketing_distributors' synthetic surrogate
-- codes against real Source-of-Sales codes and matched 0 rows). Every one of those edits had to be
-- reasoned about twice, in two places, with nothing enforcing that the answers stayed the same.
--
-- This migration extracts the rule ONCE into public.phx_marketing_request_sales_lines and rewrites
-- both engines as thin projections over it. From here a matching-rule change is a one-place edit
-- and the two engines cannot disagree about which sales rows belong to a request.
--
-- THIS CHANGES NO BEHAVIOUR. Both branches are transcribed verbatim from the definitions they
-- replace -- the retail branch from the exact_hits/hits CTEs, the direct branch from the corrected
-- direct_hits CTE of 20260808231742 including its req.track_direct_sales = true guard and its
-- marketing_roi_distributor_rollup hop. No predicate, gate, formula or exclusion was "improved".
-- Verified on staging (cifwmndunmlxjhyjugxa) by diffing the old and new definitions over all 217
-- marketing requests, in both directions, on every returned column: 0 differing rows. See the PR
-- body for the counts compared.
--
-- THE ONE DELIBERATE DEVIATION: phx_marketing_request_view_sales gains a final ORDER BY tiebreaker
-- (source_row_id). Its three existing sort keys are unchanged, but they never formed a total order
-- -- 146 of 249 staging rows tie on them -- so the order WITHIN those ties was already unspecified
-- and could differ between two runs of the unchanged function. Since rpcAll pages this RPC with
-- .range(), an unstable order can repeat or skip rows across page boundaries. The tiebreaker makes
-- the sequence reproducible. It changes no row and no value; the row SET is identical.
--
-- VIEW SALES STAYS RETAIL-ONLY, DELIBERATELY. phx_marketing_request_view_sales has never had a
-- direct-order branch, so it projects the shared function filtered to channel = 'retail'. Letting
-- direct rows through here would change what the View Sales screen and its export show -- a real
-- behaviour change, and explicitly NOT part of this refactor. Closing that gap (and the matching
-- gap in phx_marketing_roi_customer_dashboard, pinned by
-- tests/marketing-roi-attribution-consistency.test.ts) is separate, deliberate work.
--
-- TWO DELIBERATE ADDITIONS TO THE SHARED SIGNATURE ----------------------------------------------
-- The shared function carries two things the actuals RPC does not need, because View Sales cannot
-- be expressed as a projection without them:
--   * p_from_period / p_to_period -- View Sales accepts an explicit period window and falls back to
--     the pay_date-derived window when it is absent or malformed. Passing NULL/NULL reproduces the
--     actuals RPC's pay_date window exactly, so the actuals path is unaffected.
--   * region_name -- View Sales returns it per row. The direct branch has no region, so it is NULL
--     there; nothing reads it, because View Sales filters to retail.
-- Both are additive. Neither changes a single matching predicate.
--
-- WHY `distinct on (request_id, source_row_id)` IN BOTH BRANCHES ---------------------------------
-- This is load-bearing, not cosmetic. The old CTEs deduplicated with `select distinct` over a
-- narrow column list (request_id, row_id, units, value), which collapsed a sales row that matched
-- several target tuples into ONE row. The shared function must also emit descriptive columns
-- (parent distributor, customer, product, period) whose values differ per target tuple, so a plain
-- `select distinct` over the wider list would emit that same sales row MORE THAN ONCE and
-- double-count it in sum(value)/sum(qty). `distinct on (request_id, source_row_id)` reproduces the
-- old collapse exactly and makes the wider projection safe. Measured on staging 2026-08-09: 249
-- request/row pairs, 0 of them ambiguous (max 1 distinct target tuple per pair), so the choice is
-- deterministic on real data as well as correct in principle.
--
-- p_exclude_product_codes DEFAULT --------------------------------------------------------------
-- The shared function and phx_marketing_request_roi_actuals_v2 both declare the FAIL-CLOSED default
-- ARRAY['LA003','LA004','SS001'] established by 20260802022100_fail_closed_exclude_codes_defaults.
-- That migration rewrote the actuals RPC's default from '{}' (fail-open: omitting the argument
-- REVEALS the confidential products) to the fail-closed list, and asserts in its own post-check
-- that no targeted function retains the fail-open form. 20260719151000 and 20260808231742 both
-- re-created the actuals RPC with `DEFAULT '{}'::text[]` in the header, which silently undid that
-- on replay -- confirmed live 2026-08-09: staging, which has 20260808231742 applied, reports
-- `p_exclude_product_codes text[] DEFAULT '{}'::text[]`, while production, which does not yet have
-- it, still reports the fail-closed ARRAY form. Declaring fail-closed here restores the documented
-- intent and makes a fresh migration replay agree with production. No caller is affected: every
-- live call site passes the argument explicitly (src/lib/marketing-requests/roi-report-service.ts
-- for both RPCs), so nothing depends on the default value.
-- phx_marketing_request_view_sales keeps its own '{LA003,LA004,SS001}'::text[] default byte for
-- byte -- it was always fail-closed and is not touched.
--
-- CAUTION for whoever edits this next: CREATE OR REPLACE FUNCTION silently DROPS any setting
-- previously applied via ALTER FUNCTION ... SET. All three functions below therefore re-declare
-- `SET search_path` and `SET statement_timeout` in the CREATE header itself. Dropping the timeout
-- would put these RPCs back on the 8s authenticator default and 500 the ROI page on a slow query;
-- tests/report-rpc-guardrails.test.ts replays every migration to catch exactly that, and
-- phx_marketing_request_sales_lines is registered in its RPCS_REQUIRING_TIMEOUT list so the new
-- function is genuinely covered rather than inheriting its callers' protection.
--
-- Re-runnable: every statement is CREATE OR REPLACE / REVOKE / GRANT, and each function is
-- recreated in full. The shared function is created FIRST because Postgres validates SQL function
-- bodies at creation time and both callers reference it.

begin;

-- â”€â”€ The one shared matching rule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
create or replace function public.phx_marketing_request_sales_lines(
  p_request_ids uuid[],
  p_exclude_product_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_from_period text default null::text,
  p_to_period text default null::text)
 returns TABLE(request_id uuid, channel text, source_row_id text, distributor_code text, distributor_name text, customer_code text, customer_name text, product_code text, product_name text, invoice_period text, region_name text, qty numeric, value numeric)
 language sql
 stable
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months,
           coalesce(mr.track_direct_sales, false) as track_direct_sales
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  -- Explicit period window, or NULL when absent/malformed. Transcribed from the View Sales `win`
  -- CTE; the actuals RPC passes NULL/NULL and therefore always falls through to pay_periods.
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
  -- Driven off the REQUESTED ids rather than off `req`, so that a request whose pay_date is null
  -- still resolves an explicit window. That reproduces View Sales exactly: its `win` CTE has no
  -- FROM clause and so yields the explicit window regardless of whether `req` matched. When no
  -- explicit window is given the coalesce falls back to pay_periods, which is empty for such a
  -- request, leaving periods NULL -- and `invoice_period = any(NULL)` is NULL, so the row is
  -- dropped, exactly as the old inner join to `periods` dropped it.
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
  -- Carries BOTH distributor codes the two engines needed separately: the family code the sales row
  -- is matched on (actuals' req_targets.distributor_code == View Sales' family_code) and the parent
  -- code View Sales reports. source_of_sales_distributors is joined so a rollup code with no SoS
  -- distributor row is dropped IDENTICALLY in both engines (keeps the two reconciled).
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
  -- RETAIL: Source-of-Sales invoice rows at this campaign's target pharmacies, for its products,
  -- inside its period window. Transcribed from phx_marketing_request_roi_actuals_v2.exact_hits and
  -- phx_marketing_request_view_sales.hits, which carried identical predicates.
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
            else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
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
  -- DIRECT (Phase D): approved Direct Order Request sales at this campaign's own target pharmacies
  -- (shared distributor + customer code) for its own products, gated on track_direct_sales.
  -- Transcribed from the corrected direct_hits CTE of
  -- 20260808231742_marketing_roi_direct_branch_routes_through_rollup.sql, including its
  -- marketing_distributors -> marketing_roi_distributor_rollup -> source_of_sales_distributors hop:
  -- marketing_distributors.distributor_code is a synthetic surrogate sharing no values with the
  -- real SoS codes on direct_order_pharmacy_distributor_codes, and matching those two columns
  -- directly is what made this branch unreachable.
  -- The master-identity join for these rows is deliberately NOT added here -- it depends on columns
  -- that do not exist yet and is separate follow-up work.
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

comment on function public.phx_marketing_request_sales_lines(uuid[], text[], text, text) is
  'Single source of truth for "which realized sales rows belong to a marketing request". Emits one line per (request, source row) with channel = retail (Source-of-Sales invoice rows) or direct (approved Direct Order Requests, gated on track_direct_sales). phx_marketing_request_roi_actuals_v2 aggregates it; phx_marketing_request_view_sales projects it filtered to retail. Change a matching rule HERE and both engines move together.';

revoke all on function public.phx_marketing_request_sales_lines(uuid[], text[], text, text) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_sales_lines(uuid[], text[], text, text) to service_role;

-- â”€â”€ Engine 1: the authoritative ROI actuals, now an aggregation over the shared lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
create or replace function public.phx_marketing_request_roi_actuals_v2(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns TABLE(request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer, exact_sales_rows integer, fallback_sales_rows integer, attribution_quality text)
 language sql
 stable
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  -- Requests still drive the output shape: a request with no pay_date returns no row at all, and a
  -- request with no matching sales returns a zeroed row. Unchanged from the previous definition.
  with req as (
    select mr.id
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  -- Both channels, exactly as the old exact_hits UNION ALL direct_hits produced them. source_row_id
  -- cannot collide across channels (SoS row ids are bigints, direct order ids are uuids), so
  -- count(distinct source_row_id) reproduces the old count(distinct row_id) over the union.
  actuals as (
    select
      l.request_id,
      coalesce(sum(l.value), 0)::numeric as actual_value,
      coalesce(sum(l.qty), 0)::numeric as actual_units,
      count(distinct l.source_row_id)::integer as sales_rows
    from public.phx_marketing_request_sales_lines(p_request_ids, p_exclude_product_codes) l
    group by l.request_id
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

-- â”€â”€ Engine 2: View Sales, now a projection of the same shared lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
create or replace function public.phx_marketing_request_view_sales(p_request_id uuid, p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_product_codes text[] DEFAULT '{LA003,LA004,SS001}'::text[])
 returns TABLE(distributor_code text, distributor_name text, invoice_period text, product_code text, product_name text, customer_code text, customer_name text, region_name text, qty numeric, value numeric)
 language sql
 stable
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  -- Retail only, on purpose: this function has never had a direct-order branch, and every row it
  -- returns stays reconciled with phx_marketing_request_roi_actuals_v2 because both now read the
  -- SAME shared matching rule rather than two copies of it. Admitting direct rows here would change
  -- what the View Sales screen and its XLSX export show and is deliberately out of scope.
  select
    l.distributor_code,
    l.distributor_name,
    l.invoice_period,
    l.product_code,
    l.product_name,
    l.customer_code,
    l.customer_name,
    l.region_name,
    l.qty::numeric,
    l.value::numeric
  from public.phx_marketing_request_sales_lines(
         array[p_request_id]::uuid[], p_exclude_product_codes, p_from_period, p_to_period) l
  where l.channel = 'retail'
  -- The three sort keys are the previous definition's, unchanged. source_row_id is appended as a
  -- TIEBREAKER: the old key list is not a total order -- measured on staging 2026-08-09, 146 of 249
  -- rows sit in groups that tie on it (and still tie under the four-column re-sort rpcAll applies
  -- in src/lib/supabase/server.ts), so their relative order was already unspecified and could
  -- differ run to run. That matters beyond cosmetics: rpcAll pages this RPC with .range(), and
  -- paging over an unstable order can repeat or skip rows between pages. The tiebreaker fixes the
  -- sequence permanently. It cannot move a row across a sort-key boundary and changes no value --
  -- the row SET is byte-identical, proven by diffing old vs new over every request id.
  order by l.invoice_period, l.distributor_code, l.product_code, l.source_row_id;
$function$;

notify pgrst, 'reload schema';

commit;
