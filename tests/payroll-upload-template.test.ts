import assert from "node:assert/strict";
import JSZip from "jszip";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { createFallbackWorkbook } from "../app/api/payroll/template/route.ts";
import { validateSalaryWorkbook } from "../src/lib/payroll/salary-import.ts";

// The payroll UPLOAD template is the one payroll file people type into and send back, and the
// restyle put two new rows of text above its header row: the house masthead (1-3) and the section
// captions (4). That is precisely the change that can swallow an upload without any error, because
// the importer does not know where the header is — `findHeaderRow` SCORES rows 1 to 12 by how many
// required columns each contains and takes the best.
//
// The captions are the danger. Three of them ("Total Additions", "Governmental Deductions",
// "Total Deductions") are also real column names, so row 4 is not obviously a non-header. It is
// safe only because the four REQUIRED columns — hrId, fullName, grossSalary, netSalary — appear on
// row 5 and nowhere else. That is a property worth pinning rather than reasoning about once.

/** Hexes from the three palettes this template used to carry. None may survive. */
const RETIRED_COLOURS = [
  "1E3A8A", // Employee Data navy
  "0F766E", // Fixed Salary teal
  "16A34A", // Additions green
  "7C3AED", // Governmental Deductions purple
  "DC2626", // Internal Deductions red
  "991B1B", // Total Deductions dark red
  "F97316", // Phoenix orange
  "111827", // the old title bar
];

export async function runPayrollUploadTemplateTests() {
  const workbook = await createFallbackWorkbook([], 8, 2026);
  const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;

  // ── 1. the row plan the importer depends on ─────────────────────────────────
  const sheet = workbook.worksheets[0];
  assert.ok(sheet, "the upload sheet must exist");
  assert.equal(sheet.name, "Payroll Upload", "the importer reads worksheets[0]");

  const textAt = (row: number, column: number) => String(sheet.getRow(row).getCell(column).value ?? "").trim();
  const rowTexts = (row: number) =>
    Array.from({ length: sheet.columnCount }, (_, index) => textAt(row, index + 1));

  const headerTexts = rowTexts(5);
  for (const required of ["HR_ID", "Full Name", "Gross Salary", "Net Salary"]) {
    assert.ok(headerTexts.includes(required), `row 5 must carry the required column "${required}"`);
  }

  // THE ONE THAT MATTERS. The captions must not contain a required column name, or row 4 could
  // out-score row 5 and every uploaded figure would be read from the wrong row.
  const captionTexts = new Set(rowTexts(4).filter(Boolean));
  for (const required of ["HR_ID", "Full Name", "Gross Salary", "Net Salary"]) {
    assert.ok(
      !captionTexts.has(required),
      `the section caption row must not contain "${required}" — it competes with the real header row`,
    );
  }
  assert.ok(captionTexts.size > 0, "the caption row must actually have captions, or this proves nothing");

  // ── 2. the REAL importer reads it ───────────────────────────────────────────
  const result = await validateSalaryWorkbook(
    new File([Buffer.from(buffer) as unknown as BlobPart], "upload.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  assert.deepEqual(
    result.missingRequiredColumns,
    [],
    "the importer must find every required column — if it locked onto the caption row instead of " +
      "the header row, they would all read as missing",
  );
  const detected = new Set(
    (result.detectedColumns as Array<{ header?: string } | string>).map((column) =>
      typeof column === "string" ? column : (column.header ?? ""),
    ),
  );
  assert.ok(
    detected.size >= 20,
    `the importer should detect the full column set, got ${detected.size}`,
  );

  // ── 3. the retired palettes are gone from the emitted styles ────────────────
  const zip = await JSZip.loadAsync(Buffer.from(buffer));
  const styles = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  assert.ok(styles.length > 0, "the workbook must have a styles part to check");
  for (const colour of RETIRED_COLOURS) {
    assert.ok(
      !styles.toUpperCase().includes(colour),
      `${colour} is from a palette this template no longer wears — it is still in xl/styles.xml`,
    );
  }

  // ── 4. structurally clean ───────────────────────────────────────────────────
  const problems = await checkWorkbook(Buffer.from(buffer), { quiet: true });
  assert.deepEqual(problems, [], `the upload template must be clean: ${problems.join("; ")}`);
}
