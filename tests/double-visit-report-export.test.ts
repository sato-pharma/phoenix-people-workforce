import assert from "node:assert/strict";

import {
  ALL,
  buildReportSummaryMetrics,
  filterLogRows,
  filterNeverVisitedRows,
  filterProbationRows,
  formatActiveFilters,
} from "../src/lib/double-visit-analytics/report-filters.ts";
import { buildDoubleVisitReportPdf, buildDoubleVisitReportPdfDocDefinition } from "../src/lib/double-visit-analytics/report-pdf.ts";
import { buildDoubleVisitReportExportWorkbook } from "../src/lib/double-visit-analytics/service.ts";
import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusRosterEntry,
  DoubleVisitReportData,
  DoubleVisitReportRow,
} from "../src/lib/double-visit-analytics/types.ts";

function logRow(input: Partial<DoubleVisitReportRow> & Pick<DoubleVisitReportRow, "activityDate">): DoubleVisitReportRow {
  return {
    activityDate: input.activityDate,
    areaName: input.areaName ?? null,
    daysSinceVisitedHire: input.daysSinceVisitedHire ?? null,
    doubleVisitorHrId: input.doubleVisitorHrId ?? null,
    doubleVisitorName: input.doubleVisitorName ?? null,
    doubleVisitorRole: input.doubleVisitorRole ?? null,
    lineName: input.lineName ?? null,
    period: input.period ?? "PM",
    regionName: input.regionName ?? null,
    visitCount: input.visitCount ?? 1,
    visitedEmployeeHireDate: input.visitedEmployeeHireDate ?? null,
    visitedHrId: input.visitedHrId ?? null,
    visitedName: input.visitedName ?? null,
    visitedStatus: input.visitedStatus ?? "active_mapped",
    visitKind: input.visitKind ?? "Regular",
  };
}

const LOG_ROWS: DoubleVisitReportRow[] = [
  logRow({
    activityDate: "2026-06-01",
    areaName: "North Cairo",
    doubleVisitorHrId: "B-100",
    doubleVisitorName: "Sara.Fahmy",
    doubleVisitorRole: "District Manager",
    period: "AM",
    regionName: "Cairo",
    visitCount: 2,
    visitedHrId: "B-201",
    visitedName: "Ahmed Nabil",
    visitKind: "Regular",
  }),
  logRow({
    activityDate: "2026-06-02",
    areaName: "South Giza",
    doubleVisitorHrId: "B-101",
    doubleVisitorName: "Mona.Adel",
    doubleVisitorRole: "Regional Manager",
    period: "PM",
    regionName: "Giza",
    visitCount: 3,
    visitedHrId: "B-202",
    visitedName: "Karim Sherif",
    visitKind: "Unplanned",
  }),
  logRow({
    activityDate: "2026-06-03",
    areaName: "North Cairo",
    doubleVisitorHrId: "B-100",
    doubleVisitorName: "Sara.Fahmy",
    doubleVisitorRole: "District Manager",
    period: "PM",
    regionName: "Cairo",
    visitCount: 1,
    visitedHrId: "B-203",
    visitedName: "Nour Hassan",
    visitKind: "Regular",
  }),
];

const NEVER_VISITED_ROWS: DoubleVisitFocusRosterEntry[] = [
  { areaName: "North Cairo", daysSinceHire: 60, flagged: true, hireDate: "2026-04-01", hrId: "B-301", name: "Yasmin Adly", visited: false },
  { areaName: "South Giza", daysSinceHire: 10, flagged: false, hireDate: "2026-05-20", hrId: "B-302", name: "Omar Khaled", visited: false },
];

const PROBATION_ROWS: DoubleVisitFocusProbationEntry[] = [
  { daysRemaining: 5, dvCount: 2, dvDone: true, hireDate: "2026-04-01", hrId: "B-401", name: "Laila Samir", probationEndDate: "2026-07-15" },
  { daysRemaining: 12, dvCount: 0, dvDone: false, hireDate: "2026-05-01", hrId: "B-402", name: "Tarek Fouad", probationEndDate: "2026-08-01" },
  { daysRemaining: 20, dvCount: 1, dvDone: null, hireDate: "2026-05-10", hrId: "B-403", name: "Nadia Emad", probationEndDate: "2026-08-10" },
];

function reportData(overrides: Partial<DoubleVisitReportData> = {}): DoubleVisitReportData {
  return {
    asOfDate: "2026-07-06",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-30",
    filters: { areas: ["North Cairo", "South Giza"], doubleVisitorRoles: ["District Manager", "Regional Manager"], doubleVisitors: ["Sara.Fahmy", "Mona.Adel"], regions: ["Cairo", "Giza"], visitKinds: ["Regular", "Unplanned"] },
    neverVisited: NEVER_VISITED_ROWS,
    probation: PROBATION_ROWS,
    roster: [],
    rows: LOG_ROWS,
    schemaReady: true,
    ...overrides,
  };
}

