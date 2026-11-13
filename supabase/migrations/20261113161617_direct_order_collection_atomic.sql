-- direct_order_collection_atomic
--
-- WHAT THIS CHANGES: adds public.phx_record_direct_order_collection — the one write that records
-- (or clears) the cash collected against a direct order. It locks the order row FOR UPDATE,
-- refuses if the order's collection is no longer what the caller read (compare-and-set on
-- paid_amount and payment_date), sums the order's marketing offsets UNDER that lock, re-checks the
-- money arithmetic, and writes paid_amount, payment_date, remaining_amount and updated_at in one
-- UPDATE, returning what it wrote and what it replaced. recordDirectOrderCollection
-- (src/lib/direct-orders/service.ts) calls it instead of its own unlocked read-then-update.
--
-- WHY (enterprise audit F-MKT-005): recordDirectOrderCollection read the order with no lock, read
-- the offset total in a separate query, derived remaining_amount in TypeScript and wrote it back
-- with a plain `.update().eq("id")`. phx_record_direct_order_offset /
-- phx_remove_direct_order_offset / phx_admin_settle_service_fee lock the same order row
-- and rewrite remaining_amount too. A collection saved while an offset was being recorded could
-- therefore write a remainder computed from the offsets as they stood BEFORE the offset — putting
-- settled money back on the order — and two Finance saves could each overwrite the other. Every
-- writer of remaining_amount now holds the order lock, so they run one after the other, and the
-- compare-and-set makes the second of two Finance saves fail loudly instead of silently winning.
--
-- THE RULES ARE THE SAME RULES. This function repeats collection-rules.ts
-- (deriveDirectOrderCollection) and offset-rules.ts (deriveRemainingWhenCollectionCleared) exactly:
--   record: status 'approved'; paid > 0; round(sales_value, 2) > 0; round(paid, 2) <= value;
--           when offsets > 0, round(paid + offsets, 2) <= value;
--           remaining = round(value - paid - offsets, 2)
--   clear:  paid_amount = null, payment_date = null,
--           remaining = null when offsets <= 0, else greatest(0, round(value - offsets, 2))
-- The Cairo "payment date is not in the future" and the YYYY-MM-DD shape stay in TypeScript, which
-- still runs first; this function only re-checks that a date was given.
--
-- ROLLBACK:
--   drop function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date);
-- and revert the service change in the same pull request (the service calls this function, so the
-- function must not be dropped while that code is serving).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new function, no existing row changes.

begin;

create or replace function public.phx_record_direct_order_collection(
  p_order_id              uuid,
  p_paid_amount           numeric,
  p_payment_date          date,
  p_expected_paid_amount  numeric,
  p_expected_payment_date date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order     public.direct_order_requests%rowtype;
  v_value     numeric(18, 2);
  v_paid      numeric(18, 2);
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
    if v_offsets <= 0 then
      v_remaining := null;
    else
      v_remaining := greatest(0, round(v_value - v_offsets, 2));
    end if;

    update public.direct_order_requests
       set paid_amount      = null,
           payment_date     = null,
           remaining_amount = v_remaining,
           updated_at       = now()
     where id = p_order_id;

    return jsonb_build_object(
      'paidAmount',              null,
      'paymentDate',             null,
      'remainingAmount',         v_remaining,
      'previousPaidAmount',      v_order.paid_amount,
      'previousPaymentDate',     v_order.payment_date,
      'previousRemainingAmount', v_order.remaining_amount
    );
  end if;

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

  v_remaining := round(v_value - v_paid - v_offsets, 2);

  update public.direct_order_requests
     set paid_amount      = v_paid,
         payment_date     = p_payment_date,
         remaining_amount = v_remaining,
         updated_at       = now()
   where id = p_order_id;

  return jsonb_build_object(
    'paidAmount',              v_paid,
    'paymentDate',             p_payment_date,
    'remainingAmount',         v_remaining,
    'previousPaidAmount',      v_order.paid_amount,
    'previousPaymentDate',     v_order.payment_date,
    'previousRemainingAmount', v_order.remaining_amount
  );
end;
$function$;

comment on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date) is
  'Records or clears (p_paid_amount null) the cash collected on a direct order, under the order row lock, compare-and-set against the paid amount and date the caller read. remaining_amount = sales_value - paid - offsets.';

revoke execute on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date) from public, anon, authenticated;
grant execute on function public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date) to service_role;

notify pgrst, 'reload schema';

commit;
