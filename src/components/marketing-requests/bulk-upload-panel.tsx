"use client";

import { humanizeCode } from "@/lib/format/code-label";
import { useCallback, useRef, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// ---- Types (mirrors bulk-import.ts public API) ----

type PreviewRow = {
  rowIndex: number;
  requesterHrId: string | null;
  requestDate: string | null;
  customerCode: string | null;
  estimatedCost: number;
  importStatus: string;
  mappedRequestTypeCode: string;
  computedExpectedRoi: number;
  resolvedProducts: Array<{ productCode: string | null; productName: string; qty: number }>;
  errors: string[];
  warnings: string[];
  canImport: boolean;
};

type Preview = {
  rows: PreviewRow[];
  summary: {
    total: number;
    canImport: number;
    hasErrors: number;
    hasWarnings: number;
    totalEstimatedCost: number;
    totalComputedRoi: number;
  };
};

type ImportResultRow = {
  rowIndex: number;
  requestCode: string;
  requesterHrId: string;
  success: boolean;
  error: string | null;
};

type ImportResult = {
  imported: number;
  failed: number;
  rows: ImportResultRow[];
};

type Phase = "idle" | "uploading" | "previewing" | "executing" | "done";

// ---- Helpers ----

function fmtMoney(n: number) {
  return new Intl.NumberFormat("en-EG", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

// ---- Sub-components ----

function SummaryCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}

function PreviewRowCard({ row }: { row: PreviewRow }) {
  const [open, setOpen] = useState(false);
  const hasIssues = row.errors.length > 0 || row.warnings.length > 0;

  return (
    <div className={`rounded-lg border ${row.canImport ? "border-slate-200 bg-white" : "border-red-200 bg-red-50"} overflow-hidden`}>
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((o: boolean) => !o)}
        type="button"
      >
        <span className="text-slate-400">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>

        <span className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs text-slate-400 w-10 shrink-0">Row {row.rowIndex}</span>
          <span className="font-medium text-sm text-slate-900 break-words">{row.requesterHrId ?? "—"}</span>
          <span className="text-xs text-slate-500">{row.requestDate ?? "—"}</span>
          <span className="text-xs text-slate-500 break-words hidden sm:block">{row.customerCode ?? "—"}</span>
        </span>

        <span className="flex items-center gap-2 shrink-0">
          <Badge variant="neutral" className="text-xs">
            {humanizeCode(row.mappedRequestTypeCode)}
          </Badge>
          <span className="text-xs font-medium text-slate-700">EGP {fmtMoney(row.estimatedCost)}</span>
          {row.canImport ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : (
            <AlertCircle className="size-4 text-red-500" />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3">
          {row.resolvedProducts.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Products</p>
              <ul className="space-y-0.5">
                {row.resolvedProducts.map((p, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-slate-700">
                    <span className="min-w-0 break-words">{p.productName}</span>
                    <span className="text-slate-400">× {p.qty}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-4 text-xs text-slate-600">
            <span>Computed ROI: <strong>EGP {fmtMoney(row.computedExpectedRoi)}</strong></span>
            <span>Status: <strong>{row.importStatus}</strong></span>
          </div>

          {row.errors.length > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 p-2 space-y-1">
              {row.errors.map((e, i) => (
                <p key={i} className="text-xs text-red-700 flex items-start gap-1.5">
                  <AlertCircle className="size-3 mt-0.5 shrink-0" /> {e}
                </p>
              ))}
            </div>
          )}

          {row.warnings.length > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-2 space-y-1">
              {row.warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                  <AlertCircle className="size-3 mt-0.5 shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}

          {!hasIssues && (
            <p className="text-xs text-emerald-700 flex items-center gap-1.5">
              <CheckCircle2 className="size-3" /> Ready to import
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ row }: { row: ImportResultRow }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border text-sm ${row.success ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
      {row.success ? (
        <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />
      ) : (
        <AlertCircle className="size-4 text-red-600 shrink-0" />
      )}
      <span className="font-medium text-slate-800">{row.requestCode}</span>
      <span className="text-slate-500 text-xs">{row.requesterHrId}</span>
      {row.error && <span className="ml-auto text-xs text-red-700 truncate max-w-xs">{row.error}</span>}
      {row.success && <span className="ml-auto text-xs text-emerald-700">Imported</span>}
    </div>
  );
}

// ---- Main component ----

export function MarketingBulkUploadPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Download template
  const handleDownloadTemplate = useCallback(async () => {
    try {
      const res = await fetch("/api/marketing-requests/bulk-upload");
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "marketing-requests-bulk-upload-template.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download template.");
    }
  }, []);

  // File selection
  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPreview(null);
    setResult(null);
    setError(null);
    if (file) setPhase("idle");
  }, []);

  const clearFile = useCallback(() => {
    setSelectedFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setPhase("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Upload for preview
  const handlePreview = useCallback(async () => {
    if (!selectedFile) return;
    setPhase("uploading");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      fd.append("mode", "preview");
      const res = await fetch("/api/marketing-requests/bulk-upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? `Server error ${res.status}`);
      }
      setPreview(data.preview as Preview);
      setPhase("previewing");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
      setPhase("idle");
    }
  }, [selectedFile]);

  // Execute import
  const handleExecute = useCallback(async () => {
    if (!selectedFile || !preview) return;
    if (!confirm(`Import ${preview.summary.canImport} requests into the system? This cannot be undone.`)) return;

    setPhase("executing");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      fd.append("mode", "execute");
      const res = await fetch("/api/marketing-requests/bulk-upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? `Server error ${res.status}`);
      setResult(data.result as ImportResult);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setPhase("previewing");
    }
  }, [selectedFile, preview]);

  return (
    <div className="space-y-6 max-w-4xl">

      {/* Step 1: Download template */}
      <Card className="p-5">
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-sky-50 p-3 shrink-0">
            <FileSpreadsheet className="size-6 text-sky-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Step 1 — Download the template</h2>
            <p className="mt-1 text-sm text-slate-500">
              The XLSX template contains instructions, required columns, dropdown validation, and a
              sample row. Fill it with historical marketing request data — one request per row.
            </p>
            <ul className="mt-2 text-xs text-slate-500 list-disc list-inside space-y-0.5">
              <li>Up to 5 products per request row</li>
              <li>Up to 3 pharmacy vendor codes per request row</li>
              <li>Leave <em>Request Code</em> blank — auto-generated by the system</li>
              <li>Set <em>Import Status</em> to <strong>approved</strong> for already-approved historical data</li>
              <li>Customers and products must already exist in the system</li>
            </ul>
          </div>
          <Button
            variant="outline"
            className="shrink-0 gap-2"
            onClick={handleDownloadTemplate}
          >
            <Download className="size-4" />
            Download Template
          </Button>
        </div>
      </Card>

      {/* Step 2: Upload filled file */}
      <Card className="p-5">
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-violet-50 p-3 shrink-0">
            <Upload className="size-6 text-violet-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Step 2 — Upload filled template</h2>
            <p className="mt-1 text-sm text-slate-500">
              Select your completed XLSX file. The system will validate every row and show you a
              preview before anything is written to the database.
            </p>

            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <label className="cursor-pointer">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="sr-only"
                  onChange={handleFileChange}
                  disabled={phase === "uploading" || phase === "executing"}
                />
                <span className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer">
                  <FileSpreadsheet className="size-4" />
                  {selectedFile ? "Change file" : "Choose XLSX file"}
                </span>
              </label>

              {selectedFile && (
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <span className="truncate max-w-xs">{selectedFile.name}</span>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="text-slate-400 hover:text-slate-600"
                    disabled={phase === "uploading" || phase === "executing"}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}

              {selectedFile && phase !== "done" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePreview}
                  disabled={phase === "uploading" || phase === "executing"}
                  className="gap-2"
                >
                  {(phase === "uploading") && <Loader2 className="size-4 animate-spin" />}
                  Validate & Preview
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <AlertCircle className="size-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Preview */}
      {preview && (phase === "previewing" || phase === "executing") && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard label="Total Rows" value={preview.summary.total} />
            <SummaryCard label="Ready to Import" value={preview.summary.canImport} color="text-emerald-600" />
            <SummaryCard label="Has Errors" value={preview.summary.hasErrors} color={preview.summary.hasErrors > 0 ? "text-red-600" : "text-slate-400"} />
            <SummaryCard label="Has Warnings" value={preview.summary.hasWarnings} color={preview.summary.hasWarnings > 0 ? "text-amber-600" : "text-slate-400"} />
            <SummaryCard label="Total Cost (EGP)" value={fmtMoney(preview.summary.totalEstimatedCost)} />
            <SummaryCard label="Total ROI (EGP)" value={fmtMoney(preview.summary.totalComputedRoi)} />
          </div>

          {/* Rows */}
          <div className="space-y-2">
            {preview.rows.map((row: PreviewRow) => (
              <PreviewRowCard key={row.rowIndex} row={row} />
            ))}
          </div>

          {/* Execute button */}
          {preview.summary.canImport > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  {preview.summary.canImport} of {preview.summary.total} rows are ready to import.
                </p>
                {preview.summary.hasErrors > 0 && (
                  <p className="text-xs text-amber-700 mt-0.5">
                    {preview.summary.hasErrors} row(s) have errors and will be skipped.
                  </p>
                )}
              </div>
              <Button
                onClick={handleExecute}
                disabled={phase === "executing"}
                className="gap-2 bg-emerald-700 hover:bg-emerald-800 text-white"
              >
                {phase === "executing" && <Loader2 className="size-4 animate-spin" />}
                Import {preview.summary.canImport} Requests
              </Button>
            </div>
          )}

          {preview.summary.canImport === 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
              <AlertCircle className="size-5 text-red-500 shrink-0" />
              <p className="text-sm text-red-700">No rows are ready to import. Fix the errors above and re-upload the file.</p>
            </div>
          )}
        </div>
      )}

      {/* Done / result */}
      {result && phase === "done" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <SummaryCard label="Successfully Imported" value={result.imported} color="text-emerald-600" />
            <SummaryCard label="Failed" value={result.failed} color={result.failed > 0 ? "text-red-600" : "text-slate-400"} />
          </div>

          <div className="space-y-2">
            {result.rows.map((row: ImportResultRow) => (
              <ResultCard key={row.rowIndex} row={row} />
            ))}
          </div>

          <Button variant="outline" onClick={clearFile} className="gap-2">
            <Upload className="size-4" />
            Upload Another File
          </Button>
        </div>
      )}
    </div>
  );
}
