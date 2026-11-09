"use client";

import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { SalesHistoryRow } from "@/lib/sales/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable } from "@/components/ui/sortable-table";


type Props = {
  initialData: SalesHistoryRow[] | null;
  initialError: string | null;
};

type RankedReason = { count: number; message: string };
type UploadIssueRow = { messages: string[]; rowNumber: number };
type UploadDetails = {
  blockingReasons?: string[];
  invalidRows?: UploadIssueRow[];
  managerTotals?: Array<{
    manager: string;
    rows: number;
    salesUnits: number;
    salesValue: number;
    targetUnits: number;
    targetValue: number;
  }>;
  topFailureReasons?: RankedReason[];
  topWarningReasons?: RankedReason[];
  validationTotals?: {
    dsmLinked: number; dsmLinkedNames: string[]; dsmNotLinkedNames: string[]; dsmTotal: number;
    failedRows: number; importableRows: number; managers: number;
    mrLinked: number; mrLinkedNames: string[]; mrNotLinkedNames: string[]; mrTotal: number;
    nsmLinked: number; nsmLinkedNames: string[]; nsmNotLinkedNames: string[]; nsmTotal: number;
    products: number; salesUnits: number; salesValue: number; targetUnits: number;
    targetValue: number; territories: number; totalRows: number; warningRows: number;
  };
};
type UploadResponse = {
  batchSummary?: { failedRecords?: number; fileName?: string; id?: string; line?: string; period?: string; status?: string; totalRecords?: number; validRecords?: number; warningRecords?: number };
  code?: string; details?: UploadDetails; error?: string; message?: string; success: boolean;
};
type EmployeeDirectoryResponse = { lookups?: { lines?: Array<{ label: string; value: string }> } };
type LinkageSummary = {
  ambiguous: number;
  linked: number;
  reasons: Array<{ count: number; message: string }>;
  sampleRows: Array<{
    employeeHrId: string | null;
    managerHrId: string | null;
    messages: string[];
    rowNumber: number;
    territory: string;
  }>;
  unlinked: number;
};

const fallbackLines = ["CNS"];
const panelClassName =
  "rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";
const adminTableHeaderClassName = "px-5 py-4 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

function StatusBanner({
  message,
  title,
  tone,
}: {
  message: string;
  title: string;
  tone: "danger" | "success";
}) {
  const isSuccess = tone === "success";

  return (
    <AdminCallout tone={isSuccess ? "success" : "danger"}>
      {isSuccess ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      )}
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

function Metric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  value: number | string;
}) {
  const tones = {
    bad: "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]",
    good: "border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]",
    neutral: "border-phx-line bg-[#FCFDFE] text-phx-ink",
    warn: "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]",
  };
  return (
    <Card className={cn(panelClassName, "p-4", tones[tone])}>
      <p className="text-phx-sm font-black uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-black tracking-[-0.03em]">{value}</p>
    </Card>
  );
}

