-- register_remaining_workflows
--
-- WHAT THIS CHANGES: inserts four rows into public.workflow_registry_modules, one per state
--   machine that so far lived only in code (audit item REC-005):
--     weekly_plans           - WEEKLY_PLAN_TRANSITIONS          (src/lib/weekly-planning/workflow.ts)
--     employee_plans         - EMPLOYEE_PLAN_TRANSITIONS        (src/lib/weekly-planning/plan-v1.ts)
--     market_awareness       - MARKET_AWARENESS_TRANSITIONS     (src/lib/market-awareness/workflow.ts)
--     automated_payroll_runs - AUTOMATED_PAYROLL_RUN_TRANSITIONS (src/lib/automated-payroll/run-transitions.ts),
--                              which tests hold to the six claimTransition calls in run-service.ts
--   Each row's statuses and actions (from -> to) are COPIED EXACTLY from its code table, so nothing
--   legal today becomes illegal and nothing illegal becomes legal. Market awareness keeps one action
--   per key: every key in its table already has a single destination, so the rows sharing a key are
--   one action whose `from` is the union. Nothing else in the registry is touched.
-- WHY: every transition table in code gets a registry entry and a Workflow Control map entry
--   (tests/workflow-registry-coverage.test.ts fails on a new table without one, and holds each seed
--   below equal to its code table). employee_plans and market_awareness are now asked as a SECOND
--   gate after the code table (src/lib/workflow-registry/code-fallback.ts); with no active row the
--   code table decides alone, so applying this changes no answer, and leaving it unapplied changes
--   none either. weekly_plans has no running caller and automated_payroll_runs moves money, so those
--   two are registered for the map only; the run service never reads its row.
--   allowedRoles: plans and awareness activities are decided by IDENTITY in the services (assigned
--   manager, second approver, approver slots, CEO), never by a role list, and the gate does not read
--   roles, so those three rows name every assignable role. Automated payroll is Super Admin only
--   (src/lib/automated-payroll/permissions.ts). No action needs a virtual "_new" status: none of
--   the four code tables has a create action.
-- SAFE TO RE-RUN: `on conflict (module_key) do nothing` - a row that already exists (seeded before,
--   or edited on the Workflow Registry screen) is never overwritten. Before applying, read
--     select module_key, is_active, version from public.workflow_registry_modules
--      where module_key in ('weekly_plans','employee_plans','market_awareness','automated_payroll_runs');
--   it should return no rows; a row it does return is kept as it is, and is NOT a copy of the code.
-- ROLLBACK:
--     delete from public.workflow_registry_modules
--      where module_key in ('weekly_plans','employee_plans','market_awareness','automated_payroll_runs')
--        and created_by = 'system' and version = 1;
--   (version = 1: the update trigger bumps it on every edit, so a row someone has since edited on the
--   Workflow Registry screen is left for a person to decide.) Removing the rows returns
--   employee_plans and market_awareness to the code table alone, which is the same rule.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: four new rows in a small configuration table, nothing updated or deleted.

begin;

