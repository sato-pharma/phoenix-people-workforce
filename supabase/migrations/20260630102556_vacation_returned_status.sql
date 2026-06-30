-- Add "returned" status to v2_vacation_requests so managers can return a request
-- to the employee for edits before making a final approve/reject decision.
ALTER TABLE v2_vacation_requests
  DROP CONSTRAINT v2_vacation_requests_status_check;

ALTER TABLE v2_vacation_requests
  ADD CONSTRAINT v2_vacation_requests_status_check
  CHECK (status = ANY (ARRAY[
    'needs_assignment'::text,
    'pending_manager'::text,
    'pending_hr'::text,
    'approved'::text,
    'rejected'::text,
    'returned'::text
  ]));
