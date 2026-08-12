-- Direct Orders — Source-of-Sales injection emits one row PER LINE ITEM (2026-08-12)
--
-- WHY THIS IS THE FIRST THING BUILT ON the items table, and the most carefully. This function runs
-- ATOMICALLY inside phx_apply_direct_order_decision on final approval, so a failure here rolls a
-- real approval back. What it writes feeds au.f_monthly_attribution Branch B1 and credits the
-- pharmacy-area rep in au.f_monthly_achievement. Getting it wrong does not produce a visible error;
-- it produces wrong numbers in somebody's achievement.
--
-- WHAT CHANGES, AND ONLY THIS. The live set is identical (approved, not a reversal entry, not
-- itself reversed, sales_month = the period). Previously each of those requests emitted ONE row
-- carrying its single product. A request can now hold several lines, so each request emits one row
-- PER LINE, and the batch header totals sum over lines rather than over requests.
--
-- For every request that existed before today — and every non-Lacto request after it — this is a
-- no-op by construction: those have exactly one line, backfilled from the request's own columns, so
-- the row this emits is byte-identical to the row the old body emitted.
--
-- EVERYTHING ELSE IS REPRODUCED VERBATIM from the live definition: the period guard, the advisory
-- lock, the empty-set branch that deletes a stale batch, phx_finalize_sos_batch, the sos_batch_id
-- write-back and the return shape. Same discipline as 20260803160000, which changed one line of
-- this module's other RPC and said so — a rewrite that quietly alters an unrelated behaviour is
-- indistinguishable from a bug until the month closes.
--
-- v_count IS NOW A ROW COUNT, NOT A REQUEST COUNT. It must be, because phx_finalize_sos_batch
-- reconciles the batch's declared total_rows/importable_rows against the raw rows actually present
-- and raises on any mismatch. Declaring the request count while inserting the line count would trip
-- that reconciliation on the first two-line basket — loudly, which is the right direction, but the
-- correct answer is to declare what is actually inserted.

