"use client";

import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Copy,
  Database,
  FileSpreadsheet,
  Loader2,
  Package,
  RefreshCw,
  Table2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SourceOfSalesProductsTab } from "@/components/sales/source-of-sales-products-tab";
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
import { cn } from "@/lib/utils";

type Props = {
  distributors: SalesDistributorOption[];
  initialBatches: SourceOfSalesUploadBatch[];
  initialDashboard: SourceOfSalesDashboard | null;
  initialError: string | null;
  initialProducts: SourceOfSalesProduct[];
};

type ValidationResponse = {
  code?: string;
  data?: DistributorSalesValidationResult;
  error?: string;
  message?: string;
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
  "rounded-3xl border border-[#D8E0EA] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";
const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]";

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
    neutral: "border-[#E2E8F0] bg-[#FCFDFE] text-[#0F172A]",
    warn: "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]",
  };
  return (
    <Card className={cn(panelClassName, "min-h-[104px] p-4", tones[tone])}>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-70">{label}</p>
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

function LineTable({ rows }: { rows: DistributorSalesLineSummary[] }) {
  return (
    <SummaryTable
      columns={["Line", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.line,
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function RegionTable({ rows }: { rows: DistributorSalesRegionSummary[] }) {
  return (
    <SummaryTable
      columns={["Region Name", "Region Code", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.regionName,
        row.regionCode,
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function AreaTable({ rows }: { rows: DistributorSalesAreaSummary[] }) {
  return (
    <SummaryTable
      columns={["Area Name", "Area Code", "Region Code", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.areaName,
        row.areaCode,
        row.regionCode,
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function BrickTable({ rows }: { rows: DistributorSalesBrickSummary[] }) {
  return (
    <SummaryTable
      columns={["Brick", "Brick ID", "Area Code", "Region Code", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.brickName,
        row.brickId,
        row.areaCode,
        row.regionCode,
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function ProductTable({ rows }: { rows: DistributorSalesProductSummary[] }) {
  return (
    <SummaryTable
      columns={["Product Name", "Product Code", "Official Line", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.productName,
        row.productCode,
        row.officialLine,
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function DashboardGroupTable({
  codeLabel,
  rows,
  titleLabel,
}: {
  codeLabel: string;
  rows: SourceOfSalesDashboardGroup[];
  titleLabel: string;
}) {
  return (
    <SummaryTable
      columns={[titleLabel, codeLabel, "Line / Parent", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.slice(0, 100).map((row) => [
        row.label,
        row.code ?? "-",
        row.line ?? "-",
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function DashboardDistributorTable({ rows }: { rows: SourceOfSalesDashboardDistributor[] }) {
  return (
    <SummaryTable
      columns={["Distributor", "Code", "Sheets", "Rows", "Qty", "B. Qty", "Value"]}
      rows={rows.map((row) => [
        row.distributorName,
        row.distributorCode,
        formatNumber(row.sheetCount),
        formatNumber(row.rowCount),
        numberWithDecimals(row.totalQty),
        numberWithDecimals(row.totalBonusQty),
        formatCurrency(row.totalValue),
      ])}
    />
  );
}

function SummaryTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto p-4 md:p-5">
      <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-[#F8FAFC]">
            <tr>
              {columns.map((column) => (
                <th className={tableHeaderClassName} key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E2E8F0]">
            {rows.map((row, rowIndex) => (
              <tr className="text-[#64748B]" key={`${row.join(":")}:${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td
                    className={cn(
                      "px-4 py-2.5 align-top",
                      cellIndex === 0 ? "font-semibold text-[#0F172A]" : "",
                    )}
                    key={`${cell}:${cellIndex}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
      <div className="overflow-x-auto p-4 md:p-5">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className={tableHeaderClassName}>Row</th>
              <th className={tableHeaderClassName}>Field</th>
              <th className={tableHeaderClassName}>Value</th>
              <th className={tableHeaderClassName}>Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E2E8F0]">
            {failedIssues.slice(0, 100).map((issue, index) => (
              <tr className="text-[#64748B]" key={`${issue.rowNumber}:${issue.field}:${index}`}>
                <td className="w-24 px-4 py-3 font-semibold text-[#0F172A]">{issue.rowNumber}</td>
                <td className="px-4 py-3">{issue.field}</td>
                <td className="px-4 py-3">{issue.value ?? "-"}</td>
                <td className="px-4 py-3">{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
      <div className="overflow-x-auto p-4 md:p-5">
        {batches.length === 0 ? (
          <AdminCallout tone="neutral">
            <FileSpreadsheet className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-semibold">No Source of Sales sheets uploaded yet</p>
              <p className="text-sm">Upload a distributor monthly workbook to start the new module history.</p>
            </div>
          </AdminCallout>
        ) : (
          <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-[#F8FAFC]">
                <tr>
                  <th className={tableHeaderClassName}>File</th>
                  <th className={tableHeaderClassName}>Distributor</th>
                  <th className={tableHeaderClassName}>Period</th>
                  <th className={tableHeaderClassName}>Status</th>
                  <th className={tableHeaderClassName}>Rows</th>
                  <th className={tableHeaderClassName}>Qty</th>
                  <th className={tableHeaderClassName}>B. Qty</th>
                  <th className={tableHeaderClassName}>Value</th>
                  <th className={tableHeaderClassName}>Uploaded</th>
                  <th className={tableHeaderClassName}>Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {batches.map((batch) => {
                  const deleting = deleteLoadingId === batch.batchId;
                  return (
                    <tr className="text-[#64748B]" key={batch.batchId}>
                      <td className="max-w-[260px] px-4 py-3">
                        <p className="truncate font-semibold text-[#0F172A]">{batch.fileName}</p>
                        <p className="mt-1 text-xs text-[#64748B]">{batch.uploadedBy}</p>
                      </td>
                      <td className="px-4 py-3">{batch.distributorName} / {batch.distributorCode}</td>
                      <td className="px-4 py-3">{batch.period ?? "-"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={batch.status === "validated" ? "success" : "danger"}>
                          {batch.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">{formatNumber(batch.rowCount)}</td>
                      <td className="px-4 py-3">{numberWithDecimals(batch.totalQty)}</td>
                      <td className="px-4 py-3">{numberWithDecimals(batch.totalBonusQty)}</td>
                      <td className="px-4 py-3">{formatCurrency(batch.totalValue)}</td>
                      <td className="px-4 py-3">{new Date(batch.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-3">
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
        )}
      </div>
    </AdminTableShell>
  );
}

function SourceOfSalesDashboardPanel({
  dashboard,
  onPeriodChange,
  onRefresh,
  refreshing,
}: {
  dashboard: SourceOfSalesDashboard | null;
  onPeriodChange: (period: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (!dashboard) {
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
            <select
              className="h-10 rounded-xl border border-[#D8E0EA] bg-[#F8FAFC] px-3 text-sm font-semibold text-[#0F172A] outline-none"
              disabled={dashboard.availablePeriods.length === 0 || refreshing}
              onChange={(event) => onPeriodChange(event.target.value)}
              value={dashboard.period ?? ""}
            >
              {dashboard.availablePeriods.length === 0 ? (
                <option value="">No validated month</option>
              ) : dashboard.availablePeriods.map((period) => (
                <option key={period} value={period}>{period}</option>
              ))}
            </select>
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
        <DashboardGroupTable codeLabel="Code" rows={dashboard.byLine} titleLabel="Line" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by region." title="By Region">
        <DashboardGroupTable codeLabel="Region Code" rows={dashboard.byRegion} titleLabel="Region" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by area." title="By Area">
        <DashboardGroupTable codeLabel="Area Code" rows={dashboard.byArea} titleLabel="Area" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by product." title="By Product">
        <DashboardGroupTable codeLabel="Product Code" rows={dashboard.byProduct} titleLabel="Product" />
      </AdminTableShell>
      <AdminTableShell description="Qty, bonus quantity, and value by brick." title="By Brick">
        <DashboardGroupTable codeLabel="Brick ID" rows={dashboard.byBrick} titleLabel="Brick" />
      </AdminTableShell>
    </div>
  );
}

type SourceOfSalesTab = "dashboard" | "products" | "sheets";

// Coded headers to paste into Excel. TAB-separated so each header lands in its OWN cell on paste.
const CODED_PASTE_HEADERS = "Discount%\tProduct ID\tBrick ID\tArea ID\tRegion ID\tDistrub ID";

export function SalesImportWorkspace({ distributors, initialBatches, initialDashboard, initialError, initialProducts }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultDistributor = useMemo(
    () => distributors.find((distributor) => distributor.code.toUpperCase() === "PS") ?? distributors[0] ?? null,
    [distributors],
  );

  const [selectedDistributorCode, setSelectedDistributorCode] = useState(defaultDistributor?.code ?? "");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [batches, setBatches] = useState(initialBatches);
  const [activeTab, setActiveTab] = useState<SourceOfSalesTab>("dashboard");
  const [headersCopied, setHeadersCopied] = useState(false);
  const [dashboard, setDashboard] = useState<SourceOfSalesDashboard | null>(initialDashboard);
  const [productsCount, setProductsCount] = useState(initialProducts.length);
  const [result, setResult] = useState<DistributorSalesValidationResult | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [isValidating, setIsValidating] = useState(false);
  const [isRefreshingDashboard, setIsRefreshingDashboard] = useState(false);
  const [isRefreshingBatches, setIsRefreshingBatches] = useState(false);
  const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  const selectedDistributor = distributors.find((distributor) => distributor.code === selectedDistributorCode) ?? defaultDistributor;
  const canValidate = Boolean(selectedDistributorCode && selectedFile && !isValidating && !initialError);

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

  async function handleValidate() {
    if (!selectedFile || !selectedDistributorCode) return;

    setIsValidating(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("distributorCode", selectedDistributorCode);

    try {
      const response = await fetch("/api/sales/monthly-import/validate", {
        body: formData,
        method: "POST",
      });
      const payload = await readJsonResponse(response);
      const data = payload.data ?? null;
      setResult(data);
      if (data?.batchId) {
        await reloadBatches();
        // Pin the dashboard to the just-uploaded period so the new data is visibly reflected.
        await reloadDashboard(data.period ?? null);
        if (data.status === "validated") {
          const periodLabel = data.period ?? "an undated period (check the sheet's dates)";
          const distributorLabel = data.distributor?.name ?? selectedDistributorCode;
          setActionMessage({
            type: "success",
            text: `Saved ${formatNumber(data.rowCount)} rows — ${formatCurrency(data.totals.totalValue)} for ${periodLabel} (${distributorLabel}). Dashboard updated.`,
          });
          // Make the dashboard update obvious instead of leaving the user on the upload tab.
          setActiveTab("dashboard");
        }
      }
      if (!payload.success) {
        setError(payload.error ?? "Validation failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Validation failed.");
    } finally {
      setIsValidating(false);
    }
  }

  if (initialError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[#F8FAFC] p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                <Database className="h-3.5 w-3.5 text-orange-600" />
                <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Source of Sales</span>
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
              <Button
                className="gap-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(CODED_PASTE_HEADERS);
                    setHeadersCopied(true);
                    setTimeout(() => setHeadersCopied(false), 1800);
                  } catch { /* clipboard blocked — nothing to surface */ }
                }}
                title="Copy the 6 coded headers (Discount%, Product ID, Brick ID, Area ID, Region ID, Distrub ID) — paste into Excel and each lands in its own cell."
                variant="secondary"
              >
                {headersCopied ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                {headersCopied ? "Copied!" : "Copy headers"}
              </Button>
              <Link href="/sales">
                <Button className="gap-2 rounded-xl bg-[#0B0B0B] font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-[#F97316]">
                  <Table2 className="h-4 w-4" />
                  Dashboard
                </Button>
              </Link>
              <Link href="/sales/queue">
                <Button className="gap-2" variant="secondary">
                  <Package className="h-4 w-4" />
                  Old Queue
                </Button>
              </Link>
            </div>
          </div>
          <div className="relative mt-5 flex flex-wrap gap-2 border-t border-[#E2E8F0] pt-4">
            <AdminInsightChip>Distributors: {formatNumber(distributors.length)}</AdminInsightChip>
            <AdminInsightChip>Uploaded sheets: {formatNumber(batches.length)}</AdminInsightChip>
            <AdminInsightChip>Products: {formatNumber(productsCount)}</AdminInsightChip>
            <AdminInsightChip>Dashboard month: {dashboard?.period ?? "No validated data"}</AdminInsightChip>
            {selectedDistributor ? <AdminInsightChip tone="orange">{selectedDistributor.name} / {selectedDistributor.code}</AdminInsightChip> : null}
            <AdminInsightChip tone="slate">New source tables</AdminInsightChip>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-[#D8E0EA] bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "dashboard" ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "",
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
              activeTab === "sheets" ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "",
            )}
            onClick={() => setActiveTab("sheets")}
            variant="secondary"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Uploaded Sheets
          </Button>
          <Button
            className={cn(
              "gap-2 rounded-xl font-black",
              activeTab === "products" ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "",
            )}
            onClick={() => setActiveTab("products")}
            variant="secondary"
          >
            <Package className="h-4 w-4" />
            Products Reference
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
            onPeriodChange={(period) => void reloadDashboard(period)}
            onRefresh={() => void reloadDashboard(dashboard?.period)}
            refreshing={isRefreshingDashboard}
          />
        ) : activeTab === "sheets" ? (
          <>
        <AdminTableShell
          description="Select the distributor, attach the monthly workbook, then run validation."
          title="Validate Monthly Sheet"
        >
          <div className="px-5 pt-5">
            <AdminCallout tone="neutral">
              <FileSpreadsheet className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-semibold">Upload any distributor sheet — raw or coded.</p>
                <p className="text-sm">Pick the <b>correct distributor</b>, then attach either its <b>raw export</b> or a <b>raw + coded</b> sheet. Missing Brick/Area/Region auto-fill from the customer map; any unmapped rows still show up in “Rows to Fix.”</p>
              </div>
            </AdminCallout>
          </div>
          <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
              <label className="space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">Distributor</span>
                <select
                  className="h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                  onChange={(event) => setSelectedDistributorCode(event.target.value)}
                  value={selectedDistributorCode}
                >
                  {distributors.map((distributor) => (
                    <option key={distributor.code} value={distributor.code}>
                      {distributor.name} / {distributor.code}
                    </option>
                  ))}
                </select>
              </label>
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">Workbook</span>
                <button
                  className="flex min-h-[132px] w-full items-center justify-between gap-4 rounded-[24px] border border-dashed border-[#CBD5E1] bg-white px-4 py-5 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition hover:border-[#F97316] hover:bg-[#FFF7ED]/50"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] text-[#F97316] shadow-[0_12px_24px_rgba(249,115,22,0.12)]">
                      <FileSpreadsheet className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-[#0F172A]">
                        {selectedFile?.name ?? "Choose monthly distributor sheet"}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[#64748B]">
                        {selectedFile
                          ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB selected`
                          : "Any distributor's raw export or raw + coded sheet is accepted (.xlsx / .xls)."}
                      </span>
                    </span>
                  </span>
                  <UploadCloud className="h-4 w-4 shrink-0 text-[#64748B]" />
                </button>
                <input
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => {
                    setSelectedFile(event.target.files?.[0] ?? null);
                    setResult(null);
                    setError(null);
                  }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
            </div>
            <Card className={cn(panelClassName, "flex flex-col justify-between gap-4 p-4")}>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Status</p>
                  {result ? (
                    <Badge variant={result.status === "validated" ? "success" : "danger"}>
                      {result.status}
                    </Badge>
                  ) : (
                    <Badge variant="neutral">Ready</Badge>
                  )}
                </div>
                <p className="text-sm leading-6 text-[#64748B]">
                  {result
                    ? `${result.rowCount} rows read from ${result.sheetName}.`
                    : "Uploaded sheets are saved in the new Source of Sales module and can be deleted below."}
                </p>
              </div>
              <Button
                className="h-11 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-[#F97316]"
                disabled={!canValidate}
                onClick={() => void handleValidate()}
                type="button"
              >
                {isValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Validate
              </Button>
            </Card>
          </div>
        </AdminTableShell>

        <UploadedSheetsTable
          batches={batches}
          deleteLoadingId={deleteLoadingId}
          onDelete={(batchId) => void handleDeleteBatch(batchId)}
          onRefresh={() => void reloadBatches()}
          refreshing={isRefreshingBatches}
        />

        <StatusBanner error={error} result={result} />

        {result?.blockingReasons && result.blockingReasons.length > 0 ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-semibold">Why the upload stopped</p>
              <div className="mt-2 space-y-2 text-sm">
                {result.blockingReasons.map((reason, index) => (
                  <p key={`${reason}:${index}`}>{reason}</p>
                ))}
              </div>
            </div>
          </AdminCallout>
        ) : null}

        {result?.advisories && result.advisories.length > 0 ? (
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

        {result ? (
          <>
            <AdminTableShell
              description="Totals from the uploaded workbook."
              title="Validation Totals"
            >
              <div className="p-4 md:p-5">
                <TotalsGrid result={result} />
              </div>
            </AdminTableShell>

            <AdminTableShell
              description="Qty, bonus quantity, and value grouped by official product line."
              title="By Line"
            >
              <LineTable rows={result.byLine} />
            </AdminTableShell>

            <AdminTableShell
              description="Qty, bonus quantity, and value grouped by Region Name and Region Code."
              title="By Region Name + Region Code"
            >
              <RegionTable rows={result.byRegion} />
            </AdminTableShell>

            <AdminTableShell
              description="Qty, bonus quantity, and value grouped by Area Code and its region."
              title="By Area"
            >
              <AreaTable rows={result.byArea} />
            </AdminTableShell>

            <AdminTableShell
              description="Qty, bonus quantity, and value grouped by Product Name and Product Code."
              title="By Product Name + Product Code"
            >
              <ProductTable rows={result.byProduct} />
            </AdminTableShell>

            <AdminTableShell
              description="Qty, bonus quantity, and value grouped by Brick ID."
              title="By Brick"
            >
              <BrickTable rows={result.byBrick} />
            </AdminTableShell>

            <IssueTable issues={result.issues} />
          </>
        ) : null}
          </>
        ) : (
          <SourceOfSalesProductsTab
            initialProducts={initialProducts}
            onProductsChange={setProductsCount}
          />
        )}
      </div>
    </div>
  );
}
