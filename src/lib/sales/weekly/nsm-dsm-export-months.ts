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
 * The cycle month Cairo is in right now ("2026-10-01"). Numeric parts only, never a locale month
 * name, so the server and the browser render the same text.
 */
export function cairoCycleMonthNow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" })
    .formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year}-${month}-01`;
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
 *  - Month filter empty → the newest OFFERED month that is not later than `currentMonth`. The page
 *    shows every month when nothing is picked, so there is no single month to follow. A month
 *    AHEAD of today can be offered legitimately — Finance books a Direct order to a later sales
 *    month — and it must not become the default book: November 2026 was offered in October with a
 *    single order in it. When every offered month is ahead, the newest one is used.
 *
 * `available` is the Month filter's own option list (newest first as the loader returns it).
 */
export function portalNsmDsmExportMonths(input: {
  available: readonly string[];
  currentMonth?: string;
  mode: "include" | "exclude";
  selected: readonly string[];
}): string[] {
  const available = [...new Set(input.available.map((code) => code.trim()).filter(isPortalNsmDsmCycleMonth))]
    .sort()
    .reverse();
  const selected = new Set(input.selected.map((code) => code.trim()).filter(isPortalNsmDsmCycleMonth));

  let months: string[];
  if (selected.size === 0) {
    const current = (input.currentMonth ?? "").trim();
    const notAhead = isPortalNsmDsmCycleMonth(current) ? available.filter((code) => code <= current) : available;
    months = (notAhead.length > 0 ? notAhead : available).slice(0, 1);
  } else if (input.mode === "exclude") {
    months = available.filter((code) => !selected.has(code));
  } else {
    months = [...selected];
  }
  return months.sort();
}
