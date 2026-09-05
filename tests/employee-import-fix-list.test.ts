import assert from "node:assert/strict";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import {
  buildEmployeeImportFixListWorkbook,
  buildFixListEntries,
  importFieldColumnHeader,
} from "../src/lib/employees/employee-import-fix-list-workbook.ts";
import { employeeColumnDefinitions } from "../src/lib/imports/employee-column-map.ts";
import type {
  EmployeeImportField,
  EmployeeImportValidationResult,
} from "../src/lib/imports/employee-import-types.ts";

// The import preview showed the first ten findings and then "+N more", so on a file of any real
// size the rest existed only in a response body nobody could read. This workbook is the rest of
// them — every finding, with the row number in the user's own file, the person it is about, and
// the column at fault.
//
// What can quietly go wrong with it:
//
//   1. a finding's `field` resolves to no column header, so the sheet says "areaName" — a name
//      that appears nowhere in the file the reader is looking at
//   2. findings come out in an order nobody can work through
//   3. a file-level finding (a missing column) has no row number and silently disappears
//   4. a CLEAN file produces an empty table, which reads as "the check did not run"

function emptyResult(): EmployeeImportValidationResult {
  return {
    detectedColumns: [],
    duplicateHrIds: [],
    failedRows: 0,
    missingRequiredColumns: [],
    organizationEntitiesToCreate: { areas: [], departments: [], lines: [], positions: [], teams: [] },
    organizationEntityCounts: { area: 0, department: 0, line: 0, position: 0, team: 0 },
    orgMappingWarnings: [],
    rowsToInsert: [],
    rowsToUpdate: [],
    sampleOrgMappings: [],
    totalRows: 0,
    vacantPositionsToCreate: [],
    vacantRows: 0,
    validRows: 0,
    validationErrors: [],
    validationWarnings: [],
    warningRows: 0,
  };
}

const record = (rowNumber: number, hrId: string, fullName: string) =>
  ({ compensation: {}, fullName, hrId, rowNumber, rowType: "employee" }) as never;

export async function runEmployeeImportFixListTests() {
  // ── 1. every field the validator can name resolves to a header a reader can see ──
  //
  // The header comes from the alias table, so this also catches a field added to the union
  // without a column definition — which would break the import itself, not just this report.
  const fields = employeeColumnDefinitions.map((definition) => definition.field);
  assert.ok(fields.length > 0, "there should be column definitions");
  for (const field of fields) {
    const header = importFieldColumnHeader(field);
    assert.notEqual(
      header,
      field,
      `import field "${field}" fell back to its own name — the sheet would point at a column ` +
        "heading that does not exist in the file the reader has open",
    );
    assert.ok(header.trim().length > 0, `import field "${field}" resolved to an empty header`);
  }
  // An unknown field degrades to the field name, never to a blank — a blank cell reads as
  // "no particular column", which is a different and wrong statement.
  assert.equal(importFieldColumnHeader("notARealField" as EmployeeImportField), "notARealField");
  assert.equal(importFieldColumnHeader(undefined), "—");

  // ── 2. order: blocking findings first, then by row ───────────────────────────
  const result = emptyResult();
  result.failedRows = 2;
  result.rowsToUpdate = [record(6, "A-1", "Omar Gawish"), record(8, "A-8", "Hossam Ali")];
  result.rowsToInsert = [record(9, "A-9", "Mona Adel")];
  result.validationWarnings = [
    { code: "basic_salary_formula_mismatch", field: "basicSalary", message: "Basic normalized.", rowNumber: 6 },
  ];
  result.validationErrors = [
    { code: "unmapped_area", field: "area", message: "Area is not active.", rowNumber: 8 },
    { code: "invalid_email", field: "workEmail", message: "Email is invalid.", rowNumber: 6 },
    { code: "missing_required_column", message: "Required column is missing for fullName." },
  ];

  const entries = buildFixListEntries(result);
  assert.equal(entries.length, 4, "every finding appears — nothing is truncated");
  assert.deepEqual(
    entries.map((entry) => entry.severity),
    ["Blocks the row", "Blocks the row", "Blocks the row", "Review"],
    "blocking findings sort above findings to review",
  );
  assert.deepEqual(
    entries.map((entry) => entry.rowNumber),
    [null, 6, 8, 6],
    "within a severity, findings sort by row; a file-level finding sorts first",
  );

  // ── 3. the person, resolved from the row ─────────────────────────────────────
  const emailFinding = entries.find((entry) => entry.code === "invalid_email");
  assert.ok(emailFinding, "the email finding should be present");
  assert.equal(emailFinding.hrId, "A-1");
  assert.equal(emailFinding.fullName, "Omar Gawish", "a finding names the person, not just a row number");
  assert.equal(emailFinding.column, "Email", "the column is the header printed in the template");

  const areaFinding = entries.find((entry) => entry.code === "unmapped_area");
  assert.equal(areaFinding?.column, "Area", 'the "area" field must read as the "Area" column');

  // ── 4. a file-level finding survives, with no row rather than a wrong one ────
  const fileLevel = entries.find((entry) => entry.code === "missing_required_column");
  assert.ok(fileLevel, "a finding with no row number must still appear");
  assert.equal(fileLevel.rowNumber, null);
  assert.equal(fileLevel.hrId, "—", "no row means no person — never a borrowed one");

  // ── 5. the emitted artifact ──────────────────────────────────────────────────
  const workbook = await buildEmployeeImportFixListWorkbook({
    result,
    sourceFileName: "employee-master-sept.xlsx",
  });
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Summary", "What To Fix"],
    "the summary leads — nothing parses this file, so unlike the template its cover may come first",
  );
  const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
  const problems = await checkWorkbook(Buffer.from(buffer), { quiet: true });
  assert.deepEqual(problems, [], `the fix list must be structurally clean: ${problems.join("; ")}`);

  // The findings really reached the sheet, with the person's name beside them.
  const findings = workbook.getWorksheet("What To Fix");
  assert.ok(findings, "the findings sheet should exist");
  const firstBodyRow = findings.getRow(6);
  assert.equal(String(firstBodyRow.getCell(1).value), "whole file", "a file-level finding says so");
  const secondBodyRow = findings.getRow(7);
  assert.equal(secondBodyRow.getCell(2).value, "A-1");
  assert.equal(secondBodyRow.getCell(3).value, "Omar Gawish");

  // ── 6. a clean file says so, rather than showing an empty table ──────────────
  const cleanWorkbook = await buildEmployeeImportFixListWorkbook({ result: emptyResult() });
  const cleanSheet = cleanWorkbook.getWorksheet("What To Fix");
  assert.ok(cleanSheet, "the findings sheet should exist even when there is nothing to report");
  const clean = String(cleanSheet.getRow(6).getCell(1).value ?? "");
  assert.match(
    clean,
    /Nothing to fix/i,
    "a file with no findings must say so — an empty table reads as a check that never ran",
  );
}