const NO_LOG_FILTERS = { areaFilter: ALL, periodFilter: ALL, regionFilter: ALL, roleFilter: ALL, search: "", visitKindFilter: ALL, visitorFilter: ALL };
const NO_NEVER_VISITED_FILTERS = { areaFilter: ALL, flaggedOnly: false, search: "" };
const NO_PROBATION_FILTERS: { dvStatusFilter: "ALL" | "done" | "pending"; search: string } = { dvStatusFilter: ALL as "ALL", search: "" };

export async function runDoubleVisitReportExportTests() {
  // ── filterLogRows ──────────────────────────────────────────────────────────
  assert.equal(filterLogRows(LOG_ROWS, NO_LOG_FILTERS).length, 3, "no filters returns every row");

  assert.deepEqual(
    filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, areaFilter: "North Cairo" }).map((r) => r.visitedName),
    ["Ahmed Nabil", "Nour Hassan"],
    "areaFilter narrows to matching area only",
  );
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, regionFilter: "Giza" }).length, 1, "regionFilter narrows to matching region");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, roleFilter: "Regional Manager" }).length, 1, "roleFilter narrows to matching job title");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, visitorFilter: "Sara.Fahmy" }).length, 2, "visitorFilter narrows to matching double-visitor");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, visitKindFilter: "Unplanned" }).length, 1, "visitKindFilter narrows to matching type");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, periodFilter: "AM" }).length, 1, "periodFilter narrows to matching period");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, search: "ahmed" }).length, 1, "search is case-insensitive and matches visited name");
  assert.equal(filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, search: "B-203" }).length, 1, "search matches visited HR ID");
  assert.equal(
    filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, search: "B-100" }).length,
    0,
    "search does not match the double-visitor's HR ID (only their name), matching the on-screen behavior exactly",
  );
  assert.equal(
    filterLogRows(LOG_ROWS, { ...NO_LOG_FILTERS, areaFilter: "North Cairo", periodFilter: "PM" }).length,
    1,
    "combined filters intersect (AND semantics)",
  );

  // ── filterNeverVisitedRows ─────────────────────────────────────────────────
  assert.equal(filterNeverVisitedRows(NEVER_VISITED_ROWS, NO_NEVER_VISITED_FILTERS).length, 2, "no filters returns every roster entry");
  assert.equal(
    filterNeverVisitedRows(NEVER_VISITED_ROWS, { ...NO_NEVER_VISITED_FILTERS, areaFilter: "South Giza" }).length,
    1,
    "areaFilter narrows the never-visited roster",
  );
  assert.deepEqual(
    filterNeverVisitedRows(NEVER_VISITED_ROWS, { ...NO_NEVER_VISITED_FILTERS, flaggedOnly: true }).map((r) => r.name),
    ["Yasmin Adly"],
    "flaggedOnly keeps only overdue (45+ day) entries",
  );
  assert.equal(filterNeverVisitedRows(NEVER_VISITED_ROWS, { ...NO_NEVER_VISITED_FILTERS, search: "omar" }).length, 1, "search matches name case-insensitively");

  // ── filterProbationRows ────────────────────────────────────────────────────
  assert.equal(filterProbationRows(PROBATION_ROWS, NO_PROBATION_FILTERS).length, 3, "no filters returns every probation entry");
  assert.deepEqual(
    filterProbationRows(PROBATION_ROWS, { ...NO_PROBATION_FILTERS, dvStatusFilter: "done" }).map((r) => r.name),
    ["Laila Samir"],
    "'done' keeps only dvDone === true",
  );
  assert.deepEqual(
    filterProbationRows(PROBATION_ROWS, { ...NO_PROBATION_FILTERS, dvStatusFilter: "pending" }).map((r) => r.name),
    ["Tarek Fouad"],
    "'pending' keeps only dvDone === false",
  );
  assert.equal(
    filterProbationRows(PROBATION_ROWS, { ...NO_PROBATION_FILTERS, dvStatusFilter: "done" }).some((r) => r.dvDone === null),
    false,
    "a null dvDone (role has no dedicated DV checkbox) is excluded from both 'done' and 'pending', only visible under ALL",
  );

  // ── buildReportSummaryMetrics / formatActiveFilters ───────────────────────
  const filtered = { logRows: LOG_ROWS, neverVisitedRows: NEVER_VISITED_ROWS, probationRows: PROBATION_ROWS };
  const metrics = buildReportSummaryMetrics(filtered);
  const metricValue = (label: string) => metrics.find((m) => m.metric === label)?.value;
  assert.equal(metricValue("Total Visits (filtered)"), 6, "total visits sums visitCount across filtered rows");
  assert.equal(metricValue("Distinct Double-Visitors"), 2, "distinct double-visitor count");
  assert.equal(metricValue("Distinct Visited MRs"), 3, "distinct visited-MR count");
  assert.equal(metricValue("AM Visits"), 2, "AM visit sum");
  assert.equal(metricValue("PM Visits"), 4, "PM visit sum");
  assert.equal(metricValue("Pharmacy Visits"), 0, "no pharmacy rows in the base fixture");

  // THE AM · PM · PHARMACIES GOLDEN RULE: a pharmacy row the CRM tagged PM counts under Pharmacy
  // Visits only, and the Period filter lists and finds it under "Pharmacies", never under PM.
  const pharmacyRow: DoubleVisitReportRow = { ...logRow({ activityDate: "2026-06-09", period: "PM", visitCount: 5 }), countBucket: "Pharmacies" };
  const withPharmacy = buildReportSummaryMetrics({ ...filtered, logRows: [...LOG_ROWS, pharmacyRow] });
  const withPharmacyValue = (label: string) => withPharmacy.find((m) => m.metric === label)?.value;
  assert.equal(withPharmacyValue("PM Visits"), 4, "a pharmacy visit tagged PM is never counted among the PM doctors");
  assert.equal(withPharmacyValue("Pharmacy Visits"), 5, "a pharmacy visit is counted under Pharmacy Visits");
  assert.deepEqual(
    filterLogRows([...LOG_ROWS, pharmacyRow], { ...NO_LOG_FILTERS, periodFilter: "Pharmacies" }),
    [pharmacyRow],
    "the Pharmacies period filter finds the pharmacy row",
  );
  assert.equal(
    filterLogRows([...LOG_ROWS, pharmacyRow], { ...NO_LOG_FILTERS, periodFilter: "PM" }).includes(pharmacyRow),
    false,
    "the PM period filter never returns a pharmacy row",
  );
  assert.equal(metricValue("Regular Visits"), 3, "Regular visit sum");
  assert.equal(metricValue("Unplanned Visits"), 3, "Unplanned visit sum");
  assert.equal(metricValue("Never Visited / At Risk (filtered)"), 2);
  assert.equal(metricValue("Probation Watchlist (filtered)"), 3);

  assert.equal(formatActiveFilters({}), "None", "no active filters formats as None");
  assert.equal(formatActiveFilters({ Area: "North Cairo", Search: "" }), "Area: North Cairo", "blank values are dropped");

  // ── xlsx workbook smoke test ───────────────────────────────────────────────
  const workbook = await buildDoubleVisitReportExportWorkbook(reportData(), filtered, { Area: "North Cairo" });
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  assert.deepEqual(sheetNames, ["Executive Summary", "Visit Log", "Never Visited", "Probation Watchlist"], "workbook has all four expected sheets");
  const logSheet = workbook.getWorksheet("Visit Log");
  assert.ok(logSheet);
  assert.equal(logSheet.rowCount, LOG_ROWS.length + 1, "Visit Log sheet has one row per filtered visit plus the header row");

  // ── pdf builder smoke test ─────────────────────────────────────────────────
  const buffer = await buildDoubleVisitReportPdf(reportData(), filtered, { Area: "North Cairo" }, "log");
  assert.ok(buffer.length > 0, "pdf buffer is non-empty");
  assert.equal(buffer.subarray(0, 4).toString("latin1"), "%PDF", "output starts with the PDF magic bytes");

  // Truncation notice must appear once the preview cap (50 rows) is exceeded, and must not
  // appear otherwise — no silent caps.
  const manyRows = Array.from({ length: 60 }, (_, i) => logRow({ activityDate: `2026-06-${(i % 28) + 1}`, visitedHrId: `B-9${i}` }));
  const truncatedDoc = buildDoubleVisitReportPdfDocDefinition(reportData(), { ...filtered, logRows: manyRows }, {}, "log");
  assert.match(JSON.stringify(truncatedDoc), /Showing 50 of 60 filtered rows/, "truncation notice appears and states the real total when capped");
  const untruncatedDoc = buildDoubleVisitReportPdfDocDefinition(reportData(), filtered, {}, "log");
  assert.doesNotMatch(JSON.stringify(untruncatedDoc), /Showing \d+ of \d+ filtered rows/, "no truncation notice when under the cap");
}
