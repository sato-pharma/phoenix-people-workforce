import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  parseInsuranceWageWorkbook,
  wageHrKey,
} from "../src/lib/payroll/statutory/insurance-wage-import.ts";

export async function runPayrollInsuranceWageImportTests() {
  // key normalization (hyphen/case/underscore insensitive)
  assert.equal(wageHrKey("B-100"), "b100");
  assert.equal(wageHrKey("b_100"), "b100");
  assert.equal(wageHrKey(" B 100 "), "b100");

  // build an in-memory workbook and round-trip it through the parser
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["HR_ID", "Insurance Wage"]);
  sheet.addRow(["B-100", 8000]);
  sheet.addRow(["B-142", "12,000"]); // comma-formatted → 12000
  sheet.addRow(["B-999", -5]); // negative → issue
  sheet.addRow(["", 500]); // missing HR_ID → issue
  sheet.addRow(["B-100", 9000]); // duplicate → issue
  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;

  const result = await parseInsuranceWageWorkbook(buffer);

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].hrId, "B-100");
  assert.equal(result.rows[0].wage, 8000);
  assert.equal(result.rows[1].hrId, "B-142");
  assert.equal(result.rows[1].wage, 12000);

  assert.ok(result.issues.some((issue) => /negative/i.test(issue.message)), "negative wage flagged");
  assert.ok(result.issues.some((issue) => /missing hr_id/i.test(issue.message)), "missing hr_id flagged");
  assert.ok(result.issues.some((issue) => /duplicate/i.test(issue.message)), "duplicate flagged");

  // a file without the required columns reports a clear issue, no rows
  const badWorkbook = new ExcelJS.Workbook();
  const badSheet = badWorkbook.addWorksheet("Sheet1");
  badSheet.addRow(["Name", "Something"]);
  badSheet.addRow(["Ahmed", 1]);
  const badBuffer = (await badWorkbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  const badResult = await parseInsuranceWageWorkbook(badBuffer);
  assert.equal(badResult.rows.length, 0);
  assert.ok(badResult.issues.length > 0);
}
