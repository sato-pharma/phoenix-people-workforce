// Weekly Stock — XLSX export. Ships BESIDE the password-locked weekly designs (export-design.pins.json)
// and wears the HOUSE identity (SATO-DIS-2026-01 v1.0) on every tab, like the portal weekly export.
//
// It exports exactly what the screen shows for the same filters: the rows come from the same
// loadWeeklyStockDashboard call, so the viewer's scope travels with them.

import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportRow } from "@/lib/export/table-workbook";
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

function groupRows(rows: WeeklyStockGroupRow[], withParent: boolean): ExportRow[] {
  const out: ExportRow[] = rows.map((group) => ({
    ...(withParent ? { parent: group.parentName } : {}),
    name: group.name,
    stockValue: group.stockValue,
    avgWeeklyValue: group.avgWeeklyValue,
    coverWeeks: cover(group.coverWeeks),
    status: WEEKLY_STOCK_STATUS_LABELS[group.status],
    productCount: group.productCount,
    lowCount: group.lowCount,
    overCount: group.overCount,
    noSalesCount: group.noSalesCount,
  }));
  out.push({
    ...(withParent ? { parent: "" } : {}),
    name: "Total (value)",
    stockValue: Number(rows.reduce((sum, group) => sum + group.stockValue, 0).toFixed(2)),
    avgWeeklyValue: Number(rows.reduce((sum, group) => sum + group.avgWeeklyValue, 0).toFixed(2)),
    coverWeeks: "",
    status: "",
    productCount: "",
    lowCount: rows.reduce((sum, group) => sum + group.lowCount, 0),
    overCount: rows.reduce((sum, group) => sum + group.overCount, 0),
    noSalesCount: rows.reduce((sum, group) => sum + group.noSalesCount, 0),
  });
  return out;
}

const groupColumns = (nameLabel: string, parentLabel: string | null) => [
  ...(parentLabel ? [{ key: "parent", label: parentLabel, width: 20 }] : []),
  { key: "name", label: nameLabel, width: 30 },
  { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 18 },
  { key: "avgWeeklyValue", label: "Avg Weekly Sales (EGP)", numeric: true, width: 20 },
  { key: "coverWeeks", label: "Weeks of Cover", numeric: true, width: 14 },
  { key: "status", label: "Status", width: 14 },
  { key: "productCount", label: "Products", numeric: true, width: 10 },
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
  depotRows.push({
    region: "Total (value)",
    area: "",
    distributor: "",
    depot: "",
    line: "",
    product: "",
    asOf: "",
    stockUnits: "",
    stockValue: view.kpis.stockValue,
    avgWeeklyUnits: "",
    coverWeeks: cover(view.kpis.coverWeeks),
    status: "",
  });
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Stock by Depot and Product",
    subtitle,
    sheetName: "Stock by Depot",
    columns: [
      { key: "region", label: "Region", width: 16 },
      { key: "area", label: "Area", width: 20 },
      { key: "distributor", label: "Distributor", width: 18 },
      { key: "depot", label: "Depot", width: 26 },
      { key: "line", label: "Line", width: 14 },
      { key: "product", label: "Product", width: 26 },
      { key: "asOf", label: "Stock As Of", width: 14 },
      { key: "stockUnits", label: "Stock Units", numeric: true, width: 12 },
      { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 16 },
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", numeric: true, width: 14 },
      { key: "coverWeeks", label: "Weeks of Cover", numeric: true, width: 12 },
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
    lowDepots: product.lowDepots,
    overDepots: product.overDepots,
    noSalesDepots: product.noSalesDepots,
  }));
  productRows.push({
    line: "Total (value)",
    product: "",
    stockUnits: "",
    stockValue: view.kpis.stockValue,
    avgWeeklyUnits: "",
    coverWeeks: cover(view.kpis.coverWeeks),
    status: "",
    depotCount: view.kpis.depotCount,
    lowDepots: view.kpis.lowCount,
    overDepots: view.kpis.overCount,
    noSalesDepots: view.kpis.noSalesCount,
  });
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Stock by Product",
    subtitle,
    sheetName: "By Product",
    columns: [
      { key: "line", label: "Line", width: 16 },
      { key: "product", label: "Product", width: 28 },
      { key: "stockUnits", label: "Stock Units", numeric: true, width: 12 },
      { key: "stockValue", label: "Stock Value (EGP)", numeric: true, width: 18 },
      { key: "avgWeeklyUnits", label: "Avg Weekly Units", numeric: true, width: 14 },
      { key: "coverWeeks", label: "Weeks of Cover", numeric: true, width: 14 },
      { key: "status", label: "Status", width: 12 },
      { key: "depotCount", label: "Depots", numeric: true, width: 10 },
      { key: "lowDepots", label: "Low Stock", numeric: true, width: 10 },
      { key: "overDepots", label: "Overstock", numeric: true, width: 10 },
      { key: "noSalesDepots", label: "No Sales", numeric: true, width: 10 },
    ],
    rows: productRows,
  });

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Stock by Depot (value)",
    subtitle,
    sheetName: "By Depot",
    columns: groupColumns("Depot", "Region"),
    rows: groupRows(view.depots, true),
  });
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Stock by Area (value)",
    subtitle,
    sheetName: "By Area",
    columns: groupColumns("Area", "Region"),
    rows: groupRows(view.areas, true),
  });
  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Stock by Region (value)",
    subtitle,
    sheetName: "By Region",
    columns: groupColumns("Region", null),
    rows: groupRows(view.regions, false),
  });

  const distributorTotals = groupRows(view.distributors, false);
  const distributorRows: ExportRow[] = distributorTotals.map((row, index) => {
    const distributor = view.distributors[index];
    return {
      ...row,
      asOf: distributor ? formatWeeklyStockDate(distributor.asOfWeekStart) : "",
      stale: distributor?.stale ? "Latest stock file is old" : "",
    };
  });
  addPhoenixTableSheet(workbook, {
    theme: "house",
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

  addPhoenixTableSheet(workbook, {
    theme: "house",
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
      { topic: "Area not mapped", rule: "Depots that serve several areas (key accounts, wholesale, warehouses) carry no single area and are listed under this label." },
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
