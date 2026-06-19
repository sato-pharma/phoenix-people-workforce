"use client";

import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2, Lock, ShieldCheck, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  WeeklyBatch,
  WeeklyDistributorOption,
  WeeklySalesValidationResult,
  WeeklyVerifyColumnStatus,
  WeeklyVerifyResult,
} from "@/lib/sales/weekly/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

const card = "rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm";
const darkHead = "bg-[#020617] text-left text-[11px] font-black uppercase tracking-wide text-white";

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
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [stockFile, setStockFile] = useState<File | null>(null);
  const [periodDate, setPeriodDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [result, setResult] = useState<WeeklySalesValidationResult | null>(null);
  const [batches, setBatches] = useState<WeeklyBatch[]>(initialBatches);
  // Step 1 — verification gate. The Upload button stays locked until `verified` is true.
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<WeeklyVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  // Recent-uploads table filters (client-side; all batches are already loaded).
  const [filterDistributor, setFilterDistributor] = useState("");
  const [filterPeriod, setFilterPeriod] = useState("");

  // Distinct periods present in the uploads, newest first.
  const uploadPeriods = useMemo(
    () => [...new Set(batches.map((batch) => batch.weekStart).filter((week): week is string => Boolean(week)))].sort().reverse(),
    [batches],
  );
  // Distinct distributors present in the uploads (code → display name), sorted by name.
  const uploadDistributors = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const batch of batches) {
      if (batch.distributorCode) byCode.set(batch.distributorCode, batch.distributorName || batch.distributorCode);
    }
    return [...byCode.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [batches]);

  const filteredBatches = useMemo(
    () =>
      batches.filter(
        (batch) =>
          (!filterDistributor || batch.distributorCode === filterDistributor) &&
          (!filterPeriod || batch.weekStart === filterPeriod),
      ),
    [batches, filterDistributor, filterPeriod],
  );
  const filtersActive = Boolean(filterDistributor || filterPeriod);

  // Overseas (PS) ships two matrix files (sales + stock); everyone else ships one combined workbook.
  const isPS = distributorCode === "PS";
  // Ibn Sina Sato carries a single clean date in the sheet → auto-detected. Every other distributor
  // either has no date (PS, Ibn Sina) or many invoice dates (EGD, RAMCO) → the period must be picked.
  const needsPeriodDate = distributorCode !== "IS-S";
  const filesReady = isPS ? Boolean(salesFile && stockFile) : Boolean(file);
  const canSubmit = Boolean(distributorCode) && filesReady && (!needsPeriodDate || Boolean(periodDate));

  async function refreshBatches() {
    try {
      const response = await fetch("/api/sales/weekly/batches", { cache: "no-store" });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyBatch[] };
      if (payload?.success && payload.data) setBatches(payload.data);
    } catch {
      /* keep the current list on a refresh error */
    }
  }

  // Any change to the distributor, files, or period invalidates a prior verification — a stale
  // "verified" must never carry over to a different file.
  function clearVerification() {
    setVerified(false);
    setVerifyResult(null);
    setVerifyError(null);
  }

  function resetFiles() {
    setFile(null);
    setSalesFile(null);
    setStockFile(null);
    clearVerification();
  }

  async function handleVerify() {
    if (!filesReady) {
      setVerifyError(
        isPS ? "Pick Overseas and both matrix files (sales + stock) first." : "Pick a distributor and a file first.",
      );
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    setVerified(false);
    try {
      const form = new FormData();
      form.set("distributorCode", distributorCode);
      if (isPS) {
        form.set("salesFile", salesFile as File);
        form.set("stockFile", stockFile as File);
      } else {
        form.set("file", file as File);
      }
      const response = await fetch("/api/sales/weekly/verify", { method: "POST", body: form });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyVerifyResult; error?: string };
      if (payload?.data) setVerifyResult(payload.data);
      if (!payload?.success) setVerifyError(payload?.error ?? "Verification failed.");
    } catch (caught) {
      setVerifyError(caught instanceof Error ? caught.message : "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleUpload() {
    if (!canSubmit) {
      setError(
        isPS
          ? "Pick Overseas, both matrix files (sales + stock), and a period date."
          : "Pick a distributor, a file, and (if asked) a period date.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set("distributorCode", distributorCode);
      if (periodDate) form.set("periodDate", periodDate);
      if (isPS) {
        form.set("salesFile", salesFile as File);
        form.set("stockFile", stockFile as File);
      } else {
        form.set("file", file as File);
      }
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

  const fileInputClass =
    "h-10 w-full rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] file:mr-3 file:rounded file:border-0 file:bg-[#F1F5F9] file:px-3 file:py-1.5 file:text-sm file:font-bold";

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" aria-hidden />
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#F97316]">Weekly Sales</span>
        </div>
        <h1 className="mt-1 text-xl font-black text-[#0F172A]">Upload &amp; Validate</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Upload a distributor&apos;s raw weekly Sales &amp; Stock file. The system maps it to your products and regions,
          nets returns out of sales, and recomputes value as net × factory price. Nothing is stored until every row resolves.
        </p>
      </header>

      {/* Upload card */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Distributor</span>
            <SearchableSelect
              className="h-10 w-full rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
              disabled={busy}
              onChange={(event) => {
                setDistributorCode(event.target.value);
                resetFiles();
                setResult(null);
              }}
              value={distributorCode}
            >
              {distributors.length === 0 && <option value="">No distributors registered</option>}
              {distributors.map((distributor) => (
                <option key={distributor.code} value={distributor.code}>
                  {distributor.name} ({distributor.code})
                </option>
              ))}
            </SearchableSelect>
          </label>

          {isPS ? (
            <>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">POS sales matrix (.xlsx)</span>
                <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(event) => { setSalesFile(event.target.files?.[0] ?? null); clearVerification(); }} type="file" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">POS stock matrix (.xlsx)</span>
                <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(event) => { setStockFile(event.target.files?.[0] ?? null); clearVerification(); }} type="file" />
              </label>
            </>
          ) : (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Weekly file (.xlsx)</span>
              <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); clearVerification(); }} type="file" />
            </label>
          )}
        </div>

        {needsPeriodDate && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Period date</span>
              <input
                className="h-10 rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                disabled={busy}
                onChange={(event) => setPeriodDate(event.target.value)}
                type="date"
                value={periodDate}
              />
            </label>
            <span className="pb-2 text-xs font-medium text-[#94A3B8]">
              {isPS || distributorCode === "IS"
                ? "This file has no date column — pick the week it covers."
                : "This file spans many invoice dates — pick the period it represents."}
            </span>
          </div>
        )}

        {/* Step 1 — AI verification gate. Upload stays locked until the operator confirms this. */}
        <div className="mt-5 border-t border-dashed border-[#E2E8F0] pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-[10px] font-black text-white">1</span>
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#0F172A]">Verify the file</span>
            {verified && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-black text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" /> Verified
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-[#64748B]">
            AI reads the file&apos;s column headers and shows which data it will take from which column. Review it, then confirm
            to unlock upload. Only the column titles are sent — never your sales numbers.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#020617] bg-white px-4 text-sm font-black text-[#0F172A] transition hover:bg-[#F8FAFC] disabled:opacity-60"
              disabled={busy || verifying || !filesReady}
              onClick={handleVerify}
              type="button"
            >
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-[#F97316]" />}
              {verifying ? "Analyzing…" : verifyResult ? "Re-run verification" : "Run AI verification"}
            </button>
            {!filesReady && <span className="text-xs font-medium text-[#94A3B8]">Pick the file(s) above first.</span>}
          </div>

          {verifyError && (
            <div className="mt-3 flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{verifyError}</span>
            </div>
          )}

          {verifyResult && <VerifyPanel result={verifyResult} verified={verified} onConfirm={() => setVerified(true)} />}
        </div>

        {/* Step 2 — Upload (greyed out and locked until verification is confirmed). */}
        <div className="mt-5 border-t border-dashed border-[#E2E8F0] pt-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-[10px] font-black text-white">2</span>
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#0F172A]">Upload &amp; validate</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-white disabled:hover:bg-[#CBD5E1]"
              disabled={busy || !canSubmit || !verified}
              onClick={handleUpload}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : !verified ? <Lock className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {busy ? "Validating…" : "Validate & Upload"}
            </button>
            {!verified && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#94A3B8]">
                <Lock className="h-3.5 w-3.5" /> Complete verification above to unlock.
              </span>
            )}
            {isPS && (salesFile || stockFile) && (
              <span className="truncate text-xs font-medium text-[#64748B]">
                {[salesFile?.name, stockFile?.name].filter(Boolean).join(" + ")}
              </span>
            )}
            {!isPS && file && <span className="truncate text-xs font-medium text-[#64748B]">{file.name}</span>}
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && <ResultPanel result={result} />}

      {/* Recent uploads */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-[#64748B]">Recent weekly uploads</h2>
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              aria-label="Filter by distributor"
              className="h-8 rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-xs font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74]"
              onChange={(event) => setFilterDistributor(event.target.value)}
              value={filterDistributor}
            >
              <option value="">All distributors</option>
              {uploadDistributors.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              aria-label="Filter by period"
              className="h-8 rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-xs font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74]"
              onChange={(event) => setFilterPeriod(event.target.value)}
              value={filterPeriod}
            >
              <option value="">All periods</option>
              {uploadPeriods.map((period) => (
                <option key={period} value={period}>
                  {period}
                </option>
              ))}
            </SearchableSelect>
            {filtersActive && (
              <button
                className="inline-flex items-center gap-1 rounded-[6px] border border-[#E2E8F0] bg-white px-2 py-1.5 text-xs font-semibold text-[#64748B] transition hover:bg-[#F8FAFC]"
                onClick={() => {
                  setFilterDistributor("");
                  setFilterPeriod("");
                }}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
            <span className="text-[11px] font-bold tabular-nums text-[#94A3B8]">
              {filteredBatches.length} of {batches.length}
            </span>
          </div>
        </div>
        <div className={`overflow-x-auto ${card}`}>
          <table className="w-full text-sm">
            <thead className={darkHead}>
              <tr>
                <th className="px-3 py-2">Period</th>
                <th className="px-3 py-2">Distributor</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Net units</th>
                <th className="px-3 py-2 text-right">Sales value</th>
                <th className="px-3 py-2 text-right">Stock units</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filteredBatches.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-[#94A3B8]" colSpan={8}>
                    {batches.length === 0 ? "No weekly uploads yet." : "No uploads match the current filters."}
                  </td>
                </tr>
              )}
              {filteredBatches.map((batch) => (
                <tr className="border-t border-[#FFE8D6]" key={batch.id}>
                  <td className="px-3 py-2 font-bold text-[#0F172A]">{batch.weekStart ?? "—"}</td>
                  <td className="px-3 py-2">{batch.distributorName}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-black ${
                        batch.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {batch.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalRows)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalNetQty)}</td>
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

function downloadUnmapped(result: WeeklySalesValidationResult) {
  // Build a quick reference list of the distinct unmapped values from the failure issues, so the
  // admin knows exactly what to add on the mapping pages.
  const seen = new Set<string>();
  const lines = ["field,value,reason"];
  for (const issue of result.issues) {
    if (issue.severity !== "failure") continue;
    const value = (issue.value ?? "").replace(/"/g, "'");
    const dedupeKey = `${issue.field}|${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(`${issue.field},"${value}","${issue.message.replace(/"/g, "'")}"`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `weekly-unmapped-${result.distributor.code}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function ResultPanel({ result }: { result: WeeklySalesValidationResult }) {
  const validated = result.status === "validated";
  const isPS = result.distributor.code === "PS";
  const hasFailures = result.failedRows > 0;
  const t = result.totals;

  return (
    <div className={card}>
      <div
        className={`flex flex-wrap items-center gap-2 border-b border-[#E2E8F0] px-4 py-3 text-sm font-black ${
          validated ? "text-emerald-700" : "text-amber-700"
        }`}
      >
        {validated ? <CheckCircle2 className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}
        {validated ? `Stored — period of ${result.weekStart ?? "—"}` : "Validation blocked — nothing stored"}
        <span className="ml-auto text-xs font-bold text-[#64748B]">{result.distributor.name}</span>
        {hasFailures && (
          <button
            className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-[#E2E8F0] px-3 text-xs font-bold text-[#334155] transition hover:border-[#FDBA74]"
            onClick={() => downloadUnmapped(result)}
            type="button"
          >
            <Download className="h-3.5 w-3.5" /> Unmapped items (.csv)
          </button>
        )}
      </div>

      {result.blockingReasons.length > 0 && (
        <ul className="list-disc space-y-1 border-b border-[#E2E8F0] bg-amber-50 px-8 py-3 text-sm font-semibold text-amber-800">
          {result.blockingReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {isPS && (
        <p className="border-b border-[#E2E8F0] bg-[#FFF7ED] px-4 py-2 text-xs font-semibold text-[#9A3412]">
          Overseas POS files carry a single net quantity per outlet, so Sales and Return are shown as the net figure
          (Return = 0); Net is the true value.
        </p>
      )}

      <div className="grid grid-cols-2 gap-px bg-[#E2E8F0] sm:grid-cols-4 lg:grid-cols-7">
        <Metric label="Rows" value={num(result.rowCount)} />
        <Metric label="Importable" value={num(result.importableRows)} />
        <Metric label="Sales units" value={num(t.salesQty)} />
        <Metric label="Return units" value={num(t.returnQty)} />
        <Metric label="Net units" value={num(t.netQty)} accent />
        <Metric label="Sales value" value={money(t.salesValue)} accent />
        <Metric label="Stock units" value={num(t.stockQty)} />
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <SummaryTable
          title="By product (Sales / Return / Net)"
          head={["Product", "Sales", "Return", "Net", "Value", "Stock"]}
          rows={result.byProduct.map((p) => [
            p.productName || p.productCode,
            num(p.salesQty),
            num(p.returnQty),
            num(p.netQty),
            money(p.salesValue),
            num(p.stockQty),
          ])}
        />
        <SummaryTable
          title="By branch (Sales / Return / Net)"
          head={["Branch", "Sales", "Return", "Net", "Value", "Stock"]}
          rows={result.byBranch.map((b) => [
            b.branchName || b.branchCode,
            num(b.salesQty),
            num(b.returnQty),
            num(b.netQty),
            money(b.salesValue),
            num(b.stockQty),
          ])}
        />
        <SummaryTable
          title="By region (Sales / Return / Net)"
          head={["Region", "Sales", "Return", "Net", "Value", "Stock"]}
          rows={result.byRegion.map((r) => [
            r.regionName || r.regionCode,
            num(r.salesQty),
            num(r.returnQty),
            num(r.netQty),
            money(r.salesValue),
            num(r.stockQty),
          ])}
        />
      </div>

      {result.issues.length > 0 && (
        <div className="border-t border-[#E2E8F0] p-4">
          <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-[#64748B]">
            Row issues ({result.issues.length})
          </h3>
          <div className="max-h-56 overflow-auto rounded-[6px] border border-[#FFE8D6]">
            <table className="w-full text-xs">
              <tbody>
                {result.issues.slice(0, 100).map((issue, index) => (
                  <tr className="border-t border-[#FFE8D6]" key={`${issue.rowNumber}-${index}`}>
                    <td className="px-2 py-1 font-bold text-[#64748B]">Row {issue.rowNumber}</td>
                    <td className="px-2 py-1">
                      <span className={issue.severity === "failure" ? "text-rose-600" : "text-amber-600"}>{issue.severity}</span>
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

function StatusPill({ status, note }: { status: WeeklyVerifyColumnStatus; note: string }) {
  const map: Record<WeeklyVerifyColumnStatus, { label: string; cls: string }> = {
    match: { label: "Match", cls: "bg-emerald-50 text-emerald-700" },
    drift: { label: "Drift", cls: "bg-rose-50 text-rose-700" },
    uncertain: { label: "Check", cls: "bg-slate-100 text-slate-600" },
    empty: { label: "Empty", cls: "bg-rose-50 text-rose-700" },
  };
  const pill = map[status] ?? map.uncertain;
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-black ${pill.cls}`} title={note || undefined}>
      {pill.label}
    </span>
  );
}

function VerifyPanel({
  result,
  verified,
  onConfirm,
}: {
  result: WeeklyVerifyResult;
  verified: boolean;
  onConfirm: () => void;
}) {
  const drift = result.verdict === "drift";
  return (
    <div className={`mt-3 ${card}`}>
      <div
        className={`flex flex-wrap items-center gap-2 border-b border-[#E2E8F0] px-4 py-3 text-sm font-black ${
          drift ? "text-amber-700" : "text-emerald-700"
        }`}
      >
        {drift ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {drift ? "Possible column drift — review carefully" : "Columns look consistent"}
        <span
          className={`ml-auto inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold ${
            result.aiUsed ? "bg-[#FFF7ED] text-[#9A3412]" : "bg-slate-100 text-slate-600"
          }`}
        >
          {result.aiUsed ? "AI checked" : "AI unavailable — manual review"}
        </span>
      </div>

      {result.aiNote && (
        <p className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-xs font-semibold text-[#334155]">{result.aiNote}</p>
      )}

      {result.files.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-[#E2E8F0] px-4 py-2 text-xs text-[#64748B]">
          {result.files.map((entry) => (
            <span key={`${entry.role}-${entry.fileName}`}>
              <span className="font-black uppercase tracking-wide text-[#94A3B8]">{entry.role}</span> · {entry.fileName} → sheet
              &quot;{entry.sheetName}&quot;
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={darkHead}>
            <tr>
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2 text-center">Col</th>
              <th className="px-3 py-2">Found in your file</th>
              <th className="px-3 py-2">Expected</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.columns.map((column, index) => (
              <tr className="border-t border-[#FFE8D6]" key={`${column.sheetRole}-${column.field}-${index}`}>
                <td className="px-3 py-1.5 font-bold text-[#0F172A]">
                  {column.label}
                  {column.critical && <span className="ml-1 text-[#F97316]">*</span>}
                </td>
                <td className="px-3 py-1.5 text-[#64748B]">{column.sheetRole}</td>
                <td className="px-3 py-1.5 text-center tabular-nums text-[#334155]">{column.columnIndex}</td>
                <td className="px-3 py-1.5 text-[#0F172A]">
                  {column.observedHeader || <span className="text-rose-600">— empty —</span>}
                </td>
                <td className="px-3 py-1.5 text-[#94A3B8]">{column.expectedHeaderHint}</td>
                <td className="px-3 py-1.5">
                  <StatusPill note={column.note} status={column.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.matrices.length > 0 && (
        <div className="space-y-2 border-t border-[#E2E8F0] px-4 py-3">
          {result.matrices.map((matrix, index) => (
            <div className="text-xs" key={`${matrix.sheetRole}-${index}`}>
              <div className="font-black text-[#0F172A]">
                {matrix.kind === "branch-headers" ? "Branches / outlets (as column headers)" : "Storage locations (one per column)"} —{" "}
                {matrix.detectedCount} detected from column {matrix.firstColumn}
              </div>
              <div className="mt-0.5 text-[#64748B]">{matrix.note}</div>
              {matrix.sampleHeaders.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {matrix.sampleHeaders.map((header, headerIndex) => (
                    <span className="rounded bg-[#F1F5F9] px-1.5 py-0.5 font-medium text-[#334155]" key={headerIndex}>
                      {header}
                    </span>
                  ))}
                  {matrix.detectedCount > matrix.sampleHeaders.length && (
                    <span className="px-1 py-0.5 text-[#94A3B8]">+{matrix.detectedCount - matrix.sampleHeaders.length} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {result.warnings.length > 0 && (
        <ul className="list-disc space-y-1 border-t border-[#E2E8F0] bg-amber-50 px-8 py-3 text-xs font-semibold text-amber-800">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-[#E2E8F0] px-4 py-3">
        {verified ? (
          <span className="inline-flex items-center gap-1 text-sm font-black text-emerald-700">
            <ShieldCheck className="h-4 w-4" /> Verified — upload is unlocked below.
          </span>
        ) : (
          <>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C]"
              onClick={onConfirm}
              type="button"
            >
              <ShieldCheck className="h-4 w-4" /> Confirm — this looks correct
            </button>
            <span className="text-xs font-medium text-[#94A3B8]">
              {drift
                ? "Drift was flagged — only confirm if you know the layout is right."
                : "Confirm to unlock the upload step."}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">{label}</div>
      <div className={`mt-0.5 text-sm font-black tabular-nums ${accent ? "text-[#F97316]" : "text-[#0F172A]"}`}>{value}</div>
    </div>
  );
}

function SummaryTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-[#E2E8F0]">
      <div className="bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white">{title}</div>
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
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-center text-[#94A3B8]" colSpan={head.length}>
                  —
                </td>
              </tr>
            )}
            {rows.map((row, rowIndex) => (
              <tr className="border-t border-[#FFE8D6]" key={rowIndex}>
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
