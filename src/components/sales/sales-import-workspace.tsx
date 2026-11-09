"use client";

import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  ClipboardCheck,
  FileSpreadsheet,
  Filter,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Package,
  RefreshCw,
  ShieldCheck,
  Table2,
  Trash2,
  TrendingUp,
  UploadCloud,
  Users,
  UserSquare,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChannelsByRepTab } from "@/components/sales/channels-by-rep-tab";
import { CustomersChannelTab } from "@/components/sales/customers-channel-tab";
import type { PreviewResult } from "@/components/sales/import-preview-modal";
import { MonthlySalesWizard } from "@/components/sales/monthly-sales-wizard";
import { SalesQueue } from "@/components/sales/sales-queue";
import { SosCoverageTab } from "@/components/sales/sos-coverage-tab";
import { SourceOfSalesMappingTab } from "@/components/sales/source-of-sales-mapping-tab";
import { SourceOfSalesProductsTab } from "@/components/sales/source-of-sales-products-tab";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput, useSortableTable } from "@/components/ui/sortable-table";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { humanizeCode } from "@/lib/format/code-label";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type {
  DistributorSalesAreaSummary,
  DistributorSalesBrickSummary,
  DistributorSalesLineSummary,
  DistributorSalesProductSummary,
  DistributorSalesRegionSummary,
  DistributorSalesValidationIssue,
  DistributorSalesValidationResult,
  SalesDistributorOption,
  SourceOfSalesDashboard,
  SourceOfSalesDashboardDistributor,
  SourceOfSalesDashboardGroup,
  SourceOfSalesProduct,
  SourceOfSalesUploadBatch,
} from "@/lib/sales/monthly-distributor-import";
import type { SalesHistoryRow } from "@/lib/sales/types";
import type { MappingReferences } from "@/lib/sales/normalizer/service";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxFieldClassName } from "@/components/ui/form-tokens";


type Props = {
  distributors: SalesDistributorOption[];
  initialBatches: SourceOfSalesUploadBatch[];
  initialDashboard: SourceOfSalesDashboard | null;
  initialError: string | null;
  initialProducts: SourceOfSalesProduct[];
  /** Master products + bricks for the Mapping tab's inline "add by field" dropdowns. */
  mappingReferences: MappingReferences;
  /** Distributor codes that have a normalizer layout profile (gates the Mapping tab's Learn/Analyze). */
  profiledDistributorCodes: string[];
  /** Open directly on a given tab — carried from a "fix this in Source of Sales" deep-link. */
  initialTab?: SourceOfSalesTab;
  /** Pre-fill the Products Reference tab's search box (used with initialTab="products"). */
  initialProductsSearch?: string;
  /**
   * Monthly sales import batches awaiting review. The Sales Queue was retired as its own page
   * (2026-08-02) and its review/approve/reject/replace workflow moved in here as the "Approvals"
   * tab — it was the only surface that could approve a batch, so it could not simply be deleted.
   */
  initialQueue: SalesHistoryRow[] | null;
  initialQueueError: string | null;
};

type ValidationResponse = {
  code?: string;
  data?: PreviewResult;
  error?: string;
  message?: string;
  storagePath?: string | null;
  success: boolean;
};

type BatchListResponse = {
  data?: SourceOfSalesUploadBatch[];
  error?: string;
  success: boolean;
};

type DashboardResponse = {
  data?: SourceOfSalesDashboard;
  error?: string;
  success: boolean;
};

const panelClassName =
  "rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";
const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
// The dashboard's By Brick / By Product breakdowns are unpaginated and can run into the hundreds of
// rows. Rendering all of them at once made this the heaviest page in the app (a single "dashboard" tab
// mount of six full tables), slow enough to stall the very first click after load. Cap the default DOM
// to a manageable slice; full data stays one click (or an Export XLSX) away.
const SUMMARY_TABLE_ROW_CAP = 50;

function numberWithDecimals(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(value || 0);
}

function Metric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  value: string;
}) {
  const tones = {
    bad: "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]",
    good: "border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]",
    neutral: "border-phx-line bg-[#FCFDFE] text-phx-ink",
    warn: "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]",
  };
  return (
    <Card className={cn(panelClassName, "min-h-[104px] p-4", tones[tone])}>
      <p className="text-phx-sm font-black uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-2 break-words text-2xl font-black tracking-tight">{value}</p>
    </Card>
  );
}

function StatusBanner({ result, error }: { error: string | null; result: DistributorSalesValidationResult | null }) {
  if (!result && !error) return null;
  if (result?.status === "validated") {
    return (
      <AdminCallout tone="success">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">Validation passed</p>
          <p className="mt-1 leading-6">The sheet is clean for {result.distributor.name} / {result.distributor.code}.</p>
        </div>
      </AdminCallout>
    );
  }

  return (
    <AdminCallout tone="danger">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">Validation blocked</p>
        <p className="mt-1 leading-6">{error ?? "Fix the failed rows before importing."}</p>
      </div>
    </AdminCallout>
  );
}

function TotalsGrid({ result }: { result: DistributorSalesValidationResult }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Rows Read" value={formatNumber(result.rowCount)} />
      <Metric label="Importable Rows" tone={result.failedRows > 0 ? "warn" : "good"} value={formatNumber(result.importableRows)} />
      <Metric label="Failed Rows" tone={result.failedRows > 0 ? "bad" : "good"} value={formatNumber(result.failedRows)} />
      <Metric label="Period" value={result.period ?? "Multiple / Missing"} />
      <Metric label="Total Qty" value={numberWithDecimals(result.totals.totalQty)} />
      <Metric label="Total B. Qty" value={numberWithDecimals(result.totals.totalBonusQty)} />
      <Metric label="Total Value" value={formatCurrency(result.totals.totalValue)} />
      <Metric label="Distributor" value={`${result.distributor.name} / ${result.distributor.code}`} />
    </div>
  );
}

function cellDisplay(value: string | undefined | null) {
  return value || "-";
}

function LineTable({ rows }: { rows: DistributorSalesLineSummary[] }) {
  const columns = ["Line", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    cellDisplay(row.line),
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "line", label: "Line" },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    line: row.line, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Line" rows={mapped} />;
}

function RegionTable({ rows }: { rows: DistributorSalesRegionSummary[] }) {
  const columns = ["Region", "Code", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    cellDisplay(row.regionName),
    row.regionCode || "-",
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "name", label: "Region" },
    { key: "code", label: "Code" },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    name: row.regionName, code: row.regionCode, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Region" rows={mapped} />;
}

function AreaTable({ rows }: { rows: DistributorSalesAreaSummary[] }) {
  const columns = ["Area", "Code", "Region", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    cellDisplay(row.areaName),
    row.areaCode || "-",
    cellDisplay(row.regionName),
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "area", label: "Area" },
    { key: "code", label: "Code" },
    { key: "region", label: "Region" },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    area: row.areaName, code: row.areaCode, region: row.regionName, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Area" rows={mapped} />;
}

