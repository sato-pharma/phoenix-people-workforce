import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildPayrollCandidateHistoryRows,
  buildResignationHistoryRows,
  buildResignationHistoryWorkbook,
  formatLengthOfService,
  resignationHistoryColumns,
  type ResignationHistoryLookups,
} from "../src/lib/resignations/history-export.ts";
import type {
  PayrollResignationCandidateRecord,
  ResignationRecord,
} from "../src/lib/resignations/types.ts";

// The Resignations "Export full history" workbook (owner request 2026-09-14: "export xlsx all
// resignations history full data").
//
// What this pins, and why each matters:
//  - EVERY record is exported whatever its status — open, closed and the historical ones with no
//    workflow row. The on-screen Export follows the tab and filters; this one must not.
//  - Actors print as NAMES, never ids (owner rule), and workflow instants print in CAIRO.
//  - No column is `numeric`, so the sheet has no TOTAL row: each money figure belongs to one leaver's
//    own exit month, and a sum across years of leavers is a number nobody should read.
//  - The file is checked as EMITTED — the buffer is loaded back with ExcelJS — not just as rows.
//  - The route asserts resignations:export, and the button is hidden without it.

function record(overrides: Partial<ResignationRecord>): ResignationRecord {
  return {
    approvedAt: null,
    approvedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    completedAt: null,
    completedBy: null,
    createdAt: "2026-08-01T08:00:00.000Z",
    createdBy: null,
    createdByName: null,
    effectiveDate: "2026-09-30",
    employeeHrId: "T-1",
    employeeName: "Open Leaver",
    employeeStatus: null,
    exitCategory: null,
    hireDate: null,
    id: "00000000-0000-0000-0000-000000000001",
    jobTitle: "Medical Rep",
    lineName: "Pedia",
    outstandingDevices: [],
    reason: "Relocating",
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    reviewedAt: null,
    reviewedBy: null,
    settlement: null,
    status: "submitted",
    submittedDate: "2026-09-01",
    updatedAt: "2026-09-01T08:00:00.000Z",
    workflowNotes: null,
    ...overrides,
  };
}

const openRecord = record({});

const completedRecord = record({
  approvedAt: "2026-09-14T21:30:00.000Z",
  approvedBy: "a-7",
  completedAt: "2026-09-15T06:00:00.000Z",
  completedBy: "a-7",
  createdBy: "a-7",
  effectiveDate: "2026-09-09",
  employeeHrId: "T-2",
  employeeName: "Closed Leaver",
  hireDate: "2024-06-10",
  id: "00000000-0000-0000-0000-000000000002",
  outstandingDevices: [
    { agreedValueEgp: 12000, assetTag: "LT-04", assignmentId: "x", category: "Laptop", identifier: "SN-99" },
  ],
  settlement: {
    baseSalary: 20000,
    branch: "on_or_before_25",
    coveredByFirstPart: false,
    daysWorked: 9,
    firstPart: 6000,
    paymentMode: "two_parts",
    secondPart: 1500.5,
    total: 7500.5,
  },
  status: "completed",
});

const legacyRecord = record({
  employeeHrId: "T-3",
  employeeName: "Historical Leaver",
  id: "legacy:T-3",
  reason: null,
  status: "completed",
});

const lookups: ResignationHistoryLookups = {
  actorName: (id) => (String(id).toLowerCase() === "a-7" ? "Test Approver" : null),
  person: (hrId) =>
    hrId === "T-2"
      ? {
          areaName: "Giza 3",
          departmentName: "Sales",
          employmentStatus: "terminated",
          exitCategory: "declined_offer",
          exitReason: null,
          managerName: "Test Manager",
          nameAr: "اسم تجريبي",
          regionName: "Giza",
        }
      : hrId === "T-3"
        ? {
            areaName: null,
            departmentName: null,
            employmentStatus: "resigned",
            exitCategory: null,
            exitReason: "Moved abroad",
            managerName: null,
            nameAr: null,
            regionName: null,
          }
        : null,
  vacancyStatus: (id) => (id === completedRecord.id ? "filled" : null),
};

const candidate: PayrollResignationCandidateRecord = {
  areaName: "Alex 1",
  createdBy: "a-7",
  employeeName: "Payroll Only",
  firstSeenAt: "2026-07-01T10:00:00.000Z",
  hireDate: "2025-01-01",
  hrId: "T-9",
  id: "11111111-1111-1111-1111-111111111111",
  jobTitle: "Medical Rep",
  lastPayoutMonth: 7,
  lastPayoutYear: 2026,
  lastSeenAt: "2026-07-01T10:00:00.000Z",
  lineName: "CNS",
  nameAr: null,
  sourceFileName: "july.xlsx",
  sourceRow: 12,
  updatedAt: "2026-07-01T10:00:00.000Z",
};

