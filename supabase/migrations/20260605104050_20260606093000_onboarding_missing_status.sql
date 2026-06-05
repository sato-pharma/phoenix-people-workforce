-- Recruitment onboarding (M6) — add the 'missing' document status.
alter table public.recruitment_onboarding_items
  drop constraint if exists recruitment_onboarding_items_status_check;
alter table public.recruitment_onboarding_items
  add constraint recruitment_onboarding_items_status_check
  check (status in ('pending', 'submitted', 'approved', 'rejected', 'waived', 'completed', 'missing'));

notify pgrst, 'reload schema';;
