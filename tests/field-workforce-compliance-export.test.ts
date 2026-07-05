import { strict as assert } from "node:assert";

import JSZip from "jszip";

import { buildFieldWorkforceCompliancePreview } from "../src/lib/field-workforce-compliance/classifier.ts";
import { fieldWorkforceMonthKey } from "../src/lib/field-workforce-compliance/archive.ts";
import {
  generateFieldWorkforceGodModeWorkbook,
  generateFieldWorkforceSimpleSummaryWorkbook,
} from "../src/lib/field-workforce-compliance/export.ts";
import { parseFieldWorkforceComplianceMatrix } from "../src/lib/field-workforce-compliance/parser.ts";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceArchiveListItem,
  FieldWorkforceRecommendationsReport,
} from "../src/lib/field-workforce-compliance/types.ts";

function buildDetail(): FieldWorkforceArchiveDetail {
  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: "Jan 2026 team calendar.xlsx",
    matrix: [
      ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-2026", "2-Jan-2026", "3-Jan-2026", "4-Jan-2026", "5-Jan-2026", "6-Jan-2026", "7-Jan-2026"],
      ["Ahmed", "A-1", "1-Jan-2026", "Jan", 2026, 9, "F", "N", "N", "CP", "AV", 5],
      ["Mona", "A-2", "1-Jan-2026", "Jan", 2026, "N", "F", 4, 3, "N", "N", "N"],
    ],
    sheetName: "iReport",
  });

  const preview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      {
        fullName: "Ahmed Official",
        areaName: "Cairo",
        employmentStatus: "active",
        hireDate: "2026-01-01",
        hrId: "A-1",
        lineName: "Line A",
        managerName: "Manager One",
        roleName: "Medical Rep",
        teamName: "Team A",
      },
      {
        fullName: "Mona Official",
        areaName: "Giza",
        employmentStatus: "active",
        hireDate: "2026-01-01",
        hrId: "A-2",
        lineName: "Line A",
        managerName: "Manager One",
        roleName: "Medical Rep",
        teamName: "Team A",
      },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    holidays: [{ name: "Coptic Christmas Day", startDate: "2026-01-07" }],
    parsed,
  });

  const archive: FieldWorkforceArchiveListItem = {
    employeeCount: preview.metadata.employeeCount,
    highSeverityCount: preview.severityCounts.High,
    id: "test-import-1",
    month: preview.metadata.month,
    monthKey: fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month),
    reviewCandidateCount: preview.reviewCandidates.length,
    sheetName: preview.metadata.sheetName,
    sourceFilename: preview.metadata.fileName,
    status: "archived",
    uploadedAt: "2026-01-08T00:00:00.000Z",
    uploadedBy: "test",
    year: preview.metadata.year,
  };

  return { archive, preview };
}

function buildReport(archive: FieldWorkforceArchiveListItem): FieldWorkforceRecommendationsReport {
  return {
    archive,
    finalActions: [
      {
        actionType: "Payroll Deduction",
        amount: null,
        areaName: "Giza",
        approvedAt: null,
        approvedBy: null,
        approvedDates: ["2026-01-05", "2026-01-06"],
        approvedDaysCount: 2,
        decisionReason: "",
        decisionStatus: "Approved for Payroll Deduction Report",
        employeeCode: "A-2",
        employeeName: "Mona Official",
        employmentStatus: "active",
        hrNote: "",
        lineName: "Line A",
        managerName: "Manager One",
        monthKey: archive.monthKey,
        pushStatus: "Export only",
        recommendationKey: "A-2:payroll",
        roleName: "Medical Rep",
        teamName: "Team A",
      },
    ],
    integrationStatus: {
      leaveSource: "not_connected",
      leaveSourceMessage: "Leave source not connected.",
      payrollAmount: "requires_calculation",
      payrollAmountMessage: "Payroll amount requires calculation.",
    },
    leaveRecommendations: [],
    payrollRecommendations: [
      {
        areaName: "Giza",
        dates: ["2026-01-05", "2026-01-06"],
        daysCount: 2,
        decisionId: null,
        decisionReason: "",
        decisionStatus: "Pending",
        decidedAt: null,
        decidedBy: null,
        employeeCode: "A-2",
        employeeName: "Mona Official",
        employmentStatus: "active",
        estimatedAmount: null,
        existingCoverageStatus: "payroll_calculation_required",
        holidayContext: null,
        hrNote: "",
        importId: archive.id,
        lineName: "Line A",
        managerName: "Manager One",
        monthKey: archive.monthKey,
        recommendation: "Review payroll deduction",
        recommendationKey: "A-2:payroll",
        recommendationReason: "Consecutive no-activity days",
        recommendationType: "payroll_deduction",
        resolvedAt: null,
        resolvedBy: null,
        roleName: "Medical Rep",
        severity: "High",
        sourceLabel: "No-activity candidate",
        sourceType: "no_activity_candidate",
        teamName: "Team A",
      },
    ],
  };
}

