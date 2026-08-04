import type {
  ReconciliationCheckResult,
  ReconciliationCounts,
  ReconciliationExpectation,
  ReconciliationStatus,
} from "@/lib/reconciliation/types";

/**
 * Pure comparison + formatting layer shared by every check, so "do these two numbers agree" has
 * exactly ONE definition in this module. A second copy of a rounding rule is how most of the
 * defects this harness watches for started.
 */

/**
 * Half a piastre. Both sides of a money comparison sum floats in a different order (per-employee
 * vs per-category, service-rounded vs SQL-rounded), so bit-exact equality would fire on arithmetic
 * rather than on a defect. One piastre is far below anything a human could act on and far above
 * float noise on totals in the millions.
 */
export const MONEY_TOLERANCE_EGP = 0.01;

export function moneyMatches(left: number, right: number, tolerance = MONEY_TOLERANCE_EGP): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= tolerance;
}

/**
 * Money is always rendered with both a thousands separator and two decimals, and always carries
 * its currency. A payroll figure printed as a bare "2667500" is how a reader mistakes EGP for
 * piastres; a figure printed as "0" with no context is how a failed read gets mistaken for a real
 * zero — so callers pair this with the count on the same line rather than emitting a lone total.
 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "unavailable (not a number) EGP";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  const noun = value === 1 ? singular : plural;
  return `${value.toLocaleString("en-US")} ${noun}`;
}

/** Money and membership in one phrase — a row count alone hides a wrong total, and vice versa. */
export function formatRowsAndMoney(count: number, total: number, singular = "row"): string {
  return `${formatCount(count, singular)} / ${formatMoney(total)}`;
}

export type SetDifference<T> = {
  onlyInLeft: T[];
  onlyInRight: T[];
  identical: boolean;
};

/**
 * Set comparison rather than count comparison. Two sides can hold the same NUMBER of HR_IDs and
 * still be paying different people — the payroll defect swapped membership, not just totals — so
 * every membership assertion in this module compares the identities, not the tally.
 */
export function diffSets<T>(left: Iterable<T>, right: Iterable<T>): SetDifference<T> {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const onlyInLeft = [...leftSet].filter((value) => !rightSet.has(value));
  const onlyInRight = [...rightSet].filter((value) => !leftSet.has(value));
  return { onlyInLeft, onlyInRight, identical: onlyInLeft.length === 0 && onlyInRight.length === 0 };
}

/**
 * Renders a list in full up to `limit`, then STATES the cap rather than trailing off. An ellipsis
 * hides how big the problem is; "first 10 of 46" tells the reader both what to look at and how
 * much is behind it.
 */
export function formatList(items: readonly string[], limit = 10): string {
  if (items.length === 0) return "none";
  if (items.length <= limit) return items.join("; ");
  return `${items.slice(0, limit).join("; ")} (first ${limit} of ${items.length})`;
}

export function classifyReconciliationOutcome(
  expectation: ReconciliationExpectation,
  holds: boolean,
): ReconciliationStatus {
  if (holds) return "holds";
  return expectation === "known-open" ? "known-open" : "breached";
}

export function summarizeReconciliationResults(results: readonly ReconciliationCheckResult[]): ReconciliationCounts {
  return {
    total: results.length,
    holding: results.filter((result) => result.status === "holds").length,
    breached: results.filter((result) => result.status === "breached").length,
    knownOpen: results.filter((result) => result.status === "known-open").length,
    errored: results.filter((result) => result.status === "errored").length,
  };
}

/**
 * A check that could not answer is an ALERT, not a pass. The whole point of the harness is that
 * silence used to mean "nobody looked"; a swallowed error that reported green would rebuild
 * exactly that.
 */
export function shouldAlert(counts: ReconciliationCounts): boolean {
  return counts.breached > 0 || counts.errored > 0;
}
