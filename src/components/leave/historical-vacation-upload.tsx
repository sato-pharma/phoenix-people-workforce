"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, UploadCloud, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { HistoricalVacationDryRunResult } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import {
  buttonClassName,
  Panel,
  PanelHeader,
  Toast,
} from "./leave-ui-primitives";

function SummaryCard({ label, tone = "slate", value }: { label: string; tone?: "green" | "orange" | "red" | "slate"; value: number | string }) {
  const toneClass = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    orange: "border-orange-200 bg-orange-50 text-orange-700",
    red: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }[tone];
  return (
    <div className={cn("rounded-2xl border px-4 py-3", toneClass)}>
      <p className="text-xs font-black uppercase tracking-[0.12em] opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

export function HistoricalVacationUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<HistoricalVacationDryRunResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<"dry-run" | "confirm" | null>(null);
  const [importedRows, setImportedRows] = useState<number | null>(null);

  async function submit(endpoint: string, mode: "dry-run" | "confirm") {
    if (!file) return setToast("Choose a historical vacation workbook first.");
    setBusy(mode);
    setToast(null);
    setImportedRows(null);
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(endpoint, { body: form, method: "POST" });
    const payload = await response.json();
    setBusy(null);
    if (!response.ok) return setToast(payload.error ?? "Historical vacation upload failed.");
    setResult(payload);
    if (mode === "confirm") {
      setImportedRows(payload.importedRows ?? 0);
      setToast(`Historical vacation import confirmed for ${payload.importedRows ?? 0} accepted row(s).`);
      window.setTimeout(() => window.location.reload(), 900);
    }
  }

  return (
    <Panel>
      <Toast message={toast} />
      <PanelHeader
        action={(
          <a className={cn(buttonClassName, "border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100")} href="/api/leave/historical-vacations/template">
            <FileSpreadsheet className="h-4 w-4" />
            Historical Vacation Template Download
          </a>
        )}
        description="Upload historical leave records only. Dry-run validates rows first, preserves uploaded paid/unpaid and deduct/no-deduct decisions, and does not mutate payroll."
        icon={<UploadCloud className="h-5 w-5" />}
        title="Historical Vacation Upload"
      />
      <div className="space-y-5 p-4 sm:p-5">
        <div className="rounded-2xl border border-orange-200 bg-orange-50/70 p-4 text-sm font-semibold text-orange-900">
          Current Vacation Request rules remain unchanged. Historical rows represent past HR decisions: paid + deduct consumes balance, unpaid/non-deducted + no_deduct does not.
          Confirmation is required after dry-run validation.
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto]">
          <label className="flex min-h-12 cursor-pointer items-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50">
            <input
              accept=".xlsx"
              className="sr-only"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setResult(null);
                setImportedRows(null);
              }}
              type="file"
            />
            {file ? file.name : "Choose historical vacation XLSX workbook"}
          </label>
          <button
            className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")}
            disabled={busy !== null}
            onClick={() => submit("/api/leave/historical-vacations/dry-run", "dry-run")}
            type="button"
          >
            <CheckCircle2 className="h-4 w-4" />
            {busy === "dry-run" ? "Validating..." : "Dry-Run Validation"}
          </button>
          <button
            className={cn(buttonClassName, "bg-orange-600 text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50")}
            disabled={busy !== null || !result || result.summary.acceptedRows === 0}
            onClick={() => submit("/api/leave/historical-vacations/confirm", "confirm")}
            type="button"
          >
            <UploadCloud className="h-4 w-4" />
            {busy === "confirm" ? "Importing..." : "Confirm Import"}
          </button>
        </div>

        {result ? (
          <div className="space-y-5">
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <SummaryCard label="Total Rows" value={result.summary.totalRows} />
              <SummaryCard label="Accepted" tone="green" value={result.summary.acceptedRows} />
              <SummaryCard label="Rejected" tone="red" value={result.summary.rejectedRows} />
              <SummaryCard label="Duplicates" tone="orange" value={result.summary.duplicateRows} />
              <SummaryCard label="Employees" value={result.summary.affectedEmployees} />
              <SummaryCard label="Balance Impact" tone="orange" value={result.summary.projectedBalanceImpact} />
            </div>

            {importedRows !== null ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-700">
                Confirmed import wrote {importedRows} accepted historical vacation row(s). Rejected rows remained rejected and were recorded for traceability.
              </div>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-emerald-200 bg-white">
                <div className="flex items-center gap-2 border-b border-emerald-100 px-4 py-3 text-sm font-black text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  Accepted Rows
                </div>
                <div className="max-h-80 overflow-auto p-3">
                  {result.acceptedRows.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm font-semibold text-slate-500">No accepted rows.</p>
                  ) : result.acceptedRows.slice(0, 50).map((row) => (
                    <div className="mb-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700" key={row.rowNumber}>
                      <div className="flex items-center justify-between gap-2">
                        <span>Row {row.rowNumber} - {row.employeeHrId}</span>
                        <Badge variant="success">{row.projectedBalanceImpact} day impact</Badge>
                      </div>
                      {row.warnings.length > 0 ? <p className="mt-1 text-orange-700">{row.warnings.join(" ")}</p> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-rose-200 bg-white">
                <div className="flex items-center gap-2 border-b border-rose-100 px-4 py-3 text-sm font-black text-rose-700">
                  <XCircle className="h-4 w-4" />
                  Rejected Rows
                </div>
                <div className="max-h-80 overflow-auto p-3">
                  {result.rejectedRows.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm font-semibold text-slate-500">No rejected rows.</p>
                  ) : result.rejectedRows.slice(0, 50).map((row) => (
                    <div className="mb-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700" key={row.rowNumber}>
                      <div className="flex items-center gap-2 text-rose-700">
                        <AlertTriangle className="h-4 w-4" />
                        Row {row.rowNumber}
                      </div>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {row.errors.map((error) => <li key={error}>{error}</li>)}
                      </ul>
                      {row.warnings.length > 0 ? <p className="mt-2 text-orange-700">{row.warnings.join(" ")}</p> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
