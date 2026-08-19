import { classifyOrganogramStructureLevel } from "@/lib/reports/organogram-safety";
import type {
  VacationActionAvailability,
  VacationApprovalStepState,
  VacationDecision,
  VacationGenericStepName,
  VacationRequestStatus,
  VacationType,
  VacationWorkflowStepKey,
} from "@/lib/vacation/types";

/**
 * Pure, database-free decision core for the sequential vacation approval workflow.
 *
 * Scope: the sequential flow applies to `annual`, `other`, `compensatory`, and `emergency`.
 * Only `sick` keeps the legacy parallel flow (see service.ts) and must not be routed
 * through these helpers. HR is an ACKNOWLEDGEMENT/RECORDING step — never "final
 * approval" — and may reject at any time with a mandatory reason.
 */

const SEQUENTIAL_WORKFLOW_TYPES = new Set<VacationType>(["annual", "other", "compensatory", "emergency"]);

export function isSequentialWorkflowType(type: VacationType | string | null | undefined): boolean {
  return SEQUENTIAL_WORKFLOW_TYPES.has(String(type ?? "").trim() as VacationType);
}

export function stepOrderForStepKey(stepKey: VacationWorkflowStepKey): number {
  if (stepKey === "direct_manager") return 1;
  if (stepKey === "manager_of_manager") return 2;
  return 3; // hr
}

/** Conceptual generic identity used in code/API/UI (DB keeps the existing generic step keys). */
export function genericStepName(stepKey: VacationWorkflowStepKey): VacationGenericStepName {
  if (stepKey === "direct_manager") return "management_approval_1";
  if (stepKey === "manager_of_manager") return "management_approval_2";
  return "hr_acknowledgement";
}

export function isManagementStep(stepKey: VacationWorkflowStepKey): boolean {
  return stepKey !== "hr";
}

/** Minimum identity needed to decide whether a second approver may be dropped. */
export type VacationApproverIdentity = {
  hrId?: string | null;
  jobTitle: string | null;
  positionTitle: string | null;
};

/**
 * Whether the request gets the second management (manager-of-manager) approval step.
 *
 * Owner rule (2026-08-15, corrected 2026-08-19): a District Manager's approval chain must never
 * include the CEO — and must never skip the National Sales Manager either.
 *
 * #2149 implemented only the first half, by dropping the second management step for every
 * District Manager. That is correct for the DMs who report straight to the NSM: their second
 * step WAS the CEO. For the DMs who report through a Regional Sales Manager it dropped the NSM
 * instead, so those requests ran Regional Manager -> HR (observed live on B-74, 16 and 19 Aug
 * 2026). Whether the step survives therefore depends on WHO the second approver is, not on the
 * requester's role alone: a District Manager keeps it only when that person is the National
 * Sales Manager. Every other role keeps the step whenever a manager-of-manager exists.
 */
export function shouldIncludeManagerOfManagerStep(input: {
  managerOfManager: VacationApproverIdentity | null | undefined;
  requesterRole: string;
}): boolean {
  const { managerOfManager, requesterRole } = input;
  if (!managerOfManager?.hrId) return false;
  if (requesterRole !== "District Manager") return true;
  return classifyOrganogramStructureLevel(managerOfManager) === "nsm";
}

function managementSteps(steps: VacationApprovalStepState[]): VacationApprovalStepState[] {
  return steps.filter((step) => isManagementStep(step.stepKey)).sort((a, b) => a.order - b.order);
}

function hrStep(steps: VacationApprovalStepState[]): VacationApprovalStepState | null {
  return steps.find((step) => step.stepKey === "hr") ?? null;
}

/**
 * The step that is currently actionable: the lowest-order still-pending management step, or
 * the HR step once all management steps are approved. Returns null when nothing is pending.
 */
export function resolveActiveStep(steps: VacationApprovalStepState[]): VacationApprovalStepState | null {
  const pendingManagement = managementSteps(steps).find((step) => step.status === "pending");
  if (pendingManagement) return pendingManagement;
  const hr = hrStep(steps);
  if (hr && hr.status === "pending") return hr;
  return null;
}

