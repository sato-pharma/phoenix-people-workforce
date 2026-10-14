-- admin_settle_service_fee_request
--
-- WHAT THIS CHANGES: adds public.phx_admin_settle_service_fee, one service-role-only function that
-- records, in ONE transaction, a service-fee marketing request that the Administrator raises AND
-- executes himself, settled against a direct order's debt. Nothing existing is altered: it inserts
-- one marketing customer (only when the beneficiary is not there yet), one marketing request, its
-- approval chain, and one row in direct_order_marketing_offsets, and lowers the order's
-- remaining_amount by the amount. No cash moves and nothing is sent to anyone.
--
-- WHY: Zamzam Hospital paid a 133,056 EGP direct order net of 25,000 — the fee of a service the
-- company owes the hospital's own doctor (Dr. Walid El Raees). The owner (the only Super Admin)
-- decided on 2026-10-15 that this one is recorded by him alone, in one click, with no employee
-- handling: "all six approvals as made by me". The chain is therefore written as it really
-- happened — every rung decided by the Administrator, with a note saying so — never under another
-- person's name. The six rungs are copied from the newest executed request so the shape matches
-- what the rest of the module expects.
--
-- The function refuses to run without a real order that is approved and still owes the amount,
-- a real requester, an active request type, and an Administrator that exists as an employee. It
-- locks the order first, like phx_record_direct_order_offset, so two clicks cannot both pass.
--
-- ROLLBACK: select public.phx_remove_direct_order_offset(<request id>, '<hr id>') restores the
-- order's remainder; then delete the request (its steps cascade) and, if it was created by this
-- function and has no other request, the customer; then
--   drop function public.phx_admin_settle_service_fee(uuid, text, text, text, numeric, text, text);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it only adds rows, and it needs the table from
-- 20261015012551_direct_order_marketing_offsets.sql.

begin;