function BrickTable({ rows }: { rows: DistributorSalesBrickSummary[] }) {
  const columns = ["Brick", "Block", "Area", "Region", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    cellDisplay(row.brickName),
    cellDisplay(row.blockName),
    cellDisplay(row.areaName),
    cellDisplay(row.regionName),
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "brick", label: "Brick" },
    { key: "block", label: "Block" },
    { key: "area", label: "Area" },
    { key: "region", label: "Region" },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    brick: row.brickName, block: row.blockName, area: row.areaName, region: row.regionName, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Brick" rows={mapped} />;
}

function ProductTable({ rows }: { rows: DistributorSalesProductSummary[] }) {
  const columns = ["Product", "Code", "Line", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    cellDisplay(row.productName),
    row.productCode || "-",
    cellDisplay(row.officialLine),
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "product", label: "Product" },
    { key: "code", label: "Code" },
    { key: "line", label: "Line" },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    product: row.productName, code: row.productCode, line: row.officialLine, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Product" rows={mapped} />;
}

function DashboardGroupTable({
  exportTitle,
  parentLabel,
  rows,
  titleLabel,
}: {
  exportTitle: string;
  parentLabel: string | null;
  rows: SourceOfSalesDashboardGroup[];
  titleLabel: string;
}) {
  const hasParent = parentLabel !== null;
  const columns = hasParent
    ? [titleLabel, parentLabel, "Rows", "Qty", "B. Qty", "Value"]
    : [titleLabel, "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) =>
    hasParent
      ? [
          cellDisplay(row.label),
          cellDisplay(row.line),
          formatNumber(row.rowCount),
          numberWithDecimals(row.totalQty),
          numberWithDecimals(row.totalBonusQty),
          formatCurrency(row.totalValue),
        ]
      : [
          cellDisplay(row.label),
          formatNumber(row.rowCount),
          numberWithDecimals(row.totalQty),
          numberWithDecimals(row.totalBonusQty),
          formatCurrency(row.totalValue),
        ],
  );
  const exportColumns: ExportColumn[] = [
    { key: "name", label: titleLabel },
    ...(hasParent ? [{ key: "parent", label: parentLabel }] : []),
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    name: row.label,
    ...(hasParent ? { parent: row.line } : {}),
    rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle={exportTitle} rows={mapped} />;
}

function DashboardDistributorTable({ rows }: { rows: SourceOfSalesDashboardDistributor[] }) {
  const columns = ["Distributor", "Code", "Sheets", "Rows", "Qty", "B. Qty", "Value"];
  const mapped = rows.map((row) => [
    row.distributorName,
    row.distributorCode,
    formatNumber(row.sheetCount),
    formatNumber(row.rowCount),
    numberWithDecimals(row.totalQty),
    numberWithDecimals(row.totalBonusQty),
    formatCurrency(row.totalValue),
  ]);
  const exportColumns: ExportColumn[] = [
    { key: "name", label: "Distributor" },
    { key: "code", label: "Code" },
    { key: "sheets", label: "Sheets", numeric: true },
    { key: "rows", label: "Rows", numeric: true },
    { key: "qty", label: "Qty", numeric: true },
    { key: "bqty", label: "B. Qty", numeric: true },
    { key: "value", label: "Value", numeric: true },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    name: row.distributorName, code: row.distributorCode, sheets: row.sheetCount, rows: row.rowCount, qty: row.totalQty, bqty: row.totalBonusQty, value: row.totalValue,
  }));
  return <SummaryTable columns={columns} exportColumns={exportColumns} exportRows={exportRows} exportTitle="Source of Sales — By Distributor" rows={mapped} />;
}

type SummaryEntry = { display: string[]; raw: ExportRow | null; index: number };