insert into public.workflow_registry_modules (
  module_key,
  module_name,
  description,
  statuses,
  actions,
  is_active,
  created_by,
  updated_by
)
values
  (
    'weekly_plans',
    'Weekly Plans (legacy table)',
    'The first weekly-plan machine, an exact copy of WEEKLY_PLAN_TRANSITIONS (src/lib/weekly-planning/workflow.ts), over the legacy weekly_plans table, which is empty and being retired. No running code moves a plan through it; live plans are the employee_plans module. Registered so the registry lists every transition table in code. Roles are not read from this row.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"submitted","label":"Submitted","terminal":false},
      {"key":"manager_approved","label":"Manager approved","terminal":false},
      {"key":"manager_returned","label":"Manager returned","terminal":false},
      {"key":"ceo_approved","label":"CEO approved","terminal":false},
      {"key":"ceo_returned","label":"CEO returned","terminal":false},
      {"key":"final_approved","label":"Final approved","terminal":true},
      {"key":"cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit","from":["draft","manager_returned","ceo_returned"],"to":"submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Legacy weekly plan submit","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"manager_approve","label":"Manager approve","from":["submitted"],"to":"manager_approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Legacy weekly plan manager approve","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"manager_return","label":"Manager return","from":["submitted"],"to":"manager_returned","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Legacy weekly plan manager return","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"ceo_approve","label":"CEO approve","from":["manager_approved"],"to":"ceo_approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Legacy weekly plan ceo approve","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"ceo_return","label":"CEO return","from":["manager_approved"],"to":"ceo_returned","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Legacy weekly plan ceo return","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"finalize","label":"Finalize","from":["ceo_approved","manager_approved"],"to":"final_approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Legacy weekly plan finalize","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"cancel","label":"Cancel","from":["draft","submitted","manager_returned","ceo_returned"],"to":"cancelled","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Legacy weekly plan cancel","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'employee_plans',
    'Weekly & Monthly Plans',
    'Employee weekly and monthly plans (employee_plan_headers): submit, manager stage, CEO or second-approver stage, HR acknowledgement. An exact copy of EMPLOYEE_PLAN_TRANSITIONS (src/lib/weekly-planning/plan-v1.ts). decideEmployeePlan asks this row after the code table; with no active row the code table decides alone. Roles are not read from this row: the assigned manager, the named second approver and the CEO are checked by identity in the service. A District Manager plan''s manager approval lands on final_approved in code (bypassCeo); this row records the table.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"submitted","label":"Submitted","terminal":false},
      {"key":"edit_requested","label":"Edit requested","terminal":false},
      {"key":"details_requested","label":"Details requested","terminal":false},
      {"key":"manager_approved","label":"Manager approved","terminal":false},
      {"key":"manager_rejected","label":"Manager rejected","terminal":true},
      {"key":"manager_returned","label":"Manager returned","terminal":false},
      {"key":"ceo_approved","label":"CEO approved","terminal":true},
      {"key":"ceo_rejected","label":"CEO rejected","terminal":true},
      {"key":"ceo_returned","label":"CEO returned","terminal":false},
      {"key":"final_approved","label":"Final approved","terminal":false},
      {"key":"hr_acknowledged","label":"HR acknowledged","terminal":false},
      {"key":"cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit","from":["draft","manager_returned","ceo_returned"],"to":"submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan submit","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"request_edit","label":"Request edit","from":["submitted"],"to":"edit_requested","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan request edit","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"approve_edit_request","label":"Approve edit request","from":["edit_requested"],"to":"draft","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan approve edit request","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"reject_edit_request","label":"Reject edit request","from":["edit_requested"],"to":"submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan reject edit request","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"request_visit_details","label":"Request visit details","from":["submitted"],"to":"details_requested","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan request visit details","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"submit_visit_details","label":"Submit visit details","from":["details_requested"],"to":"submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan submit visit details","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"manager_approve","label":"Manager approve","from":["submitted"],"to":"manager_approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan manager approve","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"manager_reject","label":"Manager reject","from":["submitted"],"to":"manager_rejected","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Plan manager reject","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"manager_return","label":"Manager return","from":["submitted"],"to":"manager_returned","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Plan manager return","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"ceo_approve","label":"CEO approve","from":["manager_approved"],"to":"final_approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan ceo approve","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"ceo_reject","label":"CEO reject","from":["manager_approved"],"to":"ceo_rejected","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Plan ceo reject","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"ceo_return","label":"CEO return","from":["manager_approved"],"to":"ceo_returned","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Plan ceo return","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"hr_acknowledge","label":"HR acknowledge","from":["final_approved","hr_acknowledged"],"to":"hr_acknowledged","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan hr acknowledge","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"revise","label":"Revise","from":["final_approved","hr_acknowledged"],"to":"draft","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan revise","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"cancel","label":"Cancel","from":["draft","submitted","edit_requested","details_requested","manager_returned","ceo_returned"],"to":"cancelled","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Plan cancel","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'market_awareness',
    'Market Awareness',
    'Product-manager awareness activities: the parallel approval group, the CEO, then executed and closed, with hold, release and withdraw. An exact copy of MARKET_AWARENESS_TRANSITIONS (src/lib/market-awareness/workflow.ts); the group approve is in neither, on purpose. decideActivity asks this row at the CEO step after the code table; with no active row the code table decides alone. Roles are not read from this row: approver slots and the CEO are checked in the service.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"pending_group","label":"Pending group","terminal":false},
      {"key":"on_hold","label":"On hold","terminal":false},
      {"key":"pending_ceo","label":"Pending CEO","terminal":false},
      {"key":"returned","label":"Returned","terminal":false},
      {"key":"rejected","label":"Rejected","terminal":true},
      {"key":"approved","label":"Approved","terminal":false},
      {"key":"executed","label":"Executed","terminal":false},
      {"key":"closed","label":"Closed","terminal":true},
      {"key":"withdrawn","label":"Withdrawn","terminal":true}
    ]'::jsonb,
    '[
      {"key":"return","label":"Return","from":["pending_group","pending_ceo"],"to":"returned","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Market awareness activity return","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"reject","label":"Reject","from":["pending_group","pending_ceo"],"to":"rejected","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity reject","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"hold","label":"Hold","from":["pending_group"],"to":"on_hold","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":true,"auditLog":"Market awareness activity hold","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"release","label":"Release","from":["on_hold"],"to":"pending_group","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity release","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"approve","label":"Approve","from":["pending_ceo"],"to":"approved","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity approve","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"withdraw","label":"Withdraw","from":["draft","returned","pending_group","on_hold","pending_ceo"],"to":"withdrawn","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity withdraw","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"execute","label":"Execute","from":["approved"],"to":"executed","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity execute","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"close","label":"Close","from":["executed"],"to":"closed","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","HR Operations","HR Resourcing","HR Administration","Manager","CEO","Super Admin"],"requiresReason":false,"auditLog":"Market awareness activity close","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'automated_payroll_runs',
    'Automated Payroll Runs',
    'The monthly automated payroll run: Part 1, Part 2, ready, then published or cancelled; Part 1 and Part 2 can be reopened. An exact copy of AUTOMATED_PAYROLL_RUN_TRANSITIONS (src/lib/automated-payroll/run-transitions.ts), which tests hold to the claimTransition calls in run-service.ts. Registered for the Workflow Control map only: the run service never reads this row, because it moves money. Super Admin only.',
    '[
      {"key":"part1","label":"Part 1","terminal":false},
      {"key":"part2","label":"Part 2","terminal":false},
      {"key":"ready","label":"Ready","terminal":false},
      {"key":"published","label":"Published","terminal":true},
      {"key":"cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"cancel","label":"Cancel","from":["part1","part2","ready"],"to":"cancelled","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Cancelling this run","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"confirm_part1","label":"Confirm Part 1","from":["part1"],"to":"part2","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Confirming Part 1","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"reopen_part1","label":"Reopen Part 1","from":["part2"],"to":"part1","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Reopening Part 1","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"confirm_part2","label":"Confirm Part 2","from":["part2"],"to":"ready","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Confirming Part 2","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"reopen_part2","label":"Reopen Part 2","from":["ready"],"to":"part2","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Reopening Part 2","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]},
      {"key":"publish","label":"Publish","from":["ready"],"to":"published","allowedRoles":["Super Admin"],"requiresReason":false,"auditLog":"Publishing to payslips","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  )
on conflict (module_key) do nothing;

commit;
