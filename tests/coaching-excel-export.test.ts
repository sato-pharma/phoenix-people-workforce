import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  coachingScoreMeaning,
  coachingStatusLabel,
  coachingZoneLabel,
  generateCoachingReportsWorkbook,
  sanitizeExcelText,
  safeWorksheetName,
} from "../src/lib/coaching/excel-export.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type {
  CoachingReportDetail,
  CoachingReportSummaryRow,
} from "../src/lib/coaching/types.ts";

function employee(): EmployeeDirectoryRow {
  return {
    fullName: "أحمد Phoenix Rep",
    hrId: "B-777",
    jobTitle: "Medical Representative",
    lineName: "CNS",
  } as EmployeeDirectoryRow;
}

function summary(): CoachingReportSummaryRow {
  return {
    acknowledged: true,
    acknowledgedAt: "2026-05-10T10:00:00.000Z",
    actualScore: 85,
    areaId: 1,
    areaName: "Cairo",
    coachHrId: "TM-1",
    coachName: "Training Manager",
    coachingDate: "2026-05-09",
    coachingMonth: 5,
    coachingQuarter: 2,
    coachingYear: 2026,
    createdAt: "2026-05-09T09:00:00.000Z",
    finalScorePercent: 85,
    lineId: 1,
    lineName: "CNS",
    maxScore: 100,
    medicalRepHrId: "B-777",
    medicalRepName: "أحمد Phoenix Rep",
    performanceZone: "green_zone",
    reportId: "report-1",
    reportNumber: "COACH-2026-0001",
    status: "reviewed_by_employee",
    submittedAt: "2026-05-09T12:00:00.000Z",
    teamId: 1,
    teamName: "Team A",
    updatedAt: "2026-05-10T10:00:00.000Z",
  };
}

function detail(longText: string): CoachingReportDetail {
  return {
    report: {
      acknowledged_at: "2026-05-10T10:00:00.000Z",
      actual_score: 85,
      area_id: 1,
      area_of_development: `Improve follow-up discipline\u0001 ${longText}`,
      coach_hr_id: "TM-1",
      coach_role: "Training Manager",
      coaching_date: "2026-05-09",
      coaching_month: 5,
      coaching_quarter: 2,
      coaching_year: 2026,
      created_at: "2026-05-09T09:00:00.000Z",
      created_by: "tm-1",
      employee_acknowledged: true,
      final_score_percent: 85,
      general_remarks: "Arabic text محفوظ and English text are preserved.",
      id: "report-1",
      line_id: 1,
      locked_at: null,
      max_score: 100,
      medical_rep_hr_id: "B-777",
      performance_zone: "green_zone",
      report_number: "COACH-2026-0001",
      status: "reviewed_by_employee",
      strength_points: "Strong planning and customer adaptation.",
      submitted_at: "2026-05-09T12:00:00.000Z",
      team_id: 1,
      updated_at: "2026-05-10T10:00:00.000Z",
      updated_by: "tm-1",
    },
    scoreResult: null,
    scores: [
      {
        area_to_be_improved: "Improve objection handling",
        created_at: "2026-05-09T09:00:00.000Z",
        display_order: 1,
        id: "score-1",
        parameter_category: "knowledge",
        report_id: "report-1",
        score: 5,
        score_item_key: "product_knowledge",
        score_item_label: "Product Knowledge",
        strength_point: "Clear product message",
        updated_at: "2026-05-09T09:00:00.000Z",
      },
    ],
    summary: summary(),
  };
}

export async function runCoachingExcelExportTests() {
  assert.equal(sanitizeExcelText("A\u0000B\u0008C"), "ABC");
  assert.equal(sanitizeExcelText("مرحبا"), "مرحبا");
  assert.equal(safeWorksheetName("Bad/Sheet:*Name?[]", "Fallback"), "Bad Sheet Name");
  assert.equal(coachingZoneLabel("critical_red"), "Red Zone / Below Expectations");
  assert.equal(coachingZoneLabel("red_zone"), "Red Zone / Below Expectations");
  assert.equal(coachingStatusLabel("reviewed_by_employee"), "Reviewed by Employee");
  assert.equal(coachingScoreMeaning(1), "Below Expectations");
  assert.equal(coachingScoreMeaning(5), "Exceeds Expectations");

  const buffer = await generateCoachingReportsWorkbook({
    exportDate: new Date("2026-05-11T10:00:00.000Z"),
    exportedBy: "Phoenix Auditor",
    filters: { year: 2026, quarter: 2 },
    reports: [{
      detail: detail("x".repeat(40000)),
      employee: employee(),
      summary: summary(),
    }],
  });

  assert.ok(buffer.length > 0);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Executive Summary", "Coaching Reports", "Score Items", "Quarterly Summary"],
  );
  assert.equal(new Set(workbook.worksheets.map((sheet) => sheet.name)).size, 4);
  assert.equal(workbook.getWorksheet("Executive Summary")?.getCell("A1").value, "⚡ Phoenix — Coaching Reports");
  assert.equal(workbook.getWorksheet("Coaching Reports")?.getCell("A1").value, "⚡ Phoenix — Coaching Reports Export");
  assert.equal(workbook.getWorksheet("Score Items")?.getCell("A1").value, "⚡ Phoenix — Coaching Score Items");
  assert.equal(workbook.getWorksheet("Quarterly Summary")?.getCell("A1").value, "⚡ Phoenix — Quarterly Coaching Summary");

  const reportsSheet = workbook.getWorksheet("Coaching Reports");
  assert.ok(reportsSheet);
  const feedback = String(reportsSheet.getCell(5, 23).value ?? "");
  assert.ok(!feedback.includes("\u0001"));
  assert.ok(feedback.length <= 32767);
  assert.equal(reportsSheet.getCell(5, 18).value, "Green Zone / Meets Expectations");
  assert.equal(reportsSheet.getCell(5, 19).value, "Reviewed by Employee");

  const scoreItemsSheet = workbook.getWorksheet("Score Items");
  assert.ok(scoreItemsSheet);
  assert.equal(scoreItemsSheet.getCell(5, 9).value, "Improve objection handling");
  assert.equal(scoreItemsSheet.getCell(5, 10).value, "Clear product message");
}
