import { Workbook, type Worksheet } from "@node-projects/excelforge";

import { systemIdentity } from "@/config/system-settings";
import type { WeeklyDashboard, WeeklyFactExportRow } from "@/lib/sales/weekly/types";

// ──────────────────────────────────────────────────────────────────────────────
// Weekly Sales — interactive BI workbook (ExcelForge engine).
//
// One hidden `Data` Excel Table is the single source of truth. Every visible number is an Excel
// FORMULA over that table (SUMIFS / SUM / share) — never a baked-in value — so editing the data
// recalculates the whole report. On top of the data: a bold branded Dashboard cover (KPI formulas +
// native charts), native PivotTables, table slicers, a Distributor×Product cross-tab, formula-driven
// breakdown sheets (AutoFilter on each), a week comparison with conditional formatting + a sparkline,
// and a Report Sources sheet.
//
// Feature set is restricted to what the Phase-0 spike proved opens cleanly in Excel (charts, pivots,
// TABLE slicers, conditional formatting, sparklines, tables, formulas). Sheet names are ASCII only.
// ──────────────────────────────────────────────────────────────────────────────

// ── premium palette / formats ───────────────────────────────────────────────────
const ORANGE = "FFF97316";
const ORANGE_DEEP = "FFEA580C";
const BLUE = "FF2563EB";
const SLATE_900 = "FF0F172A";
const SLATE_800 = "FF1E293B";
const WHITE = "FFFFFFFF";
const INK = "FF1E293B";
const ZEBRA = "FFFDF3EA"; // warm light-orange band (premium, not washed out)
const GRIDC = "FFF6C9A4"; // light-orange gridlines (admin-shell language)
const GREEN = "FF16A34A";
const AMBER = "FFF59E0B";
const RED = "FFDC2626";

const F_VALUE = "#,##0";
const F_UNITS = "#,##0";
const F_PCT = "0.0%";

// ── Data sheet column map (1-based index → letter) ──────────────────────────────
const DATA = {
  Distributor: 1, DistCode: 2, Product: 3, ProductCode: 4, Line: 5,
  Region: 6, RegionCode: 7, Branch: 8, BranchCode: 9, Month: 10,
  Week: 11, WeekStart: 12, Value: 13, Units: 14, Stock: 15,
} as const;
const DATA_HEADERS = Object.keys(DATA);
const DATA_NCOLS = DATA_HEADERS.length;

function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s;
}
const L = (key: keyof typeof DATA) => colLetter(DATA[key]);
const esc = (s: unknown) => String(s ?? "").replace(/"/g, '""');

// ── style helpers ────────────────────────────────────────────────────────────────
type CS = Parameters<Worksheet["setStyle"]>[2];
const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: argb });
const border = () => { const s = { style: "thin" as const, color: GRIDC }; return { top: s, bottom: s, left: s, right: s }; };

