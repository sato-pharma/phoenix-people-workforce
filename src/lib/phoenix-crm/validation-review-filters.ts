/**
 * Phoenix CRM — the filter logic for the Place checks page (owner, 2026-10-05: "I want to be able to
 * filter by rep by line by region by period by field by rejected by accepted by any single thing").
 *
 * Pure and screen-free, so the board (`validation-reviews-board.tsx`) stays a thin shell of state and
 * controls and the rules here can be pinned by a test. Both the review rows and the validated-place
 * rows carry every field a filter reads, so one set of functions narrows all three sections.
 */

/**
 * Which sections are shown. "all" is everything; the rest narrow to one outcome.
 *
 * "unseen" (2026-10-08) narrows the validations in use to the ones NOBODY HAS EVER LOOKED AT — no review
 * row of any status. 598 of the module's first 643 places were exactly that, and the page could not say
 * so; combined with the signboard verdict on every place it is the one sort that matters.
 */
export type ValidationReviewOutcome = "all" | "pending" | "approved" | "rejected" | "validated" | "unseen";

/** A validated place passes the outcome when the outcome shows that section — "unseen" only if never reviewed. */
export function validatedPassesOutcome(row: { reviewed: boolean }, outcome: ValidationReviewOutcome): boolean {
  if (outcome === "unseen") return !row.reviewed;
  return outcome === "all" || outcome === "validated";
}

/** How far back a row may be, by its own date (captured, decided, or validated). */
export type ValidationReviewPeriod = "all" | "today" | "7" | "14" | "30";

export type ValidationReviewFilters = {
  outcome: ValidationReviewOutcome;
  rep: string;
  line: string;
  region: string;
  area: string;
  list: string;
  period: ValidationReviewPeriod;
  text: string;
};

export const EMPTY_VALIDATION_REVIEW_FILTERS: ValidationReviewFilters = {
  outcome: "all",
  rep: "",
  line: "",
  region: "",
  area: "",
  list: "",
  period: "all",
  text: "",
};

/** The fields every filterable row carries — both the review rows and the validated-place rows have all of these. */
export type ValidationReviewFilterable = {
  repName: string;
  line: string | null;
  region: string | null;
  listType: string;
  customerName: string;
  territory: string;
  speciality: string | null;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
};

/** The distinct, non-empty values of a column across every row, sorted for a dropdown. */
export function distinctValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) seen.add(value);
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

/** The oldest timestamp a period allows, or null for "any time". `now` is injectable so a test is deterministic. */
export function validationReviewPeriodCutoff(period: ValidationReviewPeriod, now: number = Date.now()): number | null {
  if (period === "all") return null;
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  return now - Number(period) * 86_400_000;
}

/** Whether a row's own timestamp is within the period. An unreadable date is kept rather than dropped. */
export function withinValidationReviewPeriod(when: string, cutoff: number | null): boolean {
  if (cutoff === null) return true;
  const at = new Date(when).getTime();
  return Number.isNaN(at) ? true : at >= cutoff;
}

/**
 * Whether a row passes the shared filters — rep, line, region, area, list and the free-text search. The
 * outcome and the period are applied by the board, which knows each section's status and date field.
 */
export function matchesValidationReviewFilters(row: ValidationReviewFilterable, filters: ValidationReviewFilters): boolean {
  if (filters.rep && row.repName !== filters.rep) return false;
  if (filters.line && (row.line ?? "") !== filters.line) return false;
  if (filters.region && (row.region ?? "") !== filters.region) return false;
  if (filters.area && (row.areaName ?? "") !== filters.area) return false;
  if (filters.list && row.listType !== filters.list) return false;
  const wanted = filters.text.trim().toLowerCase();
  if (wanted) {
    const haystack = [row.customerName, row.repName, row.territory, row.speciality, row.placeLabel, row.brickName, row.areaName, row.address];
    if (!haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(wanted))) return false;
  }
  return true;
}

/**
 * The same shared filters, read against a POLYCLINIC or centre (owner, 2026-10-09).
 *
 * 🔴 THE LIST FILTER DELIBERATELY DOES NOT REACH A VENUE. A shared place is on nobody's list — it is a
 * venue only, takes no visit and counts in no KPI — so narrowing to AM or PM would empty the section
 * rather than narrow it, and the reader would read an empty section as "no polyclinics". Everything
 * else (rep, line, region, area, free text) applies exactly as it does to a place, and the venue's own
 * name is what the free-text box searches in place of a customer name.
 */
export function matchesSharedPlaceFilters(
  row: { name: string; repName: string; line: string | null; region: string | null; territory: string; address: string | null; brickName: string | null; areaName: string | null },
  filters: ValidationReviewFilters,
): boolean {
  if (filters.rep && row.repName !== filters.rep) return false;
  if (filters.line && (row.line ?? "") !== filters.line) return false;
  if (filters.region && (row.region ?? "") !== filters.region) return false;
  if (filters.area && (row.areaName ?? "") !== filters.area) return false;
  const wanted = filters.text.trim().toLowerCase();
  if (wanted) {
    const haystack = [row.name, row.repName, row.territory, row.brickName, row.areaName, row.address];
    if (!haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(wanted))) return false;
  }
  return true;
}

/**
 * Which outcomes show a venue. `held` is the one waiting for a decision; `active` is in use, whether he
 * approved it or the system never questioned it.
 *
 * 🔴 A REJECTED VENUE IS ON THE BOARD AGAIN (owner, 2026-10-15: "approve validation after rejection" —
 * `loadSharedPlaceBoard` reads a retired venue for 90 days so it can be taken back), so "Rejected" shows
 * exactly the retired ones and every other outcome hides them. Before that this answered `false` for
 * "Rejected" on the strength of the venue not being read at all, and the Polyclinics section vanished
 * under the very outcome that now holds its rejected buildings.
 */
export function sharedPlacePassesOutcome(
  row: { status: "active" | "held" | "retired"; decidedAtText: string | null },
  outcome: ValidationReviewOutcome,
): boolean {
  if (row.status === "retired") return outcome === "all" || outcome === "rejected";
  if (outcome === "pending") return row.status === "held";
  if (outcome === "approved") return row.status === "active" && row.decidedAtText !== null;
  if (outcome === "rejected") return false;
  if (outcome === "unseen") return row.status === "active" && row.decidedAtText === null;
  return outcome === "all" || outcome === "validated";
}

/** Whether any narrowing filter is set — the outcome selector alone does not count, since "Clear" also resets it. */
export function hasActiveValidationReviewFilter(filters: ValidationReviewFilters): boolean {
  return (
    filters.rep !== "" ||
    filters.line !== "" ||
    filters.region !== "" ||
    filters.area !== "" ||
    filters.list !== "" ||
    filters.period !== "all" ||
    filters.text.trim() !== ""
  );
}