export type StepActionEvaluation = {
  allowed: boolean;
  reason: string | null;
  nextStatus: VacationRequestStatus;
  isFinal: boolean;
};

/**
 * Decide whether `actorStep` may take `decision` right now, and what the resulting request
 * status is. Sequencing rules:
 *  - A management step is actionable only after every lower-order management step is approved.
 *  - Approving the last management step hands off to HR (`pending_hr`); if no HR step exists it
 *    finalizes as `approved`.
 *  - HR may REJECT at any time (overrides prior approvals → `rejected`).
 *  - HR may ACKNOWLEDGE (approve) only after all management approvals are complete → `approved`.
 *  - Any rejection is final.
 */
export function evaluateStepAction(input: {
  steps: VacationApprovalStepState[];
  actorStep: { stepKey: VacationWorkflowStepKey; order: number };
  decision: VacationDecision;
}): StepActionEvaluation {
  const { steps, actorStep, decision } = input;
  const mgmt = managementSteps(steps);
  const allManagementApproved = mgmt.every((step) => step.status === "approved");

  if (actorStep.stepKey === "hr") {
    if (decision === "return") {
      return { allowed: false, reason: "HR cannot return requests to the employee.", nextStatus: "pending_hr", isFinal: false };
    }
    if (decision === "reject") {
      return { allowed: true, reason: null, nextStatus: "rejected", isFinal: true };
    }
    if (!allManagementApproved) {
      return {
        allowed: false,
        reason: "Available after management approvals are completed.",
        nextStatus: "pending_hr",
        isFinal: false,
      };
    }
    return { allowed: true, reason: null, nextStatus: "approved", isFinal: true };
  }

  // Management step — must be the active (lowest-order pending) step.
  const blockedByPrior = mgmt.some((step) => step.order < actorStep.order && step.status !== "approved");
  if (blockedByPrior) {
    return {
      allowed: false,
      reason: "Available after the previous management approval is completed.",
      nextStatus: "pending_manager",
      isFinal: false,
    };
  }

  if (decision === "return") {
    return { allowed: true, reason: null, nextStatus: "returned", isFinal: false };
  }

  if (decision === "reject") {
    return { allowed: true, reason: null, nextStatus: "rejected", isFinal: true };
  }

  const laterManagementPending = mgmt.some((step) => step.order > actorStep.order && step.status === "pending");
  if (laterManagementPending) {
    return { allowed: true, reason: null, nextStatus: "pending_manager", isFinal: false };
  }

  // Last management approval.
  if (hrStep(steps)) {
    return { allowed: true, reason: null, nextStatus: "pending_hr", isFinal: false };
  }
  return { allowed: true, reason: null, nextStatus: "approved", isFinal: true };
}

const HR_ACKNOWLEDGEMENT_LABEL = "HR Acknowledgement";

export function genericStepLabel(stepKey: VacationWorkflowStepKey, approverTitle?: string | null): string {
  if (stepKey === "hr") return HR_ACKNOWLEDGEMENT_LABEL;
  const title = (approverTitle ?? "").trim();
  return title ? `${title} Approval` : "Management Approval";
}

/**
 * Dynamic, role-aware stage label for tracking/timeline. `titles` maps each step key to the
 * actual assigned approver's job title so the UI never hardcodes DSM/RSM/NSM.
 */
export function resolveStageLabel(input: {
  status: VacationRequestStatus;
  vacationType: VacationType;
  steps?: VacationApprovalStepState[];
  titles?: Partial<Record<VacationWorkflowStepKey, string | null>>;
}): string {
  const sequential = isSequentialWorkflowType(input.vacationType);
  const titleFor = (key: VacationWorkflowStepKey) => (input.titles?.[key] ?? "").trim();

  if (input.status === "needs_assignment") return "Needs HR Assignment";

  if (input.status === "returned") return "Returned to Employee";

  if (input.status === "rejected") {
    const rejected = (input.steps ?? []).find((step) => step.status === "rejected");
    if (!rejected) return "Rejected";
    if (rejected.stepKey === "hr") return "Rejected by HR";
    const title = titleFor(rejected.stepKey);
    return title ? `Rejected by ${title}` : "Rejected by Management";
  }

  if (input.status === "approved") return sequential ? "Recorded by HR" : "Approved";

  if (input.status === "pending_hr") {
    return sequential ? "Approved by Management - Pending HR Acknowledgement" : "Pending HR";
  }

  // pending_manager
  if (sequential && input.steps && input.steps.length > 0) {
    const active = resolveActiveStep(input.steps);
    if (active && active.stepKey !== "hr") {
      const title = titleFor(active.stepKey);
      return title ? `Waiting for ${title} Approval` : "Waiting for Management Approval";
    }
    if (active && active.stepKey === "hr") {
      return "Approved by Management - Pending HR Acknowledgement";
    }
  }
  return "Waiting for Management Approval";
}

