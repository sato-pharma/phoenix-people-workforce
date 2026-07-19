-- Direct-sales reconciliation — detect double-count exposure between the two DIRECT
-- sources in the fact rollup:
--   * distributor_code 'DIRECT'    — the legacy manual "Direct Orders (4).xlsx" upload
--                                     (region-only; area_code NULL)
--   * distributor_code 'DirectReq' — the Direct Order Request module (area-attributed)
--
-- If the SAME real deal is entered in BOTH during the parallel-run transition, the
-- company/region DIRECT totals double-count. Rep ACHIEVEMENT is unaffected (manual
-- DIRECT is region-only and excluded from the rep grid; only DirectReq credits reps)
-- — it is the company/region direct TOTALS that can double.
--
-- Overlap grain: (period, official_line, region_code, product_code). Manual DIRECT is
-- region-only, so the module's area-level rows are compared at REGION level. Both
-- sources key off the same pharmacy's SoS region, so a genuine double-entry lands in
-- the same bucket. Mirrors the validated-batch join + LA003/LA004/SS001 exclusion of
-- au.f_monthly_attribution so totals tie out to the attribution engine.
--
-- Read-only verdict RPC (mirrors phx_marketing_roi_health). Server reads it via
-- getSupabaseAdmin(); no browser/anon access.

begin;

create or replace function public.phx_direct_sales_reconciliation(
  p_period_from text default null,
  p_period_to   text default null
)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
 set statement_timeout to '30s'
as $function$
  with direct_rollup as (
    select
      f.period,
      coalesce(nullif(btrim(f.official_line), ''), '(unassigned)')     as official_line,
      coalesce(nullif(btrim(f.region_code), ''), '(unspecified)')      as region_code,
      upper(btrim(coalesce(f.product_code, '')))                       as product_code,
      f.distributor_code,
      f.direct_value,
      f.total_qty
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.is_direct
      and f.distributor_code in ('DIRECT', 'DirectReq')
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      and (p_period_from is null or f.period >= p_period_from)
      and (p_period_to   is null or f.period <= p_period_to)
  ),
  grouped as (
    select
      period, official_line, region_code, product_code,
      coalesce(sum(direct_value) filter (where distributor_code = 'DIRECT'), 0)    as manual_value,
      coalesce(sum(total_qty)    filter (where distributor_code = 'DIRECT'), 0)    as manual_qty,
      coalesce(sum(direct_value) filter (where distributor_code = 'DirectReq'), 0) as module_value,
      coalesce(sum(total_qty)    filter (where distributor_code = 'DirectReq'), 0) as module_qty
    from direct_rollup
    group by period, official_line, region_code, product_code
  ),
  overlap_set as (
    select *, least(manual_value, module_value) as overlap_exposure
    from grouped
    where manual_value > 0 and module_value > 0
  )
  select jsonb_build_object(
    'periodFrom',        p_period_from,
    'periodTo',          p_period_to,
    'groupedRows',       (select count(*) from grouped),
    'overlapRows',       (select count(*) from overlap_set),
    'totalManualDirect', (select round(coalesce(sum(manual_value), 0), 2) from grouped),
    'totalModuleDirect', (select round(coalesce(sum(module_value), 0), 2) from grouped),
    'overlapExposure',   (select round(coalesce(sum(overlap_exposure), 0), 2) from overlap_set),
    'pass',              (select count(*) from overlap_set) = 0,
    'overlaps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period',          period,
        'line',            official_line,
        'regionCode',      region_code,
        'productCode',     product_code,
        'manualValue',     round(manual_value, 2),
        'manualQty',       manual_qty,
        'moduleValue',     round(module_value, 2),
        'moduleQty',       module_qty,
        'overlapExposure', round(overlap_exposure, 2)
      ) order by overlap_exposure desc)
      from overlap_set
    ), '[]'::jsonb),
    'byPeriod', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period', period,
        'manualValue', round(manual_value, 2),
        'moduleValue', round(module_value, 2),
        'overlapExposure', round(overlap_exposure, 2)
      ) order by period)
      from (
        select period,
          sum(manual_value) as manual_value,
          sum(module_value) as module_value,
          sum(case when manual_value > 0 and module_value > 0 then least(manual_value, module_value) else 0 end) as overlap_exposure
        from grouped
        group by period
      ) p
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.phx_direct_sales_reconciliation(text, text) from public;
grant execute on function public.phx_direct_sales_reconciliation(text, text) to service_role;

notify pgrst, 'reload schema';

commit;