create or replace function public.phx_admin_settle_service_fee(
  p_order_id          uuid,
  p_requester_hr_id   text,
  p_request_type_code text,
  p_beneficiary_name  text,
  p_amount            numeric,
  p_note              text,
  p_admin_hr_id       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_amount        numeric(14, 2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_name          text := regexp_replace(btrim(coalesce(p_beneficiary_name, '')), '\s+', ' ', 'g');
  v_normalized    text;
  v_order         public.direct_order_requests%rowtype;
  v_admin_id      text;
  v_req_id        text;
  v_req_manager   text;
  v_req_line      bigint;
  v_req_area      bigint;
  v_type_id       bigint;
  v_type_name     text;
  v_customer_id   uuid;
  v_request_id    uuid;
  v_request_code  text;
  v_template_id   uuid;
  v_other_offsets numeric(14, 2);
  v_outstanding   numeric(14, 2);
  v_remaining     numeric(14, 2);
  v_today         date := (now() at time zone 'Africa/Cairo')::date;
  v_note_text     text;
  v_offset_id     uuid;
  v_rungs         integer;
begin
  if v_amount <= 0 then
    raise exception 'service_fee_amount_invalid';
  end if;
  if v_name = '' then
    raise exception 'service_fee_beneficiary_required';
  end if;
  v_normalized := lower(v_name);

  select hr_id into v_admin_id from public.employees where upper(hr_id) = upper(btrim(coalesce(p_admin_hr_id, '')));
  if v_admin_id is null then
    raise exception 'service_fee_admin_unknown';
  end if;

  select hr_id, manager_hr_id, line_id, area_id
    into v_req_id, v_req_manager, v_req_line, v_req_area
    from public.employees where upper(hr_id) = upper(btrim(coalesce(p_requester_hr_id, '')));
  if v_req_id is null then
    raise exception 'service_fee_requester_unknown';
  end if;

  select id, name into v_type_id, v_type_name
    from public.marketing_request_types
   where code = p_request_type_code and active is true;
  if v_type_id is null then
    raise exception 'service_fee_type_unknown';
  end if;
  if p_request_type_code = 'other' and btrim(coalesce(p_note, '')) = '' then
    raise exception 'service_fee_description_required';
  end if;

  -- The order first, exactly as phx_record_direct_order_offset does, so two clicks cannot both pass.
  select * into v_order from public.direct_order_requests where id = p_order_id for update;
  if not found then
    raise exception 'offset_order_not_found';
  end if;
  if lower(coalesce(v_order.status, '')) <> 'approved' then
    raise exception 'offset_order_not_approved';
  end if;

  select coalesce(sum(amount), 0) into v_other_offsets
    from public.direct_order_marketing_offsets where direct_order_id = p_order_id;
  v_outstanding := round(coalesce(v_order.sales_value, 0)::numeric, 2)
                   - round(coalesce(v_order.paid_amount, 0)::numeric, 2)
                   - v_other_offsets;
  if v_amount > v_outstanding then
    raise exception 'offset_exceeds_outstanding';
  end if;

  -- A double click: the same amount settled against the same order by this path in the last ten minutes.
  if exists (
    select 1
      from public.direct_order_marketing_offsets o
      join public.marketing_requests r on r.id = o.marketing_request_id
     where o.direct_order_id = p_order_id
       and o.amount = v_amount
       and o.created_at > now() - interval '10 minutes'
       and r.notes like 'Recorded and executed by the Administrator%'
  ) then
    raise exception 'service_fee_duplicate';
  end if;

  -- The rungs are copied from the newest executed request, so the shape is the module's own.
  select r.id into v_template_id
    from public.marketing_requests r
   where r.executed_at is not null
     and r.status in ('active', 'roi_tracking', 'closed')
     and exists (select 1 from public.marketing_request_approval_steps s
                  where s.request_id = r.id and s.step_code = 'finance_execution')
   order by r.executed_at desc
   limit 1;
  if v_template_id is null then
    raise exception 'service_fee_chain_template_missing';
  end if;

  -- The beneficiary as a marketing customer (a doctor), found by name or created validated by the Administrator.
  select id into v_customer_id
    from public.marketing_customers
   where normalized_name = v_normalized
     and customer_type = 'doctor'
     and merged_into_customer_id is null
   order by created_at
   limit 1;
  if v_customer_id is null then
    insert into public.marketing_customers (
      customer_code, customer_type, display_name, normalized_name,
      owner_hr_id, manager_hr_id, line_id, area_id,
      validation_status, validated_by_hr_id, validated_at, validation_notes,
      created_by_hr_id, updated_by_hr_id
    ) values (
      'ADM-' || to_char(now() at time zone 'Africa/Cairo', 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
      'doctor', v_name, v_normalized,
      v_req_id, v_req_manager, v_req_line, v_req_area,
      'system_validated', v_admin_id, now(),
      'Added by the Administrator when settling a service fee against a direct order.',
      v_admin_id, v_admin_id
    ) returning id into v_customer_id;
  end if;

  v_note_text := 'Recorded and executed by the Administrator for a direct-order settlement; no cash moved. '
                 || coalesce(nullif(btrim(p_note), ''), 'Service fee kept by the hospital for ' || v_name || '.');
  v_request_code := 'MKT-REQ-' || to_char(now() at time zone 'Africa/Cairo', 'YYYYMMDD') || '-'
                    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.marketing_requests (
    request_code, requester_hr_id, manager_hr_id, line_id, area_id, customer_id, request_type_id,
    request_date, estimated_cost, status, notes, submitted_at, approved_at, executed_at,
    created_by_hr_id, updated_by_hr_id, track_direct_sales, origin
  ) values (
    v_request_code, v_req_id, v_req_manager, v_req_line, v_req_area, v_customer_id, v_type_id,
    v_today, v_amount, 'active', v_note_text, now(), now(), now(),
    v_admin_id, v_admin_id, false, 'phoenix'
  ) returning id into v_request_id;

  insert into public.marketing_request_approval_steps (
    request_id, workflow_step_id, sequence, step_code, step_name, assigned_role, assigned_hr_id,
    status, decision_by_hr_id, decision_at, decision_note, step_kind, decision_labels,
    terminal_status, allow_reject, is_cc, executed_at, allow_return
  )
  select v_request_id, t.workflow_step_id, t.sequence, t.step_code, t.step_name, t.assigned_role, v_admin_id,
         case when t.is_cc then 'skipped' else 'approved' end,
         v_admin_id, now(),
         case when t.is_cc then 'Copy-only rung; nothing to decide.'
              else 'Decided by the Administrator in the holder''s place; no cash moved, settled against a direct order.' end,
         t.step_kind, t.decision_labels, t.terminal_status, t.allow_reject, t.is_cc,
         case when t.step_code = 'finance_execution' and not t.is_cc then now() else null end,
         t.allow_return
    from public.marketing_request_approval_steps t
   where t.request_id = v_template_id
   order by t.sequence;
  get diagnostics v_rungs = row_count;

  insert into public.direct_order_marketing_offsets (direct_order_id, marketing_request_id, amount, note, created_by_hr_id)
  values (p_order_id, v_request_id, v_amount, nullif(btrim(coalesce(p_note, '')), ''), v_admin_id)
  returning id into v_offset_id;

  v_remaining := v_outstanding - v_amount;
  update public.direct_order_requests
     set remaining_amount = v_remaining,
         updated_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'offsetId',        v_offset_id,
    'requestId',       v_request_id,
    'requestCode',     v_request_code,
    'requestTypeName', v_type_name,
    'customerId',      v_customer_id,
    'rungs',           v_rungs,
    'amount',          v_amount,
    'remainingBefore', v_outstanding,
    'remainingAfter',  v_remaining
  );
end;
$function$;

revoke execute on function public.phx_admin_settle_service_fee(uuid, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.phx_admin_settle_service_fee(uuid, text, text, text, numeric, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
