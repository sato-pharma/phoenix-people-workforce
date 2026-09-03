import { roundCurrency } from "@/lib/payroll/money";

/**
 * What an outstation expense actually pays.
 *
 * `total` is what the employee claimed. `approvedAmount` is what HR approved when they changed
 * that claim. NULL/undefined means HR never adjusted it, so the claim stands — which is what
 * keeps every row written before the `approved_amount` column existed paying exactly what it
 * always paid.
 *
 * Every payroll read of an outstation expense must go through here. There are two independent
 * payout paths (the payroll template totals and the automated-payroll recommendation) plus a SQL
 * importer, and they must never disagree about what a trip is worth.
 */
export function payableExpenseAmount(
  approvedAmount: number | null | undefined,
  total: number | null | undefined,
): number {
  const claimed = Number(total);
  const claimedAmount = Number.isFinite(claimed) ? claimed : 0;

  if (approvedAmount === null || approvedAmount === undefined) return claimedAmount;

  const approved = Number(approvedAmount);
  return Number.isFinite(approved) ? approved : claimedAmount;
}

/**
 * The two ends of one decision: HR either types how much to CUT off a claim, or types what to
 * PAY, and the other figure follows. Kept here as a pure complementary pair so the two inputs can
 * never drift apart — `approved + deduction === claimed` always holds.
 *
 * Both clamp into [0, claimed]. A negative deduction is not a deduction, and outstation approval
 * exists to reduce a claim: it never pays an employee more than they asked for. A non-finite or
 * missing entry reads as "no deduction" rather than silently zeroing someone's payable amount.
 */
export function approvedAmountFromDeduction(
  claimed: number | null | undefined,
  deduction: number | null | undefined,
): number {
  const claimedAmount = Math.max(0, toFiniteAmount(claimed));
  const cut = Math.min(claimedAmount, Math.max(0, toFiniteAmount(deduction)));
  return roundCurrency(claimedAmount - cut);
}

export function deductionFromApprovedAmount(
  claimed: number | null | undefined,
  approvedAmount: number | null | undefined,
): number {
  const claimedAmount = Math.max(0, toFiniteAmount(claimed));
  const approved = Math.min(claimedAmount, Math.max(0, toFiniteAmount(approvedAmount)));
  return roundCurrency(claimedAmount - approved);
}

function toFiniteAmount(value: number | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Turns what the approvals UI submitted into what belongs in `approved_amount`.
 *
 * Returns null when HR left the claim alone, so "never adjusted" stays distinguishable from
 * "approved at exactly the claimed figure" — the column keeps meaning what the migration says it
 * means, and an untouched row is never rewritten with a redundant copy of `total`.
 *
 * Zero is a real decision (approve the trip, pay nothing) and is preserved. A negative is not a
 * payable amount and the column's check constraint rejects it, so it clamps to zero rather than
 * failing the whole batched save.
 *
 * CLAMPS AT THE CLAIM, exactly like `approvedAmountFromDeduction` and `deductionFromApprovedAmount`
 * above — outstation approval exists to REDUCE a claim and never pays more than was asked for.
 * This function is the one of the three that omitted that cap, and it is the one the approvals UI
 * writes through, so an entry above the claim was stored verbatim: `OUTSTATION-52` held 800.00
 * approved against 364.00 claimed and `OUTSTATION-99` 541.90 against 341.90. Nothing downstream
 * tolerates that — `expense_claims_approved_total_range` forbids `approved_total > claimed_total`,
 * so the hourly mirror rebuild threw on those two rows and froze all 416 claims from 2026-09-03.
 * An over-claim entry now reads as "pay the claim" (null), which is what the clamp in the sibling
 * pair already meant.
 */
export function normalizeApprovedAmount(
  approvedAmount: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (approvedAmount === null || approvedAmount === undefined) return null;

  const approved = Number(approvedAmount);
  if (!Number.isFinite(approved)) return null;
  if (approved < 0) return 0;

  const claimed = Number(total);
  const rounded = Number.isFinite(claimed)
    ? Math.min(roundCurrency(approved), roundCurrency(Math.max(0, claimed)))
    : roundCurrency(approved);
  if (Number.isFinite(claimed) && Math.abs(rounded - roundCurrency(claimed)) < 0.005) return null;

  return rounded;
}
