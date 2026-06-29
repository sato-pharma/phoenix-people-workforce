import { Workbook, type Worksheet } from "@node-projects/excelforge";

import { systemIdentity } from "@/config/system-settings";
import type { WeeklyDashboard, WeeklyFactExportRow } from "@/lib/sales/weekly/types";
import {
  ORANGE, ORANGE_DEEP, BLUE, SLATE_900, SLATE_800, WHITE, INK, GREEN, AMBER, RED,
  F_VALUE, F_UNITS, F_PCT, F_Z, F_WK,
  MAX_MATRIX_PRODUCTS, MAX_TRAJ_WEEKS, MAX_COVERAGE_COMBOS, MAX_RP_PAIRS,
  DATA_HEADERS, DATA_NCOLS, colLetter,
  cleanText, esc,
  dataRange, sumifs1, div0,
  makeCfPriority,
  fill,
  headerStyle, headerRightStyle, totalStyle, totalNumStyle,
  textCell, numCell, barCell,
  bandHeader, sectionTitle, applyPrintSetup, labelFilters,
  groupRow, collapseBand,
} from "@/lib/sales/weekly/export-kit";

// ──────────────────────────────────────────────────────────────────────────────
// Weekly Sales — interactive BI workbook (ExcelForge engine).
//
// A hidden `Data` Excel Table (`tblWeekly`) is the single source of truth; every
// visible number is a live SUMIFS / SUM / share FORMULA over it (never a baked-in
// value), so editing the data recalculates the whole report. On top of it: a branded
// Dashboard cover (KPI formulas + executive narrative + native charts + a clickable
// Contents panel), region→product drill-downs, region×product / region×week matrices,
// a zero-sales gap map, global + per-region Pareto, growth contribution, sell-through /
// stock-coverage, statistical outliers, branch-coverage depth, line sub-dashboards,
// the Distributor×Product cross-tab, a waterfall, a week comparison, a native pivot
// (interactive only) and a Report Sources sheet.
//
// All shared primitives + the repair-hardening rules live in `export-kit.ts`.
// Sheet names are ASCII only (a prior non-ASCII name caused Excel repair). Every
// "exotic" call (outline / conditional-format / chart / pivot / slicer) is wrapped so
// a single failure degrades gracefully instead of corrupting the package.
// ──────────────────────────────────────────────────────────────────────────────

// ── JS-side aggregation derived from the row grain (layout only; values stay formulas) ──
type ProdAgg = { code: string; name: string; value: number; units: number };
type RegionNode = { code: string; name: string; total: number; products: ProdAgg[] };

/** Region → product tree, regions ordered by value desc, products by value desc. */
function buildRegionTree(rows: WeeklyFactExportRow[]): RegionNode[] {
  const regions = new Map<string, { code: string; name: string; total: number; products: Map<string, ProdAgg> }>();
  for (const r of rows) {
    const rc = cleanText(r.regionCode);
    let reg = regions.get(rc);
    if (!reg) { reg = { code: rc, name: cleanText(r.regionName || r.regionCode), total: 0, products: new Map() }; regions.set(rc, reg); }
    reg.total += r.salesValue;
    const pc = cleanText(r.productCode);
    let p = reg.products.get(pc);
    if (!p) { p = { code: pc, name: cleanText(r.productName || r.productCode), value: 0, units: 0 }; reg.products.set(pc, p); }
    p.value += r.salesValue; p.units += r.salesUnits;
  }
  return [...regions.values()]
    .sort((a, b) => b.total - a.total)
    .map((reg) => ({ code: reg.code, name: reg.name, total: reg.total, products: [...reg.products.values()].sort((a, b) => b.value - a.value) }));
}

/** Distinct (region, product) pairs present in the data, capped. */
function presentPairs(tree: RegionNode[], cap: number): { pairs: { rc: string; rn: string; pc: string; pn: string; value: number }[]; truncated: number } {
  const pairs: { rc: string; rn: string; pc: string; pn: string; value: number }[] = [];
  for (const reg of tree) for (const p of reg.products) pairs.push({ rc: reg.code, rn: reg.name, pc: p.code, pn: p.name, value: p.value });
  if (pairs.length > cap) return { pairs: pairs.slice(0, cap), truncated: pairs.length - cap };
  return { pairs, truncated: 0 };
}