--
-- RENAMED TWICE ON 2026-08-12, WHICH IS THE POINT. Written as 20260812160100_direct_orders_sos_injection_per_item.sql and
-- applied to STAGING under that name. The outstation expense_claims phases were landing on main
-- in parallel and took that timestamp, so check:migrations refused the push; moved to 20260812170100
-- and applied to PRODUCTION under THAT name; expense_claims then took that slot too. Hence the
-- minute-precise timestamp here, deliberately off the round-hour cadence that sequence walks.
-- The CONTENT never changed through any of it — verified 2026-08-12 by fingerprinting the live
-- objects on both projects: the rebuild RPC, the family guard and the items table's column shape
-- all md5-match between staging and production.
--
-- APPLIED TO BOTH PROJECTS via scripts/apply-sql-file.mjs, which does not write to
-- schema_migrations at all. So NEITHER ledger has a row for this file under ANY name — not the old
-- timestamps, not the new one. (An earlier version of this note claimed staging recorded the old
-- timestamp. It does not; staging's ledger has no row for it whatsoever. Checked, not assumed.)
--
-- That is why the file is listed in scripts/check-migrations-applied.ts, whose exceptions set is
-- global and therefore covers both legs of the daily drift check. The evidence there — direct
-- schema inspection, never schema_migrations — is what records the apply in this repo.

begin;

create or replace function public.phx_rebuild_direct_order_sos_batch(
  p_period text,
  p_actor  text default 'system'
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_batch_id     uuid;
  v_count        integer;
  v_total_qty    numeric;
  v_total_bonus  numeric;
  v_total_value  numeric;
  v_finalize     jsonb;
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_rebuild_direct_order_sos_batch: invalid period % (want YYYY-MM)', p_period;
  end if;

  -- Serialize concurrent rebuilds of this period. Re-entrant with the try-lock that
  -- phx_finalize_sos_batch takes on the same key within this same transaction.
  perform pg_advisory_xact_lock(hashtextextended('DirectReq:' || p_period, 0));

  -- The authoritative live set for this sales month: approved, not a reversal entry,
  -- not itself reversed (a reversed original is flipped to status='reversed').
  --
  -- Counted and summed over LINE ITEMS. A one-line request contributes exactly what it contributed
  -- before; a Lacto basket contributes both of its concentrations.
  select count(*),
         coalesce(sum(i.qty), 0),
         coalesce(sum(coalesce(i.bonus, 0)), 0),
         coalesce(sum(i.sales_value), 0)
    into v_count, v_total_qty, v_total_bonus, v_total_value
  from public.direct_order_requests r
  join public.direct_order_request_items i on i.request_id = r.id
  join public.direct_order_pharmacies ph on ph.id = r.pharmacy_id
  where r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  if v_count = 0 then
    -- Nothing live this month -> remove any prior DirectReq batch so the injected
    -- direct sales disappear (a reversal of the only order nets cleanly to zero).
    delete from public.source_of_sales_import_batches
     where distributor_code = 'DirectReq' and period = p_period;
    return jsonb_build_object('period', p_period, 'rowCount', 0, 'batchId', null, 'totalValue', 0);
  end if;

  insert into public.source_of_sales_import_batches
    (distributor_code, distributor_name, template_key, file_name, sheet_name, period,
     status, total_rows, importable_rows, failed_rows, warning_rows,
     total_qty, total_bonus_qty, total_value, uploaded_by)
  values
    ('DirectReq', 'Direct Order Requests', 'direct_orders',
     'direct-orders-' || p_period, 'DirectOrders', p_period,
     'pending', v_count, v_count, 0, 0,
     v_total_qty, v_total_bonus, v_total_value, coalesce(p_actor, 'system'))
  returning id into v_batch_id;

  insert into public.source_of_sales_import_rows
    (batch_id, row_number, distributor_code, invoice_period,
     region_code, region_name, area_code, area_name, brick_id,
     client_code, client_name, client_address,
     product_code, product_name, official_line,
     qty, bonus_qty, discount, value, is_direct, validation_state, raw_row)
  select
    v_batch_id,
    -- Ordered by request then line, so a basket's lines stay adjacent and the numbering is stable
    -- across rebuilds of the same period.
    row_number() over (order by r.created_at, r.id, i.line_no),
    'DirectReq',
    p_period,
    coalesce(ph.region_code, ''),
    coalesce(ph.region_code, ''),
    ph.area_code,
    ph.area_code,
    ph.brick_id,
    ph.phoenix_pharmacy_code,
    ph.pharmacy_name,
    ph.pharmacy_address,
    upper(btrim(i.product_code)),
    i.product_name,
    -- The LINE is a property of the request (the requester's line), not of the item. A basket is
    -- single-family and every family sits on one line once confidential products are excluded, so
    -- this stays the request's line exactly as before.
    r.line,
    i.qty,
    coalesce(i.bonus, 0),
    0,
    i.sales_value,
    true,
    'valid',
    jsonb_build_object(
      'source', 'direct_order_request',
      'requestId', r.id,
      'lineNo', i.line_no,
      'dealType', i.deal_type
    )
  from public.direct_order_requests r
  join public.direct_order_request_items i on i.request_id = r.id
  join public.direct_order_pharmacies ph on ph.id = r.pharmacy_id
  where r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  -- Supersede any prior DirectReq/period batch, validate this one, refresh the
  -- rollup, and reconcile raw rows == rollup grain (raises on any silent loss).
  v_finalize := public.phx_finalize_sos_batch(v_batch_id, 'DirectReq', p_period);

  -- Per REQUEST, not per line: a request has one batch id.
  update public.direct_order_requests r
     set sos_batch_id = v_batch_id, updated_at = now()
  from public.direct_order_pharmacies ph
  where ph.id = r.pharmacy_id
    and r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  return jsonb_build_object(
    'period', p_period,
    'rowCount', v_count,
    'batchId', v_batch_id,
    'totalValue', v_total_value,
    'finalize', v_finalize
  );
end $function$;

-- The grant this function has always carried. `create or replace` preserves privileges, but saying
-- it makes a replay from scratch land in the same state as production rather than relying on a
-- default that has changed between Postgres versions.
revoke execute on function public.phx_rebuild_direct_order_sos_batch(text, text) from public, anon, authenticated;
grant execute on function public.phx_rebuild_direct_order_sos_batch(text, text) to service_role;

commit;
