import { classifyOrganogramStructureLevel } from "@/lib/reports/organogram-safety";
import type {
  VacationActionAvailability,
  VacationApprovalStepState,
  VacationApprovalStepStatus,
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
  if (stepKey === "manager_level_3") return 3;
  return 4; // hr — rows written before the third management level keep their stored order 3
}

/** Conceptual generic identity used in code/API/UI (DB keeps the existing generic step keys). */
export function genericStepName(stepKey: VacationWorkflowStepKey): VacationGenericStepName {
  if (stepKey === "direct_manager") return "management_approval_1";
  if (stepKey === "manager_of_manager") return "management_approval_2";
  if (stepKey === "manager_level_3") return "management_approval_3";
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

/**
 * Whether the request has ONE approval only: the HR step (owner rule, 2026-11-08 — "all the HR team
 * leave, vacations and excuses have one only approval, me first and final").
 *
 * True when the requester's direct manager is himself an HR-step approver (the Super Admin). The HR
 * team reports to the HR Manager, so their chain was HR Manager -> CEO -> HR Manager again; it is now
 * the HR step alone, first and final, every leave type. Derived from the reporting line, never from a
 * list of HR ids, so a new HR hire who reports to him gets it with no code change. Excuses already
 * have one step, the direct manager, so they need nothing here.
 */
export function isHrApproverDirectReport(input: {
  directManagerHrId: string | null | undefined;
  hrApproverHrIds: Array<string | null | undefined>;
}): boolean {
  const key = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();
  const manager = key(input.directManagerHrId);
  if (!manager) return false;
  return input.hrApproverHrIds.some((hrId) => key(hrId) === manager);
}

/** A chain with no management step at all — the HR step is the one and final approval. */
export function isHrOnlyChain(steps: Array<{ stepKey: VacationWorkflowStepKey }>): boolean {
  return steps.length > 0 && steps.every((step) => step.stepKey === "hr");
}

/**
 * Whether the request gets a THIRD management approval step (owner rule, 2026-10-08).
 *
 * The field ladder is Medical Rep -> District Manager -> Regional Manager (when there is one) ->
 * National Sales Manager -> HR acknowledgement. Two management steps cannot hold that when a
 * Regional Manager sits between the District Manager and the NSM: the chain stopped at the Regional
 * Manager and the NSM never saw the request (6 active Medical Reps, measured 2026-10-08).
 *
 * The third step exists ONLY to reach the NSM, so it is included when the second approver is on the
 * ladder but is not the NSM yet, and the person above them IS the NSM. It never reaches the CEO: a
 * third approver who is not the NSM is not added.
 */
export function shouldIncludeThirdManagementStep(input: {
  managerOfManager: VacationApproverIdentity | null | undefined;
  includesManagerOfManagerStep: boolean;
  thirdManager: VacationApproverIdentity | null | undefined;
}): boolean {
  const { managerOfManager, includesManagerOfManagerStep, thirdManager } = input;
  if (!includesManagerOfManagerStep || !managerOfManager?.hrId || !thirdManager?.hrId) return false;
  if (classifyOrganogramStructureLevel(managerOfManager) === "nsm") return false;
  return classifyOrganogramStructureLevel(thirdManager) === "nsm";
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
    // HR may send a request back for the employee to edit at any time, like a rejection — it decides
    // nothing, so it is never final (owner, 2026-10-08: return for edit on every approval, any type).
    if (decision === "return") {
      return { allowed: true, reason: null, nextStatus: "returned", isFinal: false };
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

/**
 * The stalled-approver override (owner instruction, 2026-09-10).
 *
 * A management approver who has not answered for this many days can have their step decided by a
 * Super Admin instead. Counted in FLAT CALENDAR DAYS at the owner's explicit choice — weekends and
 * public holidays included — not in the business days the SLA reminder uses. The two clocks are
 * deliberately different and must not be merged: the SLA one nags the approver, this one takes the
 * decision away from them, so the owner wanted the second to be the one nobody has to compute.
 */
export const ADMIN_OVERRIDE_STALL_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A step as the override rule needs to see it — `createdAt` is what the SLA status never carries. */
export type VacationOverrideStep = {
  createdAt: string | null;
  decidedAt: string | null;
  order: number;
  status: VacationApprovalStepStatus;
  stepKey: VacationWorkflowStepKey;
};

export type AdminOverrideEvaluation = {
  available: boolean;
  availableAt: string | null;
  daysPending: number;
  reason: string | null;
  step: VacationOverrideStep | null;
};

/**
 * When the active step actually became its approver's to answer.
 *
 * NOT the request's creation time. On a two-management-step chain the second approver's wait
 * starts when the FIRST one approved, so keying the clock off the request would hand step 2 an
 * already-expired timer the moment step 1 cleared — an override available against someone who has
 * had the request for ten seconds. (This is exactly how the SLA `stageStart` behaves, which is why
 * this rule does not reuse it.) Falls back to the step row's own creation time for step 1.
 */
export function resolveStepActivatedAt(input: {
  activeStep: Pick<VacationOverrideStep, "createdAt" | "order">;
  steps: VacationOverrideStep[];
}): string | null {
  const priorDecisions = input.steps
    .filter((step) => step.order < input.activeStep.order && step.decidedAt)
    .map((step) => step.decidedAt as string)
    .sort();
  return priorDecisions.at(-1) ?? input.activeStep.createdAt ?? null;
}

function unavailable(reason: string, extra?: Partial<AdminOverrideEvaluation>): AdminOverrideEvaluation {
  return { available: false, availableAt: null, daysPending: 0, reason, step: null, ...extra };
}

/**
 * Whether a Super Admin may decide the currently active MANAGEMENT step in its approver's place.
 *
 * Management steps only. The HR step is never overridable — HR is the Super Admin, so an override
 * there would be a self-override, and the sequencing in evaluateStepAction already holds it until
 * management is done. Never on the actor's own request.
 */
export function evaluateAdminOverride(input: {
  isAdminActor: boolean;
  isOwnRequest: boolean;
  now: Date;
  status: VacationRequestStatus;
  steps: VacationOverrideStep[];
}): AdminOverrideEvaluation {
  if (!input.isAdminActor) {
    return unavailable("Only the System Administrator can respond on an unanswered request.");
  }
  if (input.isOwnRequest) {
    return unavailable("The approval cannot transfer to you on your own request.");
  }
  if (input.status === "pending_hr") {
    return unavailable("Management has already responded — this request is waiting on HR acknowledgement.");
  }
  if (input.status !== "pending_manager") {
    return unavailable("This request is not waiting on a management response.");
  }

  const active = resolveActiveStep(
    input.steps.map((step) => ({ order: step.order, status: step.status, stepKey: step.stepKey })),
  );
  if (!active || !isManagementStep(active.stepKey)) {
    return unavailable("This request is not waiting on a management response.");
  }
  const activeStep = input.steps.find(
    (step) => step.order === active.order && step.stepKey === active.stepKey,
  );
  if (!activeStep) return unavailable("This request is not waiting on a management response.");

  const activatedAt = resolveStepActivatedAt({ activeStep, steps: input.steps });
  const activatedMs = activatedAt ? Date.parse(activatedAt) : Number.NaN;
  if (!Number.isFinite(activatedMs)) {
    // Fail CLOSED. An unreadable start time means the wait cannot be measured, and an override
    // offered on an unmeasured wait is the one outcome worse than no override at all.
    return unavailable("The start of this wait is unreadable, so its length cannot be measured.", {
      step: activeStep,
    });
  }

  const availableAt = new Date(activatedMs + ADMIN_OVERRIDE_STALL_DAYS * MS_PER_DAY).toISOString();
  const daysPending = Math.max(0, (input.now.getTime() - activatedMs) / MS_PER_DAY);
  const rounded = Math.round(daysPending * 100) / 100;

  if (input.now.getTime() < activatedMs + ADMIN_OVERRIDE_STALL_DAYS * MS_PER_DAY) {
    return {
      available: false,
      availableAt,
      daysPending: rounded,
      reason: `Awaiting a response for ${rounded} of the ${ADMIN_OVERRIDE_STALL_DAYS} days after which the approval transfers to the System Administrator.`,
      step: activeStep,
    };
  }

  return { available: true, availableAt, daysPending: rounded, reason: null, step: activeStep };
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
    // An HR-team request has no management step to have approved it — the HR step is its one approval.
    if (input.steps && isHrOnlyChain(input.steps)) return "Waiting for HR Manager Approval";
    return sequential ? "Approved by Management - Pending HR Acknowledgement" : "Pending HR";
  }

  // pending_manager
  if (input.steps && isHrOnlyChain(input.steps)) return "Waiting for HR Manager Approval";
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
  /** Server verdict from evaluateAdminOverride. Omitted means "not offered". */
  override?: AdminOverrideEvaluation | null;
}): VacationActionAvailability {
  // The override flags are merged at the single exit rather than written into each of the four
  // literals below. An exhaustive Record does NOT gate this build (next.config ignoreBuildErrors),
  // so a branch that forgot a key would compile, deploy, and silently drop the button on exactly
  // the terminal/returned paths nobody tests. One merge point cannot forget.
  const override = input.override ?? null;
  const overrideFlag = override?.available
    ? { enabled: true, disabledReason: null }
    : { enabled: false, disabledReason: override?.reason ?? DISABLED_NO_TRANSFER };
  const base = resolveBaseActionAvailability(input);
  return { ...base, overrideApprove: overrideFlag, overrideReject: overrideFlag };
}

const DISABLED_NO_TRANSFER = "Only the System Administrator can respond on an unanswered request.";

type BaseActionAvailability = Omit<VacationActionAvailability, "overrideApprove" | "overrideReject">;

function resolveBaseActionAvailability(input: {
  status: VacationRequestStatus;
  steps: VacationApprovalStepState[];
  actorStep: { stepKey: VacationWorkflowStepKey; order: number } | null;
  isHrActor: boolean;
}): BaseActionAvailability {
  const terminal = input.status === "approved" || input.status === "rejected" || input.status === "returned";
  const disabledTerminal = { enabled: false, disabledReason: "This request is already closed." };
  const disabledReturned = { enabled: false, disabledReason: "Waiting for the employee to resubmit." };

  const availability: BaseActionAvailability = {
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
    // HR may reject or return for edit at any time; acknowledge only after management approvals.
    availability.reject = { enabled: true, disabledReason: null };
    availability.return = { enabled: true, disabledReason: null };
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

/**
 * Whose turn a viewer has on an open SICK leave — the one type on the legacy parallel flow, where
 * the managers and HR decide side by side and the status stays `pending_manager` for all of them.
 *
 * The same rule `getPendingVacationApprovalStepForActor` applies when the decision is posted: the
 * viewer's own pending step first (HR when it is an HR step, management otherwise), then — for an
 * HR authority actor — any pending HR step, since HR is one authority across its fanned-out rows.
 * Null: nothing pending is this viewer's to decide.
 */
export function sickLeaveTurnForViewer(input: {
  isHrActor: boolean;
  pendingSteps: Array<{ matchesViewer: boolean; stepKey: VacationWorkflowStepKey }>;
}): "management" | "hr" | null {
  const own = input.pendingSteps.find((step) => step.matchesViewer);
  if (own) return own.stepKey === "hr" ? "hr" : "management";
  if (input.isHrActor && input.pendingSteps.some((step) => step.stepKey === "hr")) return "hr";
  return null;
}
