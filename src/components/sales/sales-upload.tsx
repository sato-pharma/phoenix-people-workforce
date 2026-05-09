"use client";

import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import { cn } from "@/lib/utils";

type RankedReason = {
  count: number;
  message: string;
};

type UploadIssueRow = {
  messages: string[];
  rowNumber: number;
};

type UploadDetails = {
  blockingReasons?: string[];
  invalidRows?: UploadIssueRow[];
  topFailureReasons?: RankedReason[];
  topWarningReasons?: RankedReason[];
  validationTotals?: {
    dsmLinked: number;
    dsmLinkedNames: string[];
    dsmNotLinkedNames: string[];
    dsmTotal: number;
    failedRows: number;
    importableRows: number;
    managers: number;
    mrLinked: number;
    mrLinkedNames: string[];
    mrNotLinkedNames: string[];
    mrTotal: number;
    nsmLinked: number;
    nsmLinkedNames: string[];
    nsmNotLinkedNames: string[];
    nsmTotal: number;
    products: number;
    salesUnits: number;
    salesValue: number;
    targetUnits: number;
    targetValue: number;
    territories: number;
    totalRows: number;
    warningRows: number;
  };
  managerTotals?: Array<{
    manager: string;
    rows: number;
    salesUnits: number;
    salesValue: number;
    targetUnits: number;
    targetValue: number;
  }>;
};

type UploadResponse = {
  batchSummary?: {
    failedRecords?: number;
    fileName?: string;
    id?: string;
    line?: string;
    period?: string;
    status?: string;
    totalRecords?: number;
    validRecords?: number;
    warningRecords?: number;
  };
  code?: string;
  details?: UploadDetails;
  error?: string;
  message?: string;
  previewUrl?: string;
  success: boolean;
};

type EmployeeDirectoryResponse = {
  lookups?: {
    lines?: Array<{ label: string; value: string }>;
  };
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
    bad: "border-red-200 bg-red-50 text-red-800",
    good: "border-emerald-200 bg-emerald-50 text-emerald-800",
    neutral: "border-slate-200 bg-white text-slate-950",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
  };

  return (
    <div className={cn("rounded-lg border px-3 py-2", tones[tone])}>
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}

