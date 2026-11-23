/**
 * Where a trip stands — the ONE answer, read by every tile, lane and row of Expense Approvals.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The page it replaces answered this with one
 * boolean, so three different things all read "Approved": a claim accepted but held out of payroll
 * until its photos and workload land, a claim waiting for the next payroll, and a claim a payroll had
 * already taken. Measured on production that day: 230 "Approved", of which 5 were held and 98 already
 * in a payroll.
 *
 * The five states, and the columns each is read from:
 *
 *   waiting          the request is undecided (`submitted`, `needs_review`).
 *   rejected         the request's status says rejected.
 *   approved_held    accepted, but NO payroll row carries it yet — the evidence gate is holding it.
 *   approved_queued  accepted, a payroll row carries it, and no payroll has taken that row.
 *   in_payroll       accepted, and a payroll took the row.
 *
 * 🔴 "A payroll took the row" is NOT only the stamp. `imported_payroll_batch_id` /
 * `imported_to_payroll_at` are written by a payroll's publish only since 2026-09-12, and July and
 * August 2026 were deliberately never backfilled — every trip those two payrolls paid reads empty.
 * So a row with no stamp whose payout month is on or before August 2026 is in a payroll too, and is
 * named for what it is (`stampKept: false`) rather than passed off as waiting for one.
 *
 * Pure and import-free: the queue read, the tiles and the tests all call this one function.
 */

export type TripStanding = "waiting" | "rejected" | "approved_held" | "approved_queued" | "in_payroll";

export const TRIP_STANDINGS = ["waiting", "approved_held", "approved_queued", "in_payroll", "rejected"] as const satisfies ReadonlyArray<TripStanding>;

/** The last payout period whose trips were paid before the paid stamp existed (August 2026). */
export const LAST_UNSTAMPED_PAYOUT = { month: 8, year: 2026 } as const;

export type TripStandingInput = {
  /** True when an `outstation_expenses` row carries this claim (`trip_id = OUTSTATION-<id>`). */
  hasPayrollRow: boolean;
  /** The payroll row's payout period; null when there is no row. */
  payoutMonth?: number | null;
  payoutYear?: number | null;
  /** True when the row carries either paid stamp. */
  payrollStamped: boolean;
  /** `outstation_expense_requests.status`, exactly as stored. */
  status: string | null | undefined;
};

export type TripStandingReading = {
  standing: TripStanding;
  /** False only for a trip a payroll took before the stamp was kept (July and August 2026). */
  stampKept: boolean;
};

const UNDECIDED = new Set(["submitted", "needs_review"]);

function isRejected(status: string): boolean {
  return status.includes("reject") || status.includes("decline");
}

function isAccepted(status: string): boolean {
  return status.includes("accept") || status.includes("approve") || status.includes("confirm");
}

/** True when the payout period is on or before the last one paid without a stamp. */
export function paidBeforeStampsWereKept(month: number | null | undefined, year: number | null | undefined): boolean {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || !Number.isInteger(y) || m < 1 || m > 12) return false;
  return y < LAST_UNSTAMPED_PAYOUT.year || (y === LAST_UNSTAMPED_PAYOUT.year && m <= LAST_UNSTAMPED_PAYOUT.month);
}

export function readTripStanding(input: TripStandingInput): TripStandingReading {
  const status = String(input.status ?? "").trim().toLowerCase();
  if (UNDECIDED.has(status)) return { standing: "waiting", stampKept: true };
  if (isRejected(status)) return { standing: "rejected", stampKept: true };
  // A status nobody listed is shown as waiting rather than hidden: an unknown claim nobody can see is
  // worse than one the decide path refuses by name.
  if (!isAccepted(status)) return { standing: "waiting", stampKept: true };
  if (!input.hasPayrollRow) return { standing: "approved_held", stampKept: true };
  if (input.payrollStamped) return { standing: "in_payroll", stampKept: true };
  if (paidBeforeStampsWereKept(input.payoutMonth, input.payoutYear)) return { standing: "in_payroll", stampKept: false };
  return { standing: "approved_queued", stampKept: true };
}

export function tripStanding(input: TripStandingInput): TripStanding {
  return readTripStanding(input).standing;
}

/** The words a row and a tile wear for each state — one vocabulary, pinned by a test. */
export const TRIP_STANDING_LABEL: Record<TripStanding, string> = {
  approved_held: "Approved · held",
  approved_queued: "Approved · next payroll",
  in_payroll: "In payroll",
  rejected: "Rejected",
  waiting: "Waiting",
};

/** One sentence saying what the state means for the money. */
export const TRIP_STANDING_MEANING: Record<TripStanding, string> = {
  approved_held: "Approved, but held out of payroll until its photos and workload land.",
  approved_queued: "Approved and waiting for the next payroll to take it.",
  in_payroll: "A payroll has taken it.",
  rejected: "Rejected. Nothing is paid.",
  waiting: "Waiting for your decision.",
};

export type TripStandingCounts = Record<TripStanding, { count: number; value: number }>;

export function emptyStandingCounts(): TripStandingCounts {
  return {
    approved_held: { count: 0, value: 0 },
    approved_queued: { count: 0, value: 0 },
    in_payroll: { count: 0, value: 0 },
    rejected: { count: 0, value: 0 },
    waiting: { count: 0, value: 0 },
  };
}

/**
 * The five tiles. `payable` is what the trip pays as it stands: the claim while it waits, the
 * approved figure once decided (the amount he typed, when he typed one), and nothing when rejected —
 * a rejected trip is counted and never summed.
 */
export function countTripStandings(trips: ReadonlyArray<{ payable: number; standing: TripStanding }>): TripStandingCounts {
  const counts = emptyStandingCounts();
  for (const trip of trips) {
    const tile = counts[trip.standing];
    tile.count += 1;
    if (trip.standing !== "rejected" && Number.isFinite(trip.payable)) tile.value += trip.payable;
  }
  for (const key of TRIP_STANDINGS) counts[key].value = Math.round(counts[key].value * 100) / 100;
  return counts;
}
