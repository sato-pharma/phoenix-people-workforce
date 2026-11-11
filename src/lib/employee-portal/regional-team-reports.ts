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

/**
 * His own plan board in Phoenix CRM. Every Regional Sales Manager shortcut to "his plans" opens this, never
 * `/employee-portals/plans`: that is the old form's read-only history since the week moved to Phoenix CRM.
 */
export const RSM_PLAN_BOARD_HREF = "/employee-portals/field-crm?tab=plan";

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
    { href: RSM_PLAN_BOARD_HREF, key: "region-plans", label: "Plan your week in Phoenix CRM" },
    // 7 — the weekly sheet.
    { href: "/employee-portals/weekly-sheet", key: "weekly-sheet", label: "Weekly Sheet" },
    // 8 — the ROI of the requests in his region.
    { href: "/employee-portals/marketing-requests/roi-tracking", key: "roi-tracking", label: "ROI Tracking" },
  ];
}

/**
 * The same shortcuts on a District Manager's overview, each over that manager's own district (owner, 2026-11-09:
 * "all shortcuts we built for Hany, build it for all district managers, but every one based on his scope"). Same
 * pages, same order, same words — the scope is decided by each page's own gate, never by the link. One label
 * differs: District Managers' Plans is their own sent week beside their reps' days, so it reads "My Plans", the
 * title that page carries for a District Manager.
 */
export function districtTeamReportLinks(cairoTodayIso: string): RegionalTeamReportLink[] {
  return regionalTeamReportLinks(cairoTodayIso).map((link) =>
    link.key === "district-manager-plans" ? { ...link, label: "My Plans" } : link,
  );
}

/** What each shortcut answers, as the Team Reports band on /admin prints it under the title. */
export type AdminTeamReportLink = RegionalTeamReportLink & { headline: string };

/**
 * The same shortcuts on the Super Admin's overview (/admin), each over the WHOLE COMPANY and in the admin shell (owner,
 * 2026-11-11: "add for the admin the reports u added to hany saad in his overview dashboard"). Same order, same words.
 *
 * - Visits — Yesterday and Today, District Managers' Plans and the Weekly Sheet open their admin twins under
 *   /admin/field-crm, gated by `readsCompanyTeamReports`.
 * - Reps weekly plans, Coverage, Frequency and ROI Tracking open the admin pages the Super Admin already reads.
 * - "Plan your week in Phoenix CRM" is left out: it is the Regional Sales Manager's OWN planning board, and the Super
 *   Admin plans no week. Every district manager's week is on District Managers' Plans.
 */
export function adminTeamReportLinks(cairoTodayIso: string): AdminTeamReportLink[] {
  const lastMonth = previousMonthKey(cairoTodayIso);
  return [
    { headline: "Every rep's weekly plan", href: "/admin/reps-list?tab=plans", key: "reps-plans", label: "Reps weekly plans" },
    { headline: "Visits and the time each was saved", href: "/admin/field-crm/team-visits", key: "team-visits", label: "Visits — Yesterday and Today" },
    { headline: "Plan coverage, this month", href: "/admin/kpis?tab=coverage", key: "coverage", label: "Coverage" },
    { headline: "Who was not covered last month", href: `/admin/kpis?tab=coverage&month=${lastMonth}`, key: "coverage-last-month", label: "Coverage · Last month" },
    { headline: "Visit frequency, last month", href: `/admin/kpis?tab=frequency&month=${lastMonth}`, key: "frequency-last-month", label: "Frequency · Last month" },
    { headline: "Who is with each rep, each day", href: "/admin/field-crm/district-manager-plans", key: "district-manager-plans", label: "District Managers' Plans" },
    { headline: "PM and AM against the week's targets", href: "/admin/field-crm/weekly-sheet", key: "weekly-sheet", label: "Weekly Sheet" },
    { headline: "The return on every request", href: "/admin/marketing-requests/roi-tracking", key: "roi-tracking", label: "ROI Tracking" },
  ];
}
