import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { CODED_HEADERS, buildCodedWorkbook } from "@/lib/sales/normalizer/service";
import { resolveInvoiceDate } from "@/lib/sales/monthly-distributor-import";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";

// THE CODED SHEET MUST CARRY THE INVOICE **DAY**, NOT THE PERIOD.
//
// Audit run wf_2196360f-a88, defect #4. The normalizer round-trips its rows out through a coded
// workbook and back in through the standard importer. That sheet's "Invoice Date" column was
// written with `invoiceDate`, which in the NORMALIZER means the PERIOD ("2026-04"); the real date
// lives in `invoiceDay`. The importer derives BOTH values from that one column, and
// `resolveInvoiceDate` only accepts an ISO date, so the period resolved and the day came out NULL.
//
// Measured on production 2026-09-05: 126,321 rows across 2026-04..06 — about 90% of each month —
// have no invoice_date. It is why the IS-S April/May duplicate cannot be settled from the database:
// all 2,282 of its rows carry no day.
//
// This test EXERCISES THE EMITTED WORKBOOK rather than reading the source. §2.1: three defects
// shipped in one night from checking source text instead of the artifact it produces.

function codedRow(over: Partial<CodedRow>): CodedRow {
  return {
    areaCode: "A1",
    areaName: "Area 1",
    bonusQty: 0,
    brickId: "B1",
    brickName: "Brick 1",
    clientAddress: null,
    clientCode: "C1",
    clientName: "Client 1",
    discount: 0,
    distributorCode: "IS-S",
    invoiceDate: "2026-04",
    invoiceDay: "2026-04-17",
    invoiceNumber: null,
    isDirect: false,
    officialLine: "CNS",
    productCode: "P1",
    productName: "Product 1",
    qty: 1,
    rawRow: {},
    regionCode: "R1",
    regionName: "Region 1",
    value: 100,
    ...over,
  } as CodedRow;
}

function resultWith(rows: CodedRow[]): NormalizeResult {
  return {
    blankCustomerRows: [],
    coded: rows,
    customerBrickCorrections: [],
    distributorCode: "IS-S",
    exceptions: [],
    ignoredRows: [],
    summary: {} as NormalizeResult["summary"],
  } as NormalizeResult;
}

async function readInvoiceDateColumn(result: NormalizeResult): Promise<string[]> {
  const buffer = await buildCodedWorkbook(result);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as ArrayBuffer);
  const sheet = book.getWorksheet("Coded");
  assert.ok(sheet, "the workbook must have a Coded sheet");

  const headerRow = sheet.getRow(1);
  let column = -1;
  headerRow.eachCell((cell, index) => {
    if (String(cell.value ?? "").trim() === "Invoice Date") column = index;
  });
  assert.ok(column > 0, "the Coded sheet must still have an 'Invoice Date' column");

  const values: string[] = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    values.push(String(sheet.getRow(row).getCell(column).value ?? ""));
  }
  return values;
}

async function testTheSheetCarriesTheDay() {
  const [written] = await readInvoiceDateColumn(resultWith([codedRow({})]));

  assert.equal(written, "2026-04-17", "the cell must hold the DAY, not the period");
  assert.notEqual(written, "2026-04", "writing the period here is the defect this test exists for");

  // And the importer must actually be able to read a day back out of it. This is the half that
  // matters — the cell being right is only useful if resolveInvoiceDate accepts it.
  assert.equal(
    resolveInvoiceDate(written, undefined, "2026-04"),
    "2026-04-17",
    "the importer must resolve a real day from the emitted cell",
  );
}

function testThePeriodFormCollapsesOntoDayOne() {
  // Pins the actual mechanism, so nobody "simplifies" the fix back to writing the period.
  //
  // Measured, not assumed: a period string does NOT resolve to null. resolveInvoiceDate's ISO
  // branch needs three groups, so "2026-04" falls through and the row is stamped on the FIRST of
  // the month. That is the dangerous shape — a plausible date rather than an obvious gap, which is
  // why it survived: nothing looks broken when every invoice claims day 1.
  assert.equal(
    resolveInvoiceDate("2026-04", undefined, "2026-04"),
    "2026-04-01",
    "a period cell collapses onto day 1 — this is what writing the period actually costs",
  );
  assert.notEqual(
    resolveInvoiceDate("2026-04", undefined, "2026-04"),
    "2026-04-17",
    "and it cannot recover the real day, which is the whole point",
  );
}

async function testARowWithNoDateStillLandsInItsPeriod() {
  // Fallback: a source row with no usable date keeps today's behaviour rather than losing its month.
  const [written] = await readInvoiceDateColumn(resultWith([codedRow({ invoiceDay: null })]));
  assert.equal(written, "2026-04", "with no day available the period must still be written");
}

async function testTheColumnSetIsUnchanged() {
  // The sheet is a human-edited artifact and the importer matches its columns BY NAME. Adding or
  // reordering columns here changes what an operator sees and what a hand-made sheet must contain,
  // so the fix deliberately changes a VALUE and not the shape.
  assert.equal(CODED_HEADERS.length, 15, "the coded sheet's column set must not change");
  assert.equal(CODED_HEADERS[10], "Invoice Date", "the Invoice Date column must stay in place");
}

export async function runNormalizerCodedSheetDayTests() {
  await testTheSheetCarriesTheDay();
  testThePeriodFormCollapsesOntoDayOne();
  await testARowWithNoDateStillLandsInItsPeriod();
  await testTheColumnSetIsUnchanged();
}
