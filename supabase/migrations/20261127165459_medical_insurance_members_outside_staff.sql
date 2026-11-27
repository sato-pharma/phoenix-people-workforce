-- medical_insurance_members_outside_staff
--
-- WHAT THIS CHANGES: one new column, medical_insurance_members.outside_staff (boolean, not null, default false).
-- WHY: owner, 27 Nov 2026 — Medhat Makram Wahba is on the issued Libano-Suisse policy (certificate 54296710) with no
--   Phoenix employee record, and his answer was "keep him, outside staff". A row marked outside_staff stays on the
--   register and leaves the "On the policy with no Phoenix employee record" check (src/lib/medical-insurance/eligibility.ts).
-- ROLLBACK: alter table public.medical_insurance_members drop column outside_staff;  (only the marks are lost)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing destructive or bulk: a new column whose default changes no existing row's meaning.

begin;

alter table public.medical_insurance_members add column if not exists outside_staff boolean not null default false;

comment on column public.medical_insurance_members.outside_staff is
  'Covered on Sato''s policy but not a Phoenix employee, kept on by the owner''s decision: the add list no longer asks who they are.';

commit;