export async function runResignationsHistoryExportTests() {
  // ── Every record, whatever its status ──────────────────────────────────────
  const rows = buildResignationHistoryRows([openRecord, completedRecord, legacyRecord], lookups);
  assert.equal(rows.length, 3, "open, completed and historical records must ALL be exported");
  assert.deepEqual(
    rows.map((row) => row.employee),
    ["Open Leaver", "Closed Leaver", "Historical Leaver"],
  );

  const [open, closed, legacy] = rows;

  // ── Names, never ids ───────────────────────────────────────────────────────
  assert.equal(closed.createdBy, "Test Approver", "Created By must resolve to a name");
  assert.equal(closed.approvedBy, "Test Approver");
  assert.equal(closed.completedBy, "Test Approver");
  assert.equal(open.approvedBy, "-", "an action nobody took reads as a dash, not a blank id");

  // ── Cairo, not UTC: 21:30 UTC on 14 Sep is 00:30 on 15 Sep in Cairo ─────────
  assert.match(String(closed.approvedAt), /^15 Sept? 2026, 12:30 AM$/, `approvedAt was ${closed.approvedAt}`);

  // ── Full data: org, exit and settlement detail ─────────────────────────────
  assert.equal(closed.area, "Giza 3");
  assert.equal(closed.region, "Giza");
  assert.equal(closed.manager, "Test Manager");
  assert.equal(closed.nameAr, "اسم تجريبي");
  assert.equal(closed.employmentStatus, "Declined offer", "declined_offer category wins over a terminated status");
  assert.equal(legacy.employmentStatus, "Resigned");
  assert.equal(legacy.reason, "Moved abroad", "a record with no reason falls back to the employee's exit reason");
  assert.equal(closed.service, "2 years 2 months");
  assert.equal(closed.due, 7500.5, "money stays a real number");
  assert.equal(closed.secondPart, 1500.5);
  assert.equal(open.due, null, "a missing settlement is a blank, never a zero");
  assert.equal(closed.paymentMode, "Two parts");
  assert.equal(closed.devicesCount, 1);
  assert.equal(closed.devices, "Laptop LT-04 (SN-99)");
  assert.equal(closed.devicesValue, 12000);
  assert.equal(closed.vacancy, "Filled");
  assert.equal(open.vacancy, "None linked");
  assert.equal(legacy.vacancy, "-", "a historical row has no workflow record to link a vacancy to");
  assert.equal(closed.source, "Resignation workflow");
  assert.equal(legacy.source, "Historical (no workflow record)");

  for (const column of resignationHistoryColumns) {
    assert.ok(column.key in closed, `row is missing the "${column.label}" column`);
  }

  // ── Length of service edges ────────────────────────────────────────────────
  assert.equal(formatLengthOfService("2026-09-01", "2026-09-10"), "Under 1 month");
  assert.equal(formatLengthOfService("2025-09-10", "2026-09-10"), "1 year");
  assert.equal(formatLengthOfService("2026-09-10", "2026-09-01"), "-", "hired after leaving has no honest answer");
  assert.equal(formatLengthOfService(null, "2026-09-01"), "-");

  // ── No TOTAL row: nothing is flagged numeric ───────────────────────────────
  assert.equal(
    resignationHistoryColumns.filter((column) => column.numeric).length,
    0,
    "a numeric column adds a SUM total across every leaver's own exit month — meaningless",
  );

  const candidateRows = buildPayrollCandidateHistoryRows([candidate], lookups);
  assert.equal(candidateRows[0].addedBy, "Test Approver");
  assert.equal(candidateRows[0].lastPayout, "Jul 2026");

  // ── The emitted workbook ───────────────────────────────────────────────────
  const buffer = await buildResignationHistoryWorkbook({
    generatedAt: "2026-09-14T09:00:00.000Z",
    lookups,
    payrollCandidates: [candidate],
    records: [openRecord, completedRecord, legacyRecord],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as ArrayBuffer);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Resignations", "Payroll Candidates"],
  );

  const sheet = workbook.getWorksheet("Resignations");
  assert.ok(sheet);
  assert.match(String(sheet.getCell(2, 1).value), /SATO-DIS-2026-01 v1\.0/, "the house document id must be on the sheet");
  assert.match(String(sheet.getCell(2, 1).value), /\(Cairo\)/);
  const headers = resignationHistoryColumns.map((_, index) => sheet.getRow(3).getCell(index + 1).value);
  assert.deepEqual(headers, resignationHistoryColumns.map((column) => column.label));
  assert.equal(sheet.getCell(4, 1).value, "Open Leaver");
  assert.equal(sheet.getCell(6, 1).value, "Historical Leaver");
  assert.equal(sheet.getCell(7, 1).value, null, "no TOTAL row under the last record");

  // ── Wiring: server gate, scoped source, button gate ────────────────────────
  const route = readFileSync("app/api/resignations/export/route.ts", "utf8");
  assert.match(route, /assertPermission\(access, "resignations", "export"\)/, "the route must assert resignations:export");
  assert.ok(
    route.indexOf("writeRequiredAuditLog({") > 0 && route.indexOf("writeRequiredAuditLog({") < route.indexOf("return new Response("),
    "the route must write its required audit row BEFORE it returns the file",
  );

  const loader = readFileSync("src/lib/resignations/history-export-data.ts", "utf8");
  assert.match(
    loader,
    /getResignationsDashboardData\(access\)/,
    "records must come from the viewer's own scoped dashboard read",
  );

  const workspace = readFileSync("src/components/resignations/resignations-workspace.tsx", "utf8");
  assert.match(workspace, /fetch\("\/api\/resignations\/export"/);
  assert.match(workspace, /canExportHistory \?/, "the button renders only with resignations:export");

  for (const page of ["app/(admin)/resignations/page.tsx", "app/employee-portals/resignations/page.tsx"]) {
    assert.match(
      readFileSync(page, "utf8"),
      /canExportHistory=\{await canAccess\(access, "resignations", "export"\)\}/,
      `${page} must pass resignations:export to the workspace`,
    );
  }
}
