import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { kpisCallRateHref, kpiCallRateRepPath, PORTAL_KPIS_PATH } from "../src/lib/crm/kpis-call-rate-route.ts";
import { buildKpisQuery, EMPTY_KPI_FILTERS } from "../src/lib/crm/kpis-filters.ts";
import {
  isKpiReportTab,
  KPI_CALL_RATE_VIEW_LABEL,
  KPI_CALL_RATE_VIEWS,
  KPI_REPORT_TABS,
  KPI_TABS,
  PORTAL_KPI_REPORT_PATH,
  PORTAL_KPI_SUMMARY_TABS,
  resolveKpiCallRateView,
} from "../src/lib/crm/kpis-tabs.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal's KPIs, split into a summary and three reports (owner, 2026-10-14): "KPIs to be a title in
 * the sidebar and under it a report called frequency, another called coverage, and another called call
 * rate … leave the KPIs report only for the summaries and consolidations."
 *
 * What each block pins, because every one of these fails as a PLAUSIBLE screen rather than an error:
 *
 *   1. THE SPLIT IS A PARTITION. A tab that left the summary page but has no page of its own, or one that
 *      stayed on both, is a measure a manager can no longer reach or reads twice.
 *   2. THE URL. `view` rides only on the call-rate report and only when it is not Total; `rep` rides on
 *      Coverage and Frequency (one list, read two ways) and nowhere else. A stray value carried along
 *      opens a view the page never asked for.
 *   3. THE OLD ADDRESSES STILL ARRIVE. A bookmark, a notification or a drill-down's Back still names
 *      `?tab=coverage`; the summary page forwards it with everything else it carried.
 *   4. THE GATES. A report is the same board sliced by measure, so it carries the same gates as the KPIs
 *      page — never a looser one.
 *   5. THE SIDEBAR. KPIs is a heading of its own with the summary and the three reports beneath it, one
 *      flag for all four, and the catalog and registry follow so search, the tab title and the phone
 *      bottom bar reach them.
 *   6. THE CALL RATE IS NEVER AVERAGED (owner, 2026-09-04: "Don't never get average"). The Total view lays
 *      AM and PM side by side beside a count of calls.
 */

const read = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => stripComments(read(path));

/** The sidebar's own sections with the hrefs each declares, re-derived from the layout's source. */
function sidebarSections(): { hrefs: string[]; title: string }[] {
  const source = read("src/components/employee-portal/employee-portal-layout.tsx");
  const start = source.indexOf("}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {");
  assert.ok(start > 0, "buildEmployeePortalSections must still be findable in the layout");
  const end = source.indexOf(".filter(", start);
  assert.ok(end > start, "the section builder must still end with its empty-section filter");
  const sections: { hrefs: string[]; title: string }[] = [];
  const pattern = /title:\s*"([^"]+)"|href:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source.slice(start, end))) !== null) {
    if (match[1]) sections.push({ hrefs: [], title: match[1] });
    else if (match[2] && sections.length > 0) sections[sections.length - 1]!.hrefs.push(match[2]);
  }
  return sections;
}

