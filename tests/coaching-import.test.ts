import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeHrId } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  classifyCoachingImportRows,
  flagCoachingImportDuplicateRows,
  parseCoachingDate,
  parseCoachingWorkbookRows,
} from "../src/lib/coaching/import.ts";

// Column letters for the 20 score items, in the template's order.
const SCORE_COLUMNS = ["D", "E", "F", "I", "J", "K", "L", "O", "P", "Q", "R", "S", "V", "W", "X", "Y", "AB", "AC", "AD", "AE"];

function buildWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Jan-Feb-March-April");

  // Header rows (only A1 = "Name" is required for header detection).
  sheet.getCell("A1").value = "Name";
  sheet.getCell("C1").value = "CoachingDate";
  sheet.getCell("B2").value = "HR-ID";

  const setScores = (row: number, base: number, overrides: Record<string, number> = {}) => {
    for (const column of SCORE_COLUMNS) {
      sheet.getCell(`${column}${row}`).value = overrides[column] ?? base;
    }
  };

  // Row 3 — matched rep with a distinct score pattern.
  sheet.getCell("A3").value = "Eman.Ahmed ( Helwan-Maadi / E )";
  sheet.getCell("B3").value = "B-104";
  sheet.getCell("C3").value = "16/02/2026";
  setScores(3, 4, { D: 0, F: 5, S: 2, AE: 1 });
  sheet.getCell("AG3").value = 80;
  sheet.getCell("AH3").value = "Adapt message to customer style";
  sheet.getCell("AI3").value = "Strong business planning";
  sheet.getCell("AJ3").value = "Keep on Eman, well done";

  // Row 4 — resigned rep (no HR-ID), date as a real Date cell.
  sheet.getCell("A4").value = "Wegdan Wagdy ( Helwan-Maadi / P )";
  sheet.getCell("C4").value = new Date(Date.UTC(2026, 0, 14));
  setScores(4, 5);
  sheet.getCell("AG4").value = 100;
  sheet.getCell("AJ4").value = "Resigned but excellent";

  // Row 5 — matched HR-ID but an incomplete score (column D left blank).
  sheet.getCell("A5").value = "Tester Rep ( Cairo / C )";
  sheet.getCell("B5").value = "B-200";
  sheet.getCell("C5").value = "01/03/2026";
  setScores(5, 4);
  sheet.getCell("D5").value = null; // missing knowledge score

  return workbook;
}

function buildDirectory(): Map<string, EmployeeDirectoryRow> {
  const index = new Map<string, EmployeeDirectoryRow>();
  index.set(normalizeHrId("B-104")!, { fullName: "Eman Ahmed", hrId: "B-104" } as EmployeeDirectoryRow);
  index.set(normalizeHrId("B-200")!, { fullName: "Tester Rep", hrId: "B-200" } as EmployeeDirectoryRow);
  return index;
}

export async function runCoachingImportTests() {
  // Date parsing — day-first text + ISO + Excel Date object.
  assert.equal(parseCoachingDate("16/02/2026").date, "2026-02-16");
  assert.equal(parseCoachingDate("2026-03-09").date, "2026-03-09");
  assert.equal(parseCoachingDate("not a date").date, null);
  // Excel Date with day > 12 is unambiguous — kept as-is, not swapped.
  assert.equal(parseCoachingDate(new Date(Date.UTC(2026, 0, 14))).date, "2026-01-14");
  assert.equal(parseCoachingDate(new Date(Date.UTC(2026, 0, 14))).corrected, false);
  // Excel Date with both fields <= 12 = US-locale day/month swap; recover day-first.
  // Stored 2026-09-02 (Excel read "09/02" as Sep 2) -> coach meant 9 Feb -> 2026-02-09.
  assert.equal(parseCoachingDate(new Date(Date.UTC(2026, 8, 2))).date, "2026-02-09");
  assert.equal(parseCoachingDate(new Date(Date.UTC(2026, 8, 2))).corrected, true);
  // Stored 2026-04-05 (Excel read "04/05" as Apr 5) -> coach meant 4 May -> 2026-05-04.
  assert.equal(parseCoachingDate(new Date(Date.UTC(2026, 3, 5))).date, "2026-05-04");

  const workbook = buildWorkbook();
  const { rows, sheetName } = parseCoachingWorkbookRows(workbook);

  assert.equal(sheetName, "Jan-Feb-March-April");
  assert.equal(rows.length, 3);

  // Row mapping — name parsing + 20-item column mapping.
  const eman = rows[0];
  assert.equal(eman.repName, "Eman.Ahmed");
  assert.equal(eman.territory, "Helwan-Maadi");
  assert.equal(eman.repCode, "E");
  assert.equal(eman.claimedHrId, "B-104");
  assert.equal(eman.coachingDate, "2026-02-16");
  assert.equal(Object.keys(eman.scores).length, 20);
  assert.equal(eman.scores.medical_patient_knowledge, 0); // D
  assert.equal(eman.scores.product_knowledge, 4); // E
  assert.equal(eman.scores.competitor_knowledge, 5); // F
  assert.equal(eman.scores.customer_adaptation_relationship, 2); // S
  assert.equal(eman.scores.discipline, 1); // AE
  assert.equal(eman.scoreIssues.length, 0);
  assert.equal(eman.overallScore, 80);
  assert.equal(eman.areaOfDevelopment, "Adapt message to customer style");
  assert.equal(eman.strengthPoints, "Strong business planning");
  assert.equal(eman.generalRemarks, "Keep on Eman, well done");

  const wegdan = rows[1];
  assert.equal(wegdan.claimedHrId, null);
  assert.equal(wegdan.coachingDate, "2026-01-14");
  assert.equal(Object.keys(wegdan.scores).length, 20);

  const tester = rows[2];
  assert.ok(tester.scoreIssues.length >= 1); // missing knowledge score
  assert.equal(tester.scores.medical_patient_knowledge, undefined);

  // Classification against an active-employee directory.
  const classified = classifyCoachingImportRows(rows, buildDirectory());

  const emanClass = classified[0];
  assert.equal(emanClass.classification, "matched");
  assert.equal(emanClass.resolvedHrId, "B-104");
  assert.equal(emanClass.resolvedName, "Eman Ahmed");
  assert.equal(emanClass.coachingQuarter, 1);
  assert.equal(emanClass.coachingYear, 2026);
  assert.equal(emanClass.issues.length, 0);

  const wegdanClass = classified[1];
  assert.equal(wegdanClass.classification, "archived");
  assert.match(wegdanClass.unmatchedReason ?? "", /No HR-ID/);

  const testerClass = classified[2];
  assert.equal(testerClass.classification, "skipped");
  assert.ok(testerClass.issues.length >= 1);

  const duplicateExisting = flagCoachingImportDuplicateRows(
    classified,
    new Set(["b-104|2026-02-16"]),
    new Set(),
  );
  assert.equal(duplicateExisting[0].classification, "duplicate");
  assert.match(duplicateExisting[0].duplicateReason ?? "", /already exists/i);

  const duplicateInWorkbook = flagCoachingImportDuplicateRows(
    [...classified, { ...classified[0], rowNumber: 6 }],
    new Set(),
    new Set(),
  );
  assert.equal(duplicateInWorkbook[0].classification, "matched");
  assert.equal(duplicateInWorkbook[3].classification, "duplicate");
  assert.match(duplicateInWorkbook[3].duplicateReason ?? "", /workbook contains another/i);
}
