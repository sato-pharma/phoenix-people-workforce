import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRawWorkbook } from "../src/lib/sales/normalizer/engine.ts";
import { normalizeNumberText } from "../src/lib/sales/normalizer/number-text.ts";
import { normalizeAliasKey } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks, DistributorProfile } from "../src/lib/sales/normalizer/types.ts";
import { withRefusedRowsFinding } from "../src/lib/sales/sales-upload.ts";
import { exceptionToIssue } from "../src/lib/sales/source-of-sales-upload.ts";
import { validateNormalizedUpload } from "../src/lib/sales/upload-validation.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A number the upload can read with one meaning only is read, and said; one it would have to guess
// at is refused, and said exactly.
//
// Owner, 2026-09-18, on the refused-rows fix: "if it is fixable, make the validator fix it, and if not
// fixable, clearly highlight what's the issue when I am blocked". Before this, a quantity written in
// Arabic-Indic digits ("١٬٢٠٠") or with its thousands grouped by a space ("1 200") was as unreadable
// to the engine as "1,2OO" with a letter O — one such cell refused the WHOLE file, and the refusal
// named only a count and row numbers. A discount written "1%" was refused as possibly 100%.
//
// Now the engine rewrites the one-meaning forms before reading them (normalizeNumberText), lists every
// one it rewrote as a "Numbers fixed automatically" warning, and a refused row names its cell and what
// is wrong with it. A letter, a bracket or a stray word inside a number is still never guessed.
// ─────────────────────────────────────────────────────────────────────────────

const NBSP = String.fromCharCode(0xa0);
const THIN = String.fromCharCode(0x2009);
const NARROW = String.fromCharCode(0x202f);
const MINUS = String.fromCharCode(0x2212);

