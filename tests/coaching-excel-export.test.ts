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
  assert.equal(coachingScoreMeaning(0), "No Score");
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
  // Each sheet still carries its own title on row 1 — but no longer in A1, and no longer prefixed
  // with the app name. The house masthead keeps columns 1-2 clear for the company mark and sets the
  // title beside it, and that identity is the COMPANY's (Sato Pharma), never the product's, so a
  // document it produces does not announce itself as Phoenix. The guarantee this pinned — four
  // sheets, four distinct titles — is unchanged and asserted by reading the row rather than a cell.
  const titleOnRowOne = (sheetName: string) => {
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `${sheetName} must exist`);
    for (let column = 1; column <= Math.max(sheet.columnCount, 8); column += 1) {
      const value = String(sheet.getRow(1).getCell(column).value ?? "").trim();
      if (value && !value.startsWith("SATO-DIS-")) return value;
    }
    return "";
  };
  assert.equal(titleOnRowOne("Executive Summary"), "Coaching Reports");
  assert.equal(titleOnRowOne("Coaching Reports"), "Coaching Reports — Export");
  assert.equal(titleOnRowOne("Score Items"), "Coaching Score Items");
  assert.equal(titleOnRowOne("Quarterly Summary"), "Quarterly Coaching Summary");

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

  // ── the house identity, checked on the ARTIFACT rather than the source ──────
  //
  // The zone column dropped its cell fills, which is only safe because the cell already SAYS the
  // zone — "Green Zone / Meets Expectations", asserted above. So the check here is that the grading
  // survived as TYPE: a red zone must still be visibly different from a green one, or the export
  // has quietly lost a distinction it used to make.
  // The GRADED cell is on the Quarterly Summary (column 12), not on the Coaching Reports sheet —
  // that one only prints the label. Checking the wrong cell would have "passed" against a value
  // nothing ever coloured.
  const quarterly = workbook.getWorksheet("Quarterly Summary");
  assert.ok(quarterly, "the quarterly sheet must exist");
  const zoneCell = quarterly.getCell(5, 12);
  const zoneColour = String(zoneCell.font?.color?.argb ?? "");
  assert.ok(
    ["FFB3261E", "FF0A527D", "FF1A1A1A", "FF1482C2"].includes(zoneColour),
    `the zone must still be graded by type — got ${zoneColour || "no font"}`,
  );
  const zoneFill = zoneCell.fill as { pattern?: string } | undefined;
  assert.ok(
    !zoneFill || zoneFill.pattern === "none" || zoneFill.pattern === undefined,
    "a graded zone cell must carry no fill of its own — the grade is type now",
  );

  // The retired palettes: Phoenix orange, the two navies, and the four zone tints.
  const retired = ["F97316", "0F172A", "111827", "FFF1F2", "ECFDF5", "FFFBEB", "BE123C", "047857"];
  const zip = await import("jszip").then((module) => module.default.loadAsync(Buffer.from(buffer)));
  const styles = ((await zip.file("xl/styles.xml")?.async("string")) ?? "").toUpperCase();
  assert.ok(styles.length > 0, "the workbook must have a styles part to check");
  for (const colour of retired) {
    assert.ok(
      !styles.includes(colour),
      `${colour} belongs to a palette this export no longer wears — still in xl/styles.xml`,
    );
  }

  // And it must open without Excel repairing it.
  const { checkWorkbook } = await import("../scripts/check-workbook-integrity.mjs");
  const problems = await checkWorkbook(Buffer.from(buffer), { quiet: true });
  assert.deepEqual(problems, [], `the coaching workbook must be clean: ${problems.join("; ")}`);
}
