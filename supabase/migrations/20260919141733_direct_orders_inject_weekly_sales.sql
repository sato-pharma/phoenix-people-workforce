-- Direct Orders -> Weekly Sales injection (2026-09-19)
--
-- OWNER RULE, 2026-09-19: "based on these rules inject weekly sales also with direct orders" — the
-- rules being the ones that already govern the Source of Sales injection:
--
--   * an order counts in the month FINANCE books it (`sales_month`), never the month it was raised,
--     approved or collected;
--   * an approved order with no sales month counts NOWHERE;
--   * collection is separate — recording cash never moves an order between periods.
--
-- Weekly Sales had a "Direct (Company)" feed, but it was an EXCEL UPLOAD: May, June and July, and it
-- stopped after 31 July, which is when the Direct Orders module took over. From August the weekly
-- screens therefore carried no direct sales at all while the monthly closing did.
--
-- WHICH WEEK. A direct order has a month but no week, so the owner chose the date (asked in chat,
-- 2026-09-19): the order's COLLECTION DATE, clamped INSIDE its booked sales month so weekly and
-- monthly still agree month for month. The week is the same day-bucket weekly uses everywhere else
-- (1-7, 8-14, 15-21, 22-end => 1..4). An order with no collection date (only the hand-entered one)
-- falls back to its approval date, then to the day it was created — a fallback, never a guess at a
-- payment.
--
-- WHAT IS WRITTEN. One validated weekly batch per (booked month, week), `template_key =
-- 'direct_orders_system'`, and one row per REGION x PRODUCT inside it — the same grain the uploaded
-- Direct sheets had ("Direct - <Region>" branches, area NULL). Values are the order items' own
-- `sales_value` (Direct keeps the value on its own sheet, never recomputed from a price — locked in
-- weekly/live-price.ts) and units are the paid `qty`, exactly what the Source-of-Sales rebuild
-- injects.
--
-- BONUS UNITS ARE NOT COUNTED HERE. `bonus_qty` is written as 0 and the recorded free units ride in
-- `raw_row.bonusUnitsNotCounted` for audit. Weekly's net units and value never include bonus anyway,
-- and the owner's rule (2026-09-18) is that from September no bonus is counted as units or value.
--
-- SAME DISCIPLINE AS THE SOURCE-OF-SALES REBUILD: rebuild-from-truth per period (supersede, never
-- patch), advisory lock per period, one plpgsql function so a client timeout cannot half-apply it.
--
-- WHY A TRIGGER AND NOT ANOTHER LINE INSIDE phx_apply_direct_order_decision. That function runs
-- ATOMICALLY with a real approval; a failure in it rolls the approval back. Weekly is a reporting
-- view and must never be able to do that, so the sync is an AFTER-ROW trigger that catches its own
-- errors: a failure leaves a `weekly_sync_failed` event on the order and a WARNING, and the approval
-- still commits. It also catches every path in one place — approval, Finance booking or re-booking,
-- reversal, a collection-date correction — instead of relying on each caller remembering.
--
-- FLOOR. Periods before 2026-08 are refused by the function itself: those months came from uploaded
-- Direct sheets (template_key 'Direct'), and rebuilding them from orders would double count. The
-- uploaded-sheet path is closed for 2026-08 onwards in the application (weekly/distributors.ts).
--
-- IDEMPOTENT. The backfill at the bottom can be re-run at any time; it deletes and rebuilds only the
-- rows this function owns (`template_key = 'direct_orders_system'`). It never touches an uploaded
-- batch of any distributor.

