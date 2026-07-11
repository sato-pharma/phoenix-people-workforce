-- Add per-trip workload counts and conditional expense amounts to outstation_expense_requests.
-- These fields appear in the canonical Excel expense report and must be stored per submission.
ALTER TABLE outstation_expense_requests
  ADD COLUMN IF NOT EXISTS meeting_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS am_workload    INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pm_workload    INTEGER       NOT NULL DEFAULT 0;

COMMENT ON COLUMN outstation_expense_requests.meeting_amount IS
  'Cash amount for meeting-type expenses (0 for non-meeting trips).';
COMMENT ON COLUMN outstation_expense_requests.other_amount IS
  'Cash amount for other/miscellaneous expenses (0 for non-other trips).';
COMMENT ON COLUMN outstation_expense_requests.am_workload IS
  'Number of morning customer visits on this trip day.';
COMMENT ON COLUMN outstation_expense_requests.pm_workload IS
  'Number of afternoon customer visits on this trip day.';
