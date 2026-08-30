import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import type { WeeklyBranchRegionIndex } from "../src/lib/sales/weekly/branch-region-map.ts";
import { normalizeCode, normalizeKey } from "../src/lib/sales/weekly/mapping-normalize.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyProductAliasIndex } from "../src/lib/sales/weekly/product-aliases.ts";

// POS ships every product as a PAIR of consecutive rows — units, then the matching EGP values. The
// adapter used to tell them apart by "the value row has no product name". POS stopped leaving those
// cells blank: from the 2026-08 file the value row repeats the product name AND code, so every value
// row read as a quantity row. Rows aggregate by (product, branch), so each pair MERGED into one cell
// holding units + EGP.
//
// Live damage, production batch 2026-08 W3 (uploaded 2026-08-18 09:53 Cairo, status "validated"):
// 172,046 "units" and EGP 16,370,596 stored, against a true 1,048 units. Every stored cell satisfied
// sales_qty = true_units + EGP_value exactly — e.g. ك.عملاء شرق القاهرة2 / Ivyronc held 1,488.25,
// which is 37 units + EGP 1,451.25. Nothing complained, because nothing compared the parsed result to
// anything the file itself asserted.
//
// These tests pin BOTH halves of the fix: rows are classified by the file's own pairing, and the
// parsed unit total is reconciled against the sheet's own "Total Units" row.

const PRICES: Record<string, number> = { SA001: 10, RO001: 20 };

function references(): SalesReferenceData {
  return {
    distributors: [{ code: "POS", name: "POS Purchasing Sales" }],
    products: Object.keys(PRICES).map((productCode) => ({
      productCode,
      productName: productCode === "SA001" ? "SAGINKGO 30 CAP" : "ROYAFLOXACIN 500 TAB",
      factoryPrice: PRICES[productCode],
      family: "",
      familyCode: "",
      line: productCode === "SA001" ? "CNS" : "Anti infective",
      source: "Sato",
    })),
    regions: [{ areaCode: "CA1", areaName: "Cairo", regionCode: "CA", regionName: "Cairo" }],
  };
}

function aliasIndex(codeMap: Record<string, string>): WeeklyProductAliasIndex {
  const byCode = new Map<string, string>();
  for (const [alias, product] of Object.entries(codeMap)) byCode.set(normalizeCode(alias), product);
  const index: WeeklyProductAliasIndex = new Map();
  index.set("POS", { byCode, byName: new Map() });
  return index;
}

function branchIndex(keys: string[]): WeeklyBranchRegionIndex {
  const byBranch = new Map<string, { regionCode: string; regionName: string; areaCode: string | null; excluded: boolean }>();
  for (const key of keys) {
    byBranch.set(`sales|${normalizeKey(key)}`, { regionCode: "CA", regionName: "Cairo", areaCode: null, excluded: false });
  }
  return { byBranch, byColumnIndex: new Map(), bySoftName: new Map() };
}

const CHANNEL_A = "Retail Al-Falaky";
const CHANNEL_B = "October K.Acc";

type PosRow = { name: string; code: string; a: number; b: number };

/**
 * Build a POS "Purchasing Sales Data" sheet. `rows` are written verbatim from row 2 down, then the
 * "Total Units" / "Total Values" sentinel rows are appended when `declaredUnits` is supplied — which
 * is what the real files carry and what the reconciliation guard reads.
 */
async function posWorkbook(input: {
  rows: PosRow[];
  declaredUnits?: { a: number; b: number } | null;
  declaredValues?: { a: number; b: number } | null;
}): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Purchasing Sales Data");

  const header: (string | null)[] = [];
  header[3] = "Product Code";
  header[4] = CHANNEL_A;
  header[5] = CHANNEL_B;
  header[6] = "Total"; // stops the channel scan, exactly as the real sheet does
  sheet.addRow(header);

  for (const row of input.rows) {
    const line: (string | number | null)[] = [];
    line[2] = row.name;
    line[3] = row.code;
    line[4] = row.a;
    line[5] = row.b;
    line[6] = row.a + row.b;
    sheet.addRow(line);
  }
  if (input.declaredUnits) {
    const line: (string | number | null)[] = [];
    line[2] = "Total Units";
    line[3] = "Total Units";
    line[4] = input.declaredUnits.a;
    line[5] = input.declaredUnits.b;
    sheet.addRow(line);
  }
  if (input.declaredValues) {
    const line: (string | number | null)[] = [];
    line[2] = "Total Values";
    line[3] = "Total Values";
    line[4] = input.declaredValues.a;
    line[5] = input.declaredValues.b;
    sheet.addRow(line);
  }
  return wb.xlsx.writeBuffer();
}

async function parsePos(buffer: ExcelJS.Buffer) {
  return parseWeeklyWorkbookBuffer({
    buffer: buffer as ArrayBuffer,
    distributorCode: "POS",
    distributorName: "POS Purchasing Sales",
    fileName: "Purchasing Sales Data.xlsx",
    references: references(),
    aliasIndex: aliasIndex({ "POS-SAG": "SA001", "POS-ROY": "RO001" }),
    branchMapIndex: branchIndex([CHANNEL_A, CHANNEL_B]),
    periodDate: "2026-08-01",
  });
}

