import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import type { WeeklyBranchRegionIndex } from "../src/lib/sales/weekly/branch-region-map.ts";
import { normalizeCode, normalizeKey } from "../src/lib/sales/weekly/mapping-normalize.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyProductAliasIndex } from "../src/lib/sales/weekly/product-aliases.ts";

// ── synthetic master ─────────────────────────────────────────────────────────────────────────
// KNOWN factory_price + line so we can prove value = netQty * factory_price (NOT the sheet value).
const PRICES: Record<string, number> = { SA001: 10, RO001: 20, IV001: 5, SS001: 8 };
const LINES: Record<string, string> = { SA001: "CNS", RO001: "Anti infective", IV001: "Anti infective", SS001: "Anti infective" };

function references(overrides?: Partial<SalesReferenceData["products"][number]>[]): SalesReferenceData {
  const base = Object.keys(PRICES).map((productCode) => ({
    productCode,
    productName:
      productCode === "RO001"
        ? "ROYAFLOXACIN 500 TAB"
        : productCode === "IV001"
          ? "IVYRONC 100ML"
          : productCode === "SS001"
            ? "SATOSLIM 30 CAP"
            : "SAGINKGO 30 CAP",
    factoryPrice: PRICES[productCode],
    family: "",
    familyCode: "",
    line: LINES[productCode],
    source: "Sato",
  }));
  const products = overrides
    ? base.map((product) => {
        const override = overrides.find((o) => o.productCode === product.productCode);
        return override ? { ...product, ...override } : product;
      })
    : base;
  return {
    distributors: [
      { code: "EG", name: "EGD" },
      { code: "RM", name: "RAMCO" },
      { code: "IS", name: "Ibn Sina" },
      { code: "IS-S", name: "Ibn Sina Sato" },
      { code: "PS", name: "Overseas" },
    ],
    products,
    regions: [
      ["CA", "Cairo"],
      ["GZ", "Giza"],
      ["UE", "Upper Egypt"],
      ["D1", "Delta (1)"],
    ].map(([regionCode, regionName]) => ({ areaCode: `${regionCode}1`, areaName: regionName, regionCode, regionName })),
  };
}

// ── stubbed mapping indexes ────────────────────────────────────────────────────────────────────

function aliasIndex(distributor: string, codeMap: Record<string, string>, nameMap: Record<string, string> = {}): WeeklyProductAliasIndex {
  const byCode = new Map<string, string>();
  for (const [alias, product] of Object.entries(codeMap)) byCode.set(normalizeCode(alias), product);
  const byName = new Map<string, string>();
  for (const [alias, product] of Object.entries(nameMap)) byName.set(normalizeKey(alias), product);
  const index: WeeklyProductAliasIndex = new Map();
  index.set(distributor.toUpperCase(), { byCode, byName });
  return index;
}

type BranchEntry = { regionCode: string; regionName: string; excluded: boolean };

function branchIndex(input: {
  branches?: { key: string; fileType: "sales" | "stock" | "any"; region: string; excluded?: boolean }[];
  columns?: { colIndex: number; region: string; headerRaw: string; excluded?: boolean }[];
}): WeeklyBranchRegionIndex {
  const REGION_NAMES: Record<string, string> = { CA: "Cairo", GZ: "Giza", UE: "Upper Egypt", D1: "Delta (1)" };
  const byBranch = new Map<string, BranchEntry>();
  for (const branch of input.branches ?? []) {
    byBranch.set(`${branch.fileType}|${normalizeKey(branch.key)}`, {
      regionCode: branch.excluded ? "" : branch.region,
      regionName: branch.excluded ? "" : REGION_NAMES[branch.region] ?? branch.region,
      excluded: Boolean(branch.excluded),
    });
  }
  const byColumnIndex = new Map<number, BranchEntry & { headerRaw: string }>();
  for (const column of input.columns ?? []) {
    byColumnIndex.set(column.colIndex, {
      regionCode: column.excluded ? "" : column.region,
      regionName: column.excluded ? "" : REGION_NAMES[column.region] ?? column.region,
      excluded: Boolean(column.excluded),
      headerRaw: column.headerRaw,
    });
  }
  return { byBranch, byColumnIndex };
}

