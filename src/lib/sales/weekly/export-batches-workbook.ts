import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import {
  UNITS_FMT,
  VALUE_FMT,
  bandHeader,
  sanitizeSheetName,
  writeTable,
} from "@/lib/sales/sales-workbook-kit";

export type BatchSummaryItem = {
  id: string;
  distributorCode: string;
  distributorName: string;
  weekStart: string | null;
  status: string;
  totalRows: number;
  totalNetQty: number;
  totalSalesValue: number;
  totalStockQty: number;
};

export type BatchProductItem = {
  productCode: string;
  productName: string;
  netQty: number;
  salesValue: number;
  stockQty: number;
};

export async function buildBatchesExportWorkbook(
  batches: BatchSummaryItem[],
  productsByBatch: Map<string, BatchProductItem[]>,
  generatedAt: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = systemIdentity.appName;
  wb.created = new Date();

  const sorted = [...batches].sort((a, z) => {
    const wCmp = (z.weekStart ?? "").localeCompare(a.weekStart ?? "");
    if (wCmp !== 0) return wCmp;
    return a.distributorName.localeCompare(z.distributorName);
  });

  const dateRange =
    sorted.length === 0
      ? "—"
      : sorted.length === 1
        ? (sorted[0].weekStart ?? "—")
        : `${sorted[sorted.length - 1].weekStart ?? "—"} to ${sorted[0].weekStart ?? "—"}`;

  // ── Sheet 1: Summary ──────────────────────────────────────────────────────
  const SUMMARY_COLS = 7;
  const summarySheet = wb.addWorksheet("Summary");
  bandHeader(
    summarySheet,
    SUMMARY_COLS,
    "Weekly Sales — Combined Report",
    `${sorted.length} batch${sorted.length === 1 ? "" : "es"} · ${dateRange} · Generated ${generatedAt}`,
  );

  writeTable(summarySheet, 5, {
    title: "Selected Upload Periods",
    columns: [
      { label: "Period", width: 14 },
      { label: "Distributor", width: 24 },
      { label: "Status", width: 12 },
      { label: "Net Units", numFmt: UNITS_FMT, right: true, width: 13 },
      { label: "Sales Value (EGP)", dataBar: true, numFmt: VALUE_FMT, right: true, width: 20 },
      { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 13 },
      { label: "Rows", numFmt: UNITS_FMT, right: true, width: 10 },
    ],
    rows: sorted.map((b) => [
      b.weekStart ?? "—",
      b.distributorName,
      b.status,
      b.totalNetQty,
      b.totalSalesValue,
      b.totalStockQty,
      b.totalRows,
    ]),
    totals:
      sorted.length > 0
        ? [
            "TOTAL",
            "",
            "",
            sorted.reduce((s, b) => s + b.totalNetQty, 0),
            sorted.reduce((s, b) => s + b.totalSalesValue, 0),
            sorted.reduce((s, b) => s + b.totalStockQty, 0),
            sorted.reduce((s, b) => s + b.totalRows, 0),
          ]
        : undefined,
  });

  // ── Per-batch sheets ──────────────────────────────────────────────────────
  for (const batch of sorted) {
    const sheetName = sanitizeSheetName(`${batch.distributorCode} ${batch.weekStart ?? "no-date"}`);
    const batchSheet = wb.addWorksheet(sheetName);
    const products = (productsByBatch.get(batch.id) ?? []).slice().sort((a, z) => z.salesValue - a.salesValue);

    const BATCH_COLS = 4;
    bandHeader(
      batchSheet,
      BATCH_COLS,
      batch.distributorName,
      `Period: ${batch.weekStart ?? "—"} · Status: ${batch.status} · Generated ${generatedAt}`,
    );

    writeTable(batchSheet, 5, {
      title: "By Product",
      columns: [
        { label: "Product", width: 32 },
        { label: "Net Units", numFmt: UNITS_FMT, right: true, width: 13 },
        { label: "Sales Value (EGP)", dataBar: true, numFmt: VALUE_FMT, right: true, width: 20 },
        { label: "Stock Units", numFmt: UNITS_FMT, right: true, width: 13 },
      ],
      rows: products.map((p) => [
        p.productName || p.productCode,
        p.netQty,
        p.salesValue,
        p.stockQty,
      ]),
      totals:
        products.length > 0
          ? [
              "TOTAL",
              products.reduce((s, p) => s + p.netQty, 0),
              products.reduce((s, p) => s + p.salesValue, 0),
              products.reduce((s, p) => s + p.stockQty, 0),
            ]
          : undefined,
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
