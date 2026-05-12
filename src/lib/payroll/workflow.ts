import { PayrollConflictError } from "./errors.ts";
import type { PayrollWorkflowAction } from "./types.ts";

export type PayrollWorkflowTransition = {
  clearRejectedReason?: boolean;
  expectedStatus: string;
  nextStatus: string;
  setApproved?: boolean;
  setLocked?: boolean;
  setRejected?: boolean;
};

const payrollTransitions: Record<PayrollWorkflowAction, PayrollWorkflowTransition> = {
  approve: {
    expectedStatus: "under_review",
    nextStatus: "approved",
    setApproved: true,
  },
  lock: {
    expectedStatus: "approved",
    nextStatus: "locked",
    setLocked: true,
  },
  mark_review: {
    expectedStatus: "uploaded",
    nextStatus: "under_review",
  },
  reject: {
    expectedStatus: "under_review",
    nextStatus: "rejected",
    setRejected: true,
  },
  reopen: {
    clearRejectedReason: true,
    expectedStatus: "rejected",
    nextStatus: "uploaded",
  },
};

export function getPayrollWorkflowTransition(
  currentStatus: string,
  action: PayrollWorkflowAction,
  rejectedReason?: string,
) {
  const transition = payrollTransitions[action];

  if (!transition) {
    throw new PayrollConflictError(`Unsupported payroll workflow action: ${action}.`);
  }

  if (currentStatus === "locked") {
    throw new PayrollConflictError("Locked payroll batches cannot be changed.");
  }

  if (action === "reject" && !rejectedReason?.trim()) {
    throw new PayrollConflictError("Rejected reason is required.");
  }

  if (currentStatus !== transition.expectedStatus) {
    throw new PayrollConflictError(
      `Invalid payroll workflow transition: ${currentStatus} cannot run ${action}.`,
    );
  }

  return transition;
}