/** Ordered (month, week) columns from the de-cumulated trend, most-recent `cap`. */
function orderedWeeks(data: WeeklyDashboard, cap: number): { month: string; week: string; label: string }[] {
  const seen = new Set<string>();
  const weeks: { month: string; week: string; label: string }[] = [];
  for (const t of [...(data.trend ?? [])].sort((a, b) => a.weekStart.localeCompare(b.weekStart))) {
    if (t.weekNumber == null || !t.cycleMonth) continue;
    const month = t.cycleMonth.slice(0, 7);
    const week = `W${t.weekNumber}`;
    const key = `${month}||${week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    weeks.push({ month, week, label: `${week} ${month}` });
  }
  return weeks.length > cap ? weeks.slice(weeks.length - cap) : weeks;
}

type LineNode = { key: string; label: string; total: number; products: ProdAgg[] };
/** Line → product tree (empty line → the "Unspecified" bucket, criterion Line=""). */
function buildLineTree(rows: WeeklyFactExportRow[]): LineNode[] {
  const lines = new Map<string, { key: string; label: string; total: number; products: Map<string, ProdAgg> }>();
  for (const r of rows) {
    const key = cleanText(r.line); // criterion value (may be "")
    let line = lines.get(key);
    if (!line) { line = { key, label: key || "Unspecified", total: 0, products: new Map() }; lines.set(key, line); }
    line.total += r.salesValue;
    const pc = cleanText(r.productCode);
    let p = line.products.get(pc);
    if (!p) { p = { code: pc, name: cleanText(r.productName || r.productCode), value: 0, units: 0 }; line.products.set(pc, p); }
    p.value += r.salesValue; p.units += r.salesUnits;
  }
  return [...lines.values()]
    .sort((a, b) => b.total - a.total)
    .map((l) => ({ key: l.key, label: l.label, total: l.total, products: [...l.products.values()].sort((a, b) => b.value - a.value) }));
}

/** Writes a small italic note row (used when a builder caps its output). */
function truncationNote(sheet: Worksheet, row: number, n: number, noun: string) {
  if (n <= 0) return;
  sheet.setValue(row, 1, `… +${n} more ${noun} not shown (capped for file size)`);
  sheet.setStyle(row, 1, { font: { italic: true, size: 9, color: RED, name: "Calibri" } });
}

// ── hidden Data Excel Table (single source for every formula / pivot / chart) ─────────────────────
function buildDataSheet(wb: Workbook, rows: WeeklyFactExportRow[]): number {
  const sheet = wb.addSheet("Data", { state: "hidden" });
  sheet.writeRow(1, 1, DATA_HEADERS);
  const matrix = rows.map((r) => [
    cleanText(r.distributorName || r.distributorCode), cleanText(r.distributorCode),
    cleanText(r.productName || r.productCode), cleanText(r.productCode), cleanText(r.line),
    cleanText(r.regionName || r.regionCode), cleanText(r.regionCode),
    cleanText(r.branchName || r.branchCode), cleanText(r.branchCode),
    (r.cycleMonth ?? "").slice(0, 7), r.weekNumber != null ? `W${r.weekNumber}` : "", r.weekStart,
    r.salesValue, r.salesUnits, r.stockUnits,
  ]);
  if (matrix.length) sheet.writeArray(2, 1, matrix);
  const lastRow = Math.max(2, 1 + matrix.length);
  sheet.addTable({
    name: "tblWeekly", displayName: "tblWeekly",
    ref: `A1:${colLetter(DATA_NCOLS)}${lastRow}`,
    style: "TableStyleMedium2", showRowStripes: true,
    columns: DATA_HEADERS.map((name) => ({ name, filterButton: true })),
  });
  return lastRow;
}

// ── generic formula-driven breakdown sheet (metrics are SUMIFS; AutoFilter on the header) ─────────
type BreakdownDim = { name: string; code: string; extra?: string };
function buildBreakdownSheet(
  wb: Workbook,
  opts: { sheetName: string; title: string; subtitle: string; dimLabel: string; extraLabel?: string; critCol: "RegionCode" | "ProductCode" | "DistCode" | "BranchCode"; last: number; dims: BreakdownDim[]; generatedAt: string },
): { sheetName: string; firstRow: number; lastRow: number; nameCol: number; valueCol: number } {
  const { sheetName, title, subtitle, dimLabel, extraLabel, critCol, last, dims, generatedAt } = opts;
  const sheet = wb.addSheet(sheetName);
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const hasExtra = !!extraLabel;
  const cName = 2, cExtra = hasExtra ? 3 : 0, cValue = hasExtra ? 4 : 3, cUnits = cValue + 1, cStock = cValue + 2, cShare = cValue + 3, ncols = cShare;
  bandHeader(sheet, ncols, title, subtitle);

  const headerRow = 4;
  sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
  sheet.setValue(headerRow, cName, dimLabel); sheet.setStyle(headerRow, cName, headerStyle);
  if (hasExtra) { sheet.setValue(headerRow, cExtra, extraLabel); sheet.setStyle(headerRow, cExtra, headerStyle); }
  sheet.setValue(headerRow, cValue, "Sales Value (EGP)"); sheet.setStyle(headerRow, cValue, headerRightStyle);
  sheet.setValue(headerRow, cUnits, "Units Sold"); sheet.setStyle(headerRow, cUnits, headerRightStyle);
  sheet.setValue(headerRow, cStock, "Stock Units"); sheet.setStyle(headerRow, cStock, headerRightStyle);
  sheet.setValue(headerRow, cShare, "Share"); sheet.setStyle(headerRow, cShare, headerRightStyle);

  const firstRow = headerRow + 1;
  const valRange = dataRange("Value", last);
  dims.forEach((d, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, cName, d.name); sheet.setStyle(row, cName, textCell(false, zebra));
    if (hasExtra) { sheet.setValue(row, cExtra, d.extra ?? ""); sheet.setStyle(row, cExtra, textCell(false, zebra)); }
    sheet.setFormula(row, cValue, sumifs1("Value", last, [[critCol, d.code]])); sheet.setStyle(row, cValue, numCell(F_VALUE, zebra));
    sheet.setFormula(row, cUnits, sumifs1("Units", last, [[critCol, d.code]])); sheet.setStyle(row, cUnits, numCell(F_UNITS, zebra));
    sheet.setFormula(row, cStock, sumifs1("Stock", last, [[critCol, d.code]])); sheet.setStyle(row, cStock, numCell(F_UNITS, zebra));
    sheet.setFormula(row, cShare, div0(`${colLetter(cValue)}${row}`, `SUM(${valRange})`)); sheet.setStyle(row, cShare, numCell(F_PCT, zebra));
  });

  const lastRow = firstRow + dims.length - 1, totalRow = lastRow + 1;
  sheet.setStyle(totalRow, 1, totalStyle);
  sheet.setValue(totalRow, cName, "TOTAL"); sheet.setStyle(totalRow, cName, totalStyle);
  if (hasExtra) { sheet.setValue(totalRow, cExtra, ""); sheet.setStyle(totalRow, cExtra, totalStyle); }
  sheet.setFormula(totalRow, cValue, `SUM(${colLetter(cValue)}${firstRow}:${colLetter(cValue)}${lastRow})`); sheet.setStyle(totalRow, cValue, totalNumStyle(F_VALUE));
  sheet.setFormula(totalRow, cUnits, `SUM(${colLetter(cUnits)}${firstRow}:${colLetter(cUnits)}${lastRow})`); sheet.setStyle(totalRow, cUnits, totalNumStyle(F_UNITS));
  sheet.setFormula(totalRow, cStock, `SUM(${colLetter(cStock)}${firstRow}:${colLetter(cStock)}${lastRow})`); sheet.setStyle(totalRow, cStock, totalNumStyle(F_UNITS));
  sheet.setValue(totalRow, cShare, 1); sheet.setStyle(totalRow, cShare, totalNumStyle(F_PCT));

  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(cName, 32);
  if (hasExtra) sheet.setColumnWidth(cExtra, 22);
  [cValue, cUnits, cStock].forEach((c) => sheet.setColumnWidth(c, 19));
  sheet.setColumnWidth(cShare, 11);
  sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`);
  if (dims.length > 0) {
    try { sheet.addConditionalFormat({ sqref: `${colLetter(cValue)}${firstRow}:${colLetter(cValue)}${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
  }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, title, generatedAt, ncols, totalRow);
  return { sheetName, firstRow, lastRow, nameCol: cName, valueCol: cValue };
}

// ── Region → Product drill-down (collapsible outline groups) ──────────────────────────────────────
function buildRegionProductDrill(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Region Drill (Region → Product)";
  const sheet = wb.addSheet("Region Drill", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6; // Region/Product | Value | Units | Stock | % of Region | % of Total
  bandHeader(sheet, ncols, title, labelFilters(data.appliedFilters));
  const headerRow = 4;
  ["Region / Product", "Sales Value (EGP)", "Units Sold", "Stock Units", "% of Region", "% of Total"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle);
  });
  const valTotal = `SUM(${dataRange("Value", last)})`;
  let row = headerRow + 1;
  const firstBody = row;
  if (tree.length === 0) {
    sheet.setValue(row, 1, "No data for the current filters."); sheet.setStyle(row, 1, textCell());
    row += 1;
  }
  for (const reg of tree) {
    const regRow = row;
    // Region header row = the region subtotal (summary above its product details).
    sheet.setValue(regRow, 1, reg.name); sheet.setStyle(regRow, 1, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    sheet.setFormula(regRow, 2, sumifs1("Value", last, [["RegionCode", reg.code]])); sheet.setStyle(regRow, 2, totalNumStyle(F_VALUE));
    sheet.setFormula(regRow, 3, sumifs1("Units", last, [["RegionCode", reg.code]])); sheet.setStyle(regRow, 3, totalNumStyle(F_UNITS));
    sheet.setFormula(regRow, 4, sumifs1("Stock", last, [["RegionCode", reg.code]])); sheet.setStyle(regRow, 4, totalNumStyle(F_UNITS));
    sheet.setValue(regRow, 5, 1); sheet.setStyle(regRow, 5, totalNumStyle(F_PCT));
    sheet.setFormula(regRow, 6, div0(`B${regRow}`, valTotal)); sheet.setStyle(regRow, 6, totalNumStyle(F_PCT));
    row += 1;
    const detailFirst = row;
    reg.products.forEach((p, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, { ...textCell(false, zebra), alignment: { vertical: "center", indent: 3 } });
      sheet.setFormula(row, 2, sumifs1("Value", last, [["RegionCode", reg.code], ["ProductCode", p.code]])); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
      sheet.setFormula(row, 3, sumifs1("Units", last, [["RegionCode", reg.code], ["ProductCode", p.code]])); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
      sheet.setFormula(row, 4, sumifs1("Stock", last, [["RegionCode", reg.code], ["ProductCode", p.code]])); sheet.setStyle(row, 4, numCell(F_UNITS, zebra));
      sheet.setFormula(row, 5, div0(`B${row}`, `B${regRow}`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
      sheet.setFormula(row, 6, div0(`B${row}`, valTotal)); sheet.setStyle(row, 6, numCell(F_PCT, zebra));
      groupRow(sheet, row, 1);
      row += 1;
    });
    if (row - 1 >= detailFirst) {
      try { sheet.addConditionalFormat({ sqref: `E${detailFirst}:E${row - 1}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
    }
  }
  const bodyLast = Math.max(firstBody, row - 1);
  sheet.setColumnWidth(1, 42); [2, 3, 4].forEach((c) => sheet.setColumnWidth(c, 18)); sheet.setColumnWidth(5, 13); sheet.setColumnWidth(6, 13);
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, title, generatedAt, ncols, bodyLast);
}

// ── Region × Product matrix (Value + Units, heat-mapped) ──────────────────────────────────────────
function buildMatrix(
  wb: Workbook,
  opts: { sheetName: string; title: string; subtitle: string; rowDimLabel: string; rowDims: { code: string; name: string }[]; colDims: { code: string; name: string }[]; rowCrit: "ProductCode"; colCrit: "RegionCode"; last: number; generatedAt: string },
) {
  const { sheetName, title, subtitle, rowDimLabel, rowDims, colDims, rowCrit, colCrit, last, generatedAt } = opts;
  const sheet = wb.addSheet(sheetName);
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 2 + colDims.length + 1; // # | name | cols... | Total
  bandHeader(sheet, ncols, title, subtitle);
  const totalCol = 3 + colDims.length;

  const writeMatrix = (startRow: number, measure: "Value" | "Units", fmt: string, label: string): number => {
    let r = startRow;
    if (startRow > 4) r = sectionTitle(sheet, startRow, ncols, label);
    const headerRow = r;
    sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
    sheet.setValue(headerRow, 2, rowDimLabel); sheet.setStyle(headerRow, 2, headerStyle);
    colDims.forEach((d, i) => { sheet.setValue(headerRow, 3 + i, d.name); sheet.setStyle(headerRow, 3 + i, headerRightStyle); });
    sheet.setValue(headerRow, totalCol, "Total"); sheet.setStyle(headerRow, totalCol, headerRightStyle);
    const firstRow = headerRow + 1;
    rowDims.forEach((p, i) => {
      const row = firstRow + i, zebra = i % 2 === 1;
      sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
      sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, textCell(false, zebra));
      colDims.forEach((d, j) => { sheet.setFormula(row, 3 + j, sumifs1(measure, last, [[rowCrit, p.code], [colCrit, d.code]])); sheet.setStyle(row, 3 + j, numCell(fmt, zebra)); });
      sheet.setFormula(row, totalCol, sumifs1(measure, last, [[rowCrit, p.code]])); sheet.setStyle(row, totalCol, numCell(fmt, zebra));
    });
    const lastRow = firstRow + rowDims.length - 1, totalRow = lastRow + 1;
    sheet.setStyle(totalRow, 1, totalStyle); sheet.setValue(totalRow, 2, "TOTAL"); sheet.setStyle(totalRow, 2, totalStyle);
    for (let c = 3; c <= totalCol; c += 1) { sheet.setFormula(totalRow, c, `SUM(${colLetter(c)}${firstRow}:${colLetter(c)}${lastRow})`); sheet.setStyle(totalRow, c, totalNumStyle(fmt)); }
    if (rowDims.length && colDims.length) {
      try {
        sheet.addConditionalFormat({
          sqref: `${colLetter(3)}${firstRow}:${colLetter(totalCol - 1)}${lastRow}`,
          type: "colorScale",
          colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] },
          priority: cfp(),
        });
      } catch { /* cosmetic */ }
    }
    return totalRow;
  };

  let lastRowUsed = writeMatrix(4, "Value", F_VALUE, "Sales Value (EGP)");
  lastRowUsed = writeMatrix(lastRowUsed + 2, "Units", F_UNITS, "Units Sold");

  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(2, 32);
  for (let c = 3; c <= totalCol; c += 1) sheet.setColumnWidth(c, 15);
  sheet.freeze(4, 2);
  applyPrintSetup(sheet, title, generatedAt, ncols, lastRowUsed);
}

