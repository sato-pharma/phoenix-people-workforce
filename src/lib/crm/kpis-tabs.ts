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

/**
 * Tab ids, in the order the strip renders them.
 *
 * The first four slice the board by KPI and were specified by the owner on 2026-09-02 ("show four
 * tabs. The first tab is the summary..."), so their order is his and is not rearranged. The last
 * two slice it by POPULATION instead — they are the two reports he asked for on 2026-09-05, each
 * carrying all three KPIs for one list. They are appended rather than interleaved precisely
 * because the two axes are different: mixing them into the original four would make the strip read
 * as one list of six comparable things.
 *
 * WEEKLY is a third axis — TIME — and is appended last for the same reason (owner, 2026-09-22: "track
 * them by week. So week one ... week two, week three ... and the total consolidated month of those
 * three"). It carries the same three KPIs as Summary, cut into the month's weeks beside the month
 * they add up to, or into months beside their quarter or semester. See crm/kpis-trend.ts.
 */
export const KPI_TABS = ["summary", "call-rate", "coverage", "frequency", "am-pm", "pharmacies", "weekly"] as const;

export type KpiTab = (typeof KPI_TABS)[number];

/** What each tab is called on screen. The owner named all four. */
export const KPI_TAB_LABEL: Record<KpiTab, string> = {
  summary: "Summary",
  "call-rate": "Call Rate",
  coverage: "Coverage",
  frequency: "Frequency",
  // The separator is a middle dot, never a slash. The owner read "1.63 / 6.57" as "1.63 out of
  // 6.57" — a slash between two independent measures reads as a fraction.
  "am-pm": "AM · PM",
  pharmacies: "Pharmacies",
  weekly: "Weekly",
};

/**
 * One line under each tab heading saying what the number MEANS, in the owner's own terms.
 *
 * These are on the page rather than in a tooltip on purpose: the three KPIs disagree by design
 * (a rep can be 100% covered and 39% on-frequency), and a manager who does not know why reads the
 * gap as a bug in the board.
 */
export const KPI_TAB_HINT: Record<KpiTab, string> = {
  // Owner, 2026-10-20: "add manager row". The rep rows are still medical reps only; each manager
  // gets a row of averages in a section of his own below them (crm/kpis-manager-rows.ts).
  summary:
    "All three KPIs, one row per medical rep. Below them, one row per manager: each figure the average of the rows directly beneath that manager.",
  "call-rate": "Calls per working day. Saturday to Wednesday, minus national holidays.",
  coverage: "How much of the planned doctor list has been reached at all this month.",
  frequency: "Whether each doctor was seen the number of times the plan asked for. Exact is the only pass.",
  // These two say "against his LIST" on purpose. The four tabs above measure against the rep's
  // PLAN; these measure against the whole panel the CRM assigned him, which is what the owner meant
  // by "whole panel visisted one is the coverage". Two different denominators, so the wording has
  // to make clear which one a number came from.
  "am-pm": "All three KPIs against their AM and PM lists, reported apart and never averaged.",
  pharmacies: "All three KPIs against their pharmacy list. A rep with no pharmacies is not applicable, not a zero.",
  weekly:
    "Call rate, coverage and frequency week by week, beside the month those weeks add up to — or month by month beside the quarter or semester.",
};

/** The hints that change once the Phoenix KPI rules score a period (phase 6, after the CRM cutover). */
export const KPI_TAB_HINT_PHOENIX: Partial<Record<KpiTab, string>> = {
  "call-rate":
    "Every submitted regular visit per working day, Saturday to Wednesday minus national holidays. GPS is evidence only.",
  coverage: "Planned doctors in the period with at least one visit, out of the planned doctors in it.",
  frequency: "Whether each graded doctor got the visits their grade asks for: A 3, B 2, C 1. Extra visits are fine.",
};

/**
 * THE PORTAL SPLIT (owner, 2026-10-14: "KPIs to be a title in the sidebar and under it a report called
 * frequency, another called coverage, and another called call rate … leave the KPIs report only for
 * the summaries and consolidations"). In the employee portal the three measures each have a page of
 * their own and the KPIs page keeps only the consolidated tabs. The admin shell is untouched and still
 * carries all seven tabs.
 */
export const PORTAL_KPI_SUMMARY_TABS = ["summary", "am-pm", "pharmacies", "weekly"] as const satisfies readonly KpiTab[];

/** The three tabs that left the portal's KPIs page for a page each, in the sidebar's order. */
export const KPI_REPORT_TABS = ["frequency", "coverage", "call-rate"] as const satisfies readonly KpiTab[];

export type KpiReportTab = (typeof KPI_REPORT_TABS)[number];

export function isKpiReportTab(tab: KpiTab): tab is KpiReportTab {
  return (KPI_REPORT_TABS as readonly string[]).includes(tab);
}

/** Where each report lives in the employee portal. */
export const PORTAL_KPI_REPORT_PATH: Record<KpiReportTab, string> = {
  frequency: "/employee-portals/kpis/frequency",
  coverage: "/employee-portals/kpis/coverage",
  "call-rate": "/employee-portals/kpis/call-rate",
};

/** The portal KPIs page's own address — the summary, and the root the call-rate drill-down hangs under. */
export const PORTAL_KPIS_ROOT_PATH = "/employee-portals/kpis";

/**
 * The call-rate report's three views: the whole picture, the morning, the afternoon.
 *
 * TOTAL IS NOT A BLENDED RATE. The owner's rule of 2026-09-04 ("this two and this ten. Don't never
 * get average") still holds, so the total view lays AM and PM side by side — each against its own
 * target — beside the count of calls logged, and never forms one percentage out of the two.
 */
export const KPI_CALL_RATE_VIEWS = ["total", "am", "pm"] as const;

export type KpiCallRateView = (typeof KPI_CALL_RATE_VIEWS)[number];

export const KPI_CALL_RATE_VIEW_LABEL: Record<KpiCallRateView, string> = {
  total: "Total",
  am: "AM",
  pm: "PM",
};

/** `?view=`, falling back to Total — an unknown value widens to the default, never a blank board. */
export function resolveKpiCallRateView(raw: string | null | undefined): KpiCallRateView {
  const value = raw?.trim().toLowerCase() ?? "";
  return (KPI_CALL_RATE_VIEWS as readonly string[]).includes(value) ? (value as KpiCallRateView) : "total";
}

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
