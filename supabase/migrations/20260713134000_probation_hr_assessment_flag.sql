-- Probation HR-assessment admin toggle (Phase 5, P5-T03).
--
-- This probation module covers the FIELD FORCE (Medical Reps + District Managers). Fingerprint /
-- settlement attendance applies only to head-office staff, so it is NOT an input here — a field
-- rep's "presence" is their CRM field activity (visits/check-ins), which feeds the SFE evidence.
-- The HR assessment is therefore available by DEFAULT: HR enters a score with the auto signals
-- relevant to field roles (leave, deduction decisions) plus HR judgment (conduct/documentation/
-- warnings, entered manually). This flag remains only as an admin enable/disable switch.
-- Additive + idempotent.

begin;

alter table public.probation_config
  add column if not exists hr_assessment_enabled boolean not null default true;

-- Ensure the flag is on wherever this column may have been created earlier with a different default.
alter table public.probation_config alter column hr_assessment_enabled set default true;
update public.probation_config set hr_assessment_enabled = true where hr_assessment_enabled is distinct from true;

notify pgrst, 'reload schema';

commit;
