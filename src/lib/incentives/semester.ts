/**
 * What a semester IS — declared, rather than inferred from whatever sales data happens to be loaded.
 *
 * The incentive payout is a semester figure: semester achievement goes into the 2026 payout curve
 * (src/lib/incentives/scheme-2026.ts, owner-locked and untouched by this module) and comes out as
 * EGP shown to a medical rep. The curve was never the problem. The WINDOW feeding it was.
 *
 * Before this module the window was `allTimeTrend.slice(-6)` — "the last six months of data that
 * happen to exist for this rep". Two consequences, both measured in production on 2026-08-04:
 *
 *   1. It is not the same window for everybody. June 2026 was only half-loaded (55 reps against 82
 *      in every other month, 2 batches instead of 3), so 26 reps had five periods and one had four
 *      while their 56 colleagues had six — different-length semesters, on the same screen, with
 *      nothing saying so.
 *   2. It silently straddles the boundary. The moment a July sheet is approved, `slice(-6)` becomes
 *      February–July: half of S1, half of S2. Nothing in the code would notice, and the payout would
 *      simply change.
 *
 * A semester here is therefore a fixed set of period keys, and a rep's window is measured AGAINST
 * it: which of those periods arrived, which are genuinely missing, and which have not happened yet.
 * Those three are different facts and the caller must be able to tell them apart — a missing past
 * month is a data gap that makes the payout untrustworthy, while a future month simply means the
 * semester is still running.
 *
 * Pure by design (no clock, no database) so every boundary is testable: the rep's periods and
 * "today" are both passed in.
 */

/** Period key as used throughout the sales/portal code: `YYYY-MM`. */
export type PeriodKey = string;

/** e.g. `2026-S1`. Stable and sortable, and readable in a log line. */
export type SemesterKey = string;

export const SEMESTER_MONTH_COUNT = 6;

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for a well-formed `YYYY-MM`. Anything else is ignored rather than guessed at — a malformed
 * period must never silently land in a payout window. */