export async function runWeeklyPosValueRowTests() {
  // ════════════ the 2026-08 shape: the value row REPEATS name and code ════════════
  // 12 units priced at 10 → the value row carries 120. Before the fix the pair merged and the cell
  // read 132 units; the headline assertion here is that it reads 12.
  {
    const parsed = await parsePos(
      await posWorkbook({
        rows: [
          { name: "SAGINKGO 30 CAP", code: "POS-SAG", a: 8, b: 4 },
          { name: "SAGINKGO 30 CAP", code: "POS-SAG", a: 80, b: 40 },
        ],
        declaredUnits: { a: 8, b: 4 },
        declaredValues: { a: 80, b: 40 },
      }),
    );
    assert.equal(parsed.ok, true, "POS repeated-key file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "POS repeated-key file validates");
      const total = parsed.rows
        .filter((row) => row.productCode === "SA001")
        .reduce((sum, row) => sum + Number(row.salesQty ?? 0), 0);
      assert.equal(total, 12, "value row that repeats name+code is NOT counted as units (12, never 132)");
      const value = parsed.rows
        .filter((row) => row.productCode === "SA001")
        .reduce((sum, row) => sum + Number(row.salesValue ?? 0), 0);
      assert.equal(value, 12 * PRICES.SA001, "value follows the true units, not the merged cell");
    }
  }

  // ════════════ the legacy shape: the value row leaves name and code BLANK ════════════
  {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Purchasing Sales Data");
    const header: (string | null)[] = [];
    header[3] = "Product Code";
    header[4] = CHANNEL_A;
    header[5] = CHANNEL_B;
    header[6] = "Total";
    sheet.addRow(header);
    const qty: (string | number | null)[] = [];
    qty[2] = "SAGINKGO 30 CAP";
    qty[3] = "POS-SAG";
    qty[4] = 8;
    qty[5] = 4;
    sheet.addRow(qty);
    const value: (string | number | null)[] = [];
    value[4] = 80;
    value[5] = 40;
    sheet.addRow(value); // blank name + blank code — the pre-2026-08 layout
    const totals: (string | number | null)[] = [];
    totals[2] = "Total Units";
    totals[4] = 8;
    totals[5] = 4;
    sheet.addRow(totals);

    const parsed = await parsePos(await wb.xlsx.writeBuffer());
    assert.equal(parsed.ok, true, "POS blank-name legacy file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "POS legacy file still validates");
      const total = parsed.rows
        .filter((row) => row.productCode === "SA001")
        .reduce((sum, row) => sum + Number(row.salesQty ?? 0), 0);
      assert.equal(total, 12, "blank-name value row is still skipped (unchanged behaviour)");
    }
  }

  // ════════════ the 2026-07 shape: ONE row per product, consecutive, DIFFERENT products ════════════
  // Production's 2026-07 POS batch held products on source rows 2,3,4,6,7 — consecutive and distinct.
  // Pair detection must not eat the second product just because it sits directly under the first.
  {
    const parsed = await parsePos(
      await posWorkbook({
        rows: [
          { name: "SAGINKGO 30 CAP", code: "POS-SAG", a: 8, b: 4 },
          { name: "ROYAFLOXACIN 500 TAB", code: "POS-ROY", a: 5, b: 3 },
        ],
        declaredUnits: { a: 13, b: 7 },
      }),
    );
    assert.equal(parsed.ok, true, "POS one-row-per-product file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "POS one-row-per-product file validates");
      const sag = parsed.rows
        .filter((row) => row.productCode === "SA001")
        .reduce((sum, row) => sum + Number(row.salesQty ?? 0), 0);
      const roy = parsed.rows
        .filter((row) => row.productCode === "RO001")
        .reduce((sum, row) => sum + Number(row.salesQty ?? 0), 0);
      assert.equal(sag, 12, "first product keeps its units");
      assert.equal(roy, 8, "a DIFFERENT product on the next row is not treated as a value row");
    }
  }

  // ════════════ the guard: parsed units must equal the sheet's own "Total Units" row ════════════
  // This is the check POS never had. It is what would have stopped the 2026-08 W3 upload outright,
  // and it is the backstop for whatever POS changes next.
  {
    const parsed = await parsePos(
      await posWorkbook({
        rows: [{ name: "SAGINKGO 30 CAP", code: "POS-SAG", a: 8, b: 4 }],
        declaredUnits: { a: 800, b: 400 }, // the file says 1,200; the rows say 12
      }),
    );
    assert.equal(parsed.ok, true, "POS mismatched-totals file parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "blocked", "a unit total that disagrees with the sheet BLOCKS the import");
      assert.ok(
        parsed.result.blockingReasons.some((reason) => reason.includes("Total Units")),
        "the blocking reason names the sheet's own Total Units row",
      );
    }
  }

  // ════════════ a file with no "Total Units" row is not blocked by the guard ════════════
  {
    const parsed = await parsePos(
      await posWorkbook({ rows: [{ name: "SAGINKGO 30 CAP", code: "POS-SAG", a: 8, b: 4 }], declaredUnits: null }),
    );
    assert.equal(parsed.ok, true, "POS file without a totals row parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "absent Total Units row does not block (guard is opt-in on the file)");
    }
  }
}
