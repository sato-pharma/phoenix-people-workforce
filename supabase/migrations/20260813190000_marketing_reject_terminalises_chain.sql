-- ─────────────────────────────────────────────────────────────────────────────
-- A rejected request must stop claiming four people still owe it a decision.
--
-- TWO DEFECTS, BOTH IN BRANCH A OF THIS ONE FUNCTION.
--
-- 1. Rejecting leaves every later rung at `pending`.
--
--    Live in production: MKT-REQ-20260811-FF5B0719 was refused at sequence 1 on 2026-08-11, and
--    still carries FOUR rows at status='pending' — SFE Validation, Marketing Review, CEO Approval,
--    Finance Execution. Four of the nine approval-step rows in the entire database are describing
--    work that will never happen.
--
--    The detail page already renders these honestly as "not reached", but that is a plaster over
--    the data: the inbox query, the nav badge (`getMarketingApproverBadge`), the approver inbox and
--    every future consumer all read the raw status. The CHECK constraint has always permitted
--    'skipped'; nothing ever wrote it here.
--
-- 2. Rejecting erases the fact that the request was ever returned.
--
--    `returned_at = CASE WHEN p_decision = 'return' THEN p_decided_at ELSE NULL END` writes NULL on
--    every reject, and `returned_step_sequence` with it. A request that was returned, resubmitted,
--    then refused kept no evidence the return ever happened — and with no history table there was
--    nowhere else for it to live.
--
--    That last clause is why this is fixable now: marketing_request_events (2026-08-13) records
--    every transition, so the request row no longer has to be the only witness. Preserving these
--    two columns costs nothing and stops the row contradicting the event log.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ────────────────────────────────────────
--
-- `skipped` is applied ONLY to non-CC rungs that are still `pending`, and only on a reject. It
-- never touches a rung that was already decided: past approval information stays exactly as it was,
-- which is the whole point of an audit trail. CC rows are already `skipped` by construction.
--
-- A RETURN is untouched. A returned request goes back to its requester and its later rungs are
-- genuinely still ahead of it — resubmitReturnedMarketingRequest resets the returned rung to
-- 'current' and the chain continues. Terminalising there would break resubmission.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- Restore the previous body by removing the `UPDATE ... SET status = 'skipped'` statement and
-- restoring `returned_at`/`returned_step_sequence` to their CASE...ELSE NULL forms. No column is
-- dropped and no row is deleted; rows written under this version simply carry more information.
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
  v_terminalised         integer := 0;
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

    -- A REJECT ends the chain. Every rung still waiting is closed out as `skipped`, so nothing
    -- downstream keeps reporting it as outstanding work. Only `pending` non-CC rungs are touched:
    -- a rung that was already approved/rejected/returned keeps its decision untouched, and CC rows
    -- are already `skipped`.
    --
    -- A RETURN is left alone on purpose — the request goes back to the requester and the later
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

  -- ── Branch B or C: approve ───────────────────────────────────────────────
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

  -- ── Branch B: next approver exists ───────────────────────────────────────
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

  -- ── Branch C: final approval ──────────────────────────────────────────────
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

-- ── backfill: close out the rungs already stranded ───────────────────────────
-- One live request is affected (MKT-REQ-20260811-FF5B0719, 4 rungs). Scoped to rejected requests
-- and pending non-CC rungs only, so no decided rung is rewritten. Idempotent.
update public.marketing_request_approval_steps s
   set status     = 'skipped',
       updated_at = now()
from public.marketing_requests r
where r.id = s.request_id
  and r.status = 'rejected'
  and s.status = 'pending'
  and s.is_cc  = false;
