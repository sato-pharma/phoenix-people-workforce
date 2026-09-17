import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import type { WeeklyBranchRegionEntry, WeeklyBranchRegionIndex } from "../src/lib/sales/weekly/branch-region-map.ts";
import { normalizeCode, normalizeKey } from "../src/lib/sales/weekly/mapping-normalize.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyProductAliasIndex } from "../src/lib/sales/weekly/product-aliases.ts";

// An EGD workbook that yields NO stock must block, never validate at zero stock.
//
// The 2026-08 month-end EGD file ("EGD SATO END SALES &STOCK 31-8-2026", stored as the September
// cycle's week 4) was read with only "Branches Sales + Branch Sales Return" — no "Current Stock
// Branches" sheet — and the EGD adapter simply skipped the stock side. Every one of its 122 rows was
// stored at stock 0 and the batch validated cleanly. Once the weekly engine began keeping each
// distributor's stock from its LATEST week (#3906), that one batch turned EGD's stock from 12,747 to 0
// in the all-months view. The stored rows cannot tell a missing sheet from real zeros, so the only
// place to catch it is the parse.
//
// Pinned here: a missing stock sheet, a renamed one (with "Current Stock Pharmacy" present, which must
// never stand in for it), an empty one and a moved stock column all BLOCK; a stock sheet whose
// quantities are genuinely 0 still VALIDATES.

type StockShape = "present" | "missing" | "renamed" | "empty" | "column-moved" | "all-zero";

async function egdWorkbook(stock: StockShape): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();

  const sales = wb.addWorksheet("Branches Sales");
  const salesHeader = new Array(30).fill("");
  salesHeader[3] = "INVOICE_DATE"; // col4
  salesHeader[4] = "ITEM_CODE"; // col5
  salesHeader[5] = "ITEM_NAME"; // col6
  salesHeader[12] = "QTY_INVOICE"; // col13
  salesHeader[28] = "BRANCH_CODE"; // col29
  salesHeader[29] = "BRANCH_NAME"; // col30
  sales.addRow(salesHeader);
  const salesRow = new Array(30).fill("");
  salesRow[3] = new Date(Date.UTC(2026, 7, 31));
  salesRow[4] = "EG-SAG";
  salesRow[5] = "SAGINKGO";
  salesRow[12] = 16;
  salesRow[28] = "B01";
  salesRow[29] = "Cairo Branch";
  sales.addRow(salesRow);

  const returns = wb.addWorksheet("Branch Sales Return");
  const returnsHeader = new Array(30).fill("");
  returnsHeader[4] = "ITEM_CODE";
  returnsHeader[13] = "RETURN_QTY"; // col14
  returnsHeader[28] = "BRANCH_CODE";
  returns.addRow(returnsHeader);

  if (stock !== "missing") {
    const sheet = wb.addWorksheet(stock === "renamed" ? "Stock Branches" : "Current Stock Branches");
    const header = new Array(14).fill("");
    header[0] = "ITEM_CODE"; // col1
    header[1] = "ITEM_NAME_ENG"; // col2
    header[2] = stock === "column-moved" ? "ITEM_NAME_AR" : "ITEM_STOCK"; // col3
    header[12] = "COMPANY_ENTITY_CODE"; // col13
    header[13] = "COMPANY_ENTITY_NAME"; // col14
    if (stock === "column-moved") header[3] = "ITEM_STOCK"; // col4 — one column right of the contract
    sheet.addRow(header);
    if (stock !== "empty") {
      for (const qty of [30, 20]) {
        const row = new Array(14).fill("");
        row[0] = "EG-SAG";
        row[1] = "SAGINKGO";
        if (stock === "column-moved") {
          row[2] = "ساجينكو";
          row[3] = qty;
        } else {
          row[2] = stock === "all-zero" ? 0 : qty;
        }
        row[12] = "B01";
        row[13] = "Cairo Branch";
        sheet.addRow(row);
      }
    }
  }

  // Present in real EGD exports and deliberately ignored — it must never count as branch stock.
  const pharmacy = wb.addWorksheet("Current Stock Pharmacy");
  pharmacy.addRow(["ITEM_CODE", "x", "ITEM_STOCK"]);
  pharmacy.addRow(["EG-SAG", "x", 9999]);

  return wb.xlsx.writeBuffer();
}