const titleStyle: CS = { font: { bold: true, size: 18, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
const subtitleStyle: CS = { font: { size: 10, color: ORANGE, name: "Calibri", bold: true }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
const headerStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", horizontal: "left", indent: 1 }, border: border() };
const headerRightStyle: CS = { ...headerStyle, alignment: { vertical: "center", horizontal: "right", indent: 1 } };
const totalStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", indent: 1 } };
const totalNumStyle = (fmt: string): CS => ({ font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt } });

function textCell(bold = false, zebra = false): CS {
  return { font: { color: INK, size: 10.5, bold, name: "Calibri" }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}
function numCell(fmt: string, zebra = false): CS {
  return { font: { color: INK, size: 10.5, name: "Calibri" }, alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}

/** Slate-900 brand band: row1 bold title, row2 orange subtitle, row3 thick orange rule. */
function bandHeader(sheet: Worksheet, cols: number, title: string, subtitle: string) {
  sheet.merge(1, 1, 1, cols); sheet.setValue(1, 1, title); sheet.setStyle(1, 1, titleStyle); sheet.setRowHeight(1, 30);
  for (let c = 1; c <= cols; c += 1) if (c > 1) sheet.setStyle(1, c, { fill: fill(SLATE_900) });
  sheet.merge(2, 1, 2, cols); sheet.setValue(2, 1, subtitle); sheet.setStyle(2, 1, subtitleStyle); sheet.setRowHeight(2, 16);
  for (let c = 1; c <= cols; c += 1) if (c > 1) sheet.setStyle(2, c, { fill: fill(SLATE_900) });
  for (let c = 1; c <= cols; c += 1) sheet.setStyle(3, c, { fill: fill(ORANGE) });
  sheet.setRowHeight(3, 4);
}

function labelFilters(f: WeeklyDashboard["appliedFilters"]): string {
  const parts: string[] = [];
  if (f.cycleMonths?.length) parts.push(`Months: ${f.cycleMonths.map((m) => m.slice(0, 7)).join(", ")}`);
  if (f.weekNumbers?.length) parts.push(`Weeks: ${f.weekNumbers.map((w) => `W${w}`).join(", ")}`);
  if (f.distributorCodes?.length) parts.push(`Distributors: ${f.distributorCodes.join(", ")}`);
  if (f.regionCodes?.length) parts.push(`Regions: ${f.regionCodes.join(", ")}`);
  if (f.productCodes?.length) parts.push(`Products: ${f.productCodes.join(", ")}`);
  if (f.lineCodes?.length) parts.push(`Lines: ${f.lineCodes.join(", ")}`);
  return parts.length ? parts.join("   ·   ") : "All distributors · all weeks";
}

// ── hidden Data Excel Table (single source for every formula / pivot / chart) ─────────────────────
function buildDataSheet(wb: Workbook, rows: WeeklyFactExportRow[]): number {
  const sheet = wb.addSheet("Data", { state: "hidden" });
  sheet.writeRow(1, 1, DATA_HEADERS);
  const matrix = rows.map((r) => [
    r.distributorName || r.distributorCode, r.distributorCode,
    r.productName || r.productCode, r.productCode, r.line,
    r.regionName || r.regionCode, r.regionCode,
    r.branchName || r.branchCode, r.branchCode,
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
  opts: { sheetName: string; title: string; subtitle: string; dimLabel: string; extraLabel?: string; critCol: keyof typeof DATA; last: number; dims: BreakdownDim[] },
): { sheetName: string; firstRow: number; lastRow: number; nameCol: number; valueCol: number } {
  const { sheetName, title, subtitle, dimLabel, extraLabel, critCol, last, dims } = opts;
  const sheet = wb.addSheet(sheetName);
  sheet.view = { showGridLines: false };
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
  const valRange = `Data!$${L("Value")}$2:$${L("Value")}$${last}`;
  const unitRange = `Data!$${L("Units")}$2:$${L("Units")}$${last}`;
  const stockRange = `Data!$${L("Stock")}$2:$${L("Stock")}$${last}`;
  const critRange = `Data!$${L(critCol)}$2:$${L(critCol)}$${last}`;

  dims.forEach((d, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, cName, d.name); sheet.setStyle(row, cName, textCell(false, zebra));
    if (hasExtra) { sheet.setValue(row, cExtra, d.extra ?? ""); sheet.setStyle(row, cExtra, textCell(false, zebra)); }
    const crit = `,${critRange},"${esc(d.code)}"`;
    sheet.setFormula(row, cValue, `SUMIFS(${valRange}${crit})`); sheet.setStyle(row, cValue, numCell(F_VALUE, zebra));
    sheet.setFormula(row, cUnits, `SUMIFS(${unitRange}${crit})`); sheet.setStyle(row, cUnits, numCell(F_UNITS, zebra));
    sheet.setFormula(row, cStock, `SUMIFS(${stockRange}${crit})`); sheet.setStyle(row, cStock, numCell(F_UNITS, zebra));
    sheet.setFormula(row, cShare, `IFERROR(${colLetter(cValue)}${row}/SUM(${valRange}),0)`); sheet.setStyle(row, cShare, numCell(F_PCT, zebra));
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
  // Orange data bar on the value column for an at-a-glance ranking.
  sheet.addConditionalFormat({ sqref: `${colLetter(cValue)}${firstRow}:${colLetter(cValue)}${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true } });
  sheet.freeze(headerRow, 0);
  return { sheetName, firstRow, lastRow, nameCol: cName, valueCol: cValue };
}

// ── Distributor x Product cross-tab (formula matrix) ──────────────────────────────────────────────
function buildCrossTab(wb: Workbook, data: WeeklyDashboard, last: number) {
  const sheet = wb.addSheet("Distributor x Product");
  sheet.view = { showGridLines: false };
  const dists = data.distributorBreakdown.map((d) => ({ name: d.name, code: d.code }));
  const prods = data.products.map((p) => ({ name: p.name, code: p.code }));
  const ncols = 2 + dists.length + 1;
  bandHeader(sheet, ncols, "Distributor x Product", "Sales value (EGP) per product across distributors — live SUMIFS");

  const headerRow = 4;
  sheet.setValue(headerRow, 1, "#"); sheet.setStyle(headerRow, 1, headerStyle);
  sheet.setValue(headerRow, 2, "Product"); sheet.setStyle(headerRow, 2, headerStyle);
  dists.forEach((d, i) => { sheet.setValue(headerRow, 3 + i, d.name); sheet.setStyle(headerRow, 3 + i, headerRightStyle); });
  const totalCol = 3 + dists.length;
  sheet.setValue(headerRow, totalCol, "Total"); sheet.setStyle(headerRow, totalCol, headerRightStyle);

  const valRange = `Data!$${L("Value")}$2:$${L("Value")}$${last}`;
  const prodRange = `Data!$${L("ProductCode")}$2:$${L("ProductCode")}$${last}`;
  const distRange = `Data!$${L("DistCode")}$2:$${L("DistCode")}$${last}`;
  const firstRow = headerRow + 1;
  prods.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, textCell(false, zebra));
    dists.forEach((d, j) => { sheet.setFormula(row, 3 + j, `SUMIFS(${valRange},${prodRange},"${esc(p.code)}",${distRange},"${esc(d.code)}")`); sheet.setStyle(row, 3 + j, numCell(F_VALUE, zebra)); });
    sheet.setFormula(row, totalCol, `SUMIFS(${valRange},${prodRange},"${esc(p.code)}")`); sheet.setStyle(row, totalCol, numCell(F_VALUE, zebra));
  });
  const lastRow = firstRow + prods.length - 1, totalRow = lastRow + 1;
  sheet.setStyle(totalRow, 1, totalStyle);
  sheet.setValue(totalRow, 2, "TOTAL"); sheet.setStyle(totalRow, 2, totalStyle);
  for (let c = 3; c <= totalCol; c += 1) { sheet.setFormula(totalRow, c, `SUM(${colLetter(c)}${firstRow}:${colLetter(c)}${lastRow})`); sheet.setStyle(totalRow, c, totalNumStyle(F_VALUE)); }
  // HEAT MAP: 3-colour scale across the distributor×product matrix (white = low → deep orange = high).
  if (prods.length && dists.length) {
    sheet.addConditionalFormat({
      sqref: `${colLetter(3)}${firstRow}:${colLetter(totalCol - 1)}${lastRow}`,
      type: "colorScale",
      colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] },
    });
  }
  sheet.setColumnWidth(1, 5); sheet.setColumnWidth(2, 32);
  for (let c = 3; c <= totalCol; c += 1) sheet.setColumnWidth(c, 16);
  sheet.setAutoFilter(`A${headerRow}:${colLetter(totalCol)}${lastRow}`);
  sheet.freeze(headerRow, 2);
}

// ── Week-by-week comparison (formulas + WoW conditional formatting + trend sparkline) ─────────────
function buildWeekComparison(wb: Workbook, data: WeeklyDashboard) {
  if (!data.weekComparison?.length) return;
  const sheet = wb.addSheet("Week Comparison");
  sheet.view = { showGridLines: false };
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
    // In-cell sparkline (REPT bar) — a formula-drawn mini bar of this week's value vs the max week.
    sheet.setFormula(row, 8, `IFERROR(REPT("|",ROUND(D${row}/MAX($D$${firstRow}:$D$${lastRow})*16,0)),"")`);
    sheet.setStyle(row, 8, { font: { name: "Calibri", size: 10.5, color: ORANGE, bold: true }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) });
  });
  sheet.addConditionalFormat({ sqref: `G${firstRow}:G${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: [RED, AMBER, GREEN] } });
  sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true } });
  [12, 8, 14, 19, 14, 14, 11, 22].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:H${lastRow}`);
  sheet.freeze(headerRow, 0);
}

// ── Pareto analysis (sorted products + cumulative % "measure" + REPT sparkline + data bar) ────────
function buildPareto(wb: Workbook, data: WeeklyDashboard, last: number) {
  const prods = data.products; // already ranked value-desc by the service
  if (!prods.length) return;
  const sheet = wb.addSheet("Pareto");
  sheet.view = { showGridLines: false };
  bandHeader(sheet, 6, "Pareto Analysis (80/20)", "Products ranked by value with a running cumulative-% measure. The 'vital few' sit left of the 80% line.");
  const headerRow = 4;
  ["#", "Product", "Sales Value (EGP)", "Bar", "Cumulative", "Cumulative %"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 && i !== 3 ? headerRightStyle : headerStyle); });
  const firstRow = headerRow + 1;
  const lastRow = firstRow + prods.length - 1;
  const valRange = `Data!$${L("Value")}$2:$${L("Value")}$${last}`;
  const prodRange = `Data!$${L("ProductCode")}$2:$${L("ProductCode")}$${last}`;
  prods.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, p.name); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setFormula(row, 3, `SUMIFS(${valRange},${prodRange},"${esc(p.code)}")`); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 4, `IFERROR(REPT("|",ROUND(C${row}/MAX($C$${firstRow}:$C$${lastRow})*16,0)),"")`);
    sheet.setStyle(row, 4, { font: { name: "Calibri", size: 10.5, color: ORANGE, bold: true }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) });
    sheet.setFormula(row, 5, `SUM($C$${firstRow}:C${row})`); sheet.setStyle(row, 5, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 6, `IFERROR(E${row}/SUM($C$${firstRow}:$C$${lastRow}),0)`); sheet.setStyle(row, 6, numCell(F_PCT, zebra));
  });
  sheet.addConditionalFormat({ sqref: `C${firstRow}:C${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true } });
  // Heat the cumulative-% column: green (early/vital few) → red (long tail).
  sheet.addConditionalFormat({ sqref: `F${firstRow}:F${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: [GREEN, AMBER, RED] } });
  [5, 34, 20, 22, 18, 14].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:F${lastRow}`);
  sheet.freeze(headerRow, 0);
}

// ── Waterfall (emulated): cumulative weekly build-up via a stacked column (invisible base + step) ──
function buildWaterfall(wb: Workbook, data: WeeklyDashboard) {
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
  // Stacked column: Base series is white (invisible on the white chart) so only the orange step shows,
  // each starting where the previous ended — the classic waterfall look.
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
  } catch {
    // chart is best-effort; the Base/Step/Running table above still conveys the waterfall.
  }
  sheet.freeze(headerRow, 0);
}

// ── Native PivotTable (interactive cross-tab; Excel's own filter buttons + field list) ────────────
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
  } catch {
    // pivot authoring is best-effort polish — never fail the whole export over it.
  }
}

