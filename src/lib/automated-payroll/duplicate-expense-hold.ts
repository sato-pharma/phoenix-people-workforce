import { payableExpenseAmount } from "@/lib/outstation/payable";
import { roundCurrency } from "@/lib/payroll/money";

/**
 * The duplicate-claim hold: the same trip claimed twice in one payout run is held out of the
 * proposed figure until a human releases it.
 *
 * WHY THIS EXISTS. Ahmed Mohamed Ahmed Mohamed Heikal was reimbursed 351.00 twice for one trip to
 * As Satamuni on 23 May 2026. TRP-00261 and TRP-00262 are the same person, the same day, the same
 * destination and the same amount; both arrived `hr_approved` from one import, both were tagged to
 * payout month 6, and payroll summed both. Nobody approved it twice — the uploaded sheet carried
 * the row twice and nothing compared a row against the rows beside it. Measured across the whole
 * history (413 expense rows, every payout run Phoenix has ever had, 2026-09-26) this rule fires on
 * that one group and nothing else: zero other matches, so it costs no honest claim.
 *
 * WHAT IT IS NOT. It never rejects, never deletes and never hides money — the owner's standing rule
 * is that the system FLAGS an expense and never auto-rejects one, and "a figure nobody can see is
 * indistinguishable from a refusal". A held trip keeps its full amount, stays in the row's trip
 * breakdown carrying the reason, and is subtotalled where HR can see it. Approving it, or typing
 * the amount, still pays it. This narrows what is PROPOSED, exactly as the 2026-09-08 decision did
 * for undecided trips — the same shape, for the same reason.
 *
 * WHY NOT A DATABASE CONSTRAINT. A unique index would refuse the claim outright, with no override
 * and no words, which is the shape of control people learn to route around. And it would be wrong
 * often enough to matter: a rep can legitimately run the same route twice in one day.
 *
 * WHY THE FIRST COPY IS NOT HELD. A single genuine trip must still pay by itself. Holding every
 * copy would turn one duplicated row into two rows nobody is paid for, which is a new error rather
 * than the absence of the old one. So the first copy is proposed as normal and only the EXTRA
 * copies wait for a decision.
 */

/** The identifying fields of one payable trip. Structural, so a caller's own row type fits. */
export type DuplicateHoldCandidate = {
  tripId: string;
  expenseDate: string;
  toLocation: string;
  total: number;
  approvedAmount?: number | null;
};

export type DuplicateExpenseHold = {
  /** The trip held out of the proposed figure. */
  tripId: string;
  /** The copy it duplicates — the one that is still proposed. */
  duplicateOfTripId: string;
  /** How many copies of this trip are in the run, the held one included. */
  copies: number;
  /** Plain words for the trip breakdown, naming the other trip so HR can compare the two. */
  reason: string;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDay(value: string | null | undefined): string {
  return String(value ?? "").trim().slice(0, 10);
}

/**
 * The identity two claims must share to be the same trip: person (the caller groups by that),
 * day, destination and amount. All four, deliberately.
 *
 * Amount is in the key because a fixed per-trip allowance repeats legitimately — the same rep
 * travelling the same route on DIFFERENT days produces identical amounts all month, and matching on
 * amount alone would hold a dozen honest claims. Destination is in the key because two destinations
 * on one day is ordinary work: of the ten same-day trip pairs on production, every single one goes
 * somewhere different, and a same-day rule alone would have held all of them.
 */
function tripIdentity(trip: DuplicateHoldCandidate): string {
  return [
    normalizeDay(trip.expenseDate),
    normalizeText(trip.toLocation),
    roundCurrency(Number(trip.total) || 0).toFixed(2),
  ].join("|");
}

/**
 * The extra copies of any trip claimed more than once, for ONE person in ONE payout run.
 *
 * Pure, and exported on its own so the rule can be pinned without a database: what this returns
 * decides what is proposed, and the money that is proposed is the money that gets paid.
 *
 * Order is the caller's. The first copy in the list given is the one kept, so a caller that sorts
 * its trips stably gets a stable answer; the live read orders by expense date.
 */
export function findDuplicateExpenseHolds(trips: DuplicateHoldCandidate[]): Map<string, DuplicateExpenseHold> {
  const held = new Map<string, DuplicateExpenseHold>();
  const byIdentity = new Map<string, DuplicateHoldCandidate[]>();

  for (const trip of trips) {
    const identity = tripIdentity(trip);
    const group = byIdentity.get(identity) ?? [];
    group.push(trip);
    byIdentity.set(identity, group);
  }

  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const [kept, ...extras] = group;
    for (const extra of extras) {
      // A trip with no id cannot be named back to HR, and two of them cannot be told apart in the
      // breakdown either — so it is left alone rather than held against something unidentifiable.
      if (!extra.tripId || !kept.tripId) continue;
      held.set(extra.tripId, {
        tripId: extra.tripId,
        duplicateOfTripId: kept.tripId,
        copies: group.length,
        // Short on purpose: this renders as one right-aligned value in the trip breakdown, beside
        // that trip's own "Trip ID" line, so it names the other copy and stops. Why the rule exists
        // is at the top of this file, and the step's subtitle says it in plain words on the screen.
        reason:
          `Duplicate of ${kept.tripId} — same day, same destination, same amount` +
          (group.length > 2 ? ` (${group.length} copies in this run)` : "") +
          `. Held out of the proposed figure; nothing is refused — approve it, or type the amount, to pay it.`,
      });
    }
  }

  return held;
}

/** The money held back for one person, so it can be shown rather than merely withheld. */
export function heldDuplicateTotal(
  trips: DuplicateHoldCandidate[],
  held: Map<string, DuplicateExpenseHold>,
): number {
  let sum = 0;
  for (const trip of trips) {
    if (!held.has(trip.tripId)) continue;
    sum = roundCurrency(sum + payableExpenseAmount(trip.approvedAmount ?? null, trip.total));
  }
  return sum;
}
