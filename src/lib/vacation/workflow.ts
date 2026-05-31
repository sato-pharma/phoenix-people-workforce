import type { AccessContext } from "@/lib/auth/permissions";
import { assertWorkflowRegistryRuntimeTransition } from "@/lib/workflow-registry/runtime";
import type { VacationDecision, VacationRequestStatus } from "@/lib/vacation/types";

export const leaveWorkflowRegistryModuleKey = "leave_requests";

export type LeaveWorkflowActionKey =
  | "admin_create"
  | "admin_delete"
  | "admin_update"
  | "hr_approve"
  | "hr_reject"
  | "manager_approve"
  | "manager_reject"
  | "submit";

export function toLeaveWorkflowStatus(status: VacationRequestStatus | string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized) return "draft";
  if (normalized === "pending") return "pending_manager";
  return normalized;
}

export function vacationDecisionAction(input: {
  decision: VacationDecision;
  status: VacationRequestStatus;
}): { actionKey: LeaveWorkflowActionKey; expectedNextStatus: string } {
  const decisionValue = input.decision === "approve" ? "approve" : "reject";

  if (input.status === "pending_hr") {
    return {
      actionKey: decisionValue === "approve" ? "hr_approve" : "hr_reject",
      expectedNextStatus: decisionValue === "approve" ? "approved" : "rejected",
    };
  }

  return {
    actionKey: decisionValue === "approve" ? "manager_approve" : "manager_reject",
    expectedNextStatus: "pending_hr",
  };
}

export async function assertLeaveWorkflowTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: LeaveWorkflowActionKey;
  expectedNextStatus?: string;
  status: VacationRequestStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access,
    actionKey: input.actionKey,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: leaveWorkflowRegistryModuleKey,
    status: toLeaveWorkflowStatus(input.status),
  });
}