export function runKpisReportsSplitTests() {
  // ── 1. The split is a partition of the tabs the board knows ───────────────────────────────────
  assert.deepEqual([...KPI_REPORT_TABS], ["frequency", "coverage", "call-rate"], "the three reports, in the sidebar's order");
  for (const tab of [...PORTAL_KPI_SUMMARY_TABS, ...KPI_REPORT_TABS]) {
    assert.ok((KPI_TABS as readonly string[]).includes(tab), `${tab} is a tab the board knows`);
  }
  assert.deepEqual(
    [...PORTAL_KPI_SUMMARY_TABS, ...KPI_REPORT_TABS].sort(),
    [...KPI_TABS].sort(),
    "every tab is either on the summary page or a report of its own — none lost, none on both",
  );
  assert.ok(PORTAL_KPI_SUMMARY_TABS.includes("summary"), "the summary page keeps the Summary tab");
  for (const tab of KPI_REPORT_TABS) {
    assert.equal(isKpiReportTab(tab), true, `${tab} is a report`);
    assert.equal(PORTAL_KPI_REPORT_PATH[tab], `/employee-portals/kpis/${tab}`, `${tab} lives at its own address`);
    assert.ok(existsSync(`app/employee-portals/kpis/${tab}/page.tsx`), `${tab} has a page`);
    assert.ok(existsSync(`app/employee-portals/kpis/${tab}/loading.tsx`), `${tab} has a loading state`);
    assert.match(
      read(`app/employee-portals/kpis/${tab}/page.tsx`),
      new RegExp(`<PortalKpiReportPage report="${tab}"`),
      `${tab}'s page renders the shared report page for ${tab}`,
    );
  }
  for (const tab of PORTAL_KPI_SUMMARY_TABS) assert.equal(isKpiReportTab(tab), false, `${tab} stays on the summary page`);

  // ── 2. The URL ────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual([...KPI_CALL_RATE_VIEWS], ["total", "am", "pm"], "Total first, then the morning and the afternoon");
  assert.deepEqual(KPI_CALL_RATE_VIEW_LABEL, { total: "Total", am: "AM", pm: "PM" });
  assert.equal(resolveKpiCallRateView(undefined), "total");
  assert.equal(resolveKpiCallRateView("PM"), "pm", "case does not matter");
  assert.equal(resolveKpiCallRateView("both"), "total", "an unknown view widens to Total, never a blank board");

  const base = { month: "2026-10", period: "month", filters: EMPTY_KPI_FILTERS };
  assert.equal(buildKpisQuery({ ...base, tab: "call-rate", view: "pm" }).includes("view=pm"), true, "the view rides on Call Rate");
  assert.equal(buildKpisQuery({ ...base, tab: "call-rate", view: "total" }).includes("view="), false, "Total is the default and is omitted");
  assert.equal(buildKpisQuery({ ...base, tab: "coverage", view: "pm" }).includes("view="), false, "and it rides nowhere else");
  assert.equal(buildKpisQuery({ ...base, tab: "frequency", rep: "hr:b-1" }).includes("rep=hr%3Ab-1"), true, "the open rep rides on Frequency");
  assert.equal(buildKpisQuery({ ...base, tab: "coverage", rep: "hr:b-1" }).includes("rep=hr%3Ab-1"), true, "and on Coverage");
  assert.equal(buildKpisQuery({ ...base, tab: "call-rate", rep: "hr:b-1" }).includes("rep="), false, "but not on Call Rate");

  // ── 3. The old addresses still arrive ─────────────────────────────────────────────────────────
  const summaryPage = code("app/employee-portals/kpis/page.tsx");
  assert.match(summaryPage, /isKpiReportTab\(tab\)/, "the summary page recognises a retired tab");
  assert.match(summaryPage, /redirect\(`\$\{PORTAL_KPI_REPORT_PATH\[tab\]\}/, "and forwards it to that report");
  assert.match(summaryPage, /tabs=\{PORTAL_KPI_SUMMARY_TABS\}/, "and draws only the consolidated tabs");

  // The retired call-rate addresses (Reps Plans, Reps List) land on the portal's page, not on a tab.
  assert.equal(
    kpisCallRateHref({ basePath: PORTAL_KPIS_PATH, query: { month: "2026-09" } }),
    "/employee-portals/kpis/call-rate?month=2026-09",
    "the portal has a Call Rate page, so no `?tab=` is written",
  );
  assert.equal(
    kpisCallRateHref({ basePath: "/admin/kpis", query: { month: "2026-09" } }),
    "/admin/kpis?month=2026-09&tab=call-rate",
    "the admin shell still reads the tab",
  );
  assert.equal(
    kpisCallRateHref({ basePath: PORTAL_KPIS_PATH, query: undefined, rep: "crm:7" }),
    "/employee-portals/kpis/call-rate/crm%3A7",
    "a rep's visits page stays under the KPIs root",
  );
  assert.equal(kpiCallRateRepPath(PORTAL_KPIS_PATH, "hr:b-1"), "/employee-portals/kpis/call-rate/hr%3Ab-1");

  // ── 4. The gates ──────────────────────────────────────────────────────────────────────────────
  const report = code("src/components/crm/portal-kpi-report-page.tsx");
  for (const [needle, why] of [
    ['resolveNavigationMode(access) !== "employee-portal"', "an admin-mode viewer is bounced to /overview, as on the KPIs page"],
    ["canSeeDoctorCoverage(access.role)", "the role gate"],
    ['canAccess(access, "crm_visits", "read")', "the permission gate"],
    ["logPortalFailure(", "a load failure leaves a row"],
    ["EmployeePortalEmptyState", "a refusal or a failure explains itself"],
    ['chrome="portal"', "the portal shell owns the heading"],
    ["includeReports: false", "the reports a page does not print are not loaded"],
  ] as const) {
    assert.ok(report.includes(needle), `the report page keeps: ${why}`);
  }
  assert.ok(!/error\.message/.test(report), "a raw error string never reaches the page");
  assert.match(report, /tabs=\{\[\]\}/, "a report is the measure itself, so it draws no tab strip");

  // ── 5. The sidebar, the catalog and the registry ──────────────────────────────────────────────
  const sections = sidebarSections();
  const kpis = sections.find((section) => section.title === "KPIs");
  assert.ok(kpis, "KPIs is a heading of its own in the portal sidebar");
  assert.deepEqual(
    kpis.hrefs,
    ["/employee-portals/kpis", "/employee-portals/kpis/frequency", "/employee-portals/kpis/coverage", "/employee-portals/kpis/call-rate"],
    "the summary, then Frequency, Coverage and Call Rate",
  );
  const fieldWork = sections.find((section) => section.title === "Field Work");
  assert.ok(fieldWork && !fieldWork.hrefs.includes("/employee-portals/kpis"), "and the KPIs row left Field Work for it");
  const layout = code("src/components/employee-portal/employee-portal-layout.tsx");
  assert.equal(
    (layout.match(/showKpisTab \? \[\{ href: "\/employee-portals\/kpis/g) ?? []).length,
    4,
    "one flag gates all four rows, so no seat gains or loses a door",
  );

  const registry = code("src/components/employee-portal/employee-portal-nav-registry.ts");
  const catalog = code("src/config/system-navigation.ts");
  for (const tab of KPI_REPORT_TABS) {
    const href = PORTAL_KPI_REPORT_PATH[tab];
    const registryRow = registry.split(/\r?\n/).find((line) => line.includes(`href: "${href}"`));
    assert.ok(registryRow, `${href} is in the portal nav registry`);
    assert.ok(registryRow.includes('flags: ["showKpisTab"]'), `${href} is gated by the KPIs flag in the registry`);
    assert.ok(!registryRow.includes("permission:"), `${href} records no permission copy: its gate is in the shared report page`);
    const catalogRow = catalog.split(/\r?\n/).find((line) => line.includes(`href: "${href}"`));
    assert.ok(catalogRow, `${href} is in the portal catalog, so search and the tab title reach it`);
    assert.ok(
      catalogRow.includes('permissions: [{ resource: "crm_visits", action: "read" }]'),
      `${href} asks the KPIs permission in the catalog`,
    );
  }
  // The catalog rows carry the KPIs row's role list verbatim.
  const rolesOf = (line: string | undefined) => /roles: (\[[^\]]*\])/.exec(line ?? "")?.[1];
  const catalogLines = catalog.split(/\r?\n/);
  const kpisRoles = rolesOf(catalogLines.find((line) => line.includes('href: "/employee-portals/kpis"')));
  assert.ok(kpisRoles, "the KPIs catalog row names its roles");
  for (const tab of KPI_REPORT_TABS) {
    assert.equal(
      rolesOf(catalogLines.find((line) => line.includes(`href: "${PORTAL_KPI_REPORT_PATH[tab]}"`))),
      kpisRoles,
      `${tab} is offered to exactly the seats the KPIs page is`,
    );
  }

  // ── 6. The call rate is never averaged ────────────────────────────────────────────────────────
  const view = code("src/components/crm/kpis-board-view.tsx");
  for (const name of ["CallRateViewSwitch", "CallRateSessionTiles", "CallRateTotalCounts", "CallRateSessionTable", "FrequencyDoctors"]) {
    assert.ok(view.includes(`function ${name}(`), `${name} is part of the board view`);
  }
  const totalCounts = /function CallRateTotalCounts\([\s\S]*?\r?\n}\r?\n/.exec(view)?.[0] ?? "";
  assert.ok(totalCounts.length > 200, "CallRateTotalCounts must still be findable");
  assert.ok(
    !/\/ ?2\b|average|mean\(/i.test(totalCounts),
    "the Total view counts calls and forms no rate out of AM and PM",
  );
  assert.ok(totalCounts.includes("Counts add up; the two rates above never do."), "and says so on the page");

  // ── 7. The Summary rows open the reports ──────────────────────────────────────────────────────
  const summaryLinks = /function summaryReportLinks\([\s\S]*?\r?\n}\r?\n/.exec(view)?.[0] ?? "";
  assert.ok(summaryLinks.length > 200, "summaryReportLinks must still be findable");
  assert.ok(summaryLinks.includes("PORTAL_KPIS_ROOT_PATH"), "the links exist on the portal's KPIs page only");
  assert.ok(summaryLinks.includes("PORTAL_KPI_REPORT_PATH[tab]"), "Coverage and Frequency go to their own pages");
  assert.ok(summaryLinks.includes("EMPTY_KPI_DOCTOR_FILTER"), "another report starts with the doctor filters clear");
  assert.ok(summaryLinks.includes("callRateVisitsLink"), "Call Rate reuses the existing visits drill-down");
  assert.ok(view.includes("action={summaryReportLinks(context, row)}"), "the desktop Summary rows carry them");
  assert.ok(view.includes("? summaryReportLinks(context, row)"), "and so do the phone cards");

  // ── 8. AM · PM and Pharmacies follow the board and count, never average ───────────────────────
  const tables = code("src/components/crm/kpi-reports-tables.tsx");
  assert.ok(tables.includes("function Tally("), "each table carries a Met / Below tally");
  assert.ok(tables.includes("no verdict"), "a rep with no list is 'no verdict', never Below");
  assert.ok(!/\.reduce\([^)]*\/ ?rows\.length|average|mean\(/i.test(tables), "the tally forms no team rate");
  assert.ok(tables.includes("rank(a.report) - rank(b.report)"), "rows follow the board's own order");
  assert.ok(view.includes("<AmPmKpiReportTables reports={board.kpiReports} reps={board.reps} />"), "AM · PM gets the board's reps");
  assert.ok(view.includes("<PharmacyKpiReportTables reports={board.kpiReports} reps={board.reps} />"), "Pharmacies too");
}
