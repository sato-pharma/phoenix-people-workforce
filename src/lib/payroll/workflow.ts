import { PayrollConflictError } from "./errors.ts";
import type { PayrollWorkflowAction } from "./types.ts";

export type PayrollWorkflowTransition = {
  clearPart2Ready?: boolean;
  clearRejectedReason?: boolean;
  expectedStatus: string;
  nextStatus: string;
  setApproved?: boolean;
  setPart1Paid?: boolean;
  setPart2Ready?: boolean;
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
  mark_part1_paid: {
    expectedStatus: "part1_ready",
    nextStatus: "part1_paid",
    setPart1Paid: true,
  },
  mark_part1_ready: {
    expectedStatus: "uploaded",
    nextStatus: "part1_ready",
  },
  mark_part2_ready: {
    expectedStatus: "adjustments_open",
    nextStatus: "part2_ready",
    setPart2Ready: true,
  },
  mark_review: {
    expectedStatus: "part2_ready",
    nextStatus: "under_review",
  },
  open_adjustments: {
    expectedStatus: "part1_paid",
    nextStatus: "adjustments_open",
  },
  reject: {
    expectedStatus: "under_review",
    nextStatus: "rejected",
    setRejected: true,
  },
  reopen: {
    clearPart2Ready: true,
    clearRejectedReason: true,
    expectedStatus: "rejected",
    nextStatus: "adjustments_open",
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
