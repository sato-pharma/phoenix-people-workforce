// Weekly Stock — XLSX export. Ships BESIDE the password-locked weekly designs (export-design.pins.json)
// and wears the HOUSE identity (SATO-DIS-2026-01 v1.0) on every tab, like the portal weekly export.
//
// It exports exactly what the screen shows for the same filters: the rows come from the same
// loadWeeklyStockDashboard call, so the viewer's scope travels with them.
//
// THE TOTAL ROW. addPhoenixTableSheet appends ONE TOTAL row that SUMs every `numeric` column. So a column
// is numeric here only when its sum means something: stock value, average weekly sales value, and the Low
// Stock, Overstock and No Sales counts, which count product-at-depot rows and so add up to the screen's
// tiles. Units and average weekly units are never summed (units of different products are never added —
// owner rule), nor is weeks of cover (a ratio), nor the Products and Depots counts (one product or depot
// recurs across rows). Those are plain columns, right-aligned after the sheet is built. There is no
// hand-written total row on top of it: the SUM would include it and count the money twice.

import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import {
  WEEKLY_STOCK_COVER_LOW_WEEKS,
  WEEKLY_STOCK_COVER_OVER_WEEKS,
  WEEKLY_STOCK_SALES_WINDOW_WEEKS,
  WEEKLY_STOCK_STATUS_LABELS,
  type WeeklyStockGroupRow,
  type WeeklyStockView,
} from "@/lib/sales/weekly/stock-dashboard";

export function formatWeeklyStockDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const cover = (value: number | null) => (value == null ? "—" : value);

type SheetColumn = ExportColumn & {
  /** a number that must never be summed: kept out of the TOTAL row, right-aligned after the sheet is built */
  plainNumber?: boolean;
};

const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;
// Exactly what addPhoenixTableSheet gives a numeric column on the house theme, so a plain number looks
// the same as before and only the SUM under it is gone.
const RIGHT_HEADER = { vertical: "middle", horizontal: "right", wrapText: true } as const;
const RIGHT_CELL = { vertical: "middle", horizontal: "right", wrapText: false } as const;

function addSheet(
  workbook: ExcelJS.Workbook,
  input: { title: string; subtitle: string; sheetName: string; columns: SheetColumn[]; rows: ExportRow[] },
) {
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: input.title,
    subtitle: input.subtitle,
    sheetName: input.sheetName,
    columns: input.columns.map(({ plainNumber, ...column }) => (plainNumber ? { ...column, numeric: false } : column)),
    rows: input.rows,
  });
  const sheet = workbook.getWorksheet(input.sheetName);
  if (!sheet) return;
  input.columns.forEach((column, index) => {
    if (!column.plainNumber) return;
    sheet.getRow(HEADER_ROW).getCell(index + 1).alignment = RIGHT_HEADER;
    for (let row = FIRST_DATA_ROW; row < FIRST_DATA_ROW + input.rows.length; row += 1) {
      sheet.getRow(row).getCell(index + 1).alignment = RIGHT_CELL;
    }
  });
}

function groupRow(group: WeeklyStockGroupRow, withParent: boolean): ExportRow {
  return {
    ...(withParent ? { parent: group.parentName } : {}),
    name: group.name,
    stockValue: group.stockValue,
    avgWeeklyValue: group.avgWeeklyValue,
    coverWeeks: cover(group.coverWeeks),
    status: WEEKLY_STOCK_STATUS_LABELS[group.status],
    productCount: group.productCount,
    outOfStockCount: group.outOfStockCount,
    lowCount: group.lowCount,
    overCount: group.overCount,
    noSalesCount: group.noSalesCount,
  };
}

const groupColumns = (nameLabel: string, parentLabel: string | null): SheetColumn[] => [
  ...(parentLabel ? [{ key: "parent", label: parentLabel, width: 20 }] : []),
  { key: "name", label: nameLabel, width: 30 },
  { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 18 },
  { key: "avgWeeklyValue", label: "Avg Weekly Sales (EGP)", numeric: true, width: 20 },
  { key: "coverWeeks", label: "Weeks of Cover", plainNumber: true, width: 14 },
  { key: "status", label: "Status", width: 14 },
  { key: "productCount", label: "Products", plainNumber: true, width: 10 },
  { key: "outOfStockCount", label: "Out of Stock", numeric: true, width: 10 },
  { key: "lowCount", label: "Low Stock", numeric: true, width: 10 },
  { key: "overCount", label: "Overstock", numeric: true, width: 10 },
  { key: "noSalesCount", label: "No Sales", numeric: true, width: 10 },
];

