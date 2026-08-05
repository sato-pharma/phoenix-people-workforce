-- Allow 'ta' as a probation feedback submitter role.
--
-- Talent Acquisition submits probation feedback alongside HR (owner-approved 2026-08-05; the
-- intent was already stated in app/employee-portals/probation/page.tsx, which has listed her in
-- canSubmitManagerFeedback since 2026-07-24 — the button rendered for her but nothing behind it
-- would accept her submission).
--
-- probation_feedback_submissions_submitter_role_check pinned the allowed set to
-- dm / nsm / tm / pm_gpm, so inserting 'ta' would fail with 23514 even after the application
-- changes. Widen the constraint; the existing four values are unchanged.
--
-- Safe to run against live data: the table holds 0 rows (the feature has never recorded a
-- submission — see the route's permission bug fixed in the same change), so no existing row can
-- violate the widened constraint, and widening a CHECK never invalidates rows that already pass.

alter table public.probation_feedback_submissions
  drop constraint if exists probation_feedback_submissions_submitter_role_check;

alter table public.probation_feedback_submissions
  add constraint probation_feedback_submissions_submitter_role_check
  check (submitter_role = any (array['dm'::text, 'nsm'::text, 'tm'::text, 'pm_gpm'::text, 'ta'::text]));
