import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { normalizeRows, sheetCarriesDate, validateSheetHeaders } from "@/lib/sales/normalizer/engine";
import { formUndatedPeriod } from "@/lib/sales/normalizer/multi-file";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// EGD's 2024 sheets on the Source Normalizer.
//
// The owner, 2026-10-26, uploading thirteen EGD workbooks: "egd 7.xlsx" was refused for a missing
// Quantity (QTY_INVOICE) and Date (INVOICE_DATE). Measured on his files, EGD sent three layouts:
//   • today's: QTY_INVOICE, TOTAL_VALUE_INVOICE, INVOICE_DATE, MRKZ_N;
//   • January–February 2024: "net qty", VALUE, DATE_TRANS, DISTRICT_NAME;
//   • a cut-down summary for some months: "Sales" for the units and NO date, value or item code.
// He chose "Teach the old layouts": the older names are read as the same fields, and a summary with
// no date goes in only under a month picked on screen — never under a guess, and never over a date
// a sheet does carry. Value is recomputed from the Phoenix price, so a missing value loses nothing.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT = "TB080";
const PRODUCT_SHEET_NAME = "TEBOFORTIN FORT TABS 80 MG 30";
const PRICE = 76.5;
const BRICK = "IS101";
const CUSTOMER = "58693";

function egd(): DistributorProfile {
  const p = rawProfileForDistributor("EG");
  assert.ok(p, "the EG profile must exist — this test reads the real one");
  return p;
}

