import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import type { WeeklyBranchRegionIndex } from "../src/lib/sales/weekly/branch-region-map.ts";
import { normalizeCode, normalizeKey } from "../src/lib/sales/weekly/mapping-normalize.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyProductAliasIndex } from "../src/lib/sales/weekly/product-aliases.ts";

// Every weekly import now compares what it READ against what the FILE ITSELF states, and says so on
// the screen either way — including when the format states nothing, which is the case the 2026-08 POS
// disaster turned on. That batch stored 172,046 units against a true 1,048 and validated cleanly,
// because nothing compared the parsed result to anything and nothing said that nothing had.
//
// These tests pin the three things that make the facility worth having:
//
//   1. A declared total located INDEPENDENTLY of the range the adapter scanned catches a short
//      column range, which a total summed across that same range cannot — both sides shrink together
//      and it passes. This is the hole the POS "Total Units" row alone still had.
//   2. A check whose invariant is not yet proven against a real file REPORTS and never blocks, so
//      switching the facility on across every distributor at once cannot stop a legitimate upload.
//   3. A format that states no total says so explicitly, rather than presenting an empty check list
//      that is indistinguishable from a check that passed.

const PRICES: Record<string, number> = { SA001: 10 };

function references(distributorCode: string, distributorName: string): SalesReferenceData {
  return {
    distributors: [{ code: distributorCode, name: distributorName }],
    products: [
      {
        productCode: "SA001",
        productName: "SAGINKGO 30 CAP",
        factoryPrice: PRICES.SA001,
        family: "",
        familyCode: "",
        line: "CNS",
        source: "Sato",
      },
    ],
    regions: [{ areaCode: "CA1", areaName: "Cairo", regionCode: "CA", regionName: "Cairo" }],
  };
}

function aliasIndex(distributorCode: string, codeMap: Record<string, string>): WeeklyProductAliasIndex {
  const byCode = new Map<string, string>();
  for (const [alias, product] of Object.entries(codeMap)) byCode.set(normalizeCode(alias), product);
  const index: WeeklyProductAliasIndex = new Map();
  index.set(distributorCode, { byCode, byName: new Map() });
  return index;
}

function branchIndex(keys: string[]): WeeklyBranchRegionIndex {
  const byBranch = new Map<string, { regionCode: string; regionName: string; areaCode: string | null; excluded: boolean }>();
  const entry = { regionCode: "CA", regionName: "Cairo", areaCode: null, excluded: false };
  for (const key of keys) {
    byBranch.set(`sales|${normalizeKey(key)}`, entry);
    byBranch.set(`stock|${normalizeKey(key)}`, entry);
  }
  return { byBranch, byColumnIndex: new Map(), bySoftName: new Map() };
}

async function bufferOf(build: (wb: ExcelJS.Workbook) => void): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return wb.xlsx.writeBuffer();
}

async function parseFor(input: {
  distributorCode: string;
  distributorName: string;
  buffer?: ExcelJS.Buffer;
  salesBuffer?: ExcelJS.Buffer;
  stockBuffer?: ExcelJS.Buffer;
  aliases: Record<string, string>;
  branches: string[];
}) {
  return parseWeeklyWorkbookBuffer({
    buffer: input.buffer as ArrayBuffer | undefined,
    salesBuffer: input.salesBuffer as ArrayBuffer | undefined,
    stockBuffer: input.stockBuffer as ArrayBuffer | undefined,
    distributorCode: input.distributorCode,
    distributorName: input.distributorName,
    fileName: `${input.distributorCode}.xlsx`,
    references: references(input.distributorCode, input.distributorName),
    aliasIndex: aliasIndex(input.distributorCode, input.aliases),
    branchMapIndex: branchIndex(input.branches),
    periodDate: "2026-08-01",
  });
}

// ── POS: a channel range that stops short ────────────────────────────────────────────────────────
// Header: col4 = channel A, col5 = BLANK, col6 = channel B, col7 = "Total". The channel scan breaks
// at the blank header, so the adapter reads channel A only and never sees channel B. The "Total
// Units" row summed across the SAME range agrees with it perfectly — which is exactly why that check
// on its own cannot see this. The row's own "Total" cell states the real figure and does.
const POS_A = "Retail Al-Falaky";
const POS_B = "October K.Acc";

