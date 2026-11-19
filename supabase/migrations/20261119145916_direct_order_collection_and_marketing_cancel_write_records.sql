-- direct_order_collection_and_marketing_cancel_write_records
--
-- WHAT THIS CHANGES: two functions gain a form that writes the act's own records inside its transaction.
--   1. public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb) — the collection
--      exactly as 20261113161617 writes it (the order row locked FOR UPDATE, the compare-and-set on paid_amount and
--      payment_date, the offsets summed under the lock, the money re-checked, ONE update), and then, in the same
--      transaction, the collection's audit_logs row and its direct_order_events row. The app hands over who acted, the
--      audit summary and the event's sentences; the figures in both rows are the ones this function wrote under the
--      lock (the paid amount, the date, the remainder, and what they replaced). The event's "still outstanding"
--      sentence carries the remainder in a {remaining} placeholder the function fills.
--   2. public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb) — the cancel exactly as
--      20261113161619 writes it (the request locked, the compare-and-set on its status, the flip to cancelled, the open
--      rungs closed as skipped), and then, in the same transaction, the cancel's audit_logs row, naming the status it
--      replaced and how many rungs it closed.
--   Either the act and its record land together, or neither does.
-- WHY: REC-038 close-out, 19 Nov 2026 (owner: "fix the direct-order collection and marketing cancel the same way", after
--   the outstation approval and release were made one call each). Both functions committed first and the app wrote the
--   record afterwards, so a record that failed left the collection (or the cancel) standing while the person was told
--   the save had failed — and the order's event row and the sheet ping were skipped. The same rows are written with the
--   same values; no amount, rule or status changes.
-- ROLLBACK:
--   drop function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb);
--   drop function public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb);
--   and ship the matching code revert in the same change — recordDirectOrderCollection and cancelMarketingRequest call
--   these forms.
--
-- THE EARLIER FORMS STAY. phx_record_direct_order_collection(uuid, numeric, date, numeric, date) and
-- phx_cancel_marketing_request(uuid, text, text, timestamptz) are left as they are: the code serving before this change
-- calls them, and dropping them here would refuse every collection and cancel between this apply and the new code going
-- live. The new forms take more arguments and none has a default, so PostgREST picks each form by the arguments it is
-- sent and can never confuse the two. The earlier forms are dropped by a later migration once this code is live.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: two new function forms, no existing row changes.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A direct-order collection, with its audit row and its event row, in one transaction.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_record_direct_order_collection(
  p_order_id              uuid,
  p_paid_amount           numeric,
  p_payment_date          date,
  p_expected_paid_amount  numeric,
  p_expected_payment_date date,
  p_audit                 jsonb,
  p_event                 jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order     public.direct_order_requests%rowtype;
  v_value     numeric(18, 2);
  v_paid      numeric(18, 2);
  v_date      date;
  v_offsets   numeric(18, 2);
  v_remaining numeric(18, 2);
begin
  -- The same lock every other writer of remaining_amount takes first (the offset RPCs and the
  -- service-fee settlement), so they queue behind each other instead of interleaving.
  select * into v_order from public.direct_order_requests where id = p_order_id for update;
  if not found then
    raise exception 'direct_order_collection_order_not_found';
  end if;

  -- Compare-and-set: the caller validated against the collection it READ. If anyone changed it
  -- since, this caller's decision was made on stale figures and it loses.
  if v_order.paid_amount is distinct from p_expected_paid_amount
     or v_order.payment_date is distinct from p_expected_payment_date then
    raise exception 'direct_order_collection_conflict: the collection on order % changed since it was read', p_order_id;
  end if;

  -- Read UNDER the lock: an offset recorded or removed a moment ago is counted here.
  select round(coalesce(sum(amount), 0)::numeric, 2) into v_offsets
    from public.direct_order_marketing_offsets
   where direct_order_id = p_order_id;

  v_value := round(coalesce(v_order.sales_value, 0)::numeric, 2);

  if p_paid_amount is null then
    -- Clearing: one explicit "nothing collected" state. The amount and the date reset together.
    v_paid := null;
    v_date := null;
    if v_offsets <= 0 then
      v_remaining := null;
    else
      v_remaining := greatest(0, round(v_value - v_offsets, 2));
    end if;
  else
    if coalesce(v_order.status, '') <> 'approved' then
      raise exception 'direct_order_collection_not_approved';
    end if;
    if p_paid_amount <= 0 then
      raise exception 'direct_order_collection_amount_invalid';
    end if;
    if v_value <= 0 then
      raise exception 'direct_order_collection_no_value';
    end if;

    -- Round BEFORE comparing, exactly as collection-rules.ts does.
    v_paid := round(p_paid_amount, 2);
    if v_paid > v_value then
      raise exception 'direct_order_collection_exceeds_value';
    end if;
    if v_offsets > 0 and round(v_paid + v_offsets, 2) > v_value then
      raise exception 'direct_order_collection_exceeds_net_value';
    end if;
    if p_payment_date is null then
      raise exception 'direct_order_collection_date_required';
    end if;

    v_date := p_payment_date;
    v_remaining := round(v_value - v_paid - v_offsets, 2);
  end if;

  update public.direct_order_requests
     set paid_amount      = v_paid,
         payment_date     = v_date,
         remaining_amount = v_remaining,
         updated_at       = now()
   where id = p_order_id;

  -- The collection's required audit row, with the figures this function wrote and the ones they replaced. trim_scale
  -- writes 500.00 as 500, as the app's own JSON did.
  insert into public.audit_logs (actor_login_id, entity_id, entity_type, new_values, old_values, summary)
  values (
    coalesce(nullif(p_audit ->> 'actor_login_id', ''), 'system'),
    p_order_id::text,
    'direct_order_request',
    jsonb_build_object(
      'paidAmount', trim_scale(v_paid),
      'paymentDate', v_date,
      'remainingAmount', trim_scale(v_remaining)
    ),
    jsonb_build_object(
      'paidAmount', trim_scale(v_order.paid_amount),
      'paymentDate', v_order.payment_date,
      'remainingAmount', trim_scale(v_order.remaining_amount)
    ),
    p_audit ->> 'summary'
  );

  -- The order's timeline entry. The app's sentence for a remainder still owed carries {remaining}, filled here with the
  -- remainder computed under the lock; otherwise its other sentence (cleared, or paid in full) is written as given.
  insert into public.direct_order_events (request_id, actor_hr_id, event_type, message, metadata)
  values (
    p_order_id,
    nullif(p_event ->> 'actor_hr_id', ''),
    p_event ->> 'event_type',
    case
      when v_paid is not null and v_remaining > 0 and (p_event ->> 'message_outstanding') is not null
        then replace(p_event ->> 'message_outstanding', '{remaining}', trim_scale(v_remaining)::text)
      else p_event ->> 'message'
    end,
    jsonb_build_object(
      'previousPaidAmount', trim_scale(v_order.paid_amount),
      'paidAmount', trim_scale(v_paid),
      'remainingAmount', trim_scale(v_remaining),
      'paymentDate', v_date,
      -- Recorded so the trail proves the month was untouched, not merely that we intended it.
      'salesMonthUnchanged', nullif(v_order.sales_month, '')
    )
  );

  return jsonb_build_object(
    'paidAmount',              v_paid,
    'paymentDate',             v_date,
    'remainingAmount',         v_remaining,
    'previousPaidAmount',      v_order.paid_amount,
    'previousPaymentDate',     v_order.payment_date,
    'previousRemainingAmount', v_order.remaining_amount
  );
end;
$function$;

comment on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb) is
  'Records or clears (p_paid_amount null) the cash collected on a direct order, under the order row lock, compare-and-set against the paid amount and date the caller read, and writes its audit row and order event in the same transaction (REC-038, 19 Nov 2026). remaining_amount = sales_value - paid - offsets.';