// ── Region × Week trajectory (per-region header + product rows, weeks across) ─────────────────────
function buildRegionWeekTrajectory(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Region × Week (Trajectory)";
  const weeks = orderedWeeks(data, MAX_TRAJ_WEEKS);
  const sheet = wb.addSheet("Region x Week", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 2 + weeks.length + 1; // # | name | weeks... | Total
  bandHeader(sheet, ncols, title, weeks.length ? labelFilters(data.appliedFilters) : "No dated weeks available");
  const totalCol = 3 + weeks.length;
  const headerRow = 4;
  sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
  sheet.setValue(headerRow, 2, "Region / Product"); sheet.setStyle(headerRow, 2, headerStyle);
  weeks.forEach((w, i) => { sheet.setValue(headerRow, 3 + i, w.label); sheet.setStyle(headerRow, 3 + i, headerRightStyle); });
  sheet.setValue(headerRow, totalCol, "Total"); sheet.setStyle(headerRow, totalCol, headerRightStyle);

  let row = headerRow + 1;
  const firstBody = row;
  const heatFirstRow = row;
  for (const reg of tree) {
    const regRow = row;
    sheet.setValue(regRow, 1, ""); sheet.setStyle(regRow, 1, { fill: fill(SLATE_800) });
    sheet.setValue(regRow, 2, reg.name); sheet.setStyle(regRow, 2, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    weeks.forEach((w, j) => { sheet.setFormula(regRow, 3 + j, sumifs1("Value", last, [["RegionCode", reg.code], ["Month", w.month], ["Week", w.week]])); sheet.setStyle(regRow, 3 + j, totalNumStyle(F_VALUE)); });
    sheet.setFormula(regRow, totalCol, `SUM(${colLetter(3)}${regRow}:${colLetter(totalCol - 1)}${regRow})`); sheet.setStyle(regRow, totalCol, totalNumStyle(F_VALUE));
    row += 1;
    reg.products.forEach((p, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
      sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, { ...textCell(false, zebra), alignment: { vertical: "center", indent: 3 } });
      weeks.forEach((w, j) => { sheet.setFormula(row, 3 + j, sumifs1("Value", last, [["RegionCode", reg.code], ["ProductCode", p.code], ["Month", w.month], ["Week", w.week]])); sheet.setStyle(row, 3 + j, numCell(F_VALUE, zebra)); });
      sheet.setFormula(row, totalCol, `SUM(${colLetter(3)}${row}:${colLetter(totalCol - 1)}${row})`); sheet.setStyle(row, totalCol, numCell(F_VALUE, zebra));
      groupRow(sheet, row, 1);
      row += 1;
    });
  }
  const bodyLast = Math.max(firstBody, row - 1);
  if (weeks.length && tree.length) {
    try {
      sheet.addConditionalFormat({
        sqref: `${colLetter(3)}${heatFirstRow}:${colLetter(totalCol - 1)}${bodyLast}`,
        type: "colorScale",
        colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] },
        priority: cfp(),
      });
    } catch { /* cosmetic */ }
  }
  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(2, 34);
  for (let c = 3; c <= totalCol; c += 1) sheet.setColumnWidth(c, 14);
  sheet.freeze(headerRow, 2);
  applyPrintSetup(sheet, title, generatedAt, ncols, bodyLast);
}