export function isPeriodKey(value: string | null | undefined): value is PeriodKey {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** The semester a period belongs to: months 1-6 are S1, months 7-12 are S2. Returns null for a
 * malformed period rather than defaulting, so a bad value cannot quietly select a window. */
export function resolveSemesterKey(period: PeriodKey | null | undefined): SemesterKey | null {
  if (!isPeriodKey(period)) return null;
  const [year, month] = period.split("-");
  return `${year}-S${Number(month) <= SEMESTER_MONTH_COUNT ? 1 : 2}`;
}

/** Every period key that belongs to `semester`, in calendar order. */
export function semesterPeriods(semester: SemesterKey): PeriodKey[] {
  const [yearText, half] = semester.split("-S");
  const year = Number(yearText);
  const firstMonth = half === "2" ? SEMESTER_MONTH_COUNT + 1 : 1;
  return Array.from({ length: SEMESTER_MONTH_COUNT }, (_, index) => {
    const month = firstMonth + index;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

/**
 * Human label for a heading — "Semester 1 2026". Never abbreviated with an ellipsis and short
 * enough that it cannot wrap in the portal's KPI cards.
 *
 * SPELLED OUT, NEVER "H1"/"H2" (owner, 2026-09-23, asked directly while the Pedia split rule was
 * being specified: "call it semester 1 and 2 and s1 and s2 not h1 and h2"). The short form stays
 * `S1`/`S2` — which is what `SemesterKey` has always carried — so the key needed no change; only
 * the words a person reads did. Use `semesterShortLabel` where a heading has no room for the long
 * one.
 */
export function semesterLabel(semester: SemesterKey): string {
  const [year, half] = semester.split("-S");
  return `Semester ${half} ${year}`;
}

/** The short form for a chip or a column header — "S1 2026". Same rule: never "H1". */
export function semesterShortLabel(semester: SemesterKey): string {
  const [year, half] = semester.split("-S");
  return `S${half} ${year}`;
}

export type IncentiveWindow = {
  /** Periods in the semester that carry data for this rep, in calendar order. */
  present: PeriodKey[];
  /** Periods already ELAPSED that carry no data — a real gap, and the reason a payout computed from
   * this window must not be presented as final. */
  missing: PeriodKey[];
  /** Periods still to come. Not a gap; the semester is simply in progress. */
  remaining: PeriodKey[];
  semester: SemesterKey;
  semesterLabel: string;
  /** Every period of the semester is present. Only then is the payout a settled figure. */
  complete: boolean;
};

/**
 * Which semester window applies, and how much of it this rep actually has.
 *
 * The semester is the CALENDAR one containing `todayPeriod`. Today (September 2026) that is
 * Semester 2, and every rep is scored on it whether or not any of it has been uploaded for them yet.
 *
 * It used to be anchored on the rep's LATEST data period instead, and that was a live landmine: the
 * displayed payout would flip from Semester 1 to Semester 2 for every rep the instant a July batch
 * was approved — no deploy, nothing on screen having changed. It also made the window a per-rep
 * fact, so a rep whose July had landed was scored on Semester 2 while the colleague beside him was
 * still on Semester 1. The owner's decision on 2026-08-13 settles which is right: the incentive
 * moves FORWARD to Semester 2 (Jul–Dec) from canonical July achievement onward, and Semester 1
 * payouts are closed and are not restated. The calendar is therefore the anchor.
 *
 * A rep with NO data in the semester still gets a window — every month either missing or still to
 * come. "Semester 2 has not started for you yet" is a fact worth stating, and returning null there
 * would leave the tab with no semester label and no notice at all.
 *
 * `todayPeriod` also separates a gap from a month that has not happened yet, and is passed in rather
 * than read from a clock so the boundary is testable.
 */
export function resolveIncentiveWindow(input: {
  periods: readonly (PeriodKey | null | undefined)[];
  todayPeriod: PeriodKey;
}): IncentiveWindow | null {
  const semester = resolveSemesterKey(input.todayPeriod);
  if (!semester) return null;

  // Periods outside the semester are not "extra data" — they belong to a closed payout and are
  // simply not part of this window. They drop out because `all` only contains the semester's months.
  const valid = input.periods.filter(isPeriodKey);

  const all = semesterPeriods(semester);
  const presentSet = new Set(valid);
  const present = all.filter((period) => presentSet.has(period));
  // A period is only "missing" once it is over. `todayPeriod` itself counts as elapsed for this
  // purpose only when it already carries data; an in-flight month with nothing uploaded yet is
  // reported as remaining, because calling it a gap would flag every rep for most of every month.
  const missing = all.filter((period) => !presentSet.has(period) && period < input.todayPeriod);
  const remaining = all.filter((period) => !presentSet.has(period) && period >= input.todayPeriod);

  return {
    complete: missing.length === 0 && remaining.length === 0,
    missing,
    present,
    remaining,
    semester,
    semesterLabel: semesterLabel(semester),
  };
}

/**
 * One line telling a rep exactly why their payout is not final yet, naming the months. Returns null
 * when the window is complete and the figure can stand on its own.
 *
 * Written as plain months a person recognises, never raw period keys, and never truncated.
 */
export function describeIncompleteWindow(window: IncentiveWindow | null): string | null {
  if (!window || window.complete) return null;
  const monthName = (period: PeriodKey) =>
    new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const parts: string[] = [];
  if (window.missing.length > 0) {
    parts.push(
      `${window.missing.map(monthName).join(", ")} ${window.missing.length === 1 ? "has" : "have"} not been uploaded yet`,
    );
  }
  if (window.remaining.length > 0) {
    parts.push(
      `${window.semesterLabel} has ${window.remaining.length} ${window.remaining.length === 1 ? "month" : "months"} still to come`,
    );
  }
  return `Provisional — ${parts.join(", and ")}.`;
}
