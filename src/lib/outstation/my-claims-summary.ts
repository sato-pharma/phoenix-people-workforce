import { payableExpenseAmount } from "@/lib/outstation/payable";

// The three cards above "My claims" (Submit Expense). Display only: what a claim pays is decided by
// payableExpenseAmount, the same rule payroll reads, and nothing here changes it.

export type MyClaimForSummary = {
  claimedTotalAmount: number;
  decision: { approvedAmount: number | null; hrApproved: boolean | null } | null;
  isPayrollEligible: boolean;
  status: string;
};

/**
 * The one test for "this claim passed validation", shared by the row's Validation stage and the
 * Validated card so the two can never disagree. HR passes a claim by approving it (hr_approved) or
 * by typing a different amount (approved_amount); a claim approved as claimed carries NO approved
 * amount, because the claim stands. The card used to count only the approved amount, so three claims
 * that each read "Passed validation · now In payroll" sat under a card saying "Nothing decided yet".
 */
export function isPassedValidation(claim: Pick<MyClaimForSummary, "decision" | "status">): boolean {
  if (claim.status.toLowerCase().includes("reject")) return false;
  const decision = claim.decision;
  if (!decision) return false;
  return decision.hrApproved === true || (decision.approvedAmount !== null && decision.approvedAmount !== undefined);
}

export type MyClaimsSummary = {
  /** Claims still held by the payroll gate — evidence or CRM workload missing. */
  awaiting: number;
  claimed: number;
  /** Claims that passed validation. */
  validatedCount: number;
  /** What the validated claims pay: the approved amount where HR changed it, the claim where not. */
  validatedAmount: number;
};

export function summarizeMyClaims(claims: readonly MyClaimForSummary[]): MyClaimsSummary {
  let claimed = 0;
  let validatedAmount = 0;
  let validatedCount = 0;
  let awaiting = 0;
  for (const claim of claims) {
    claimed += claim.claimedTotalAmount;
    if (isPassedValidation(claim)) {
      validatedCount += 1;
      validatedAmount += payableExpenseAmount(claim.decision?.approvedAmount, claim.claimedTotalAmount);
    }
    if (!claim.isPayrollEligible) awaiting += 1;
  }
  return { awaiting, claimed, validatedAmount, validatedCount };
}

/** "1 claim", "3 claims". */
export function claimsLabel(count: number): string {
  return `${count} ${count === 1 ? "claim" : "claims"}`;
}