const round2 = (value: number) => Number(value.toFixed(2));

async function bufferOf(build: (wb: ExcelJS.Workbook) => void): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return wb.xlsx.writeBuffer();
}

// ── EG (EGD) synthetic combined workbook ─────────────────────────────────────────────────────
async function egWorkbook(opts?: { multiDate?: boolean }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sales = wb.addWorksheet("Branches Sales");
    const salesHeader = new Array(30).fill("");
    salesHeader[3] = "INVOICE_DATE"; // col4
    salesHeader[4] = "ITEM_CODE"; // col5
    salesHeader[5] = "ITEM_NAME"; // col6
    salesHeader[12] = "QTY_INVOICE"; // col13
    salesHeader[28] = "BRANCH_CODE"; // col29
    salesHeader[29] = "BRANCH_NAME"; // col30
    sales.addRow(salesHeader);
    const mkSalesRow = (date: Date, code: string, name: string, branchCode: string, branchName: string, qty: number) => {
      const r = new Array(30).fill("");
      r[3] = date;
      r[4] = code;
      r[5] = name;
      r[12] = qty;
      r[28] = branchCode;
      r[29] = branchName;
      return r;
    };
    const d1 = new Date(Date.UTC(2026, 5, 1));
    const d2 = new Date(Date.UTC(2026, 5, 8));
    sales.addRow(mkSalesRow(d1, "EG-SAG", "SAGINKGO", "B01", "Cairo Branch", 10));
    sales.addRow(mkSalesRow(opts?.multiDate ? d2 : d1, "EG-ROY", "ROYAFLOXACIN", "B02", "Giza Branch", 6));

    const returns = wb.addWorksheet("Branch Sales Return");
    const retHeader = new Array(30).fill("");
    retHeader[3] = "INVOICE_DATE";
    retHeader[4] = "ITEM_CODE";
    retHeader[5] = "ITEM_NAME";
    retHeader[13] = "RETURN_QTY"; // col14
    retHeader[28] = "BRANCH_CODE";
    retHeader[29] = "BRANCH_NAME";
    returns.addRow(retHeader);
    const mkRetRow = (code: string, branchCode: string, branchName: string, qtyNeg: number) => {
      const r = new Array(30).fill("");
      r[3] = d1;
      r[4] = code;
      r[5] = "SAGINKGO";
      r[13] = qtyNeg; // negative in the file
      r[28] = branchCode;
      r[29] = branchName;
      return r;
    };
    returns.addRow(mkRetRow("EG-SAG", "B01", "Cairo Branch", -2)); // returns 2 against Cairo SAGINKGO

    // Stock should ONLY come from Current Stock Branches.
    const stock = wb.addWorksheet("Current Stock Branches");
    const stockHeader = new Array(14).fill("");
    stockHeader[0] = "ITEM_CODE"; // col1
    stockHeader[1] = "ITEM_NAME_ENG"; // col2
    stockHeader[2] = "ITEM_STOCK"; // col3
    stockHeader[12] = "COMPANY_ENTITY_CODE"; // col13
    stockHeader[13] = "COMPANY_ENTITY_NAME"; // col14
    stock.addRow(stockHeader);
    const mkStockRow = (code: string, entityCode: string, entityName: string, qty: number) => {
      const r = new Array(14).fill("");
      r[0] = code;
      r[1] = "SAGINKGO";
      r[2] = qty;
      r[12] = entityCode;
      r[13] = entityName;
      return r;
    };
    stock.addRow(mkStockRow("EG-SAG", "B01", "Cairo Branch", 30));
    stock.addRow(mkStockRow("EG-SAG", "B01", "Cairo Branch", 20)); // summed → 50 for (EG-SAG, B01)

    // These sheets MUST be ignored.
    const pharmacy = wb.addWorksheet("Current Stock Pharmacy");
    pharmacy.addRow(["ITEM_CODE", "x", "ITEM_STOCK"]);
    pharmacy.addRow(["EG-SAG", "x", 9999]);
    wb.addWorksheet("Transfer").addRow(["ignore"]);
    wb.addWorksheet("Transfer Return").addRow(["ignore"]);
  });
}