const DISABLED_NOT_ASSIGNED = "Only the assigned approver can take this action.";

/**
 * Per-button availability for the Action Center. `actorStep` is the caller's own pending step
 * (null if they are not an assigned approver of a pending step). `isHrActor` is true for the HR
 * acknowledgement users (who may reject any stage and assign on a Needs-HR-Assignment request).
 */
export function resolveActionAvailability(input: {
  status: VacationRequestStatus;
  steps: VacationApprovalStepState[];
  actorStep: { stepKey: VacationWorkflowStepKey; order: number } | null;
  isHrActor: boolean;
}): VacationActionAvailability {
  const terminal = input.status === "approved" || input.status === "rejected" || input.status === "returned";
  const disabledTerminal = { enabled: false, disabledReason: "This request is already closed." };
  const disabledReturned = { enabled: false, disabledReason: "Waiting for the employee to resubmit." };

  const availability: VacationActionAvailability = {
    approve: { enabled: false, disabledReason: DISABLED_NOT_ASSIGNED },
    reject: { enabled: false, disabledReason: DISABLED_NOT_ASSIGNED },
    acknowledge: { enabled: false, disabledReason: DISABLED_NOT_ASSIGNED },
    assign: { enabled: false, disabledReason: "Only HR can assign an approver." },
    return: { enabled: false, disabledReason: DISABLED_NOT_ASSIGNED },
  };

  if (input.status === "returned") {
    return {
      approve: disabledReturned,
      reject: disabledReturned,
      acknowledge: disabledReturned,
      assign: disabledReturned,
      return: disabledReturned,
    };
  }

  if (terminal) {
    return {
      approve: disabledTerminal,
      reject: disabledTerminal,
      acknowledge: disabledTerminal,
      assign: disabledTerminal,
      return: disabledTerminal,
    };
  }

  // Needs-HR-Assignment: HR assigns the first management approver; HR may also reject outright.
  if (input.status === "needs_assignment") {
    availability.assign = input.isHrActor
      ? { enabled: true, disabledReason: null }
      : { enabled: false, disabledReason: "Only HR can assign an approver." };
    if (input.isHrActor && input.actorStep?.stepKey === "hr") {
      availability.reject = { enabled: true, disabledReason: null };
    }
    availability.return = { enabled: false, disabledReason: "Cannot return a request that has not been assigned yet." };
    return availability;
  }

  if (!input.actorStep) return availability;

  if (input.actorStep.stepKey === "hr") {
    // HR may reject at any time; acknowledge only after management approvals; cannot return.
    availability.reject = { enabled: true, disabledReason: null };
    availability.return = { enabled: false, disabledReason: "HR cannot return requests to the employee." };
    const ack = evaluateStepAction({ steps: input.steps, actorStep: input.actorStep, decision: "approve" });
    availability.acknowledge = ack.allowed
      ? { enabled: true, disabledReason: null }
      : { enabled: false, disabledReason: ack.reason };
    return availability;
  }

  // Management step.
  const approveEval = evaluateStepAction({ steps: input.steps, actorStep: input.actorStep, decision: "approve" });
  availability.approve = approveEval.allowed
    ? { enabled: true, disabledReason: null }
    : { enabled: false, disabledReason: approveEval.reason };
  availability.reject = approveEval.allowed
    ? { enabled: true, disabledReason: null }
    : { enabled: false, disabledReason: approveEval.reason };
  availability.return = approveEval.allowed
    ? { enabled: true, disabledReason: null }
    : { enabled: false, disabledReason: approveEval.reason };
  return availability;
}