create or replace function public.phx_rebuild_direct_order_weekly_batches(
  p_period text,
  p_actor  text default 'system'
) returns jsonb
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

  -- Serialize concurrent rebuilds of this period.
  perform pg_advisory_xact_lock(hashtextextended('DirectWeekly:' || p_period, 0));

  -- Supersede: what this function wrote last time is discarded and rebuilt from the orders. Rows go
  -- with their batch (weekly_sales_rows.batch_id is ON DELETE CASCADE). Uploaded batches carry a
  -- different template_key and are never matched.
  delete from public.weekly_sales_batches
   where distributor_code = 'Direct'
     and template_key     = 'direct_orders_system'
     and cycle_month      = v_month_start;

  with live as (
    -- The authoritative live set for this sales month — identical to the Source-of-Sales rebuild:
    -- approved, not a reversal entry, not itself reversed (a reversed original is status 'reversed').
    select r.id as request_id,
           least(greatest(
             coalesce(r.collection_date,
                      (r.decided_at at time zone 'Africa/Cairo')::date,
                      (r.created_at at time zone 'Africa/Cairo')::date),
             v_month_start), v_month_end)                              as placed_on,
           coalesce(ph.region_code, '')                                as region_code,
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
           product_code,
           official_line,
           min(product_name)                                            as product_name,
           sum(qty)                                                     as qty,
           sum(bonus)                                                   as bonus,
           sum(sales_value)                                             as line_value,
           jsonb_agg(distinct request_id)                               as request_ids,
           string_agg(distinct pharmacy_name, ', ' order by pharmacy_name) as pharmacy_names
      from wk
     group by week_number, region_code, product_code, official_line
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
                             order by l.region_code, l.product_code, l.official_line))::integer,
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
         v_month_start, l.week_number, null
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

comment on function public.phx_rebuild_direct_order_weekly_batches(text, text) is
  'Rebuilds the Direct (Company) weekly batches for one sales month from the approved direct orders Finance booked into it. Rebuild-from-truth; touches only template_key direct_orders_system. Floor 2026-08.';

revoke execute on function public.phx_rebuild_direct_order_weekly_batches(text, text) from public, anon, authenticated;
grant  execute on function public.phx_rebuild_direct_order_weekly_batches(text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The trigger. Never blocks the write it rides on.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_direct_order_weekly_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period text;
begin
  -- The month the order LEFT and the month it ENTERED: a re-booking or a reversal must clear the old
  -- month's weekly rows as surely as it fills the new one.
  for v_period in
    select distinct p
      from unnest(array[
        case when tg_op = 'UPDATE' then old.sales_month end,
        new.sales_month
      ]) as p
     where p is not null
       and p ~ '^\d{4}-\d{2}$'
       and p >= '2026-08'
  loop
    begin
      perform public.phx_rebuild_direct_order_weekly_batches(v_period, 'system');
    exception when others then
      -- A reporting view must never roll back an approval. Say so loudly instead: a WARNING for the
      -- database log and an event on the order for the person reading its history.
      raise warning 'phx_direct_order_weekly_sync: weekly rebuild for % failed: %', v_period, sqlerrm;
      begin
        insert into public.direct_order_events (request_id, actor_hr_id, event_type, message, metadata)
        values (new.id, null, 'weekly_sync_failed',
                'The weekly sales rows for ' || v_period || ' could not be rebuilt from this order.',
                jsonb_build_object('period', v_period, 'error', sqlerrm));
      exception when others then
        null;
      end;
    end;
  end loop;
  return null;
end $function$;

revoke execute on function public.phx_direct_order_weekly_sync() from public, anon, authenticated;

drop trigger if exists trg_direct_order_weekly_sync_ins on public.direct_order_requests;
create trigger trg_direct_order_weekly_sync_ins
  after insert on public.direct_order_requests
  for each row
  when (new.status = 'approved' and new.sales_month is not null)
  execute function public.phx_direct_order_weekly_sync();

drop trigger if exists trg_direct_order_weekly_sync_upd on public.direct_order_requests;
create trigger trg_direct_order_weekly_sync_upd
  after update on public.direct_order_requests
  for each row
  when (
       old.status          is distinct from new.status
    or old.sales_month     is distinct from new.sales_month
    or old.collection_date is distinct from new.collection_date
    or old.sales_value     is distinct from new.sales_value
    or old.pharmacy_id     is distinct from new.pharmacy_id
  )
  execute function public.phx_direct_order_weekly_sync();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Backfill: August (the gap left when the uploads stopped) and September. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
select public.phx_rebuild_direct_order_weekly_batches(p, 'migration')
  from (values ('2026-08'), ('2026-09')) as periods(p);
