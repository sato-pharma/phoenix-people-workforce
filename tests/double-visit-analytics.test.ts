import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyVisitedEmployeeStatus,
  extractEmployeeNameAreaLine,
  normalizeDoubleVisitExcelRows,
  normalizeIReports360DoubleVisits,
  recoverVisitedEmployeesByCrmUsername,
} from "../src/lib/double-visit-analytics/parser.ts";
import {
  buildExecutiveSummary,
  buildManagerMrPairs,
  buildManagerSummariesDetailed,
} from "../src/lib/double-visit-analytics/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { DoubleVisitKpis, DoubleVisitLogEntry } from "../src/lib/double-visit-analytics/types.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";

type DvRowInput = {
  area?: string | null;
  date: string;
  dvHrId: string;
  dvName?: string;
  line?: string | null;
  period?: "AM" | "PM" | "UNKNOWN";
  visit: number;
  visitedHrId?: string | null;
  visitedName?: string;
};

function dvRow(input: DvRowInput): Record<string, unknown> {
  return {
    activity_date: input.date,
    area_name: input.area ?? null,
    double_visitor_hr_id: input.dvHrId,
    double_visitor_name: input.dvName ?? null,
    id: `${input.dvHrId}-${input.date}-${input.visitedHrId ?? "x"}-${input.period ?? "PM"}-${input.visit}`,
    import_id: "imp",
    line_name: input.line ?? null,
    period: input.period ?? "PM",
    raw_payload: null,
    source_record_id: null,
    source_row_number: null,
    source_type: "excel",
    visit_count: input.visit,
    visited_employee_hr_id: input.visitedHrId ?? null,
    visited_employee_name: input.visitedName ?? null,
    visited_employee_status: input.visitedHrId ? "active_mapped" : "unmapped",
  };
}

type DvRows = Parameters<typeof buildManagerSummariesDetailed>[0];
const asRows = (rows: Array<Record<string, unknown>>) => rows as unknown as DvRows;

function logEntry(input: DvRowInput): DoubleVisitLogEntry {
  return {
    area: input.area ?? null,
    date: input.date,
    doubleVisitorHrId: input.dvHrId,
    doubleVisitorName: input.dvName ?? null,
    period: input.period ?? "PM",
    visitCount: input.visit,
    visitedHrId: input.visitedHrId ?? null,
    visitedName: input.visitedName ?? null,
    visitedStatus: "active_mapped",
  };
}

const zeroKpis: DoubleVisitKpis = {
  activeCalendarDays: 0,
  activeDoubleVisitDays: 0,
  activeMappedVisitCount: 0,
  amPmRatio: null,
  amVisitCount: 0,
  averageVisitsPerDoubleVisitDay: 0,
  averageVisitsPerDoubleVisitor: 0,
  doubleVisitorCount: 0,
  mrCoverageCount: 0,
  pmVisitCount: 0,
  totalVisits: 0,
  vacantOrUnmappedShare: 0,
  vacantOrUnmappedVisitCount: 0,
};

function row(input: {
  count: number;
  date?: string;
  doubleVisitorHrId?: string;
  doubleVisitorName?: string;
  employee?: string;
  hrId?: string;
  period?: string;
}) {
  return {
    "AM \\ PM": input.period ?? "PM",
    Count: input.count,
    Date: input.date ?? "2026-06-01",
    "DV HR ID": input.doubleVisitorHrId ?? "D-1",
    "Double Visit with": input.doubleVisitorName ?? "Double Visitor",
    Employee: input.employee ?? "Medical Rep ( Cairo East / P )",
    "HR ID": input.hrId ?? "M-1",
  };
}

