import type { MarketingRequestApprovalStep } from "@/lib/marketing-requests/types";

// ─────────────────────────────────────────────────────────────────────────────
// What a RESUBMIT does to the approvals a returned request already holds.
//
// A returned request used to resume at the rung that returned it, with every earlier approval kept,
// whatever the requester had changed. So a request approved by the District Manager at EGP 5,000
// could be returned by the Regional Manager, edited to EGP 50,000 aimed at a different customer, and
// resumed one rung up - the District Manager's "yes" now covering money and a customer he never saw.
//
// Owner decision, 2026-10-14, asked in chat with the options "restart at the first approver" and
// "keep earlier approvals": a resubmit that changes the COST, the CUSTOMER or the TARGETS restarts
// the chain at the first approver. A resubmit that changes none of the three (a corrected note, a
// fixed typo) still resumes where it was returned.
//
// Pure on purpose: `resubmitReturnedMarketingRequest` reaches Supabase, so a test could otherwise
// only assert over source text.
// ─────────────────────────────────────────────────────────────────────────────

export type ResubmitBasisTarget = {
  distributorCodeId: string | null;
  pharmacyId: string;
};

/** The three things an earlier approval was given ON. */
export type ResubmitBasis = {
  customerId: string;
  estimatedCost: number;
  targets: ReadonlyArray<ResubmitBasisTarget>;
};

export type ResubmitBasisChange = "cost" | "customer" | "targets";

/** A half-piastre: costs are stored to two decimals, so anything smaller is float noise. */
const COST_TOLERANCE = 0.005;

function targetKey(target: ResubmitBasisTarget): string {
  return `${String(target.pharmacyId).trim().toLowerCase()}|${String(target.distributorCodeId ?? "").trim().toLowerCase()}`;
}

/** Which of the three approval-basis facts differ between what was approved and what is resubmitted. */
export function resubmitBasisChanges(before: ResubmitBasis, after: ResubmitBasis): ResubmitBasisChange[] {
  const changes: ResubmitBasisChange[] = [];
  if (String(before.customerId).trim().toLowerCase() !== String(after.customerId).trim().toLowerCase()) {
    changes.push("customer");
  }
  if (Math.abs(Number(before.estimatedCost) - Number(after.estimatedCost)) > COST_TOLERANCE) {
    changes.push("cost");
  }
  const beforeKeys = new Set(before.targets.map(targetKey));
  const afterKeys = new Set(after.targets.map(targetKey));
  const sameTargets = beforeKeys.size === afterKeys.size && [...afterKeys].every((key) => beforeKeys.has(key));
  if (!sameTargets) changes.push("targets");
  return changes;
}

export function resubmitRestartsApprovals(before: ResubmitBasis, after: ResubmitBasis): boolean {
  return resubmitBasisChanges(before, after).length > 0;
}

export type RestartedStepPlan = {
  stepId: string;
  /** The rung that opens - the first real gate - is `current`; every other gate waits as `pending`. */
  status: "current" | "pending";
};

type PlannableStep = Pick<
  MarketingRequestApprovalStep,
  "decisionAt" | "decisionByHrId" | "decisionNote" | "id" | "isCc" | "sequence" | "status"
>;

/**
 * Put the chain back to its starting position: the first real gate `current`, every later real gate
 * `pending`, every earlier decision cleared. Returns ONLY the rungs that have to change.
 *
 * CC rows and a skipped self-approval rung are not gates and are never touched - the self-approval
 * rung is `skipped` WITH a note saying why, and re-opening it would park the request on a rung its
 * own assignee is forbidden to decide (the deadlock `isRungClosedOutByRefusal` documents).
 */
export function planRestartedApprovalSteps(steps: ReadonlyArray<PlannableStep>): RestartedStepPlan[] {
  const gates = steps
    .filter((step) => !step.isCc && step.status !== "skipped")
    .sort((left, right) => left.sequence - right.sequence);
  const plan: RestartedStepPlan[] = [];
  gates.forEach((step, index) => {
    const target: RestartedStepPlan["status"] = index === 0 ? "current" : "pending";
    const carriesDecision = Boolean(step.decisionAt || step.decisionByHrId || String(step.decisionNote ?? "").trim());
    if (step.status === target && !carriesDecision) return;
    plan.push({ status: target, stepId: step.id });
  });
  return plan;
}
