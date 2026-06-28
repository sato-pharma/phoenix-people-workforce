import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import {
  BLACK,
  MUTED,
  PCT_FMT,
  SLATE,
  UNITS_FMT,
  VALUE_FMT,
  WHITE,
  ZEBRA,
  applyDataBar,
  bandHeader,
  gridBorder,
  writeTable,
} from "@/lib/sales/sales-workbook-kit";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

// ── helpers ───────────────────────────────────────────────────────────────────

const egp = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });

function labelFilters(filters: WeeklyDashboard["appliedFilters"]): string {
  const parts: string[] = [];
  if (filters.allWeeks) {
    parts.push("Period: All time");
  } else if (filters.weekStarts.length > 1) {
    parts.push(`Periods: ${filters.weekStarts.join(", ")}`);
  } else if (filters.weekStart) {
    parts.push(`Week of: ${filters.weekStart}`);
  }
  if (filters.cycleMonths?.length) parts.push(`Months: ${filters.cycleMonths.map((m) => m.slice(0, 7)).join(", ")}`);
  if (filters.weekNumbers?.length) parts.push(`Weeks: ${filters.weekNumbers.map((w) => `W${w}`).join(", ")}`);
  if (filters.distributorCode) parts.push(`Distributor: ${filters.distributorCode}`);
  if (filters.regionCode) parts.push(`Region: ${filters.regionCode}`);
  if (filters.productCode) parts.push(`Product: ${filters.productCode}`);
  if (filters.lineCode) parts.push(`Line: ${filters.lineCode}`);
  return parts.length ? parts.join("  ·  ") : "No filters applied";
}

function kpiCell(
  sheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  label: string,
  value: string,
  sub?: string,
) {
  const labelCell = sheet.getCell(row, col);
  labelCell.value = label;
  labelCell.font = { color: { argb: MUTED }, name: "Calibri", size: 9, bold: true };
  labelCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  labelCell.fill = { fgColor: { argb: "FF1E293B" }, pattern: "solid", type: "pattern" };

  const valCell = sheet.getCell(row + 1, col);
  valCell.value = value;
  valCell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 14 };
  valCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  valCell.fill = { fgColor: { argb: "FF1E293B" }, pattern: "solid", type: "pattern" };

  if (sub !== undefined) {
    const subCell = sheet.getCell(row + 2, col);
    subCell.value = sub;
    subCell.font = { color: { argb: sub.startsWith("+") ? "FF22C55E" : sub.startsWith("-") ? "FFEF4444" : MUTED }, name: "Calibri", size: 9 };
    subCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    subCell.fill = { fgColor: { argb: "FF1E293B" }, pattern: "solid", type: "pattern" };
  }
}

