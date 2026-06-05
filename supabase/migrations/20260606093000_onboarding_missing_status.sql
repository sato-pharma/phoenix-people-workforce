-- Recruitment onboarding (M6) — add the 'missing' document status.
--
-- Document Verification rule: a required document with no submission is "Missing"
-- (distinct from awaiting-review "pending"). Additive + idempotent. documentsComplete
-- stays approved/waived-only, so a Missing document keeps the hire gate closed.

alter table public.recruitment_onboarding_items
  drop constraint if exists recruitment_onboarding_items_status_check;
alter table public.recruitment_onboarding_items
  add constraint recruitment_onboarding_items_status_check
  check (status in ('pending', 'submitted', 'approved', 'rejected', 'waived', 'completed', 'missing'));

notify pgrst, 'reload schema';
