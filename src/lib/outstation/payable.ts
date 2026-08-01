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
 * Turns what the approvals UI submitted into what belongs in `approved_amount`.
 *
 * Returns null when HR left the claim alone, so "never adjusted" stays distinguishable from
 * "approved at exactly the claimed figure" — the column keeps meaning what the migration says it
 * means, and an untouched row is never rewritten with a redundant copy of `total`.
 *
 * Zero is a real decision (approve the trip, pay nothing) and is preserved. A negative is not a
 * payable amount and the column's check constraint rejects it, so it clamps to zero rather than
 * failing the whole batched save.
 */
export function normalizeApprovedAmount(
  approvedAmount: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (approvedAmount === null || approvedAmount === undefined) return null;

  const approved = Number(approvedAmount);
  if (!Number.isFinite(approved)) return null;
  if (approved < 0) return 0;

  const rounded = roundCurrency(approved);
  const claimed = Number(total);
  if (Number.isFinite(claimed) && Math.abs(rounded - roundCurrency(claimed)) < 0.005) return null;

  return rounded;
}
