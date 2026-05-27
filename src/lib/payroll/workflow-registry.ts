import type { AccessContext } from "@/lib/auth/permissions";
import { PayrollConflictError } from "@/lib/payroll/errors";
import type { PayrollWorkflowAction } from "@/lib/payroll/types";
import {
  assertWorkflowRegistryTransition,
  isWorkflowRegistryTransitionError,
} from "@/lib/workflow-registry/service";

export const payrollWorkflowRegistryModuleKey = "payroll_batches";

export async function assertPayrollWorkflowRegistryTransition(input: {
  access: Pick<AccessContext, "role">;
  action: PayrollWorkflowAction;
  currentStatus: string;
  expectedNextStatus: string;
}) {
  try {
    const transition = await assertWorkflowRegistryTransition({
      actionKey: input.action,
      moduleKey: payrollWorkflowRegistryModuleKey,
      role: input.access.role,
      status: input.currentStatus,
    });

    if (transition.nextStatus !== input.expectedNextStatus) {
      throw new PayrollConflictError(
        `Workflow Registry mismatch: payroll action ${input.action} must move ` +
          `${input.currentStatus} to ${input.expectedNextStatus}, but registry points to ${transition.nextStatus}.`,
      );
    }

    return transition;
  } catch (error) {
    if (isWorkflowRegistryTransitionError(error)) {
      throw new PayrollConflictError(error.message);
    }
    throw error;
  }
}