function references(): SalesReferenceData {
  return {
    distributors: [{ code: "EG", name: "EGD" }],
    products: [
      {
        productCode: "SA001",
        productName: "SAGINKGO 30 CAP",
        factoryPrice: 10,
        family: "",
        familyCode: "",
        line: "CNS",
        source: "Sato",
      },
    ],
    regions: [{ areaCode: "CA1", areaName: "Cairo", regionCode: "CA", regionName: "Cairo" }],
  };
}

function aliasIndex(): WeeklyProductAliasIndex {
  const index: WeeklyProductAliasIndex = new Map();
  index.set("EG", { byCode: new Map([[normalizeCode("EG-SAG"), "SA001"]]), byName: new Map() });
  return index;
}

function branchIndex(): WeeklyBranchRegionIndex {
  const entry: WeeklyBranchRegionEntry = { regionCode: "CA", regionName: "Cairo", areaCode: null, excluded: false };
  return {
    byBranch: new Map<string, WeeklyBranchRegionEntry>([
      [`sales|${normalizeKey("B01")}`, entry],
      [`stock|${normalizeKey("B01")}`, entry],
    ]),
    byColumnIndex: new Map(),
    bySoftName: new Map(),
  };
}

async function parse(stock: StockShape) {
  const parsed = await parseWeeklyWorkbookBuffer({
    buffer: await egdWorkbook(stock),
    distributorCode: "EG",
    distributorName: "EGD",
    fileName: `EGD ${stock}.xlsx`,
    references: references(),
    aliasIndex: aliasIndex(),
    branchMapIndex: branchIndex(),
  });
  assert.equal(parsed.ok, true, `EGD (${stock} stock) parses to a result`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.result;
}

export async function runWeeklyEgdMissingStockTests() {
  // Control: the normal three-sheet workbook validates with its stock, and the pharmacy sheet stays out.
  {
    const result = await parse("present");
    assert.equal(result.status, "validated", "a full EGD workbook validates");
    assert.deepEqual(result.blockingReasons, [], "a full EGD workbook has no blocking reasons");
    assert.equal(result.totals.stockQty, 50, "stock is read from Current Stock Branches only (30 + 20)");
  }

  // The 31-8-2026 shape: two sales sheets, no stock sheet. This is the headline assertion.
  {
    const result = await parse("missing");
    assert.equal(result.status, "blocked", "an EGD workbook with no Current Stock Branches sheet BLOCKS instead of storing zero stock");
    const reason = result.blockingReasons.find((text) => text.includes('no "Current Stock Branches" sheet'));
    assert.ok(reason, "the block names the missing sheet");
    assert.ok(
      reason.includes("Branches Sales · Branch Sales Return · Current Stock Pharmacy"),
      "the block lists the sheets the workbook does have, so the operator can see what arrived",
    );
    assert.ok(!result.blockingReasons.some((text) => text.startsWith("Validation failed:")), "the rows themselves are clean — only the stock is missing");
  }

  // A renamed stock sheet is the same fault. "Current Stock Pharmacy" must not be taken in its place.
  {
    const result = await parse("renamed");
    assert.equal(result.status, "blocked", "a renamed stock sheet blocks");
    assert.ok(result.blockingReasons.some((text) => text.includes('no "Current Stock Branches" sheet')), "a renamed stock sheet reads as missing");
    assert.equal(result.totals.stockQty, 0, "the pharmacy sheet's 9999 never stands in for branch stock");
  }

  // The sheet is there but holds no rows.
  {
    const result = await parse("empty");
    assert.equal(result.status, "blocked", "an empty stock sheet blocks");
    assert.ok(result.blockingReasons.some((text) => text.includes("has no stock rows")), "the block says the stock sheet is empty");
  }

  // The sheet has rows, but column 3 no longer holds a quantity — the column moved.
  {
    const result = await parse("column-moved");
    assert.equal(result.status, "blocked", "a moved stock column blocks");
    const reason = result.blockingReasons.find((text) => text.includes("no stock quantity in column 3"));
    assert.ok(reason, "the block names the column the contract reads");
    assert.ok(reason.includes("header: ITEM_NAME_AR"), "the block quotes the header actually found there");
  }

  // Genuine zero stock is data, not a fault — it must still validate.
  {
    const result = await parse("all-zero");
    assert.equal(result.status, "validated", "a stock sheet whose quantities are really 0 still validates");
    assert.equal(result.totals.stockQty, 0, "genuine zero stock is stored as 0");
  }
}
