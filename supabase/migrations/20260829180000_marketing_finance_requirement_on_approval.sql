-- ─────────────────────────────────────────────────────────────────────────────
-- Approving a marketing request never recorded the invoice obligation it creates.
--
-- THE DEFECT
--
-- `phx_decide_marketing_request_step` is the single transaction that decides a marketing approval
-- rung. Branch C — final approval — stamps `approved_at`, sets the terminal status, and returns.
-- It has never written `marketing_request_finance_requirements`. Confirmed against the live
-- function body in production on 2026-08-29: the string "finance_requirement" does not appear in
-- it anywhere.
--
-- The only code anywhere that creates that row is the finance-evidence upload
-- (`src/lib/marketing-requests/service.ts`, the upsert keyed on `request_id`), which fires when
-- somebody uploads an invoice or a money-transfer proof. So the obligation only comes into
-- existence once it has already been discharged. Nothing ever records that an invoice is OWED.
--
-- Measured in production, 2026-08-29 — 4 approved requests, 1 finance row between them:
--
--   MKT-REQ-20260802-DCF31EC4   approved 2026-08-04   EGP  5,500   no finance row
--   MKT-REQ-20260814-6CD456E4   approved 2026-08-23   EGP 11,200   row created 2026-08-26 by the
--                                                                  invoice upload, three days
--                                                                  later, deadline still NULL
--   MKT-REQ-20260818-8C628BF4   approved 2026-08-26   EGP  3,000   no finance row
--   MKT-REQ-20260823-9C5756FD   approved 2026-08-26   EGP  3,500   no finance row
--
-- EGP 12,000 of approved marketing spend carries no invoice obligation at all, and the one request
-- that does have a row has no deadline on it.
--
-- THE SETTING THAT WAS NEVER READ
--
-- `marketing_control_settings.finance_invoice_deadline_days` has held {"days": 7} since it was
-- seeded on 2026-05-21, and the Marketing Control workspace offers it as an editable field
-- (`marketing-control-workspace.tsx`). No code has ever read it. Editing it in the UI changed
-- nothing. This migration makes it the deadline rule it was always meant to be.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ────────────────────────────────────────
--
-- * ON CONFLICT (request_id) DO NOTHING, never DO UPDATE. A row can legitimately already exist —
--   the evidence upload can land before the final rung is decided — and it will then be sitting at
--   invoice_status 'submitted' with its storage paths set. Rewriting it back to 'pending' would
--   erase a delivered invoice. An approval may CREATE an obligation; it may never rewrite one.
--
-- * Both terminal statuses get a row. Branch C covers 'approved' and 'active' (finance execution);
--   both mean the money is committed, so both owe an invoice.
--
-- * Reject and return (Branch A), and every intermediate rung (Branch B), are untouched. Nothing is
--   owed on a request nobody approved.
--
-- * invoice_required is set true for every approved request. There is no per-request-type flag in
--   this schema to express anything narrower — marketing_request_types carries only
--   requires_description — and the workflow map has always documented this step as "On approval
--   creates the finance requirement (invoice/deadline)". If some request type should be exempt,
--   that needs a new flag and is a separate change.
--
-- The deadline is computed in Africa/Cairo, not UTC. An approval at 01:30 Cairo is the 29th here
-- and the 28th in UTC, and the date a human is held to has to be the local one.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phx_decide_marketing_request_step(
  p_step_id       uuid,
  p_request_id    uuid,
  p_decision      text,
  p_decided_by    text,
  p_decision_note text,
  p_decided_at    timestamptz
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_step_status text;
  v_step                 marketing_request_approval_steps%ROWTYPE;
  v_request              marketing_requests%ROWTYPE;
  v_next_step            marketing_request_approval_steps%ROWTYPE;
  v_has_next             boolean := false;
  v_terminal_status      text;
  v_is_execution         boolean := false;
  v_requester_hr_id      text;
  v_terminalised         integer := 0;
  v_invoice_days         integer;
BEGIN
  -- Map decision -> step terminal status
  v_terminal_step_status := CASE p_decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject'  THEN 'rejected'
    WHEN 'return'  THEN 'returned'
  END;

  IF v_terminal_step_status IS NULL THEN
    RAISE EXCEPTION 'Invalid marketing request decision: %', p_decision;
  END IF;

  -- 0. Nobody decides their own request. Checked before anything is written.
  SELECT r.requester_hr_id INTO v_requester_hr_id
  FROM marketing_requests r
  WHERE r.id = p_request_id;

  IF v_requester_hr_id IS NOT NULL
     AND lower(btrim(v_requester_hr_id)) = lower(btrim(COALESCE(p_decided_by, ''))) THEN
    -- Caller maps this to a 403.
    RAISE EXCEPTION 'marketing_self_approval_refused: % raised this request and may not decide it', p_decided_by
      USING errcode = 'check_violation';
  END IF;

  -- 1. Stamp the current step with optimistic-lock (status must still be 'current').
  UPDATE marketing_request_approval_steps SET
    decision_at       = p_decided_at,
    decision_by_hr_id = p_decided_by,
    decision_note     = NULLIF(btrim(COALESCE(p_decision_note, '')), ''),
    status            = v_terminal_step_status,
    updated_at        = p_decided_at
  WHERE id     = p_step_id
    AND status = 'current'
  RETURNING * INTO v_step;

  IF NOT FOUND THEN
    -- Signals a concurrent decision; caller maps this to a 409 conflict.
    RAISE EXCEPTION 'marketing_step_already_decided: step % was no longer current', p_step_id;
  END IF;

  -- Branch A: reject or return
  IF p_decision IN ('reject', 'return') THEN

    -- A REJECT ends the chain. Every rung still waiting is closed out as `skipped`, so nothing
    -- downstream keeps reporting it as outstanding work. Only `pending` non-CC rungs are touched:
    -- a rung that was already approved/rejected/returned keeps its decision untouched, and CC rows
    -- are already `skipped`.
    --
    -- A RETURN is left alone on purpose - the request goes back to the requester and the later
    -- rungs are genuinely still ahead of it; resubmission depends on them staying `pending`.
    IF p_decision = 'reject' THEN
      UPDATE marketing_request_approval_steps SET
        status     = 'skipped',
        updated_at = p_decided_at
      WHERE request_id = p_request_id
        AND status     = 'pending'
        AND is_cc      = false;
      GET DIAGNOSTICS v_terminalised = ROW_COUNT;
    END IF;

    UPDATE marketing_requests SET
      -- `returned_at` and `returned_step_sequence` are NO LONGER cleared by a reject. A request
      -- that was returned, resubmitted, then refused keeps the evidence that the return happened.
      -- Only a `return` sets them; a `reject` leaves whatever is already there.
      rejected_at            = CASE WHEN p_decision = 'reject' THEN p_decided_at ELSE rejected_at END,
      returned_at            = CASE WHEN p_decision = 'return' THEN p_decided_at ELSE returned_at END,
      returned_step_sequence = CASE WHEN p_decision = 'return' THEN v_step.sequence ELSE returned_step_sequence END,
      status                 = CASE WHEN p_decision = 'reject' THEN 'rejected'::text ELSE 'returned'::text END,
      updated_at             = p_decided_at,
      updated_by_hr_id       = p_decided_by
    WHERE id = p_request_id
    RETURNING * INTO v_request;

    RETURN jsonb_build_object(
      'branch',        p_decision,
      'step',          to_jsonb(v_step),
      'request',       to_jsonb(v_request),
      'nextStep',      NULL,
      'isExecution',   false,
      -- How many rungs were closed out, so the caller can log it rather than infer it.
      'terminalised',  v_terminalised
    );
  END IF;

  -- Branch B or C: approve
  UPDATE marketing_request_approval_steps SET
    status     = 'current',
    updated_at = p_decided_at
  WHERE id = (
    SELECT id
    FROM   marketing_request_approval_steps
    WHERE  request_id = p_request_id
      AND  status     = 'pending'
      AND  is_cc      = false
      AND  sequence   > v_step.sequence
    ORDER  BY sequence
    LIMIT  1
  )
  AND status = 'pending'
  RETURNING * INTO v_next_step;

  v_has_next := FOUND;

  -- Branch B: next approver exists
  IF v_has_next THEN
    SELECT * INTO v_request FROM marketing_requests WHERE id = p_request_id;

    RETURN jsonb_build_object(
      'branch',      'approve_next',
      'step',        to_jsonb(v_step),
      'request',     to_jsonb(v_request),
      'nextStep',    to_jsonb(v_next_step),
      'isExecution', false
    );
  END IF;

  -- Branch C: final approval
  v_terminal_status := COALESCE(v_step.terminal_status, 'approved');
  v_is_execution    := (v_terminal_status = 'active');

  UPDATE marketing_requests SET
    approved_at      = p_decided_at,
    executed_at      = CASE WHEN v_is_execution THEN p_decided_at ELSE executed_at END,
    status           = v_terminal_status,
    updated_at       = p_decided_at,
    updated_by_hr_id = p_decided_by
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  IF v_is_execution THEN
    UPDATE marketing_request_approval_steps SET
      executed_at = p_decided_at,
      updated_at  = p_decided_at
    WHERE id = p_step_id
    RETURNING * INTO v_step;
  END IF;

  -- Record the invoice obligation this approval creates.
  --
  -- Inside the same transaction as the approval on purpose: this function exists precisely so a
  -- decision cannot half-apply, and an approval that commits without its obligation is exactly the
  -- half-state it was written to prevent.
  --
  -- A missing settings row falls back to 7 rather than raising. The deadline is a reminder; a
  -- deleted setting must not be able to make an approval fail.
  SELECT (setting_value ->> 'days')::integer
    INTO v_invoice_days
  FROM marketing_control_settings
  WHERE setting_key = 'finance_invoice_deadline_days';

  INSERT INTO marketing_request_finance_requirements (
    request_id,
    invoice_required,
    invoice_status,
    invoice_deadline_date,
    created_at,
    updated_at
  )
  VALUES (
    p_request_id,
    true,
    'pending',
    ((p_decided_at AT TIME ZONE 'Africa/Cairo')::date + COALESCE(v_invoice_days, 7)),
    p_decided_at,
    p_decided_at
  )
  ON CONFLICT (request_id) DO NOTHING;

  RETURN jsonb_build_object(
    'branch',      'approve_final',
    'step',        to_jsonb(v_step),
    'request',     to_jsonb(v_request),
    'nextStep',    NULL,
    'isExecution', v_is_execution
  );
END;
$function$;

revoke execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  to service_role;

-- ── backfill: the obligations already approved without one ───────────────────
-- Scoped to requests that are genuinely approved and have no finance row at all, so the one request
-- whose row was created by an invoice upload is left exactly as it is. Idempotent. The `notes` text
-- records where each row came from, which is also what makes it reversible:
--
--   delete from public.marketing_request_finance_requirements
--    where notes like 'Backfilled 2026-08-29:%';
--
-- Each deadline is measured from that request's own approval date, so the request approved on
-- 2026-08-04 is recorded as already long overdue. That is the truth — the invoice is weeks late —
-- and dating them all from today would hide exactly the thing worth seeing.
insert into public.marketing_request_finance_requirements (
  request_id,
  invoice_required,
  invoice_status,
  invoice_deadline_date,
  notes,
  created_at,
  updated_at
)
select
  r.id,
  true,
  'pending',
  ((r.approved_at at time zone 'Africa/Cairo')::date
    + coalesce(
        (select (setting_value ->> 'days')::integer
           from public.marketing_control_settings
          where setting_key = 'finance_invoice_deadline_days'),
        7)),
  'Backfilled 2026-08-29: approved before the decision RPC recorded finance obligations.',
  r.approved_at,
  now()
from public.marketing_requests r
where r.approved_at is not null
on conflict (request_id) do nothing;
