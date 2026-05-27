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

  const outstationWorkflow = source("src/lib/outstation/workflow.ts");
  assert.match(outstationWorkflow, /outstationExpenseWorkflowModuleKey = "outstation_expenses"/);
  assert.match(outstationWorkflow, /normalized === "submitted"\) return "pending"/);
  assert.match(outstationWorkflow, /actionKey: OutstationExpenseWorkflowActionKey/);

  const outstationService = source("src/lib/outstation/service.ts");
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "submit"/);
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "approve"/);
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "reject"/);
  assert.match(outstationService, /assertOutstationExpenseWorkflowTransition\(\{[\s\S]*actionKey: "delete_before_payroll"/);

  const payrollRegistry = source("src/lib/payroll/workflow-registry.ts");
  assert.match(payrollRegistry, /payrollWorkflowRegistryModuleKey = "payroll_batches"/);
  assert.match(payrollRegistry, /assertWorkflowRegistryTransition/);
  assert.match(payrollRegistry, /Workflow Registry mismatch/);

  const payrollService = source("src/lib/payroll/service.ts");
  assert.match(payrollService, /assertPayrollWorkflowRegistryTransition\(\{/);
  assert.match(payrollService, /expectedNextStatus: transition\.nextStatus/);

  const payrollRoute = source("app/api/payroll/[id]/workflow/route.ts");
  assert.match(payrollRoute, /runPayrollWorkflow\(id,\s*action,\s*access,\s*actorIdentity,\s*rejectedReason\)/);

  const payrollExpenses = source("src/lib/payroll/expenses.ts");
  assert.match(payrollExpenses, /actionKey: "approve"/);
  assert.match(payrollExpenses, /actionKey: "add_to_payroll"/);
  assert.match(payrollExpenses, /actionKey: "delete_before_payroll"/);

  const baseMigration = source("supabase/migrations/20260527083111_workflow_registry.sql");
  assert.match(baseMigration, /"key":"mark_part1_ready"/);
  assert.match(baseMigration, /"key":"reopen"/);
  assert.match(baseMigration, /"Super Admin","HR Specialist","Finance Manager","CEO"/);

  const alignmentMigration = source("supabase/migrations/20260527085038_workflow_registry_runtime_alignment.sql");
  assert.match(alignmentMigration, /where module_key = 'outstation_expenses'/);
  assert.match(alignmentMigration, /where module_key = 'payroll_batches'/);
  assert.match(alignmentMigration, /"key":"mark_review"/);
}