/**
 * Unzips a produced workbook and asserts it has none of the ExcelJS constructs
 * that make Excel report a corrupt part and repair (empty) the sheet:
 *  - cell comments (the VML / comments subsystem), and
 *  - data bars, which emit an invalid empty <x14:id/>.
 * writeBuffer() succeeding is NOT enough — these open in-memory but fail in Excel.
 */
async function assertNoExcelRepairTriggers(buffer: Buffer | ArrayBuffer | Uint8Array, label: string) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);

  const commentParts = names.filter((name) => /comments\d*\.xml$/.test(name) || /vmlDrawing/i.test(name));
  assert.equal(commentParts.length, 0, `${label}: unexpected comment/VML parts (${commentParts.join(", ")})`);

  const sheetNames = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  assert.ok(sheetNames.length > 0, `${label}: workbook has no worksheet parts`);
  for (const name of sheetNames) {
    const xml = await zip.files[name].async("string");
    assert.ok(xml.startsWith("<?xml"), `${label}: ${name} is not an XML document`);
    assert.ok(!xml.includes("<x14:id/>"), `${label}: ${name} has an empty <x14:id/> (invalid data bar)`);
  }
}

export async function runFieldWorkforceComplianceExportTests() {
  const detail = buildDetail();
  const totalCells = detail.preview.employees.reduce((total, employee) => total + employee.timeline.length, 0);
  assert.ok(totalCells > 0, "fixture should produce timeline cells");

  // Simple single-sheet export.
  const simple = generateFieldWorkforceSimpleSummaryWorkbook(detail);
  assert.equal(simple.worksheets.length, 1, "simple export is a single sheet");
  const monthlySheet = simple.getWorksheet("Monthly Summary");
  assert.ok(monthlySheet, "simple export has a Monthly Summary sheet");
  // title + subtitle + spacer + header + one row per employee + totals row.
  assert.equal(monthlySheet!.rowCount, 4 + detail.preview.employees.length + 1);
  const simpleBuffer = await simple.xlsx.writeBuffer();
  assert.ok(simpleBuffer.byteLength > 0, "simple export produces a non-empty workbook");
  await assertNoExcelRepairTriggers(simpleBuffer, "simple");

  // God-mode book without a recommendations report (graceful path).
  const godNoReport = generateFieldWorkforceGodModeWorkbook(detail, null);
  const godSheetNames = godNoReport.worksheets.map((sheet) => sheet.name);
  for (const expected of [
    "Summary",
    "Monthly Summary",
    "Calendar Grid",
    "Review Queue",
    "Recommendations",
    "Final Actions",
    "Day Data",
    "Diagnostics",
    "Legend",
  ]) {
    assert.ok(godSheetNames.includes(expected), `god-mode book has a ${expected} sheet`);
  }
  // Day Data is one flat row per employee-day on top of the 4 heading rows.
  assert.equal(godNoReport.getWorksheet("Day Data")!.rowCount, 4 + totalCells);
  // Calendar Grid = 4 heading rows + one row per employee (no grouped team headers).
  assert.equal(
    godNoReport.getWorksheet("Calendar Grid")!.rowCount,
    4 + detail.preview.employees.length,
  );
  // No report => no recommendation/final-action data rows (heading rows only).
  assert.equal(godNoReport.getWorksheet("Recommendations")!.rowCount, 4);
  assert.equal(godNoReport.getWorksheet("Final Actions")!.rowCount, 4);
  const godNoReportBuffer = await godNoReport.xlsx.writeBuffer();
  assert.ok(godNoReportBuffer.byteLength > 0, "god-mode book builds without a report");
  await assertNoExcelRepairTriggers(godNoReportBuffer, "godmode-no-report");

  // God-mode book with a recommendations report populates those sheets.
  const report = buildReport(detail.archive);
  const godWithReport = generateFieldWorkforceGodModeWorkbook(detail, report);
  assert.equal(
    godWithReport.getWorksheet("Recommendations")!.rowCount,
    4 + report.leaveRecommendations.length + report.payrollRecommendations.length,
  );
  assert.equal(godWithReport.getWorksheet("Final Actions")!.rowCount, 4 + report.finalActions.length);
  const godWithReportBuffer = await godWithReport.xlsx.writeBuffer();
  assert.ok(godWithReportBuffer.byteLength > 0, "god-mode book builds with a report");
  await assertNoExcelRepairTriggers(godWithReportBuffer, "godmode-with-report");
}