revoke execute on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A marketing request cancel, with its audit row, in one transaction.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_cancel_marketing_request(
  p_request_id      uuid,
  p_expected_status text,
  p_actor_hr_id     text,
  p_cancelled_at    timestamptz,
  p_audit           jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status        text;
  v_closed_steps  integer := 0;
begin
  -- The request first, the same lock phx_decide_marketing_request_step takes first.
  select r.status into v_status
    from marketing_requests r
   where r.id = p_request_id
   for update;
  if not found then
    raise exception 'marketing_request_not_found: request % does not exist', p_request_id;
  end if;

  -- Compare-and-set against the status the caller read and judged cancellable.
  if v_status is distinct from p_expected_status then
    raise exception 'marketing_cancel_conflict: request % is %, not %', p_request_id, v_status, p_expected_status;
  end if;

  -- Stamping updated_by_hr_id / updated_at is what lets the AFTER UPDATE capture trigger record WHO
  -- cancelled it and from which state — exactly as the TypeScript update did.
  update marketing_requests
     set status           = 'cancelled',
         updated_at       = p_cancelled_at,
         updated_by_hr_id = p_actor_hr_id
   where id = p_request_id;

  -- Close every rung still open, exactly as a reject closes the rungs below it: 'skipped', no
  -- decision recorded (the Case File reads this as "Closed out without a decision"). Rungs already
  -- decided keep their decision; CC rows are already 'skipped'.
  update marketing_request_approval_steps
     set status     = 'skipped',
         updated_at = p_cancelled_at
   where request_id = p_request_id
     and status in ('current', 'pending')
     and is_cc = false;
  get diagnostics v_closed_steps = row_count;

  -- The cancel's required audit row: the durable record of why an in-flight request was abandoned (the reason is in
  -- the app's summary), the status it replaced and how many rungs this cancel closed.
  insert into audit_logs (actor_login_id, entity_id, entity_type, new_values, old_values, summary)
  values (
    coalesce(nullif(p_audit ->> 'actor_login_id', ''), 'system'),
    p_request_id::text,
    'marketing_request',
    jsonb_build_object('status', 'cancelled', 'closedApprovalSteps', v_closed_steps),
    jsonb_build_object('status', v_status),
    p_audit ->> 'summary'
  );

  return jsonb_build_object(
    'requestId',      p_request_id,
    'previousStatus', v_status,
    'status',         'cancelled',
    'closedSteps',    v_closed_steps
  );
end;
$function$;

comment on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb) is
  'Cancels a marketing request (compare-and-set on the status the caller read), closes its open approval rungs as skipped and writes its audit row, under the request row lock, in one transaction (REC-038, 19 Nov 2026).';

revoke execute on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb)
  to service_role;

notify pgrst, 'reload schema';

commit;
