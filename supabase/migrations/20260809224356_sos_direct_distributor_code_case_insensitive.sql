-- Root cause: source_of_sales_distributors stores this channel's code as 'Direct' (mixed case),
-- so anyone hand-writing a manual INSERT into source_of_sales_import_rows (bypassing the
-- Upload Sales UI's normalizeCode() uppercasing) can end up with distributor_code = 'Direct'
-- instead of 'DIRECT'. That happened for July 2026: 35 rows landed as 'Direct' via ad hoc SQL
-- (raw_row.source: "manual_pedia_july_2026_direct_hand_mapping" / "owner instruction 2026-08-09"
-- / "owner instruction 2026-08-10"), while every genuine file upload in the same batch correctly
-- normalized to 'DIRECT'. Those 35 rows have already been corrected by a one-time UPDATE
-- (distributor_code 'Direct' -> 'DIRECT'), but the functions below compared distributor_code
-- with a literal `=`, so the NEXT stray-cased row would silently vanish from money reconciliation
-- again (phx_direct_sales_reconciliation('2026-07','2026-07') under-reported totalManualDirect
-- by 1,052,259.65 EGP -- 87.6% of the period -- before the data fix). Widening these three to
-- upper(btrim(...)) matches the case-insensitive convention already used elsewhere in this schema
-- (e.g. sos_customer_map_normalized_code_idx) so a future casing slip degrades gracefully instead
-- of silently dropping rows.

create or replace function public.phx_direct_sales_reconciliation(p_period_from text DEFAULT NULL::text, p_period_to text DEFAULT NULL::text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '30s'
as $function$
  with direct_rollup as (
    select
      f.period,
      coalesce(nullif(btrim(f.official_line), ''), '(unassigned)')     as official_line,
      coalesce(nullif(btrim(f.region_code), ''), '(unspecified)')      as region_code,
      upper(btrim(coalesce(f.product_code, '')))                       as product_code,
      upper(btrim(f.distributor_code))                                 as distributor_code,
      f.direct_value,
      f.total_qty
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.is_direct
      and upper(btrim(f.distributor_code)) in ('DIRECT', 'DIRECTREQ')
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      and (p_period_from is null or f.period >= p_period_from)
      and (p_period_to   is null or f.period <= p_period_to)
  ),
  grouped as (
    select
      period, official_line, region_code, product_code,
      coalesce(sum(direct_value) filter (where distributor_code = 'DIRECT'), 0)    as manual_value,
      coalesce(sum(total_qty)    filter (where distributor_code = 'DIRECT'), 0)    as manual_qty,
      coalesce(sum(direct_value) filter (where distributor_code = 'DIRECTREQ'), 0) as module_value,
      coalesce(sum(total_qty)    filter (where distributor_code = 'DIRECTREQ'), 0) as module_qty
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

create or replace function public.sos_backfill_import_rows_from_customer_map(p_distributor text, p_customer text)
 returns table(updated_rows integer, affected_batch_ids uuid[])
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
begin
  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id    = m.brick_id,
        area_code   = b.area_code,
        area_name   = coalesce(a.area_name, r.area_name),
        region_code = b.region_code,
        region_name = coalesce(g.region_name, r.region_name)
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
      and upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      -- Unchanged intent: this fills a MISSING brick, it never re-points an existing one.
      -- Re-pointing is sos_reconcile_import_rows_from_customer_map's job. brick_id is treated
      -- as missing on either '' (the normalizer's "unresolved" sentinel) or SQL NULL, and
      -- distributor_code is now compared case-insensitively -- see migration header.
      and (r.brick_id is null or r.brick_id = '')
    returning r.batch_id
  )
  select count(*)::integer, coalesce(array_agg(distinct batch_id), '{}')
  into v_count, v_batches
  from updated;

  updated_rows := v_count;
  affected_batch_ids := v_batches;
  return next;
end;
$function$;

create or replace function public.sos_count_reconcilable_import_rows(p_distributor text, p_customer text)
 returns table(affected_rows integer, affected_batch_ids uuid[], current_bricks jsonb, target_brick_id text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_target_brick text;
  v_rows integer;
  v_batches uuid[];
  v_current jsonb;
begin
  select m.brick_id into v_target_brick
  from public.source_of_sales_customer_map m
  where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
  limit 1;

  if v_target_brick is null then
    return query select 0, '{}'::uuid[], '{}'::jsonb, null::text;
    return;
  end if;

  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from public.source_of_sales_import_rows
  where upper(btrim(distributor_code)) = upper(btrim(p_distributor))
    and client_code = p_customer
    and brick_id is distinct from v_target_brick;

  select coalesce(jsonb_object_agg(brick_id, cnt), '{}'::jsonb) into v_current
  from (
    select coalesce(nullif(brick_id, ''), '(none)') as brick_id, count(*) as cnt
    from public.source_of_sales_import_rows
    where upper(btrim(distributor_code)) = upper(btrim(p_distributor))
      and client_code = p_customer
      and brick_id is distinct from v_target_brick
    group by 1
  ) g;

  return query select v_rows, v_batches, v_current, v_target_brick;
end;
$function$;

-- CREATE OR REPLACE preserves an existing function's ACL (all three were already service_role-only
-- in production, confirmed via pg_proc.proacl before this migration ran, so nothing changes live
-- today), but replaying this file against a fresh environment (staging rebuild, disaster recovery)
-- runs a true CREATE, which defaults to PUBLIC execute -- handing anon/authenticated a SoS
-- money-reconciliation RPC. Revoke explicitly so the file is safe in isolation either way.
revoke execute on function public.phx_direct_sales_reconciliation(text, text) from public, anon, authenticated;
grant execute on function public.phx_direct_sales_reconciliation(text, text) to service_role;

revoke execute on function public.sos_backfill_import_rows_from_customer_map(text, text) from public, anon, authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text) to service_role;

revoke execute on function public.sos_count_reconcilable_import_rows(text, text) from public, anon, authenticated;
grant execute on function public.sos_count_reconcilable_import_rows(text, text) to service_role;
