"use client";

import { AlertTriangle, CheckCircle2, FileUp, Loader2, Trash2, Upload } from "lucide-react";
import { useState } from "react";

import type { WeeklyBatch, WeeklyDistributorOption, WeeklySalesValidationResult } from "@/lib/sales/weekly/types";

const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

export function WeeklyUploadWorkspace({
  distributors,
  initialBatches,
  initialError,
}: {
  distributors: WeeklyDistributorOption[];
  initialBatches: WeeklyBatch[];
  initialError: string | null;
}) {
  const [distributorCode, setDistributorCode] = useState(distributors[0]?.code ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [result, setResult] = useState<WeeklySalesValidationResult | null>(null);
  const [batches, setBatches] = useState<WeeklyBatch[]>(initialBatches);

  async function refreshBatches() {
    try {
      const response = await fetch("/api/sales/weekly/batches", { cache: "no-store" });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyBatch[] };
      if (payload?.success && payload.data) setBatches(payload.data);
    } catch {
      /* keep the current list on a refresh error */
    }
  }

  async function handleUpload() {
    if (!distributorCode || !file) {
      setError("Pick a distributor and a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set("distributorCode", distributorCode);
      form.set("file", file);
      const response = await fetch("/api/sales/weekly/validate", { method: "POST", body: form });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklySalesValidationResult; error?: string };
      if (payload?.data) setResult(payload.data);
      if (!payload?.success) setError(payload?.error ?? "Upload failed.");
      else await refreshBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(batchId: string) {
    if (!window.confirm("Delete this weekly upload? Its stored rows will be removed.")) return;
    try {
      const response = await fetch(`/api/sales/weekly/batches?batchId=${encodeURIComponent(batchId)}`, { method: "DELETE" });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!payload?.success) setError(payload?.error ?? "Delete failed.");
      else await refreshBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed.");
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-black text-[#0F172A]">Weekly Sales Upload</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Upload a distributor&apos;s weekly Sales &amp; Stock file. Sales value is recomputed from the product
          master (Qty × factory price); stock is tracked as units only. One week per file.
        </p>
      </header>

      {/* Upload card */}
      <div className="border border-[#E2E8F0] bg-white p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Distributor</span>
            <select
              className="h-10 w-full border border-[#E2E8F0] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
              disabled={busy}
              onChange={(event) => setDistributorCode(event.target.value)}
              value={distributorCode}
            >
              {distributors.length === 0 && <option value="">No weekly templates registered</option>}
              {distributors.map((distributor) => (
                <option key={distributor.code} value={distributor.code}>
                  {distributor.name} ({distributor.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Weekly file (.xlsx)</span>
            <input
              accept=".xlsx"
              className="h-10 w-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] file:mr-3 file:border-0 file:bg-[#F1F5F9] file:px-3 file:py-1.5 file:text-sm file:font-bold"
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            className="inline-flex h-10 items-center gap-2 bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
            disabled={busy || !file || !distributorCode}
            onClick={handleUpload}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? "Validating…" : "Validate & Upload"}
          </button>
          {file && <span className="truncate text-xs font-medium text-[#64748B]">{file.name}</span>}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && <ResultPanel result={result} />}

      {/* Recent uploads */}
      <section>
        <h2 className="mb-2 text-sm font-black uppercase tracking-[0.12em] text-[#64748B]">Recent weekly uploads</h2>
        <div className="overflow-x-auto border border-[#E2E8F0] bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] text-left text-[11px] font-black uppercase tracking-wide text-[#64748B]">
              <tr>
                <th className="px-3 py-2">Week</th>
                <th className="px-3 py-2">Distributor</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Sales value</th>
                <th className="px-3 py-2 text-right">Stock units</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-[#94A3B8]" colSpan={7}>
                    No weekly uploads yet.
                  </td>
                </tr>
              )}
              {batches.map((batch) => (
                <tr className="border-t border-[#F1F5F9]" key={batch.id}>
                  <td className="px-3 py-2 font-bold text-[#0F172A]">{batch.weekStart ?? "—"}</td>
                  <td className="px-3 py-2">{batch.distributorName}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-black ${
                        batch.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {batch.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalRows)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(batch.totalSalesValue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalStockQty)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      aria-label="Delete upload"
                      className="inline-flex text-[#94A3B8] transition hover:text-rose-600"
                      onClick={() => handleDelete(batch.id)}
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ResultPanel({ result }: { result: WeeklySalesValidationResult }) {
  const validated = result.status === "validated";
  return (
    <div className="border border-[#E2E8F0] bg-white">
      <div
        className={`flex items-center gap-2 border-b border-[#E2E8F0] px-4 py-3 text-sm font-black ${
          validated ? "text-emerald-700" : "text-amber-700"
        }`}
      >
        {validated ? <CheckCircle2 className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}
        {validated ? `Stored — week of ${result.weekStart ?? "—"}` : "Validation blocked"}
        <span className="ml-auto text-xs font-bold text-[#64748B]">
          {result.distributor.name} · {result.templateName}
        </span>
      </div>

      {result.blockingReasons.length > 0 && (
        <ul className="list-disc space-y-1 border-b border-[#E2E8F0] bg-amber-50 px-8 py-3 text-sm font-semibold text-amber-800">
          {result.blockingReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-px bg-[#E2E8F0] sm:grid-cols-4 lg:grid-cols-6">
        <Metric label="Rows" value={num(result.rowCount)} />
        <Metric label="Importable" value={num(result.importableRows)} />
        <Metric label="Warnings" value={num(result.warningRows)} />
        <Metric label="Sales units" value={num(result.totals.salesQty)} />
        <Metric label="Sales value" value={money(result.totals.salesValue)} />
        <Metric label="Stock units" value={num(result.totals.stockQty)} />
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <SummaryTable
          title="By region"
          head={["Region", "Sales value", "Stock units"]}
          rows={result.byRegion.map((r) => [r.regionName || r.regionCode, money(r.salesValue), num(r.stockQty)])}
        />
        <SummaryTable
          title="By product"
          head={["Product", "Sales value", "Stock units"]}
          rows={result.byProduct.map((p) => [p.productName || p.productCode, money(p.salesValue), num(p.stockQty)])}
        />
      </div>

      {result.issues.length > 0 && (
        <div className="border-t border-[#E2E8F0] p-4">
          <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-[#64748B]">
            Row issues ({result.issues.length})
          </h3>
          <div className="max-h-56 overflow-auto border border-[#F1F5F9]">
            <table className="w-full text-xs">
              <tbody>
                {result.issues.slice(0, 100).map((issue, index) => (
                  <tr className="border-t border-[#F1F5F9]" key={`${issue.rowNumber}-${index}`}>
                    <td className="px-2 py-1 font-bold text-[#64748B]">Row {issue.rowNumber}</td>
                    <td className="px-2 py-1">
                      <span className={issue.severity === "failure" ? "text-rose-600" : "text-amber-600"}>
                        {issue.severity}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-[#334155]">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">{label}</div>
      <div className="mt-0.5 text-sm font-black tabular-nums text-[#0F172A]">{value}</div>
    </div>
  );
}

function SummaryTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div className="border border-[#E2E8F0]">
      <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-black uppercase tracking-wide text-[#64748B]">
        {title}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-bold uppercase text-[#94A3B8]">
            <tr>
              {head.map((cell, index) => (
                <th className={`px-3 py-1.5 ${index === 0 ? "" : "text-right"}`} key={cell}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr className="border-t border-[#F1F5F9]" key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td
                    className={`px-3 py-1.5 ${cellIndex === 0 ? "font-semibold text-[#0F172A]" : "text-right tabular-nums text-[#334155]"}`}
                    key={cellIndex}
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
