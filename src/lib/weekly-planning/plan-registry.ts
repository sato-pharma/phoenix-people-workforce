import {
  assertRegistryAgreesWithCodeTransition,
  type WorkflowRegistryModuleLoader,
} from "@/lib/workflow-registry/code-fallback";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import {
  EMPLOYEE_PLAN_TRANSITIONS,
  EmployeePlanWorkflowError,
  type EmployeePlanAction,
  type EmployeePlanStatus,
} from "@/lib/weekly-planning/plan-v1";

/**
 * Weekly and monthly (employee) plans in the workflow registry — module `employee_plans`, seeded as
 * an exact copy of EMPLOYEE_PLAN_TRANSITIONS by migration 20261113201813 (audit item REC-005).
 *
 * Asked AFTER getNextEmployeePlanStatus, never instead of it: the code table stays the first gate
 * and the whole rule whenever the registry row is absent or unreadable (code-fallback.ts). The
 * destination compared is the TABLE's `to`, not the District Manager bypass — `bypassCeo` lands a
 * manager_approve on final_approved by design, and the registry row records the table, not the
 * bypass. Kept out of plan-v1.ts on purpose: that file is pure and the screens import it.
 */
export const employeePlanWorkflowRegistryModuleKey = "employee_plans";

export async function assertEmployeePlanRegistryTransition(input: {
  status: EmployeePlanStatus;
  action: EmployeePlanAction;
  loadModules?: WorkflowRegistryModuleLoader;
}) {
  try {
    return await assertRegistryAgreesWithCodeTransition({
      actionKey: input.action,
      codeNextStatus: EMPLOYEE_PLAN_TRANSITIONS[input.action].to,
      loadModules: input.loadModules,
      moduleKey: employeePlanWorkflowRegistryModuleKey,
      status: input.status,
    });
  } catch (error) {
    if (isWorkflowRegistryTransitionError(error)) {
      throw new EmployeePlanWorkflowError("INVALID_TRANSITION", error.message);
    }
    throw error;
  }
}
