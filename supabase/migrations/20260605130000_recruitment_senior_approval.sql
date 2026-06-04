-- Recruitment / ATS — Phase 4b threshold offer approval.
--
-- Offers whose net salary exceeds a configurable band require a Super Admin
-- senior sign-off before the hire is allowed (HR proposes, SA approves). The
-- threshold lives in env (RECRUITMENT_SENIOR_APPROVAL_NET_THRESHOLD); these
-- columns record the sign-off state on the application.

alter table public.recruitment_applications
  add column if not exists senior_approval_status text null,
  add column if not exists senior_approved_by text null,
  add column if not exists senior_approved_at timestamptz null;

notify pgrst, 'reload schema';
