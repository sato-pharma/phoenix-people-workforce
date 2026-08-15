/**
 * The Cairo no-allowance rule.
 *
 * Owner rule (2026-08-15): an employee whose base is in ANY region who travels to Cairo earns
 * NO outstation per-diem allowance for that trip. Cairo is the head-office city — coming to it
 * is not an "outstation" for allowance purposes. The owner confirmed two things in-session that
 * fix the exact boundary of this rule:
 *
 *   1. "Cairo" here means the CAIRO GOVERNORATE ONLY. Giza (6th of October, Sheikh Zayed, Dokki)
 *      and Qalyubia (Benha, Shubra El-Kheima) are separate governorates and still earn an
 *      allowance — they are not folded into a "Greater Cairo".
 *   2. Only the per-diem ALLOWANCE is removed. Real transport, tickets, meeting and other costs
 *      are still paid; the rule zeroes the same-day / overnight / return-day rows, nothing else.
 *
 * This mirrors, and sits beside, the existing residence-vs-destination governorate rule in
 * service.ts: a trip inside the residence governorate is already not eligible at all; this rule
 * adds the one cross-governorate destination that still pays travel but not an allowance.
 *
 * Pure and synchronous on purpose — the same discipline the duplicate-day guard
 * (allowance-day-guard.ts) uses: this decides whether real money is paid, so it must be
 * assertable without a database. The Supabase reads that resolve the two governorates live in
 * service.ts; only the DECISION and the row transform live here.
 */
import type { OutstationAllowanceBreakdown } from "./types";

/**
 * The one destination governorate that earns no allowance for a regional employee. This is the
 * canonical name `resolveGovernorate` (@/lib/geo/egypt-locations) returns for Cairo, so both
 * sides of the compare below are canonical and a plain `===` is valid.
 */
export const CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE = "Cairo";

/** Why an allowance row was zeroed by this rule — carried on every zeroed row, never silent. */
export const CAIRO_NO_ALLOWANCE_REASON =
  "No allowance: a trip to Cairo from a regional base does not earn an outstation per-diem allowance.";

/**
 * True when this trip earns NO allowance under the Cairo rule: the destination is the Cairo
 * governorate AND the employee's residence governorate is a resolved, non-Cairo region.
 *
 * Both arguments are canonical governorate names (`resolveGovernorate` output) or null when a
 * side could not be resolved. An unresolved residence returns false — we never strip an
 * allowance on a guess. An unconfirmable residence is exactly the case the existing governorate
 * rule already holds for Super Admin review; it is not one to silently zero here.
 */
export function cairoTripEarnsNoAllowance(
  residenceGovernorate: string | null | undefined,
  destinationGovernorate: string | null | undefined,
): boolean {
  if (destinationGovernorate !== CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE) return false;
  const residence = residenceGovernorate ?? null;
  if (!residence) return false;
  return residence !== CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE;
}

/**
 * Zero every still-paying allowance row, tagging each with why. Rows already zeroed by another
 * guard (e.g. the duplicate-day guard) keep their own reason and amount — this never overwrites
 * an earlier explanation. Returns a NEW breakdown; the input is not mutated.
 *
 * `removedAmount` is what this rule took away, so a caller can tell "the rule fired and removed
 * money" from "the rule fired but every row was already zero" and avoid rebuilding a breakdown
 * that did not change.
 */
export function applyCairoNoAllowance(breakdown: OutstationAllowanceBreakdown): {
  allowanceAmount: number;
  breakdown: OutstationAllowanceBreakdown;
  removedAmount: number;
} {
  let removedAmount = 0;
  const rows = breakdown.rows.map((row) => {
    if (row.skipped || row.amount === 0) return row;
    removedAmount += row.amount;
    return {
      ...row,
      amount: 0,
      skipped: true,
      skipReason: CAIRO_NO_ALLOWANCE_REASON,
    };
  });

  return {
    // Every row is now zero (the ones this rule touched, plus any a prior guard already zeroed),
    // so the trip's allowance is zero by construction.
    allowanceAmount: 0,
    breakdown: { ...breakdown, rows } satisfies OutstationAllowanceBreakdown,
    removedAmount,
  };
}
