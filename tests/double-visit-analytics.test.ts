import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyVisitedEmployeeStatus,
  extractEmployeeNameAreaLine,
  normalizeDoubleVisitExcelRows,
  normalizeIReports360DoubleVisits,
} from "../src/lib/double-visit-analytics/parser.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";

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

  const accessRegistry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistry, /\/api\/admin\/double-visit-analytics\/export/);
  assert.match(accessRegistry, /double_visit_analytics/);
  assert.match(accessRegistry, /\/api\/outstation\/workload-evidence/);

  const outstationService = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.match(outstationService, /resolveOutstationWorkloadPayload/);
  assert.match(outstationService, /workload_source_import_id/);
  assert.match(outstationService, /workload_evidence_snapshot/);
}
