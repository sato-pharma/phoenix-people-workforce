import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRawWorkbook } from "../src/lib/sales/normalizer/engine.ts";
import { needsAGuess, normalizeNumberText, twoReadings } from "../src/lib/sales/normalizer/number-text.ts";
import { normalizeAliasKey } from "../src/lib/sales/normalizer/resolvers.ts";
import { describeRefusedRow, isRefusedRow } from "../src/lib/sales/normalizer/row-messages.ts";
import type { Crosswalks, DistributorProfile, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";
import { validateNormalizedUpload } from "../src/lib/sales/upload-validation.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A European number is read for what it is; one that could mean two things is refused by name.
//
// parseNum and discountFrac stripped EVERY comma before Number(), so a quantity written "1.234,56"
// (one thousand two hundred thirty-four point five six) was imported as 1.23456 units, "12,5" as 125
// and a text "1.234" as 1.234 — nothing refused, nothing warned, a wrong sale on the books. The
// engine's own comment even claimed "1.234,56" failed to parse. It never did.
//
// Owner, 2026-09-18:
//   • "1.234,56" (a dot BEFORE a comma) has one meaning: read it as 1234.56 and list it under
//     "Numbers fixed automatically".
//   • a TEXT "1.234" could mean 1.234 or 1234, and "12,5" could mean 12.5 or 125: refuse the row and
//     name the cell. A cell Excel stores as a number is never ambiguous, so it is never refused.
//   • the discount changes no number since 2026-09-07, so none of this adds a refusal on a discount.
//
// Production on 2026-09-18 held none of these in any column the import reads: across the 362,338
// stored rows that keep their raw cells, no number cell in any column had a comma, and no quantity or
// discount cell had a dot followed by exactly three digits. The 10,916 cells that do ("108.553") are
// all prices and sheet values, which every profile recomputes as units x factory price and never
// reads. So the fix re-reads nothing already imported.
// ─────────────────────────────────────────────────────────────────────────────

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
function sale(qty: unknown, discount: unknown = "", net: unknown = 0) {
  return ["LA001", "Lacto 1", qty, net, "2026/08/31", "C1", "Pharmacy X", "Nasr City", discount];
}

async function normalize(rows: unknown[][], using: DistributorProfile = profile): Promise<NormalizeResult> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Item Code", "Item Name", "Quantity", "Net", "Date", "Client Code", "Client Name", "Territory Name", "Discount%"]);
  rows.forEach((r) => ws.addRow(r));
  const buffer = await wb.xlsx.writeBuffer();
  return normalizeRawWorkbook(buffer as unknown as ArrayBuffer, using, maps);
}

function refusals(result: NormalizeResult): string[] {
  return result.exceptions.filter(isRefusedRow).map(describeRefusedRow);
}

