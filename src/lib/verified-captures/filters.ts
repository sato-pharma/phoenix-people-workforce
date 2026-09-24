// Pure, dependency-free filtering for the Verified Captures gallery.
//
// Kept apart from the loaders and the React component so the rep / district-manager / text filter
// that the owner asked for ("filter by rep or by district manager") can be unit-tested without a
// database or a DOM. Both tabs' rows share the four fields this file reads, so one set of helpers
// drives both.

/** The sentinel a select uses for "no filter" — never a real HR id. */
export const ALL = "__all__" as const;

/** The slice of a capture row the filters read — both tab row types satisfy it. */
export type FilterableCapture = {
  repHrId: string | null;
  repName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  /** Any text the search box should match against (name, code, address …), joined by the caller. */
  searchText?: string | null;
};

export type CaptureFilter = {
  /** A canonical rep HR id, or {@link ALL}. */
  rep: string;
  /** A canonical district-manager HR id, or {@link ALL}. */
  manager: string;
  /** Free text; empty means no text filter. */
  search: string;
};

export const EMPTY_CAPTURE_FILTER: CaptureFilter = { rep: ALL, manager: ALL, search: "" };

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

/** Does one row pass the whole filter? Empty/`ALL` parts match everything. */
export function matchesCaptureFilter(row: FilterableCapture, filter: CaptureFilter): boolean {
  if (filter.rep !== ALL && row.repHrId !== filter.rep) return false;
  if (filter.manager !== ALL && row.managerHrId !== filter.manager) return false;

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

/** Apply the filter to a list, preserving order. */
export function applyCaptureFilter<T extends FilterableCapture>(
  rows: readonly T[],
  filter: CaptureFilter,
): T[] {
  return rows.filter((row) => matchesCaptureFilter(row, filter));
}