// ── Report sources ────────────────────────────────────────────────────────────────
function buildSources(wb: Workbook, data: WeeklyDashboard) {
  const sheet = wb.addSheet("Report Sources");
  sheet.view = { showGridLines: false };
  bandHeader(sheet, 6, "Report Sources", "The validated weekly sheets this report was built from");
  const headerRow = 4;
  ["Distributor", "Cycle Month", "Week", "Sheet Date", "File", "Status"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, headerStyle); });
  const firstRow = headerRow + 1;
  data.sources.forEach((s, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    [s.distributorName || s.distributorCode, (s.cycleMonth ?? "").slice(0, 7) || "—", s.weekNumber ? `W${s.weekNumber}` : "—", s.weekStart ?? "—", s.fileName || "—", "validated"]
      .forEach((v, c) => { sheet.setValue(row, c + 1, v); sheet.setStyle(row, c + 1, textCell(false, zebra)); });
  });
  if (!data.sources.length) { sheet.setValue(firstRow, 1, "No source sheets matched the current filters."); sheet.setStyle(firstRow, 1, textCell()); }
  [24, 14, 8, 16, 44, 12].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setAutoFilter(`A${headerRow}:F${Math.max(firstRow, firstRow + data.sources.length - 1)}`);
  sheet.freeze(headerRow, 0);
}

