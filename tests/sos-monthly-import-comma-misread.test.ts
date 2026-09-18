import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import {
  normalizeSourceOfSalesProductInput,
  parseDiscount,
  validateDistributorSalesWorkbookBuffer,
  type DistributorSalesValidationResult,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The coded importer reads a European number for what it is, and refuses one it would have to guess at.
//
// parseNumber and parseDiscount in monthly-distributor-import.ts stripped EVERY comma before Number(),
// the defect #4024 fixed in the Normalizer's engine: a quantity written "1.234,56" was read as 1.23456
// units, a text "12,5" as 125 and a text "1.234" as 1.234 — nothing refused, nothing listed. This is the
// reader behind Direct orders on Sales Upload, the coded/hybrid sheets on the Monthly Sales wizard, and
// the Normalizer's one-click import.
//
// Owner, 2026-09-18, the same rules as the engine:
//   • "1.234,56" (a dot BEFORE a comma) has one meaning: read it as 1234.56 and list it.
//   • a TEXT quantity or value "1.234" (1.234 or 1234?) or "12,5" (12.5 or 125?) is refused and the
//     cell named. A cell Excel stores as a number is never refused.
//   • a discount gets no new refusal: it multiplies nothing since 2026-09-07.
//   • Direct orders follow the same rule — asked the same day, he chose "refuse it like distributors".
//
// Production on 2026-09-18 held none of these: of the rows the importer ever stored with their raw
// cells (730 Direct, 83,601 Normalizer, 27,947 Office), no cell in any column had a comma, and no
// Direct quantity was fractional or had a dot followed by exactly three digits. The Normalizer's
// in-memory sheet writes typed numbers, so it can never meet the new refusal. Nothing re-reads.
// ─────────────────────────────────────────────────────────────────────────────

const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "Direct", name: "Direct (Company)" },
  ],
  products: [
    { factoryPrice: 10, family: "Pedia", familyCode: "PED", line: "Pedia", productCode: "P-A", productName: "Product A", source: "" },
  ],
  regions: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  areas: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  blocks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" }],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
  ],
};

async function read(distributorCode: string, headers: string[], row: unknown[]): Promise<DistributorSalesValidationResult> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(headers);
  sheet.addRow(row);
  return validateDistributorSalesWorkbookBuffer({
    buffer: (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer,
    distributorCode,
    fileName: `${distributorCode}.xlsx`,
    references,
  });
}

// One distributor row: a JS string lands as a TEXT cell, a JS number as a NUMBER cell.
const readPs = (qty: unknown, discount: unknown = 0) =>
  read("PS", ["Invoice Date", "Qty", "Discount%", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"], [
    new Date("2026-08-03T00:00:00Z"), qty, discount, "P-A", "B-1", "A1", "CA", "PS",
  ]);

// One Direct row: the one channel whose Value is read from the sheet.
const readDirect = (qty: unknown, value: unknown) =>
  read("Direct", ["Date", "Product", "QTY", "Value", "Product ID", "Region ID", "Distrub ID"], [
    new Date("2026-08-03T00:00:00Z"), "Product A", qty, value, "P-A", "CA", "Direct",
  ]);

const messages = (result: DistributorSalesValidationResult, severity: "failure" | "warning") =>
  result.issues.filter((issue) => issue.severity === severity).map((issue) => issue.message);

