import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import {
  PCT_FMT,
  UNITS_FMT,
  VALUE_FMT,
  sanitizeSheetName,
  type CellValue,
  type TableColumn,
} from "@/lib/sales/sales-workbook-kit";
import type { SalesDashboardData, SalesDashboardFilters, SalesTrendPoint } from "@/lib/sales/types";

// Detailed, filter-aware export of the Monthly Sales (Achievement) Dashboard. Reuses the exact
// SalesDashboardData the on-screen dashboard renders — the workbook can never show more than the
// caller's session already scoped/stripped, because the caller re-runs getSalesDashboard() with
// the same filters and access context before handing data in here.

type ChannelSlice = { name: string; value: number };
type FamilyRow = { name: string; sales: number; target: number; achievementRate: number; units?: number; status?: string };
type TerritoryRow = { name: string; sales: number; target: number; achievementRate: number };
type LineRow = { line: string; sales: number; target: number; achievementRate: number; linkedEmployees: number };
type ManagerRow = {
  manager: string;
  line: string;
  sales: number;
  target: number;
  achievementRate: number;
  topProduct: string;
  retailSales: number;
  storesSales: number;
};
type ProductRow = { product: string; family: string; sales: number; target: number; achievementRate: number };
type ParetoRow = { name: string; sales: number; cumulativePercent: number };
type AnomalyRow = { label: string; detail: string; score: number };
type TransactionRow = {
  employeeHrId: string | null;
  employeeName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  line: string;
  territory: string;
  salesType: string;
  family: string;
  product: string;
  period: string;
  salesUnits: number;
  salesValue: number;
  targetValue: number;
  achievementRate: number;
  ownershipLabel: string;
};
type RecentBatchRow = {
  fileName: string;
  line: string;
  period: string;
  status: string;
  uploadedBy: string;
  createdAt: string;
  totalRecords: number;
  approvedSalesValue?: number;
  approvedTargetValue?: number;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function bufferOf(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

/**
 * Human-readable summary of the applied filters for the cover sheet. `managerLabels` turns the
 * Manager filter's key into the manager's name (owner, 2026-10-20, names never codes).
 */
export function describeMonthlyDashboardFilters(
  filters: SalesDashboardFilters,
  managerLabels?: Record<string, string>,
): string {
  const parts: string[] = [];
  if (filters.periods?.length) parts.push(`Months: ${filters.periods.join(", ")}`);
  if (filters.line) parts.push(`Line: ${filters.line}`);
  if (filters.salesType) parts.push(`Sales type: ${filters.salesType}`);
  if (filters.territory) parts.push(`Territory: ${filters.territory}`);
  if (filters.manager) parts.push(`Manager: ${managerLabels?.[filters.manager] ?? filters.manager}`);
  if (filters.products?.length) parts.push(`Products: ${filters.products.join(", ")}`);
  if (filters.family) parts.push(`Family: ${filters.family}`);
  return parts.length > 0 ? parts.join("   ·   ") : "No filters applied (full scope)";
}

export type MonthlyDashboardWorkbookMeta = {
  exportedByName: string;
  exportedByHrId: string;
  role: string;
  generatedAtIso: string;
  filters: SalesDashboardFilters;
};

export async function buildMonthlySalesDashboardWorkbook(input: {
  data: SalesDashboardData;
  meta: MonthlyDashboardWorkbookMeta;
}): Promise<ArrayBuffer> {
  const { data, meta } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  const summary = (data.summary ?? {}) as Record<string, number | string>;
  const totalSales = Number(summary.totalApprovedSales ?? 0);
  const totalTarget = Number(summary.totalApprovedTarget ?? 0);

  buildHouseCoverSheet(workbook, {
    title: "Monthly Sales Dashboard",
    subtitle: "Approved Source of Sales data — targets, channel mix, territories and trends, filter-scoped.",
    confidentialNote: "Confidential products (LA003 / LA004) are excluded unless your role is authorized to view them.",
    rows: [
      houseGeneratedRow(meta.generatedAtIso),
      ["Exported by", `${meta.exportedByName} (${meta.exportedByHrId})`],
      ["Role", meta.role],
      ["Applied filters", describeMonthlyDashboardFilters(meta.filters, data.filters?.managerLabels)],
      ["Total sales (EGP)", totalSales.toLocaleString("en-US")],
      ["Total target (EGP)", totalTarget.toLocaleString("en-US")],
      ["Achievement", `${Math.round(Number(summary.achievementRate ?? 0) * 100)}%`],
      ["Approved records", String(summary.approvedRecords ?? 0)],
      ["Linked employees", String(summary.linkedEmployees ?? 0)],
      ["Data quality (DSM linkage)", `${Math.round(Number(summary.dataQualityRate ?? 0) * 100)}%`],
      ["Top manager", String(summary.topManager ?? "-")],
    ],
  });

  // ── Trend ─────────────────────────────────────────────────────────────────
  const trend = asArray<SalesTrendPoint>(data.trend);
  const trendSheet = workbook.addWorksheet(sanitizeSheetName("Trend"));
  writeHouseTable(trendSheet, 1, {
    title: "Monthly sales vs target",
    columns: [
      { label: "Month", width: 12 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
      { label: "Linked employees", numFmt: UNITS_FMT, right: true, width: 15 },
    ],
    rows: trend.map((point) => [point.period, point.sales, point.target, point.achievementRate, point.linkedEmployees]),
    note: `${trend.length} month(s) in the selected scope.`,
  });

  // ── Channel Mix ───────────────────────────────────────────────────────────
  const channelMix = asArray<ChannelSlice>(data.channelMix);
  const channelSheet = workbook.addWorksheet(sanitizeSheetName("Channel Mix"));
  const channelTotal = channelMix.reduce((s, c) => s + c.value, 0);
  writeHouseTable(channelSheet, 1, {
    title: "Sales value by sales type",
    columns: [
      { label: "Sales type", width: 24 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Share", numFmt: PCT_FMT, right: true, width: 11 },
    ],
    rows: channelMix.map((c) => [c.name, c.value, channelTotal > 0 ? c.value / channelTotal : 0]),
    note: `${channelMix.length} channel(s).`,
  });

  // ── Family Performance ───────────────────────────────────────────────────
  const familyMatrix = asArray<FamilyRow>(data.familyMatrix);
  const familySheet = workbook.addWorksheet(sanitizeSheetName("Family Performance"));
  writeHouseTable(familySheet, 1, {
    title: "Sales by product family",
    columns: [
      { label: "Family", width: 26 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
    ],
    rows: [...familyMatrix]
      .sort((a, b) => b.sales - a.sales)
      .map((row) => [row.name, row.sales, row.target, row.achievementRate]),
    note: `${familyMatrix.length} famil${familyMatrix.length === 1 ? "y" : "ies"}.`,
  });

  // ── Territory Performance ────────────────────────────────────────────────
  const territories = asArray<TerritoryRow>(data.territories);
  const territorySheet = workbook.addWorksheet(sanitizeSheetName("Territory Performance"));
  writeHouseTable(territorySheet, 1, {
    title: "Sales by territory",
    columns: [
      { label: "Territory", width: 24 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
    ],
    rows: [...territories]
      .sort((a, b) => b.sales - a.sales)
      .map((row) => [row.name, row.sales, row.target, row.achievementRate]),
    note: `${territories.length} territor${territories.length === 1 ? "y" : "ies"}.`,
  });

  // ── Line Performance ──────────────────────────────────────────────────────
  const linePerformance = asArray<LineRow>(data.linePerformance);
  const lineSheet = workbook.addWorksheet(sanitizeSheetName("Line Performance"));
  writeHouseTable(lineSheet, 1, {
    title: "Sales by product line",
    columns: [
      { label: "Line", width: 18 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
      { label: "Linked reps", numFmt: UNITS_FMT, right: true, width: 12 },
    ],
    rows: [...linePerformance]
      .sort((a, b) => b.sales - a.sales)
      .map((row) => [row.line, row.sales, row.target, row.achievementRate, row.linkedEmployees]),
    note: `${linePerformance.length} line(s).`,
  });

  // ── Manager Performance ───────────────────────────────────────────────────
  const managerPerformance = asArray<ManagerRow>(data.managerPerformance);
  const managerSheet = workbook.addWorksheet(sanitizeSheetName("Manager Performance"));
  writeHouseTable(managerSheet, 1, {
    title: "District/sales managers ranked by approved sales",
    columns: [
      { label: "Manager", width: 24 },
      { label: "Line", width: 16 },
      { label: "Top product", width: 24 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
      { label: "Retail sales", numFmt: VALUE_FMT, right: true, width: 15 },
      { label: "Stores sales", numFmt: VALUE_FMT, right: true, width: 15 },
    ],
    rows: [...managerPerformance]
      .sort((a, b) => b.sales - a.sales)
      .map((row) => [row.manager, row.line, row.topProduct, row.sales, row.target, row.achievementRate, row.retailSales, row.storesSales]),
    note: `${managerPerformance.length} manager(s).`,
  });

  // ── Product Performance ───────────────────────────────────────────────────
  const productPerformance = asArray<ProductRow>(data.productPerformance);
  const productSheet = workbook.addWorksheet(sanitizeSheetName("Product Performance"));
  writeHouseTable(productSheet, 1, {
    title: "Sales by product / SKU",
    columns: [
      { label: "Product", width: 30 },
      { label: "Family", width: 22 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Target", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
    ],
    rows: [...productPerformance]
      .sort((a, b) => b.sales - a.sales)
      .map((row) => [row.product, row.family, row.sales, row.target, row.achievementRate]),
    note: `${productPerformance.length} product(s).`,
  });

  // ── Pareto ────────────────────────────────────────────────────────────────
  const pareto = asArray<ParetoRow>(data.pareto);
  const paretoSheet = workbook.addWorksheet(sanitizeSheetName("Pareto"));
  writeHouseTable(paretoSheet, 1, {
    title: "Top products — cumulative contribution",
    columns: [
      { label: "Product", width: 30 },
      { label: "Sales", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
      { label: "Cumulative %", numFmt: PCT_FMT, right: true, width: 14 },
    ],
    rows: pareto.map((row) => [row.name, row.sales, row.cumulativePercent]),
    note: `${pareto.length} product(s) in the Pareto ranking.`,
  });

  // ── Anomalies ─────────────────────────────────────────────────────────────
  const anomalies = asArray<AnomalyRow>(data.anomalies);
  const anomalySheet = workbook.addWorksheet(sanitizeSheetName("Anomalies"));
  writeHouseTable(anomalySheet, 1, {
    title: "Product x territory outliers",
    columns: [
      { label: "Label", width: 28 },
      { label: "Detail", width: 40 },
      { label: "Sigma score", numFmt: VALUE_FMT, right: true, width: 12 },
    ],
    rows: anomalies.map((row) => [row.label, row.detail, row.score]),
    note: anomalies.length === 0 ? "No significant anomalies detected." : `${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}.`,
  });

  // ── Recent Batches ────────────────────────────────────────────────────────
  // These figures now come from SoS Monthly Closing, which has no closing-sheet upload batch
  // behind it, so this sheet reports nothing rather than reprinting a ledger that no longer
  // explains where the numbers came from. Upload provenance lives on /sales/import.
  const recentBatches = asArray<RecentBatchRow>(data.recentBatches);
  const batchSheet = workbook.addWorksheet(sanitizeSheetName("Recent Batches"));
  writeHouseTable(batchSheet, 1, {
    title: "Recently uploaded sales batches",
    columns: [
      { label: "File name", width: 30 },
      { label: "Line", width: 14 },
      { label: "Period", width: 10 },
      { label: "Status", width: 14 },
      { label: "Uploaded by", width: 16 },
      { label: "Uploaded at", width: 22 },
      { label: "Records", numFmt: UNITS_FMT, right: true, width: 10 },
      { label: "Approved sales", numFmt: VALUE_FMT, right: true, width: 15 },
    ],
    rows: recentBatches.map((batch) => [
      batch.fileName,
      batch.line,
      batch.period,
      batch.status,
      batch.uploadedBy,
      batch.createdAt,
      batch.totalRecords,
      batch.approvedSalesValue ?? 0,
    ]),
    note:
      recentBatches.length === 0
        ? "This report reads Source of Sales Monthly Closing. Upload history is on Sales > Import."
        : `${recentBatches.length} batch(es) shown.`,
  });

  // ── Transactions (detailed rows) ─────────────────────────────────────────
  const transactions = asArray<TransactionRow>(data.transactions);
  const txnColumns: TableColumn[] = [
    { label: "Period", width: 10 },
    { label: "Line", width: 14 },
    { label: "Territory", width: 18 },
    { label: "Sales type", width: 16 },
    { label: "Family", width: 20 },
    { label: "Product", width: 28 },
    { label: "Employee HR_ID", width: 14 },
    { label: "Employee", width: 22 },
    { label: "Manager HR_ID", width: 14 },
    { label: "Manager", width: 22 },
    { label: "Ownership", width: 20 },
    { label: "Units", numFmt: UNITS_FMT, right: true, width: 10 },
    { label: "Sales value", numFmt: VALUE_FMT, right: true, width: 15, dataBar: true },
    { label: "Target value", numFmt: VALUE_FMT, right: true, width: 15 },
    { label: "Achievement", numFmt: PCT_FMT, right: true, width: 13 },
  ];
  const txnRows: CellValue[][] = transactions.map((row) => [
    row.period,
    row.line,
    row.territory,
    row.salesType,
    row.family,
    row.product,
    row.employeeHrId ?? "—",
    row.employeeName ?? "—",
    row.managerHrId ?? "—",
    row.managerName ?? "—",
    row.ownershipLabel ?? "—",
    row.salesUnits,
    row.salesValue,
    row.targetValue,
    row.achievementRate,
  ]);
  const txnTotals: CellValue[] = new Array(txnColumns.length).fill(null);
  txnTotals[0] = "TOTAL";
  txnTotals[11] = transactions.reduce((s, r) => s + r.salesUnits, 0);
  txnTotals[12] = transactions.reduce((s, r) => s + r.salesValue, 0);
  txnTotals[13] = transactions.reduce((s, r) => s + r.targetValue, 0);
  const txnSheet = workbook.addWorksheet(sanitizeSheetName("Transactions"));
  writeHouseTable(txnSheet, 1, {
    title: "Detailed approved sales records",
    columns: txnColumns,
    rows: txnRows,
    totals: txnRows.length > 0 ? txnTotals : undefined,
    note: `${transactions.length} record(s) shown${transactions.length >= 20000 ? " (capped — narrow the filters for a complete extract)" : ""}.`,
  });

  return bufferOf(workbook);
}
