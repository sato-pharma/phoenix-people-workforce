import type { AccessContext } from "@/lib/auth/permissions";
import {
  assertWorkflowRegistryTransition,
  WorkflowRegistryTransitionError,
} from "@/lib/workflow-registry/service";

export const outstationExpenseWorkflowModuleKey = "outstation_expenses";

export type OutstationExpenseWorkflowActionKey =
  | "add_to_payroll"
  | "approve"
  | "delete_before_payroll"
  | "edit_before_payroll"
  | "reject"
  | "reject_before_payroll"
  | "submit";

export function toOutstationExpenseWorkflowStatus(
  status: string | null | undefined,
  options: { addedToPayroll?: boolean } = {},
) {
  if (options.addedToPayroll) return "added_to_payroll";

  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized) return "draft";
  if (normalized === "submitted") return "pending";
  // The granular decision statuses fold onto the registry's approved / rejected so the
  // workflow registry needs no schema change.
  if (normalized === "accepted_by_system" || normalized === "accepted_by_admin") return "approved";
  if (normalized === "rejected_by_system" || normalized === "rejected_by_admin") return "rejected";
  return normalized;
}

export async function assertOutstationExpenseWorkflowTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: OutstationExpenseWorkflowActionKey;
  addedToPayroll?: boolean;
  expectedNextStatus?: string;
  status: string | null | undefined;
}) {
  const workflowStatus = toOutstationExpenseWorkflowStatus(input.status, {
    addedToPayroll: input.addedToPayroll,
  });
  const transition = await assertWorkflowRegistryTransition({
    actionKey: input.actionKey,
    moduleKey: outstationExpenseWorkflowModuleKey,
    role: input.access.role,
    status: workflowStatus,
  });

  if (input.expectedNextStatus && transition.nextStatus !== input.expectedNextStatus) {
    throw new WorkflowRegistryTransitionError({
      actionKey: input.actionKey,
      message:
        `Workflow Registry blocked ${outstationExpenseWorkflowModuleKey}.${input.actionKey}: ` +
        `expected next status "${input.expectedNextStatus}" but registry points to "${transition.nextStatus}".`,
      moduleKey: outstationExpenseWorkflowModuleKey,
      reason: "workflow_next_status_mismatch",
      status: workflowStatus,
    });
  }

  return transition;
}