export function buildWeeklyStockWorkbook(
  view: WeeklyStockView,
  context: { scopeSummary: string; generatedAtCairo: string },
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  const subtitle = `${context.scopeSummary} · Stock as of ${formatWeeklyStockDate(view.asOfWeekStart)}`;

  // ── Tab 1: every product at every depot — the grain people read.
  const depotRows: ExportRow[] = view.cells.map((cell) => ({
    region: cell.regionName,
    area: cell.areaName,
    distributor: cell.distributorName,
    depot: cell.branchName,
    line: cell.line,
    product: cell.productName,
    asOf: formatWeeklyStockDate(cell.asOfWeekStart),
    stockUnits: cell.stockUnits,
    stockValue: cell.stockValue,
    avgWeeklyUnits: cell.avgWeeklyUnits,
    coverWeeks: cover(cell.coverWeeks),
    status: WEEKLY_STOCK_STATUS_LABELS[cell.status],
  }));
  addSheet(workbook, {
    title: "Weekly Stock by Branch and Product",
    subtitle,
    sheetName: "Stock by Branch",
    columns: [
      { key: "region", label: "Region", width: 16 },
      { key: "area", label: "Area", width: 20 },
      { key: "distributor", label: "Distributor", width: 18 },
      { key: "depot", label: "Branch", width: 26 },
      { key: "line", label: "Line", width: 14 },
      { key: "product", label: "Product", width: 26 },
      { key: "asOf", label: "Stock As Of", width: 14 },
      { key: "stockUnits", label: "Stock Units", plainNumber: true, width: 12 },
      { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 16 },
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", plainNumber: true, width: 14 },
      { key: "coverWeeks", label: "Weeks of Cover", plainNumber: true, width: 12 },
      { key: "status", label: "Status", width: 12 },
    ],
    rows: depotRows,
  });

  // ── Tab 2: one product code (one concentration) across depots — the only valid unit total.
  const productRows: ExportRow[] = view.products.map((product) => ({
    line: product.line,
    product: product.productName,
    stockUnits: product.stockUnits,
    stockValue: product.stockValue,
    avgWeeklyUnits: product.avgWeeklyUnits,
    coverWeeks: cover(product.coverWeeks),
    status: WEEKLY_STOCK_STATUS_LABELS[product.status],
    depotCount: product.depotCount,
    outDepots: product.outDepots,
    lowDepots: product.lowDepots,
    overDepots: product.overDepots,
    noSalesDepots: product.noSalesDepots,
  }));
  addSheet(workbook, {
    title: "Weekly Stock by Product",
    subtitle,
    sheetName: "By Product",
    columns: [
      { key: "line", label: "Line", width: 16 },
      { key: "product", label: "Product", width: 28 },
      { key: "stockUnits", label: "Stock Units", plainNumber: true, width: 12 },
      { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 18 },
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", plainNumber: true, width: 14 },
      { key: "coverWeeks", label: "Weeks of Cover", plainNumber: true, width: 14 },
      { key: "status", label: "Status", width: 12 },
      { key: "depotCount", label: "Branches", plainNumber: true, width: 10 },
      { key: "outDepots", label: "Out of Stock", numeric: true, width: 10 },
      { key: "lowDepots", label: "Low Stock", numeric: true, width: 10 },
      { key: "overDepots", label: "Overstock", numeric: true, width: 10 },
      { key: "noSalesDepots", label: "No Sales", numeric: true, width: 10 },
    ],
    rows: productRows,
  });

  addSheet(workbook, {
    title: "Weekly Stock by Branch (value)",
    subtitle,
    sheetName: "By Branch",
    columns: groupColumns("Branch", "Region"),
    rows: view.depots.map((group) => groupRow(group, true)),
  });
  addSheet(workbook, {
    title: "Weekly Stock by Area (value)",
    subtitle,
    sheetName: "By Area",
    columns: groupColumns("Area", "Region"),
    rows: view.areas.map((group) => groupRow(group, true)),
  });
  addSheet(workbook, {
    title: "Weekly Stock by Region (value)",
    subtitle,
    sheetName: "By Region",
    columns: groupColumns("Region", null),
    rows: view.regions.map((group) => groupRow(group, false)),
  });

  const distributorRows: ExportRow[] = view.distributors.map((distributor) => ({
    ...groupRow(distributor, false),
    asOf: formatWeeklyStockDate(distributor.asOfWeekStart),
    stale: distributor.stale ? "Latest stock file is old" : "",
  }));
  addSheet(workbook, {
    title: "Weekly Stock by Distributor (value)",
    subtitle,
    sheetName: "By Distributor",
    columns: [
      ...groupColumns("Distributor", null).slice(0, 1),
      { key: "asOf", label: "Stock As Of", width: 14 },
      { key: "stale", label: "Freshness", width: 22 },
      ...groupColumns("Distributor", null).slice(1),
    ],
    rows: distributorRows,
  });

  addSheet(workbook, {
    title: "How to read this workbook",
    subtitle,
    sheetName: "Notes",
    columns: [
      { key: "topic", label: "Topic", width: 24 },
      { key: "rule", label: "Rule", width: 100 },
    ],
    rows: [
      { topic: "Scope", rule: context.scopeSummary },
      { topic: "Generated", rule: `${context.generatedAtCairo} (Cairo)` },
      { topic: "Stock", rule: "Each distributor's latest stock file on or before the as-of date. Stock is a snapshot and is never added across weeks." },
      { topic: "Units", rule: "Units are shown per product and concentration only. Totals across different products are values, never units." },
      { topic: "Value", rule: "Stock units multiplied by the current Product Master factory price." },
      {
        topic: "Weeks of cover",
        rule: `Stock divided by the average weekly net sales of the last ${WEEKLY_STOCK_SALES_WINDOW_WEEKS} weeks. Low stock under ${WEEKLY_STOCK_COVER_LOW_WEEKS} weeks, Healthy ${WEEKLY_STOCK_COVER_LOW_WEEKS} to ${WEEKLY_STOCK_COVER_OVER_WEEKS}, Overstock over ${WEEKLY_STOCK_COVER_OVER_WEEKS}. No sales means stock on hand with nothing sold in that window.`,
      },
      { topic: "Area not mapped", rule: "Branches that serve several areas (key accounts, wholesale, warehouses) carry no single area and are listed under this label." },
      { topic: "Lines", rule: "CNS, Anti Infective and Pedia only. Head Office products are not tracked in weekly figures." },
      ...(view.kpis.priceMissingCount > 0
        ? [{ topic: "Missing prices", rule: `${view.kpis.priceMissingCount} rows have no factory price in the Product Master and are valued at zero.` }]
        : []),
    ],
  });

  return workbook;
}

export function buildWeeklyStockExportFilename(view: WeeklyStockView): string {
  return `phoenix-weekly-stock-${view.asOfWeekStart ?? "latest"}.xlsx`;
}
