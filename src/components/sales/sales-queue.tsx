"use client";

import {
  AlertTriangle,
  BarChart3,
  CheckCircle,
  CheckCircle2,
  Clock,
  Database,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TrendingUp,
  UploadCloud,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { SalesHistoryRow } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

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
    bad: "border-red-100 bg-red-50 text-red-900",
    good: "border-emerald-100 bg-emerald-50 text-emerald-900",
    neutral: "border-slate-200 bg-white text-slate-950",
    warn: "border-amber-100 bg-amber-50 text-amber-900",
  };
  return (
    <div className={cn("rounded-lg border px-3 py-3 shadow-sm", tones[tone])}>
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}

function SummaryStat({
  icon: Icon,
  label,
  value,
  detail,
}: {
  detail: string;
  icon: typeof BarChart3;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">{label}</p>
          <p className="mt-1 truncate text-xl font-bold">{value}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-white/65">{detail}</p>
    </div>
  );
}

function LinkageList({ linked, notLinked, title }: { linked: string[]; notLinked: string[]; title: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">{title}</p>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-text-secondary">
          {linked.length + notLinked.length} people
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-emerald-700">Linked ({linked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {linked.length === 0
              ? <p className="text-xs text-text-secondary">No linked records.</p>
              : linked.map((name) => <p className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-900" key={name}>{name}</p>)}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-red-700">Not Linked ({notLinked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {notLinked.length === 0
              ? <p className="text-xs text-text-secondary">No missing links.</p>
              : notLinked.map((name) => <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-900" key={name}>{name}</p>)}
          </div>
        </div>
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

  const canUpload = Boolean(line && selectedFile && !isUploading);
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
      <div className="space-y-6">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-primary">Sales</p>
          <h1 className="mt-1 text-2xl font-bold text-text">Monthly Sales</h1>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <input
        accept=".xlsx,.xls,.csv,.tsv"
        className="hidden"
        onChange={(event) => void handleReplaceFile(event.target.files?.[0] ?? null)}
        ref={replaceInputRef}
        type="file"
      />

      <section className="overflow-hidden rounded-2xl border border-slate-900 bg-slate-950 shadow-sm">
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_520px] lg:p-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-primary">Sales Operations</p>
            <h1 className="mt-2 text-2xl font-bold text-white lg:text-3xl">Monthly Sales Report</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
              Upload, validate, approve, replace, and delete monthly sales sheets before they flow into the sales dashboard.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/sales">
                <Button className="gap-2 border border-white/10 bg-white text-slate-950 hover:bg-white/90">
                  <BarChart3 className="h-4 w-4" />
                  Sales Dashboard
                </Button>
              </Link>
              <Button
                className="gap-2 border border-white/10 bg-white/10 text-white hover:bg-white/15"
                onClick={() => fileInputRef.current?.click()}
                variant="secondary"
              >
                <UploadCloud className="h-4 w-4" />
                Upload Sheet
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryStat
              detail={`${reportSummary.approvedCount} approved sheets`}
              icon={Database}
              label="Active Sheets"
              value={formatNumber(reportSummary.activeCount)}
            />
            <SummaryStat
              detail={reportSummary.latestPeriod}
              icon={TrendingUp}
              label="Approved Sales"
              value={formatCurrency(reportSummary.approvedSales)}
            />
            <SummaryStat
              detail={`${formatNumber(reportSummary.totalWarnings)} warnings`}
              icon={FileSpreadsheet}
              label="Rows Loaded"
              value={formatNumber(reportSummary.totalRows)}
            />
            <SummaryStat
              detail={`${formatNumber(reportSummary.totalFailures)} failed rows`}
              icon={ShieldCheck}
              label="Validation"
              value={reportSummary.totalFailures === 0 ? "Clean" : "Review"}
            />
          </div>
        </div>
      </section>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-text">Upload Monthly Sheet</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Choose the sales line, attach the workbook, then validate the totals before approval.
              </p>
            </div>
            <span className="rounded-full border border-orange-100 bg-orange-50 px-3 py-1 text-xs font-semibold text-primary">
              {line || "No line selected"}
            </span>
          </div>
        </div>
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5 p-5">
            <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <label className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">Line</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-medium text-text outline-none transition focus:border-primary focus:ring-4 focus:ring-orange-100"
                  onChange={(event) => setLine(event.target.value)}
                  value={line}
                >
                  {lineOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">Workbook</span>
                <button
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-left text-sm transition hover:border-primary hover:bg-orange-50/40"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate font-medium text-text">
                      {selectedFile?.name ?? "Choose .xlsx sales workbook"}
                    </span>
                  </span>
                  <UploadCloud className="h-4 w-4 shrink-0 text-text-secondary" />
                </button>
                <input
                  accept=".xlsx,.xls,.csv,.tsv"
                  className="hidden"
                  onChange={(event) => { setSelectedFile(event.target.files?.[0] ?? null); setUploadResult(null); }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button className="gap-2" disabled={!canUpload} onClick={handleUpload}>
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Validate & Upload
              </Button>
              {selectedFile && (
                <p className="text-xs text-text-secondary">
                  {selectedFile.name} - {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-border bg-slate-50 p-5 lg:border-l lg:border-t-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">Validation Output</p>
            {!uploadResult && (
              <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white p-5 text-sm text-text-secondary">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-primary">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <p className="mt-3 font-medium text-text">Waiting for workbook</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  Validation will show rows read, totals, linkage, manager totals, and blocking errors.
                </p>
              </div>
            )}
            {uploadResult && (
              <div className="mt-4 space-y-3">
                <div className={cn("rounded-lg border p-4", isUploadFailure ? "border-red-200 bg-red-50 text-red-900" : "border-emerald-200 bg-emerald-50 text-emerald-900")}>
                  <div className="flex gap-2">
                    {isUploadFailure ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                    <div>
                      <p className="font-semibold">{uploadResult.error ?? uploadResult.message}</p>
                      {uploadResult.code && <p className="mt-1 text-xs opacity-75">Code: {uploadResult.code}</p>}
                    </div>
                  </div>
                </div>
                {uploadResult.batchSummary && (
                  <div className="grid grid-cols-2 gap-2">
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
      </Card>

      {uploadResult?.details?.validationTotals && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-text">Sheet Read Summary</h2>
              <p className="mt-1 text-xs text-text-secondary">Totals calculated from the rows the system read from the workbook.</p>
            </div>
            {uploadResult.batchSummary?.period && (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-text-secondary">
                {uploadResult.batchSummary.period}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        </Card>
      )}

      {uploadResult?.details?.managerTotals && uploadResult.details.managerTotals.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-text">District Manager Validation Totals</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Totals grouped by the manager HR ID read from the monthly sales sheet.
              </p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-text-secondary">
              {formatNumber(uploadResult.details.managerTotals.length)} managers
            </span>
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-text-secondary">
                <tr>
                  <th className="px-3 py-2">District Manager</th>
                  <th className="px-3 py-2">Rows</th>
                  <th className="px-3 py-2">Sales Units</th>
                  <th className="px-3 py-2">Sales Value</th>
                  <th className="px-3 py-2">Target Units</th>
                  <th className="px-3 py-2">Target Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {uploadResult.details.managerTotals.map((manager) => (
                  <tr key={manager.manager}>
                    <td className="px-3 py-2 font-semibold text-text">{manager.manager}</td>
                    <td className="px-3 py-2 text-text-secondary">{formatNumber(manager.rows)}</td>
                    <td className="px-3 py-2 text-text-secondary">{formatNumber(manager.salesUnits)}</td>
                    <td className="px-3 py-2 text-text-secondary">{formatCurrency(manager.salesValue)}</td>
                    <td className="px-3 py-2 text-text-secondary">{formatNumber(manager.targetUnits)}</td>
                    <td className="px-3 py-2 text-text-secondary">{formatCurrency(manager.targetValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {uploadResult?.details?.blockingReasons && uploadResult.details.blockingReasons.length > 0 && (
        <Card className="border-red-200 bg-red-50">
          <h2 className="text-sm font-bold text-red-950">Why the upload stopped</h2>
          <div className="mt-3 space-y-2">
            {uploadResult.details.blockingReasons.map((reason) => (
              <p className="rounded-lg bg-white/70 px-3 py-2 text-sm text-red-900" key={reason}>{reason}</p>
            ))}
          </div>
        </Card>
      )}

      {(failureReasons.length > 0 || warningReasons.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {failureReasons.length > 0 && (
            <Card>
              <h2 className="text-sm font-bold text-text">Top Errors</h2>
              <div className="mt-3 space-y-2">
                {failureReasons.map((reason) => (
                  <div className="flex gap-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm" key={reason.message}>
                    <span className="font-bold text-red-700">{reason.count}</span>
                    <span className="text-red-950">{reason.message}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {warningReasons.length > 0 && (
            <Card>
              <details>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-text">Warnings</h2>
                    <p className="mt-1 text-xs text-text-secondary">
                      {formatNumber(warningReasons.reduce((sum, reason) => sum + reason.count, 0))} warnings found. Open only when you need details.
                    </p>
                  </div>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                    Show
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  {warningReasons.map((reason) => (
                    <div className="flex gap-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm" key={reason.message}>
                      <span className="font-bold text-amber-700">{reason.count}</span>
                      <span className="text-amber-950">{reason.message}</span>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          )}
        </div>
      )}

      {invalidRows.length > 0 && (
        <Card>
          <h2 className="text-sm font-bold text-text">Rows To Fix</h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-text-secondary">
                <tr>
                  <th className="w-24 px-3 py-2">Row</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invalidRows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-3 py-2 font-semibold text-text">{row.rowNumber}</td>
                    <td className="px-3 py-2 text-text-secondary">{row.messages.join(" | ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <section className="rounded-2xl border border-border bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Repository</p>
            <h2 className="mt-1 text-lg font-bold text-text">Uploaded Sales Sheets</h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              {batches.length === 0 ? "No uploaded sheets yet." : `${batches.length} uploaded sheet${batches.length === 1 ? "" : "s"}.`}
            </p>
          </div>
          <Button className="gap-2" onClick={() => fileInputRef.current?.click()} variant="secondary">
            <UploadCloud className="h-4 w-4" />
            New Upload
          </Button>
        </div>

        {actionMessage && (
          <Card className={cn("mb-4 border", actionMessage.type === "success" ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50")}>
            <div className="flex items-center gap-3">
              {actionMessage.type === "success" ? <CheckCircle className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
              <p className="text-sm font-medium">{actionMessage.text}</p>
            </div>
          </Card>
        )}

        {batches.length === 0 ? (
          <Card>
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Clock className="h-10 w-10 text-text-secondary" />
              <p className="font-medium text-text">No sales sheets uploaded yet</p>
              <p className="text-sm text-text-secondary">Use the form above to upload a monthly sales file.</p>
            </div>
          </Card>
        ) : (
          <div className="space-y-3">
            {batches.map((batch) => {
              const isBusy = actionLoading?.startsWith(`${batch.id}:`);
              return (
                <div className="rounded-xl border border-border bg-slate-50/60 p-4 shadow-sm" key={batch.id}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-sm ring-1 ring-orange-100">
                        <FileText className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-text">{batch.fileName}</p>
                        <p className="text-sm text-text-secondary">{batch.line} - {batch.period}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                          <span className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-text-secondary shadow-sm">
                            {formatNumber(Number(batch.totalRecords ?? 0))} rows
                          </span>
                          <span className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-warning">
                            {formatNumber(Number(batch.warningRecords ?? 0))} warnings
                          </span>
                          <span className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-danger">
                            {formatNumber(Number(batch.failedRecords ?? 0))} failures
                          </span>
                          <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-success">
                            {formatNumber(Number(batch.linkedRecords ?? 0))} DSM linked ({Math.round((batch.linkageRate ?? 0) * 100)}%)
                          </span>
                          {batch.approvedSalesValue !== undefined && (
                            <span className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-text shadow-sm">
                              {formatCurrency(Number(batch.approvedSalesValue))}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
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
                        className="gap-1 px-3 py-1.5 text-xs"
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
                          {(batch.linkageSummary as LinkageSummary).reasons.map((reason) => (
                            <div className="rounded-md bg-white/80 px-3 py-2 text-xs text-amber-950" key={reason.message}>
                              <span className="font-bold">{formatNumber(reason.count)}</span> {reason.message}
                            </div>
                          ))}
                        </div>
                        <div className="overflow-hidden rounded-md border border-amber-200 bg-white/80">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-amber-100/60 text-amber-950">
                              <tr>
                                <th className="px-2 py-1">Row</th>
                                <th className="px-2 py-1">HR ID</th>
                                <th className="px-2 py-1">Area</th>
                                <th className="px-2 py-1">Reason</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-amber-100">
                              {(batch.linkageSummary as LinkageSummary).sampleRows.map((row) => (
                                <tr key={row.rowNumber}>
                                  <td className="px-2 py-1 font-semibold">{row.rowNumber}</td>
                                  <td className="px-2 py-1">{row.employeeHrId || "-"}</td>
                                  <td className="px-2 py-1">{row.territory}</td>
                                  <td className="px-2 py-1">{row.messages[0] ?? "No matching employee linkage was found."}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
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
      </section>
    </div>
  );
}
