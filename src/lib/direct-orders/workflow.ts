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
  | "submit_held"
  | "revive_held"
  | "expire_held"
  | "cancel_held"
  // Added 2026-08-08 with migration 20260808214500_direct_orders_release_held.sql. THE UNION, THE DB
  // ROW AND THE CALL SITE MUST LAND TOGETHER — a key declared in only two of the three is audit
  // finding F2, and an action naming an undeclared status is what caused the 2026-08-05 outage.
  | "release_held"
  | "keep_held"
  // Added 2026-08-09 with migration 20260809031500_direct_orders_duplicate_cleanup.sql. Separate
  // from cancel_held because that action's audit line says the REQUESTER withdrew the request.
  // Nobody withdrew this one: the system found a duplicate and an SFE Manager confirmed it.
  | "cancel_duplicate"
  // The two doors out of the held lane. Both were DECLARED in the registry from the start and
  // neither could be gated, because this union did not list them — the type was quietly the reason
  // the module's governance layer did not cover its own most important flow (audit F2).
  | "request_pharmacy_validation"
  | "decide_pharmacy_validation"
  | "approve_intermediate"
  | "approve_final"
  | "reject"
  | "return"
  | "reverse"
  // Added 2026-08-12 with migration 20260812140000_direct_orders_repair_approval_rung.sql, and the
  // call site (reassignDirectOrderApprovalRung) landed in the same commit — the union, the DB row
  // and the caller together, per the rule three lines up that F2 was written about.
  //
  // Its 'from' and 'to' are BOTH `pending_approval`: re-addressing a rung whose approver does not
  // exist in the directory moves nothing. The order still owes the same approvals to the same
  // seats. `keep_held` set the precedent that an action worth auditing is an action worth
  // declaring, even when it does not move the status.
  | "repair_approval_rung";

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
