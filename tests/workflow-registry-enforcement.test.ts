import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

export function runWorkflowRegistryEnforcementTests() {
  const registryService = source("src/lib/workflow-registry/service.ts");
  assert.match(registryService, /export class WorkflowRegistryTransitionError/);
  assert.match(registryService, /export async function assertWorkflowRegistryTransition/);
  assert.match(registryService, /Forbidden: Workflow Registry does not allow/);
  assert.match(registryService, /to !== "deleted" && to !== "unchanged"/);

  const registryRuntime = source("src/lib/workflow-registry/runtime.ts");
  assert.match(registryRuntime, /assertWorkflowRegistryRuntimeTransition/);
  assert.match(registryRuntime, /expected next status/);

  const outstationWorkflow = source("src/lib/outstation/workflow.ts");
  assert.match(outstationWorkflow, /outstationExpenseWorkflowModuleKey = "outstation_expenses"/);
  assert.match(outstationWorkflow, /normalized === "submitted"\) return "pending"/);
  assert.match(outstationWorkflow, /actionKey: OutstationExpenseWorkflowActionKey/);

  const outstationService = source("src/lib/outstation/service.ts");
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "submit"/);
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "approve"/);
  assert.match(outstationService, /actionKey: existing\.status\.startsWith\("accepted"\) \? "reject_before_payroll" : "reject"/);
  assert.match(outstationService, /actionKey: "edit_before_payroll"/);
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "delete_before_payroll"/);
  assert.match(outstationService, /already been added to payroll and cannot be edited/);

  const payrollRegistry = source("src/lib/payroll/workflow-registry.ts");
  assert.match(payrollRegistry, /payrollWorkflowRegistryModuleKey = "payroll_batches"/);
  assert.match(payrollRegistry, /assertWorkflowRegistryTransition/);
  assert.match(payrollRegistry, /Workflow Registry mismatch/);

  const payrollService = source("src/lib/payroll/service.ts");
  assert.match(payrollService, /assertPayrollWorkflowRegistryTransition\(\{/);
  assert.match(payrollService, /expectedNextStatus: transition\.nextStatus/);

  const payrollRoute = source("app/api/payroll/[id]/workflow/route.ts");
  assert.match(payrollRoute, /runPayrollWorkflow\(id,\s*action,\s*access,\s*actorIdentity,\s*rejectedReason\)/);

  const payrollExpenses = source("src/lib/outstation/expenses.ts");
  assert.match(payrollExpenses, /actionKey: "approve"/);
  assert.match(payrollExpenses, /actionKey: "add_to_payroll"/);
  assert.match(payrollExpenses, /actionKey: "delete_before_payroll"/);

  const retireRoleMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260612042046_retire_hr_specialist_role.sql");
  assert.match(retireRoleMigration, /module_key in \('recruitment', 'offers'\)/);
  assert.match(retireRoleMigration, /"Talent Acquisition"/);
  assert.match(retireRoleMigration, /where role_value <> to_jsonb\('HR Specialist'::text\)/);

  const alignmentMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260527085038_workflow_registry_runtime_alignment.sql");
  assert.match(alignmentMigration, /where module_key = 'outstation_expenses'/);
  assert.match(alignmentMigration, /where module_key = 'payroll_batches'/);
  assert.match(alignmentMigration, /"key":"mark_part1_ready"/);
  assert.match(alignmentMigration, /"key":"reopen"/);
  assert.match(alignmentMigration, /"key":"mark_review"/);

  const liveModulesMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260527091104_workflow_registry_live_modules.sql");
  for (const moduleKey of [
    "outstation_expenses",
    "leave_requests",
    "resignations",
    "probation",
    "contracts",
    "offers",
    "marketing_requests",
    "coaching_reports",
  ]) {
    assert.match(liveModulesMigration, new RegExp(`'${moduleKey}'`));
  }
  assert.match(liveModulesMigration, /"key":"edit_before_payroll"/);
  assert.match(liveModulesMigration, /"key":"reject_before_payroll"/);
  assert.match(liveModulesMigration, /Deprecated combined registry module/);
  assert.match(liveModulesMigration, /"key":"resignation_submit"/);
  assert.match(liveModulesMigration, /"key":"probation_manager_feedback"/);
  assert.match(liveModulesMigration, /"key":"contract_renew"/);
  assert.match(liveModulesMigration, /"key":"offer_hire_approve"/);
  assert.match(liveModulesMigration, /"key":"create_validation_record"/);
  assert.match(liveModulesMigration, /"key":"acknowledge"/);

  const vacationWorkflow = source("src/lib/vacation/workflow.ts");
  assert.match(vacationWorkflow, /leaveWorkflowRegistryModuleKey = "leave_requests"/);
  assert.match(vacationWorkflow, /vacationDecisionAction/);
  const vacationService = source("src/lib/vacation/service.ts");
  assert.match(vacationService, /assertLeaveWorkflowTransition\(\{[\s\S]*actionKey: "submit"/);
  assert.match(vacationService, /assertLeaveWorkflowTransition\(\{[\s\S]*actionKey: "admin_create"/);
  // The decide path must enforce the registry's runtime-overridable role authority,
  // deriving the action key from vacationDecisionAction (manager_*/hr_* per step).
  assert.match(vacationService, /const \{ actionKey \} = vacationDecisionAction\(\{/);
  assert.match(vacationService, /getPendingVacationApprovalStepForActor/);
  assert.match(vacationService, /\.rpc\("phx_apply_vacation_step_decision"/);

  const lifecycleWorkflow = source("src/lib/employee-lifecycle/workflow.ts");
  assert.match(lifecycleWorkflow, /resignationWorkflowRegistryModuleKey = "resignations"/);
  assert.match(lifecycleWorkflow, /probationWorkflowRegistryModuleKey = "probation"/);
  assert.match(lifecycleWorkflow, /contractWorkflowRegistryModuleKey = "contracts"/);
  assert.match(lifecycleWorkflow, /assertResignationWorkflowTransition/);
  assert.match(lifecycleWorkflow, /assertProbationWorkflowTransition/);
  assert.match(lifecycleWorkflow, /assertContractWorkflowTransition/);

  const resignationService = source("src/lib/resignations/service.ts");
  assert.match(resignationService, /assertResignationWorkflowTransition\(\{[\s\S]*action: "submit"/);
  assert.match(resignationService, /expectedNextStatusByAction/);
  const probationService = source("src/lib/probation/service.ts");
  assert.match(probationService, /assertProbationWorkflowTransition\(\{[\s\S]*action: "create"/);
  assert.match(probationService, /assertProbationWorkflowTransition\(\{[\s\S]*expectedNextStatus: expectedNextStatusByAction\[action\]/);
  const contractService = source("src/lib/contracts/service.ts");
  assert.match(contractService, /assertContractWorkflowTransition\(\{[\s\S]*action: "create"/);
  assert.match(contractService, /assertContractWorkflowTransition\(\{[\s\S]*expectedNextStatus: expectedNextStatusByAction\[action\]/);

  const marketingWorkflow = source("src/lib/marketing-requests/workflow.ts");
  assert.match(marketingWorkflow, /marketingWorkflowRegistryModuleKey = "marketing_requests"/);
  const marketingService = source("src/lib/marketing-requests/service.ts");
  assert.match(marketingService, /assertMarketingWorkflowTransition\(\{[\s\S]*actionKey: "create_draft"/);
  assert.match(marketingService, /assertMarketingWorkflowTransition\(\{[\s\S]*actionKey: "create_validation_record"/);
  assert.match(marketingService, /assertMarketingWorkflowTransition\(\{[\s\S]*actionKey: "update_control_step"/);
  assert.match(marketingService, /assertMarketingWorkflowTransition\(\{[\s\S]*actionKey: "upload_finance_evidence"/);

  const coachingWorkflow = source("src/lib/coaching/workflow.ts");
  assert.match(coachingWorkflow, /coachingWorkflowRegistryModuleKey = "coaching_reports"/);
  const coachingService = source("src/lib/coaching/service.ts");
  assert.match(coachingService, /assertCoachingWorkflowTransition\(\{[\s\S]*actionKey: "create_draft"/);
  assert.match(coachingService, /assertCoachingWorkflowTransition\(\{[\s\S]*actionKey: "update_draft"/);
  assert.match(coachingService, /assertCoachingWorkflowTransition\(\{[\s\S]*actionKey: "submit"/);
  assert.match(coachingService, /assertCoachingWorkflowTransition\(\{[\s\S]*actionKey: "acknowledge"/);
  assert.match(coachingService, /assertCoachingWorkflowTransition\(\{[\s\S]*actionKey: "lock"/);
}
