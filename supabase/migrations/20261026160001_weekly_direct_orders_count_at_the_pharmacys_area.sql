-- Weekly Sales counts each direct order at its pharmacy's own area (2026-10-26)
--
-- WHAT. Redefines public.phx_rebuild_direct_order_weekly_batches so every weekly Direct row carries
-- the pharmacy's own `area_code` (direct_order_pharmacies.area_code), and the rows are grouped by
-- region x AREA x product x line x week instead of region x product x line x week. Nothing else
-- changes: the same batches, the same weeks, the same values and units, the same branch label
-- ("Direct – <Region>"), the same floor, lock and supersede discipline.
--
-- WHY. Owner, 2026-10-26: "fix weekly direct orders to count at the pharmacy's own area". The old
-- writer hard-coded `area_code = null`, so the weekly screens read the branch name "Direct – Giza"
-- as a whole REGION (src/lib/sales/weekly/branch-name-scope.ts) and spread each order evenly over
-- every area of that region on the line (branch-attribution.ts). One pharmacy's order was shared by
-- all the region's reps. Monthly Closing never did that: phx_rebuild_direct_order_sos_batch writes
-- `ph.area_code` on every injected row and phx_monthly_closing_direct groups by it — the direct-order
-- month golden rule ("an order counts in the month Finance books it, at its pharmacy's own brick and
-- area"). This makes Weekly use the very same area, read from the very same column. A row that
-- carries an area is never split (branch-attribution.ts, rule 1), so the even split stops.
--
-- A pharmacy with a blank area keeps the old region-level row (area null), which the weekly screens
-- still place by region as before. Measured 2026-10-26: every approved order booked 2026-08..2026-11
-- (119 orders, EGP 1,506,624.57) has a pharmacy area, and every one of those areas is on its line in
-- au_v_line_area_map.
--
-- REBUILD. The function supersedes the month's own system batches, so after this applies each month
-- from 2026-08 is rebuilt once by calling it: the total value per month does not move, only which
-- area holds it.
--
-- ROLLBACK. Re-apply the function body from 20260919141733_direct_orders_inject_weekly_sales.sql and
-- call it again for each month from 2026-08; that restores the region-only rows. Nothing is deleted
-- that the function cannot rebuild from the orders themselves.

create or replace function public.phx_rebuild_direct_order_weekly_batches(p_period text, p_actor text default 'system')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month_start date;
  v_month_end   date;
  v_rows        integer := 0;
  v_batches     integer := 0;
  v_value       numeric := 0;
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_rebuild_direct_order_weekly_batches: invalid period % (want YYYY-MM)', p_period;
  end if;
  if p_period < '2026-08' then
    raise exception 'phx_rebuild_direct_order_weekly_batches: % came from uploaded Direct sheets; rebuilding it from orders would double count', p_period;
  end if;

  v_month_start := (p_period || '-01')::date;
  v_month_end   := (v_month_start + interval '1 month' - interval '1 day')::date;

  perform pg_advisory_xact_lock(hashtextextended('DirectWeekly:' || p_period, 0));

  delete from public.weekly_sales_batches
   where distributor_code = 'Direct'
     and template_key     = 'direct_orders_system'
     and cycle_month      = v_month_start;

  with live as (
    select r.id as request_id,
           least(greatest(
             coalesce(r.collection_date,
                      (r.decided_at at time zone 'Africa/Cairo')::date,
                      (r.created_at at time zone 'Africa/Cairo')::date),
             v_month_start), v_month_end)                              as placed_on,
           coalesce(ph.region_code, '')                                as region_code,
           -- The pharmacy's own area: the same column the Source-of-Sales rebuild writes, so Weekly
           -- and Monthly Closing credit the same area. Blank stays null (region-level, as before).
           nullif(upper(btrim(coalesce(ph.area_code, ''))), '')        as area_code,
           upper(btrim(i.product_code))                                as product_code,
           i.product_name,
           r.line                                                      as official_line,
           i.qty,
           coalesce(i.bonus, 0)                                        as bonus,
           i.sales_value,
           ph.pharmacy_name
      from public.direct_order_requests r
      join public.direct_order_request_items i on i.request_id = r.id
      join public.direct_order_pharmacies ph   on ph.id = r.pharmacy_id
     where r.status = 'approved'
       and r.reversal_of_request_id is null
       and r.sales_month = p_period
  ),
  wk as (
    select live.*,
           (case when extract(day from placed_on) <= 7  then 1
                 when extract(day from placed_on) <= 14 then 2
                 when extract(day from placed_on) <= 21 then 3
                 else 4 end)::smallint as week_number
      from live
  ),
  lines as (
    select week_number,
           (v_month_start + ((week_number - 1) * 7))::date              as week_start,
           region_code,
           area_code,
           product_code,
           official_line,
           min(product_name)                                            as product_name,
           sum(qty)                                                     as qty,
           sum(bonus)                                                   as bonus,
           sum(sales_value)                                             as line_value,
           jsonb_agg(distinct request_id)                               as request_ids,
           string_agg(distinct pharmacy_name, ', ' order by pharmacy_name) as pharmacy_names
      from wk
     group by week_number, region_code, area_code, product_code, official_line
  ),
  weeks as (
    select week_number, week_start, count(*)::integer as total_rows,
           sum(qty) as total_qty, sum(line_value) as total_value
      from lines
     group by week_number, week_start
  ),
  new_batches as (
    insert into public.weekly_sales_batches
      (distributor_code, distributor_name, template_key, file_name, sheet_name, week_start,
       status, total_rows, importable_rows, failed_rows, warning_rows,
       total_sales_qty, total_bonus_qty, total_sales_value, total_stock_qty,
       uploaded_by, total_return_qty, total_net_qty, column_contract_source,
       cycle_month, week_number)
    select 'Direct', 'Direct (Company)', 'direct_orders_system',
           'direct-orders-' || p_period || '-week-' || w.week_number, 'DirectOrders', w.week_start,
           'validated', w.total_rows, w.total_rows, 0, 0,
           w.total_qty, 0, w.total_value, 0,
           coalesce(p_actor, 'system'), 0, w.total_qty, 'code',
           v_month_start, w.week_number
      from weeks w
    returning id, week_number
  )
  insert into public.weekly_sales_rows
    (batch_id, row_number, week_start, distributor_code, distributor_name,
     region_code, region_name, branch_code, branch_name, item_code, product_code, product_name,
     official_line, sales_qty, bonus_qty, discount, sales_value, stock_qty,
     validation_state, validation_issues, raw_row, return_qty, net_qty,
     cycle_month, week_number, area_code)
  select b.id,
         (row_number() over (partition by l.week_number
                             order by l.region_code, l.area_code nulls first,
                                      l.product_code, l.official_line))::integer,
         l.week_start, 'Direct', 'Direct (Company)',
         l.region_code,
         coalesce((select sr.region_name from public.source_of_sales_regions sr
                    where sr.region_code = l.region_code limit 1), l.region_code),
         l.region_code,
         'Direct ' || chr(8211) || ' ' ||
           coalesce((select sr.region_name from public.source_of_sales_regions sr
                      where sr.region_code = l.region_code limit 1),
                    nullif(l.region_code, ''), '(no region)'),
         l.product_code, l.product_code, l.product_name,
         l.official_line, l.qty, 0, 0, l.line_value, 0,
         'valid', '[]'::jsonb,
         jsonb_build_object(
           'source', 'direct_order_request',
           'requestIds', l.request_ids,
           'pharmacyNames', l.pharmacy_names,
           'grossSalesQty', l.qty,
           'netQty', l.qty,
           'bonusUnitsNotCounted', l.bonus
         ),
         0, l.qty,
         v_month_start, l.week_number, l.area_code
    from lines l
    join new_batches b on b.week_number = l.week_number;

  get diagnostics v_rows = row_count;

  select count(*), coalesce(sum(total_sales_value), 0)
    into v_batches, v_value
    from public.weekly_sales_batches
   where distributor_code = 'Direct'
     and template_key     = 'direct_orders_system'
     and cycle_month      = v_month_start;

  return jsonb_build_object(
    'period', p_period, 'batches', v_batches, 'rowCount', v_rows, 'totalValue', v_value);
end $function$;

revoke execute on function public.phx_rebuild_direct_order_weekly_batches(text, text) from public, anon, authenticated;
grant  execute on function public.phx_rebuild_direct_order_weekly_batches(text, text) to service_role;