export async function runSosEuropeanDecimalMisreadTests() {
  const result = await normalize([
    sale("1.234,56"), // row 2: dot for thousands, comma for decimals — one meaning
    sale("1.234"), // row 3: text — 1.234 or 1234?
    sale("12,5"), // row 4: text — 12.5 or 125?
    sale(1.234), // row 5: a NUMBER cell holding 1.234 — one value, never refused
    sale("1,200"), // row 6: a comma between whole groups of three is thousands, as always
    sale("0.500"), // row 7: a leading zero is never a thousands group
    sale("1,23,456"), // row 8: a comma that is not between groups of three
    sale(10, "12.500"), // row 9: the same "1.234" shape in a DISCOUNT refuses nothing
    sale("-1.234,5"), // row 10: a return, European-written
    sale({ formula: "1234/1000", result: 1.234 }), // row 11: a formula whose cached result is a number
  ]);
  const byRow = new Map(result.coded.map((r) => [r.rawRowNumber, r]));

  // ── The headline: "1.234,56" is 1234.56, never 1.23456 ─────────────────────
  assert.equal(
    byRow.get(2)?.qty,
    1234.56,
    'a quantity written "1.234,56" must be read as 1234.56 — every comma was stripped and it was imported as 1.23456 units, silently',
  );
  assert.equal(byRow.get(10)?.qty, -1234.5, "a European-written return reads the same way");

  // ── A text cell that could mean two numbers is refused, never guessed ──────
  assert.deepEqual(
    result.exceptions.map((e) => [e.rawRowNumber, e.reason, e.rawCell]),
    [
      [3, "unparseable_qty", "1.234"],
      [4, "unparseable_qty", "12,5"],
      [8, "unparseable_qty", "1,23,456"],
    ],
    'a text "1.234" was read as 1.234 and "12,5" as 125 — each must be refused with the cell as written',
  );
  assert.deepEqual(refusals(result), [
    'Row 3: quantity "1.234" could mean 1.234 or 1234, so it is not guessed',
    'Row 4: quantity "12,5" could mean 12.5 or 125, so it is not guessed',
    'Row 8: quantity "1,23,456" has a comma in the wrong place',
  ]);

  // ── What Excel stores as a number, and plain forms, read exactly as before ──
  assert.equal(byRow.get(5)?.qty, 1.234, "a number cell has one value however it prints — it is never refused");
  assert.equal(byRow.get(11)?.qty, 1.234, "nor is a formula whose cached result is a number");
  assert.equal(byRow.get(6)?.qty, 1200, "whole-group thousands still read");
  assert.equal(byRow.get(7)?.qty, 0.5, '"0.500" can only be a half');
  assert.equal(byRow.get(9)?.discount, 0.125, "a discount changes no number, so this refuses no discount: 12.500 stays 12.5%");

  // ── Every European read is listed, and the upload says what it read ────────
  assert.deepEqual(result.cellCorrections, [
    { rawRowNumber: 2, field: "quantity", raw: "1.234,56", read: 1234.56 },
    { rawRowNumber: 10, field: "quantity", raw: "-1.234,5", read: -1234.5 },
  ], "only the rewritten cells are listed — a number cell, a plain 1,200 and a plain 0.500 are not");
  const fixed = validateNormalizedUpload(result, { valueSource: "recompute", hasDateColumn: true })
    .findings.find((f) => f.code === "cells_read_after_fix");
  assert.ok(fixed, "a European number must never be read silently");
  assert.equal(fixed.severity, "warning", "reading a one-meaning number never blocks the file");
  assert.equal(
    fixed.detail,
    "2 number cells were written in a form the import rewrote before reading: "
      + 'Row 2: quantity "1.234,56" read as 1,234.56; Row 10: quantity "-1.234,5" read as -1,234.5.',
  );

  // ── A value the sheet supplies follows the same rules ──────────────────────
  const sheetValued = await normalize(
    [sale(10, "", "1.234,56"), sale(10, "", "12,5"), sale(10, "", "1.234")],
    { ...profile, valueSource: "sheet" },
  );
  assert.equal(sheetValued.coded[0]?.value, 1234.56, 'a sheet value written "1.234,56" is 1234.56');
  assert.deepEqual(refusals(sheetValued), [
    'Row 3: value "12,5" could mean 12.5 or 125, so it is not guessed',
    'Row 4: value "1.234" could mean 1.234 or 1234, so it is not guessed',
  ]);

  // ── normalizeNumberText: the dot-before-comma form is rewritten, nothing else ──
  const rewritten: [string, string][] = [
    ["1.234,56", "1234.56"],
    ["1.234.567,8", "1234567.8"],
    ["-1.234,5", "-1234.5"],
    ["1.234,5%", "1234.5%"],
  ];
  for (const [raw, read] of rewritten) assert.equal(normalizeNumberText(raw), read, `"${raw}" has one meaning`);
  for (const left of ["1.234", "12,5", "1.23,45", "1.2345,6", "1.234.567", "1,234.56"]) {
    assert.equal(normalizeNumberText(left), left, `"${left}" is not the dot-before-comma form and must be left alone`);
  }
  // The Arabic signs name their own roles — decimal "٫", then thousands "٬" — so this is not European.
  assert.equal(normalizeNumberText("١٫٢٣٤٬٥٦"), "1.234,56", "Arabic separators are folded, never re-read as European");

  // ── What counts as a guess ─────────────────────────────────────────────────
  for (const guess of ["1.234", "-100.000", "12,5", "1234,567", "1,23,456", ","]) {
    assert.equal(needsAGuess(guess), true, `"${guess}" could only be read by guessing`);
  }
  for (const plain of ["1234.56", "0.500", "1234.567", "12.5", "1,200", "12,345.5", "-1,200", "7"]) {
    assert.equal(needsAGuess(plain), false, `"${plain}" has one reading`);
  }
  assert.deepEqual(twoReadings("100.000"), ["100.000", "100000"]);
  assert.deepEqual(twoReadings("1234,567"), ["1234.567", "1234567"]);
  assert.equal(twoReadings("1,200"), null, "a thousands group is not a decimal comma");
}
