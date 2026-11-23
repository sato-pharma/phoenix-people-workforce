/**
 * Where a trip stands — the ONE answer, read by every tile, lane and row of Expense Approvals.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The page it replaces answered this with one
 * boolean, so three different things all read "Approved": a claim accepted but held out of payroll
 * until its photos and workload land, a claim waiting for the next payroll, and a claim a payroll had
 * already taken. Measured on production that day: 230 "Approved", of which 5 were held and 98 already
 * in a payroll.
 *
 * The six states, and the columns each is read from:
 *
 *   waiting          the request is undecided (`submitted`, `needs_review`).
 *   rejected         the request's status says rejected.
 *   approved_held    accepted, but NO payroll row carries it yet — the evidence gate is holding it.
 *   approved_queued  accepted, a payroll row carries it, and its payout month's payroll has not run.
 *   approved_missed  accepted, a payroll row carries it, the row is not marked paid, and the payroll
 *                    of its payout month HAS already run.
 *   in_payroll       accepted, and a payroll took the row.
 *
 * 🔴 `approved_missed` was found the morning the desk went live (23 Nov 2026): 12 approved trips with
 * payout month September or October 2026, about 3,869 EGP, read "Approved · next payroll" while both
 * payrolls had run. Payroll reads a trip by its OWN payout month and no later run looks back
 * (src/lib/automated-payroll/late-expenses.ts), so "the next payroll" takes none of them by itself:
 * they are listed on the payroll Expenses step, and paid only when a run carries them. UNSTAMPED IS
 * NOT UNPAID there either, so this state says exactly what is known — approved, its payroll ran, not
 * marked paid — and never "unpaid". "Its payroll ran" is read from the newest payout month that
 * carries a paid stamp (`lastPaidPayout`); without that reading the state is never claimed.
 *
 * 🔴 "A payroll took the row" is NOT only the stamp. `imported_payroll_batch_id` /
 * `imported_to_payroll_at` are written by a payroll's publish only since 2026-09-12, and July and
 * August 2026 were deliberately never backfilled — every trip those two payrolls paid reads empty.
 * So a row with no stamp whose payout month is on or before August 2026 is in a payroll too, and is
 * named for what it is (`stampKept: false`) rather than passed off as waiting for one.
 *
 * Pure and import-free: the queue read, the tiles and the tests all call this one function.
 */

export type TripStanding = "waiting" | "rejected" | "approved_held" | "approved_queued" | "approved_missed" | "in_payroll";

export const TRIP_STANDINGS = ["waiting", "approved_held", "approved_queued", "approved_missed", "in_payroll", "rejected"] as const satisfies ReadonlyArray<TripStanding>;

/** A payout month, as the payroll row stores it. */
export type PayoutPeriod = { month: number; year: number };

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
  /**
   * The newest payout month any payroll row carries a paid stamp for — the last payroll that ran.
   * Null or absent when it was not read: `approved_missed` is then never claimed.
   */
  lastPaidPayout?: PayoutPeriod | null;
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

function period(month: unknown, year: unknown): PayoutPeriod | null {
  if (month === null || month === undefined || year === null || year === undefined) return null;
  const m = Number(month);
  const y = Number(year);
  return Number.isInteger(m) && Number.isInteger(y) && m >= 1 && m <= 12 ? { month: m, year: y } : null;
}

/** True when a payroll has already run for this payout month: it is on or before the newest paid one. */
export function payrollAlreadyRan(
  month: number | null | undefined,
  year: number | null | undefined,
  lastPaidPayout: PayoutPeriod | null | undefined,
): boolean {
  const own = period(month, year);
  const last = period(lastPaidPayout?.month, lastPaidPayout?.year);
  if (!own || !last) return false;
  return own.year < last.year || (own.year === last.year && own.month <= last.month);
}

/** The newest payout month among the rows given; null when none names one. Pure. */
export function newestPayout(rows: ReadonlyArray<{ payout_month?: unknown; payout_year?: unknown }>): PayoutPeriod | null {
  let newest: PayoutPeriod | null = null;
  for (const row of rows) {
    const own = period(row.payout_month, row.payout_year);
    if (own && (!newest || own.year > newest.year || (own.year === newest.year && own.month > newest.month))) newest = own;
  }
  return newest;
}

/** True for an approved trip whose payroll row no payroll has taken — queued, or missed by its own month's run. */
export function awaitsAPayroll(standing: TripStanding): boolean {
  return standing === "approved_queued" || standing === "approved_missed";
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
  if (payrollAlreadyRan(input.payoutMonth, input.payoutYear, input.lastPaidPayout)) return { standing: "approved_missed", stampKept: true };
  return { standing: "approved_queued", stampKept: true };
}

export function tripStanding(input: TripStandingInput): TripStanding {
  return readTripStanding(input).standing;
}

/** The words a row and a tile wear for each state — one vocabulary, pinned by a test. */
export const TRIP_STANDING_LABEL: Record<TripStanding, string> = {
  approved_held: "Approved · held",
  approved_missed: "Approved · payroll already ran",
  approved_queued: "Approved · next payroll",
  in_payroll: "In payroll",
  rejected: "Rejected",
  waiting: "Waiting",
};

/** One sentence saying what the state means for the money. */
export const TRIP_STANDING_MEANING: Record<TripStanding, string> = {
  approved_held: "Approved, but held out of payroll until its photos and workload land.",
  approved_missed:
    "Approved, but the payroll of its payout month has already run and it is not marked paid. No later payroll takes it by itself: it is listed on the payroll Expenses step.",
  approved_queued: "Approved and waiting for the next payroll to take it.",
  in_payroll: "A payroll has taken it.",
  rejected: "Rejected. Nothing is paid.",
  waiting: "Waiting for your decision.",
};

export type TripStandingCounts = Record<TripStanding, { count: number; value: number }>;

export function emptyStandingCounts(): TripStandingCounts {
  return {
    approved_held: { count: 0, value: 0 },
    approved_missed: { count: 0, value: 0 },
    approved_queued: { count: 0, value: 0 },
    in_payroll: { count: 0, value: 0 },
    rejected: { count: 0, value: 0 },
    waiting: { count: 0, value: 0 },
  };
}

/**
 * The six tiles. `payable` is what the trip pays as it stands: the claim while it waits, the
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
