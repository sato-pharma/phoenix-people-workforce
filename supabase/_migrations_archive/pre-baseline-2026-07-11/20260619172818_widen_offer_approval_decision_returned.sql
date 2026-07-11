-- Offer approval decisions now support returning an offer for edit.
-- The original table check allowed only pending/approved/rejected.
ALTER TABLE public.offer_approval_steps
  DROP CONSTRAINT IF EXISTS offer_approval_steps_decision_check;

ALTER TABLE public.offer_approval_steps
  ADD CONSTRAINT offer_approval_steps_decision_check
  CHECK (decision IN ('pending', 'approved', 'rejected', 'returned'));

NOTIFY pgrst, 'reload schema';