// ── RM (RAMCO) synthetic combined workbook ─────────────────────────────────────────────────────
async function rmWorkbook(opts?: { multiDate?: boolean; divergentNet?: boolean }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sales = wb.addWorksheet("SALES");
    sales.addRow(["RAMCO Weekly Sales"]); // row 1 merged title
    const header = new Array(24).fill("");
    header[1] = "فرع"; // col2 branch
    header[8] = "ك.صنف"; // col9 item code
    header[9] = "صنف"; // col10 item name
    header[10] = "بيع"; // col11 gross
    header[12] = "مرتجع بيع"; // col13 return
    header[14] = "صافى كمية"; // col15 net
    header[23] = "تاريخ"; // col24 date
    sales.addRow(header);
    const d1 = new Date(Date.UTC(2026, 5, 1));
    const d2 = new Date(Date.UTC(2026, 5, 8));
    const mkRow = (date: Date, code: string, branch: string, gross: number, ret: number, netOverride?: number) => {
      const r = new Array(24).fill("");
      r[1] = branch;
      r[8] = code;
      r[9] = "SAGINKGO";
      r[10] = gross;
      r[12] = ret; // negative
      r[14] = netOverride ?? gross + ret; // net (col15) — authoritative; may diverge from gross+ret
      r[23] = date;
      return r;
    };
    // divergentNet → col15 carries an adjustment NOT reflected in بيع/مرتجع (gross 12, ret -2 would
    // imply net 10, but col15 says 9). The parser must honor col15, not recompute 12 − 2.
    sales.addRow(mkRow(d1, "RM-SAG", "Cairo Branch", 12, -2, opts?.divergentNet ? 9 : undefined)); // net 10 (or 9)
    sales.addRow(mkRow(opts?.multiDate ? d2 : d1, "RM-ROY", "Giza Branch", 5, 0)); // net 5

    const stock = wb.addWorksheet("STOCK");
    stock.addRow(["RAMCO Stock"]);
    const stockHeader = new Array(35).fill("");
    stockHeader[3] = "كود"; // col4
    stockHeader[4] = "إسم الصنف"; // col5
    stockHeader[34] = "الإجمالى"; // col35 grand total
    stock.addRow(stockHeader);
    const mkStock = (code: string, qty: number) => {
      const r = new Array(35).fill("");
      r[3] = code;
      r[4] = "SAGINKGO";
      r[34] = qty;
      return r;
    };
    stock.addRow(mkStock("RM-SAG", 40)); // product-level total, no branch
  });
}

// ── IS-S (Ibn Sina Sato) single sheet ───────────────────────────────────────────────────────────
async function issWorkbook(): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("SalesAndStockReport2_DataHub");
    sheet.addRow(["Weekly Sales and Stock"]); // title row 1
    const header = new Array(10).fill("");
    header[0] = "Date"; // col1
    header[3] = "Item Code"; // col4
    header[4] = "Item name"; // col5
    header[5] = "Branch Code"; // col6
    header[6] = "Branch Name"; // col7
    header[7] = "Stock"; // col8
    header[9] = "Sales Quantity"; // col10
    sheet.addRow(header);
    const d = new Date(Date.UTC(2026, 5, 6));
    const mkRow = (code: string, branchCode: string, branchName: string, stock: number, signedSales: number) => {
      const r = new Array(10).fill("");
      r[0] = d;
      r[3] = code;
      r[4] = "SAGINKGO";
      r[5] = branchCode;
      r[6] = branchName;
      r[7] = stock;
      r[9] = signedSales;
      return r;
    };
    sheet.addRow(mkRow("ISS-SAG", "B01", "Cairo Branch", 30, 10)); // sale 10
    sheet.addRow(mkRow("ISS-SAG", "B01", "Cairo Branch", 0, -3)); // inline return 3
    sheet.addRow(new Array(10).fill("")); // footer / blank row → skipped
  });
}

