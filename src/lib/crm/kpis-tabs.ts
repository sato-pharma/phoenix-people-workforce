/**
 * The KPIs board's four tabs — ids, labels, and the URL resolver.
 *
 * DELIBERATELY DEPENDENCY-FREE, and this is load-bearing rather than tidiness. The tab strip is a
 * `"use client"` component, so every RUNTIME value it imports drags that module's whole dependency
 * chain into the browser bundle. Importing these constants from kpis-board.ts would pull
 * getRepDoctorLists → the Supabase admin client → `node:crypto`, and the page 500s with
 * `UnhandledSchemeError: Reading from "node:crypto"`.
 *
 * That exact failure happened on 2026-09-01 with the Reps Weekly Plans status filter, and it is
 * invisible to `tsc` — a cold typecheck passed clean minutes before the page broke. Type-only
 * imports are erased and remain safe; VALUES must come from here.
 */

/** Tab ids, in the order the strip renders them. */
export const KPI_TABS = ["summary", "call-rate", "coverage", "frequency"] as const;

export type KpiTab = (typeof KPI_TABS)[number];

/** What each tab is called on screen. The owner named all four. */
export const KPI_TAB_LABEL: Record<KpiTab, string> = {
  summary: "Summary",
  "call-rate": "Call Rate",
  coverage: "Coverage",
  frequency: "Frequency",
};

/**
 * One line under each tab heading saying what the number MEANS, in the owner's own terms.
 *
 * These are on the page rather than in a tooltip on purpose: the three KPIs disagree by design
 * (a rep can be 100% covered and 39% on-frequency), and a manager who does not know why reads the
 * gap as a bug in the board.
 */
export const KPI_TAB_HINT: Record<KpiTab, string> = {
  summary: "All three KPIs, one row per medical rep. Managers are not on this board.",
  "call-rate": "Calls per working day. Saturday to Wednesday, minus national holidays.",
  coverage: "How much of the planned doctor list has been reached at all this month.",
  frequency: "Whether each doctor was seen the number of times the plan asked for. Exact is the only pass.",
};

/**
 * Resolves the `?tab=` parameter, falling back to Summary.
 *
 * An unrecognised value WIDENS to the default rather than rendering an empty shell — the same rule
 * the plan-status filter follows, and for the same reason: a blank board reads as "there is nothing
 * here", which is a statement about the reps rather than about the URL.
 */
export function resolveKpiTab(raw: string | null | undefined): KpiTab {
  const value = raw?.trim().toLowerCase() ?? "";
  return (KPI_TABS as readonly string[]).includes(value) ? (value as KpiTab) : "summary";
}