function LinkageList({ linked, notLinked, title }: { linked: string[]; notLinked: string[]; title: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">{title}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-emerald-700">Linked ({linked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {linked.length === 0 ? (
              <p className="text-xs text-text-secondary">No linked records.</p>
            ) : (
              linked.map((name) => (
                <p className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-900" key={name}>
                  {name}
                </p>
              ))
            )}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-red-700">Not Linked ({notLinked.length})</p>
          <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
            {notLinked.length === 0 ? (
              <p className="text-xs text-text-secondary">No missing links.</p>
            ) : (
              notLinked.map((name) => (
                <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-900" key={name}>
                  {name}
                </p>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SalesUpload() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [line, setLine] = useState(fallbackLines[0]);
  const [lineOptions, setLineOptions] = useState(fallbackLines);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);

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

    return () => {
      cancelled = true;
    };
  }, []);

  const canUpload = Boolean(line && selectedFile && !isUploading);
  const isFailure = result?.success === false;
  const failureReasons = useMemo(() => result?.details?.topFailureReasons ?? [], [result]);
  const invalidRows = useMemo(() => result?.details?.invalidRows ?? [], [result]);
  const warningReasons = useMemo(() => result?.details?.topWarningReasons ?? [], [result]);

  async function handleUpload() {
    if (!selectedFile || !line) return;
    setIsUploading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("line", line);
    formData.append("uploadedBy", "admin");

    try {
      const response = await fetch("/api/sales/imports/upload", {
        body: formData,
        method: "POST",
      });
      const payload = (await response.json()) as UploadResponse;
      setResult(payload);
    } catch (error) {
      setResult({
        error: error instanceof Error ? error.message : "Upload failed.",
        success: false,
      });
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-primary">Sales</p>
        <h1 className="mt-1 text-2xl font-bold text-text">Upload Monthly Sales</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Upload the monthly sales workbook, validate the sheet, then review the saved batch.
        </p>
      </div>

      <Card className="p-0">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
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
                    <option key={option} value={option}>
                      {option}
                    </option>
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
                  onChange={(event) => {
                    setSelectedFile(event.target.files?.[0] ?? null);
                    setResult(null);
                  }}
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
            {!result && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-text-secondary">
                Select a line and upload the monthly workbook to see validation results.
              </div>
            )}
            {result && (
              <div className="mt-4 space-y-3">
                <div
                  className={cn(
                    "rounded-lg border p-4",
                    isFailure
                      ? "border-red-200 bg-red-50 text-red-900"
                      : "border-emerald-200 bg-emerald-50 text-emerald-900",
                  )}
                >
                  <div className="flex gap-2">
                    {isFailure ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <div>
                      <p className="font-semibold">{result.error ?? result.message}</p>
                      {result.code && <p className="mt-1 text-xs opacity-75">Code: {result.code}</p>}
                    </div>
                  </div>
                </div>

                {result.batchSummary && (
                  <div className="grid grid-cols-2 gap-2">
                    <Metric label="Rows" value={result.batchSummary.totalRecords ?? 0} />
                    <Metric label="Valid" tone="good" value={result.batchSummary.validRecords ?? 0} />
                    <Metric label="Warnings" tone="warn" value={result.batchSummary.warningRecords ?? 0} />
                    <Metric label="Failed" tone="bad" value={result.batchSummary.failedRecords ?? 0} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      {result?.details?.validationTotals && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-text">Sheet Read Summary</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Totals calculated from the rows the system read from the workbook.
              </p>
            </div>
            {result.batchSummary?.period && (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-text-secondary">
                {result.batchSummary.period}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Rows Read" value={formatNumber(result.details.validationTotals.totalRows)} />
            <Metric label="Importable" tone="good" value={formatNumber(result.details.validationTotals.importableRows)} />
            <Metric label="Warnings" tone="warn" value={formatNumber(result.details.validationTotals.warningRows)} />
            <Metric label="Failed" tone="bad" value={formatNumber(result.details.validationTotals.failedRows)} />
            <Metric label="Sales Units" value={formatNumber(result.details.validationTotals.salesUnits)} />
            <Metric label="Sales Value" value={formatCurrency(result.details.validationTotals.salesValue)} />
            <Metric label="Target Units" value={formatNumber(result.details.validationTotals.targetUnits)} />
            <Metric label="Target Value" value={formatCurrency(result.details.validationTotals.targetValue)} />
            <Metric label="MR Linked" tone="good" value={`${formatNumber(result.details.validationTotals.mrLinked)} / ${formatNumber(result.details.validationTotals.mrTotal)}`} />
            <Metric label="DSM Linked" tone="good" value={`${formatNumber(result.details.validationTotals.dsmLinked)} / ${formatNumber(result.details.validationTotals.dsmTotal)}`} />
            <Metric label="NSM Linked" tone="good" value={`${formatNumber(result.details.validationTotals.nsmLinked)} / ${formatNumber(result.details.validationTotals.nsmTotal)}`} />
            <Metric label="Territories" value={formatNumber(result.details.validationTotals.territories)} />
            <Metric label="Managers" value={formatNumber(result.details.validationTotals.managers)} />
            <Metric label="Products" value={formatNumber(result.details.validationTotals.products)} />
          </div>
          <div className="mt-4 grid gap-3">
            <LinkageList
              linked={result.details.validationTotals.mrLinkedNames}
              notLinked={result.details.validationTotals.mrNotLinkedNames}
              title="MR Linkage"
            />
            <LinkageList
              linked={result.details.validationTotals.dsmLinkedNames}
              notLinked={result.details.validationTotals.dsmNotLinkedNames}
              title="DSM Linkage"
            />
            <LinkageList
              linked={result.details.validationTotals.nsmLinkedNames}
              notLinked={result.details.validationTotals.nsmNotLinkedNames}
              title="NSM Linkage"
            />
          </div>
        </Card>
      )}

      {result?.details?.managerTotals && result.details.managerTotals.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-text">District Manager Validation Totals</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Totals grouped by the manager HR ID read from the monthly sales sheet.
              </p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-text-secondary">
              {formatNumber(result.details.managerTotals.length)} managers
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
                {result.details.managerTotals.map((manager) => (
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

      {result?.details?.blockingReasons && result.details.blockingReasons.length > 0 && (
        <Card className="border-red-200 bg-red-50">
          <h2 className="text-sm font-bold text-red-950">Why the upload stopped</h2>
          <div className="mt-3 space-y-2">
            {result.details.blockingReasons.map((reason) => (
              <p className="rounded-lg bg-white/70 px-3 py-2 text-sm text-red-900" key={reason}>
                {reason}
              </p>
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
                  <div
                    className="flex gap-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm"
                    key={reason.message}
                  >
                    <span className="font-bold text-red-700">{reason.count}</span>
                    <span className="text-red-950">{reason.message}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {warningReasons.length > 0 && (
            <Card>
              <h2 className="text-sm font-bold text-text">Top Warnings</h2>
              <div className="mt-3 space-y-2">
                {warningReasons.map((reason) => (
                  <div
                    className="flex gap-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm"
                    key={reason.message}
                  >
                    <span className="font-bold text-amber-700">{reason.count}</span>
                    <span className="text-amber-950">{reason.message}</span>
                  </div>
                ))}
              </div>
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
    </div>
  );
}