// ── IS (Ibn Sina ISP) single sheet, no Date ──────────────────────────────────────────────────────
async function isWorkbook(): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Sheet2");
    const header = new Array(10).fill("");
    header[2] = "Item Code"; // col3
    header[3] = "Item name"; // col4
    header[4] = "Branch Code"; // col5
    header[5] = "Branch Name"; // col6
    header[6] = "Stock"; // col7
    header[8] = "Sales Quantity"; // col9
    header[9] = "Free Unit"; // col10 — read but never priced
    sheet.addRow(header);
    const mkRow = (code: string, branchCode: string, branchName: string, stock: number, signedSales: number, free: number) => {
      const r = new Array(10).fill("");
      r[2] = code;
      r[3] = "SAGINKGO";
      r[4] = branchCode;
      r[5] = branchName;
      r[6] = stock;
      r[8] = signedSales;
      r[9] = free;
      return r;
    };
    sheet.addRow(mkRow("IS-SAG", "B01", "Cairo Branch", 25, 8, 5)); // sale 8, free 5 (ignored)
  });
}

// ── PS (Overseas) two matrix files ──────────────────────────────────────────────────────────────
async function psSalesWorkbook(opts?: { driftTotal?: boolean }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Data");
    const header = new Array(121).fill("");
    header[2] = "Mat. Code"; // col3
    header[3] = "Mat. Desc."; // col4
    header[4] = "Retail Cairo  _ك"; // col5 (outlet) — verbatim w/ double space + _ك
    header[5] = "Super KA Delta_ك"; // col6 (outlet)
    header[118] = "Total Qty."; // col119
    header[119] = "Bonus Qty."; // col120
    header[120] = "Total Val."; // col121
    sheet.addRow(header);
    const r = new Array(121).fill("");
    r[2] = "PS-SAG";
    r[3] = "SAGINKGO";
    r[4] = 5; // Retail Cairo net
    r[5] = 3; // Super KA Delta net
    r[118] = opts?.driftTotal ? 10 : 8; // Total Qty: 10 → +2 unallocated; 8 → reconciled exactly
    r[119] = 99; // bonus (ignored)
    r[120] = 99999; // total val (ignored)
    sheet.addRow(r);
  });
}

async function psStockWorkbook(opts?: { driftHeader?: boolean }): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Data");
    const header = new Array(85).fill("");
    header[2] = "Mat. Code"; // col3
    header[3] = "Mat. Desc."; // col4
    header[4] = "Total val."; // col5
    header[5] = "Total Qty."; // col6
    header[6] = opts?.driftHeader ? "Some OTHER Warehouse" : "Cairo Warehouse"; // col7 location
    sheet.addRow(header);
    const r = new Array(85).fill("");
    r[2] = "PS-SAG";
    r[3] = "SAGINKGO";
    r[4] = 0;
    r[5] = 0;
    r[6] = 40; // stock units at col7
    sheet.addRow(r);
  });
}