// ── Dashboard cover: KPI formula tiles + native charts + table slicers (built last, lives first) ──
function buildDashboard(
  wb: Workbook, dash: Worksheet, data: WeeklyDashboard, generatedAt: string, last: number,
  ranges: { region: ReturnType<typeof buildBreakdownSheet>; product: ReturnType<typeof buildBreakdownSheet>; distributor: ReturnType<typeof buildBreakdownSheet> },
  interactive: boolean,
) {
  dash.view = { showGridLines: false };
  bandHeader(dash, 12, `${systemIdentity.appName} — Weekly Sales BI`, `${labelFilters(data.appliedFilters)}      ·      Generated ${generatedAt}`);

  const valRange = `Data!$${L("Value")}$2:$${L("Value")}$${last}`;
  const unitRange = `Data!$${L("Units")}$2:$${L("Units")}$${last}`;
  const stockRange = `Data!$${L("Stock")}$2:$${L("Stock")}$${last}`;
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

  // Native charts bound to the formula breakdown sheets (reflect the current export selection).
  const q = (name: string) => `'${name}'`;
  const topN = (r: ReturnType<typeof buildBreakdownSheet>, n: number) => Math.min(n, Math.max(1, r.lastRow - r.firstRow + 1));
  const seriesFor = (r: ReturnType<typeof buildBreakdownSheet>, count: number) => ({
    values: `${q(r.sheetName)}!$${colLetter(r.valueCol)}$${r.firstRow}:$${colLetter(r.valueCol)}$${r.firstRow + count - 1}`,
    categories: `${q(r.sheetName)}!$${colLetter(r.nameCol)}$${r.firstRow}:$${colLetter(r.nameCol)}$${r.firstRow + count - 1}`,
  });
  const labels = { showValue: true as const, numFmt: "#,##0" };
  dash.addChart({ type: "bar", title: "Top Products by Value", series: [{ name: "Value", color: ORANGE, ...seriesFor(ranges.product, topN(ranges.product, 12)) }], from: { col: 0, row: 8 }, to: { col: 5, row: 26 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "orange", dataLabels: labels });
  dash.addChart({ type: "column", title: "Value by Region", series: [{ name: "Value", color: ORANGE_DEEP, ...seriesFor(ranges.region, topN(ranges.region, 12)) }], from: { col: 6, row: 8 }, to: { col: 11, row: 26 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "orange", dataLabels: labels });
  dash.addChart({ type: "column", title: "Value by Distributor", series: [{ name: "Value", color: BLUE, ...seriesFor(ranges.distributor, topN(ranges.distributor, 12)) }], from: { col: 0, row: 27 }, to: { col: 5, row: 45 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "blueWarm", dataLabels: labels });

  // Weekly trend line — helper series written onto the hidden Data sheet (far columns) so the cover stays clean.
  if (data.trend?.length) {
    const dataSheet = wb.getSheet("Data");
    if (dataSheet) {
      const sorted = [...data.trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      const lblCol = DATA_NCOLS + 2, valCol = DATA_NCOLS + 3; // Q, R on the hidden sheet
      sorted.forEach((t, i) => {
        dataSheet.setValue(2 + i, lblCol, t.weekNumber != null && t.cycleMonth ? `W${t.weekNumber} ${t.cycleMonth.slice(0, 7)}` : t.weekStart);
        dataSheet.setValue(2 + i, valCol, t.salesValue);
      });
      dash.addChart({
        type: "line", title: "Weekly Value Trend",
        series: [{ name: "Value", color: ORANGE, values: `Data!$${colLetter(valCol)}$2:$${colLetter(valCol)}$${1 + sorted.length}`, categories: `Data!$${colLetter(lblCol)}$2:$${colLetter(lblCol)}$${1 + sorted.length}` }],
        from: { col: 6, row: 27 }, to: { col: 11, row: 45 }, legend: false, roundedCorners: true, chartFill: "white", dataLabels: labels,
      });
    }
  }

  // Table slicers (spike-proven) filtering the Data table — placed below the charts.
  if (interactive) {
    const slicerRow = 47;
    for (const [i, col] of (["Month", "Distributor", "Line", "Region"] as const).entries()) {
      try {
        dash.addTableSlicer({ name: `slicer_${col}`, tableName: "tblWeekly", columnName: col, caption: col, cell: `${colLetter(1 + i * 3)}${slicerRow}`, columnCount: 1 });
      } catch {
        // slicer authoring is best-effort polish — never fail the whole export over it.
      }
    }
  }
  for (let c = 1; c <= 12; c += 1) dash.setColumnWidth(c, 12);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function buildWeeklyExportWorkbook(
  data: WeeklyDashboard,
  generatedAt: string,
  opts?: { interactive?: boolean },
): Promise<Buffer> {
  // interactive=false drops the native PivotTable + slicers (the only features beyond plain
  // charts/formulas/CF), leaving a guaranteed-clean charts+formulas workbook. Default on.
  const interactive = opts?.interactive !== false;
  const wb = new Workbook();
  wb.calcSettings = { calcMode: "auto", fullCalcOnLoad: true };

  const dash = wb.addSheet("Dashboard"); // created first (leftmost), populated last
  const last = buildDataSheet(wb, data.factRows ?? []);

  const sub = labelFilters(data.appliedFilters);
  const region = buildBreakdownSheet(wb, { sheetName: "By Region", title: "By Region", subtitle: sub, dimLabel: "Region", critCol: "RegionCode", last, dims: data.regions.map((r) => ({ name: r.name, code: r.code })) });
  const product = buildBreakdownSheet(wb, { sheetName: "By Product", title: "By Product", subtitle: sub, dimLabel: "Product", critCol: "ProductCode", last, dims: data.products.map((p) => ({ name: p.name, code: p.code })) });
  const distributor = buildBreakdownSheet(wb, { sheetName: "By Distributor", title: "By Distributor", subtitle: sub, dimLabel: "Distributor", critCol: "DistCode", last, dims: data.distributorBreakdown.map((d) => ({ name: d.name, code: d.code })) });
  buildBreakdownSheet(wb, { sheetName: "By Branch", title: "By Branch", subtitle: sub, dimLabel: "Branch", extraLabel: "Region", critCol: "BranchCode", last, dims: data.branchBreakdown.map((b) => ({ name: b.name, code: b.code, extra: b.regionName })) });

  buildCrossTab(wb, data, last);
  buildPareto(wb, data, last);
  buildWaterfall(wb, data);
  buildWeekComparison(wb, data);
  if (interactive) buildPivot(wb, last);
  buildSources(wb, data);

  buildDashboard(wb, dash, data, generatedAt, last, { region, product, distributor }, interactive);
  wb.setActiveSheet("Dashboard");

  const b64 = await wb.buildBase64();
  return Buffer.from(b64, "base64");
}
