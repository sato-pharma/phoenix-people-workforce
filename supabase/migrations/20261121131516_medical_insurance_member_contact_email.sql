-- WHAT: A nullable `contact_email` on a medical insurance register row, with a lower-case shape check.
-- WHY:  Added on 2026-11-21 so the Medical Cover Statement could be emailed to the two people on the policy
--       who have no employee record. The owner then ruled the same day: "donot send to saeed or medhat". So
--       NOTHING reads or sends to this column; the two addresses written into it were cleared (0 rows hold one).
--       The column stays only because this file was already applied to staging and production; the comment
--       below says so, and was re-applied by hand on both after the ruling (the first apply carried a comment
--       saying the statement goes here).
-- ROLLBACK: alter table public.medical_insurance_members drop column contact_email;
--           (no data is lost: every row is null.)

alter table public.medical_insurance_members
  add column if not exists contact_email text;

alter table public.medical_insurance_members
  drop constraint if exists medical_insurance_members_contact_email_shape;

alter table public.medical_insurance_members
  add constraint medical_insurance_members_contact_email_shape
  check (contact_email is null or (contact_email = lower(btrim(contact_email)) and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

comment on column public.medical_insurance_members.contact_email is
  'An address typed for a register row with no HR id. Nothing sends to it: the owner ruled on 2026-11-21 that no Medical Cover Statement is emailed to a person on the policy with no employee record.';
