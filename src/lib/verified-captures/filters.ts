// Pure, dependency-free filtering and sorting for the Verified Captures gallery.
//
// Kept apart from the loaders and the React component so the filters the owner asked for — rep
// (requester), district manager, line, area, brick, region, month, plus a by-date sort — can be
// unit-tested without a database or a DOM. Both tabs' rows share the fields this file reads, and a
// dimension a tab does not carry simply has no options (its picker is hidden), so one set of helpers
// drives both.

/** The sentinel a select uses for "no filter" — never a real value. */
export const ALL = "__all__" as const;

/** The value dimensions a capture can be filtered by, beyond the two people. */
export type CaptureValueDimension = "line" | "area" | "brick" | "region";

/** How the list is ordered. Newest first by default. */
export type CaptureSort = "date-desc" | "date-asc";

/** The slice of a capture row the filters read — both tab row types satisfy it. */
export type FilterableCapture = {
  repHrId: string | null;
  repName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  /** Any text the search box should match against (name, code, address …), joined by the caller. */
  searchText?: string | null;
  line?: string | null;
  area?: string | null;
  brick?: string | null;
  region?: string | null;
  /** The ISO instant the row is dated by — capture time (marketing) or verify time (direct orders). */
  sortDate?: string | null;
};

export type CaptureFilter = {
  /** A canonical rep HR id, or {@link ALL}. */
  rep: string;
  /** A canonical district-manager HR id, or {@link ALL}. */
  manager: string;
  /** Free text; empty means no text filter. */
  search: string;
  /** A line name, or {@link ALL}. */
  line?: string;
  /** An area name, or {@link ALL}. */
  area?: string;
  /** A brick name, or {@link ALL}. */
  brick?: string;
  /** A region name, or {@link ALL}. */
  region?: string;
  /** A Cairo month key "YYYY-MM", or {@link ALL}. */
  month?: string;
  /** The sort order; defaults to newest first. */
  sort?: CaptureSort;
};

export const EMPTY_CAPTURE_FILTER: CaptureFilter = {
  rep: ALL,
  manager: ALL,
  search: "",
  line: ALL,
  area: ALL,
  brick: ALL,
  region: ALL,
  month: ALL,
  sort: "date-desc",
};

/** One option in a rep/manager picker: the id to filter on and the name to show. */
export type CaptureFilterOption = {
  hrId: string;
  name: string;
};

/**
 * The distinct people in one dimension, sorted by display name, ready for a select.
 *
 * A person with an id but no name still gets an option (labelled by their id) rather than being
 * dropped — the owner would otherwise be unable to filter to a rep the employees table has not
 * named, and the capture would be unreachable through the picker.
 */
export function distinctPeople(
  rows: readonly FilterableCapture[],
  dimension: "rep" | "manager",
): CaptureFilterOption[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    const hrId = dimension === "rep" ? row.repHrId : row.managerHrId;
    if (!hrId) continue;
    const name = (dimension === "rep" ? row.repName : row.managerName) ?? hrId;
    // First non-id name wins; never let a later blank overwrite a real name.
    if (!byId.has(hrId) || byId.get(hrId) === hrId) byId.set(hrId, name);
  }
  return [...byId.entries()]
    .map(([hrId, name]) => ({ hrId, name }))
    .sort((a, b) => {
      // Named people first (alphabetically); anyone the employees table has not named — labelled by
      // their own id — sinks to the bottom, so the picker reads as a list of names, not ids.
      const aUnnamed = a.name === a.hrId;
      const bUnnamed = b.name === b.hrId;
      if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

/** The distinct non-empty values in one value dimension, sorted for a select. */
export function distinctValues(
  rows: readonly FilterableCapture[],
  dimension: CaptureValueDimension,
): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[dimension];
    if (typeof value === "string" && value.trim()) values.add(value.trim());
  }
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The Cairo year-month "YYYY-MM" for an ISO instant, or null when it cannot be read. */
export function cairoMonthKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Intl with an explicit time zone is reliable here; the MSYS `TZ` trap does not touch it.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

/** A readable label for a "YYYY-MM" month key, e.g. "September 2026". */
export function cairoMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  const date = new Date(Date.UTC(year, month - 1, 1));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(date);
}

/** The distinct Cairo months present, newest first, each with its key and label. */
export function distinctMonths(
  rows: readonly FilterableCapture[],
): Array<{ key: string; label: string }> {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = cairoMonthKey(row.sortDate);
    if (key) keys.add(key);
  }
  return [...keys]
    .sort((a, b) => b.localeCompare(a))
    .map((key) => ({ key, label: cairoMonthLabel(key) }));
}

/** Does one row pass the whole filter? Empty/`ALL`/undefined parts match everything. */
export function matchesCaptureFilter(row: FilterableCapture, filter: CaptureFilter): boolean {
  if (filter.rep !== ALL && row.repHrId !== filter.rep) return false;
  if (filter.manager !== ALL && row.managerHrId !== filter.manager) return false;
  if (filter.line && filter.line !== ALL && (row.line ?? null) !== filter.line) return false;
  if (filter.area && filter.area !== ALL && (row.area ?? null) !== filter.area) return false;
  if (filter.brick && filter.brick !== ALL && (row.brick ?? null) !== filter.brick) return false;
  if (filter.region && filter.region !== ALL && (row.region ?? null) !== filter.region) return false;
  if (filter.month && filter.month !== ALL && cairoMonthKey(row.sortDate) !== filter.month) return false;

  const needle = filter.search.trim().toLowerCase();
  if (needle) {
    const haystack = [row.searchText, row.repName, row.managerName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Apply the filter to a list, then order it by date per {@link CaptureFilter.sort}. */
export function applyCaptureFilter<T extends FilterableCapture>(
  rows: readonly T[],
  filter: CaptureFilter,
): T[] {
  const matched = rows.filter((row) => matchesCaptureFilter(row, filter));
  if (!filter.sort) return matched;

  const direction = filter.sort === "date-asc" ? 1 : -1;
  // A stable sort that keeps rows with no date at the end, in their original order, either way.
  return matched
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aTime = a.row.sortDate ? Date.parse(a.row.sortDate) : NaN;
      const bTime = b.row.sortDate ? Date.parse(b.row.sortDate) : NaN;
      const aOk = !Number.isNaN(aTime);
      const bOk = !Number.isNaN(bTime);
      if (aOk && bOk) return aTime === bTime ? a.index - b.index : (aTime - bTime) * direction;
      if (aOk !== bOk) return aOk ? -1 : 1; // undated rows sink to the bottom
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}
