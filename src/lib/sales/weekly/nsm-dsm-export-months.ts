// Which cycle months the portal's NSM/DSM download covers — the months the page's own Month filter
// names, so the book is never a different month from the screen it was taken from.
//
// Pure and import-free ON PURPOSE: the dashboard component is a client bundle, and the builder
// (portal-nsm-dsm-export.ts) reaches node:crypto, which webpack refuses in a browser bundle and which
// then 500s every request the dev server serves. Same reason product-units-shape.ts exists.

/** A cycle month as the loader stores it: the first of the month. */
const CYCLE_MONTH = /^\d{4}-\d{2}-01$/;

/** True for a cycle month code such as "2026-10-01" — the one shape the route accepts. */
export function isPortalNsmDsmCycleMonth(value: string): boolean {
  return CYCLE_MONTH.test(value.trim());
}

/**
 * Each month downloads as its own workbook (the weekly grid is keyed by week-of-month, so two months
 * in one book would add W1 of one to W1 of the other), and the route allows ten downloads a minute.
 * Six leaves room for a retry inside the same minute.
 */
export const PORTAL_NSM_DSM_MAX_MONTHS = 6;

/**
 * The months to export, oldest first.
 *
 *  - Month filter set to include some months → those months.
 *  - Month filter set to exclude some months → every offered month except those.
 *  - Month filter empty → the newest OFFERED month. The page shows every month when nothing is
 *    picked, so there is no single month to follow; the newest one is the one he opens it for, and
 *    it comes from the same list he can see in the filter — never from a server-side guess, which
 *    once picked a month holding a single stray Direct order.
 *
 * `available` is the Month filter's own option list (newest first as the loader returns it).
 */
export function portalNsmDsmExportMonths(input: {
  available: readonly string[];
  mode: "include" | "exclude";
  selected: readonly string[];
}): string[] {
  const available = [...new Set(input.available.map((code) => code.trim()).filter(isPortalNsmDsmCycleMonth))]
    .sort()
    .reverse();
  const selected = new Set(input.selected.map((code) => code.trim()).filter(isPortalNsmDsmCycleMonth));

  let months: string[];
  if (selected.size === 0) {
    months = available.slice(0, 1);
  } else if (input.mode === "exclude") {
    months = available.filter((code) => !selected.has(code));
  } else {
    months = [...selected];
  }
  return months.sort();
}