// ── Zero-Sales Gap Map (Region × Product units; gaps highlighted red) ─────────────────────────────
function buildZeroSalesGapMap(wb: Workbook, data: WeeklyDashboard, products: { code: string; name: string }[], regions: { code: string; name: string }[], last: number, generatedAt: string) {
  const title = "Zero-Sales Gaps";
  const weeks = orderedWeeks(data, MAX_TRAJ_WEEKS);
  const sheet = wb.addSheet("Zero-Sales Gaps");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 2 + regions.length + 2; // # | product | regions... | Total | Weeks Covered
  bandHeader(sheet, ncols, title, "Red = no units sold in that region. Right-most column = weeks with sales (of the recent window).");
  const totalCol = 3 + regions.length;
  const weeksCol = totalCol + 1;
  const headerRow = 4;
  sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
  sheet.setValue(headerRow, 2, "Product"); sheet.setStyle(headerRow, 2, headerStyle);
  regions.forEach((d, i) => { sheet.setValue(headerRow, 3 + i, d.name); sheet.setStyle(headerRow, 3 + i, headerRightStyle); });
  sheet.setValue(headerRow, totalCol, "Total Units"); sheet.setStyle(headerRow, totalCol, headerRightStyle);
  sheet.setValue(headerRow, weeksCol, `Weeks w/ Sales (max ${Math.max(weeks.length, 0)})`); sheet.setStyle(headerRow, weeksCol, headerRightStyle);

  const firstRow = headerRow + 1;
  products.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, textCell(false, zebra));
    regions.forEach((d, j) => { sheet.setFormula(row, 3 + j, sumifs1("Units", last, [["ProductCode", p.code], ["RegionCode", d.code]])); sheet.setStyle(row, 3 + j, numCell(F_UNITS, zebra)); });
    sheet.setFormula(row, totalCol, sumifs1("Units", last, [["ProductCode", p.code]])); sheet.setStyle(row, totalCol, numCell(F_UNITS, zebra));
    // Weeks-with-sales = fixed-length sum of per-week (>0) booleans.
    const terms = weeks.map((w) => `(${sumifs1("Units", last, [["ProductCode", p.code], ["Month", w.month], ["Week", w.week]])}>0)`);
    sheet.setFormula(row, weeksCol, terms.length ? terms.join("+") : "0");
    sheet.setStyle(row, weeksCol, numCell(F_UNITS, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + products.length - 1);
  if (products.length && regions.length) {
    try {
      // Highest priority: hard-red the true zeros so gaps are unmissable.
      sheet.addConditionalFormat({ sqref: `${colLetter(3)}${firstRow}:${colLetter(totalCol - 1)}${lastRow}`, type: "cellIs", operator: "equal", formula: "0", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      // Then a white→amber→green scale for the non-zero magnitudes.
      sheet.addConditionalFormat({ sqref: `${colLetter(3)}${firstRow}:${colLetter(totalCol - 1)}${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "num", val: "0" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, GREEN] }, priority: cfp() });
      if (weeks.length) {
        sheet.addConditionalFormat({ sqref: `${colLetter(weeksCol)}${firstRow}:${colLetter(weeksCol)}${lastRow}`, type: "iconSet", iconSet: { type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", val: "0" }, { type: "percent", val: "33" }, { type: "percent", val: "67" }] }, priority: cfp() });
      }
    } catch { /* cosmetic */ }
  }
  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(2, 32);
  for (let c = 3; c <= totalCol; c += 1) sheet.setColumnWidth(c, 14);
  sheet.setColumnWidth(weeksCol, 20);
  sheet.setAutoFilter(`A${headerRow}:${colLetter(weeksCol)}${lastRow}`);
  sheet.freeze(headerRow, 2);
  applyPrintSetup(sheet, title, generatedAt, ncols, lastRow);
}

// ── Pareto (global) — sorted products + cumulative-% measure + REPT bar + data bar ────────────────
function buildPareto(wb: Workbook, data: WeeklyDashboard, last: number, generatedAt: string) {
  const prods = data.products; // ranked value-desc by the service
  const sheet = wb.addSheet("Pareto");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  bandHeader(sheet, 6, "Pareto Analysis (80/20)", "Products ranked by value with a running cumulative-% measure. The 'vital few' sit left of the 80% line.");
  const headerRow = 4;
  ["#", "Product", "Sales Value (EGP)", "Bar", "Cumulative", "Cumulative %"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 && i !== 3 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + prods.length - 1);
  prods.forEach((p, i) => {
    const rowN = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(rowN, 1, i + 1); sheet.setStyle(rowN, 1, numCell(F_UNITS, zebra));
    sheet.setValue(rowN, 2, cleanText(p.name)); sheet.setStyle(rowN, 2, textCell(false, zebra));
    sheet.setFormula(rowN, 3, sumifs1("Value", last, [["ProductCode", p.code]])); sheet.setStyle(rowN, 3, numCell(F_VALUE, zebra));
    sheet.setFormula(rowN, 4, `IFERROR(REPT("|",ROUND(C${rowN}/MAX($C$${firstRow}:$C$${firstRow + prods.length - 1})*16,0)),"")`); sheet.setStyle(rowN, 4, barCell(zebra));
    sheet.setFormula(rowN, 5, `SUM($C$${firstRow}:C${rowN})`); sheet.setStyle(rowN, 5, numCell(F_VALUE, zebra));
    sheet.setFormula(rowN, 6, `IFERROR(E${rowN}/SUM($C$${firstRow}:$C$${firstRow + prods.length - 1}),0)`); sheet.setStyle(rowN, 6, numCell(F_PCT, zebra));
  });
  if (prods.length) {
    try {
      sheet.addConditionalFormat({ sqref: `C${firstRow}:C${firstRow + prods.length - 1}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `F${firstRow}:F${firstRow + prods.length - 1}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: [GREEN, AMBER, RED] }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  [5, 34, 20, 22, 18, 14].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:F${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Pareto Analysis", generatedAt, 6, lastRow);
}

// ── Pareto per Region (80/20 within each region) ──────────────────────────────────────────────────
function buildRegionPareto(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Region Pareto (80/20 per region)";
  const sheet = wb.addSheet("Region Pareto", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6; // Region/Product | Value | Bar | Cumulative | Cumulative % | Flag
  bandHeader(sheet, ncols, title, "Each region's own 80/20 — the product crossing the 80% line is the region's tipping point.");
  const headerRow = 4;
  ["Region / Product", "Sales Value (EGP)", "Bar", "Cumulative", "Cumulative %", "80% Line"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 1 && i !== 2 ? headerRightStyle : headerStyle); });
  let row = headerRow + 1;
  const firstBody = row;
  for (const reg of tree) {
    const regRow = row;
    sheet.setValue(regRow, 1, reg.name); sheet.setStyle(regRow, 1, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    sheet.setFormula(regRow, 2, sumifs1("Value", last, [["RegionCode", reg.code]])); sheet.setStyle(regRow, 2, totalNumStyle(F_VALUE));
    for (let c = 3; c <= 6; c += 1) sheet.setStyle(regRow, c, { fill: fill(SLATE_800) });
    row += 1;
    const prodFirst = row;
    const prodLast = row + reg.products.length - 1;
    reg.products.forEach((p, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, { ...textCell(false, zebra), alignment: { vertical: "center", indent: 3 } });
      sheet.setFormula(row, 2, sumifs1("Value", last, [["RegionCode", reg.code], ["ProductCode", p.code]])); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
      sheet.setFormula(row, 3, `IFERROR(REPT("|",ROUND(B${row}/MAX($B$${prodFirst}:$B$${prodLast})*14,0)),"")`); sheet.setStyle(row, 3, barCell(zebra));
      sheet.setFormula(row, 4, `SUM($B$${prodFirst}:B${row})`); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
      sheet.setFormula(row, 5, div0(`D${row}`, `B${regRow}`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
      sheet.setFormula(row, 6, `IF(E${row}>=0.8,IF(${i === 0 ? "TRUE" : `E${row - 1}<0.8`},"◄ 80%",""),"")`); sheet.setStyle(row, 6, { font: { color: ORANGE_DEEP, bold: true, name: "Calibri", size: 10.5 }, alignment: { vertical: "center", indent: 1 } });
      groupRow(sheet, row, 1);
      row += 1;
    });
    if (prodLast >= prodFirst) {
      try {
        sheet.addConditionalFormat({ sqref: `B${prodFirst}:B${prodLast}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `E${prodFirst}:E${prodLast}`, type: "cellIs", operator: "greaterThanOrEqual", formula: "0.8", style: { fill: fill(AMBER) }, priority: cfp() });
      } catch { /* cosmetic */ }
    }
  }
  const bodyLast = Math.max(firstBody, row - 1);
  [42, 18, 18, 18, 14, 10].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, title, generatedAt, ncols, bodyLast);
}

