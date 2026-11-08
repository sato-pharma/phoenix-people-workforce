/**
 * The Regional Sales Manager's team reports — one shortcut per report on his overview landing page, in the order
 * Dr. Hany Saad listed his needs (owner, 2026-11-08: "make a shortcut in his overview landing page for every
 * report … use what we already use … he presses on the report, he is redirected to the report").
 *
 * Every label is a name Phoenix already shows for that page — the sidebar row, the tab or the page title — never a
 * new expression. Pure, so the list and its order are pinned by a test.
 */

export type RegionalTeamReportKey =
  | "reps-plans"
  | "team-visits"
  | "coverage"
  | "coverage-last-month"
  | "frequency-last-month"
  | "district-manager-plans"
  | "region-plans"
  | "weekly-sheet"
  | "roi-tracking";

export type RegionalTeamReportLink = { key: RegionalTeamReportKey; href: string; label: string };

/** "2026-11" → "2026-10"; "2026-01" → "2025-12". */
export function previousMonthKey(cairoTodayIso: string): string {
  const year = Number(cairoTodayIso.slice(0, 4));
  const month = Number(cairoTodayIso.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return cairoTodayIso.slice(0, 7);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** The shortcuts, in Dr. Hany's order. `cairoTodayIso` is today in Cairo, "YYYY-MM-DD". */
export function regionalTeamReportLinks(cairoTodayIso: string): RegionalTeamReportLink[] {
  const lastMonth = previousMonthKey(cairoTodayIso);
  return [
    // 1 — the reps' plans: the Reps List's own "Reps weekly plans" tab.
    { href: "/employee-portals/reps-list?tab=plans", key: "reps-plans", label: "Reps weekly plans" },
    // 2 — yesterday's and today's visits with the time each was saved.
    { href: "/employee-portals/team-visits", key: "team-visits", label: "Visits — Yesterday and Today" },
    // 3 — plan coverage: the KPIs Coverage report, this month.
    { href: "/employee-portals/kpis/coverage", key: "coverage", label: "Coverage" },
    // 4 — last month's coverage (who was not covered) and visit frequency.
    { href: `/employee-portals/kpis/coverage?month=${lastMonth}`, key: "coverage-last-month", label: "Coverage · Last month" },
    { href: `/employee-portals/kpis/frequency?month=${lastMonth}`, key: "frequency-last-month", label: "Frequency · Last month" },
    // 5 — the district managers' plans, with who else is with each rep.
    { href: "/employee-portals/district-manager-plans", key: "district-manager-plans", label: "District Managers' Plans" },
    // 6 — his own plan board in Phoenix CRM, where picking a district manager shows that manager's day. Never the
    // old "Weekly / Monthly Plans" form: it is read-only history now. The words are that page's own link to the board.
    { href: "/employee-portals/field-crm?tab=plan", key: "region-plans", label: "Plan your week in Phoenix CRM" },
    // 7 — the weekly sheet.
    { href: "/employee-portals/weekly-sheet", key: "weekly-sheet", label: "Weekly Sheet" },
    // 8 — the ROI of the requests in his region.
    { href: "/employee-portals/marketing-requests/roi-tracking", key: "roi-tracking", label: "ROI Tracking" },
  ];
}