function formatDelta(current: number, pct: number | null): string {
  if (pct === null) return "vs prior: —";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(1)}% vs prior week`;
}

// ── Sheet builders ────────────────────────────────────────────────────────────

function buildSummarySheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard, generatedAt: string) {
  const COLS = 6;
  const sheet = workbook.addWorksheet("Executive Summary", {
    views: [{ showGridLines: false }],
  });

  // Brand header (rows 1-3)
  const filterLabel = labelFilters(data.appliedFilters);
  bandHeader(sheet, COLS, "Weekly Sales Report", filterLabel);

  // Generated-at row (row 4 sits under the premium header divider)
  sheet.mergeCells(4, 1, 4, COLS);
  const genCell = sheet.getCell(4, 1);
  genCell.value = `Generated: ${generatedAt}`;
  genCell.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  genCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  genCell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  sheet.getRow(4).height = 14;

  // Blank separator
  sheet.getRow(5).height = 8;

  // ── KPI tiles (rows 6-8) ──
  const kpiTileRow = 6;
  const kpis = data.kpis;
  const compare = data.compare;

  // Merge each KPI into a 3-row × 1-column tile
  const kpiDefs: [string, string, string][] = [
    [
      "SALES VALUE (EGP)",
      `EGP ${egp(kpis.salesValue)}`,
      formatDelta(compare.salesValue.current, compare.salesValue.pct),
    ],
    [
      "NET UNITS SOLD",
      egp(kpis.salesUnits),
      formatDelta(compare.salesUnits.current, compare.salesUnits.pct),
    ],
    [
      "STOCK ON HAND",
      egp(kpis.stockUnits),
      formatDelta(compare.stockUnits.current, compare.stockUnits.pct),
    ],
    ["BRANCHES ACTIVE", String(kpis.branchCount), `${kpis.regionCount} region${kpis.regionCount !== 1 ? "s" : ""}`],
    ["PRODUCTS TRACKED", String(kpis.productCount), `${kpis.distributorCount} distributor${kpis.distributorCount !== 1 ? "s" : ""}`],
  ];

  for (let col = 1; col <= Math.min(kpiDefs.length, COLS - 1); col += 1) {
    const [label, value, sub] = kpiDefs[col - 1];
    kpiCell(sheet, kpiTileRow, col, label, value, sub);
    sheet.getRow(kpiTileRow).height = 14;
    sheet.getRow(kpiTileRow + 1).height = 24;
    sheet.getRow(kpiTileRow + 2).height = 14;
  }

  // Blank separator before tables
  sheet.getRow(10).height = 10;

  // ── Top Regions summary ──
  let cursor = 11;
  cursor = writeTable(sheet, cursor, {
    title: "Top Regions",
    columns: [
      { label: "Region", width: 22 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 20, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.regions.map((r) => [r.name, r.salesValue, r.salesUnits, r.stockUnits, r.share]),
    totals: [
      "TOTAL",
      data.regions.reduce((s, r) => s + r.salesValue, 0),
      data.regions.reduce((s, r) => s + r.salesUnits, 0),
      data.regions.reduce((s, r) => s + r.stockUnits, 0),
      1,
    ],
  });

  cursor += 1;

  // ── Top Distributors ──
  writeTable(sheet, cursor, {
    title: "By Distributor",
    columns: [
      { label: "Distributor", width: 22 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 20, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.distributorBreakdown.map((d) => [d.name, d.salesValue, d.salesUnits, d.stockUnits, d.share]),
    totals: [
      "TOTAL",
      data.distributorBreakdown.reduce((s, d) => s + d.salesValue, 0),
      data.distributorBreakdown.reduce((s, d) => s + d.salesUnits, 0),
      data.distributorBreakdown.reduce((s, d) => s + d.stockUnits, 0),
      1,
    ],
  });

  for (let col = 1; col <= COLS; col += 1) {
    if (!sheet.getColumn(col).width || (sheet.getColumn(col).width ?? 0) < 12) {
      sheet.getColumn(col).width = 16;
    }
  }
}

function buildRegionsSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  const sheet = workbook.addWorksheet("By Region", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 5, "By Region", labelFilters(data.appliedFilters));

  writeTable(sheet, 4, {
    title: "Region Breakdown",
    columns: [
      { label: "#", width: 5 },
      { label: "Region", width: 26 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 22, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.regions.map((r, i) => [i + 1, r.name, r.salesValue, r.salesUnits, r.stockUnits, r.share]),
    totals: [
      "",
      "TOTAL",
      data.regions.reduce((s, r) => s + r.salesValue, 0),
      data.regions.reduce((s, r) => s + r.salesUnits, 0),
      data.regions.reduce((s, r) => s + r.stockUnits, 0),
      1,
    ],
  });
}

function buildProductsSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  const sheet = workbook.addWorksheet("By Product", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 6, "By Product", labelFilters(data.appliedFilters));

  writeTable(sheet, 4, {
    title: "Product Breakdown",
    columns: [
      { label: "#", width: 5 },
      { label: "Product", width: 30 },
      { label: "Code", width: 14 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 22, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.products.map((p, i) => [i + 1, p.name, p.code, p.salesValue, p.salesUnits, p.stockUnits, p.share]),
    totals: [
      "",
      "TOTAL",
      "",
      data.products.reduce((s, p) => s + p.salesValue, 0),
      data.products.reduce((s, p) => s + p.salesUnits, 0),
      data.products.reduce((s, p) => s + p.stockUnits, 0),
      1,
    ],
  });
}

function buildBranchesSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  const sheet = workbook.addWorksheet("By Branch", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 6, "By Branch", labelFilters(data.appliedFilters));

  writeTable(sheet, 4, {
    title: "Branch Breakdown",
    columns: [
      { label: "#", width: 5 },
      { label: "Branch", width: 26 },
      { label: "Region", width: 20 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 22, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.branchBreakdown.map((b, i) => [i + 1, b.name, b.regionName, b.salesValue, b.salesUnits, b.stockUnits, b.share]),
    totals: [
      "",
      "TOTAL",
      "",
      data.branchBreakdown.reduce((s, b) => s + b.salesValue, 0),
      data.branchBreakdown.reduce((s, b) => s + b.salesUnits, 0),
      data.branchBreakdown.reduce((s, b) => s + b.stockUnits, 0),
      1,
    ],
  });
}

function buildDistributorsSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  const sheet = workbook.addWorksheet("By Distributor", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 5, "By Distributor", labelFilters(data.appliedFilters));

  writeTable(sheet, 4, {
    title: "Distributor Breakdown",
    columns: [
      { label: "#", width: 5 },
      { label: "Distributor", width: 24 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 22, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.distributorBreakdown.map((d, i) => [i + 1, d.name, d.salesValue, d.salesUnits, d.stockUnits, d.share]),
    totals: [
      "",
      "TOTAL",
      data.distributorBreakdown.reduce((s, d) => s + d.salesValue, 0),
      data.distributorBreakdown.reduce((s, d) => s + d.salesUnits, 0),
      data.distributorBreakdown.reduce((s, d) => s + d.stockUnits, 0),
      1,
    ],
  });
}

function buildTrendSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  if (!data.trend?.length) return;

  const distributorCodes = Array.from(
    new Set(data.trend.flatMap((t) => t.byDistributor.map((d) => d.distributorCode))),
  );
  const distributorNames = new Map<string, string>();
  for (const week of data.trend) {
    for (const d of week.byDistributor) distributorNames.set(d.distributorCode, d.distributorName);
  }

  const sheet = workbook.addWorksheet("Trend", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  const totalCols = 4 + distributorCodes.length;
  bandHeader(sheet, totalCols, "Weekly Trend", labelFilters(data.appliedFilters));

  const headers = [
    "Week Start",
    "Sales Value (EGP)",
    "Units Sold",
    "Stock Units",
    ...distributorCodes.map((code) => `${distributorNames.get(code) ?? code} Value`),
  ];

  const headerRow = sheet.getRow(4);
  headers.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: i === 0 ? "left" : "right", indent: i === 0 ? 1 : 0, vertical: "middle" };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    sheet.getColumn(i + 1).width = i === 0 ? 14 : 22;
  });
  headerRow.height = 18;

  const sortedWeeks = [...data.trend].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  sortedWeeks.forEach((week, rowIndex) => {
    const excelRow = sheet.getRow(5 + rowIndex);
    const distMap = new Map<string, number>(week.byDistributor.map((d) => [d.distributorCode, d.salesValue]));
    const cells = [
      week.weekStart,
      week.salesValue,
      week.salesUnits,
      week.stockUnits,
      ...distributorCodes.map((code) => distMap.get(code) ?? 0),
    ];
    cells.forEach((value, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.value = value;
      if (i > 0) cell.numFmt = VALUE_FMT;
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: i === 0 ? "left" : "right", indent: i === 0 ? 1 : 0, vertical: "middle" };
      cell.border = gridBorder();
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
    });
  });

  // Data bars on the total value column
  const lastDataRow = 4 + sortedWeeks.length;
  if (sortedWeeks.length > 0) {
    applyDataBar(sheet, `B5:B${lastDataRow}`);
  }
}

function buildZeroSalesSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  if (!data.zeroSalesBranches?.length) return;

  const sheet = workbook.addWorksheet("Zero Sales Watch", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 4, "Zero-Sales Watchlist", "Branches with stock on hand but zero sales this period");

  writeTable(sheet, 4, {
    title: "Branches: Stock On Hand, No Sales",
    columns: [
      { label: "Branch", width: 26 },
      { label: "Region", width: 20 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 16, dataBar: true },
    ],
    rows: data.zeroSalesBranches.map((b) => [b.branchName, b.regionName, b.stockUnits]),
    totals: [
      "TOTAL",
      "",
      data.zeroSalesBranches.reduce((s, b) => s + b.stockUnits, 0),
    ],
    note: "These branches reported inventory but no sales movement. Investigate for fulfillment or data issues.",
  });
}

function buildSourcesSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  const sheet = workbook.addWorksheet("Report Sources", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 6, "Report Sources", "The validated weekly sheets this report was built from");

  writeTable(sheet, 4, {
    title: "Source Sheets",
    columns: [
      { label: "Distributor", width: 24 },
      { label: "Cycle Month", width: 14 },
      { label: "Week", width: 8 },
      { label: "Sheet Date", width: 16 },
      { label: "File", width: 40 },
      { label: "Status", width: 12 },
    ],
    rows: data.sources.map((s) => [
      s.distributorName || s.distributorCode,
      (s.cycleMonth ?? "").slice(0, 7) || "—",
      s.weekNumber ? `W${s.weekNumber}` : "—",
      s.weekStart ?? "—",
      s.fileName || "—",
      "validated",
    ]),
    note: data.sources.length === 0 ? "No source sheets matched the current filters." : undefined,
  });
}

function buildWeekComparisonSheet(workbook: ExcelJS.Workbook, data: WeeklyDashboard) {
  if (!data.weekComparison?.length) return;
  const sheet = workbook.addWorksheet("Week Comparison", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  bandHeader(sheet, 7, "Week-by-Week Comparison", "Real per-week sales (de-cumulated). Stock is the week's snapshot.");

  writeTable(sheet, 4, {
    title: "Real Sales Per Week",
    columns: [
      { label: "Month", width: 12 },
      { label: "Week", width: 8 },
      { label: "Sheet Date", width: 16 },
      { label: "Sales Value (EGP)", numFmt: VALUE_FMT, right: true, width: 22, dataBar: true },
      { label: "Units Sold", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 14 },
      { label: "WoW", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    rows: data.weekComparison.map((w) => [
      (w.cycleMonth ?? "").slice(0, 7),
      `W${w.weekNumber}`,
      w.weekStart ?? "—",
      w.salesValue,
      w.salesUnits,
      w.stockUnits,
      w.deltaValuePct ?? 0,
    ]),
    note: "Each week = its cumulative sheet minus the previous week of the same month (W2−W1, W3−W2, …).",
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function buildWeeklyExportWorkbook(
  data: WeeklyDashboard,
  generatedAt: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  buildSummarySheet(workbook, data, generatedAt);
  buildSourcesSheet(workbook, data);
  buildWeekComparisonSheet(workbook, data);
  buildRegionsSheet(workbook, data);
  buildProductsSheet(workbook, data);
  buildBranchesSheet(workbook, data);
  buildDistributorsSheet(workbook, data);
  buildTrendSheet(workbook, data);
  buildZeroSalesSheet(workbook, data);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