function employee(input: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaName: null,
    crmId: null,
    departmentName: null,
    employmentStatus: "active",
    fullName: input.fullName ?? "Employee",
    hrId: input.hrId ?? "E-1",
    jobTitle: input.jobTitle ?? "Medical Representative",
    lineName: null,
    managerHrId: null,
    managerName: null,
    positionTitle: input.positionTitle ?? "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

export function runDoubleVisitAnalyticsTests() {
  assert.equal(classifyVisitedEmployeeStatus(""), "blank_hr_id");
  assert.equal(classifyVisitedEmployeeStatus("Vacant"), "vacant");
  assert.equal(classifyVisitedEmployeeStatus("resigned"), "resigned");
  assert.equal(classifyVisitedEmployeeStatus("#N/A"), "unmapped");
  assert.equal(classifyVisitedEmployeeStatus("A-10"), "active_mapped");

  const parsedName = extractEmployeeNameAreaLine("Ahmed Ali ( Cairo East / P )");
  assert.deepEqual(parsedName, {
    areaName: "Cairo East",
    lineName: "P",
    name: "Ahmed Ali",
    raw: "Ahmed Ali ( Cairo East / P )",
  });

  const preview = normalizeDoubleVisitExcelRows({
    fileName: "DSM DV.xlsx",
    rows: [
      row({ count: 2, hrId: "M-1", period: "AM" }),
      row({ count: 3, employee: "Vacant Territory ( Tanta / A )", hrId: "" }),
      row({ count: 5, employee: "Vacant ( Mahalla / C )", hrId: "Vacant" }),
      row({ count: 7, employee: "Former Rep ( Sohag / B )", hrId: "resigned", period: "AM" }),
      row({ count: 11, employee: "Unmapped Rep ( Assiut / P )", hrId: "#N/A" }),
    ],
    sheetName: "iReport_ (12)",
  });

  assert.equal(preview.summary.totalRows, 5, "parser must keep blank/vacant/resigned/unmapped rows");
  assert.equal(preview.summary.totalVisits, 28, "Count remains the official visit quantity");
  assert.equal(preview.summary.activeMappedVisitCount, 2, "only mapped visited employee rows count as active mapped");
  assert.equal(preview.summary.vacantOrUnmappedVisitCount, 26, "unmapped visited employee rows still count as double visitor effort");
  assert.equal(preview.summary.amVisitCount, 9, "AM split uses Count");
  assert.equal(preview.summary.pmVisitCount, 19, "PM split uses Count");
  assert.equal(preview.rows.filter((item) => item.visitedEmployeeHrId == null).length, 4);
  assert.ok(preview.rows.every((item) => item.doubleVisitorHrId === "D-1"), "effort is attributed to Double Visitor HR ID");

  // ── Vacant/blank HR ID recovered from the Employee name (crm_username) ───────
  const vacantPreview = normalizeDoubleVisitExcelRows({
    fileName: "DSM DV.xlsx",
    rows: [row({ count: 7, doubleVisitorHrId: "B-94", employee: "Fiby.Wagdy ( Fayoum / F )", hrId: "Vacant" })],
    sheetName: "s",
  });
  assert.equal(vacantPreview.rows[0]?.visitedEmployeeHrId, null, "raw parse leaves a Vacant HR ID unmapped");
  assert.equal(vacantPreview.summary.activeMappedVisitCount, 0);
  const recoveredPreview = recoverVisitedEmployeesByCrmUsername(vacantPreview, [
    employee({ crmUsername: "Fiby.Wagdy ( Fayoum / F )", fullName: "Fiby Wagdy Luka", hrId: "B-52" }),
  ]);
  assert.equal(recoveredPreview.rows[0]?.visitedEmployeeHrId, "B-52", "Vacant seat recovered to the real MR by crm_username");
  assert.equal(recoveredPreview.rows[0]?.visitedEmployeeStatus, "active_mapped");
  assert.equal(recoveredPreview.summary.activeMappedVisitCount, 7, "recovered visits now count toward the MR");
  const noRecovery = recoverVisitedEmployeesByCrmUsername(vacantPreview, [
    employee({ crmUsername: "Other.Person ( X / Y )", fullName: "Someone Else", hrId: "B-99" }),
  ]);
  assert.equal(noRecovery.rows[0]?.visitedEmployeeHrId, null, "no recovery without an exact crm_username match");

  // Unambiguous day-first text date must NOT be silently dropped as invalid.
  const dmyPreview = normalizeDoubleVisitExcelRows({
    fileName: "f.xlsx",
    rows: [row({ count: 1, date: "25/06/2026", doubleVisitorHrId: "B-1", hrId: "M-1" })],
    sheetName: "s",
  });
  assert.equal(dmyPreview.rows.length, 1, "dd/mm/yyyy text date row is kept, not skipped");
  assert.equal(dmyPreview.rows[0]?.activityDate, "2026-06-25", "dd/mm/yyyy (day>12) parses day-first");

  const live = normalizeIReports360DoubleVisits({
    employees: [
      employee({ crmId: "100", fullName: "Visitor One", hrId: "D-1" }),
      employee({ crmId: "200", fullName: "MR One", hrId: "M-1" }),
    ],
    fileName: "iReports360",
    visits: [
      {
        agentID: 200,
        agentName: "MR One",
        ampm: "AM",
        attendance: null,
        callType: null,
        comment: null,
        contactID: null,
        contactName: null,
        customerName: null,
        doubleID: 100,
        doubleName: "Visitor One",
        id: 10,
        saveDate: null,
        visitDate: "2026-06-02",
        visitType: 0,
        visitTypeDescription: null,
      },
      {
        agentID: 200,
        agentName: "MR One",
        ampm: "PM",
        attendance: null,
        callType: null,
        comment: null,
        contactID: null,
        contactName: null,
        customerName: null,
        doubleID: 0,
        doubleName: null,
        id: 11,
        saveDate: null,
        visitDate: "2026-06-02",
        visitType: 0,
        visitTypeDescription: null,
      },
    ] satisfies IReports360Visit[],
  });
  assert.equal(live.summary.totalRows, 1, "iReports360 import keeps only actual double visits");
  assert.equal(live.rows[0]?.doubleVisitorHrId, "D-1");
  assert.equal(live.rows[0]?.visitedEmployeeHrId, "M-1");
  assert.equal(live.rows[0]?.visitedEmployeeStatus, "active_mapped");

  const serviceSource = readFileSync("src/lib/double-visit-analytics/service.ts", "utf8");
  assert.match(serviceSource, /neq\("id", input\.importId\)/, "publishing must supersede every other official snapshot");
  assert.match(serviceSource, /double_visitor_hr_id\) === employeeKey/, "expense workload matching must use Double Visitor HR ID");
  assert.match(serviceSource, /loadDoubleVisitPrivateCalendarItems/, "private calendar must receive Double Visit evidence");
  assert.doesNotMatch(serviceSource, /DSM Dashboard/i, "module service must not use DSM dashboard naming");

  const migration = readFileSync("supabase/migrations/20260612172427_double_visit_analytics.sql", "utf8");
  assert.match(migration, /double_visit_imports/);
  assert.match(migration, /double_visit_rows/);
  assert.match(migration, /Vacant, resigned, blank, and unmapped visited employees are preserved/i);
  assert.match(migration, /workload_evidence_snapshot/);

  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(nav, /Double Visit Analytics/);
  assert.doesNotMatch(nav, /DSM Dashboard/i);

  const service = readFileSync("src/lib/double-visit-analytics/service.ts", "utf8");
  assert.match(service, /isAllowedDoubleVisitor\(/);
  assert.match(service, /filterRowsByAllowedDoubleVisitor\(/);
  assert.match(service, /isDisallowedExecutiveManager\(/);
  assert.match(service, /buildHeatmapRows\(mrScores, "areaName", areaBuckets\)/);
  assert.match(service, /buildHeatmapRows\(mrScores, "lineName", lineBuckets\)/);
  assert.match(service, /addWorksheet\("Manager Activity"\)/, "export must include a Manager Activity sheet");
  assert.match(service, /addWorksheet\("By Role"\)/, "export must include a By Role sheet");
  assert.match(service, /addWorksheet\("Insights"\)/, "export must include an Insights sheet");
  assert.match(service, /addWorksheet\("Manager × MR Pairs"\)/, "export must include a Manager × MR Pairs sheet");
  assert.match(service, /buildManagerMrPairs\(data\.visitLog\)/, "pairs sheet must be built from the visit log");
  assert.match(service, /getLatestPublishedImport\(/, "dashboard defaults to the published snapshot span");
  assert.match(service, /recoverVisitedEmployeesByCrmUsername\(/, "Excel import recovers Vacant/blank visited HR IDs by name");
  assert.match(service, /latestPublished\?\.dateFrom/, "default date range comes from the published import, not the current month");
  assert.match(service, /\.range\(from, from \+ pageSize/, "published rows must be paged past the PostgREST row cap, not truncated");
  assert.match(service, /row mismatch/i, "import verifies stored row count and rolls back on a partial write");
  assert.match(service, /zero total visits/i, "import aborts when rows parse to zero visits");

  const parser = readFileSync("src/lib/double-visit-analytics/parser.ts", "utf8");
  assert.match(parser, /missing the required Double Visit columns/i, "import rejects a wrong sheet / missing columns instead of importing empty");
  assert.match(parser, /day > 12/, "day-first date guard keeps unambiguous dd/mm/yyyy dates");

  const component = readFileSync("src/components/double-visit-analytics/double-visit-analytics-workspace.tsx", "utf8");
  assert.match(component, /type Tab = "summary"/, "Summary is the new default tab");
  assert.doesNotMatch(component, /"overview"/, "Overview tab is folded into Summary");
  assert.match(component, /visitsPerDay/, "per-pair intensity is computed client-side");
  assert.match(component, /dates: new Set/, "per-pair distinct days come from the visit log");
  assert.match(component, /vacantTerritories/, "resigned/vacant-territory visits are split out and counted as manager effort");
  assert.match(component, /Resigned \/ Vacant Territory/, "resigned/vacant territory has its own labeled section");

  const accessRegistry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistry, /\/api\/admin\/double-visit-analytics\/export/);
  assert.match(accessRegistry, /double_visit_analytics/);
  assert.match(accessRegistry, /\/api\/outstation\/workload-evidence/);

  const outstationService = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.match(outstationService, /resolveOutstationWorkloadPayload/);
  assert.match(outstationService, /workload_source_import_id/);
  assert.match(outstationService, /workload_evidence_snapshot/);

  // ── Manager summaries: personal-effort lens + team coverage ──────────────────
  const dsmEmployees = [
    employee({ fullName: "Saad Salama", hrId: "B-10", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
    employee({ fullName: "MR 1", hrId: "M-1", managerHrId: "B-10" }),
    employee({ fullName: "MR 2", hrId: "M-2", managerHrId: "B-10" }),
    employee({ fullName: "MR 3", hrId: "M-3", managerHrId: "B-10" }),
    employee({ fullName: "MR 4", hrId: "M-4", managerHrId: "B-10" }),
    employee({ fullName: "MR 5", hrId: "M-5", managerHrId: "B-10" }),
    employee({ fullName: "Nahed", hrId: "A-10", jobTitle: "Product Manager", positionTitle: "Product Manager" }),
  ];
  const dsmRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "B-10", period: "AM", visit: 2, visitedHrId: "M-1" }),
    dvRow({ date: "2026-06-02", dvHrId: "B-10", period: "PM", visit: 3, visitedHrId: "M-1" }),
    dvRow({ date: "2026-06-03", dvHrId: "B-10", period: "PM", visit: 2, visitedHrId: "M-2" }),
    dvRow({ date: "2026-06-04", dvHrId: "B-10", period: "PM", visit: 3, visitedHrId: "M-3" }),
    dvRow({ date: "2026-06-05", dvHrId: "A-10", period: "PM", visit: 4, visitedHrId: "M-1" }),
  ]);
  const { summaries: dsmSummaries } = buildManagerSummariesDetailed(dsmRows, dsmEmployees, "2026-06-30");
  const dsm = dsmSummaries.find((s) => s.managerName === "Saad Salama");
  assert.ok(dsm, "DSM summary present");
  assert.equal(dsm!.totalDvs, 10, "personal lens sums visit_count");
  assert.equal(dsm!.distinctMrs, 3, "DSM visited 3 distinct MRs");
  assert.equal(dsm!.activeDvDays, 4, "4 distinct DV dates");
  assert.equal(dsm!.callsPerActiveDay, 2.5, "calls/day = totalDvs / active days");
  assert.equal(dsm!.amVisits, 2);
  assert.equal(dsm!.pmVisits, 8);
  assert.equal(dsm!.teamMrCount, 5, "team = active MR descendants");
  assert.equal(dsm!.coveragePct, 60, "visited 3 of 6-in-team rule (3/5)");
  assert.equal(dsm!.neglectedMrCount, 2);
  assert.equal(dsm!.roleCode, "DSM");
  assert.equal(dsm!.firstDvDate, "2026-06-01");
  assert.equal(dsm!.lastDvDate, "2026-06-04");
  const pmSummary = dsmSummaries.find((s) => s.managerName === "Nahed");
  assert.ok(pmSummary, "PM summary present");
  assert.equal(pmSummary!.roleCode, "PM");
  assert.equal(pmSummary!.teamMrCount, null, "PM has no org-team denominator");
  assert.equal(pmSummary!.coveragePct, null);
  assert.equal(pmSummary!.neglectedMrCount, null);

  // Concentration (top-4 share) + off-directory visitor.
  const concRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "X-1", visit: 3, visitedHrId: "MA" }),
    dvRow({ date: "2026-06-01", dvHrId: "X-1", visit: 3, visitedHrId: "MB" }),
    dvRow({ date: "2026-06-02", dvHrId: "X-1", visit: 2, visitedHrId: "MC" }),
    dvRow({ date: "2026-06-02", dvHrId: "X-1", visit: 1, visitedHrId: "MD" }),
    dvRow({ date: "2026-06-03", dvHrId: "X-1", visit: 1, visitedHrId: "ME" }),
  ]);
  const conc = buildManagerSummariesDetailed(concRows, [], "2026-06-30").summaries[0];
  assert.equal(conc.distinctMrs, 5);
  assert.equal(conc.concentrationPct, 90, "top-4 of 9/10 visits = 90%");
  assert.equal(conc.inDirectory, false, "visitor absent from directory");
  assert.equal(conc.roleCode, null);
  assert.equal(conc.teamMrCount, null);

  // Over-focused threshold max(5, 2*avg).
  const ofRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "Y-1", visit: 8, visitedHrId: "MA" }),
    dvRow({ date: "2026-06-02", dvHrId: "Y-1", visit: 1, visitedHrId: "MB" }),
    dvRow({ date: "2026-06-03", dvHrId: "Y-1", visit: 1, visitedHrId: "MC" }),
  ]);
  assert.equal(buildManagerSummariesDetailed(ofRows, [], "2026-06-30").summaries[0].overFocusedMrCount, 1);

  // Null-visited rows count as effort but not as a distinct MR.
  const nullRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "Z-1", visit: 4, visitedHrId: null }),
    dvRow({ date: "2026-06-01", dvHrId: "Z-1", visit: 2, visitedHrId: "MA" }),
  ]);
  const nullSummary = buildManagerSummariesDetailed(nullRows, [], "2026-06-30").summaries[0];
  assert.equal(nullSummary.totalDvs, 6, "unmapped visits still count as effort");
  assert.equal(nullSummary.distinctMrs, 1, "unmapped visit does not add a distinct MR");

  // ── Executive summary: idle managers + insights ─────────────────────────────
  const execEmployees = [
    ...dsmEmployees,
    employee({ fullName: "Idle Boss", hrId: "B-99", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
  ];
  const { summaries: execSummaries, visitedKeysByManager } = buildManagerSummariesDetailed(dsmRows, execEmployees, "2026-06-30");
  const execKpis: DoubleVisitKpis = { ...zeroKpis, amVisitCount: 113, pmVisitCount: 543, totalVisits: 656 };
  const exec = buildExecutiveSummary(execSummaries, [], execKpis, execEmployees, visitedKeysByManager);
  assert.ok(exec.idleManagers.some((m) => m.hrId === canonicalHrIdKey("B-99")), "DSM with zero DVs is idle");
  assert.ok(!exec.idleManagers.some((m) => m.hrId === canonicalHrIdKey("B-10")), "active DSM is not idle");
  assert.ok(exec.roleRollups.some((r) => r.roleCode === "DSM"), "DSM rollup present");
  assert.ok(exec.roleRollups.some((r) => r.roleCode === "PM"), "PM rollup present");
  const ampm = exec.insights.find((i) => i.id === "ampm-imbalance");
  assert.ok(ampm, "AM/PM imbalance insight present");
  assert.equal(ampm!.managerHrId, null, "org-wide insight has no manager link");
  exec.insights.forEach((insight, index) => assert.equal(insight.rank, index, "insight ranks are contiguous"));
  const severityWeight: Record<string, number> = { critical: 0, info: 2, positive: 3, warning: 1 };
  for (let i = 1; i < exec.insights.length; i += 1) {
    assert.ok(severityWeight[exec.insights[i - 1].severity] <= severityWeight[exec.insights[i].severity], "insights sorted by severity");
  }

  // ── Manager × MR pairs: "29 visits in how many days?" ───────────────────────
  const pairLog: DoubleVisitLogEntry[] = [
    logEntry({ date: "2026-06-01", dvHrId: "B-10", dvName: "Saad Salama", period: "AM", visit: 5, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-01", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 4, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-02", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 6, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-03", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 5, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-04", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 4, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-05", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 3, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-06", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 2, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-02", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 2, visitedHrId: "M-2", visitedName: "Other MR" }),
  ];
  const pairs = buildManagerMrPairs(pairLog);
  const topPair = pairs[0];
  assert.equal(topPair.mrName, "Ahmed Ashraf", "pairs sorted by visits desc");
  assert.equal(topPair.visits, 29, "29 total visits");
  assert.equal(topPair.days, 6, "AM+PM on the same date collapse to one day → 6 distinct days");
  assert.equal(topPair.visitsPerDay, 4.83, "29 visits across 6 days");
  assert.equal(topPair.firstDate, "2026-06-01");
  assert.equal(topPair.lastDate, "2026-06-06");
  assert.equal(pairs[1].visits, 2, "second pair after the heavy one");
}
