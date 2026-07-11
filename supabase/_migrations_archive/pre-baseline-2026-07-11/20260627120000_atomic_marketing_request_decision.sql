-- ---------------------------------------------------------------------------
-- phx_decide_marketing_request_step
-- Atomically applies a single approval-step decision (approve / reject / return)
-- across marketing_request_approval_steps and marketing_requests in one transaction.
--
-- Replaces the 2–4 sequential .from(...).update(...) calls in
-- src/lib/marketing-requests/service.ts :: decideMarketingRequestWorkflow,
-- eliminating the corrupt half-state risk when a write succeeds and the next fails.
--
-- All three decision paths are handled:
--   A. reject / return  → stamp step + update marketing_requests (rejected/returned)
--   B. approve (next)   → stamp step + advance next pending step to 'current'
--   C. approve (final)  → stamp step + update marketing_requests (approved/active)
--
-- Returns jsonb:
--   { branch, step, request, nextStep, isExecution }
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION phx_decide_marketing_request_step(
  p_step_id       uuid,        -- step being decided (must have status = 'current')
  p_request_id    uuid,        -- parent marketing_request
  p_decision      text,        -- 'approve' | 'reject' | 'return'
  p_decided_by    text,        -- canonical stored HR_ID of the actor
  p_decision_note text,        -- nullable reason / comment
  p_decided_at    timestamptz  -- caller-supplied timestamp for consistency
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal_step_status text;
  v_step                 marketing_request_approval_steps%ROWTYPE;
  v_request              marketing_requests%ROWTYPE;
  v_next_step            marketing_request_approval_steps%ROWTYPE;
  v_has_next             boolean := false;
  v_terminal_status      text;
  v_is_execution         boolean := false;
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
$$;

REVOKE ALL ON FUNCTION phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  TO service_role;
