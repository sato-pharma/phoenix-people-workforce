-- direct_order_marketing_offsets
--
-- WHAT THIS CHANGES: adds public.direct_order_marketing_offsets, one row per marketing request that
-- was SETTLED AGAINST A DIRECT ORDER'S DEBT instead of being paid out of the treasury, plus the two
-- RPCs that write it (phx_record_direct_order_offset / phx_remove_direct_order_offset). Recording an
-- offset lowers the order's remaining_amount by the offset and moves no cash anywhere.
--
-- WHY: Zamzam Hospital paid its direct order net of EGP 25,000 — the fee of a service the company
-- owes the hospital's doctor. The hospital kept the 25,000 out of its own payment, so the company
-- must neither collect it nor pay it again. The system had no way to say that: a marketing request
-- is "executed" by attaching a money-transfer proof, and an order's debt only ever falls by a
-- recorded collection. This table is the link between the two, and the missing proof stops being a
-- gap for a request that has one.
--
-- paid_amount keeps meaning CASH THAT ARRIVED. remaining_amount becomes
--   sales_value - coalesce(paid_amount, 0) - sum(offsets)
-- and both RPCs recompute it inside the same transaction as the offset row, with both parents
-- locked, so the order and its offsets can never disagree.
--
-- ROLLBACK: select public.phx_remove_direct_order_offset(<request id>) for each row (it restores the
-- order's remaining_amount), then
--   drop function public.phx_remove_direct_order_offset(uuid);
--   drop function public.phx_record_direct_order_offset(uuid, uuid, numeric, text, text);
--   drop table public.direct_order_marketing_offsets;
-- The next migration (finance_command_center_offset_requests_need_no_proof) must be rolled back
-- first: it reads this table.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new table, two new functions, no existing row changes.

begin;

create table if not exists public.direct_order_marketing_offsets (
  id                   uuid primary key default gen_random_uuid(),
  direct_order_id      uuid not null references public.direct_order_requests (id),
  marketing_request_id uuid not null references public.marketing_requests (id),
  amount               numeric(14, 2) not null check (amount > 0),
  note                 text,
  created_by_hr_id     text not null,
  created_at           timestamptz not null default now(),
  -- One request is settled against ONE order, once. Splitting a request over several orders would
  -- need a second amount to reconcile against the request's cost; nobody has asked for it.
  constraint direct_order_marketing_offsets_request_key unique (marketing_request_id)
);

create index if not exists direct_order_marketing_offsets_order_idx
  on public.direct_order_marketing_offsets (direct_order_id);

alter table public.direct_order_marketing_offsets enable row level security;

-- Application-scoped, like the rest of the module: only the service-role client touches this table.
revoke all on table public.direct_order_marketing_offsets from public, anon, authenticated;
grant select, insert, update, delete on table public.direct_order_marketing_offsets to service_role;

comment on table public.direct_order_marketing_offsets is
  'A marketing request settled against a direct order''s outstanding debt instead of a treasury payout. paid_amount on the order stays cash received; remaining_amount = sales_value - paid - sum(these amounts).';

-- ---------------------------------------------------------------------------------------------
-- Record an offset. Everything is checked HERE, under row locks, because two Finance clicks
-- landing together must not both pass an outstanding-balance check made in the application.
-- ---------------------------------------------------------------------------------------------
create or replace function public.phx_record_direct_order_offset(
  p_request_id    uuid,
  p_order_id      uuid,
  p_amount        numeric,
  p_note          text,
  p_actor_hr_id   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order         public.direct_order_requests%rowtype;
  v_request       public.marketing_requests%rowtype;
  v_amount        numeric(14, 2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_other_offsets numeric(14, 2);
  v_outstanding   numeric(14, 2);
  v_remaining     numeric(14, 2);
  v_offset_id     uuid;
begin
  if p_actor_hr_id is null or btrim(p_actor_hr_id) = '' then
    raise exception 'offset_actor_required';
  end if;
  if v_amount <= 0 then
    raise exception 'offset_amount_invalid';
  end if;

  -- Lock order first, request second, in every code path, so two callers cannot deadlock.
  select * into v_order from public.direct_order_requests where id = p_order_id for update;
  if not found then
    raise exception 'offset_order_not_found';
  end if;
  select * into v_request from public.marketing_requests where id = p_request_id for update;
  if not found then
    raise exception 'offset_request_not_found';
  end if;

  if lower(coalesce(v_order.status, '')) <> 'approved' then
    raise exception 'offset_order_not_approved';
  end if;
  -- Money-bearing statuses only: an offset stands in for a payout, so the request must be one the
  -- company has actually agreed to pay (the same set the Finance command centre counts).
  if lower(coalesce(v_request.status, '')) not in ('approved', 'active', 'roi_tracking', 'finance_hold') then
    raise exception 'offset_request_not_approved';
  end if;
  if exists (select 1 from public.direct_order_marketing_offsets where marketing_request_id = p_request_id) then
    raise exception 'offset_request_already_settled';
  end if;
  if v_amount > round(coalesce(v_request.estimated_cost, 0)::numeric, 2) then
    raise exception 'offset_exceeds_request_cost';
  end if;

  select coalesce(sum(amount), 0) into v_other_offsets
    from public.direct_order_marketing_offsets where direct_order_id = p_order_id;

  v_outstanding := round(coalesce(v_order.sales_value, 0)::numeric, 2)
                   - round(coalesce(v_order.paid_amount, 0)::numeric, 2)
                   - v_other_offsets;
  if v_amount > v_outstanding then
    raise exception 'offset_exceeds_outstanding';
  end if;

  insert into public.direct_order_marketing_offsets (direct_order_id, marketing_request_id, amount, note, created_by_hr_id)
  values (p_order_id, p_request_id, v_amount, nullif(btrim(coalesce(p_note, '')), ''), btrim(p_actor_hr_id))
  returning id into v_offset_id;

  v_remaining := v_outstanding - v_amount;
  update public.direct_order_requests
     set remaining_amount = v_remaining,
         updated_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'offsetId',        v_offset_id,
    'amount',          v_amount,
    'orderId',         p_order_id,
    'requestId',       p_request_id,
    'paidAmount',      v_order.paid_amount,
    'remainingBefore', v_outstanding,
    'remainingAfter',  v_remaining
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Undo an offset (a mistake, or the hospital reversed it). Puts the debt back on the order.
-- ---------------------------------------------------------------------------------------------
create or replace function public.phx_remove_direct_order_offset(
  p_request_id  uuid,
  p_actor_hr_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_offset        public.direct_order_marketing_offsets%rowtype;
  v_order         public.direct_order_requests%rowtype;
  v_left_offsets  numeric(14, 2);
  v_remaining     numeric(14, 2);
begin
  if p_actor_hr_id is null or btrim(p_actor_hr_id) = '' then
    raise exception 'offset_actor_required';
  end if;

  select * into v_offset from public.direct_order_marketing_offsets where marketing_request_id = p_request_id;
  if not found then
    raise exception 'offset_not_found';
  end if;

  select * into v_order from public.direct_order_requests where id = v_offset.direct_order_id for update;
  perform 1 from public.marketing_requests where id = p_request_id for update;

  delete from public.direct_order_marketing_offsets where id = v_offset.id;

  select coalesce(sum(amount), 0) into v_left_offsets
    from public.direct_order_marketing_offsets where direct_order_id = v_offset.direct_order_id;

  -- Nothing recorded at all (no collection, no offset left) reads as NULL, exactly as before any
  -- money was touched; otherwise the debt is the value less cash less the offsets that remain.
  if v_order.paid_amount is null and v_left_offsets = 0 then
    v_remaining := null;
  else
    v_remaining := round(coalesce(v_order.sales_value, 0)::numeric, 2)
                   - round(coalesce(v_order.paid_amount, 0)::numeric, 2)
                   - v_left_offsets;
  end if;

  update public.direct_order_requests
     set remaining_amount = v_remaining,
         updated_at = now()
   where id = v_offset.direct_order_id;

  return jsonb_build_object(
    'orderId',        v_offset.direct_order_id,
    'requestId',      p_request_id,
    'removedAmount',  v_offset.amount,
    'remainingAfter', v_remaining
  );
end;
$function$;

revoke execute on function public.phx_record_direct_order_offset(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.phx_record_direct_order_offset(uuid, uuid, numeric, text, text) to service_role;
revoke execute on function public.phx_remove_direct_order_offset(uuid, text) from public, anon, authenticated;
grant execute on function public.phx_remove_direct_order_offset(uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
