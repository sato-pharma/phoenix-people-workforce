import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { buildPreviewBreakdowns, freeGoodsQtyTotal } from "@/lib/sales/normalizer/breakdowns";
import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";
import { buildReconciliation } from "@/lib/sales/sales-upload";
import { skippedRowsAdvisories } from "@/lib/sales/source-of-sales-upload";

// FREE GOODS ARE EXCLUDED FROM SALES, AND NEVER INVISIBLE.
//
// A row the distributor flags as free goods (EPDA's is_bonus) is skipped whole: no distributor's
// bonus is ever counted as sales (owner, 2026-09-07, restated 2026-09-18). That part is right and
// this test does not change it. What was wrong is that the excluded UNITS left no trace anywhere:
// the engine recorded qty 0 on the skipped row, so the Validate screen's Bonus column read 0, the
// receipt said nothing, and the single advisory told the reader their products were "mapped as
// ignore" — a mapping that was perfectly correct.
//
// The real case, 9 Oct 2026: the September EPDA-BULK book (ساتو قطاع الجملة.xlsx, 73 data rows) carries
// 6,736 Ivyronc packs — 5,214 paid on 17 rows and 1,522 free goods on 14 is_bonus rows — and the
// screen showed 5,214 with nothing to account for the other 1,522. Satoslim on the same sheet is
// 1,097 paid + 153 free goods = 1,250. Both figures below are that file's, read from it.
//
// The rule this pins: Qty + Bonus on the Validate screen equals the quantity in the distributor's
// file, for every product, always.

const IVYRONC = "IV001";
const IVYRONC_NAME = "Ivyronc";
const IVYRONC_SHEET_NAME = "ايفيرونك شراب 100 مل -45ج";
const SATOSLIM = "SS002";
const SATOSLIM_NAME = "Satoslim";
const SATOSLIM_SHEET_NAME = "ساتو سليم 30 كبسولة -330ج";
const BRICK_ID = "CA101";
const IVYRONC_PRICE = 45;
const SATOSLIM_PRICE = 330;

// The sheet's own split, product by product: [paid, free goods].
const IVYRONC_PAID = 5214;
const IVYRONC_FREE = 1522;
const SATOSLIM_PAID = 1097;
const SATOSLIM_FREE = 153;

function crosswalks(): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK_ID, {
      areaCode: "CA1", areaName: "Cairo 1", blockCode: "CA1-1", brickId: BRICK_ID, brickName: "Marg",
      regionCode: "CA", regionName: "Cairo",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map([
      [`${normalizeCodeKey("EP-BK")} ${normalizeCodeKey("5001")}`, BRICK_ID],
    ]),
    productAliasByKey: new Map([
      [`${normalizeCodeKey("EP-BK")} ${normalizeAliasKey(IVYRONC_SHEET_NAME)}`, IVYRONC],
      [`${normalizeCodeKey("EP-BK")} ${normalizeAliasKey(SATOSLIM_SHEET_NAME)}`, SATOSLIM],
    ]),
    productByCanonicalCode: new Map(),
    productByCode: new Map([
      [IVYRONC, { productCode: IVYRONC, productName: IVYRONC_NAME, factoryPrice: IVYRONC_PRICE, line: "Pedia" }],
      [SATOSLIM, { productCode: SATOSLIM, productName: SATOSLIM_NAME, factoryPrice: SATOSLIM_PRICE, line: "Head Office" }],
    ]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
  };
}

function profile(): DistributorProfile {
  const p = rawProfileForDistributor("EP-BK");
  assert.ok(p, "the EP-BK profile must exist — this test reads the real one");
  return p;
}

// The real sheet's columns, in its own order.
const HEADERS = ["inv_date", "cust_code", "cust_name", "cust_address", "class_code", "class_name", "is_bonus", "qnt"];

function row(sheetName: string, isBonus: 0 | 1, qnt: number) {
  return ["9/30/2026", "5001", "Nour Pharmacy", "Marg", "18812737", sheetName, isBonus, qnt];
}