async function posWorkbookWithGap(input: { statedGrandTotal: number | null }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Purchasing Sales Data");
    const header: (string | null)[] = [];
    header[3] = "Product Code";
    header[4] = POS_A;
    header[5] = null; // a depot added mid-row with no header — the scan stops here
    header[6] = POS_B;
    header[7] = "Total";
    sheet.addRow(header);

    const line: (string | number | null)[] = [];
    line[2] = "SAGINKGO 30 CAP";
    line[3] = "POS-SAG";
    line[4] = 8;
    line[6] = 4;
    line[7] = 12;
    sheet.addRow(line);

    const totals: (string | number | null)[] = [];
    totals[2] = "Total Units";
    totals[3] = "Total Units";
    totals[4] = 8;
    totals[6] = 4;
    if (input.statedGrandTotal !== null) totals[7] = input.statedGrandTotal;
    sheet.addRow(totals);
  });
}

// ── PS (Overseas): the stock matrix states its own "Total Qty." per product ──────────────────────
async function psSalesWorkbook(): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Data");
    const header = new Array(121).fill("");
    header[2] = "Mat. Code";
    header[3] = "Mat. Desc.";
    header[4] = "Retail Cairo";
    header[118] = "Total Qty.";
    sheet.addRow(header);
    const row = new Array(121).fill("");
    row[2] = "PS-SAG";
    row[3] = "SAGINKGO";
    row[4] = 5;
    row[118] = 5;
    sheet.addRow(row);
  });
}

async function psStockWorkbook(input: { statedTotalQty: number }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Data");
    const header = new Array(85).fill("");
    header[2] = "Mat. Code";
    header[3] = "Mat. Desc.";
    header[4] = "Total val.";
    header[5] = "Total Qty.";
    header[6] = "Cairo Warehouse";
    sheet.addRow(header);
    const row = new Array(85).fill("");
    row[2] = "PS-SAG";
    row[3] = "SAGINKGO";
    row[4] = 0;
    row[5] = input.statedTotalQty;
    row[6] = 40; // the only location column → the import reads 40
    sheet.addRow(row);
  });
}

// ── RM (RAMCO): the stock sheet states a grand total per product in الإجمالى ─────────────────────
async function rmWorkbook(input: { statedGrandTotal: number }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sales = wb.addWorksheet("SALES");
    sales.addRow(["RAMCO Weekly Sales"]);
    const header = new Array(24).fill("");
    header[0] = "كود الفرع";
    header[1] = "فرع";
    header[8] = "ك.صنف";
    header[9] = "صنف";
    header[10] = "بيع";
    header[12] = "مرتجع بيع";
    header[14] = "صافى كمية";
    sales.addRow(header);
    const row = new Array(24).fill("");
    row[0] = "11";
    row[1] = "Cairo Branch";
    row[8] = "RM-SAG";
    row[9] = "SAGINKGO";
    row[10] = 12;
    row[12] = 0;
    row[14] = 12;
    sales.addRow(row);

    const stock = wb.addWorksheet("STOCK");
    stock.addRow(["RAMCO Stock"]);
    const stockHeader = new Array(35).fill("");
    stockHeader[3] = "كود";
    stockHeader[4] = "إسم الصنف";
    stockHeader[5] = "إجمالى Cairo Branch";
    stockHeader[34] = "الإجمالى";
    stock.addRow(stockHeader);
    const stockRow = new Array(35).fill("");
    stockRow[3] = "RM-SAG";
    stockRow[4] = "SAGINKGO";
    stockRow[5] = 40; // the only branch column → the import reads 40
    stockRow[34] = input.statedGrandTotal;
    stock.addRow(stockRow);
  });
}

// ── the formats that state nothing ──────────────────────────────────────────────────────────────
async function isWorkbook(): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Sheet2");
    const header = new Array(10).fill("");
    header[2] = "Item Code";
    header[3] = "Item name";
    header[4] = "Branch Code";
    header[5] = "Branch Name";
    header[6] = "Stock";
    header[8] = "Sales Quantity";
    sheet.addRow(header);
    const row = new Array(10).fill("");
    row[2] = "IS-SAG";
    row[3] = "SAGINKGO";
    row[4] = "B01";
    row[5] = "Cairo Branch";
    row[6] = 25;
    row[8] = 8;
    sheet.addRow(row);
  });
}

