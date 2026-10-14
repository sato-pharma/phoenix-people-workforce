-- ─────────────────────────────────────────────────────────────────────────────
-- phx_resubmit_marketing_request — put an edited, returned request back into the approval chain,
-- in ONE transaction.
--
-- WHY THIS IS AN RPC AND NOT SIX CLIENT CALLS
--
-- `resubmitReturnedMarketingRequest` used to be six sequential client writes: delete the products,
-- insert the new ones, delete the targets, insert the new ones, reopen a rung, update the request.
-- Same reason phx_decide_marketing_request_step and phx_reopen_rejected_marketing_request are RPCs:
-- a Supabase client request that times out still commits, so the sequence can leave
--
--   * a request on `returned` with NO products and NO targets (a delete that landed, an insert that
--     did not),
--   * a request on `pending_approval` with NO rung in `current` (the SLA scan calls that "actively
--     misleading", and nobody can decide it - there is no reassign or repair tool), or
--   * two resubmits from two tabs interleaving their delete-and-inserts and leaving every product
--     twice.
--
-- A client-side claim-and-rollback was tried first and rejected in review for exactly these reasons:
-- the rollback could not re-insert products (marketing_request_products.expected_value is GENERATED
-- ALWAYS), the claim did not stop a second resubmit from claiming on top of the first, and a final
-- update that committed but errored to the client was rolled back around. One transaction has none
-- of those problems.
--
-- WHAT IT DECIDES AND WHAT IT DOES NOT
--
-- The RESTART RULE (a changed cost, customer or target set reopens the chain at the first approver)
-- is not decided here. It lives once, in src/lib/marketing-requests/resubmit-rule.ts, and the service
-- passes the rungs to rewrite as `p_steps`. This function applies that list blindly - but refuses
-- anything that is not a gating rung of THIS request, and refuses to commit unless exactly one gating
-- rung is `current` afterwards, so a bad plan can strand nothing.
--
-- The requester-only rule and the customer-scope rule are enforced in the service before this is
-- called; the requester check is repeated here as defence in depth.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.phx_resubmit_marketing_request(
  p_request_id     uuid,
  p_resubmitted_by text,
  p_request        jsonb,
  p_products       jsonb,
  p_pharmacies     jsonb,
  p_steps          jsonb,
  p_resubmitted_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request    marketing_requests%rowtype;
  v_in         marketing_requests%rowtype;
  v_open       marketing_request_approval_steps%rowtype;
  v_planned    integer;
  v_written    integer;
  v_current    integer;
  v_products   jsonb;
  v_pharmacies jsonb;
begin
  -- Serialise against a concurrent resubmit, decision, cancel or reopen on the same request. A
  -- second resubmit WAITS here, then finds the request no longer `returned` and is refused below.
  select * into v_request from marketing_requests where id = p_request_id for update;
  if not found then
    raise exception 'marketing_request_not_found: %', p_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'returned' then
    raise exception 'marketing_request_not_returned: % is %', p_request_id, v_request.status
      using errcode = 'check_violation';
  end if;

  if lower(btrim(coalesce(v_request.requester_hr_id, ''))) <> lower(btrim(coalesce(p_resubmitted_by, ''))) then
    raise exception 'marketing_resubmit_not_requester: % did not raise %', p_resubmitted_by, p_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_products is null or jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) = 0 then
    raise exception 'marketing_resubmit_no_products: a resubmit must carry at least one product'
      using errcode = 'check_violation';
  end if;
  if p_pharmacies is null or jsonb_typeof(p_pharmacies) <> 'array' or jsonb_array_length(p_pharmacies) = 0 then
    raise exception 'marketing_resubmit_no_targets: a resubmit must name at least one target'
      using errcode = 'check_violation';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'marketing_resubmit_invalid_steps: no approval rung was given to reopen'
      using errcode = 'check_violation';
  end if;

  -- 1. The edited products replace the old ones. `expected_value` is GENERATED ALWAYS, so it is
  --    deliberately not in the column list.
  delete from marketing_request_products where request_id = p_request_id;
  insert into marketing_request_products
    (request_id, product_id, product_name_snapshot, line_snapshot,
     factory_price_snapshot, forecast_quantity, value_share)
  select p_request_id, r.product_id, r.product_name_snapshot, r.line_snapshot,
         r.factory_price_snapshot, r.forecast_quantity, r.value_share
  from jsonb_populate_recordset(null::marketing_request_products, p_products) r;

  -- 2. The edited targets replace the old ones. `tracking_status` takes its column default.
  delete from marketing_request_pharmacies where request_id = p_request_id;
  insert into marketing_request_pharmacies
    (request_id, pharmacy_id, distributor_code_id, notes)
  select p_request_id, r.pharmacy_id, r.distributor_code_id, r.notes
  from jsonb_populate_recordset(null::marketing_request_pharmacies, p_pharmacies) r;

  -- 3. Rewrite the rungs the plan names: the first real gate `current`, every other gate `pending`,
  --    every earlier decision cleared. Only gating rungs of THIS request are touched - a CC row or a
  --    rung of another request in the list matches nothing, and the count check below refuses it.
  v_planned := jsonb_array_length(p_steps);
  update marketing_request_approval_steps s set
    status            = x.status,
    decision_at       = null,
    decision_by_hr_id = null,
    decision_note     = null,
    updated_at        = p_resubmitted_at
  from jsonb_to_recordset(p_steps) as x("stepId" uuid, status text)
  where s.id         = x."stepId"
    and s.request_id = p_request_id
    and s.is_cc      = false
    and x.status in ('current', 'pending');
  get diagnostics v_written = row_count;

  if v_written <> v_planned then
    raise exception 'marketing_resubmit_invalid_steps: % rung(s) planned, % matched this request', v_planned, v_written
      using errcode = 'check_violation';
  end if;

  -- 4. The invariant this whole function exists to keep: a request that goes back into
  --    `pending_approval` has exactly ONE gating rung in `current`. Zero strands it (nobody can
  --    decide it); two lets two people decide the same step. Raising here rolls back everything above.
  select count(*) into v_current
  from marketing_request_approval_steps
  where request_id = p_request_id and is_cc = false and status = 'current';
  if v_current <> 1 then
    raise exception 'marketing_resubmit_no_single_current_step: % gating rung(s) would be current', v_current
      using errcode = 'check_violation';
  end if;

  select * into v_open
  from marketing_request_approval_steps
  where request_id = p_request_id and is_cc = false and status = 'current';

  -- 5. The request itself. Its editable columns arrive as one jsonb object and are read through
  --    `jsonb_populate_record`, so each is cast to its real column type; a NOT NULL column the
  --    caller left out fails the whole transaction instead of being written as NULL.
  v_in := jsonb_populate_record(null::marketing_requests, p_request);
  update marketing_requests set
    area_id                = v_in.area_id,
    customer_contact_id    = v_in.customer_contact_id,
    customer_id            = v_in.customer_id,
    estimated_cost         = v_in.estimated_cost,
    expected_roi_value     = v_in.expected_roi_value,
    line_id                = v_in.line_id,
    notes                  = v_in.notes,
    other_request_type     = v_in.other_request_type,
    pay_date               = v_in.pay_date,
    request_type_id        = v_in.request_type_id,
    roi_duration_months    = v_in.roi_duration_months,
    roi_status             = v_in.roi_status,
    returned_at            = null,
    returned_step_sequence = null,
    status                 = 'pending_approval',
    submitted_at           = p_resubmitted_at,
    updated_at             = p_resubmitted_at,
    updated_by_hr_id       = p_resubmitted_by
  where id = p_request_id
  returning * into v_request;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at, p.id), '[]'::jsonb)
    into v_products
  from marketing_request_products p where p.request_id = p_request_id;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at, p.id), '[]'::jsonb)
    into v_pharmacies
  from marketing_request_pharmacies p where p.request_id = p_request_id;

  return jsonb_build_object(
    'request',     to_jsonb(v_request),
    'currentStep', to_jsonb(v_open),
    'products',    v_products,
    'pharmacies',  v_pharmacies
  );
end;
$function$;

revoke execute on function public.phx_resubmit_marketing_request(uuid, text, jsonb, jsonb, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_resubmit_marketing_request(uuid, text, jsonb, jsonb, jsonb, jsonb, timestamptz)
  to service_role;

comment on function public.phx_resubmit_marketing_request(uuid, text, jsonb, jsonb, jsonb, jsonb, timestamptz) is
  'Puts an edited, returned marketing request back into the approval chain in one transaction: replaces its products and targets, rewrites the approval rungs the service planned, and refuses to commit unless exactly one gating rung is current. The restart rule lives in the service (resubmit-rule.ts); the requester-only and customer-scope checks live there too, and the requester check is repeated here.';
