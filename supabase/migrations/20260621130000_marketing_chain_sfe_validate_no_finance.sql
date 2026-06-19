-- Governance corrections: SFE is validate-only (no reject/return), Finance step deactivated.
-- The Finance Manager ("Financial Advisor") executes approved requests — they are not an approver.
-- SFE's single action is "Validate & Forward" — they cannot block or return a request.

-- Add allow_return column to both tables (mirrors allow_reject semantics).
ALTER TABLE marketing_workflow_steps
  ADD COLUMN IF NOT EXISTS allow_return boolean NOT NULL DEFAULT true;

ALTER TABLE marketing_request_approval_steps
  ADD COLUMN IF NOT EXISTS allow_return boolean NOT NULL DEFAULT true;

-- SFE step: validate-only — cannot reject or return.
UPDATE marketing_workflow_steps
SET
  allow_reject = false,
  allow_return = false,
  decision_labels = jsonb_build_object(
    'approve', 'Validate & Forward',
    'reject',  'Reject',
    'return',  'Return for Edit'
  )
WHERE assigned_role = 'SFE Manager'
  AND step_kind = 'role';

UPDATE marketing_request_approval_steps
SET
  allow_reject = false,
  allow_return = false,
  updated_at = now()
WHERE assigned_role = 'SFE Manager'
  AND step_code = 'sfe_validation'
  AND COALESCE(step_kind, 'role') = 'role';

-- Deactivate Finance step — Finance Manager is not an approver.
UPDATE marketing_workflow_steps
SET active = false
WHERE step_kind = 'finance';
