// Weekly Planning workflow status machine. No DB writes.

import type { WeeklyPlanApprovalRole, WeeklyPlanStatus } from "./types.ts";
import { WEEKLY_PLAN_ELIGIBLE_JOB_TITLES, weeklyPlanStatuses } from "./types.ts";

export const WEEKLY_PLAN_STATUSES: readonly WeeklyPlanStatus[] = weeklyPlanStatuses;

export const WEEKLY_PLAN_TERMINAL_STATUSES: readonly string[] = ["final_approved", "cancelled"];

export type WeeklyPlanAction =
  | "submit"
  | "manager_approve"
  | "manager_return"
  | "ceo_approve"
  | "ceo_return"
  | "finalize"
  | "cancel";

export const weeklyPlanActions = [
  "submit",
  "manager_approve",
  "manager_return",
  "ceo_approve",
  "ceo_return",
  "finalize",
  "cancel",
] as const satisfies readonly WeeklyPlanAction[];

type TransitionDef = {
  from: WeeklyPlanStatus[];
  to: WeeklyPlanStatus;
  requiresReason: boolean;
  requiresApprovalRole?: WeeklyPlanApprovalRole;
};

export const WEEKLY_PLAN_TRANSITIONS: Record<WeeklyPlanAction, TransitionDef> = {
  submit: {
    from: ["draft", "manager_returned", "ceo_returned"],
    to: "submitted",
    requiresReason: false,
  },
  manager_approve: {
    from: ["submitted"],
    to: "manager_approved",
    requiresReason: false,
    requiresApprovalRole: "manager",
  },
  manager_return: {
    from: ["submitted"],
    to: "manager_returned",
    requiresReason: true,
    requiresApprovalRole: "manager",
  },
  ceo_approve: {
    from: ["manager_approved"],
    to: "ceo_approved",
    requiresReason: false,
    requiresApprovalRole: "ceo",
  },
  ceo_return: {
    from: ["manager_approved"],
    to: "ceo_returned",
    requiresReason: true,
    requiresApprovalRole: "ceo",
  },
  finalize: {
    from: ["ceo_approved"],
    to: "final_approved",
    requiresReason: false,
  },
  cancel: {
    from: ["draft", "submitted", "manager_returned", "ceo_returned"],
    to: "cancelled",
    requiresReason: false,
  },
};

export class WeeklyPlanWorkflowError extends Error {
  code: "INVALID_TRANSITION" | "REASON_REQUIRED" | "TERMINAL_STATUS";

  constructor(code: "INVALID_TRANSITION" | "REASON_REQUIRED" | "TERMINAL_STATUS", message: string) {
    super(message);
    this.name = "WeeklyPlanWorkflowError";
    this.code = code;
  }
}

/**
 * Assert that a state machine transition is valid.
 * Throws WeeklyPlanWorkflowError on failure.
 * Returns void on success.
 */
export function assertWeeklyPlanTransition(
  currentStatus: WeeklyPlanStatus,
  action: WeeklyPlanAction,
  options?: { reason?: string },
): void {
  if (WEEKLY_PLAN_TERMINAL_STATUSES.includes(currentStatus)) {
    throw new WeeklyPlanWorkflowError(
      "TERMINAL_STATUS",
      `Plan is in a terminal status '${currentStatus}' and cannot be transitioned.`,
    );
  }

  const transition = WEEKLY_PLAN_TRANSITIONS[action];
  if (!transition.from.includes(currentStatus)) {
    throw new WeeklyPlanWorkflowError(
      "INVALID_TRANSITION",
      `Action '${action}' is not allowed from status '${currentStatus}'. Allowed from: [${transition.from.join(", ")}].`,
    );
  }

  if (transition.requiresReason && (!options?.reason || options.reason.trim() === "")) {
    throw new WeeklyPlanWorkflowError(
      "REASON_REQUIRED",
      `Action '${action}' requires a reason to be provided.`,
    );
  }
}

/**
 * Get the next status for a structurally valid transition.
 * Throws WeeklyPlanWorkflowError if the action is not allowed from the current
 * status, or if the status is terminal. Does NOT enforce reason requirements —
 * use assertWeeklyPlanTransition for full business rule enforcement.
 */
export function getNextStatus(currentStatus: WeeklyPlanStatus, action: WeeklyPlanAction): WeeklyPlanStatus {
  if (WEEKLY_PLAN_TERMINAL_STATUSES.includes(currentStatus)) {
    throw new WeeklyPlanWorkflowError(
      "TERMINAL_STATUS",
      `Plan is in a terminal status '${currentStatus}' and cannot be transitioned.`,
    );
  }

  const transition = WEEKLY_PLAN_TRANSITIONS[action];
  if (!transition.from.includes(currentStatus)) {
    throw new WeeklyPlanWorkflowError(
      "INVALID_TRANSITION",
      `Action '${action}' is not allowed from status '${currentStatus}'. Allowed from: [${transition.from.join(", ")}].`,
    );
  }

  return transition.to;
}

/**
 * Check if a status is terminal (no further transitions possible).
 */
export function isTerminalStatus(status: WeeklyPlanStatus): boolean {
  return WEEKLY_PLAN_TERMINAL_STATUSES.includes(status);
}

/**
 * Check if a job title is eligible for weekly planning (v1 eligible list).
 * Comparison is case-insensitive with whitespace trimmed.
 */
export function isEligibleJobTitle(jobTitle: string): boolean {
  const normalized = jobTitle.trim().toLowerCase();
  return WEEKLY_PLAN_ELIGIBLE_JOB_TITLES.some((t) => t.toLowerCase() === normalized);
}