const maps: Crosswalks = {
  brickById: new Map([
    ["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
  ]),
  areaByCode: new Map([["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }]]),
  regionByCode: new Map([["CA", { regionCode: "CA", regionName: "Cairo" }]]),
  productByCode: new Map([["LA001", { productCode: "LA001", productName: "Lacto 1", factoryPrice: 10, line: "Pedia" }]]),
  productAliasByKey: new Map(),
  territoryAliasByKey: new Map([[normalizeAliasKey("Nasr City"), { targetType: "brick", targetCode: "B1" }]]),
  areaAliasByKey: new Map(),
  regionAliasByKey: new Map(),
  customerBrickByKey: new Map(),
  customerBrickByCanonicalKey: new Map(),
  productByCanonicalCode: new Map(),
};

const profile: DistributorProfile = {
  distributorCode: "IS",
  distributorName: "Ibn sina",
  productColumns: ["Item Code", "Item Name"],
  qtyColumns: ["Quantity"],
  valueColumns: ["Net"],
  valueSource: "recompute",
  dateColumns: ["Date"],
  customerCodeColumns: ["Client Code"],
  customerNameColumns: ["Client Name"],
  territoryColumns: ["Territory Name"],
  discountColumns: ["Discount%"],
};

// One data row per case; the sheet row number is the index + 2 (row 1 is the header).
function sale(qty: unknown, discount: unknown = "") {
  return ["LA001", "Lacto 1", qty, 0, 0, "2026/08/31", "C1", "Pharmacy X", "Nasr City", discount];
}

async function buildRaw(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Item Code", "Item Name", "Quantity", "Free Unit", "Net", "Date", "Client Code", "Client Name", "Territory Name", "Discount%"]);
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

export async function runSosNumberCellsAutoFixTests() {
  const buffer = await buildRaw([
    sale("١٬٢٠٠"), // row 2: Arabic-Indic digits and thousands separator
    sale(`1${NBSP}200`), // row 3: thousands grouped with a no-break space
    sale("٣٥", "٥٪"), // row 4: Arabic digits in the quantity and an Arabic-percent discount
    sale(10, "1%"), // row 5: "1%" is 1%, not "1% or 100%"
    sale("1,2OO"), // row 6: letter O — never guessed
    sale("12 5"), // row 7: not whole groups of three — never guessed
    sale("(120)"), // row 8: bracketed — never guessed
    sale(5, "1"), // row 9: a bare 1 is 1% or 100% — never guessed
  ]);
  const result = await normalizeRawWorkbook(buffer as unknown as ArrayBuffer, profile, maps);
  const byRow = new Map(result.coded.map((r) => [r.rawRowNumber, r]));

  // ── The headline: a one-meaning number is read, not refused ─────────────────
  assert.equal(
    byRow.get(2)?.qty,
    1200,
    "a quantity written in Arabic-Indic digits must be read as the number it plainly is — it refused the whole file",
  );
  assert.equal(byRow.get(2)?.value, 12000, "and it is priced like any other row");
  assert.equal(byRow.get(3)?.qty, 1200, "thousands grouped with a no-break space are read");
  assert.equal(byRow.get(4)?.qty, 35);
  assert.equal(byRow.get(4)?.discount, 0.05, "an Arabic percent sign is a percent");
  assert.equal(byRow.get(5)?.discount, 0.01, "a discount written with a % sign is a percent: 1% is 1%, never refused as maybe 100%");

  // ── Every rewritten cell is recorded, with what it was read as ──────────────
  assert.deepEqual(result.cellCorrections, [
    { rawRowNumber: 2, field: "quantity", raw: "١٬٢٠٠", read: 1200 },
    { rawRowNumber: 3, field: "quantity", raw: `1${NBSP}200`, read: 1200 },
    { rawRowNumber: 4, field: "quantity", raw: "٣٥", read: 35 },
    { rawRowNumber: 4, field: "discount", raw: "٥٪", read: 0.05 },
  ], "only cells the engine rewrote are listed — a plain 10 and a plain 1% are not");

  // ── ...and the validator says so, as a warning that never blocks ────────────
  const report = validateNormalizedUpload(result, { valueSource: "recompute", hasDateColumn: true });
  const fixed = report.findings.find((f) => f.code === "cells_read_after_fix");
  assert.ok(fixed, "a rewritten number must never be read silently");
  assert.equal(fixed.severity, "warning", "reading a one-meaning number is not a reason to block the file");
  assert.equal(fixed.title, "Numbers fixed automatically");
  assert.equal(fixed.count, 4);
  assert.deepEqual(fixed.sampleRows, [2, 3, 4], "each row once");
  assert.equal(
    fixed.detail,
    "4 number cells were written in a form the import rewrote before reading: "
      + `Row 2: quantity "١٬٢٠٠" read as 1,200; Row 3: quantity "1${NBSP}200" read as 1,200; `
      + "Row 4: quantity \"٣٥\" read as 35; Row 4: discount \"٥٪\" read as 5%.",
  );
  const plain = await normalizeRawWorkbook((await buildRaw([sale(10, "5%")])) as unknown as ArrayBuffer, profile, maps);
  assert.deepEqual(plain.cellCorrections, [], "a sheet of plain numbers records nothing");
  assert.equal(
    validateNormalizedUpload(plain, { valueSource: "recompute", hasDateColumn: true }).findings.some((f) => f.code === "cells_read_after_fix"),
    false,
    "and shows no warning",
  );

  // ── What cannot be read without guessing is refused, and named cell by cell ──
  assert.deepEqual(
    result.exceptions.map((e) => [e.rawRowNumber, e.reason, e.rawCell]),
    [
      [6, "unparseable_qty", "1,2OO"],
      [7, "unparseable_qty", "12 5"],
      [8, "unparseable_qty", "(120)"],
      [9, "discount_out_of_range", "1"],
    ],
    "each refused row carries the cell exactly as the sheet wrote it",
  );
  const refused = withRefusedRowsFinding(report, result.exceptions).findings[0];
  assert.equal(refused.code, "rows_refused");
  assert.equal(
    refused.detail,
    "3 with a quantity that cannot be read · 1 with a discount that is unreadable, negative, or 100% or more. "
      + "Row 6: quantity \"1,2OO\" has letters in it; Row 7: quantity \"12 5\" is not a number; "
      + "Row 8: quantity \"(120)\" is in brackets; "
      + "Row 9: discount \"1\" could mean 1% or 100%, so it is not guessed; write 1% or 100%. "
      + "One such row is enough for the import to refuse the whole file, not just these rows, and no mapping can fix them.",
  );

  // ── The older monthly wizard says the same, and no longer blames mapping ─────
  const issue = exceptionToIssue(result.exceptions[0]!);
  assert.equal(issue.field, "Quantity", "not one of the wizard's map-now fields: mapping cannot fix a cell");
  assert.equal(issue.value, "1,2OO");
  assert.equal(
    issue.message,
    "Row 6: quantity \"1,2OO\" has letters in it. Mapping cannot fix this: correct the row in the distributor's sheet, then re-upload.",
  );

  // ── normalizeNumberText: one meaning is rewritten, anything else is left for a person ──
  const rewritten: [string, string][] = [
    ["١٢٠", "120"],
    ["۱۲۰", "120"],
    ["١٫٥", "1.5"],
    ["١٬٢٠٠", "1,200"],
    ["١٠٪", "10%"],
    [`${MINUS}5`, "-5"],
    [`12${THIN}345${NARROW}678`, "12345678"],
    ["1 200.50", "1200.50"],
    ["-1 200", "-1200"],
    ["  7  ", "7"],
  ];
  for (const [raw, read] of rewritten) assert.equal(normalizeNumberText(raw), read, `"${raw}" has one meaning`);
  for (const guess of ["1,2OO", "(120)", "120 box", "12 5", "1 23", "1 200,50", "n/a"]) {
    assert.equal(normalizeNumberText(guess), guess, `"${guess}" must be left unreadable, never guessed at`);
  }
}