function LinkageList({ linked, notLinked, title }: { linked: string[]; notLinked: string[]; title: string }) {
  return (
    <Card className={cn(panelClassName, "p-4")}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-phx-ink-soft">{title}</p>
        <span className="rounded-full border border-phx-line bg-white px-2.5 py-1 text-xs font-semibold text-phx-ink-soft">
          {linked.length + notLinked.length} people
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-emerald-700">Linked ({linked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {linked.length === 0
              ? <p className="text-xs text-text-secondary">No linked records.</p>
              : linked.map((name, index) => <p className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-900" key={`${title}:linked:${name}:${index}`}>{name}</p>)}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-red-700">Not Linked ({notLinked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {notLinked.length === 0
              ? <p className="text-xs text-text-secondary">No missing links.</p>
              : notLinked.map((name, index) => <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-900" key={`${title}:missing:${name}:${index}`}>{name}</p>)}
          </div>
        </div>
      </div>
    </Card>
  );
}

type ManagerTotalRow = { manager: string; rows: number; salesUnits: number; salesValue: number; targetUnits: number; targetValue: number };

function ManagerTotalsTable({ rows }: { rows: ManagerTotalRow[] }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "manager", accessor: (row) => row.manager, type: "string" },
      { key: "rows", accessor: (row) => row.rows, type: "number" },
      { key: "salesUnits", accessor: (row) => row.salesUnits, type: "number" },
      { key: "salesValue", accessor: (row) => row.salesValue, type: "number" },
      { key: "targetUnits", accessor: (row) => row.targetUnits, type: "number" },
      { key: "targetValue", accessor: (row) => row.targetValue, type: "number" },
    ],
    searchAccessors: [(row) => row.manager],
    initialSort: { key: "salesValue", dir: "desc" },
  });
  const th = { sort: table.sort, onSort: table.toggleSort, variant: "light" as const, className: "break-words px-3 py-3 tracking-[0.14em]" };
  return (
    <div className="px-4 py-4 md:px-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-xs font-semibold text-phx-ink-soft">
          {table.isFiltered ? `${table.visible} of ${table.total}` : formatNumber(table.total)} managers
        </span>
        <div className="w-52">
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search manager…" />
        </div>
      </div>
      <div className="overflow-hidden rounded-[16px] border border-phx-line">
        <CrmTable columns={["24%", "9%", "15%", "18%", "15%", "19%"]}>
          <thead className="bg-phx-paper">
            <tr>
              <SortableTh label="District Manager" sortKey="manager" {...th} />
              <SortableTh label="Rows" sortKey="rows" align="right" {...th} />
              <SortableTh label="Sales Units" sortKey="salesUnits" align="right" {...th} />
              <SortableTh label="Sales Value" sortKey="salesValue" align="right" {...th} />
              <SortableTh label="Target Units" sortKey="targetUnits" align="right" {...th} />
              <SortableTh label="Target Value" sortKey="targetValue" align="right" {...th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {table.rows.length === 0 && <TableNoResults colSpan={6} filtered={table.isFiltered} label="managers" />}
            {table.rows.map((manager, index) => (
              <tr className="text-phx-ink-soft" key={`${manager.manager}:${index}`}>
                <td className="break-words px-3 py-2.5 align-top font-semibold text-phx-ink">{manager.manager}</td>
                <td className="break-words px-3 py-2.5 text-right align-top tabular-nums">{formatNumber(manager.rows)}</td>
                <td className="break-words px-3 py-2.5 text-right align-top tabular-nums">{formatNumber(manager.salesUnits)}</td>
                <td className="break-words px-3 py-2.5 text-right align-top tabular-nums">{formatCurrency(manager.salesValue)}</td>
                <td className="break-words px-3 py-2.5 text-right align-top tabular-nums">{formatNumber(manager.targetUnits)}</td>
                <td className="break-words px-3 py-2.5 text-right align-top tabular-nums">{formatCurrency(manager.targetValue)}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
        <CrmCardsOnPhone>
          {table.rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              {table.isFiltered ? "No managers match this filter." : "No managers."}
            </p>
          ) : null}
          {table.rows.map((manager, index) => (
            <CrmCard key={`${manager.manager}:${index}:card`} title={manager.manager}>
              <CrmFacts
                facts={[
                  { label: "Rows", value: formatNumber(manager.rows) },
                  { label: "Sales units", value: formatNumber(manager.salesUnits) },
                  { label: "Sales value", value: formatCurrency(manager.salesValue) },
                  { label: "Target units", value: formatNumber(manager.targetUnits) },
                  { label: "Target value", value: formatCurrency(manager.targetValue) },
                ]}
              />
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
      </div>
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "approved": return <Badge variant="success">Approved</Badge>;
    case "rejected": return <Badge variant="danger">Rejected</Badge>;
    case "needs_review": return <Badge variant="warning">Needs Review</Badge>;
    case "validated": return <Badge variant="neutral">Validated</Badge>;
    case "replaced": return <Badge variant="neutral">Replaced</Badge>;
    default: return <Badge variant="neutral">{status}</Badge>;
  }
}

export function SalesQueue({ initialData, initialError }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const [batches, setBatches] = useState(initialData ?? []);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<SalesHistoryRow | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [line, setLine] = useState(fallbackLines[0]);
  const [lineOptions, setLineOptions] = useState(fallbackLines);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadLines() {
      try {
        const response = await fetch("/api/employees", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as EmployeeDirectoryResponse;
        const lines = data.lookups?.lines?.map((item) => item.label || item.value).filter(Boolean) ?? [];
        const uniqueLines = [...new Set(lines)];
        if (!cancelled && uniqueLines.length > 0) {
          setLineOptions(uniqueLines);
          setLine((current) => current || uniqueLines[0]);
        }
      } catch {
        if (!cancelled) setLine((current) => current || fallbackLines[0]);
      }
    }
    void loadLines();
    return () => { cancelled = true; };
  }, []);

  // Sales Queue uploads are retired at the UI level (2026-07-29): Monthly Closing now reads Source of
  // Sales, so keep the primary upload button disabled and treat this page as a view-only history.
  // The endpoint behind it used to be left intact because Reconciliation still read these sheets —
  // it no longer does, so the server now refuses the write too (LEGACY_SALES_IMPORT_FROZEN in
  // src/lib/sales/service.ts). A disabled button is UX; the server guard is the actual boundary.
  const canUpload = false;
  const isUploadFailure = uploadResult?.success === false;
  const failureReasons = useMemo(() => uploadResult?.details?.topFailureReasons ?? [], [uploadResult]);
  const invalidRows = useMemo(() => uploadResult?.details?.invalidRows ?? [], [uploadResult]);
  const warningReasons = useMemo(() => uploadResult?.details?.topWarningReasons ?? [], [uploadResult]);
  const reportSummary = useMemo(() => {
    const approved = batches.filter((batch) => batch.status === "approved");
    const active = batches.filter((batch) => batch.status !== "replaced");
    const totalRows = active.reduce((sum, batch) => sum + Number(batch.totalRecords ?? 0), 0);
    const totalWarnings = active.reduce((sum, batch) => sum + Number(batch.warningRecords ?? 0), 0);
    const totalFailures = active.reduce((sum, batch) => sum + Number(batch.failedRecords ?? 0), 0);
    const approvedSales = approved.reduce((sum, batch) => sum + Number(batch.approvedSalesValue ?? 0), 0);
    const latestPeriod = active[0]?.period ?? "No period yet";

    return {
      activeCount: active.length,
      approvedCount: approved.length,
      approvedSales,
      latestPeriod,
      totalFailures,
      totalRows,
      totalWarnings,
    };
  }, [batches]);

  // Quick text filter over the uploaded-sheet cards (summary above stays on the full set).
  const sheetTable = useSortableTable(batches, {
    columns: [],
    searchAccessors: [
      (batch) => batch.fileName,
      (batch) => String(batch.line ?? ""),
      (batch) => String(batch.period ?? ""),
      (batch) => String(batch.status ?? ""),
    ],
    initialSort: null,
  });

  async function reloadHistory() {
    const updated = await fetch("/api/sales/imports", { cache: "no-store" }).then((r) => r.json());
    if (updated.success) setBatches(updated.data);
  }

  async function readJsonResponse(response: Response) {
    const text = await response.text();
    if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText };
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: text };
    }
  }

  async function handleUpload() {
    if (!selectedFile || !line) return;
    setIsUploading(true);
    setUploadResult(null);
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("line", line);
    formData.append("uploadedBy", "admin");
    try {
      const response = await fetch("/api/sales/imports/upload", { body: formData, method: "POST" });
      const payload = (await readJsonResponse(response)) as UploadResponse;
      setUploadResult(payload);
      if (payload.success) {
        setSelectedFile(null);
        try {
          await reloadHistory();
        } catch {
          setActionMessage({ type: "error", text: "Upload succeeded, but refreshing uploaded sheets failed. Refresh the page to see the new sheet." });
        }
      }
    } catch (error) {
      setUploadResult({ error: error instanceof Error ? error.message : "Upload failed.", success: false });
    } finally {
      setIsUploading(false);
    }
  }

  async function handleAction(batchId: string, action: "approve" | "reject" | "delete") {
    if (action === "delete" && !window.confirm("Delete this uploaded sales sheet?")) return;
    setActionLoading(`${batchId}:${action}`);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/sales/imports/${batchId}/${action}`, { method: "POST" });
      const payload = await readJsonResponse(res);
      if (payload.success) {
        setActionMessage({ type: "success", text: payload.message });
        await reloadHistory();
      } else {
        setActionMessage({ type: "error", text: payload.error ?? "Action failed." });
      }
    } catch {
      setActionMessage({ type: "error", text: "Network error." });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReplaceFile(file: File | null) {
    if (!file || !replaceTarget) return;
    setActionLoading(`${replaceTarget.id}:replace`);
    setActionMessage(null);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("line", String(replaceTarget.line ?? ""));
    formData.append("uploadedBy", "admin");
    formData.append("replacementForBatchId", String(replaceTarget.id));
    try {
      const res = await fetch("/api/sales/imports/upload", { body: formData, method: "POST" });
      const payload = await readJsonResponse(res);
      if (payload.success) {
        setActionMessage({ type: "success", text: payload.message ?? "Replacement uploaded." });
        await reloadHistory();
      } else {
        setActionMessage({ type: "error", text: payload.error ?? "Replacement failed." });
      }
    } catch {
      setActionMessage({ type: "error", text: "Network error." });
    } finally {
      setActionLoading(null);
      setReplaceTarget(null);
      if (replaceInputRef.current) replaceInputRef.current.value = "";
    }
  }

  if (initialError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
        <div className="mb-5 flex items-center justify-between rounded-3xl border border-phx-line bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div>
            <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">Sales queue</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Unable to open sales queue</h1>
            <p className="mt-1 text-sm text-slate-500">The sales queue could not be loaded.</p>
          </div>
          <Link href="/sales"><Button>Sales Dashboard</Button></Link>
        </div>
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p className="text-sm">{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      <AdminCallout tone="warning">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">Uploads on this tab have been retired</p>
          <p className="mt-1 leading-6">
            Monthly Closing rep achievement now reads live Source of Sales data, not sheets uploaded here,
            so the upload form here is disabled. Existing sheets below stay viewable for reference. To bring
            in sales, use the Source of Sales importer.
          </p>
        </div>
      </AdminCallout>
      <input
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(event) => void handleReplaceFile(event.target.files?.[0] ?? null)}
        ref={replaceInputRef}
        type="file"
      />

      <div className="relative overflow-hidden rounded-3xl border border-phx-line bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
        <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              <span className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">Sales queue</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-950">Monthly Closing Sheets</h1>
                <p className="mt-1 max-w-3xl text-sm text-slate-500">
                  Validate monthly closing data, fix linkage issues, and advance a sheet into reporting workflow.
                </p>
              </div>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Link href="/sales">
              <Button className="gap-2 rounded-xl bg-[#0B0B0B] font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent">
                <BarChart3 className="h-4 w-4" />
                Sales Dashboard
              </Button>
            </Link>
            <Link href="/sales/import">
              <Button className="gap-2" variant="secondary">
                <UploadCloud className="h-4 w-4" />
                Source of Sales
              </Button>
            </Link>
            <Button
              className="gap-2"
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <UploadCloud className="h-4 w-4" />
              Upload Sheet
            </Button>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2 border-t border-phx-line pt-4">
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Active sheets: {formatNumber(reportSummary.activeCount)}</AdminInsightChip>
            <AdminInsightChip>Approved sales: {formatCurrency(reportSummary.approvedSales)}</AdminInsightChip>
            <AdminInsightChip>Latest period: {reportSummary.latestPeriod}</AdminInsightChip>
          </div>
        </div>
      </div>

      <AdminTableShell
        description="Choose the sales line, attach the closing sheet, then validate the totals before approval."
        title="Upload monthly sheet"
      >
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
              <label className="space-y-1.5">
                <span className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">
                  Line
                  <a
                    className="inline-flex items-center gap-1 text-phx-xs font-bold normal-case tracking-normal text-phx-accent hover:underline"
                    href="/api/sales/import/template"
                  >
                    <Download className="h-3 w-3" />
                    Download template
                  </a>
                </span>
                <SearchableSelect
                  className="w-full px-3.5"
                  onChange={(event) => setLine(event.target.value)}
                  value={line}
                >
                  {lineOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </SearchableSelect>
              </label>
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">Workbook</span>
                <button
                  className="flex min-h-[140px] w-full items-center justify-between gap-4 rounded-[24px] border border-dashed border-phx-line-strong bg-white px-4 py-5 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition hover:border-phx-accent hover:bg-phx-accent-soft/50"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#FED7AA] bg-phx-accent-soft text-phx-accent shadow-[0_12px_24px_rgba(249,115,22,0.12)]">
                      <FileSpreadsheet className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-phx-ink">
                        {selectedFile?.name ?? "Choose .xlsx closing sheet"}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-phx-ink-soft">
                        {selectedFile
                          ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB selected`
                          : "Validation will run before the file enters queue."}
                      </span>
                    </span>
                  </span>
                  <UploadCloud className="h-4 w-4 shrink-0 text-phx-ink-soft" />
                </button>
                <input
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => { setSelectedFile(event.target.files?.[0] ?? null); setUploadResult(null); }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button className="gap-2 rounded-xl bg-[#0B0B0B] font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent" disabled={!canUpload} onClick={handleUpload}>
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Validate and upload
              </Button>
              {selectedFile && (
                <p className="text-xs text-phx-ink-soft">
                  {selectedFile.name} - {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-phx-line bg-[#FCFDFE] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">Validation output</p>
            {!uploadResult && (
              <AdminCallout tone="neutral">
                <Clock className="mt-0.5 h-4 w-4" />
                <span>Upload a workbook to show rows read, totals, linkage, and blocking errors.</span>
              </AdminCallout>
            )}
            {uploadResult && (
              <div className="mt-3 space-y-3">
                <StatusBanner
                  message={uploadResult.code ? `${uploadResult.error ?? uploadResult.message} (${uploadResult.code})` : (uploadResult.error ?? uploadResult.message ?? "")}
                  title={isUploadFailure ? "Validation failed" : "Validation completed"}
                  tone={isUploadFailure ? "danger" : "success"}
                />
                {uploadResult.batchSummary && (
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Metric label="Rows" value={uploadResult.batchSummary.totalRecords ?? 0} />
                    <Metric label="Valid" tone="good" value={uploadResult.batchSummary.validRecords ?? 0} />
                    <Metric label="Warnings" tone="warn" value={uploadResult.batchSummary.warningRecords ?? 0} />
                    <Metric label="Failed" tone="bad" value={uploadResult.batchSummary.failedRecords ?? 0} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </AdminTableShell>

      {uploadResult?.details?.validationTotals && (
      <AdminTableShell
        description="Totals calculated from the rows the system read from the workbook."
        title="Sheet Read Summary"
      >
        <div className="px-4 py-4 md:px-5">
          {uploadResult.batchSummary?.period && (
            <div className="mb-3 flex items-center justify-end">
              <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-xs font-semibold text-phx-ink-soft">
                {uploadResult.batchSummary.period}
              </span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Rows Read" value={formatNumber(uploadResult.details.validationTotals.totalRows)} />
            <Metric label="Importable" tone="good" value={formatNumber(uploadResult.details.validationTotals.importableRows)} />
            <Metric label="Warnings" tone="warn" value={formatNumber(uploadResult.details.validationTotals.warningRows)} />
            <Metric label="Failed" tone="bad" value={formatNumber(uploadResult.details.validationTotals.failedRows)} />
            <Metric label="Sales Units" value={formatNumber(uploadResult.details.validationTotals.salesUnits)} />
            <Metric label="Sales Value" value={formatCurrency(uploadResult.details.validationTotals.salesValue)} />
            <Metric label="Target Units" value={formatNumber(uploadResult.details.validationTotals.targetUnits)} />
            <Metric label="Target Value" value={formatCurrency(uploadResult.details.validationTotals.targetValue)} />
            <Metric label="MR Linked" tone="good" value={`${formatNumber(uploadResult.details.validationTotals.mrLinked)} / ${formatNumber(uploadResult.details.validationTotals.mrTotal)}`} />
            <Metric label="DSM Linked" tone="good" value={`${formatNumber(uploadResult.details.validationTotals.dsmLinked)} / ${formatNumber(uploadResult.details.validationTotals.dsmTotal)}`} />
            <Metric label="NSM Linked" tone="good" value={`${formatNumber(uploadResult.details.validationTotals.nsmLinked)} / ${formatNumber(uploadResult.details.validationTotals.nsmTotal)}`} />
            <Metric label="Territories" value={formatNumber(uploadResult.details.validationTotals.territories)} />
            <Metric label="Managers" value={formatNumber(uploadResult.details.validationTotals.managers)} />
            <Metric label="Products" value={formatNumber(uploadResult.details.validationTotals.products)} />
          </div>
          <div className="mt-4 grid gap-3">
            <LinkageList linked={uploadResult.details.validationTotals.mrLinkedNames} notLinked={uploadResult.details.validationTotals.mrNotLinkedNames} title="MR Linkage" />
            <LinkageList linked={uploadResult.details.validationTotals.dsmLinkedNames} notLinked={uploadResult.details.validationTotals.dsmNotLinkedNames} title="DSM Linkage" />
            <LinkageList linked={uploadResult.details.validationTotals.nsmLinkedNames} notLinked={uploadResult.details.validationTotals.nsmNotLinkedNames} title="NSM Linkage" />
          </div>
        </div>
      </AdminTableShell>
      )}

      {uploadResult?.details?.managerTotals && uploadResult.details.managerTotals.length > 0 && (
        <AdminTableShell
          description="Totals grouped by the manager HR ID read from the monthly sales sheet."
          title="District Manager Validation Totals"
        >
          <ManagerTotalsTable rows={uploadResult.details.managerTotals} />
        </AdminTableShell>
      )}

      {uploadResult?.details?.blockingReasons && uploadResult.details.blockingReasons.length > 0 && (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-semibold">Why the upload stopped</p>
            <div className="mt-2 space-y-2 text-sm">
              {uploadResult.details.blockingReasons.map((reason, index) => (
                <p key={`${reason}:${index}`}>{reason}</p>
              ))}
            </div>
          </div>
        </AdminCallout>
      )}

      {(failureReasons.length > 0 || warningReasons.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {failureReasons.length > 0 && (
            <AdminTableShell
              description="Counts by the most frequent blocking reasons from this uploaded file."
              title="Top Errors"
            >
              <div className="space-y-2 p-4 md:p-5">
                {failureReasons.map((reason, index) => (
                  <AdminCallout tone="danger" key={`${reason.message}:${index}`}>
                    <span className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-black text-[#991B1B]">
                      {reason.count}
                    </span>
                    <span>{reason.message}</span>
                  </AdminCallout>
                  ))}
              </div>
            </AdminTableShell>
          )}
          {warningReasons.length > 0 && (
            <AdminTableShell
              description={`${formatNumber(warningReasons.reduce((sum, reason) => sum + reason.count, 0))} warnings found.`}
              title="Warnings"
            >
              <details className="group p-4 md:p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-phx-line bg-[#FFFBEB] px-3 py-2.5 text-sm">
                  <span className="font-semibold text-[#92400E]">Open warning details</span>
                  <span className="rounded-full border border-[#FDE68A] bg-white px-3 py-0.5 text-xs font-semibold text-[#92400E]">Show</span>
                </summary>
                <div className="mt-3 space-y-2">
                  {warningReasons.map((reason, index) => (
                    <AdminCallout tone="neutral" key={`${reason.message}:${index}`}>
                      <span className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-[#FDE68A] bg-[#FFFBEB] text-xs font-black text-[#92400E]">
                        {reason.count}
                      </span>
                      <span className="text-[#78350F]">{reason.message}</span>
                    </AdminCallout>
                  ))}
                </div>
              </details>
            </AdminTableShell>
          )}
        </div>
      )}

      {invalidRows.length > 0 && (
        <AdminTableShell
          description="Rows with required fixes before the sheet can move through validation."
          title="Rows To Fix"
        >
          <div className="p-4 md:p-5">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[82%]" />
              </colgroup>
              <thead className="bg-phx-paper">
                <tr>
                  <th className={adminTableHeaderClassName}>Row</th>
                  <th className={adminTableHeaderClassName}>Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {invalidRows.map((row, index) => (
                  <tr className="text-phx-ink-soft" key={`${row.rowNumber}:${index}`}>
                    <td className="px-4 py-3 font-semibold text-phx-ink tabular-nums">{row.rowNumber}</td>
                    <td className="break-words px-4 py-3">{row.messages.join(" | ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminTableShell>
      )}
      
      <AdminTableShell
        description={batches.length === 0 ? "No uploaded sheets yet. Start a new upload from the action bar." : `${batches.length} uploaded sheet${batches.length === 1 ? "" : "s"} in repository.`}
        title="Uploaded Sales Sheets"
        action={(
          <div className="flex items-center gap-2">
            {batches.length > 0 ? (
              <div className="w-48">
                <TableSearchInput value={sheetTable.query} onChange={sheetTable.setQuery} onClear={sheetTable.clearQuery} placeholder="Filter sheets…" />
              </div>
            ) : null}
            <Button className="gap-2" onClick={() => fileInputRef.current?.click()} variant="secondary">
              <UploadCloud className="h-4 w-4" />
              New Upload
            </Button>
          </div>
        )}
      >
        <div className="px-1 pb-1 pt-0">

        {actionMessage && (
          <div className="mb-4">
            <StatusBanner
              message={actionMessage.text}
              title={actionMessage.type === "success" ? "Queue updated" : "Queue action failed"}
              tone={actionMessage.type === "success" ? "success" : "danger"}
            />
          </div>
        )}

        {batches.length === 0 ? (
          <AdminCallout tone="neutral">
            <Clock className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-semibold">No sales sheets uploaded yet</p>
              <p className="text-sm">Use the form above to upload a monthly closing sheet.</p>
            </div>
          </AdminCallout>
        ) : sheetTable.rows.length === 0 ? (
          <AdminCallout tone="neutral">
            <Clock className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-semibold">No sheets match your filter</p>
              <p className="text-sm">Clear the filter to see all {formatNumber(batches.length)} uploaded sheets.</p>
            </div>
          </AdminCallout>
        ) : (
          <div className="divide-y divide-phx-line overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.06)]">
            {sheetTable.rows.map((batch) => {
              const isBusy = actionLoading?.startsWith(`${batch.id}:`);
              return (
                <div className="bg-white px-5 py-5 transition-colors hover:bg-orange-50/35" key={batch.id}>
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="flex min-w-0 items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-phx-accent-soft text-phx-accent ring-8 ring-orange-100/70">
                        <FileText className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-phx-ink">{batch.fileName}</p>
                        <p className="text-sm font-medium text-phx-ink-soft">{batch.line} - {batch.period}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                          <span className="rounded-lg border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-text-secondary">
                            {formatNumber(Number(batch.totalRecords ?? 0))} rows
                          </span>
                          <span className="rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs font-semibold text-warning">
                            {formatNumber(Number(batch.warningRecords ?? 0))} warnings
                          </span>
                          <span className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-danger">
                            {formatNumber(Number(batch.failedRecords ?? 0))} failures
                          </span>
                          <span className="rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-success">
                            {formatNumber(Number(batch.linkedRecords ?? 0))} DSM linked ({Math.round((batch.linkageRate ?? 0) * 100)}%)
                          </span>
                          {batch.approvedSalesValue !== undefined && (
                            <span className="rounded-lg border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-text">
                              {formatCurrency(Number(batch.approvedSalesValue))}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
                      {statusBadge(String(batch.status))}
                      {batch.canApprove && (
                        <Button className="px-3 py-1.5 text-xs" disabled={isBusy} onClick={() => handleAction(batch.id, "approve")}>
                          Approve
                        </Button>
                      )}
                      <Button
                        className="gap-1 px-3 py-1.5 text-xs"
                        disabled={isBusy || batch.status === "replaced"}
                        onClick={() => { setReplaceTarget(batch); replaceInputRef.current?.click(); }}
                        variant="secondary"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Replace
                      </Button>
                      <Button
                        className="px-3 py-1.5 text-xs"
                        disabled={isBusy || batch.status === "rejected" || batch.status === "replaced"}
                        onClick={() => handleAction(batch.id, "reject")}
                        variant="secondary"
                      >
                        Reject
                      </Button>
                      <Button
                        className="gap-1 rounded-xl px-3 py-1.5 text-xs"
                        disabled={isBusy}
                        onClick={() => handleAction(batch.id, "delete")}
                        variant="destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {actionLoading === `${batch.id}:replace` && (
                    <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2">
                      <p className="flex items-center gap-2 text-xs font-medium text-warning">
                        <UploadCloud className="h-3.5 w-3.5" />
                        Uploading replacement sheet...
                      </p>
                    </div>
                  )}

                  {batch.linkageSummary && (batch.linkageSummary as LinkageSummary).unlinked + (batch.linkageSummary as LinkageSummary).ambiguous > 0 && (
                    <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-900">Linkage Warnings</p>
                          <p className="mt-1 text-xs text-amber-900/75">Compact by default. Open to see why linkage is not 100%.</p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-amber-900">
                          <span className="rounded-full bg-white/70 px-2 py-1">Linked: {formatNumber((batch.linkageSummary as LinkageSummary).linked)}</span>
                          <span className="rounded-full bg-white/70 px-2 py-1">Unlinked: {formatNumber((batch.linkageSummary as LinkageSummary).unlinked)}</span>
                          <span className="rounded-full bg-white/70 px-2 py-1">Ambiguous: {formatNumber((batch.linkageSummary as LinkageSummary).ambiguous)}</span>
                        </div>
                      </summary>
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <div className="space-y-2">
                          {(batch.linkageSummary as LinkageSummary).reasons.map((reason, index) => (
                            <div className="rounded-md bg-white/80 px-3 py-2 text-xs text-amber-950" key={`${reason.message}:${index}`}>
                              <span className="font-bold">{formatNumber(reason.count)}</span> {reason.message}
                            </div>
                          ))}
                        </div>
                        <div className="overflow-hidden rounded-md border border-amber-200 bg-white/80">
                          <CrmTable className="text-xs" columns={["12%", "22%", "22%", "44%"]}>
                            <thead className="bg-amber-100/60 text-amber-950">
                              <tr>
                                <th className="break-words px-2 py-1">Row</th>
                                <th className="break-words px-2 py-1">HR ID</th>
                                <th className="break-words px-2 py-1">Area</th>
                                <th className="break-words px-2 py-1">Reason</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-amber-100">
                              {(batch.linkageSummary as LinkageSummary).sampleRows.map((row, index) => (
                                <tr key={`${row.rowNumber}:${index}`}>
                                  <td className="break-words px-2 py-1 align-top font-semibold">{row.rowNumber}</td>
                                  <td className="break-words px-2 py-1 align-top">{row.employeeHrId || "—"}</td>
                                  <td className="break-words px-2 py-1 align-top">{row.territory}</td>
                                  <td className="break-words px-2 py-1 align-top">{row.messages[0] ?? "No matching employee linkage was found."}</td>
                                </tr>
                              ))}
                            </tbody>
                          </CrmTable>
                          <CrmCardsOnPhone>
                            {(batch.linkageSummary as LinkageSummary).sampleRows.map((row, index) => (
                              <CrmCard key={`${row.rowNumber}:${index}:card`} title={`Row ${row.rowNumber}`}>
                                <CrmFacts
                                  facts={[
                                    ...(row.employeeHrId ? [{ label: "HR ID", value: row.employeeHrId }] : []),
                                    { label: "Area", value: row.territory },
                                    { label: "Reason", value: row.messages[0] ?? "No matching employee linkage was found." },
                                  ]}
                                />
                              </CrmCard>
                            ))}
                          </CrmCardsOnPhone>
                        </div>
                      </div>
                    </details>
                  )}

                  {batch.approvalBlockedReason && (
                    <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 dark:border-orange-800 dark:bg-orange-950/20">
                    <p className="text-xs font-medium text-warning">{batch.approvalBlockedReason}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </AdminTableShell>
      </div>
    </div>
  );
}