async function directWorkbook(): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Direct Orders");
    sheet.addRow(["Pharmacy Name", "Distrub ID", "Region ID", "Product ID", "Product", "Qty", "Invoice Date", "Value"]);
    sheet.addRow(["Cairo Pharmacy A", "Direct", "CA", "SA001", "SAGINKGO", 10, new Date(Date.UTC(2026, 7, 1)), 500]);
  });
}

export async function runWeeklyFileTotalsSelfCheckTests() {
  // ════════════ 1. the grand-total CELL catches a short channel range ════════════
  // The headline assertion: this file is BLOCKED. The channel sum agrees (8 == 8) and would have
  // waved it through; only the file's own "Total" cell, found from the header row rather than from
  // where the data scan stopped, sees that channel B was never read.
  {
    const parsed = await parseFor({
      distributorCode: "POS",
      distributorName: "POS Purchasing Sales",
      buffer: await posWorkbookWithGap({ statedGrandTotal: 12 }),
      aliases: { "POS-SAG": "SA001" },
      branches: [POS_A, POS_B],
    });
    assert.equal(parsed.ok, true, "POS file parses");
    if (parsed.ok) {
      assert.equal(
        parsed.result.status,
        "blocked",
        "a channel range that stopped short is BLOCKED by the file's own Total cell",
      );
      const checks = parsed.result.fileTotals?.checks ?? [];
      const summed = checks.find((check) => check.label.includes("summed across"));
      const cell = checks.find((check) => check.label.includes('"Total" cell'));
      assert.ok(summed, "the summed-across-channels check ran");
      assert.equal(summed?.status, "ok", "the summed check AGREES — it cannot see a short range");
      assert.ok(cell, "the grand-total cell check ran");
      assert.equal(cell?.status, "mismatch", "the grand-total cell check is the one that catches it");
      assert.equal(cell?.declared, 12, "the file states 12 units");
      assert.equal(cell?.parsed, 8, "the import read 8 — channel B was never scanned");
      assert.ok(
        parsed.result.blockingReasons.some((reason) => reason.includes('"Total" cell')),
        "the blocking reason names the cell the figure came from",
      );
    }
  }

  // ════════════ 2. the same file, with the file's own total agreeing, imports ════════════
  // Proves the check discriminates rather than blocking everything with a gap in the header.
  {
    const parsed = await parseFor({
      distributorCode: "POS",
      distributorName: "POS Purchasing Sales",
      buffer: await posWorkbookWithGap({ statedGrandTotal: 8 }),
      aliases: { "POS-SAG": "SA001" },
      branches: [POS_A, POS_B],
    });
    assert.equal(parsed.ok, true, "POS file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "a total that agrees does not block");
      assert.equal(
        (parsed.result.fileTotals?.checks ?? []).every((check) => check.status === "ok"),
        true,
        "every check agrees",
      );
    }
  }

  // ════════════ 3. a blank total cell is NOT a declared zero ════════════
  // Reading a blank as 0 would block every file that leaves the cell empty.
  {
    const parsed = await parseFor({
      distributorCode: "POS",
      distributorName: "POS Purchasing Sales",
      buffer: await posWorkbookWithGap({ statedGrandTotal: null }),
      aliases: { "POS-SAG": "SA001" },
      branches: [POS_A, POS_B],
    });
    assert.equal(parsed.ok, true, "POS file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "a blank Total cell states nothing and never blocks");
      assert.equal(
        (parsed.result.fileTotals?.checks ?? []).some((check) => check.label.includes('"Total" cell')),
        false,
        "no check is created for a total the file does not state",
      );
    }
  }

  // ════════════ 4. PS stock — an unproven check REPORTS, and never blocks ════════════
  // The file states 999 against the 40 the import reads. That is a real disagreement and it is shown
  // loudly, but no real Overseas stock file has been measured against this column, so it must not
  // stop the upload.
  {
    const parsed = await parseFor({
      distributorCode: "PS",
      distributorName: "Overseas",
      salesBuffer: await psSalesWorkbook(),
      stockBuffer: await psStockWorkbook({ statedTotalQty: 999 }),
      aliases: { "PS-SAG": "SA001" },
      branches: ["Retail Cairo", "Cairo Warehouse"],
    });
    assert.equal(parsed.ok, true, "PS files parse");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "a REPORT-severity mismatch never blocks the import");
      const check = (parsed.result.fileTotals?.checks ?? []).find((entry) => entry.label.includes("Total Qty."));
      assert.ok(check, "the PS stock Total Qty check ran");
      assert.equal(check?.severity, "report", "it reports rather than blocks");
      assert.equal(check?.status, "mismatch", "999 stated against 40 read is a mismatch");
      assert.equal(
        (parsed.result.advisories ?? []).some((advisory) => advisory.includes("Total Qty.")),
        true,
        "the operator is shown the disagreement before pressing Import",
      );
    }
  }

  // ════════════ 5. PS stock — agreeing totals raise nothing ════════════
  {
    const parsed = await parseFor({
      distributorCode: "PS",
      distributorName: "Overseas",
      salesBuffer: await psSalesWorkbook(),
      stockBuffer: await psStockWorkbook({ statedTotalQty: 40 }),
      aliases: { "PS-SAG": "SA001" },
      branches: ["Retail Cairo", "Cairo Warehouse"],
    });
    assert.equal(parsed.ok, true, "PS files parse");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "PS imports");
      assert.equal((parsed.result.advisories ?? []).length, 0, "nothing is raised when the file agrees");
    }
  }

  // ════════════ 6. RM stock — the الإجمالى grand total, until now read by nobody ════════════
  {
    const mismatch = await parseFor({
      distributorCode: "RM",
      distributorName: "RAMCO",
      buffer: await rmWorkbook({ statedGrandTotal: 250 }),
      aliases: { "RM-SAG": "SA001" },
      branches: ["11", "Cairo Branch"],
    });
    assert.equal(mismatch.ok, true, "RM file parses");
    if (mismatch.ok) {
      assert.equal(mismatch.result.status, "validated", "a REPORT-severity mismatch never blocks RAMCO either");
      const check = (mismatch.result.fileTotals?.checks ?? []).find((entry) => entry.label.includes("الإجمالى"));
      assert.ok(check, "the RAMCO grand-total check ran");
      assert.equal(check?.declared, 250, "the file states 250");
      assert.equal(check?.parsed, 40, "the import read 40");
      assert.equal(check?.status, "mismatch", "and says so");
    }

    const agrees = await parseFor({
      distributorCode: "RM",
      distributorName: "RAMCO",
      buffer: await rmWorkbook({ statedGrandTotal: 40 }),
      aliases: { "RM-SAG": "SA001" },
      branches: ["11", "Cairo Branch"],
    });
    assert.equal(agrees.ok, true, "RM file parses");
    if (agrees.ok) {
      assert.equal((agrees.result.advisories ?? []).length, 0, "an agreeing grand total raises nothing");
    }
  }

  // ════════════ 7. a format that states NOTHING says so, in words ════════════
  // The whole point of the facility: "nothing checked this" must be visible, not an empty list that
  // reads on screen exactly like a check that passed.
  {
    const parsed = await parseFor({
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      buffer: await isWorkbook(),
      aliases: { "IS-SAG": "SA001" },
      branches: ["B01"],
    });
    assert.equal(parsed.ok, true, "Ibn Sina file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "a format with no declared total still imports");
      assert.equal((parsed.result.fileTotals?.checks ?? []).length, 0, "there is nothing to check");
      assert.ok(parsed.result.fileTotals?.absence, "and the absence is recorded explicitly");
      assert.match(
        parsed.result.fileTotals?.absence?.reason ?? "",
        /no totals row/i,
        "the reason says what the file is missing, in words the operator can read",
      );
    }
  }

  {
    const parsed = await parseFor({
      distributorCode: "Direct",
      distributorName: "Direct (Company)",
      buffer: await directWorkbook(),
      aliases: {},
      branches: [],
    });
    assert.equal(parsed.ok, true, "Direct file parses");
    if (parsed.ok) {
      assert.ok(parsed.result.fileTotals?.absence, "Direct records the absence too");
      assert.match(
        parsed.result.fileTotals?.absence?.reason ?? "",
        /by hand/i,
        "and explains that a hand-filled sheet carries no totals row",
      );
    }
  }
}
