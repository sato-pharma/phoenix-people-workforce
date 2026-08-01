import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { parseOfficePivotBuffer } from "../src/lib/sales/office-pivot.ts";

async function buildOfficePivotBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Row Labels", "BUM", "Sum of المبيعات"]);
  sheet.addRow(["Conviban 100 ml", "Ezzat Sedrak", 3148]);
  sheet.addRow(["Tebofortin 40 ml", "Ezzat Sedrak", 20472]);
  sheet.addRow(["Tebofortin 80 ml", "Ezzat Sedrak", 20823]);
  // Blank row — parsing MUST stop here; everything below is unrelated junk.
  sheet.addRow([]);
  sheet.addRow(["Factory code 2025", "Marcyrl Products", "BUM ( New )"]);
  sheet.addRow(["FG-001-313", "Tebofortin 40 ml", 5]);
  return workbook.xlsx.writeBuffer();
}

export async function runOfficePivotTests() {
  const buffer = await buildOfficePivotBuffer();
  const result = await parseOfficePivotBuffer(buffer as unknown as ArrayBuffer);

  // Only the 3 product rows above the blank row are read — the junk block below is ignored.
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((r) => r.productName), ["Conviban 100 ml", "Tebofortin 40 ml", "Tebofortin 80 ml"]);

  // The units column is "Sum of المبيعات" — NOT the "BUM" (manager name) column.
  assert.equal(result.rows[0].units, 3148);
  assert.equal(result.rows[1].units, 20472);
  assert.equal(result.rows[2].units, 20823);

  // A well-formed sheet reports no bad-units rows.
  assert.deepEqual(result.badUnitsRows, []);

  // An empty file yields no rows (never throws).
  const empty = new ExcelJS.Workbook();
  empty.addWorksheet("Sheet1");
  const emptyBuffer = await empty.xlsx.writeBuffer();
  const emptyResult = await parseOfficePivotBuffer(emptyBuffer as unknown as ArrayBuffer);
  assert.equal(emptyResult.rows.length, 0);
  assert.deepEqual(emptyResult.badUnitsRows, []);

  // A NAMED product with a non-numeric units cell is REPORTED as bad, not imported as 0 units.
  const bad = new ExcelJS.Workbook();
  const badSheet = bad.addWorksheet("Sheet1");
  badSheet.addRow(["Row Labels", "Sum of المبيعات"]);
  badSheet.addRow(["Conviban 100 ml", 3148]);
  badSheet.addRow(["Tebofortin 40 ml", "N/A"]); // unreadable units on a real product
  const badResult = await parseOfficePivotBuffer((await bad.xlsx.writeBuffer()) as unknown as ArrayBuffer);
  assert.equal(badResult.rows.length, 1, "only the numeric row is a real data row");
  assert.equal(badResult.rows[0].productName, "Conviban 100 ml");
  assert.equal(badResult.badUnitsRows.length, 1, "the unreadable-units product must be flagged, not zeroed");
  assert.equal(badResult.badUnitsRows[0].productName, "Tebofortin 40 ml");
  assert.equal(badResult.badUnitsRows[0].rawUnits, "N/A");
  assert.ok(
    !badResult.rows.some((r) => r.units === 0),
    "no product should have been silently coerced to 0 units",
  );
}