function SummaryTable({
  columns,
  exportColumns,
  exportRows,
  exportTitle,
  rows,
}: {
  columns: string[];
  exportColumns?: ExportColumn[];
  exportRows?: ExportRow[];
  exportTitle?: string;
  rows: string[][];
}) {
  // Keep each display row glued to its raw export row so sort + filter never desync the two.
  const combined = useMemo<SummaryEntry[]>(
    () => rows.map((display, index) => ({ display, raw: exportRows?.[index] ?? null, index })),
    [rows, exportRows],
  );
  // Sort reads the RAW export value (numeric-aware) when available, never the formatted string.
  const table = useSortableTable(combined, {
    columns: columns.map((_, i) => {
      const exp = exportColumns?.[i];
      return {
        key: String(i),
        type: (exp?.numeric ? "number" : "string") as "number" | "string",
        accessor: (entry: SummaryEntry) => (exp && entry.raw ? entry.raw[exp.key] : entry.display[i]),
      };
    }),
    searchAccessors: columns.map((_, i) => (entry: SummaryEntry) => entry.display[i]),
    initialSort: null,
  });
  const exportFilteredRows = table.rows.map((entry) => entry.raw).filter((row): row is ExportRow => row !== null);
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? table.rows : table.rows.slice(0, SUMMARY_TABLE_ROW_CAP);
  const hiddenCount = table.rows.length - visibleRows.length;
  // Read once so the mobile sort control can use it without a non-null assertion.
  const activeSort = table.sort;

  return (
    <div className="space-y-0 p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-[200px] max-w-xs flex-1">
          <TableSearchInput
            value={table.query}
            onChange={table.setQuery}
            onClear={table.clearQuery}
            placeholder="Filter rows..."
            size="sm"
          />
        </div>
        <div className="flex items-center gap-2">
          {table.isFiltered && (
            <span className="text-xs text-phx-ink-soft">
              <Filter className="mr-1 inline h-3 w-3" />
              {table.visible} of {table.total}
            </span>
          )}
          {exportColumns && exportTitle && exportRows && (
            <ExportXlsxButton columns={exportColumns} rows={exportFilteredRows} title={exportTitle} />
          )}
        </div>
      </div>
      {/* Below `md` these five-to-eight columns get about 40px each, so the same rows render as
          cards — the admin shell's own rule, desktop tables and mobile cards. The sort that lives
          in the header on a laptop moves to a control above the cards, so a phone loses neither
          the data nor the ordering. Measured at 375px: the table wanted 760px in a 273px column
          and the scroll wrapper around it WAS the sideways scroll. */}
      <div className="border border-phx-line md:hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-phx-line bg-phx-paper px-3 py-2">
          <span className="text-phx-sm font-bold uppercase tracking-[0.12em] text-phx-ink-faint">Sort by</span>
          <SearchableSelect
            className="h-8 px-2 text-xs"
            onChange={(event) => table.toggleSort(event.target.value)}
            value={table.sort ? table.sort.key : ""}
          >
            <option value="">Sheet order</option>
            {columns.map((column, i) => (
              <option key={column} value={String(i)}>{column}</option>
            ))}
          </SearchableSelect>
          {activeSort ? (
            <button
              aria-label={`Sort ${activeSort.dir === "asc" ? "descending" : "ascending"}`}
              className="border border-phx-line bg-white px-2 py-1 text-xs font-bold text-phx-ink-soft"
              onClick={() => table.toggleSort(activeSort.key)}
              type="button"
            >
              {activeSort.dir === "asc" ? "▲ Ascending" : "▼ Descending"}
            </button>
          ) : null}
        </div>
        {table.rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-phx-ink-faint">
            {table.isFiltered ? "No rows match the filter." : "No data."}
          </p>
        ) : (
          <div className="divide-y divide-phx-line">
            {visibleRows.map((entry) => (
              <div className="px-3 py-3" key={`card:${entry.display.join(":")}:${entry.index}`}>
                {entry.display.map((cell, cellIndex) => (
                  <div className="flex gap-2 py-0.5" key={`${cell}:${cellIndex}`}>
                    <span className="w-20 shrink-0 pt-0.5 text-phx-sm font-bold uppercase tracking-[0.12em] text-phx-ink-faint">
                      {columns[cellIndex]}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 break-words text-sm",
                        cellIndex === 0 ? "font-semibold text-phx-ink" : "text-phx-ink-soft",
                      )}
                    >
                      {cell}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className="px-3 py-3 text-center">
                <button
                  className="text-sm font-semibold text-phx-accent hover:underline"
                  onClick={() => setShowAll(true)}
                  type="button"
                >
                  Show all {table.rows.length} rows ({hiddenCount} more)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="hidden overflow-hidden border border-phx-line md:block">
        <div>
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              {columns.map((column) => (
                <col key={column} style={{ width: `${100 / columns.length}%` }} />
              ))}
            </colgroup>
            <thead className="bg-phx-paper">
              <tr>
                {columns.map((column, i) => (
                  <SortableTh
                    key={column}
                    label={column}
                    sortKey={String(i)}
                    sort={table.sort}
                    onSort={table.toggleSort}
                    variant="light"
                    className="text-xs"
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {table.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-phx-ink-faint" colSpan={columns.length}>
                    {table.isFiltered ? "No rows match the filter." : "No data."}
                  </td>
                </tr>
              ) : (
                <>
                  {visibleRows.map((entry) => (
                    <tr className="text-phx-ink-soft" key={`${entry.display.join(":")}:${entry.index}`}>
                      {entry.display.map((cell, cellIndex) => (
                        <td
                          className={cn(
                            "break-words px-4 py-2.5 align-top",
                            cellIndex === 0 ? "font-semibold text-phx-ink" : "",
                          )}
                          key={`${cell}:${cellIndex}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {hiddenCount > 0 && (
                    <tr>
                      <td className="px-4 py-3 text-center" colSpan={columns.length}>
                        <button
                          className="text-sm font-semibold text-phx-accent hover:underline"
                          onClick={() => setShowAll(true)}
                          type="button"
                        >
                          Show all {table.rows.length} rows ({hiddenCount} more)
                        </button>
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function IssueTable({ issues }: { issues: DistributorSalesValidationIssue[] }) {
  const failedIssues = issues.filter((issue) => issue.severity === "failure");
  if (failedIssues.length === 0) return null;

  return (
    <AdminTableShell
      description="Rows that must be corrected in the workbook."
      title="Rows To Fix"
    >
      <div className="p-4 md:p-5">
        <CrmTable columns={["12%", "20%", "30%", "38%"]}>
          <thead className="bg-phx-paper">
            <tr>
              <th className={tableHeaderClassName}>Row</th>
              <th className={tableHeaderClassName}>Field</th>
              <th className={tableHeaderClassName}>Value</th>
              <th className={tableHeaderClassName}>Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {failedIssues.slice(0, 100).map((issue, index) => (
              <tr className="text-phx-ink-soft" key={`${issue.rowNumber}:${issue.field}:${index}`}>
                <td className="px-4 py-3 align-top font-semibold tabular-nums text-phx-ink">{issue.rowNumber}</td>
                <td className="break-words px-4 py-3 align-top">{issue.field}</td>
                <td className="break-words px-4 py-3 align-top">{issue.value ?? "—"}</td>
                <td className="break-words px-4 py-3 align-top">{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
        <CrmCardsOnPhone>
          {failedIssues.slice(0, 100).map((issue, index) => (
            <CrmCard key={`${issue.rowNumber}:${issue.field}:${index}:card`} title={`Row ${issue.rowNumber} · ${issue.field}`}>
              <CrmFacts
                facts={[
                  ...(issue.value ? [{ label: "Value", value: issue.value }] : []),
                  { label: "Error", value: issue.message },
                ]}
              />
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
        {failedIssues.length > 100 ? (
          <p className="mt-3 text-xs text-phx-ink-soft">Showing the first 100 of {failedIssues.length} rows to fix.</p>
        ) : null}
      </div>
    </AdminTableShell>
  );
}

function UploadedSheetsTable({
  batches,
  deleteLoadingId,
  onDelete,
  onRefresh,
  refreshing,
}: {
  batches: SourceOfSalesUploadBatch[];
  deleteLoadingId: string | null;
  onDelete: (batchId: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [distributorFilter, setDistributorFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState<string[]>([]);

  // Distinct distributors + periods present across the uploaded sheets — drives the filter controls.
  const distributorOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const batch of batches) {
      if (batch.distributorCode) map.set(batch.distributorCode, batch.distributorName || batch.distributorCode);
    }
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [batches]);

  const periodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const batch of batches) if (batch.period) set.add(batch.period);
    return [...set].sort((a, b) => b.localeCompare(a)); // newest period first
  }, [batches]);

  const filtered = useMemo(
    () =>
      batches.filter((batch) => {
        if (distributorFilter !== "all" && batch.distributorCode !== distributorFilter) return false;
        if (periodFilter.length > 0 && !(batch.period && periodFilter.includes(batch.period))) return false;
        return true;
      }),
    [batches, distributorFilter, periodFilter],
  );

  const togglePeriod = (period: string) =>
    setPeriodFilter((current) => (current.includes(period) ? current.filter((value) => value !== period) : [...current, period]));
  const hasFilters = distributorFilter !== "all" || periodFilter.length > 0;
  const clearFilters = () => {
    setDistributorFilter("all");
    setPeriodFilter([]);
  };

  return (
    <AdminTableShell
      action={(
        <Button className="gap-2" disabled={refreshing} onClick={onRefresh} variant="secondary">
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      )}
      description="Every uploaded Source of Sales workbook can be removed from the new module without touching old sales tables."
      title="Uploaded Sheets"
    >
      {batches.length === 0 ? (
        <div className="p-4 md:p-5">
          <AdminCallout tone="neutral">
            <FileSpreadsheet className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-semibold">No Source of Sales sheets uploaded yet</p>
              <p className="text-sm">Upload a distributor monthly workbook to start the new module history.</p>
            </div>
          </AdminCallout>
        </div>
      ) : (
        <div className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[12px] border border-phx-line bg-phx-paper p-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              <Filter className="h-3.5 w-3.5" /> Filter
            </span>
            <label className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-phx-ink-soft">Distributor</span>
              <SearchableSelect
                className="h-9 px-3"
                onChange={(event) => setDistributorFilter(event.target.value)}
                value={distributorFilter}
              >
                <option value="all">All distributors</option>
                {distributorOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name}
                  </option>
                ))}
              </SearchableSelect>
            </label>
            {periodOptions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-phx-ink-soft">Period</span>
                {periodOptions.map((period) => {
                  const active = periodFilter.includes(period);
                  return (
                    <button
                      className={cn(
                        "h-7 rounded-full border px-2.5 text-xs font-bold transition",
                        active
                          ? "border-phx-accent bg-phx-accent text-white"
                          : "border-phx-line bg-white text-phx-ink hover:border-phx-accent",
                      )}
                      key={period}
                      onClick={() => togglePeriod(period)}
                      type="button"
                    >
                      {period}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {hasFilters ? (
              <Button className="h-8 gap-1" onClick={clearFilters} type="button" variant="secondary">
                Clear
              </Button>
            ) : null}
            <span className="ml-auto text-xs font-semibold text-phx-ink-soft">
              Showing {formatNumber(filtered.length)} of {formatNumber(batches.length)}
            </span>
          </div>

          {filtered.length === 0 ? (
            <AdminCallout tone="neutral">
              <Filter className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-semibold">No uploaded sheets match these filters</p>
                <p className="text-sm">Adjust the distributor or period filters, or clear them to see all {formatNumber(batches.length)} sheets.</p>
              </div>
            </AdminCallout>
          ) : (
            <div>
              {/* Ten columns do not fit a laptop. Qty and B. Qty MERGE into one Quantity
                  cell, and the four detail columns fold into the File cell below lg, so
                  nothing is dropped at either width. */}
              <div className="overflow-hidden rounded-[16px] border border-phx-line">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[40%] lg:w-[20%]" />
                    <col className="hidden lg:table-column lg:w-[14%]" />
                    <col className="hidden lg:table-column lg:w-[8%]" />
                    <col className="w-[22%] lg:w-[10%]" />
                    <col className="hidden lg:table-column lg:w-[8%]" />
                    <col className="hidden lg:table-column lg:w-[11%]" />
                    <col className="w-[22%] lg:w-[11%]" />
                    <col className="hidden lg:table-column lg:w-[10%]" />
                    <col className="w-[16%] lg:w-[8%]" />
                  </colgroup>
                  <thead className="bg-phx-paper">
                    <tr>
                      <th className={tableHeaderClassName}>File</th>
                      <th className={`${tableHeaderClassName} hidden lg:table-cell`}>Distributor</th>
                      <th className={`${tableHeaderClassName} hidden lg:table-cell`}>Period</th>
                      <th className={tableHeaderClassName}>Status</th>
                      <th className={`${tableHeaderClassName} hidden lg:table-cell`}>Rows</th>
                      <th className={`${tableHeaderClassName} hidden lg:table-cell`}>Quantity</th>
                      <th className={tableHeaderClassName}>Value</th>
                      <th className={`${tableHeaderClassName} hidden lg:table-cell`}>Uploaded</th>
                      <th className={tableHeaderClassName}>Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-phx-line">
                    {filtered.map((batch) => {
                      const deleting = deleteLoadingId === batch.batchId;
                      return (
                        <tr className="text-phx-ink-soft" key={batch.batchId}>
                          <td className="px-4 py-3 align-top">
                            <p className="break-words font-semibold text-phx-ink">{batch.fileName}</p>
                            <p className="mt-1 break-words text-xs text-phx-ink-soft">{batch.uploadedBy}</p>
                            <p className="mt-1 break-words text-xs text-phx-ink-soft lg:hidden">
                              {batch.distributorName} · {batch.period ?? "—"}
                            </p>
                            <p className="mt-0.5 text-xs tabular-nums text-phx-ink-soft lg:hidden">
                              {formatNumber(batch.rowCount)} rows · {numberWithDecimals(batch.totalQty)} qty
                              {" · "}{numberWithDecimals(batch.totalBonusQty)} bonus
                            </p>
                            <p className="mt-0.5 text-xs text-phx-ink-soft lg:hidden">{new Date(batch.createdAt).toLocaleString()}</p>
                          </td>
                          <td className="hidden break-words px-4 py-3 align-top lg:table-cell">{batch.distributorName}</td>
                          <td className="hidden px-4 py-3 align-top lg:table-cell">{batch.period ?? "—"}</td>
                          <td className="px-4 py-3 align-top">
                            <Badge variant={batch.status === "validated" ? "success" : "danger"}>
                              {humanizeCode(batch.status)}
                            </Badge>
                          </td>
                          <td className="hidden px-4 py-3 align-top tabular-nums lg:table-cell">{formatNumber(batch.rowCount)}</td>
                          <td className="hidden px-4 py-3 align-top tabular-nums lg:table-cell">
                            <span className="block">{numberWithDecimals(batch.totalQty)}</span>
                            <span className="block text-xs text-phx-ink-soft">bonus {numberWithDecimals(batch.totalBonusQty)}</span>
                          </td>
                          <td className="break-words px-4 py-3 align-top tabular-nums">{formatCurrency(batch.totalValue)}</td>
                          <td className="hidden break-words px-4 py-3 align-top lg:table-cell">{new Date(batch.createdAt).toLocaleString()}</td>
                          <td className="px-4 py-3 align-top">
                            <Button
                              className="gap-1"
                              disabled={deleting}
                              onClick={() => onDelete(batch.batchId)}
                              variant="destructive"
                            >
                              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                              Delete
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </AdminTableShell>
  );
}

function SourceOfSalesDashboardPanel({
  dashboard,
  dashboardError,
  onPeriodChange,
  onRefresh,
  refreshing,
}: {
  dashboard: SourceOfSalesDashboard | null;
  dashboardError: string | null;
  onPeriodChange: (period: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (!dashboard) {
    if (!dashboardError) {
      return (
        <AdminCallout tone="neutral">
          <Info className="mt-0.5 h-4 w-4" />
          <p>No data for this period yet — upload and validate your first distributor sheet to see the dashboard.</p>
        </AdminCallout>
      );
    }
    return (
      <AdminCallout tone="danger">
        <AlertTriangle className="mt-0.5 h-4 w-4" />
        <p>Dashboard data could not be loaded.</p>
      </AdminCallout>
    );
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row">
            <SearchableSelect
              className="px-3"
              disabled={dashboard.availablePeriods.length === 0 || refreshing}
              onChange={(event) => onPeriodChange(event.target.value)}
              value={dashboard.period ?? ""}
            >
              {dashboard.availablePeriods.length === 0 ? (
                <option value="">No validated month</option>
              ) : dashboard.availablePeriods.map((period) => (
                <option key={period} value={period}>{period}</option>
              ))}
            </SearchableSelect>
            <Button className="gap-2" disabled={refreshing} onClick={onRefresh} variant="secondary">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        )}
        description="Validated monthly distributor sheets aggregated by the new Source of Sales allocation fields."
        title="Monthly Source Dashboard"
      >
        <div className="space-y-5 p-4 md:p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Period" value={dashboard.period ?? "No validated data"} />
            <Metric label="Validated Sheets" value={formatNumber(dashboard.sheetCount)} />
            <Metric label="Total Qty" value={numberWithDecimals(dashboard.totals.totalQty)} />
            <Metric label="Total B. Qty" value={numberWithDecimals(dashboard.totals.totalBonusQty)} />
            <Metric label="Total Value" value={formatCurrency(dashboard.totals.totalValue)} />
            <Metric label="Lines" value={formatNumber(dashboard.byLine.length)} />
            <Metric label="Regions" value={formatNumber(dashboard.byRegion.length)} />
            <Metric label="Bricks" value={formatNumber(dashboard.byBrick.length)} />
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell description="Totals across all validated distributor sheets for the selected month." title="By Distributor">
        <DashboardDistributorTable rows={dashboard.byDistributor} />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by official line." title="By Line">
        <DashboardGroupTable exportTitle="Dashboard — By Line" parentLabel={null} rows={dashboard.byLine} titleLabel="Line" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by region." title="By Region">
        <DashboardGroupTable exportTitle="Dashboard — By Region" parentLabel={null} rows={dashboard.byRegion} titleLabel="Region" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by area." title="By Area">
        <DashboardGroupTable exportTitle="Dashboard — By Area" parentLabel="Region" rows={dashboard.byArea} titleLabel="Area" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by product." title="By Product">
        <DashboardGroupTable exportTitle="Dashboard — By Product" parentLabel="Line" rows={dashboard.byProduct} titleLabel="Product" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by brick." title="By Brick">
        <DashboardGroupTable exportTitle="Dashboard — By Brick" parentLabel="Area" rows={dashboard.byBrick} titleLabel="Brick" />
      </AdminTableShell>
    </div>
  );
}

function StepCircle({ number, done, active }: { active?: boolean; done?: boolean; number: number }) {
  return (
    <div
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black",
        done ? "bg-emerald-500 text-white" : active ? "bg-[#0B0B0B] text-white" : "bg-phx-line text-phx-ink-soft",
      )}
    >
      {done ? <CheckCircle2 className="h-4 w-4" /> : number}
    </div>
  );
}

function UploadStatusPanel({
  batches,
  distributors,
  onSelectDistributor,
}: {
  batches: SourceOfSalesUploadBatch[];
  distributors: SalesDistributorOption[];
  onSelectDistributor: (code: string) => void;
}) {
  const periodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const batch of batches) if (batch.period) set.add(batch.period);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [batches]);

  const [selectedPeriod, setSelectedPeriod] = useState(() => periodOptions[0] ?? "");

  const validatedCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const batch of batches) {
      if (batch.status === "validated" && batch.period === selectedPeriod && batch.distributorCode) {
        codes.add(batch.distributorCode);
      }
    }
    return codes;
  }, [batches, selectedPeriod]);

  const validatedCount = distributors.filter((d) => validatedCodes.has(d.code)).length;

  return (
    <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line bg-phx-paper px-6 py-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Upload Status</p>
          <p className="mt-0.5 text-sm font-semibold text-phx-ink">
            {periodOptions.length === 0
              ? "No uploads yet"
              : `${validatedCount} of ${distributors.length} distributors validated`}
            {selectedPeriod ? ` — ${selectedPeriod}` : ""}
          </p>
        </div>
        {periodOptions.length > 0 ? (
          <SearchableSelect
            className="h-9 px-3"
            onChange={(e) => setSelectedPeriod(e.target.value)}
            value={selectedPeriod}
          >
            {periodOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </SearchableSelect>
        ) : null}
      </div>
      <div className="p-5">
        {distributors.length === 0 ? (
          <p className="text-sm text-phx-ink-soft">No distributors configured.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {distributors.map((d) => {
              const done = validatedCodes.has(d.code);
              return (
                <button
                  className={cn(
                    "flex items-center gap-3 rounded-2xl border p-3 text-left transition",
                    done
                      ? "border-emerald-200 bg-emerald-50 hover:border-emerald-300"
                      : "border-phx-line bg-phx-paper hover:border-phx-accent/40 hover:bg-phx-accent-soft/60",
                  )}
                  key={d.code}
                  onClick={() => { if (!done) onSelectDistributor(d.code); }}
                  title={done ? `${d.name} validated for ${selectedPeriod}` : `Click to select ${d.name} for upload`}
                  type="button"
                >
                  {done
                    ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    : <Clock className="h-4 w-4 shrink-0 text-phx-ink-faint" />}
                  <div className="min-w-0">
                    <p className={cn("truncate text-xs font-black", done ? "text-emerald-800" : "text-phx-ink")}>{d.name}</p>
                    <p className={cn("text-phx-xs font-semibold", done ? "text-emerald-600" : "text-phx-ink-soft")}>{d.code} · {done ? "Validated ✓" : "Pending"}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

type SourceOfSalesTab = "approvals" | "channels-by-rep" | "coverage" | "customers" | "dashboard" | "mapping" | "monthly-sales" | "products" | "sheets";

export function SalesImportWorkspace({ distributors, initialBatches, initialDashboard, initialError, initialProducts, mappingReferences, profiledDistributorCodes, initialTab, initialProductsSearch, initialQueue, initialQueueError }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultDistributor = useMemo(
    () => distributors.find((distributor) => distributor.code.toUpperCase() === "PS") ?? distributors[0] ?? null,
    [distributors],
  );

  const [selectedDistributorCode, setSelectedDistributorCode] = useState(defaultDistributor?.code ?? "");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [batches, setBatches] = useState(initialBatches);
  const [activeTab, setActiveTab] = useState<SourceOfSalesTab>(initialTab ?? "dashboard");
  const [dashboard, setDashboard] = useState<SourceOfSalesDashboard | null>(initialDashboard);
  const [productsCount, setProductsCount] = useState(initialProducts.length);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [isValidating, setIsValidating] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [pendingStoragePath, setPendingStoragePath] = useState<string | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detection, setDetection] = useState<{ text: string; tone: "good" | "info" } | null>(null);
  const [isRefreshingDashboard, setIsRefreshingDashboard] = useState(false);
  const [isRefreshingBatches, setIsRefreshingBatches] = useState(false);
  const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  const selectedDistributor = distributors.find((distributor) => distributor.code === selectedDistributorCode) ?? defaultDistributor;
  async function readJsonResponse(response: Response): Promise<ValidationResponse> {
    const text = await response.text();
    if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText };
    try {
      return JSON.parse(text) as ValidationResponse;
    } catch {
      return { success: false, error: text };
    }
  }

  async function readBatchListResponse(response: Response): Promise<BatchListResponse> {
    const text = await response.text();
    if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText };
    try {
      return JSON.parse(text) as BatchListResponse;
    } catch {
      return { success: false, error: text };
    }
  }

  async function readDashboardResponse(response: Response): Promise<DashboardResponse> {
    const text = await response.text();
    if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText };
    try {
      return JSON.parse(text) as DashboardResponse;
    } catch {
      return { success: false, error: text };
    }
  }

  async function reloadDashboard(period?: string | null) {
    setIsRefreshingDashboard(true);
    try {
      const query = period ? `?period=${encodeURIComponent(period)}` : "";
      const response = await fetch(`/api/sales/monthly-import/dashboard${query}`, { cache: "no-store" });
      const payload = await readDashboardResponse(response);
      if (payload.success && payload.data) {
        setDashboard(payload.data);
      } else {
        setActionMessage({ type: "error", text: payload.error ?? "Failed to refresh Source of Sales dashboard." });
      }
    } catch (caught) {
      setActionMessage({
        type: "error",
        text: caught instanceof Error ? caught.message : "Failed to refresh Source of Sales dashboard.",
      });
    } finally {
      setIsRefreshingDashboard(false);
    }
  }

  async function reloadBatches() {
    setIsRefreshingBatches(true);
    try {
      const response = await fetch("/api/sales/monthly-import/batches", { cache: "no-store" });
      const payload = await readBatchListResponse(response);
      if (payload.success) {
        setBatches(payload.data ?? []);
      } else {
        setActionMessage({ type: "error", text: payload.error ?? "Failed to refresh uploaded sheets." });
      }
    } catch (caught) {
      setActionMessage({
        type: "error",
        text: caught instanceof Error ? caught.message : "Failed to refresh uploaded sheets.",
      });
    } finally {
      setIsRefreshingBatches(false);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    const target = batches.find((batch) => batch.batchId === batchId);
    if (!window.confirm(`Delete uploaded sheet${target ? ` "${target.fileName}"` : ""}?`)) return;

    setDeleteLoadingId(batchId);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/sales/monthly-import/batches/${batchId}`, { method: "DELETE" });
      const payload = await readBatchListResponse(response);
      if (payload.success) {
        setActionMessage({ type: "success", text: "Uploaded sheet deleted." });
        setBatches((current) => current.filter((batch) => batch.batchId !== batchId));
        if (result?.batchId === batchId) setResult(null);
        await reloadDashboard(dashboard?.period);
      } else {
        setActionMessage({ type: "error", text: payload.error ?? "Delete failed." });
      }
    } catch (caught) {
      setActionMessage({ type: "error", text: caught instanceof Error ? caught.message : "Delete failed." });
    } finally {
      setDeleteLoadingId(null);
    }
  }

  // On file select: remember the file, then auto-detect the distributor from its header row so the
  // user doesn't have to pick (and a wrong manual pick gets corrected). Detection is a convenience —
  // any failure is silent and the manual dropdown still governs. Large files skip detection (they
  // upload to Storage only at preview time); the preview's distributor advisory remains the safety net.
  async function handleFileChosen(file: File | null) {
    setSelectedFile(file);
    setResult(null);
    setError(null);
    setDetection(null);
    const stale = pendingStoragePath;
    setPendingStoragePath(null);
    if (stale) {
      void fetch("/api/sales/monthly-import/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storagePath: stale }),
      }).catch(() => {});
    }
    if (!file) return;

    const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024;
    if (file.size > LARGE_FILE_THRESHOLD) return;

    setIsDetecting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/sales/monthly-import/detect", { body: formData, method: "POST" });
      const payload = (await response.json().catch(() => ({ success: false }))) as {
        success: boolean;
        data?: {
          ambiguous: boolean;
          best: { distributorCode: string; distributorName: string } | null;
          confidence: "high" | "low" | "none";
          matches: { distributorCode: string; distributorName: string }[];
        };
      };
      if (!payload.success || !payload.data) return;
      const { best, confidence, matches } = payload.data;
      if (best && confidence === "high" && distributors.some((d) => d.code === best.distributorCode)) {
        if (best.distributorCode !== selectedDistributorCode) {
          setSelectedDistributorCode(best.distributorCode);
          setDetection({ text: `Auto-selected ${best.distributorName} (${best.distributorCode}) from the file's columns.`, tone: "good" });
        } else {
          setDetection({ text: `Confirmed ${best.distributorName} (${best.distributorCode}) from the file's columns.`, tone: "good" });
        }
      } else if (matches.length > 1) {
        setDetection({ text: `Couldn't auto-detect — the columns match ${matches.length} distributors. Please confirm the distributor above.`, tone: "info" });
      }
      // confidence "none" → stay silent (unrecognized layout; the user picks manually).
    } catch {
      // Non-blocking: detection is a convenience only.
    } finally {
      setIsDetecting(false);
    }
  }

  // Step 1 of the mandatory preview → confirm flow: validate the upload WITHOUT persisting, then open
  // the preview modal. For large files the workbook is uploaded to Storage first; its path is kept so
  // Confirm can reuse it (no re-upload).
  async function handlePreview() {
    if (!selectedFile || !selectedDistributorCode) return;

    setIsValidating(true);
    setError(null);
    setResult(null);
    setPendingStoragePath(null);

    // Large workbooks (> ~4MB) cannot be POSTed through the serverless function — Vercel caps the request
    // body at ~4.5MB (FUNCTION_PAYLOAD_TOO_LARGE). Those upload straight to Storage via a short-lived
    // signed URL, then preview by reference. Small files keep the original direct multipart POST.
    const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024;

    try {
      let response: Response;
      let storagePath: string | null = null;
      if (selectedFile.size > LARGE_FILE_THRESHOLD) {
        const urlResponse = await fetch("/api/sales/monthly-import/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileName: selectedFile.name }),
        });
        const urlPayload = (await urlResponse.json().catch(() => ({}))) as {
          signedUrl?: string;
          path?: string;
          error?: string;
        };
        if (!urlResponse.ok || !urlPayload.signedUrl || !urlPayload.path) {
          throw new Error(urlPayload.error ?? "Could not start the upload for this large file.");
        }
        const putResponse = await fetch(urlPayload.signedUrl, {
          method: "PUT",
          headers: {
            "content-type": selectedFile.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "x-upsert": "false",
          },
          body: selectedFile,
        });
        if (!putResponse.ok) {
          throw new Error("The file could not be uploaded. Please try again.");
        }
        storagePath = urlPayload.path;
        response = await fetch("/api/sales/monthly-import/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storagePath: urlPayload.path, distributorCode: selectedDistributorCode, period: selectedPeriod }),
        });
      } else {
        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("distributorCode", selectedDistributorCode);
        if (selectedPeriod) formData.append("period", selectedPeriod);
        response = await fetch("/api/sales/monthly-import/preview", {
          body: formData,
          method: "POST",
        });
      }
      const payload = await readJsonResponse(response);
      const data = payload.data ?? null;
      setResult(data);
      setPendingStoragePath(storagePath);
      if (!payload.success && !data) {
        setError(payload.error ?? "Preview failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Preview failed.");
    } finally {
      setIsValidating(false);
    }
  }

  // Step 2: persist the upload the user just previewed. Reuses the kept Storage object for large files.
  async function handleConfirmImport() {
    if (!selectedFile || !selectedDistributorCode || result?.status !== "validated") return;

    setIsCommitting(true);
    setError(null);

    try {
      let response: Response;
      if (pendingStoragePath) {
        response = await fetch("/api/sales/monthly-import/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            distributorCode: selectedDistributorCode,
            period: selectedPeriod,
            previewDiff: result?.previewDiff ?? null,
            storagePath: pendingStoragePath,
            unmappedCustomers: result?.unmappedCustomers ?? [],
          }),
        });
      } else {
        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("distributorCode", selectedDistributorCode);
        if (selectedPeriod) formData.append("period", selectedPeriod);
        // Carry the reviewed diff + unmapped details so a coverage snapshot is recorded for small
        // files too (not just large/Storage uploads).
        if (result?.previewDiff) formData.append("previewDiff", JSON.stringify(result.previewDiff));
        if (result?.unmappedCustomers?.length) formData.append("unmappedCustomers", JSON.stringify(result.unmappedCustomers));
        response = await fetch("/api/sales/monthly-import/commit", { body: formData, method: "POST" });
      }
      const payload = await readJsonResponse(response);
      const data = payload.data ?? null;
      if (payload.success && data?.batchId) {
        setResult(data);
        setPendingStoragePath(null);
        await reloadBatches();
        await reloadDashboard(data.period ?? null);
        const periodLabel = data.period ?? "an undated period (check the sheet's dates)";
        const distributorLabel = data.distributor?.name ?? selectedDistributorCode;
        setActionMessage({
          type: "success",
          text: `Saved ${formatNumber(data.rowCount)} rows — ${formatCurrency(data.totals.totalValue)} for ${periodLabel} (${distributorLabel}). Dashboard updated.`,
        });
        setActiveTab("dashboard");
      } else {
        if (data) setResult(data);
        setError(payload.error ?? "Import failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setIsCommitting(false);
    }
  }

  if (initialError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const stepVerified = Boolean(selectedFile && selectedDistributorCode);
  const stepValidated = result?.status === "validated";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <div className="relative overflow-hidden rounded-3xl border border-phx-line bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                <Database className="h-3.5 w-3.5 text-orange-600" />
                <span className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">Source of Sales</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-3xl font-black tracking-tight text-slate-950">Source of Sales</h1>
                  <p className="mt-1 max-w-3xl text-sm text-slate-500">
                    Validate distributor files against the region, product, and distributor source-of-truth tables.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Link href="/sales">
                <Button className="gap-2 rounded-xl bg-[#0B0B0B] font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent">
                  <Table2 className="h-4 w-4" />
                  Dashboard
                </Button>
              </Link>
              <Link href="/sales/import?tab=approvals">
                <Button className="gap-2" variant="secondary">
                  <Package className="h-4 w-4" />
                  Old Queue
                </Button>
              </Link>
            </div>
          </div>
          <div className="relative mt-5 flex flex-wrap gap-2 border-t border-phx-line pt-4">
            <AdminInsightChip>Distributors: {formatNumber(distributors.length)}</AdminInsightChip>
            <AdminInsightChip>Uploaded sheets: {formatNumber(batches.length)}</AdminInsightChip>
            <AdminInsightChip>Products: {formatNumber(productsCount)}</AdminInsightChip>
            <AdminInsightChip>Dashboard month: {dashboard?.period ?? "No validated data"}</AdminInsightChip>
            {selectedDistributor ? <AdminInsightChip tone="orange">{selectedDistributor.name} / {selectedDistributor.code}</AdminInsightChip> : null}
            <AdminInsightChip tone="slate">New source tables</AdminInsightChip>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-phx-line bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "dashboard" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("dashboard")}
            variant="secondary"
          >
            <BarChart3 className="h-4 w-4" />
            Dashboard
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "monthly-sales" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("monthly-sales")}
            variant="secondary"
          >
            <ListChecks className="h-4 w-4" />
            Monthly Sales
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "sheets" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("sheets")}
            variant="secondary"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Upload &amp; Status
          </Button>
          {/* Batch review/approve — the retired Sales Queue's workflow, now a tab here. */}
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "approvals" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("approvals")}
            variant="secondary"
          >
            <ClipboardCheck className="h-4 w-4" />
            Approvals
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "mapping" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("mapping")}
            variant="secondary"
          >
            <Database className="h-4 w-4" />
            Mapping
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "products" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("products")}
            variant="secondary"
          >
            <Package className="h-4 w-4" />
            Products Reference
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "coverage" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("coverage")}
            variant="secondary"
          >
            <TrendingUp className="h-4 w-4" />
            Coverage
          </Button>
          {/* Customers — the customer base split into Pharmacies and Stores by name keyword. */}
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "customers" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("customers")}
            variant="secondary"
          >
            <Users className="h-4 w-4" />
            Customers
          </Button>
          {/* Channels by Rep — the same three channels, but per rep instead of per customer. */}
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "channels-by-rep" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
            )}
            onClick={() => setActiveTab("channels-by-rep")}
            variant="secondary"
          >
            <UserSquare className="h-4 w-4" />
            Channels by Rep
          </Button>
        </div>

        {actionMessage ? (
          <AdminCallout tone={actionMessage.type === "success" ? "success" : "danger"}>
            {actionMessage.type === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4" />
            )}
            <p>{actionMessage.text}</p>
          </AdminCallout>
        ) : null}

        {activeTab === "dashboard" ? (
          <SourceOfSalesDashboardPanel
            dashboard={dashboard}
            dashboardError={dashboard === null ? (initialError ?? null) : null}
            onPeriodChange={(period) => void reloadDashboard(period)}
            onRefresh={() => void reloadDashboard(dashboard?.period)}
            refreshing={isRefreshingDashboard}
          />
        ) : activeTab === "monthly-sales" ? (
          <MonthlySalesWizard bricks={mappingReferences.bricks} products={mappingReferences.products} />
        ) : activeTab === "approvals" ? (
          <SalesQueue initialData={initialQueue} initialError={initialQueueError} />
        ) : activeTab === "sheets" ? (
          <>
            {/* Upload Status: shows which distributors have validated for the selected period */}
            <UploadStatusPanel
              batches={batches}
              distributors={distributors}
              onSelectDistributor={(code) => { setSelectedDistributorCode(code); setResult(null); setError(null); setDetection(null); }}
            />

            {/* 3-Step Upload Wizard */}
            <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
              <div className="border-b border-phx-line bg-phx-paper px-6 py-4">
                <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                  <UploadCloud className="h-3 w-3 text-orange-600" />
                  <span className="text-phx-sm font-black uppercase tracking-[0.18em] text-orange-600">Upload Monthly Sheet</span>
                </div>
                <p className="mt-1 text-xs text-phx-ink-soft">Pick the distributor, attach its raw export, validate, then confirm — three steps, no surprises.</p>
              </div>

              {/* Step 1 — Verify file & distributor */}
              <div className="border-b border-phx-line p-6">
                <div className="mb-5 flex items-center gap-3">
                  <StepCircle active={!stepVerified} done={stepVerified} number={1} />
                  <span className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Verify File &amp; Distributor</span>
                  {stepVerified && !result && <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-500" />}
                </div>
                <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
                  <div className="space-y-3">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">Distributor</span>
                      <SearchableSelect
                        className="w-full px-3.5"
                        onChange={(event) => { setSelectedDistributorCode(event.target.value); setDetection(null); setResult(null); }}
                        value={selectedDistributorCode}
                      >
                        {distributors.map((distributor) => (
                          <option key={distributor.code} value={distributor.code}>
                            {distributor.name} / {distributor.code}
                          </option>
                        ))}
                      </SearchableSelect>
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">
                        Period <span className="font-medium normal-case tracking-normal text-phx-ink-faint">— only if the sheet has no date</span>
                      </span>
                      <input
                        className={phxFieldClassName}
                        onChange={(event) => setSelectedPeriod(event.target.value)}
                        type="month"
                        value={selectedPeriod}
                      />
                    </label>
                  </div>
                  <div className="space-y-2">
                    <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">Workbook</span>
                    <button
                      className="flex min-h-[120px] w-full items-center justify-between gap-4 rounded-[24px] border border-dashed border-phx-line-strong bg-white px-4 py-5 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition hover:border-phx-accent hover:bg-phx-accent-soft/50"
                      onClick={() => fileInputRef.current?.click()}
                      type="button"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className={cn(
                          "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border shadow-[0_8px_20px_rgba(249,115,22,0.10)]",
                          selectedFile ? "border-emerald-200 bg-emerald-50 text-emerald-600" : "border-[#FED7AA] bg-phx-accent-soft text-phx-accent",
                        )}>
                          {selectedFile ? <CheckCircle2 className="h-5 w-5" /> : <FileSpreadsheet className="h-5 w-5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-phx-ink">
                            {selectedFile?.name ?? "Choose monthly distributor sheet"}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-phx-ink-soft">
                            {selectedFile
                              ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB — click to change`
                              : "Any distributor's raw export (.xlsx / .xls) — no coding needed."}
                          </span>
                        </span>
                      </span>
                      <UploadCloud className="h-4 w-4 shrink-0 text-phx-ink-faint" />
                    </button>
                    <input
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={(event) => void handleFileChosen(event.target.files?.[0] ?? null)}
                      ref={fileInputRef}
                      type="file"
                    />
                    {isDetecting ? (
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-phx-ink-soft">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Detecting distributor from the file…
                      </p>
                    ) : detection ? (
                      <p className={cn(
                        "flex items-center gap-1.5 text-xs font-semibold",
                        detection.tone === "good" ? "text-emerald-700" : "text-orange-700",
                      )}>
                        {detection.tone === "good" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                        {detection.text}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Step 2 — Validate */}
              <div className={cn("border-b border-phx-line p-6", !stepVerified && "opacity-50")}>
                <div className="mb-4 flex items-center gap-3">
                  <StepCircle active={stepVerified && !result} done={Boolean(result)} number={2} />
                  <span className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Validate — Per Product · Per Region · Per Brick</span>
                </div>
                {!stepVerified ? (
                  <p className="flex items-center gap-2 text-xs text-phx-ink-soft">
                    <Lock className="h-3.5 w-3.5" />
                    Complete Step 1 — pick a distributor and attach a file.
                  </p>
                ) : (
                  <Button
                    className="h-11 gap-2 bg-[#0B0B0B] font-black text-white transition hover:bg-phx-accent"
                    disabled={isValidating}
                    onClick={() => void handlePreview()}
                    type="button"
                  >
                    {isValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {result ? "Re-validate" : "Validate"}
                  </Button>
                )}
              </div>

              {/* Step 3 — Confirm (only unlocks after validation passes) */}
              <div className={cn("p-6", !stepValidated && "opacity-50")}>
                <div className="mb-4 flex items-center gap-3">
                  <StepCircle active={stepValidated} number={3} />
                  <span className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Confirm &amp; Save</span>
                </div>
                {!stepValidated ? (
                  <p className="flex items-center gap-2 text-xs text-phx-ink-soft">
                    <Lock className="h-3.5 w-3.5" />
                    {result ? "Validation blocked — fix the rows above before importing." : "Complete Step 2 — run validation first."}
                  </p>
                ) : (
                  <Button
                    className="h-11 gap-2 bg-phx-accent font-black text-white shadow-[0_8px_20px_rgba(249,115,22,0.25)] transition hover:bg-phx-accent-hover"
                    disabled={isCommitting}
                    onClick={() => void handleConfirmImport()}
                    type="button"
                  >
                    {isCommitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                    Confirm &amp; Upload
                  </Button>
                )}
              </div>
            </div>

            {/* Inline validation results — appear after Step 2 runs */}
            {result ? (
              <div className="space-y-4">
                <StatusBanner error={error} result={result} />

                {result.blockingReasons && result.blockingReasons.length > 0 ? (
                  <AdminCallout tone="danger">
                    <AlertTriangle className="mt-0.5 h-4 w-4" />
                    <div>
                      <p className="font-semibold">Why validation blocked</p>
                      <div className="mt-2 space-y-2 text-sm">
                        {result.blockingReasons.map((reason, index) => (
                          <p key={`${reason}:${index}`}>{reason}</p>
                        ))}
                      </div>
                    </div>
                  </AdminCallout>
                ) : null}

                {result.advisories && result.advisories.length > 0 ? (
                  <AdminCallout tone="neutral">
                    <AlertTriangle className="mt-0.5 h-4 w-4" />
                    <div>
                      <p className="font-semibold">Heads up — please double-check</p>
                      <div className="mt-2 space-y-2 text-sm">
                        {result.advisories.map((advisory, index) => (
                          <p key={`${advisory}:${index}`}>{advisory}</p>
                        ))}
                      </div>
                    </div>
                  </AdminCallout>
                ) : null}

                <AdminTableShell description="Summary totals from the uploaded workbook." title="Validation Totals">
                  <div className="p-4 md:p-5">
                    <TotalsGrid result={result} />
                  </div>
                </AdminTableShell>

                <AdminTableShell description="Qty, bonus quantity, and value grouped by product." title="By Product">
                  <ProductTable rows={result.byProduct} />
                </AdminTableShell>

                <AdminTableShell description="Qty, bonus quantity, and value grouped by region." title="By Region">
                  <RegionTable rows={result.byRegion} />
                </AdminTableShell>

                <AdminTableShell description="Qty, bonus quantity, and value grouped by brick with full hierarchy." title="By Brick">
                  <BrickTable rows={result.byBrick} />
                </AdminTableShell>

                <AdminTableShell description="Qty, bonus quantity, and value grouped by official product line." title="By Line">
                  <LineTable rows={result.byLine} />
                </AdminTableShell>

                <AdminTableShell description="Qty, bonus quantity, and value grouped by area and its parent region." title="By Area">
                  <AreaTable rows={result.byArea} />
                </AdminTableShell>

                <IssueTable issues={result.issues} />
              </div>
            ) : error ? (
              <StatusBanner error={error} result={null} />
            ) : null}

            {/* History of all uploaded batches */}
            <UploadedSheetsTable
              batches={batches}
              deleteLoadingId={deleteLoadingId}
              onDelete={(batchId) => void handleDeleteBatch(batchId)}
              onRefresh={() => void reloadBatches()}
              refreshing={isRefreshingBatches}
            />
          </>
        ) : activeTab === "mapping" ? (
          <SourceOfSalesMappingTab
            bricks={mappingReferences.bricks}
            distributorCode={selectedDistributorCode}
            distributors={distributors}
            onDistributorChange={setSelectedDistributorCode}
            products={mappingReferences.products}
            profiledDistributorCodes={profiledDistributorCodes}
          />
        ) : activeTab === "coverage" ? (
          <SosCoverageTab bricks={mappingReferences.bricks} />
        ) : activeTab === "channels-by-rep" ? (
          <ChannelsByRepTab />
        ) : activeTab === "customers" ? (
          <CustomersChannelTab />
        ) : (
          <SourceOfSalesProductsTab
            initialProducts={initialProducts}
            initialSearch={initialProductsSearch}
            onProductsChange={setProductsCount}
          />
        )}
      </div>
    </div>
  );
}
