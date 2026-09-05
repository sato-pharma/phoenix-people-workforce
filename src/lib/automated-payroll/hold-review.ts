import { monthNameAndYear } from "./step-definitions.ts";
import { isCarriedForwardReason, previousPeriod } from "./hold-reason.ts";
import type { PayrollPeriod, PriorHold, StepRow } from "./types.ts";

/**
 * The held-employee review — who this run is NOT paying, and why.
 *
 * A held row is dropped at publish (`publishToPayslips` filters `!onHold`): no
 * `salary_record`, no payslip, and nothing anywhere recording that the person
 * was paid outside the system. So the moment before publishing is the last
 * moment the reason can still be read, and until now the reviewer standing at
 * that moment saw a single number — `Held: 13` — with no names behind it.
 *
 * A count cannot answer the question that matters. On the August 2026 run those
 * thirteen were not one population: eleven were new decisions and two were the
 * continuation of an owner ruling made in July, and nothing on screen separated
 * them. This names each person, shows the reason, and says whether they were
 * held last month and why — which is the fact the run being reviewed cannot
 * answer about itself, because it only holds its own month.
 *
 * Deliberately shaped like `population-diff.ts`, its sibling: that panel names
 * joiners and leavers rather than counting them, for the same reason (a headcount
 * hides the one case worth seeing). Pure and I/O-free so the classification is
 * unit-tested directly; the caller supplies the rows.
 */

/** Whether this hold continues one from last month, or starts here. */
export type HoldContinuity = "new" | "continued";

export type HeldEmployeeReview = {
  hrId: string;
  fullName: string;
  jobTitle: string | null;
  /**
   * The reason as it stands for THIS run — already resolved, so a reason
   * inherited from last month appears here carrying its own
   * "Carried forward from <month>" label. Null means nothing explains this
   * hold: not this month, and not last month either.
   */
  reason: string | null;
  /** True when `reason` announces itself as inherited rather than typed for this run. */
  carriedForward: boolean;
  continuity: HoldContinuity;
  /** Last month's hold for this person, when there was one. */
  priorHold: PriorHold | null;
};

export type HoldReview = {
  month: number;
  year: number;
  monthLabel: string;
  priorMonthLabel: string;
  /** Every held row, most-urgent first (see `compareForReview`). */
  held: HeldEmployeeReview[];
  heldCount: number;
  /**
   * Held with no reason at all. These are the rows that block the hold step's
   * confirm (and therefore Part 2, and therefore publish), so the reviewer is
   * told the number they have to act on rather than discovering it at the 400.
   */
  unexplainedCount: number;
  /** Held this month AND last month — a continuation, not a fresh decision. */
  continuedCount: number;
};

/**
 * Review order: unexplained first, then continuations, then by name.
 *
 * An unexplained hold is the only one that needs work before this run can be
 * confirmed, so it goes to the top rather than being sorted alphabetically into
 * the middle of a list of settled ones. Name is the final tiebreak because the
 * owner reads people by name, never by HR id.
 */
function compareForReview(a: HeldEmployeeReview, b: HeldEmployeeReview): number {
  const unexplained = Number(b.reason === null) - Number(a.reason === null);
  if (unexplained !== 0) return unexplained;
  const continued = Number(b.continuity === "continued") - Number(a.continuity === "continued");
  if (continued !== 0) return continued;
  return a.fullName.localeCompare(b.fullName);
}

/**
 * Build the review from a hold step's rows.
 *
 * Takes `StepRow[]` straight from `recommendStep` rather than re-deriving the
 * reason from draft columns. That is the whole point: the grid, the confirm gate
 * and this panel then read one resolution, so the review cannot drift into
 * showing a reason the confirm does not accept — a rule being right while a
 * second code path disagrees with it is exactly the defect class this module's
 * sibling `hold-reason.ts` was written to close.
 *
 * `readOnly` rows are excluded because they are never persisted and never
 * published, so they are not among the people this run declines to pay.
 */
export function buildHoldReview(input: { period: PayrollPeriod; rows: readonly StepRow[] }): HoldReview {
  const prior = previousPeriod(input.period);

  const held: HeldEmployeeReview[] = input.rows
    .filter((row) => row.onHold && !row.readOnly)
    .map((row): HeldEmployeeReview => ({
      hrId: row.hrId,
      fullName: row.fullName,
      jobTitle: row.jobTitle ?? null,
      reason: row.reason ?? null,
      // Trust the resolver's own flag when it set one, and fall back to reading
      // the stored text. A reason that was carried forward and then SAVED comes
      // back on a later load as an ordinary stored reason with no flag, but its
      // text still says where it came from — so the label must survive that
      // round trip, or a continuation silently starts reading as a fresh
      // assertion about this month.
      carriedForward: row.reasonCarriedForward === true || isCarriedForwardReason(row.reason),
      continuity: row.priorHold ? "continued" : "new",
      priorHold: row.priorHold ?? null,
    }))
    .sort(compareForReview);

  return {
    month: input.period.month,
    year: input.period.year,
    monthLabel: monthNameAndYear(input.period.month, input.period.year),
    priorMonthLabel: monthNameAndYear(prior.month, prior.year),
    held,
    heldCount: held.length,
    unexplainedCount: held.filter((entry) => entry.reason === null).length,
    continuedCount: held.filter((entry) => entry.continuity === "continued").length,
  };
}
