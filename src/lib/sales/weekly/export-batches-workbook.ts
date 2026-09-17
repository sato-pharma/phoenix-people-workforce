import ExcelJS from "exceljs";

import { systemLegalEntity } from "@/config/system-settings";
// The HOUSE helpers, not the kit's. `sales-workbook-kit` is shared with the Weekly Summarized
// Report, whose layout the owner has locked — restyling the kit in place would restyle that too.
// `writeHouseTable` takes the same arguments and returns the same row as `writeTable`, so the
// layout arithmetic below is unchanged; only the ink differs.
import { writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { writeHouseTable } from "@/lib/export/house-table-workbook";
import {
  UNITS_FMT,
  VALUE_FMT,
  sanitizeSheetName,
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
  wb.creator = systemLegalEntity.legalNameEn;
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
  const summaryFirstRow = writeHouseMasthead(wb, summarySheet, {
    columns: SUMMARY_COLS,
    provenance: [`Generated ${generatedAt}`],
    subtitle: `${sorted.length} batch${sorted.length === 1 ? "" : "es"} · ${dateRange}`,
    title: "Weekly Sales — Combined Report",
  });

  writeHouseTable(summarySheet, summaryFirstRow + 1, {
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
    // Only Sales Value and Rows add up (owner, 2026-09-17). The unit TOTALs stay empty: each period's
    // units already add different products, which are never added (unit-totals.ts), and its stock is a
    // snapshot of that week, so adding the periods multiplies the stock on hand.
    totals:
      sorted.length > 0
        ? [
            "TOTAL",
            "",
            "",
            "",
            sorted.reduce((s, b) => s + b.totalSalesValue, 0),
            "",
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
    const batchFirstRow = writeHouseMasthead(wb, batchSheet, {
      columns: BATCH_COLS,
      provenance: [`Generated ${generatedAt}`],
      subtitle: `Period: ${batch.weekStart ?? "—"} · Status: ${batch.status}`,
      title: batch.distributorName,
    });

    writeHouseTable(batchSheet, batchFirstRow + 1, {
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
      // The rows are different products, so only Sales Value adds up; the unit TOTALs stay empty.
      totals:
        products.length > 0
          ? [
              "TOTAL",
              "",
              products.reduce((s, p) => s + p.salesValue, 0),
              "",
            ]
          : undefined,
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
