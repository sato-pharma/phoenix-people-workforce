/**
 * Phoenix CRM — the filter logic for the Place checks page (owner, 2026-10-05: "I want to be able to
 * filter by rep by line by region by period by field by rejected by accepted by any single thing").
 *
 * Pure and screen-free, so the board (`validation-reviews-board.tsx`) stays a thin shell of state and
 * controls and the rules here can be pinned by a test. Both the review rows and the validated-place
 * rows carry every field a filter reads, so one set of functions narrows all three sections.
 */

/** Which sections are shown. "all" is everything; the rest narrow to one outcome. */
export type ValidationReviewOutcome = "all" | "pending" | "approved" | "rejected" | "validated";

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
