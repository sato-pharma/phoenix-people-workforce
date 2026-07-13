-- Probation final-decision snapshot + Extend teardown (Phase 10).
--
-- 1. decision_snapshot: a defensible JSON copy of the consolidated report captured at the moment
--    a Pass/Terminate decision is recorded, so the evidence behind a decision is preserved even if
--    later data changes. Additive.
-- 2. Extend teardown: owner policy removed the "extend" probation decision. The type layer was
--    cleaned in Phase 1; this strips the now-dead `probation_extended` status from the live
--    workflow-registry 'probation' module so no dead workflow path remains (acceptance #44).
--    Idempotent (only rewrites if the status is present).

begin;

alter table public.probation_cases
  add column if not exists decision_snapshot jsonb;

-- Remove the dead probation_extended status from the registry 'probation' module (if present).
update public.workflow_registry_modules
set statuses = (
      select coalesce(jsonb_agg(s), '[]'::jsonb)
      from jsonb_array_elements(statuses) s
      where s->>'key' <> 'probation_extended'
    ),
    version = coalesce(version, 1) + 1,
    updated_at = now()
where module_key = 'probation'
  and statuses @> '[{"key":"probation_extended"}]'::jsonb;

notify pgrst, 'reload schema';

commit;