export async function runWeeklySalesImportTests() {
  // ════════════ EG (EGD) ════════════
  {
    const branch = branchIndex({
      branches: [
        { key: "B01", fileType: "sales", region: "CA" },
        { key: "B02", fileType: "sales", region: "GZ" },
        { key: "B01", fileType: "stock", region: "CA" },
      ],
    });
    const aliases = aliasIndex("EG", { "EG-SAG": "SA001", "EG-ROY": "RO001" });

    // Multi-date → blocked without periodDate.
    const blocked = await parseWeeklyWorkbookBuffer({
      buffer: await egWorkbook({ multiDate: true }),
      distributorCode: "EG",
      distributorName: "EGD",
      fileName: "EGD.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
    });
    assert.equal(blocked.ok, true, "EG parses");
    if (blocked.ok) assert.equal(blocked.result.status, "blocked", "EG multi-date blocks without periodDate");

    // Multi-date OK with periodDate.
    const eg = await parseWeeklyWorkbookBuffer({
      buffer: await egWorkbook({ multiDate: true }),
      distributorCode: "EG",
      distributorName: "EGD",
      fileName: "EGD.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-01",
    });
    assert.equal(eg.ok, true);
    if (eg.ok) {
      assert.equal(eg.result.status, "validated", "EG validates with periodDate");
      assert.equal(eg.result.weekStart, "2026-06-01", "EG uses supplied periodDate");

      const cairo = eg.rows.find((row) => normalizeKey(row.branchCode) === normalizeKey("B01"));
      assert.ok(cairo, "EG Cairo fact row present");
      assert.equal(cairo?.salesQty, 10, "EG Cairo gross = 10");
      assert.equal(cairo?.returnQty, 2, "EG Cairo return = 2 (abs of -2)");
      assert.equal(cairo?.netQty, 8, "EG Cairo net = gross - return = 8");
      assert.equal(cairo?.salesValue, round2(8 * PRICES.SA001), "EG value = net * factory_price");
      assert.equal(cairo?.stockQty, 50, "EG stock summed from Current Stock Branches only (30+20)");
      assert.equal(cairo?.regionCode, "CA", "EG region is the MASTER region code");

      // Pharmacy stock (9999) must NOT leak in.
      assert.equal(eg.result.totals.stockQty, 50, "EG total stock excludes pharmacy/transfer sheets");
      // Totals carry Sales/Return/Net.
      assert.equal(eg.result.totals.salesQty, 16, "EG gross total = 10 + 6");
      assert.equal(eg.result.totals.returnQty, 2, "EG return total = 2");
      assert.equal(eg.result.totals.netQty, 14, "EG net total = 14");
    }
  }

  // ════════════ RM (RAMCO) ════════════
  {
    const branch = branchIndex({
      branches: [
        { key: "Cairo Branch", fileType: "sales", region: "CA" },
        { key: "Giza Branch", fileType: "sales", region: "GZ" },
      ],
    });
    const aliases = aliasIndex("RM", { "RM-SAG": "SA001", "RM-ROY": "RO001" });
    const rm = await parseWeeklyWorkbookBuffer({
      buffer: await rmWorkbook(),
      distributorCode: "RM",
      distributorName: "RAMCO",
      fileName: "RAMCO.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
    });
    assert.equal(rm.ok, true, "RM parses");
    if (rm.ok) {
      assert.equal(rm.result.status, "validated", "RM single date validates (header row 2 handled)");
      assert.equal(rm.result.weekStart, "2026-06-01", "RM single sheet date auto-used");
      const cairo = rm.rows.find((row) => row.productCode === "SA001" && row.branchCode === "Cairo Branch");
      assert.ok(cairo, "RM Cairo fact present");
      assert.equal(cairo?.netQty, 10, "RM net from صافى كمية (gross 12 - return 2)");
      assert.equal(cairo?.salesQty, 12, "RM gross from بيع");
      assert.equal(cairo?.returnQty, 2, "RM return from مرتجع بيع");
      assert.equal(cairo?.salesValue, round2(10 * PRICES.SA001), "RM value = net * factory_price");
      // Stock-only product-level row (no branch) is allowed (not blocked).
      const stockRow = rm.rows.find((row) => row.productCode === "SA001" && row.stockQty === 40 && !row.branchCode);
      assert.ok(stockRow, "RM stock-only row present under empty branch");
      assert.equal(rm.result.totals.stockQty, 40, "RM stock total from الإجمالى");
    }

    // صافى كمية (col15) is AUTHORITATIVE: when it diverges from بيع − مرتجع, the parser must use
    // col15 (net 9), NOT recompute gross − return (which would say 10). Gross stays 12; return is
    // reconciled to 12 − 9 = 3 so (gross − return) == col15; value = 9 * price.
    const divergent = await parseWeeklyWorkbookBuffer({
      buffer: await rmWorkbook({ divergentNet: true }),
      distributorCode: "RM",
      distributorName: "RAMCO",
      fileName: "RAMCO.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
    });
    assert.equal(divergent.ok, true, "RM divergent-net parses");
    if (divergent.ok) {
      assert.equal(divergent.result.status, "validated", "RM divergent-net validates");
      const cairo = divergent.rows.find((row) => row.productCode === "SA001" && row.branchCode === "Cairo Branch");
      assert.ok(cairo, "RM divergent Cairo fact present");
      assert.equal(cairo?.netQty, 9, "RM net honors صافى كمية (col15 = 9), not gross − return (10)");
      assert.equal(cairo?.salesQty, 12, "RM gross stays بيع (12)");
      assert.equal(cairo?.returnQty, 3, "RM return reconciled to gross − net = 12 − 9 = 3");
      assert.equal(cairo?.salesValue, round2(9 * PRICES.SA001), "RM value = authoritative net * factory_price");
      assert.equal(cairo?.rawRow.authoritativeNet, "true", "RM row flags authoritative net in audit");
      assert.equal(cairo?.rawRow.observedReturnQty, "2", "RM audit keeps the observed return (abs col13 = 2)");
    }
  }

  // ════════════ IS-S (Ibn Sina Sato) ════════════
  {
    const branch = branchIndex({ branches: [{ key: "B01", fileType: "sales", region: "CA" }, { key: "B01", fileType: "stock", region: "CA" }] });
    const aliases = aliasIndex("IS-S", { "ISS-SAG": "SA001" });
    const iss = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
    });
    assert.equal(iss.ok, true, "IS-S parses");
    if (iss.ok) {
      assert.equal(iss.result.status, "validated", "IS-S single auto date validates");
      assert.equal(iss.result.weekStart, "2026-06-06", "IS-S single Date auto-used");
      const fact = iss.rows.find((row) => row.productCode === "SA001");
      assert.ok(fact, "IS-S fact present");
      assert.equal(fact?.salesQty, 10, "IS-S gross = +10 line");
      assert.equal(fact?.returnQty, 3, "IS-S inline negative -3 becomes a return");
      assert.equal(fact?.netQty, 7, "IS-S net = 10 - 3");
      assert.equal(fact?.salesValue, round2(7 * PRICES.SA001), "IS-S value = net * factory_price");
      assert.equal(fact?.stockQty, 30, "IS-S stock captured");
      // Footer/blank row produced no extra fact row.
      assert.equal(iss.rows.length, 1, "IS-S footer row skipped (one fact row)");
    }
  }

  // ════════════ IS (Ibn Sina ISP) ════════════
  {
    const branch = branchIndex({ branches: [{ key: "B01", fileType: "sales", region: "CA" }, { key: "B01", fileType: "stock", region: "CA" }] });
    const aliases = aliasIndex("IS", { "IS-SAG": "SA001" });

    // No date column → blocked without periodDate.
    const noDate = await parseWeeklyWorkbookBuffer({
      buffer: await isWorkbook(),
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      fileName: "ISP.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
    });
    assert.equal(noDate.ok, true, "IS parses");
    if (noDate.ok) assert.equal(noDate.result.status, "blocked", "IS with no date blocks without periodDate");

    const is = await parseWeeklyWorkbookBuffer({
      buffer: await isWorkbook(),
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      fileName: "ISP.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-06",
    });
    assert.equal(is.ok, true);
    if (is.ok) {
      assert.equal(is.result.status, "validated", "IS validates with periodDate");
      const fact = is.rows.find((row) => row.productCode === "SA001");
      assert.equal(fact?.salesQty, 8, "IS gross = 8");
      assert.equal(fact?.netQty, 8, "IS net = 8 (no returns)");
      // Free Unit (5) must NOT change value: value = 8 * price, not 13 * price.
      assert.equal(fact?.salesValue, round2(8 * PRICES.SA001), "IS Free Unit not priced");
      assert.notEqual(fact?.salesValue, round2(13 * PRICES.SA001), "IS Free Unit excluded from value");
    }
  }

  // ════════════ PS (Overseas) two-file ════════════
  {
    const branch = branchIndex({
      branches: [
        { key: "Retail Cairo  _ك", fileType: "sales", region: "CA" },
        { key: "Super KA Delta_ك", fileType: "sales", region: "D1" },
      ],
      columns: [{ colIndex: 7, region: "CA", headerRaw: "Cairo Warehouse" }],
    });
    const aliases = aliasIndex("PS", { "PS-SAG": "SA001" });

    // Missing one file → blocked.
    const missing = await parseWeeklyWorkbookBuffer({
      salesBuffer: await psSalesWorkbook(),
      distributorCode: "PS",
      distributorName: "Overseas",
      fileName: "PS.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-06",
    });
    assert.equal(missing.ok, true, "PS parses with missing stock file");
    if (missing.ok) assert.equal(missing.result.status, "blocked", "PS blocks when one file is missing");

    // Both files, Total Qty matches outlet sum exactly (no unallocated row).
    const exact = await parseWeeklyWorkbookBuffer({
      salesBuffer: await psSalesWorkbook({ driftTotal: false }),
      stockBuffer: await psStockWorkbook(),
      distributorCode: "PS",
      distributorName: "Overseas",
      fileName: "PS.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-06",
    });
    assert.equal(exact.ok, true);
    if (exact.ok) {
      assert.equal(exact.result.status, "validated", "PS two-file validates");
      // PS preview shows NET only: returnQty 0, salesQty = net.
      for (const row of exact.rows) assert.equal(row.returnQty, 0, "PS rows carry no separate return");
      const cairo = exact.rows.find((row) => normalizeKey(row.branchCode) === normalizeKey("Retail Cairo  _ك"));
      assert.equal(cairo?.netQty, 5, "PS Retail Cairo outlet net = 5");
      assert.equal(cairo?.salesQty, 5, "PS salesQty mirrors net");
      assert.equal(cairo?.salesValue, round2(5 * PRICES.SA001), "PS value = net * factory_price");
      assert.equal(cairo?.regionCode, "CA", "PS outlet region from branch map (master code)");
      // Stock keyed by column index → region CA.
      const stockRow = exact.rows.find((row) => row.stockQty === 40);
      assert.ok(stockRow, "PS stock row present");
      assert.equal(stockRow?.regionCode, "CA", "PS stock region resolved by column index");
      assert.notEqual(exact.result.totals.salesValue, 99999, "PS uploaded Total Val ignored");
      // No unallocated row when totals reconcile.
      assert.equal(exact.rows.some((row) => row.rawRow.unallocated === "true"), false, "no unallocated row when reconciled");
    }

    // Total Qty drift → an unallocated row reconciles the product total.
    const drift = await parseWeeklyWorkbookBuffer({
      salesBuffer: await psSalesWorkbook({ driftTotal: true }),
      stockBuffer: await psStockWorkbook(),
      distributorCode: "PS",
      distributorName: "Overseas",
      fileName: "PS.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-06",
    });
    assert.equal(drift.ok, true);
    if (drift.ok) {
      const unallocated = drift.rows.find((row) => row.rawRow.unallocated === "true");
      assert.ok(unallocated, "PS unallocated reconciliation row present when Total Qty differs");
      assert.equal(unallocated?.netQty, 2, "PS unallocated carries the difference (10 - 8)");
      const psNetTotal = drift.rows.reduce((acc, row) => acc + row.netQty, 0);
      assert.equal(round2(psNetTotal), 10, "PS net total reconciles to Total Qty (10)");
    }

    // Header drift on the stock column → blocked.
    const headerDrift = await parseWeeklyWorkbookBuffer({
      salesBuffer: await psSalesWorkbook(),
      stockBuffer: await psStockWorkbook({ driftHeader: true }),
      distributorCode: "PS",
      distributorName: "Overseas",
      fileName: "PS.xlsx",
      references: references(),
      aliasIndex: aliases,
      branchMapIndex: branch,
      periodDate: "2026-06-06",
    });
    assert.equal(headerDrift.ok, true);
    if (headerDrift.ok) assert.equal(headerDrift.result.status, "blocked", "PS stock header drift blocks the batch");
  }

  // ════════════ STRICT validation classes ════════════
  {
    const branch = branchIndex({ branches: [{ key: "B01", fileType: "sales", region: "CA" }, { key: "B01", fileType: "stock", region: "CA" }] });

    // (1) Unmapped alias → validated with warning (stored for auto-heal when alias is added).
    const unmappedAlias = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references(),
      aliasIndex: aliasIndex("IS-S", {}), // no alias for ISS-SAG
      branchMapIndex: branch,
    });
    assert.equal(unmappedAlias.ok, true);
    if (unmappedAlias.ok) {
      assert.equal(unmappedAlias.result.status, "validated", "unmapped alias validates with warning (not blocked)");
      assert.equal(unmappedAlias.result.importableRows, unmappedAlias.result.rowCount, "unresolved-product rows are still importable");
      assert.ok(unmappedAlias.result.issues.some((i) => i.field === "productCode" && i.severity === "warning"), "no-alias recorded as warning");
    }

    // (2) Unpriced master → blocked.
    const unpriced = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references([{ productCode: "SA001", factoryPrice: 0 }]),
      aliasIndex: aliasIndex("IS-S", { "ISS-SAG": "SA001" }),
      branchMapIndex: branch,
    });
    assert.equal(unpriced.ok, true);
    if (unpriced.ok) {
      assert.equal(unpriced.result.status, "blocked", "unpriced master blocks");
      assert.ok(unpriced.result.issues.some((i) => i.field === "factoryPrice" && i.severity === "failure"), "unpriced failure recorded");
    }

    // (3) Unlined master → blocked.
    const unlined = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references([{ productCode: "SA001", line: "" }]),
      aliasIndex: aliasIndex("IS-S", { "ISS-SAG": "SA001" }),
      branchMapIndex: branch,
    });
    assert.equal(unlined.ok, true);
    if (unlined.ok) {
      assert.equal(unlined.result.status, "blocked", "unlined master blocks");
      assert.ok(unlined.result.issues.some((i) => i.field === "officialLine" && i.severity === "failure"), "unlined failure recorded");
    }

    // (4) Unmapped non-excluded branch → blocked.
    const unmappedBranch = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references(),
      aliasIndex: aliasIndex("IS-S", { "ISS-SAG": "SA001" }),
      branchMapIndex: branchIndex({ branches: [{ key: "B01", fileType: "stock", region: "CA" }] }), // sales B01 not mapped
    });
    assert.equal(unmappedBranch.ok, true);
    if (unmappedBranch.ok) {
      assert.equal(unmappedBranch.result.status, "blocked", "unmapped non-excluded branch blocks");
      assert.ok(unmappedBranch.result.issues.some((i) => i.field === "regionCode" && i.severity === "failure"), "branch failure recorded");
    }

    // excluded branch → cell dropped from totals, NOT a failure.
    const excluded = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "IS-S",
      distributorName: "Ibn Sina Sato",
      fileName: "ISS.xlsx",
      references: references(),
      aliasIndex: aliasIndex("IS-S", { "ISS-SAG": "SA001" }),
      branchMapIndex: branchIndex({
        branches: [
          { key: "B01", fileType: "sales", region: "CA", excluded: true },
          { key: "B01", fileType: "stock", region: "CA", excluded: true },
        ],
      }),
    });
    assert.equal(excluded.ok, true);
    if (excluded.ok) {
      assert.equal(excluded.result.status, "validated", "excluded branch does not block");
      assert.equal(excluded.result.totals.salesValue, 0, "excluded branch cells dropped from totals");
      assert.equal(excluded.result.rowCount, 0, "excluded branch produces no fact rows");
    }
  }

  // ════════════ unknown distributor ════════════
  {
    const unsupported = await parseWeeklyWorkbookBuffer({
      buffer: await issWorkbook(),
      distributorCode: "ZZ",
      distributorName: "Unknown",
      fileName: "x.xlsx",
      references: references(),
      aliasIndex: aliasIndex("ZZ", {}),
      branchMapIndex: branchIndex({}),
    });
    assert.equal(unsupported.ok, false, "unknown distributor has no weekly adapter");
    if (!unsupported.ok) assert.equal(unsupported.error.code, "unsupported_template");
  }
}
