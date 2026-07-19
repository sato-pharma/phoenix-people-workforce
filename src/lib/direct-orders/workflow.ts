import type { AccessContext } from "@/lib/auth/permissions";
import { assertWorkflowRegistryRuntimeTransition } from "@/lib/workflow-registry/runtime";
import type { DirectOrderDecision, DirectOrderStatus } from "@/lib/direct-orders/types";

// Workflow-registry governance layer for direct orders. The row is seeded in
// migration 20260718140000_direct_orders_module_foundation.sql. This is a coarse
// role/status gate on top of the fine per-step approver binding in the service and
// the pure sequencing in approval-flow.ts — belts and suspenders, mirroring vacation.

export const directOrderWorkflowRegistryModuleKey = "direct_orders";

export type DirectOrderWorkflowActionKey =
  | "submit"
  | "approve_intermediate"
  | "approve_final"
  | "reject"
  | "return"
  | "reverse";

/** Map a request status to the registry status vocabulary (identical here — kept explicit for safety). */
export function toDirectOrderWorkflowStatus(status: DirectOrderStatus | string | null | undefined): string {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized || "draft";
}

/** Resolve the registry action + expected next status for a decision on the active step. */
export function directOrderDecisionAction(input: {
  decision: DirectOrderDecision;
  isFinal: boolean;
}): { actionKey: DirectOrderWorkflowActionKey; expectedNextStatus: string } {
  if (input.decision === "return") {
    return { actionKey: "return", expectedNextStatus: "returned" };
  }
  if (input.decision === "reject") {
    return { actionKey: "reject", expectedNextStatus: "rejected" };
  }
  // approve
  return input.isFinal
    ? { actionKey: "approve_final", expectedNextStatus: "approved" }
    : { actionKey: "approve_intermediate", expectedNextStatus: "pending_approval" };
}

export async function assertDirectOrderWorkflowTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: DirectOrderWorkflowActionKey;
  expectedNextStatus?: string;
  status: DirectOrderStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access,
    actionKey: input.actionKey,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: directOrderWorkflowRegistryModuleKey,
    status: toDirectOrderWorkflowStatus(input.status),
  });
}
