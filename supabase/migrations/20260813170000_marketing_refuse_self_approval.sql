-- ─────────────────────────────────────────────────────────────────────────────
-- Nobody approves their own marketing spend.
--
-- Production carries MKT-REQ-20260811-FF5B0719: raised by A-9 (Marketing Manager), with A-9
-- assigned to its own `marketing_review` rung. A role-resolved rung lands on whoever holds the
-- role, and the requester can be that person. Nothing in the chain builder, the service, or this
-- function refused it — a live count of the condition returned 1 of 2 requests.
--
-- WHY THE GUARD BELONGS HERE AND NOT ONLY IN THE SERVICE
--
-- The chain is data. `marketing_request_approval_steps.assigned_hr_id` can be edited, re-pointed by
-- a later routing change, or written by the bulk importer, and the service-side fix only shapes
-- rows at submit time. This function is the single write path for every decision, so it is the one
-- place the rule cannot be routed around.
--
-- Placed BEFORE the optimistic-lock UPDATE deliberately: raising after it would already have
-- stamped decision_by/decision_at onto the step inside the same transaction. The exception rolls
-- that back, but ordering the check first means a refused decision never touches the row at all.
--
-- HR_ID casing is compared case-insensitively and trimmed. `employees(hr_id)` is case-sensitive and
-- this module has already shipped one FK bug over it (`resolveStoredEmployeeHrId` exists precisely
-- because `a-9` and `A-9` are the same human); a guard that misses on casing is not a guard.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.phx_decide_marketing_request_step(
  p_step_id       uuid,
  p_request_id    uuid,
  p_decision      text,
  p_decided_by    text,
  p_decision_note text,
  p_decided_at    timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_terminal_step_status text;
  v_step                 marketing_request_approval_steps%ROWTYPE;
  v_request              marketing_requests%ROWTYPE;
  v_next_step            marketing_request_approval_steps%ROWTYPE;
  v_has_next             boolean := false;
  v_terminal_status      text;
  v_is_execution         boolean := false;
  v_requester_hr_id      text;
BEGIN
  -- Map decision → step terminal status
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

  -- ── Branch A: reject or return ───────────────────────────────────────────
  IF p_decision IN ('reject', 'return') THEN
    UPDATE marketing_requests SET
      rejected_at            = CASE WHEN p_decision = 'reject' THEN p_decided_at ELSE NULL END,
      returned_at            = CASE WHEN p_decision = 'return' THEN p_decided_at ELSE NULL END,
      returned_step_sequence = CASE WHEN p_decision = 'return' THEN v_step.sequence ELSE NULL END,
      status                 = CASE WHEN p_decision = 'reject' THEN 'rejected'::text ELSE 'returned'::text END,
      updated_at             = p_decided_at,
      updated_by_hr_id       = p_decided_by
    WHERE id = p_request_id
    RETURNING * INTO v_request;

    RETURN jsonb_build_object(
      'branch',      p_decision,
      'step',        to_jsonb(v_step),
      'request',     to_jsonb(v_request),
      'nextStep',    NULL,
      'isExecution', false
    );
  END IF;

  -- ── Branch B or C: approve ───────────────────────────────────────────────
  -- Try to advance the next pending non-CC step atomically.
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
  AND status = 'pending'   -- second guard against a concurrent write on the same row
  RETURNING * INTO v_next_step;

  v_has_next := FOUND;

  -- ── Branch B: next approver exists ───────────────────────────────────────
  IF v_has_next THEN
    -- marketing_requests stays 'pending_approval'; just return the current row.
    SELECT * INTO v_request FROM marketing_requests WHERE id = p_request_id;

    RETURN jsonb_build_object(
      'branch',      'approve_next',
      'step',        to_jsonb(v_step),
      'request',     to_jsonb(v_request),
      'nextStep',    to_jsonb(v_next_step),
      'isExecution', false
    );
  END IF;

  -- ── Branch C: final approval ──────────────────────────────────────────────
  v_terminal_status := COALESCE(v_step.terminal_status, 'approved');
  v_is_execution    := (v_terminal_status = 'active');

  UPDATE marketing_requests SET
    approved_at      = p_decided_at,
    executed_at      = CASE WHEN v_is_execution THEN p_decided_at ELSE NULL END,
    status           = v_terminal_status,
    updated_at       = p_decided_at,
    updated_by_hr_id = p_decided_by
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  -- Finance-execution steps also stamp executed_at on the step row.
  IF v_is_execution THEN
    UPDATE marketing_request_approval_steps SET
      executed_at = p_decided_at,
      updated_at  = p_decided_at
    WHERE id = p_step_id
    RETURNING * INTO v_step;
  END IF;

  RETURN jsonb_build_object(
    'branch',      'approve_final',
    'step',        to_jsonb(v_step),
    'request',     to_jsonb(v_request),
    'nextStep',    NULL,
    'isExecution', v_is_execution
  );
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, but the revoke is restated so this migration is
-- self-describing and so the rule survives if the function is ever recreated from this file alone.
-- anon/authenticated inherit EXECUTE through PUBLIC membership, so revoking only those two is a
-- no-op; and revoking PUBLIC on a default ACL also strips service_role, hence the explicit re-grant.
revoke execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  to service_role;