function sheetOf(rows: unknown[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("Sheet1");
  ws.addRow(HEADERS);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

function normalizeSeptemberBulkSheet() {
  return normalizeRows(
    sheetOf([
      row(IVYRONC_SHEET_NAME, 0, 3000),
      row(IVYRONC_SHEET_NAME, 0, IVYRONC_PAID - 3000),
      row(IVYRONC_SHEET_NAME, 1, 1000),
      row(IVYRONC_SHEET_NAME, 1, IVYRONC_FREE - 1000),
      row(SATOSLIM_SHEET_NAME, 0, SATOSLIM_PAID),
      row(SATOSLIM_SHEET_NAME, 1, SATOSLIM_FREE),
    ]),
    profile(),
    crosswalks(),
  );
}

function theSheetsOwnTotalReconcilesOnTheValidateScreen() {
  const result = normalizeSeptemberBulkSheet();

  // Unchanged and deliberate: a free-goods row is never a sale.
  assert.equal(
    result.coded.reduce((sum, r) => sum + (r.productCode === IVYRONC ? r.qty : 0), 0),
    IVYRONC_PAID,
    "paid Ivyronc units are the only Ivyronc SALES — a free-goods row must never be imported as one",
  );

  const breakdowns = buildPreviewBreakdowns(result.coded, [], result.ignoredRows);
  const ivyronc = breakdowns.byProduct.find((r) => r.code === IVYRONC);
  assert.ok(ivyronc, "Ivyronc must appear in the By product table");

  // HEADLINE: the Validate screen accounts for every unit the file carried.
  assert.equal(
    ivyronc.totalQty + ivyronc.totalBonusQty,
    IVYRONC_PAID + IVYRONC_FREE,
    `the sheet carries ${IVYRONC_PAID + IVYRONC_FREE} Ivyronc units; the Validate screen must account for all of them as `
    + `${IVYRONC_PAID} Qty + ${IVYRONC_FREE} Bonus. Showing ${IVYRONC_PAID} with the free goods recorded as 0 is how 1,522 packs went missing on 9 Oct 2026.`,
  );
  assert.equal(ivyronc.totalQty, IVYRONC_PAID, "Qty stays the PAID units — free goods are never added to sales");
  assert.equal(ivyronc.totalBonusQty, IVYRONC_FREE, "the Bonus column carries the excluded free-goods units");
  assert.equal(ivyronc.totalValue, IVYRONC_PAID * IVYRONC_PRICE, "value is paid units x factory price — free goods are worth nothing here");

  const satoslim = breakdowns.byProduct.find((r) => r.code === SATOSLIM);
  assert.ok(satoslim, "Satoslim must appear in the By product table");
  assert.equal(satoslim.totalBonusQty, SATOSLIM_FREE, "every product's free goods are reported, not just the biggest one");

  // By line carries them too, because the product's line is known. Region and brick never can: a
  // flagged row is dropped before geography is resolved.
  const pedia = breakdowns.byLine.find((r) => r.code === "Pedia");
  assert.equal(pedia?.totalBonusQty, IVYRONC_FREE, "By line reports the same excluded units under the product's line");
  assert.equal(
    breakdowns.byRegion.reduce((sum, r) => sum + r.totalBonusQty, 0),
    0,
    "By region must claim no free goods — a flagged row has no geography at all",
  );
}

function aProductThatSoldOnlyFreeGoodsStillAppears() {
  const result = normalizeRows(
    sheetOf([
      row(IVYRONC_SHEET_NAME, 1, 400),
      row(SATOSLIM_SHEET_NAME, 0, 10),
    ]),
    profile(),
    crosswalks(),
  );
  const breakdowns = buildPreviewBreakdowns(result.coded, [], result.ignoredRows);
  const ivyronc = breakdowns.byProduct.find((r) => r.code === IVYRONC);
  assert.ok(ivyronc, "a product whose every row was free goods must still have a row — absent from the table is exactly how the units went missing");
  assert.equal(ivyronc.totalQty, 0, "it sold nothing");
  assert.equal(ivyronc.totalBonusQty, 400, "and its 400 free-goods units are stated");
  assert.equal(ivyronc.totalValue, 0, "free goods carry no value");
}

function aConfidentialProductsFreeGoodsStayHidden() {
  const result = normalizeSeptemberBulkSheet();
  const breakdowns = buildPreviewBreakdowns(result.coded, [SATOSLIM], result.ignoredRows);
  assert.equal(
    breakdowns.byProduct.find((r) => r.code === SATOSLIM),
    undefined,
    "a restricted product must not reappear through its free goods — the exclusion list still wins",
  );
  assert.equal(
    breakdowns.byProduct.find((r) => r.code === IVYRONC)?.totalBonusQty,
    IVYRONC_FREE,
    "and the products the viewer may see are unaffected",
  );
}

function theReceiptStatesTheExcludedUnits() {
  const result = normalizeSeptemberBulkSheet();
  const receipt = buildReconciliation(result);
  assert.equal(receipt.freeGoodsQty, IVYRONC_FREE + SATOSLIM_FREE, "the receipt states how many units the free-goods rule took out");
  assert.equal(receipt.rowsFreeGoods, 3, "and on how many rows");
  assert.equal(receipt.totalQty, IVYRONC_PAID + SATOSLIM_PAID, "while Total qty stays the paid units — the bonus is never counted as sales");
  assert.equal(freeGoodsQtyTotal(result.ignoredRows), IVYRONC_FREE + SATOSLIM_FREE, "the same total, from the shared helper");

  const hidden = buildReconciliation(result, [SATOSLIM]);
  assert.equal(hidden.freeGoodsQty, IVYRONC_FREE, "a restricted product's free goods are hidden from the receipt as its sales already were");
}

function theAdvisorySaysFreeGoodsAndNeverBlamesTheMapping() {
  const result = normalizeSeptemberBulkSheet();
  const advisories = skippedRowsAdvisories(result);
  assert.equal(advisories.length, 1, "this sheet has free-goods rows and no ignore-mapped ones, so it gets exactly one advisory");

  const [advisory] = advisories;
  assert.match(advisory, /free goods/i, "the advisory must say what these rows are");
  assert.match(
    advisory,
    new RegExp(String(IVYRONC_FREE)),
    `the advisory must state the ${IVYRONC_FREE} excluded units — it used to report "(0 units)" because the engine recorded 0`,
  );
  assert.match(advisory, new RegExp(IVYRONC_NAME), "and name the product, so the reader knows which of their totals will not match");
  assert.doesNotMatch(
    advisory,
    /mapped as "ignore"|Mapping tab/,
    'free-goods rows must never be reported as products "mapped as ignore" — that sent the reader to fix a mapping that was correct',
  );
}

export function runFreeGoodsUnitsStayVisibleTests() {
  theSheetsOwnTotalReconcilesOnTheValidateScreen();
  aProductThatSoldOnlyFreeGoodsStillAppears();
  aConfidentialProductsFreeGoodsStayHidden();
  theReceiptStatesTheExcludedUnits();
  theAdvisorySaysFreeGoodsAndNeverBlamesTheMapping();
}