function crosswalks(): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK, {
      areaCode: "IS1", areaName: "Ismailia 1", blockCode: "IS1-1", brickId: BRICK, brickName: "Ismailia",
      regionCode: "CN", regionName: "Canal",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map([[`${normalizeCodeKey("EG")} ${normalizeCodeKey(CUSTOMER)}`, BRICK]]),
    productAliasByKey: new Map([[`${normalizeCodeKey("EG")} ${normalizeAliasKey(PRODUCT_SHEET_NAME)}`, PRODUCT]]),
    productByCanonicalCode: new Map(),
    productByCode: new Map([[PRODUCT, { productCode: PRODUCT, productName: "Tebofortin Fort", factoryPrice: PRICE, line: "CNS" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
  } as unknown as Crosswalks;
}

function sheetOf(headers: string[], rows: unknown[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("Sheet1");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

// The January 2024 sheet's own columns, in its own order (egd 1.xlsx).
const JANUARY_2024 = () => sheetOf(
  ["branch", "net qty", "ITEM_NAME", "CUSTOMER_CODE", "CUSTOMER_NAME", "DATE_TRANS", "ITEM_CODE", "GOV_NAME", "DISTRICT_NAME", "CUSTOMER_ADDRESS", "VALUE"],
  [
    ["الإسماعيلية", 1, PRODUCT_SHEET_NAME, CUSTOMER, "الممر-إسماعيلية", "01/01/2024", 3116, "الإسماعيلية", "الاسماعيليه", "134 شارع سيناء", 76.5],
    ["الإسماعيلية", 2, PRODUCT_SHEET_NAME, CUSTOMER, "الممر-إسماعيلية", "02/01/2024", 3116, "الإسماعيلية", "الاسماعيليه", "134 شارع سيناء", 153],
  ],
);

// The summary sheet's own columns (egd 7.xlsx): no date, no value, no item code.
const SUMMARY = () => sheetOf(
  ["BRANCH_NAME", "Sales", "ITEM_NAME", "CUSTOMER_CODE", "CUSTOMER_NAME", "CUSTOMER_ADDRESS"],
  [
    ["فرع سوهاج محطة", 2, PRODUCT_SHEET_NAME, CUSTOMER, "احمد جمال/ سفلاق", "شارع السلخانة"],
    ["فرع ميت غمر", 3, PRODUCT_SHEET_NAME, CUSTOMER, "احمد السعيد", "ميت غراب"],
  ],
);

function theJanuaryLayoutReadsAsEgd() {
  const header = validateSheetHeaders(JANUARY_2024(), egd(), RAW_DISTRIBUTOR_PROFILES);
  assert.deepEqual(header.missingGroups.map((g) => g.label), [], "the January–February 2024 layout carries every field EGD needs, under its older names");
  assert.equal(header.valid, true);

  const result = normalizeRows(JANUARY_2024(), egd(), crosswalks());
  assert.equal(result.coded.length, 2, "both January rows are coded");
  assert.deepEqual(result.coded.map((r) => r.qty), [1, 2], "\"net qty\" is read as the quantity");
  assert.deepEqual(result.coded.map((r) => r.invoiceDate), ["2024-01", "2024-01"], "DATE_TRANS is read as the invoice date, day first");
  assert.equal(result.coded[1].value, 2 * PRICE, "value is units times the Phoenix price");
}

function theSummaryNeedsAPickedMonth() {
  const sheet = SUMMARY();
  assert.equal(sheetCarriesDate(sheet, egd()), false, "the summary carries no date column");
  assert.equal(sheetCarriesDate(JANUARY_2024(), egd()), true, "the January sheet does");

  const refused = validateSheetHeaders(sheet, egd(), RAW_DISTRIBUTOR_PROFILES);
  assert.equal(refused.valid, false, "with no month picked the summary is refused — its month is unknown");
  assert.deepEqual(refused.missingGroups.map((g) => g.label), ["Date"], "refused for the date alone: \"Sales\" is read as the quantity");

  const taken = validateSheetHeaders(sheet, egd(), RAW_DISTRIBUTOR_PROFILES, { monthPicked: true });
  assert.equal(taken.valid, true, "with its month picked the summary is taken");

  const result = normalizeRows(sheet, egd(), crosswalks(), { undatedPeriod: "2024-07" });
  assert.equal(result.coded.length, 2, "every summary row is coded");
  assert.deepEqual(result.coded.map((r) => r.invoiceDate), ["2024-07", "2024-07"], "every row is filed under the picked month");
  assert.deepEqual(result.coded.map((r) => r.value), [2 * PRICE, 3 * PRICE], "value is recomputed from the price, so the missing value column loses nothing");
}

function aDatedRowKeepsItsOwnMonth() {
  const result = normalizeRows(JANUARY_2024(), egd(), crosswalks(), { undatedPeriod: "2024-07" });
  assert.deepEqual(result.coded.map((r) => r.invoiceDate), ["2024-01", "2024-01"], "a row with its own date is never moved to the picked month");
}

function theFormTakesOnlyARealMonth() {
  const form = (v?: string) => { const f = new FormData(); if (v !== undefined) f.set("undatedPeriod", v); return f; };
  assert.equal(formUndatedPeriod(form()), null, "no month picked reads as none");
  assert.equal(formUndatedPeriod(form("  ")), null);
  assert.equal(formUndatedPeriod(form("2024-07")), "2024-07");
  for (const bad of ["2024-13", "2024-7", "July 2024", "2024-07-01"]) {
    assert.throws(() => formUndatedPeriod(form(bad)), (e: unknown) => e instanceof SalesWorkflowError && e.status === 400, `"${bad}" is refused in words, never read as "no month"`);
  }
}

function everyRouteAndTheScreenCarryTheMonth() {
  for (const route of ["preview", "import", "import-validated", "download", "mappings/template"]) {
    const src = stripComments(readFileSync(`app/api/sales/normalizer/${route}/route.ts`, "utf8"));
    assert.match(src, /undatedPeriod: formUndatedPeriod\(form\)/, `the ${route} route reads the picked month — or a summary that previews would refuse at import`);
  }
  const multi = stripComments(readFileSync("src/lib/sales/normalizer/multi-file.ts", "utf8"));
  assert.match(multi, /"several_undated_sheets"/, "two date-less sheets are never filed under one picked month — each goes in on its own");
  assert.match(multi, /Month of a sheet with no date/, "a sheet refused for its date alone is told where to pick its month");
  const screen = stripComments(readFileSync("src/components/sales/normalizer-workspace.tsx", "utf8"));
  assert.match(screen, /f\.set\("undatedPeriod", undatedPeriod\)/, "the screen sends the picked month with every request");
  assert.match(screen, /type="month"/, "the screen offers a month picker");
  assert.match(screen, /Month of a sheet with no date/, "the picker carries the label the refusal points to");
}

export function runNormalizerEgdOldLayoutsTests() {
  theJanuaryLayoutReadsAsEgd();
  theSummaryNeedsAPickedMonth();
  aDatedRowKeepsItsOwnMonth();
  theFormTakesOnlyARealMonth();
  everyRouteAndTheScreenCarryTheMonth();
}
