-- Fix: private_calendar_data_disputes' "submit" action was registered with
-- from:[] (no predecessor status), which src/lib/workflow-registry/service.ts's
-- normalizeActions() rejects (every action's `from` must be non-empty). Because
-- listWorkflowRegistryModules() loads and validates ALL workflow_registry_modules
-- rows together and throws on the first invalid one, this single bad record was
-- blocking every workflow-registry-governed transition app-wide (resignations,
-- payroll, probation, contracts, outstation, offers, marketing requests) even
-- though it only actually belongs to an unrelated module.
--
-- private_calendar_data_disputes has no real "draft" predecessor status — a
-- dispute row is inserted directly at status 'pending_review'
-- (src/lib/private-calendar/disputes.ts submitPrivateCalendarDataDispute) and
-- the table's own status_check constraint only allows
-- ('pending_review','accepted','rejected'). So `from:[]` was an attempt to
-- represent "this action creates the row, there's no prior state" — but every
-- other module in this registry instead models create/submit actions with a
-- purely virtual predecessor status that exists ONLY in this registry's JSONB
-- (never persisted in the real table), e.g. resignation_submit's
-- from = ["resignation_new"], probation_create's from = ["probation_new"],
-- contract_create's from = ["contract_new"] (see
-- src/lib/employee-lifecycle/workflow.ts). This migration follows that same
-- established, already-working convention: add a virtual "new" status to this
-- module's statuses list and point "submit"'s from at it.

begin;

update public.workflow_registry_modules
set
    statuses = '[
        {"key":"new","label":"New","terminal":false},
        {"key":"pending_review","label":"Pending Review","terminal":false},
        {"key":"accepted","label":"Accepted","terminal":true},
        {"key":"rejected","label":"Rejected","terminal":true}
    ]'::jsonb,
    actions = '[
        {"key":"submit","label":"Employee flags inaccurate data","from":["new"],"to":"pending_review","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","Talent Acquisition","Manager","CEO","Super Admin"],"requiresReason":true,"sideEffects":["notify Super Admin"],"notifications":["notify Super Admin the dispute needs review"],"auditLog":"Private calendar data dispute submitted","tests":["private calendar dispute submit is service-gated"]},
        {"key":"accept","label":"Super Admin accepts the dispute","from":["pending_review"],"to":"accepted","allowedRoles":["Super Admin"],"requiresReason":true,"sideEffects":["record verified correction annotation","notify employee"],"notifications":["notify employee the dispute was accepted"],"auditLog":"Private calendar data dispute accepted","tests":["private calendar dispute accept is Super Admin only"]},
        {"key":"reject","label":"Super Admin rejects the dispute","from":["pending_review"],"to":"rejected","allowedRoles":["Super Admin"],"requiresReason":true,"sideEffects":["notify employee"],"notifications":["notify employee the dispute was rejected"],"auditLog":"Private calendar data dispute rejected","tests":["private calendar dispute reject is Super Admin only"]}
    ]'::jsonb,
    updated_by = 'system'
where module_key = 'private_calendar_data_disputes'
  and not (statuses @> '[{"key":"new"}]'::jsonb);

notify pgrst, 'reload schema';

commit;
