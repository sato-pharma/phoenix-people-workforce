// Employee-portal Weekly Sales — simple 3-tab XLSX export.
// Tabs: Summary KPIs, Week Comparison, Report Sources.
// Uses addPhoenixTableSheet on the HOUSE theme — SATO-DIS-2026-01 v1.0 — on every tab.
//
// Unit totals are printed only where every row behind them is ONE product (owner rule: units of
// different products are never added; see unit-totals.ts). The dashboard's tiles follow the same
// test, so the file never shows a unit total the screen does not.

import ExcelJS from "exceljs";

import { addPhoenixTableSheet } from "@/lib/export/table-workbook";
import { latestNonFuturePeriod } from "@/lib/sales/periods";
import type { PortalWeeklyScopeView } from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";
import {
  weeklyKpiUnitsAreOneProduct,
  weeklyWeekComparisonUnitsAreOneProduct,
} from "@/lib/sales/weekly/unit-totals";

function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function formatPct(value: number | null): string {
  if (value == null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatCycleMonth(code: string | null): string {
  if (!code) return "—";
  const match = /^(\d{4})-(\d{2})-01$/.exec(code);
  if (!match) return code;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** The newest uploaded month that has STARTED — never one ahead of today (the future-month rule). */
function latestUploadedMonth(data: WeeklyDashboard): string | null {
  return latestNonFuturePeriod(data.availableMonths.map((month) => month.code));
}

export function buildPortalWeeklyWorkbook(
  data: WeeklyDashboard,
  scope: PortalWeeklyScopeView,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";

  const currentMonth =
    data.appliedFilters.cycleMonths.length === 1
      ? formatCycleMonth(data.appliedFilters.cycleMonths[0])
      : latestUploadedMonth(data)
        ? formatCycleMonth(latestUploadedMonth(data) as string)
        : "All Months";

  const subtitle = `${scope.scopeSummary} · ${currentMonth}`;

  // ── Tab 1: Summary ──────────────────────────────────────────────────────────
  // KPI rows + separator + Top 10 Regions + Top 10 Products
  const summaryRows = [
    { metric: "Total Sales Value", value: formatEgp(data.kpis.salesValue) },
    ...(weeklyKpiUnitsAreOneProduct(data)
      ? [
          { metric: "Total Sales Units", value: String(data.kpis.salesUnits) },
          { metric: "Total Stock Units", value: String(data.kpis.stockUnits) },
        ]
      : []),
    { metric: "Distributors", value: String(data.kpis.distributorCount) },
    { metric: "Regions", value: String(data.kpis.regionCount) },
    { metric: "Products", value: String(data.kpis.productCount) },
    { metric: "", value: "" },
    { metric: "Top Regions by Value", value: "" },
    ...data.regions.slice(0, 10).map((r, i) => ({
      metric: `  ${i + 1}. ${r.name}`,
      value: formatEgp(r.salesValue),
    })),
    { metric: "", value: "" },
    { metric: "Top Products by Value", value: "" },
    ...data.products.slice(0, 10).map((p, i) => ({
      metric: `  ${i + 1}. ${p.name}`,
      value: formatEgp(p.salesValue),
    })),
  ];

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Weekly Sales Summary",
    subtitle,
    sheetName: "Summary",
    columns: [
      { key: "metric", label: "Metric", width: 36 },
      { key: "value", label: "Value", width: 22 },
    ],
    rows: summaryRows,
  });

  // ── Tab 2: Week Comparison ──────────────────────────────────────────────────
  // Its units add every week in scope, so they need the stricter one-product test (unit-totals.ts).
  // Stock Units stays out of the TOTAL row: each week's stock is a snapshot of what is on hand, not a
  // flow, so adding the weeks multiplies it (the same reason service.ts's latestStockOnly keeps one week
  // for the tiles). Its TOTAL cell is empty, because a row labelled TOTAL must not show one week's stock.
  const weekCompUnits = weeklyWeekComparisonUnitsAreOneProduct(data);
  const weekCompRows = data.weekComparison.map((row) => ({
    month: formatCycleMonth(row.cycleMonth),
    week: row.weekNumber != null ? `W${row.weekNumber}` : "—",
    weekStart: row.weekStart ?? "—",
    // M6: a gap-spanning week's value/units/WoW are suppressed to null upstream (not a true
    // single-week figure); export "—" (the "spans gap" state) rather than a misleading number.
    salesValue: row.salesValue ?? "—",
    salesUnits: row.salesUnits ?? "—",
    stockUnits: row.stockUnits,
    deltaPct: row.deltaValuePct != null ? formatPct(row.deltaValuePct) : "—",
  }));

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Week-by-Week Comparison",
    subtitle,
    sheetName: "Week Comparison",
    columns: [
      { key: "month", label: "Cycle Month", width: 18 },
      { key: "week", label: "Week", width: 8 },
      { key: "weekStart", label: "Week Start", width: 14 },
      { key: "salesValue", label: "Sales Value (EGP)", numeric: true, width: 22 },
      ...(weekCompUnits
        ? [
            { key: "salesUnits", label: "Sales Units", numeric: true, width: 16 },
            { key: "stockUnits", label: "Stock Units", numeric: true, excludeFromTotal: true, width: 16 },
          ]
        : []),
      { key: "deltaPct", label: "Δ% vs Prior Week", width: 18 },
    ],
    rows: weekCompRows,
  });

  // ── Tab 3: Report Sources ───────────────────────────────────────────────────
  const sourceRows = data.sources.map((s) => ({
    distributor: s.distributorName,
    distributorCode: s.distributorCode,
    cycleMonth: formatCycleMonth(s.cycleMonth ?? null),
    week: s.weekNumber != null ? `W${s.weekNumber}` : "—",
    weekStart: s.weekStart ?? "—",
    fileName: s.fileName,
  }));

  addPhoenixTableSheet(workbook, {
    theme: "house",
    title: "Report Sources",
    subtitle,
    sheetName: "Sources",
    columns: [
      { key: "distributor", label: "Distributor", width: 28 },
      { key: "distributorCode", label: "Code", width: 12 },
      { key: "cycleMonth", label: "Cycle Month", width: 18 },
      { key: "week", label: "Week", width: 8 },
      { key: "weekStart", label: "Week Start", width: 14 },
      { key: "fileName", label: "File Name", width: 40 },
    ],
    rows: sourceRows,
  });

  return workbook;
}

/** Generate the suggested file name for the export. */
export function buildPortalWeeklyExportFilename(data: WeeklyDashboard): string {
  const month =
    data.appliedFilters.cycleMonths.length === 1
      ? data.appliedFilters.cycleMonths[0]?.slice(0, 7) // "2026-06"
      : (latestUploadedMonth(data)?.slice(0, 7) ?? "export");
  return `phoenix-weekly-sales-${month}-export.xlsx`;
}
