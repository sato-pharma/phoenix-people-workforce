-- Outstation & Expenses — Target Architecture, PHASE 3 (part 1): the decision function.
--
-- ADDITIVE. This migration adds three functions and wires NOTHING to them. The application still
-- writes to the legacy tables; switching those writes over is phase 3 part 2 and is a separate,
-- reviewable change. Reversing this is dropping three functions.
--
-- It replaces a decision path that today is:
--   * NOT transactional  - approve writes the request, then the ledger, then a synthetic report,
--     then an audit row, with no transaction around any of it (F-13);
--   * NOT concurrency-guarded - approve does a bare `.eq("id", …)` with no status precondition, and
--     reject's `.in("status", [...])` lists every status including the target, so it excludes
--     nothing (F-09);
--   * NOT reversible - there is no reopen, un-approve or return anywhere in the product, which is
--     why all four historical corrections were hand-written SQL (F-10);
--   * NOT audited on the money - `audit_logs` has 116 rows for outstation_request and ZERO for the
--     ledger, the table the money is actually read from (F-06).
--
-- Modelled on phx_apply_direct_order_decision, which already solves the same problem next door -
-- same p_expected_status compare-and-swap, same SECURITY DEFINER posture.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Payout period resolution.
--
--    THE POINT: approving a claim whose own payout month is already closed must still be able to
--    pay it. 241 of the backlog claims sit in periods whose batch is `locked` or `approved`, and
--    salary_records carries phx_prevent_closed_salary_detail_mutation, which REFUSES any write to
--    such a batch. Stamping the natural period would produce an approval that can never become
--    money - the exact failure this architecture exists to remove.
--
--    So: walk forward from the month after the expense was incurred and return the first period
--    that is open (no batch yet, or a batch not yet approved/locked). `incurred_*` never moves, so
--    the expense stays attributable to when it happened.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_resolve_expense_payout_period(
  p_incurred_year  integer,
  p_incurred_month integer
)
returns table (payout_year integer, payout_month integer, reperiodized boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_y      integer;
  v_m      integer;
  v_nat_y  integer;
  v_nat_m  integer;
  v_closed boolean;
  i        integer := 0;
begin
  if p_incurred_year is null or p_incurred_month is null then
    return query select null::integer, null::integer, false;
    return;
  end if;

  -- Natural period = the month AFTER the expense was incurred (outstation pays one month in arrears).
  v_y := p_incurred_year;
  v_m := p_incurred_month + 1;
  if v_m > 12 then v_m := 1; v_y := v_y + 1; end if;
  v_nat_y := v_y; v_nat_m := v_m;

  -- 36 months is a hard stop, not an expectation: without it a pathological data state would spin.
  while i < 36 loop
    select exists (
      select 1 from public.salary_batches b
      where b.year = v_y and b.month = v_m and b.status in ('approved', 'locked')
    ) into v_closed;

    if not v_closed then
      return query select v_y, v_m, (v_y is distinct from v_nat_y or v_m is distinct from v_nat_m);
      return;
    end if;

    v_m := v_m + 1;
    if v_m > 12 then v_m := 1; v_y := v_y + 1; end if;
    i := i + 1;
  end loop;

  raise exception 'Could not resolve an open payout period within 36 months of %-%.',
    p_incurred_year, p_incurred_month using errcode = 'P0001';
end;
$function$;

revoke execute on function public.phx_resolve_expense_payout_period(integer, integer)
  from public, anon, authenticated;
grant execute on function public.phx_resolve_expense_payout_period(integer, integer) to service_role;

comment on function public.phx_resolve_expense_payout_period(integer, integer) is
  'The first payout period at or after (incurred month + 1) whose payroll batch is not approved/locked. Returns reperiodized=true when the natural month was closed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The single decision. One transaction: claim + event, guarded on the status the caller
--    believed it was acting on.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_decide_expense_claim(
  p_claim_ref       text,
  p_action          text,
  p_expected_status text,
  p_actor_hr_id     text,
  p_approved_total  numeric default null,
  p_reason          text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_claim        public.expense_claims%rowtype;
  v_next         text;
  v_reason       text := nullif(btrim(coalesce(p_reason, '')), '');
  v_linked       boolean;
  v_py           integer;
  v_pm           integer;
  v_reperiod     boolean := false;
  v_approved     numeric := null;
  v_from_status  text;
begin
  if p_actor_hr_id is null or btrim(p_actor_hr_id) = '' then
    raise exception 'An actor is required: every decision must be attributable.' using errcode = 'P0001';
  end if;

  -- FOR UPDATE: two reviewers in two tabs must not both decide the same claim.
  select * into v_claim
  from public.expense_claims
  where claim_ref = p_claim_ref
  for update;

  if not found then
    raise exception 'Expense claim % was not found.', p_claim_ref using errcode = 'P0002';
  end if;

  v_from_status := v_claim.status;

  -- COMPARE-AND-SWAP. The caller says what it believed the status was; if the row moved underneath
  -- it, refuse rather than overwrite someone else's decision.
  if v_claim.status is distinct from p_expected_status then
    raise exception
      'Expense claim % moved: expected "%" but it is "%". Refresh and retry.',
      p_claim_ref, p_expected_status, v_claim.status
      using errcode = 'P0001';
  end if;

  select exists (select 1 from public.expense_payroll_links l where l.claim_id = v_claim.id)
    into v_linked;

  -- Money that payroll has already picked up is not editable here. Unwinding it is a payroll
  -- operation (phase 4), not a decision.
  if v_linked then
    raise exception
      'Expense claim % is already linked to a payroll batch; "%" is not allowed here. Unwinding a linked claim is a payroll operation.',
      p_claim_ref, p_action using errcode = 'P0001';
  end if;

  -- The state machine. Every non-terminal state has an exit; `paid` and `cancelled` are terminal.
  v_next := case
    when p_action = 'approve'   and v_claim.status in ('submitted', 'returned')             then 'approved'
    when p_action = 'reject'    and v_claim.status in ('submitted', 'returned', 'approved') then 'rejected'
    when p_action = 'return'    and v_claim.status in ('submitted')                         then 'returned'
    when p_action = 'reopen'    and v_claim.status in ('rejected')                          then 'submitted'
    when p_action = 'unapprove' and v_claim.status in ('approved')                          then 'submitted'
    when p_action = 'cancel'    and v_claim.status in ('submitted', 'returned')             then 'cancelled'
    else null
  end;

  if v_next is null then
    raise exception 'Action "%" is not allowed on an expense claim in status "%".',
      p_action, v_claim.status using errcode = 'P0001';
  end if;

  -- Reasons: required wherever a person is being told no, or told to change something.
  if p_action in ('reject', 'return') and v_reason is null then
    raise exception 'A reason is required to % expense claim %.', p_action, p_claim_ref
      using errcode = 'P0001';
  end if;

  if p_action = 'approve' then
    if p_approved_total is null then
      raise exception
        'An approved amount is required. Write it even when it equals the claim, so "reviewed and approved in full" stays distinguishable from "nobody touched it".'
        using errcode = 'P0001';
    end if;
    if p_approved_total < 0 or p_approved_total > v_claim.claimed_total then
      raise exception 'Approved amount % is outside [0, %] for claim %.',
        p_approved_total, v_claim.claimed_total, p_claim_ref using errcode = 'P0001';
    end if;
    -- Same rule the UI's bulk approve already applies: a cut the employee cannot be given a reason
    -- for is not defensible.
    if abs(p_approved_total - v_claim.claimed_total) > 0.005 and v_reason is null then
      raise exception 'A reason is required when the approved amount differs from the claim (% vs %).',
        p_approved_total, v_claim.claimed_total using errcode = 'P0001';
    end if;

    v_approved := round(p_approved_total, 2);
    select r.payout_year, r.payout_month, r.reperiodized
      into v_py, v_pm, v_reperiod
    from public.phx_resolve_expense_payout_period(v_claim.incurred_year, v_claim.incurred_month) r;
  end if;

  update public.expense_claims
  set status           = v_next,
      approved_total   = case when p_action = 'approve' then v_approved else null end,
      decided_by_hr_id = case when p_action in ('reopen', 'unapprove') then null else p_actor_hr_id end,
      decided_at       = case when p_action in ('reopen', 'unapprove') then null else now() end,
      decision_reason  = case when p_action in ('reopen', 'unapprove') then null else v_reason end,
      payout_year      = case when p_action = 'approve' then v_py else null end,
      payout_month     = case when p_action = 'approve' then v_pm else null end
  where id = v_claim.id;

  -- The audit row is written INSIDE this transaction, so an unaudited money mutation is not
  -- possible rather than merely discouraged.
  insert into public.expense_claim_events (claim_id, actor_hr_id, event_type, message, metadata)
  values (
    v_claim.id,
    p_actor_hr_id,
    'decision.' || p_action,
    coalesce(v_reason, 'Action: ' || p_action),
    jsonb_strip_nulls(jsonb_build_object(
      'from_status',    v_from_status,
      'to_status',      v_next,
      'from_approved',  v_claim.approved_total,
      'to_approved',    v_approved,
      'claimed_total',  v_claim.claimed_total,
      'payout_year',    v_py,
      'payout_month',   v_pm,
      'reperiodized',   case when v_reperiod then true else null end,
      'natural_period', case when v_reperiod
                             then (v_claim.incurred_year::text || '-' || lpad((v_claim.incurred_month + 1)::text, 2, '0'))
                             else null end
    ))
  );

  return jsonb_build_object(
    'claim_ref',      p_claim_ref,
    'from_status',    v_from_status,
    'status',         v_next,
    'approved_total', v_approved,
    'payout_year',    v_py,
    'payout_month',   v_pm,
    'reperiodized',   v_reperiod,
    'decided_at',     now()
  );
end;
$function$;

revoke execute on function public.phx_decide_expense_claim(text, text, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.phx_decide_expense_claim(text, text, text, text, numeric, text) to service_role;

comment on function public.phx_decide_expense_claim(text, text, text, text, numeric, text) is
  'One guarded, transactional expense-claim decision: approve | reject | return | reopen | unapprove | cancel. Compare-and-swap on p_expected_status; writes its own audit event; resolves payout to the earliest OPEN period on approve.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Bulk: N decisions, ONE round trip.
--
--    The current bulk save is a serial `for` loop at roughly 10-14 round trips per approved row
--    (F-23). Each decision here still gets its own guard and its own event; a refusal is returned
--    named rather than aborting the batch, so one bad row does not cost the other ninety-nine.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_decide_expense_claims(p_decisions jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item     jsonb;
  v_applied  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_result   jsonb;
  v_msg      text;
begin
  if jsonb_typeof(p_decisions) <> 'array' then
    raise exception 'p_decisions must be a JSON array of decision objects.' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_decisions) loop
    begin
      v_result := public.phx_decide_expense_claim(
        v_item->>'claim_ref',
        v_item->>'action',
        v_item->>'expected_status',
        v_item->>'actor_hr_id',
        nullif(v_item->>'approved_total', '')::numeric,
        v_item->>'reason'
      );
      v_applied := v_applied || jsonb_build_array(v_result);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'claim_ref', v_item->>'claim_ref',
        'action',    v_item->>'action',
        'reason',    v_msg
      ));
    end;
  end loop;

  return jsonb_build_object(
    'applied',       jsonb_array_length(v_applied),
    'skipped',       jsonb_array_length(v_skipped),
    'applied_rows',  v_applied,
    'skipped_rows',  v_skipped
  );
end;
$function$;

revoke execute on function public.phx_decide_expense_claims(jsonb) from public, anon, authenticated;
grant execute on function public.phx_decide_expense_claims(jsonb) to service_role;

comment on function public.phx_decide_expense_claims(jsonb) is
  'Bulk wrapper over phx_decide_expense_claim: N decisions in ONE round trip. A per-row refusal is returned named instead of aborting the batch.';