// ── Growth Contribution (last two weeks; who drove the change) ────────────────────────────────────
function buildGrowthContribution(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Growth Contribution (WoW)";
  const sheet = wb.addSheet("Growth Contribution");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 7; // Region | Product | Prev | Curr | Δ | % of total Δ | Trend
  const weeks = orderedWeeks(data, MAX_TRAJ_WEEKS);
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const curr = weeks.length >= 1 ? weeks[weeks.length - 1] : null;
  const sub = prev && curr ? `${prev.label}  →  ${curr.label}` : "Need at least two dated weeks to compute growth";
  bandHeader(sheet, ncols, title, sub);
  const headerRow = 4;
  ["Region", "Product", `Prev (${prev?.label ?? "—"})`, `Curr (${curr?.label ?? "—"})`, "Δ (Curr − Prev)", "% of Total Δ", "Trend"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 && i !== 6 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  if (!prev || !curr) {
    sheet.setValue(firstRow, 1, "Growth needs two dated weeks in the selected window."); sheet.setStyle(firstRow, 1, textCell());
    [22, 30, 18, 18, 18, 14, 16].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    sheet.freeze(headerRow, 0);
    applyPrintSetup(sheet, title, generatedAt, ncols, firstRow);
    return;
  }
  const { pairs, truncated } = presentPairs(tree, MAX_RP_PAIRS);
  pairs.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, p.rn); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, p.pn); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setFormula(row, 3, sumifs1("Value", last, [["RegionCode", p.rc], ["ProductCode", p.pc], ["Month", prev.month], ["Week", prev.week]])); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 4, sumifs1("Value", last, [["RegionCode", p.rc], ["ProductCode", p.pc], ["Month", curr.month], ["Week", curr.week]])); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 5, `D${row}-C${row}`); sheet.setStyle(row, 5, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 7, `IF(E${row}>0,"▲ up",IF(E${row}<0,"▼ down","="))`); sheet.setStyle(row, 7, textCell(false, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + pairs.length - 1);
  // % of total Δ references the whole Δ column; written after lastRow is known.
  pairs.forEach((_, i) => { const row = firstRow + i; sheet.setFormula(row, 6, `IFERROR(E${row}/SUM($E$${firstRow}:$E$${lastRow}),0)`); sheet.setStyle(row, 6, numCell(F_PCT, i % 2 === 1)); });
  if (pairs.length) {
    try {
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "0", style: { font: { color: GREEN, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "cellIs", operator: "lessThan", formula: "0", style: { font: { color: RED, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: BLUE, showValue: true }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  truncationNote(sheet, lastRow + 2, truncated, "region×product pairs");
  [22, 30, 18, 18, 18, 14, 16].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:G${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, title, generatedAt, ncols, lastRow + (truncated ? 2 : 0));
}

// ── Sell-Through & Stock Coverage ─────────────────────────────────────────────────────────────────
function buildSellThroughCoverage(wb: Workbook, data: WeeklyDashboard, products: { code: string; name: string }[], tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Sell-Through & Stock Coverage";
  const sheet = wb.addSheet("Sell-Through & Cover");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6; // name | units | stock | sell-through | weeks-of-cover | health
  const weekCount = Math.max(1, orderedWeeks(data, MAX_TRAJ_WEEKS).length);
  bandHeader(sheet, ncols, title, `Sell-through = units / (units + stock). Weeks of cover = stock / (units / ${weekCount} weeks).`);
  const headerRow = 4;
  ["Product", "Units Sold", "Stock Units", "Sell-Through", "Weeks of Cover", "Health"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 1 && i !== 5 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  products.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setFormula(row, 2, sumifs1("Units", last, [["ProductCode", p.code]])); sheet.setStyle(row, 2, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 3, sumifs1("Stock", last, [["ProductCode", p.code]])); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 4, div0(`B${row}`, `B${row}+C${row}`)); sheet.setStyle(row, 4, numCell(F_PCT, zebra));
    sheet.setFormula(row, 5, `IFERROR(C${row}/(B${row}/${weekCount}),0)`); sheet.setStyle(row, 5, numCell(F_WK, zebra));
    sheet.setFormula(row, 6, `IF(D${row}>=0.67,"strong",IF(D${row}>=0.33,"ok","slow"))`); sheet.setStyle(row, 6, textCell(false, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + products.length - 1);
  if (products.length) {
    try {
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "iconSet", iconSet: { type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", val: "0" }, { type: "percent", val: "33" }, { type: "percent", val: "67" }] }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: BLUE, showValue: true }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  // Lower table: per region × product sell-through.
  let r2 = sectionTitle(sheet, lastRow + 2, ncols, "By Region × Product");
  const rpHeader = r2;
  ["Region / Product", "Units Sold", "Stock Units", "Sell-Through", "Weeks of Cover", "Health"].forEach((h, i) => { sheet.setValue(rpHeader, i + 1, h); sheet.setStyle(rpHeader, i + 1, i >= 1 && i !== 5 ? headerRightStyle : headerStyle); });
  r2 = rpHeader + 1;
  const { pairs, truncated } = presentPairs(tree, MAX_RP_PAIRS);
  pairs.forEach((p, i) => {
    const row = r2 + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, `${p.rn} — ${p.pn}`); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setFormula(row, 2, sumifs1("Units", last, [["RegionCode", p.rc], ["ProductCode", p.pc]])); sheet.setStyle(row, 2, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 3, sumifs1("Stock", last, [["RegionCode", p.rc], ["ProductCode", p.pc]])); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 4, div0(`B${row}`, `B${row}+C${row}`)); sheet.setStyle(row, 4, numCell(F_PCT, zebra));
    sheet.setFormula(row, 5, `IFERROR(C${row}/(B${row}/${weekCount}),0)`); sheet.setStyle(row, 5, numCell(F_WK, zebra));
    sheet.setFormula(row, 6, `IF(D${row}>=0.67,"strong",IF(D${row}>=0.33,"ok","slow"))`); sheet.setStyle(row, 6, textCell(false, zebra));
  });
  const rpLast = Math.max(r2, r2 + pairs.length - 1);
  if (pairs.length) {
    try { sheet.addConditionalFormat({ sqref: `D${r2}:D${rpLast}`, type: "iconSet", iconSet: { type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", val: "0" }, { type: "percent", val: "33" }, { type: "percent", val: "67" }] }, priority: cfp() }); } catch { /* cosmetic */ }
  }
  truncationNote(sheet, rpLast + 2, truncated, "region×product pairs");
  sheet.setColumnWidth(1, 40); [2, 3].forEach((c) => sheet.setColumnWidth(c, 15)); sheet.setColumnWidth(4, 14); sheet.setColumnWidth(5, 16); sheet.setColumnWidth(6, 12);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, title, generatedAt, ncols, rpLast + (truncated ? 2 : 0));
}

// ── Outlier Detection (z-score over region×product values) ────────────────────────────────────────
function buildOutlierDetection(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], last: number, generatedAt: string) {
  const title = "Outlier Detection (z-score)";
  const sheet = wb.addSheet("Outliers");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 5; // Region | Product | Value | z | Flag
  bandHeader(sheet, ncols, title, "z = (value − mean) / std-dev across every region×product cell. |z| > 2 is flagged.");
  const headerRow = 4;
  ["Region", "Product", "Sales Value (EGP)", "z-score", "Flag"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 && i !== 4 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  const { pairs, truncated } = presentPairs(tree, MAX_RP_PAIRS);
  pairs.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, p.rn); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, p.pn); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setFormula(row, 3, sumifs1("Value", last, [["RegionCode", p.rc], ["ProductCode", p.pc]])); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + pairs.length - 1);
  pairs.forEach((_, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setFormula(row, 4, `IFERROR((C${row}-AVERAGE($C$${firstRow}:$C$${lastRow}))/STDEV($C$${firstRow}:$C$${lastRow}),0)`); sheet.setStyle(row, 4, numCell(F_Z, zebra));
    sheet.setFormula(row, 5, `IF(ABS(D${row})>2,IF(D${row}>0,"high","low"),"")`); sheet.setStyle(row, 5, textCell(false, zebra));
  });
  if (pairs.length) {
    try {
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "2", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "lessThan", formula: "-2", style: { fill: fill(BLUE), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  truncationNote(sheet, lastRow + 2, truncated, "region×product pairs");
  [22, 32, 20, 12, 12].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:E${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, title, generatedAt, ncols, lastRow + (truncated ? 2 : 0));
}

// ── Branch-coverage hidden helper (distinct keys → formula flags) ─────────────────────────────────
type CoverageRefs = { aLast: number; fLast: number; truncated: number };
function buildCoverageHelper(wb: Workbook, rows: WeeklyFactExportRow[], last: number): CoverageRefs {
  const sheet = wb.addSheet("CoverageHelper", { state: "hidden" });
  sheet.writeRow(1, 1, ["regionCode", "productCode", "branchCode", "sold"]);
  const combos = new Map<string, { rc: string; pc: string; bc: string }>();
  for (const r of rows) {
    const rc = cleanText(r.regionCode), pc = cleanText(r.productCode), bc = cleanText(r.branchCode);
    const k = `${rc}||${pc}||${bc}`;
    if (!combos.has(k)) combos.set(k, { rc, pc, bc });
  }
  let comboList = [...combos.values()];
  let truncated = 0;
  if (comboList.length > MAX_COVERAGE_COMBOS) { truncated = comboList.length - MAX_COVERAGE_COMBOS; comboList = comboList.slice(0, MAX_COVERAGE_COMBOS); }
  comboList.forEach((c, i) => {
    const row = 2 + i;
    sheet.setValue(row, 1, c.rc); sheet.setValue(row, 2, c.pc); sheet.setValue(row, 3, c.bc);
    sheet.setFormula(row, 4, `IF(${sumifs1("Units", last, [["RegionCode", c.rc], ["ProductCode", c.pc], ["BranchCode", c.bc]])}>0,1,0)`);
  });
  const aLast = Math.max(2, 1 + comboList.length);
  // Region-branch universe (cols F,G,H).
  const rb = new Map<string, { rc: string; bc: string }>();
  for (const r of rows) { const rc = cleanText(r.regionCode), bc = cleanText(r.branchCode); const k = `${rc}||${bc}`; if (!rb.has(k)) rb.set(k, { rc, bc }); }
  const rbList = [...rb.values()];
  sheet.writeRow(1, 6, ["regionCode", "branchCode", "one"]);
  rbList.forEach((c, i) => { const row = 2 + i; sheet.setValue(row, 6, c.rc); sheet.setValue(row, 7, c.bc); sheet.setValue(row, 8, 1); });
  const fLast = Math.max(2, 1 + rbList.length);
  return { aLast, fLast, truncated };
}

// ── Branch Coverage Depth (branches selling each product, per region) ─────────────────────────────
function buildBranchCoverageDepth(wb: Workbook, data: WeeklyDashboard, tree: RegionNode[], cov: CoverageRefs, generatedAt: string) {
  const title = "Branch Coverage Depth";
  const sheet = wb.addSheet("Branch Coverage");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 5; // Region | Product | Branches Sold | Branches in Region | Coverage %
  bandHeader(sheet, ncols, title, "Of each region's branches, how many actually sold the product. Low coverage = a distribution gap, not a demand gap.");
  const headerRow = 4;
  ["Region", "Product", "Branches Sold", "Branches in Region", "Coverage %"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  const { pairs, truncated } = presentPairs(tree, MAX_RP_PAIRS);
  const aRange = `CoverageHelper!$A$2:$A$${cov.aLast}`;
  const bRange = `CoverageHelper!$B$2:$B$${cov.aLast}`;
  const dRange = `CoverageHelper!$D$2:$D$${cov.aLast}`;
  const fRange = `CoverageHelper!$F$2:$F$${cov.fLast}`;
  pairs.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, p.rn); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, p.pn); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setFormula(row, 3, `SUMIFS(${dRange},${aRange},"${esc(p.rc)}",${bRange},"${esc(p.pc)}")`); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 4, `COUNTIFS(${fRange},"${esc(p.rc)}")`); sheet.setStyle(row, 4, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 5, div0(`C${row}`, `D${row}`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + pairs.length - 1);
  if (pairs.length) {
    try {
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "iconSet", iconSet: { type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", val: "0" }, { type: "percent", val: "33" }, { type: "percent", val: "67" }] }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `E${firstRow}:E${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  truncationNote(sheet, lastRow + 2, truncated, "region×product pairs");
  [24, 32, 16, 18, 14].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:E${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, title, generatedAt, ncols, lastRow + (truncated ? 2 : 0));
}

// ── Line sub-dashboards (collapsible group per product line) ──────────────────────────────────────
function buildLineDashboards(wb: Workbook, data: WeeklyDashboard, lineTree: LineNode[], regions: { code: string; name: string }[], last: number, generatedAt: string) {
  const title = "By Line (sub-dashboards)";
  const sheet = wb.addSheet("By Line", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = Math.max(5, 2 + regions.length); // header band spans the wider of the two tables
  bandHeader(sheet, ncols, title, "Each product line's own performance — collapse a line to compare lines, expand to see its products.");
  const headerRow = 4;
  ["Line / Product", "Sales Value (EGP)", "Units Sold", "Stock Units", "Share of Line"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 1 && i !== 4 ? headerRightStyle : headerStyle); });
  let row = headerRow + 1;
  const firstBody = row;
  for (const line of lineTree) {
    const lineRow = row;
    sheet.setValue(lineRow, 1, line.label); sheet.setStyle(lineRow, 1, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    sheet.setFormula(lineRow, 2, sumifs1("Value", last, [["Line", line.key]])); sheet.setStyle(lineRow, 2, totalNumStyle(F_VALUE));
    sheet.setFormula(lineRow, 3, sumifs1("Units", last, [["Line", line.key]])); sheet.setStyle(lineRow, 3, totalNumStyle(F_UNITS));
    sheet.setFormula(lineRow, 4, sumifs1("Stock", last, [["Line", line.key]])); sheet.setStyle(lineRow, 4, totalNumStyle(F_UNITS));
    sheet.setValue(lineRow, 5, 1); sheet.setStyle(lineRow, 5, totalNumStyle(F_PCT));
    row += 1;
    const detailFirst = row;
    line.products.forEach((p) => {
      sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, { ...textCell(false, false), alignment: { vertical: "center", indent: 3 } });
      sheet.setFormula(row, 2, sumifs1("Value", last, [["Line", line.key], ["ProductCode", p.code]])); sheet.setStyle(row, 2, numCell(F_VALUE, false));
      sheet.setFormula(row, 3, sumifs1("Units", last, [["Line", line.key], ["ProductCode", p.code]])); sheet.setStyle(row, 3, numCell(F_UNITS, false));
      sheet.setFormula(row, 4, sumifs1("Stock", last, [["Line", line.key], ["ProductCode", p.code]])); sheet.setStyle(row, 4, numCell(F_UNITS, false));
      sheet.setFormula(row, 5, div0(`B${row}`, `B${lineRow}`)); sheet.setStyle(row, 5, numCell(F_PCT, false));
      row += 1;
    });
    if (row - 1 >= detailFirst) collapseBand(sheet, detailFirst, row - 1, 1);
  }
  const bodyLast = Math.max(firstBody, row - 1);
  // Lower: Line × Region matrix.
  const mCols = 2 + regions.length;
  let r2 = sectionTitle(sheet, bodyLast + 2, Math.max(ncols, mCols), "Line × Region (Value)");
  const mHeader = r2;
  sheet.setValue(mHeader, 1, "Line"); sheet.setStyle(mHeader, 1, headerStyle);
  regions.forEach((d, i) => { sheet.setValue(mHeader, 2 + i, d.name); sheet.setStyle(mHeader, 2 + i, headerRightStyle); });
  r2 = mHeader + 1;
  lineTree.forEach((line, i) => {
    const row = r2 + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, line.label); sheet.setStyle(row, 1, textCell(false, zebra));
    regions.forEach((d, j) => { sheet.setFormula(row, 2 + j, sumifs1("Value", last, [["Line", line.key], ["RegionCode", d.code]])); sheet.setStyle(row, 2 + j, numCell(F_VALUE, zebra)); });
  });
  const mLast = Math.max(r2, r2 + lineTree.length - 1);
  if (lineTree.length && regions.length) {
    try { sheet.addConditionalFormat({ sqref: `B${r2}:${colLetter(mCols)}${mLast}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] }, priority: cfp() }); } catch { /* cosmetic */ }
  }
  sheet.setColumnWidth(1, 40); [2, 3, 4].forEach((c) => sheet.setColumnWidth(c, 18)); sheet.setColumnWidth(5, 14);
  for (let c = 6; c <= mCols; c += 1) sheet.setColumnWidth(c, 16);
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, title, generatedAt, Math.max(ncols, mCols), mLast);
}

// ── Distributor x Product cross-tab (formula matrix + heat map) ───────────────────────────────────
function buildCrossTab(wb: Workbook, data: WeeklyDashboard, last: number, generatedAt: string) {
  const sheet = wb.addSheet("Distributor x Product");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const dists = data.distributorBreakdown.map((d) => ({ name: cleanText(d.name), code: d.code }));
  const prods = data.products.map((p) => ({ name: cleanText(p.name), code: p.code }));
  const ncols = 2 + dists.length + 1;
  bandHeader(sheet, ncols, "Distributor x Product", "Sales value (EGP) per product across distributors — live SUMIFS");
  const headerRow = 4;
  sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
  sheet.setValue(headerRow, 2, "Product"); sheet.setStyle(headerRow, 2, headerStyle);
  dists.forEach((d, i) => { sheet.setValue(headerRow, 3 + i, d.name); sheet.setStyle(headerRow, 3 + i, headerRightStyle); });
  const totalCol = 3 + dists.length;
  sheet.setValue(headerRow, totalCol, "Total"); sheet.setStyle(headerRow, totalCol, headerRightStyle);
  const firstRow = headerRow + 1;
  prods.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, textCell(false, zebra));
    dists.forEach((d, j) => { sheet.setFormula(row, 3 + j, sumifs1("Value", last, [["ProductCode", p.code], ["DistCode", d.code]])); sheet.setStyle(row, 3 + j, numCell(F_VALUE, zebra)); });
    sheet.setFormula(row, totalCol, sumifs1("Value", last, [["ProductCode", p.code]])); sheet.setStyle(row, totalCol, numCell(F_VALUE, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + prods.length - 1), totalRow = lastRow + 1;
  sheet.setStyle(totalRow, 1, totalStyle);
  sheet.setValue(totalRow, 2, "TOTAL"); sheet.setStyle(totalRow, 2, totalStyle);
  for (let c = 3; c <= totalCol; c += 1) { sheet.setFormula(totalRow, c, `SUM(${colLetter(c)}${firstRow}:${colLetter(c)}${lastRow})`); sheet.setStyle(totalRow, c, totalNumStyle(F_VALUE)); }
  if (prods.length && dists.length) {
    try {
      sheet.addConditionalFormat({
        sqref: `${colLetter(3)}${firstRow}:${colLetter(totalCol - 1)}${lastRow}`,
        type: "colorScale",
        colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] },
        priority: cfp(),
      });
    } catch { /* cosmetic */ }
  }
  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(2, 32);
  for (let c = 3; c <= totalCol; c += 1) sheet.setColumnWidth(c, 16);
  sheet.setAutoFilter(`A${headerRow}:${colLetter(totalCol)}${lastRow}`);
  sheet.freeze(headerRow, 2);
  applyPrintSetup(sheet, "Distributor x Product", generatedAt, ncols, totalRow);
}

// ── Week-by-week comparison (formulas + WoW conditional formatting + REPT trend) ──────────────────
function buildWeekComparison(wb: Workbook, data: WeeklyDashboard, generatedAt: string) {
  if (!data.weekComparison?.length) return;
  const sheet = wb.addSheet("Week Comparison");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  bandHeader(sheet, 8, "Week-by-Week Comparison", "Real per-week sales (de-cumulated). Stock = week snapshot. WoW colour-coded.");
  const headerRow = 4;
  ["Month", "Week", "Sheet Date", "Sales Value (EGP)", "Units Sold", "Stock Units", "WoW %", "Trend"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 3 && i <= 6 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  const lastRow = firstRow + data.weekComparison.length - 1;
  data.weekComparison.forEach((w, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, (w.cycleMonth ?? "").slice(0, 7)); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, `W${w.weekNumber}`); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setValue(row, 3, w.weekStart ?? "—"); sheet.setStyle(row, 3, textCell(false, zebra));
    sheet.setValue(row, 4, w.salesValue); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
    sheet.setValue(row, 5, w.salesUnits); sheet.setStyle(row, 5, numCell(F_UNITS, zebra));
    sheet.setValue(row, 6, w.stockUnits); sheet.setStyle(row, 6, numCell(F_UNITS, zebra));
    sheet.setValue(row, 7, w.deltaValuePct ?? 0); sheet.setStyle(row, 7, numCell(F_PCT, zebra));
    sheet.setFormula(row, 8, `IFERROR(REPT("|",ROUND(D${row}/MAX($D$${firstRow}:$D$${lastRow})*16,0)),"")`); sheet.setStyle(row, 8, barCell(zebra));
  });
  try {
    sheet.addConditionalFormat({ sqref: `G${firstRow}:G${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: [RED, AMBER, GREEN] }, priority: cfp() });
    sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
  } catch { /* cosmetic */ }
  [12, 8, 14, 19, 14, 14, 11, 22].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:H${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Week-by-Week Comparison", generatedAt, 8, lastRow);
}

// ── Waterfall (emulated): cumulative weekly build-up via a stacked column ──────────────────────────
function buildWaterfall(wb: Workbook, data: WeeklyDashboard, generatedAt: string) {
  const trend = [...(data.trend ?? [])].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  if (trend.length < 2) return;
  const sheet = wb.addSheet("Waterfall");
  sheet.view = { showGridLines: false };
  bandHeader(sheet, 6, "Sales Waterfall", "How each week builds to the cumulative total (emulated: invisible base + step columns).");
  const headerRow = 4;
  ["Week", "Base", "Weekly Step", "Running Total"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle); });
  const firstRow = headerRow + 1;
  let running = 0;
  trend.forEach((t, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    const label = t.weekNumber != null && t.cycleMonth ? `W${t.weekNumber} ${t.cycleMonth.slice(0, 7)}` : t.weekStart;
    const base = running; running += t.salesValue;
    sheet.setValue(row, 1, label); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, Number(base.toFixed(2))); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
    sheet.setValue(row, 3, Number(t.salesValue.toFixed(2))); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
    sheet.setValue(row, 4, Number(running.toFixed(2))); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
  });
  const lastRow = firstRow + trend.length - 1;
  [18, 16, 16, 16].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try {
    sheet.addChart({
      type: "columnStacked",
      title: "Weekly build-up to total",
      series: [
        { name: "Base", values: `Waterfall!$B$${firstRow}:$B$${lastRow}`, categories: `Waterfall!$A$${firstRow}:$A$${lastRow}`, color: "FFFFFFFF" },
        { name: "Weekly", values: `Waterfall!$C$${firstRow}:$C$${lastRow}`, categories: `Waterfall!$A$${firstRow}:$A$${lastRow}`, color: ORANGE },
      ],
      from: { col: 5, row: 3 }, to: { col: 14, row: 24 },
      legend: false, chartFill: "white", roundedCorners: true,
    });
  } catch { /* chart is best-effort */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Sales Waterfall", generatedAt, 6, lastRow);
}

// ── Native PivotTable (interactive cross-tab) ─────────────────────────────────────────────────────
function buildPivot(wb: Workbook, last: number) {
  const sheet = wb.addSheet("Pivot - Dist x Product");
  sheet.view = { showGridLines: false };
  bandHeader(sheet, 8, "Pivot — Distributor x Product", "Native pivot: drag fields, filter, expand. Source: the Data table.");
  try {
    sheet.addPivotTable({
      name: "pvtDistProduct", sourceSheet: "Data", sourceRef: `A1:${colLetter(DATA_NCOLS)}${last}`,
      targetCell: "A5", rowFields: ["Product"], colFields: ["Distributor"],
      dataFields: [{ field: "Value", func: "sum", name: "Sales Value" }],
      rowGrandTotals: true, colGrandTotals: true,
    });
  } catch { /* pivot authoring is best-effort polish */ }
}

// ── Report sources ────────────────────────────────────────────────────────────────
function buildSources(wb: Workbook, data: WeeklyDashboard, generatedAt: string) {
  const sheet = wb.addSheet("Report Sources");
  sheet.view = { showGridLines: false };
  bandHeader(sheet, 6, "Report Sources", "The validated weekly sheets this report was built from");
  const headerRow = 4;
  ["Distributor", "Cycle Month", "Week", "Sheet Date", "File", "Status"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, headerStyle); });
  const firstRow = headerRow + 1;
  data.sources.forEach((s, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    [cleanText(s.distributorName || s.distributorCode), (s.cycleMonth ?? "").slice(0, 7) || "—", s.weekNumber ? `W${s.weekNumber}` : "—", s.weekStart ?? "—", cleanText(s.fileName) || "—", "validated"]
      .forEach((v, c) => { sheet.setValue(row, c + 1, v); sheet.setStyle(row, c + 1, textCell(false, zebra)); });
  });
  if (!data.sources.length) { sheet.setValue(firstRow, 1, "No source sheets matched the current filters."); sheet.setStyle(firstRow, 1, textCell()); }
  const lastRow = Math.max(firstRow, firstRow + data.sources.length - 1);
  [24, 14, 8, 16, 44, 12].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:F${lastRow}`);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Report Sources", generatedAt, 6, lastRow);
}

// ── Dashboard cover: KPI formula tiles + executive narrative + charts + Contents ──────────────────
function buildDashboard(
  wb: Workbook, dash: Worksheet, data: WeeklyDashboard, generatedAt: string, last: number,
  ranges: { region: ReturnType<typeof buildBreakdownSheet>; product: ReturnType<typeof buildBreakdownSheet>; distributor: ReturnType<typeof buildBreakdownSheet> },
  contentsSheets: { name: string; desc: string }[],
) {
  dash.view = { showGridLines: false };
  bandHeader(dash, 12, `${systemIdentity.appName} — Weekly Sales BI`, `${labelFilters(data.appliedFilters)}      ·      Generated ${generatedAt}`);

  const valRange = dataRange("Value", last);
  const unitRange = dataRange("Units", last);
  const stockRange = dataRange("Stock", last);
  const tiles: { label: string; formula?: string; value?: number; fmt: string }[] = [
    { label: "SALES VALUE (EGP)", formula: `SUM(${valRange})`, fmt: F_VALUE },
    { label: "NET UNITS SOLD", formula: `SUM(${unitRange})`, fmt: F_UNITS },
    { label: "STOCK ON HAND", formula: `SUM(${stockRange})`, fmt: F_UNITS },
    { label: "PRODUCTS", value: data.kpis.productCount, fmt: F_UNITS },
    { label: "BRANCHES", value: data.kpis.branchCount, fmt: F_UNITS },
    { label: "DISTRIBUTORS", value: data.kpis.distributorCount, fmt: F_UNITS },
  ];
  tiles.forEach((t, i) => {
    const c = 1 + i * 2;
    dash.merge(5, c, 5, c + 1); dash.setValue(5, c, t.label);
    dash.setStyle(5, c, { font: { bold: true, size: 9, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } });
    dash.setStyle(5, c + 1, { fill: fill(SLATE_900) });
    dash.merge(6, c, 6, c + 1);
    if (t.formula) dash.setFormula(6, c, t.formula); else dash.setValue(6, c, t.value ?? 0);
    dash.setStyle(6, c, { font: { bold: true, size: 17, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 }, numberFormat: { formatCode: t.fmt } });
    dash.setStyle(6, c + 1, { fill: fill(SLATE_900) });
    dash.setStyle(7, c, { fill: fill(ORANGE) }); dash.setStyle(7, c + 1, { fill: fill(ORANGE) });
  });
  dash.setRowHeight(5, 16); dash.setRowHeight(6, 30); dash.setRowHeight(7, 3);

  // Executive narrative — formula-driven so it tracks the data. Segmented to stay short.
  const topRegionName = `'By Region'!$B$5`, topRegionShare = `'By Region'!$F$5`;
  const topProductName = `'By Product'!$B$5`, topProductShare = `'By Product'!$F$5`;
  const narrative =
    `"This report covers "&TEXT(SUM(${valRange}),"#,##0")&" EGP of sales across "&` +
    `TEXT(${data.kpis.distributorCount},"#,##0")&" distributors, "&TEXT(${data.kpis.regionCount},"#,##0")&" regions and "&` +
    `TEXT(${data.kpis.productCount},"#,##0")&" products.  Top region: "&${topRegionName}&" ("&TEXT(${topRegionShare},"0.0%")&` +
    `").  Top product: "&${topProductName}&" ("&TEXT(${topProductShare},"0.0%")&")."`;
  dash.merge(9, 1, 10, 12);
  try { dash.setFormula(9, 1, `IFERROR(${narrative},"Summary unavailable for the current filters.")`); }
  catch { dash.setValue(9, 1, "Weekly Sales BI report."); }
  dash.setStyle(9, 1, { font: { size: 11, color: INK, name: "Calibri" }, alignment: { vertical: "center", horizontal: "left", indent: 1, wrapText: true }, fill: fill("FFFFF7ED") });
  dash.setRowHeight(9, 18); dash.setRowHeight(10, 18);

  // Native charts bound to the formula breakdown sheets.
  const q = (name: string) => `'${name}'`;
  const topN = (r: ReturnType<typeof buildBreakdownSheet>, n: number) => Math.min(n, Math.max(1, r.lastRow - r.firstRow + 1));
  const seriesFor = (r: ReturnType<typeof buildBreakdownSheet>, count: number) => ({
    values: `${q(r.sheetName)}!$${colLetter(r.valueCol)}$${r.firstRow}:$${colLetter(r.valueCol)}$${r.firstRow + count - 1}`,
    categories: `${q(r.sheetName)}!$${colLetter(r.nameCol)}$${r.firstRow}:$${colLetter(r.nameCol)}$${r.firstRow + count - 1}`,
  });
  const labels = { showValue: true as const, numFmt: "#,##0" };
  try { dash.addChart({ type: "bar", title: "Top Products by Value", series: [{ name: "Value", color: ORANGE, ...seriesFor(ranges.product, topN(ranges.product, 12)) }], from: { col: 0, row: 11 }, to: { col: 5, row: 29 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "orange", dataLabels: labels }); } catch { /* chart best-effort */ }
  try { dash.addChart({ type: "column", title: "Value by Region", series: [{ name: "Value", color: ORANGE_DEEP, ...seriesFor(ranges.region, topN(ranges.region, 12)) }], from: { col: 6, row: 11 }, to: { col: 11, row: 29 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "orange", dataLabels: labels }); } catch { /* chart best-effort */ }
  try { dash.addChart({ type: "column", title: "Value by Distributor", series: [{ name: "Value", color: BLUE, ...seriesFor(ranges.distributor, topN(ranges.distributor, 12)) }], from: { col: 0, row: 30 }, to: { col: 5, row: 48 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "blueWarm", dataLabels: labels }); } catch { /* chart best-effort */ }

  // Weekly trend line — helper series on the hidden Data sheet (far columns).
  if (data.trend?.length) {
    const dataSheet = wb.getSheet("Data");
    if (dataSheet) {
      const sorted = [...data.trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      const lblCol = DATA_NCOLS + 2, valCol = DATA_NCOLS + 3; // Q, R on the hidden sheet
      sorted.forEach((t, i) => {
        dataSheet.setValue(2 + i, lblCol, t.weekNumber != null && t.cycleMonth ? `W${t.weekNumber} ${t.cycleMonth.slice(0, 7)}` : t.weekStart);
        dataSheet.setValue(2 + i, valCol, t.salesValue);
      });
      try {
        dash.addChart({
          type: "line", title: "Weekly Value Trend",
          series: [{ name: "Value", color: ORANGE, values: `Data!$${colLetter(valCol)}$2:$${colLetter(valCol)}$${1 + sorted.length}`, categories: `Data!$${colLetter(lblCol)}$2:$${colLetter(lblCol)}$${1 + sorted.length}` }],
          from: { col: 6, row: 30 }, to: { col: 11, row: 48 }, legend: false, roundedCorners: true, chartFill: "white", dataLabels: labels,
        });
      } catch { /* chart best-effort */ }
    }
  }

  // Contents panel — clickable HYPERLINK() index of every sheet.
  const cStart = 50;
  dash.merge(cStart, 1, cStart, 12); dash.setValue(cStart, 1, "CONTENTS");
  dash.setStyle(cStart, 1, { font: { bold: true, size: 12, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } });
  for (let c = 2; c <= 12; c += 1) dash.setStyle(cStart, c, { fill: fill(SLATE_900) });
  contentsSheets.forEach((s, i) => {
    const row = cStart + 1 + i;
    try { dash.setFormula(row, 1, `HYPERLINK("#'${s.name.replace(/'/g, "''")}'!A1","${esc(s.name)}")`); }
    catch { dash.setValue(row, 1, s.name); }
    dash.setStyle(row, 1, { font: { color: BLUE, underline: "single", name: "Calibri", size: 10.5, bold: true }, alignment: { vertical: "center", indent: 1 } });
    dash.merge(row, 2, row, 12); dash.setValue(row, 2, s.desc);
    dash.setStyle(row, 2, { font: { color: INK, size: 10, name: "Calibri" }, alignment: { vertical: "center", indent: 1 } });
  });

  for (let c = 1; c <= 12; c += 1) dash.setColumnWidth(c, 12);
  dash.setColumnWidth(1, 26);
  applyPrintSetup(dash, "Weekly Sales BI — Dashboard", generatedAt, 12, cStart + contentsSheets.length + 1);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function buildWeeklyExportWorkbook(
  data: WeeklyDashboard,
  generatedAt: string,
  opts?: { interactive?: boolean },
): Promise<Buffer> {
  // interactive=false drops the native PivotTable (the only feature beyond charts /
  // formulas / conditional-formatting), leaving a guaranteed-clean workbook. Default on.
  const interactive = opts?.interactive !== false;
  const wb = new Workbook();
  wb.calcSettings = { calcMode: "auto", fullCalcOnLoad: true };

  const dash = wb.addSheet("Dashboard"); // created first (leftmost), populated last
  const rows = data.factRows ?? [];
  const last = buildDataSheet(wb, rows);
  const cov = buildCoverageHelper(wb, rows, last);

  // JS-side layout scaffolds (values stay formulas).
  const tree = buildRegionTree(rows);
  const lineTree = buildLineTree(rows);
  const regionsForCols = data.regions.map((r) => ({ code: r.code, name: cleanText(r.name) }));
  const productsAll = data.products.map((p) => ({ code: p.code, name: cleanText(p.name) }));
  const productsCapped = productsAll.slice(0, MAX_MATRIX_PRODUCTS);

  const sub = labelFilters(data.appliedFilters);
  const region = buildBreakdownSheet(wb, { sheetName: "By Region", title: "By Region", subtitle: sub, dimLabel: "Region", critCol: "RegionCode", last, dims: data.regions.map((r) => ({ name: cleanText(r.name), code: r.code })), generatedAt });
  const product = buildBreakdownSheet(wb, { sheetName: "By Product", title: "By Product", subtitle: sub, dimLabel: "Product", critCol: "ProductCode", last, dims: data.products.map((p) => ({ name: cleanText(p.name), code: p.code })), generatedAt });
  const distributor = buildBreakdownSheet(wb, { sheetName: "By Distributor", title: "By Distributor", subtitle: sub, dimLabel: "Distributor", critCol: "DistCode", last, dims: data.distributorBreakdown.map((d) => ({ name: cleanText(d.name), code: d.code })), generatedAt });
  buildBreakdownSheet(wb, { sheetName: "By Branch", title: "By Branch", subtitle: sub, dimLabel: "Branch", extraLabel: "Region", critCol: "BranchCode", last, dims: data.branchBreakdown.map((b) => ({ name: cleanText(b.name), code: b.code, extra: cleanText(b.regionName) })), generatedAt });

  buildRegionProductDrill(wb, data, tree, last, generatedAt);
  buildLineDashboards(wb, data, lineTree, regionsForCols, last, generatedAt);
  buildMatrix(wb, { sheetName: "Region x Product", title: "Region × Product", subtitle: sub, rowDimLabel: "Product", rowDims: productsCapped, colDims: regionsForCols, rowCrit: "ProductCode", colCrit: "RegionCode", last, generatedAt });
  buildRegionWeekTrajectory(wb, data, tree, last, generatedAt);
  buildZeroSalesGapMap(wb, data, productsCapped, regionsForCols, last, generatedAt);
  buildCrossTab(wb, data, last, generatedAt);
  buildPareto(wb, data, last, generatedAt);
  buildRegionPareto(wb, data, tree, last, generatedAt);
  buildGrowthContribution(wb, data, tree, last, generatedAt);
  buildSellThroughCoverage(wb, data, productsAll, tree, last, generatedAt);
  buildOutlierDetection(wb, data, tree, last, generatedAt);
  buildBranchCoverageDepth(wb, data, tree, cov, generatedAt);
  buildWaterfall(wb, data, generatedAt);
  buildWeekComparison(wb, data, generatedAt);
  if (interactive) buildPivot(wb, last);
  buildSources(wb, data, generatedAt);

  // Contents index (only sheets that were actually added).
  const contents: { name: string; desc: string }[] = [
    { name: "By Region", desc: "Regional totals with share." },
    { name: "Region Drill", desc: "Each region broken down by product (collapsible)." },
    { name: "By Product", desc: "Product totals with share." },
    { name: "By Distributor", desc: "Distributor totals with share." },
    { name: "By Branch", desc: "Branch totals with their region." },
    { name: "By Line", desc: "Per product-line sub-dashboards + line × region." },
    { name: "Region x Product", desc: "Value & units matrix, heat-mapped." },
    { name: "Region x Week", desc: "Per-region product trajectory across weeks." },
    { name: "Zero-Sales Gaps", desc: "Where a product sold nothing in a region." },
    { name: "Distributor x Product", desc: "Value per product across distributors." },
    { name: "Pareto", desc: "Company-wide 80/20 product ranking." },
    { name: "Region Pareto", desc: "Each region's own 80/20." },
    { name: "Growth Contribution", desc: "What drove the latest week-over-week change." },
    { name: "Sell-Through & Cover", desc: "Inventory health per product / region." },
    { name: "Outliers", desc: "Statistically unusual region×product cells." },
    { name: "Branch Coverage", desc: "How many branches sell each product per region." },
    { name: "Waterfall", desc: "Cumulative weekly build-up." },
    { name: "Week Comparison", desc: "De-cumulated per-week totals + WoW." },
    ...(interactive ? [{ name: "Pivot - Dist x Product", desc: "Native pivot — drag, filter, expand." }] : []),
    { name: "Report Sources", desc: "Validated source sheets behind this report." },
  ];

  buildDashboard(wb, dash, data, generatedAt, last, { region, product, distributor }, contents);
  wb.setActiveSheet("Dashboard");

  const b64 = await wb.buildBase64();
  return Buffer.from(b64, "base64");
}