export async function runSosMonthlyImportCommaMisreadTests() {
  // ── 1. A dot before a comma has one reading: 1234.56, and the row says so ──
  {
    const euro = await readPs("1.234,56");
    assert.equal(euro.totals.totalQty, 1234.56, 'a text quantity "1.234,56" is 1234.56 units, never 1.23456');
    assert.equal(euro.status, "validated", "a number with one meaning never blocks the sheet");
    assert.equal(euro.failedRows, 0);
    assert.deepEqual(messages(euro, "warning"), ['Qty "1.234,56" was read as 1,234.56.'], "the rewritten cell is listed with what it was read as");

    const direct = await readDirect(3, "1.234,56");
    assert.equal(direct.totals.totalValue, 1234.56, 'a Direct text value "1.234,56" is 1234.56, never 1.23456');
    assert.equal(direct.status, "validated");
    assert.deepEqual(messages(direct, "warning"), ['Value "1.234,56" was read as 1,234.56.']);
  }

  // ── 2. A text quantity with two readings is refused and the cell named ──
  {
    const comma = await readPs("12,5");
    assert.equal(comma.status, "blocked", 'a text "12,5" is never read as 125 units');
    assert.equal(comma.failedRows, 1);
    assert.equal(comma.totals.totalQty, 0, "a refused quantity puts nothing on the books");
    assert.deepEqual(messages(comma, "failure"), ['Qty "12,5" could mean 12.5 or 125, so it is not guessed.']);

    const dot = await readPs("1.234");
    assert.equal(dot.status, "blocked", 'a text "1.234" is never quietly read as 1.234 units');
    assert.deepEqual(messages(dot, "failure"), ['Qty "1.234" could mean 1.234 or 1234, so it is not guessed.']);

    const scattered = await readPs("1,2,3");
    assert.deepEqual(messages(scattered, "failure"), ['Qty "1,2,3" has a comma in the wrong place.'], "a comma between no whole groups of three is never dropped");
  }

  // ── 3. Direct follows the same rule, for its value and its quantity ──
  {
    const comma = await readDirect(3, "12,5");
    assert.equal(comma.status, "blocked", 'a Direct text value "12,5" is never read as 125');
    assert.deepEqual(messages(comma, "failure"), ['Value "12,5" could mean 12.5 or 125, so it is not guessed.']);

    const dot = await readDirect(3, "1.234");
    assert.deepEqual(messages(dot, "failure"), ['Value "1.234" could mean 1.234 or 1234, so it is not guessed.']);

    const qty = await readDirect("12,5", 100);
    assert.deepEqual(messages(qty, "failure"), ['Qty "12,5" could mean 12.5 or 125, so it is not guessed.'], "a Direct quantity is refused like a distributor's");
  }

  // ── 4. What already read correctly still does, with nothing new said ──
  {
    const typed = await readPs(1.234);
    assert.equal(typed.totals.totalQty, 1.234, "a cell Excel stores as a NUMBER is taken as it is, never refused");
    assert.equal(typed.issues.length, 0);

    const typedValue = await readDirect(3, 1.234);
    assert.equal(typedValue.totals.totalValue, 1.234, "a Direct value stored as a number is never refused");
    assert.equal(typedValue.issues.length, 0);

    const grouped = await readPs("1,200");
    assert.equal(grouped.totals.totalQty, 1200, "a comma between whole groups of three is a thousands separator");
    assert.equal(grouped.issues.length, 0, "a plain thousands separator is not listed as a fix");

    const empty = await readDirect(3, null);
    assert.equal(empty.status, "validated", "an empty Direct value is still a legitimate zero");
    assert.equal(empty.totals.totalValue, 0);
  }

  // ── 5. A form with one meaning that used to refuse the row is read, and listed ──
  {
    const arabic = await readPs("١٢٠");
    assert.equal(arabic.totals.totalQty, 120, "Arabic-Indic digits are read, as the engine reads them");
    assert.deepEqual(messages(arabic, "warning"), ['Qty "١٢٠" was read as 120.']);
  }

  // ── 6. A discount gets no new refusal ──
  {
    const discounted = await readPs(10, "12,5");
    assert.equal(discounted.status, "validated", "an unreadable discount never refuses the row: it multiplies nothing");
    assert.equal(discounted.failedRows, 0);
    assert.equal(discounted.totals.totalValue, 100, "value stays units x factory price");

    assert.deepEqual(parseDiscount("12,5"), { rate: 0, outOfRange: false }, 'a discount "12,5" is unreadable like "abc", never 125%');
    assert.deepEqual(parseDiscount("12,5%"), { rate: 0, outOfRange: false });
    assert.deepEqual(parseDiscount("25٪"), { rate: 0.25, outOfRange: false }, "the Arabic percent sign is read");
    assert.deepEqual(parseDiscount("25%"), { rate: 0.25, outOfRange: false });
  }

  // ── 7. The product form's Factory Price shares parseNumber: the comma is fixed, "1.234" is not refused ──
  {
    const product = (factoryPrice: string) =>
      normalizeSourceOfSalesProductInput({
        factoryPrice,
        family: "Family",
        familyCode: "FA",
        line: "Pedia",
        productCode: "P-X",
        productName: "Product X",
        source: "Source",
      });
    assert.equal(product("1.234,56").factoryPrice, 1234.56);
    assert.equal(product("1,250.75").factoryPrice, 1250.75);
    // The edit form sends String(price) back, so a three-decimal price must stay readable.
    assert.equal(product("123.456").factoryPrice, 123.456, "the two-readings refusal is for sheet cells, not the product form");
    assert.throws(() => product("12,5"), SalesWorkflowError, 'a Factory Price "12,5" is refused, never saved as 125');
  }
}

// The product's Source Row Number shared the same blind comma strip: "1,2" was saved as row 12. The form's
// field is a number input, so only a direct call to the products API could send one; production held no
// source row number on any of its 30 products on 2026-09-18, so nothing is re-read.
export function runProductSourceRowNumberCommaTests() {
  const rowNumber = (sourceRowNumber: string | number | null) =>
    normalizeSourceOfSalesProductInput({
      factoryPrice: 10,
      family: "Family",
      familyCode: "FA",
      line: "Pedia",
      productCode: "P-X",
      productName: "Product X",
      source: "Source",
      sourceRowNumber,
    }).sourceRowNumber;

  assert.throws(() => rowNumber("1,2"), SalesWorkflowError, 'a Source Row Number "1,2" is refused, never saved as row 12');
  assert.throws(() => rowNumber("12,5"), SalesWorkflowError, 'a Source Row Number "12,5" is refused, never saved as row 125');
  assert.equal(rowNumber("1,200"), 1200, "a comma between whole groups of three is a thousands separator");
  assert.equal(rowNumber("12"), 12);
  assert.equal(rowNumber(12), 12, "the number the form sends is taken as it is");
  assert.equal(rowNumber("١٢"), 12, "Arabic-Indic digits are read, as everywhere else in the importer");
  assert.equal(rowNumber(""), null, "an empty row number stays empty");
  assert.equal(rowNumber(null), null);
  assert.throws(() => rowNumber("1.5"), SalesWorkflowError, "a row number is still a positive whole number");
}
