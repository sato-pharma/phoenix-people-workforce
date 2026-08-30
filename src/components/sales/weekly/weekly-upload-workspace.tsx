"use client";

import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2, Lock, Pencil, ShieldCheck, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { SourceOfSalesProductsTab } from "@/components/sales/source-of-sales-products-tab";
import type {
  WeeklyBatch,
  WeeklyDistributorOption,
  WeeklyExcludedBranch,
  WeeklyExcludedItem,
  WeeklyFileTotalsReport,
  WeeklySalesValidationResult,
  WeeklyVerifyColumnStatus,
  WeeklyVerifyResult,
} from "@/lib/sales/weekly/types";
import { WEEKLY_DISTRIBUTORS } from "@/lib/sales/weekly/distributors";
import type { SourceOfSalesProduct } from "@/lib/sales/monthly-distributor-import";
import { SearchableSelect } from "@/components/ui/searchable-select";

import { WeeklyBranchMappingManager } from "./weekly-branch-mapping-manager";
import { WeeklyProductMappingManager } from "./weekly-product-mapping-manager";


// No money formatter here on purpose: this whole screen — Validate preview AND the stored-upload
// history — reports UNITS. Value belongs to the surfaces that own the price (dashboard, export).
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

const card = "rounded-[6px] border border-phx-line bg-white shadow-sm";
const darkHead = "bg-[#020617] text-left text-phx-xs font-black uppercase tracking-wide text-white";

// Large workbooks (> ~4MB) can't be POSTed through the serverless function — Vercel caps the request
// body at ~4.5MB (FUNCTION_PAYLOAD_TOO_LARGE), which large weekly POS matrices routinely exceed. Those
// stream straight to the "sales-imports" Storage bucket via a short-lived signed URL, then the endpoint
// is called by reference (JSON storagePath). PS / Overseas ships two matrix files, so it needs two
// references. Small files keep the original direct multipart POST. Mirrors the monthly /sales/upload
// path; the server resolves both shapes via resolveWeeklyUploadRequest and deletes the temp object(s).
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024;

async function uploadWeeklyFileToStorage(file: File): Promise<string> {
  const urlRes = await fetch("/api/sales/monthly-import/upload-url", {
    body: JSON.stringify({ fileName: file.name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const urlPayload = (await urlRes.json().catch(() => ({}))) as { signedUrl?: string; path?: string; error?: string };
  if (!urlRes.ok || !urlPayload.signedUrl || !urlPayload.path) {
    throw new Error(urlPayload.error ?? "Could not start the upload for this large file.");
  }
  const putRes = await fetch(urlPayload.signedUrl, {
    body: file,
    headers: {
      "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "x-upsert": "false",
    },
    method: "PUT",
  });
  if (!putRes.ok) throw new Error("The file could not be uploaded. Please try again.");
  return urlPayload.path;
}

type WeeklyPostInput = {
  distributorCode: string;
  isPS: boolean;
  periodDate?: string;
  /** week-of-month 1–4 (the confirmed label); omitted lets the server fall back to the date suggestion */
  weekNumber?: number | null;
  file?: File | null;
  salesFile?: File | null;
  stockFile?: File | null;
};

// Posts a weekly request to `endpoint`. Small payloads go multipart; large ones stream to Storage first
// (both PS files together count toward the cap, so if either pushes the combined body over the limit
// both are streamed) and the endpoint is called by JSON reference.
async function postWeekly(endpoint: string, input: WeeklyPostInput): Promise<Response> {
  const { distributorCode, isPS, periodDate, weekNumber, file, salesFile, stockFile } = input;
  const combinedSize = isPS
    ? (salesFile?.size ?? 0) + (stockFile?.size ?? 0)
    : file?.size ?? 0;

  if (combinedSize <= LARGE_FILE_THRESHOLD) {
    const form = new FormData();
    form.set("distributorCode", distributorCode);
    if (periodDate) form.set("periodDate", periodDate);
    if (weekNumber) form.set("weekNumber", String(weekNumber));
    if (isPS) {
      form.set("salesFile", salesFile as File);
      form.set("stockFile", stockFile as File);
    } else {
      form.set("file", file as File);
    }
    return fetch(endpoint, { body: form, method: "POST" });
  }

  const body: Record<string, string> = { distributorCode };
  if (periodDate) body.periodDate = periodDate;
  if (weekNumber) body.weekNumber = String(weekNumber);
  if (isPS) {
    const [salesStoragePath, stockStoragePath] = await Promise.all([
      uploadWeeklyFileToStorage(salesFile as File),
      uploadWeeklyFileToStorage(stockFile as File),
    ]);
    body.salesStoragePath = salesStoragePath;
    body.stockStoragePath = stockStoragePath;
  } else {
    body.storagePath = await uploadWeeklyFileToStorage(file as File);
  }
  return fetch(endpoint, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
}

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
  // Week-of-month (1–4) this upload covers. The user picks it; the system also derives a suggestion
  // from the sheet date at Validate and flags any mismatch. It is the LABEL stored on the batch.
  const [weekNumber, setWeekNumber] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [stockFile, setStockFile] = useState<File | null>(null);
  const [periodDate, setPeriodDate] = useState("");
  const [batches, setBatches] = useState<WeeklyBatch[]>(initialBatches);

  // Inline re-tag (fix a batch's month-cycle + week) — used for boundary sheets.
  const [retagId, setRetagId] = useState<string | null>(null);
  const [retagWeek, setRetagWeek] = useState(1);
  const [retagMonth, setRetagMonth] = useState(""); // YYYY-MM
  const [retagBusy, setRetagBusy] = useState(false);

  // Step 1 — AI verification
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<WeeklyVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  // Step 2 — Validate (dry run)
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<WeeklySalesValidationResult | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);

  // Step 3 — Confirm Upload (persist)
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(false);

  // Global load error passed from the server
  const [pageError] = useState<string | null>(initialError);

  // Recent-uploads table filters (client-side; all batches are already loaded).
  const [filterDistributor, setFilterDistributor] = useState("");
  const [filterPeriod, setFilterPeriod] = useState("");

  // Multi-select + per-row download
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadingMulti, setDownloadingMulti] = useState(false);

  const uploadPeriods = useMemo(
    () => [...new Set(batches.map((b) => b.weekStart).filter((w): w is string => Boolean(w)))].sort().reverse(),
    [batches],
  );
  const uploadDistributors = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const b of batches) {
      if (b.distributorCode) byCode.set(b.distributorCode, b.distributorName || b.distributorCode);
    }
    return [...byCode.entries()].sort((a, z) => a[1].localeCompare(z[1]));
  }, [batches]);

  const filteredBatches = useMemo(
    () =>
      batches.filter(
        (b) =>
          (!filterDistributor || b.distributorCode === filterDistributor) &&
          (!filterPeriod || b.weekStart === filterPeriod),
      ),
    [batches, filterDistributor, filterPeriod],
  );
  const filtersActive = Boolean(filterDistributor || filterPeriod);

  const allFilteredSelected =
    filteredBatches.length > 0 && filteredBatches.every((b) => selectedIds.has(b.id));

  function toggleAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredBatches.forEach((b) => next.delete(b.id));
      else filteredBatches.forEach((b) => next.add(b.id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSingleDownload(batch: WeeklyBatch) {
    setDownloadingId(batch.id);
    try {
      const params = new URLSearchParams({ distributor: batch.distributorCode, week: batch.weekStart ?? "" });
      const res = await fetch(`/api/sales/weekly/export?${params.toString()}`);
      if (!res.ok) throw new Error("Export failed.");
      triggerDownload(await res.blob(), `phoenix-weekly_${batch.weekStart ?? "no-date"}_${batch.distributorCode}.xlsx`);
    } catch {
      alert("Download failed. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleMultiDownload() {
    setDownloadingMulti(true);
    try {
      const res = await fetch("/api/sales/weekly/export-batches", {
        body: JSON.stringify({ batchIds: [...selectedIds] }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error("Export failed.");
      triggerDownload(await res.blob(), `phoenix-weekly-combined_${selectedIds.size}-batches.xlsx`);
    } catch {
      alert("Download failed. Please try again.");
    } finally {
      setDownloadingMulti(false);
    }
  }

  const isPS = distributorCode === "PS";
  const needsPeriodDate = distributorCode !== "IS-S";
  const filesReady = isPS ? Boolean(salesFile && stockFile) : Boolean(file);
  const canProceed = Boolean(distributorCode) && filesReady && (!needsPeriodDate || Boolean(periodDate));
  const busy = verifying || validating || uploadBusy;

  async function refreshBatches() {
    try {
      const response = await fetch("/api/sales/weekly/batches", { cache: "no-store" });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyBatch[] };
      if (payload?.success && payload.data) setBatches(payload.data);
    } catch {
      /* keep current list on refresh error */
    }
  }

  function clearVerification() {
    setVerified(false);
    setVerifyResult(null);
    setVerifyError(null);
  }

  function clearValidation() {
    setValidateResult(null);
    setValidateError(null);
    setUploadDone(false);
    setUploadError(null);
  }

  function resetFiles() {
    setFile(null);
    setSalesFile(null);
    setStockFile(null);
    clearVerification();
    clearValidation();
  }

  async function handleVerify() {
    if (!filesReady) {
      setVerifyError(isPS ? "Pick both matrix files (sales + stock) first." : "Pick a file first.");
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    setVerified(false);
    clearValidation();
    try {
      const response = await postWeekly("/api/sales/weekly/verify", { distributorCode, file, isPS, salesFile, stockFile });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyVerifyResult; error?: string };
      if (payload?.data) setVerifyResult(payload.data);
      if (!payload?.success) setVerifyError(payload?.error ?? "Verification failed.");
    } catch (caught) {
      setVerifyError(caught instanceof Error ? caught.message : "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleValidate() {
    if (!canProceed) {
      setValidateError(
        isPS
          ? "Pick distributor, both matrix files, and a period date."
          : "Pick a distributor, a file, and (if asked) a period date.",
      );
      return;
    }
    setValidating(true);
    setValidateError(null);
    setValidateResult(null);
    setUploadDone(false);
    setUploadError(null);
    try {
      const response = await postWeekly("/api/sales/weekly/validate", { distributorCode, file, isPS, periodDate, weekNumber, salesFile, stockFile });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklySalesValidationResult; error?: string };
      if (payload?.data) {
        setValidateResult(payload.data);
        // Auto-suggest the week from the sheet date when the user hasn't picked one yet.
        if (weekNumber == null && payload.data.suggestedWeekNumber) setWeekNumber(payload.data.suggestedWeekNumber);
      }
      if (!payload?.success) setValidateError(payload?.error ?? "Validation failed.");
    } catch (caught) {
      setValidateError(caught instanceof Error ? caught.message : "Validation failed — check your network connection.");
    } finally {
      setValidating(false);
    }
  }

  async function handleUpload() {
    if (!validateResult || validateResult.status !== "validated") return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const response = await postWeekly("/api/sales/weekly/upload", { distributorCode, file, isPS, periodDate, weekNumber, salesFile, stockFile });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklySalesValidationResult; error?: string };
      if (payload?.success) {
        setUploadDone(true);
        await refreshBatches();
      } else {
        setUploadError(payload?.error ?? "Upload failed.");
      }
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "Upload failed — check your network connection.");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleDelete(batchId: string) {
    if (!window.confirm("Delete this weekly upload? Its stored rows will be removed.")) return;
    try {
      const response = await fetch(`/api/sales/weekly/batches?batchId=${encodeURIComponent(batchId)}`, { method: "DELETE" });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!payload?.success) alert(payload?.error ?? "Delete failed.");
      else await refreshBatches();
    } catch {
      alert("Delete failed.");
    }
  }

  function startRetag(batch: WeeklyBatch) {
    setRetagId(batch.id);
    setRetagWeek(batch.weekNumber ?? 1);
    setRetagMonth((batch.cycleMonth ?? batch.weekStart ?? "").slice(0, 7));
  }

  async function handleRetag() {
    if (!retagId || !/^\d{4}-\d{2}$/.test(retagMonth)) {
      alert("Pick a valid month for this sheet.");
      return;
    }
    setRetagBusy(true);
    try {
      const response = await fetch("/api/sales/weekly/batches", {
        body: JSON.stringify({ batchId: retagId, cycleMonth: `${retagMonth}-01`, weekNumber: retagWeek }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!payload?.success) {
        alert(payload?.error ?? "Re-tag failed.");
        return;
      }
      setRetagId(null);
      await refreshBatches();
    } catch {
      alert("Re-tag failed.");
    } finally {
      setRetagBusy(false);
    }
  }

  const fileInputClass =
    "h-10 w-full rounded-[6px] border border-phx-line bg-white px-3 py-1.5 text-sm text-phx-ink file:mr-3 file:rounded file:border-0 file:bg-phx-paper-2 file:px-3 file:py-1.5 file:text-sm file:font-bold";

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-phx-accent" aria-hidden />
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">Weekly Sales</span>
        </div>
        <h1 className="mt-1 text-xl font-black text-phx-ink">Upload &amp; Validate</h1>
        <p className="mt-1 text-sm font-medium text-phx-ink-soft">
          Upload a distributor&apos;s raw weekly Sales &amp; Stock file. The system maps it to your products and regions,
          nets returns out of sales, and recomputes value as net × factory price. Nothing is stored until you confirm.
        </p>
        {distributorCode === "Direct" && (
          <p className="mt-2 text-sm font-medium text-[#9A3412]">
            Direct (Company) is different: it&apos;s a hand-coded sheet (Distrub ID / Region ID / Product ID / Qty /
            Invoice Date / Value / Pharmacy Name), region-only (no area/brick), and the Value column is stored
            exactly as written on the sheet — never recomputed from factory price.
          </p>
        )}
      </header>

      {pageError && (
        <div className="flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{pageError}</span>
        </div>
      )}

      {/* Month completeness tracker — advisory reminder, never blocks uploads */}
      <MonthCompletenessTracker batches={batches} />

      {/* Upload card */}
      <div className={`${card} p-4 sm:p-5`}>

        {/* ── Step 1: Week of month ── */}
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-phx-2xs font-black text-white">1</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Week of month</span>
            {weekNumber && (
              <span className="inline-flex items-center rounded bg-phx-accent-soft px-2 py-0.5 text-phx-xs font-black text-[#9A3412]">Week {weekNumber}</span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            Distributor sheets are cumulative within a month (week 2 already includes week 1, and so on). Pick the week this
            file covers — the system also reads the date inside the file and flags any mismatch when you validate.
          </p>
          <div className="mt-2 inline-flex flex-wrap gap-2">
            {[1, 2, 3, 4].map((w) => (
              <button
                className={`h-10 min-w-[88px] rounded-[6px] border px-4 text-sm font-black transition disabled:opacity-60 ${
                  weekNumber === w
                    ? "border-phx-accent bg-phx-accent text-white"
                    : "border-phx-line bg-white text-phx-ink hover:border-phx-accent-line"
                }`}
                disabled={busy}
                key={w}
                onClick={() => setWeekNumber(w)}
                type="button"
              >
                Week {w}
              </button>
            ))}
          </div>
        </div>

        {/* ── Step 2: Distributor & file ── */}
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-phx-2xs font-black text-white">2</span>
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Distributor &amp; file</span>
        </div>

        {/* File selectors */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Distributor</span>
            <SearchableSelect
              className="h-10 w-full rounded-[6px] border border-phx-line bg-white px-3 text-sm font-bold text-phx-ink outline-none focus:border-phx-accent-line"
              disabled={busy}
              onChange={(event) => {
                setDistributorCode(event.target.value);
                resetFiles();
                setValidateResult(null);
              }}
              value={distributorCode}
            >
              {distributors.length === 0 && <option value="">No distributors registered</option>}
              {distributors.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name} ({d.code})
                </option>
              ))}
            </SearchableSelect>
          </label>

          {isPS ? (
            <>
              <label className="block">
                <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">POS sales matrix (.xlsx)</span>
                <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(e) => { setSalesFile(e.target.files?.[0] ?? null); clearVerification(); clearValidation(); }} type="file" />
              </label>
              <label className="block">
                <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">POS stock matrix (.xlsx)</span>
                <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(e) => { setStockFile(e.target.files?.[0] ?? null); clearVerification(); clearValidation(); }} type="file" />
              </label>
            </>
          ) : (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Weekly file (.xlsx)</span>
              <input accept=".xlsx" className={fileInputClass} disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); clearVerification(); clearValidation(); }} type="file" />
            </label>
          )}
        </div>

        {needsPeriodDate && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Period date</span>
              <input
                className="h-10 rounded-[6px] border border-phx-line bg-white px-3 text-sm font-bold text-phx-ink outline-none focus:border-phx-accent-line"
                disabled={busy}
                onChange={(e) => { setPeriodDate(e.target.value); clearValidation(); }}
                type="date"
                value={periodDate}
              />
            </label>
            <span className="pb-2 text-xs font-medium text-phx-ink-faint">
              {isPS || distributorCode === "IS"
                ? "This file has no date column — pick the week it covers."
                : "This file spans many invoice dates — pick the period it represents."}
            </span>
          </div>
        )}

        {/* ── Step 1: AI Verify ── */}
        <div className="mt-5 border-t border-dashed border-phx-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-phx-2xs font-black text-white">3</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Verify columns</span>
            {verified && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-phx-xs font-black text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" /> Verified
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            AI reads the column headers and shows which data it will take from which column. Only column titles are sent — never sales numbers.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#020617] bg-white px-4 text-sm font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-60"
              disabled={busy || !filesReady}
              onClick={handleVerify}
              type="button"
            >
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-phx-accent" />}
              {verifying ? "Analyzing…" : verifyResult ? "Re-run verification" : "Run AI verification"}
            </button>
            {!filesReady && <span className="text-xs font-medium text-phx-ink-faint">Pick the file(s) above first.</span>}
          </div>

          {verifyError && (
            <div className="mt-3 flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{verifyError}</span>
            </div>
          )}

          {verifyResult && <VerifyPanel result={verifyResult} verified={verified} onConfirm={() => setVerified(true)} />}
        </div>

        {/* ── Step 2: Validate (dry run) ── */}
        <div className="mt-5 border-t border-dashed border-phx-line pt-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-phx-2xs font-black text-white">4</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Validate</span>
            {validateResult && !validateError && (
              <span className={`inline-flex items-center rounded px-2 py-0.5 text-phx-xs font-black ${validateResult.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {validateResult.status === "validated" ? "Ready to upload" : "Blocked"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            Parses the file, maps products and branches, checks for issues. Shows totals per product and per branch. Nothing is stored yet.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-ink px-4 text-sm font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-phx-line-strong disabled:hover:bg-phx-line-strong"
              disabled={busy || !canProceed || !verified}
              onClick={handleValidate}
              type="button"
            >
              {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : !verified ? <Lock className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}
              {validating ? "Validating…" : "Validate"}
            </button>
            {!verified && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-phx-ink-faint">
                <Lock className="h-3.5 w-3.5" /> Complete verification above to unlock.
              </span>
            )}
          </div>

          {validateError && (
            <div className="mt-3 flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{validateError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Validation result + Step 3 confirm upload */}
      {validateResult && (
        <ValidationResultPanel
          result={validateResult}
          selectedWeek={weekNumber}
          onPickWeek={setWeekNumber}
          uploadBusy={uploadBusy}
          uploadDone={uploadDone}
          uploadError={uploadError}
          onUpload={handleUpload}
        />
      )}

      {/* Recent uploads */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink-soft">Recent weekly uploads</h2>
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              aria-label="Filter by distributor"
              className="h-8 rounded-[6px] border border-phx-line bg-white px-2 text-xs font-semibold text-phx-ink outline-none focus:border-phx-accent-line"
              onChange={(e) => setFilterDistributor(e.target.value)}
              value={filterDistributor}
            >
              <option value="">All distributors</option>
              {uploadDistributors.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              aria-label="Filter by period"
              className="h-8 rounded-[6px] border border-phx-line bg-white px-2 text-xs font-semibold text-phx-ink outline-none focus:border-phx-accent-line"
              onChange={(e) => setFilterPeriod(e.target.value)}
              value={filterPeriod}
            >
              <option value="">All periods</option>
              {uploadPeriods.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </SearchableSelect>
            {filtersActive && (
              <button
                className="inline-flex items-center gap-1 rounded-[6px] border border-phx-line bg-white px-2 py-1.5 text-xs font-semibold text-phx-ink-soft transition hover:bg-phx-paper"
                onClick={() => { setFilterDistributor(""); setFilterPeriod(""); }}
                type="button"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
            <span className="text-phx-xs font-bold tabular-nums text-phx-ink-faint">
              {filteredBatches.length} of {batches.length}
            </span>
          </div>
        </div>

        {/* Multi-select action bar */}
        {selectedIds.size > 0 && (
          <div className="mb-2 flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#020617] px-3 py-1.5 text-phx-xs font-black uppercase tracking-wide text-white transition hover:bg-[#1E293B] disabled:opacity-60"
              disabled={downloadingMulti}
              onClick={handleMultiDownload}
              type="button"
            >
              {downloadingMulti ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Download {selectedIds.size} selected
            </button>
            <button
              className="text-phx-xs text-phx-ink-faint transition hover:text-phx-ink"
              onClick={() => setSelectedIds(new Set())}
              type="button"
            >
              Clear selection
            </button>
          </div>
        )}

        <div className={`overflow-x-auto ${card}`}>
          <table className="w-full text-sm">
            <thead className={darkHead}>
              <tr>
                <th className="px-3 py-2">
                  <input
                    aria-label="Select all"
                    checked={allFilteredSelected}
                    className="accent-phx-accent"
                    onChange={toggleAll}
                    type="checkbox"
                  />
                </th>
                <th className="px-3 py-2">Period</th>
                <th className="px-3 py-2">Week</th>
                <th className="px-3 py-2">Distributor</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Net units</th>
                <th className="px-3 py-2 text-right">Stock units</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filteredBatches.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-phx-ink-faint" colSpan={9}>
                    {batches.length === 0 ? "No weekly uploads yet." : "No uploads match the current filters."}
                  </td>
                </tr>
              )}
              {filteredBatches.map((batch) => (
                <tr className="border-t border-[#FFE8D6]" key={batch.id}>
                  <td className="px-3 py-2">
                    <input
                      aria-label={`Select ${batch.distributorName} ${batch.weekStart ?? ""}`}
                      checked={selectedIds.has(batch.id)}
                      className="accent-phx-accent"
                      onChange={() => toggleOne(batch.id)}
                      type="checkbox"
                    />
                  </td>
                  <td className="px-3 py-2 font-bold text-phx-ink">
                    {retagId === batch.id ? (
                      <input
                        aria-label="Cycle month"
                        className="h-8 rounded-[6px] border border-phx-line bg-white px-2 text-xs font-bold text-phx-ink outline-none focus:border-phx-accent-line"
                        onChange={(e) => setRetagMonth(e.target.value)}
                        type="month"
                        value={retagMonth}
                      />
                    ) : (
                      batch.weekStart ?? "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {retagId === batch.id ? (
                      <select
                        aria-label="Week of month"
                        className="h-8 rounded-[6px] border border-phx-line bg-white px-1 text-xs font-bold text-phx-ink outline-none focus:border-phx-accent-line"
                        onChange={(e) => setRetagWeek(Number(e.target.value))}
                        value={retagWeek}
                      >
                        {[1, 2, 3, 4].map((w) => (
                          <option key={w} value={w}>Week {w}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="inline-flex items-center rounded bg-phx-accent-soft px-2 py-0.5 text-phx-xs font-black text-[#9A3412]">
                        {batch.weekNumber ? `W${batch.weekNumber}` : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{batch.distributorName}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-phx-xs font-black ${batch.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                      {batch.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalRows)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalNetQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(batch.totalStockQty)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      {retagId === batch.id ? (
                        <>
                          <button
                            className="inline-flex h-8 items-center gap-1 rounded-[6px] bg-phx-accent px-2.5 text-xs font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
                            disabled={retagBusy}
                            onClick={handleRetag}
                            type="button"
                          >
                            {retagBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            Save
                          </button>
                          <button
                            aria-label="Cancel re-tag"
                            className="inline-flex text-phx-ink-faint transition hover:text-phx-ink"
                            onClick={() => setRetagId(null)}
                            type="button"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            aria-label="Download XLSX report"
                            className="inline-flex text-phx-ink-faint transition hover:text-phx-accent disabled:opacity-40"
                            disabled={downloadingId === batch.id}
                            onClick={() => handleSingleDownload(batch)}
                            type="button"
                          >
                            {downloadingId === batch.id
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <Download className="h-4 w-4" />}
                          </button>
                          <button
                            aria-label="Re-tag week / month"
                            className="inline-flex text-phx-ink-faint transition hover:text-phx-accent"
                            onClick={() => startRetag(batch)}
                            type="button"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            aria-label="Delete upload"
                            className="inline-flex text-phx-ink-faint transition hover:text-rose-600"
                            onClick={() => handleDelete(batch.id)}
                            type="button"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
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

// ── Validation result panel (step 2 output + step 3 confirm) ──────────────────────────────────────

// Failure messages quote the exact code/name that needs fixing (master product code, branch name,
// region code, ...) — pull it out so links can pre-fill the target screen's search box, which is
// more reliable than the raw sheet value on rows where an alias already remapped it.
function extractQuoted(message: string): string | null {
  const match = message.match(/"([^"]*)"/);
  return match && match[1] ? match[1] : null;
}

type MapAction =
  | { label: string; kind: "branch" }
  | { label: string; kind: "products"; search: string | null }
  | { label: string; kind: "product-alias"; alias: string | null };

type IssueGroup = {
  key: string;
  field: string;
  message: string;
  rowNumbers: number[];
  action: MapAction | null;
};

// Every blocking field maps to exactly one existing manager that can resolve it inline. A missing
// alias (no distributor code/name maps to a Phoenix product yet) is Weekly's own alias table — the
// operator adds one. An alias that resolves to missing/bad master product data (no price, no line,
// or resolves to a code that isn't in the master at all) is Source of Sales master data, out of
// Weekly's own tables — nothing to "map," it's the master row itself that needs fixing, so that
// stays a read-only reference lookup. An unmapped branch is Weekly's own branch->region table. A
// Direct-channel region code not in the SoS master region list has no editable UI (regions derive
// from the brick/area master, not a flat list) — null means "show the valid codes instead of a map
// action" (see UnresolvedItemRow).
function actionForIssue(field: string, message: string): MapAction | null {
  if (field === "productCode" && message.startsWith("No product alias maps")) {
    return { label: "Map now", kind: "product-alias", alias: extractQuoted(message) };
  }
  if (field === "productCode" || field === "officialLine" || field === "factoryPrice") {
    return { label: "Map now", kind: "products", search: extractQuoted(message) };
  }
  if (field === "regionCode") {
    if (message.includes("Source of Sales master region table")) return null;
    return { label: "Map now", kind: "branch" };
  }
  return null;
}

function groupUnresolvedIssues(result: WeeklySalesValidationResult): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of result.issues) {
    if (issue.severity !== "failure") continue;
    const key = `${issue.field}|${issue.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rowNumbers.push(issue.rowNumber);
      continue;
    }
    groups.set(key, {
      key,
      field: issue.field,
      message: issue.message,
      rowNumbers: [issue.rowNumber],
      action: actionForIssue(issue.field, issue.message),
    });
  }
  return [...groups.values()];
}

function downloadUnmapped(result: WeeklySalesValidationResult) {
  const seen = new Set<string>();
  const lines = ["field,value,reason"];
  for (const issue of result.issues) {
    if (issue.severity !== "failure") continue;
    const value = (issue.value ?? "").replace(/"/g, "'");
    const key = `${issue.field}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

const FIELD_LABELS: Record<string, string> = {
  factoryPrice: "Price",
  officialLine: "Line",
  productCode: "Product",
  regionCode: "Region",
};

function MapNowModal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-[6px] border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-phx-line bg-white px-5 py-3">
          <h2 className="text-sm font-black text-phx-ink">{title}</h2>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-phx-line text-phx-ink-soft transition hover:border-phx-accent-line"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Self-fetches the product list on open (the wizard page never loads it up front) so the Products
// Reference manager can render with real data pre-filtered to the code that's actually broken.
function InlineSosProductsModal({ onClose, search }: { onClose: () => void; search: string | null }) {
  const [products, setProducts] = useState<SourceOfSalesProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/sales/source-of-sales/products", { cache: "no-store" });
        const payload = (await response.json()) as { success?: boolean; data?: SourceOfSalesProduct[]; error?: string };
        if (cancelled) return;
        if (payload?.success && payload.data) setProducts(payload.data);
        else setError(payload?.error ?? "Failed to load Source of Sales products.");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load Source of Sales products.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <MapNowModal onClose={onClose} title="Source of Sales — Products Reference">
      {error ? (
        <div className="flex items-start gap-2 p-6 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : products ? (
        <SourceOfSalesProductsTab initialProducts={products} initialSearch={search ?? undefined} />
      ) : (
        <div className="flex items-center justify-center p-16">
          <Loader2 className="h-6 w-6 animate-spin text-phx-ink-faint" />
        </div>
      )}
    </MapNowModal>
  );
}

// Direct-channel region codes are validated straight against the SoS master region list (see
// resolveRegion in parser.ts) — there's no flat "regions" table to add a row to (regions derive
// from the brick/area master), so instead of a map action, let the operator see the valid codes
// right here and fix the typo in their own file.
function ValidRegionCodesInline({ distributorCode }: { distributorCode: string }) {
  const [open, setOpen] = useState(false);
  const [regions, setRegions] = useState<{ regionCode: string; regionName: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (regions || error) return;
    try {
      const params = new URLSearchParams({ distributor: distributorCode, fileType: "any" });
      const response = await fetch(`/api/sales/weekly/branch-mapping?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success?: boolean;
        data?: { masterRegions?: { regionCode: string; regionName: string }[] };
        error?: string;
      };
      if (payload?.success && payload.data?.masterRegions) setRegions(payload.data.masterRegions);
      else setError(payload?.error ?? "Failed to load region codes.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load region codes.");
    }
  }

  return (
    <>
      <button
        className="ml-auto inline-flex h-7 items-center gap-1 rounded-[6px] border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
        onClick={() => void toggle()}
        type="button"
      >
        {open ? "Hide" : "Show"} valid region codes
      </button>
      {open && (
        <div className="w-full basis-full">
          {error ? (
            <span className="text-xs font-semibold text-rose-600">{error}</span>
          ) : regions ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {regions.map((region) => (
                <span
                  className="rounded-[4px] border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-xs font-bold text-phx-ink-2"
                  key={region.regionCode}
                >
                  {region.regionName} ({region.regionCode})
                </span>
              ))}
            </div>
          ) : (
            <Loader2 className="mt-1 h-3.5 w-3.5 animate-spin text-phx-ink-faint" />
          )}
        </div>
      )}
    </>
  );
}

function UnresolvedItemRow({
  distributorCode,
  group,
  onMap,
}: {
  distributorCode: string;
  group: IssueGroup;
  onMap: (action: MapAction) => void;
}) {
  // regionCode with no action is exactly the Direct-channel "not in the SoS master region list" case
  // (see actionForIssue) — the only unresolved-item type with no editable screen to map into.
  const showValidRegionCodes = group.field === "regionCode" && group.action === null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] border border-rose-200 bg-white px-3 py-2">
      <span className="rounded-[4px] bg-rose-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-rose-700">
        {FIELD_LABELS[group.field] ?? group.field}
      </span>
      <span className="text-sm font-semibold text-phx-ink-2">{group.message}</span>
      <span className="text-xs font-medium text-phx-ink-faint">
        {group.rowNumbers.length} row{group.rowNumbers.length === 1 ? "" : "s"}
        {" "}(e.g. row {group.rowNumbers[0]})
      </span>
      {group.action && (
        <button
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[6px] bg-[#0B0B0B] px-3 text-xs font-black text-white transition hover:bg-phx-accent"
          onClick={() => onMap(group.action as MapAction)}
          type="button"
        >
          <Pencil className="h-3 w-3" /> {group.action.label}
        </button>
      )}
      {showValidRegionCodes && <ValidRegionCodesInline distributorCode={distributorCode} />}
    </div>
  );
}

function UnresolvedItemsPanel({ result }: { result: WeeklySalesValidationResult }) {
  const groups = useMemo(() => groupUnresolvedIssues(result), [result]);
  const [modal, setModal] = useState<MapAction | null>(null);
  if (groups.length === 0) return null;

  return (
    <div className="border-b border-phx-line bg-rose-50/60 px-4 py-3">
      <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-rose-700">
        Unresolved items ({groups.length}) — map these to unblock the upload
      </h3>
      <div className="space-y-2">
        {groups.map((group) => (
          <UnresolvedItemRow distributorCode={result.distributor.code} group={group} key={group.key} onMap={setModal} />
        ))}
      </div>
      <p className="mt-2 text-xs font-medium text-phx-ink-faint">
        Map it right here, then click Validate again to re-check this file.
      </p>
      {modal?.kind === "branch" && (
        <MapNowModal onClose={() => setModal(null)} title="Weekly Mapping — Branch → Region">
          <WeeklyBranchMappingManager initial={null} initialError={null} lockedDistributor={result.distributor.code} />
        </MapNowModal>
      )}
      {modal?.kind === "products" && <InlineSosProductsModal onClose={() => setModal(null)} search={modal.search} />}
      {modal?.kind === "product-alias" && (
        <MapNowModal onClose={() => setModal(null)} title="Weekly Mapping — Product Alias">
          <WeeklyProductMappingManager
            initial={null}
            initialError={null}
            lockedDistributor={result.distributor.code}
            prefillAlias={modal.alias ?? undefined}
          />
        </MapNowModal>
      )}
    </div>
  );
}

function ExcludedItemsPanel({ items }: { items: WeeklyExcludedItem[] }) {
  const rows = items.reduce((sum, item) => sum + item.rows, 0);
  const netQty = items.reduce((sum, item) => sum + item.netQty, 0);

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="text-xs font-black uppercase tracking-wide text-phx-ink-2">
        Excluded on purpose ({items.length}) — {num(rows)} rows, {num(netQty)} net units kept out of the numbers
      </h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="py-1 pr-4 whitespace-nowrap">Item code</th>
              <th className="py-1 pr-4 whitespace-nowrap">Item name</th>
              <th className="py-1 pr-4 text-right whitespace-nowrap">Rows</th>
              <th className="py-1 pr-4 text-right whitespace-nowrap">Net units</th>
              <th className="py-1 text-right whitespace-nowrap">Stock units</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr className="border-t border-phx-line" key={`${item.itemCode}|${item.itemName}`}>
                <td className="py-1 pr-4 font-semibold text-phx-ink whitespace-nowrap">{item.itemCode || "—"}</td>
                <td className="py-1 pr-4 text-phx-ink-2 whitespace-nowrap">{item.itemName || "—"}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(item.rows)}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(item.netQty)}</td>
                <td className="py-1 text-right tabular-nums text-phx-ink-2">{num(item.stockQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs font-medium text-phx-ink-faint">
        These items are mapped to IGNORE in Weekly Mapping — not Phoenix products. Re-point the mapping to a real product if any of them belongs to a line.
      </p>
    </div>
  );
}

function ExcludedBranchesPanel({ branches }: { branches: WeeklyExcludedBranch[] }) {
  const rows = branches.reduce((sum, branch) => sum + branch.rows, 0);
  const netQty = branches.reduce((sum, branch) => sum + branch.netQty, 0);
  const stockQty = branches.reduce((sum, branch) => sum + branch.stockQty, 0);

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="text-xs font-black uppercase tracking-wide text-phx-ink-2">
        Branches excluded on purpose ({branches.length}) — {num(rows)} rows, {num(netQty)} net and {num(stockQty)} stock units kept out of the numbers
      </h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="py-1 pr-4 whitespace-nowrap">Branch</th>
              <th className="py-1 pr-4 whitespace-nowrap">Branch name</th>
              <th className="py-1 pr-4 text-right whitespace-nowrap">Rows</th>
              <th className="py-1 pr-4 text-right whitespace-nowrap">Net units</th>
              <th className="py-1 text-right whitespace-nowrap">Stock units</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
              <tr className="border-t border-phx-line" key={`${branch.rawBranch}|${branch.branchColumnIndex ?? ""}`}>
                <td className="py-1 pr-4 font-semibold text-phx-ink whitespace-nowrap">{branch.rawBranch || (branch.branchColumnIndex != null ? `Column ${branch.branchColumnIndex}` : "—")}</td>
                <td className="py-1 pr-4 text-phx-ink-2 whitespace-nowrap">{branch.branchName || "—"}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(branch.rows)}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(branch.netQty)}</td>
                <td className="py-1 text-right tabular-nums text-phx-ink-2">{num(branch.stockQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs font-medium text-phx-ink-faint">
        These depots are ticked &quot;excluded&quot; in the Weekly Mapping branch list, so none of their volume reaches the dashboard. Untick a branch there if its sales should count.
      </p>
    </div>
  );
}

/**
 * What the file said its own totals were, against what the import read.
 *
 * Shown on every upload, including when everything agrees and including when the format states no
 * total at all. That last case is the point: the 2026-08 POS batch stored 172,046 units against a true
 * 1,048 and validated cleanly, because nothing compared the result to anything and nothing on this
 * screen said so. A silent absence is indistinguishable from a passed check, so it is spelled out.
 */
function FileSelfCheckPanel({ fileTotals }: { fileTotals: WeeklyFileTotalsReport }) {
  const mismatches = fileTotals.checks.filter((check) => check.status === "mismatch").length;
  const headline =
    fileTotals.absence !== null
      ? "File self-check — this file states no total of its own"
      : mismatches > 0
        ? `File self-check — ${num(mismatches)} of ${num(fileTotals.checks.length)} disagree with the file`
        : `File self-check — all ${num(fileTotals.checks.length)} agree with the file`;

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="text-xs font-black uppercase tracking-wide text-phx-ink-2">{headline}</h3>

      {fileTotals.absence !== null ? (
        <p className="mt-2 text-sm font-medium text-phx-ink-2">{fileTotals.absence.reason}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
              <tr>
                <th className="py-1 pr-4 whitespace-nowrap">What the file states</th>
                <th className="py-1 pr-4 whitespace-nowrap">Where</th>
                <th className="py-1 pr-4 text-right whitespace-nowrap">File says</th>
                <th className="py-1 pr-4 text-right whitespace-nowrap">Import read</th>
                <th className="py-1 whitespace-nowrap">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {fileTotals.checks.map((check) => (
                <tr className="border-t border-phx-line" key={`${check.label}|${check.where}`}>
                  <td className="py-1 pr-4 font-semibold text-phx-ink whitespace-nowrap">{check.label}</td>
                  <td className="py-1 pr-4 text-phx-ink-2 whitespace-nowrap">{check.where}</td>
                  <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(check.declared)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(check.parsed)}</td>
                  <td
                    className={`py-1 font-bold whitespace-nowrap ${
                      check.status === "ok"
                        ? "text-emerald-700"
                        : check.severity === "block"
                          ? "text-red-700"
                          : "text-amber-700"
                    }`}
                  >
                    {check.status === "ok"
                      ? "Agrees"
                      : check.severity === "block"
                        ? "Disagrees — import stopped"
                        : "Disagrees — please check"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fileTotals.absence === null && mismatches === 0 && (
        <p className="mt-2 text-xs font-medium text-phx-ink-faint">
          The numbers below were read the way the file itself says they should add up.
        </p>
      )}
    </div>
  );
}

function ValidationResultPanel({
  result,
  selectedWeek,
  onPickWeek,
  onUpload,
  uploadBusy,
  uploadError,
  uploadDone,
}: {
  result: WeeklySalesValidationResult;
  selectedWeek: number | null;
  onPickWeek: (week: number) => void;
  onUpload: () => void;
  uploadBusy: boolean;
  uploadError: string | null;
  uploadDone: boolean;
}) {
  const validated = result.status === "validated";
  const isPS = result.distributor.code === "PS";
  const hasFailures = result.failedRows > 0;
  const t = result.totals;
  const tw = result.thisWeekOnly;
  const weekMismatch =
    result.suggestedWeekNumber != null && selectedWeek != null && selectedWeek !== result.suggestedWeekNumber;

  return (
    <div className={card}>
      {/* Header */}
      <div className={`flex flex-wrap items-center gap-2 border-b border-phx-line px-4 py-3 text-sm font-black ${validated ? "text-emerald-700" : "text-amber-700"}`}>
        {validated ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {validated ? `Validation passed — ${result.rowCount} rows ready for upload` : "Validation blocked — fix the issues below"}
        <span className="ml-auto text-xs font-bold text-phx-ink-soft">{result.distributor.name} · {result.weekStart ?? "no date"}</span>
        {hasFailures && (
          <button
            className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
            onClick={() => downloadUnmapped(result)}
            type="button"
          >
            <Download className="h-3.5 w-3.5" /> Unmapped items (.csv)
          </button>
        )}
      </div>

      {/* Week-of-month mismatch (selected vs date-derived suggestion) */}
      {weekMismatch && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            You picked <b>Week {selectedWeek}</b>, but this sheet&apos;s date ({result.weekStart ?? "—"}) looks like{" "}
            <b>Week {result.suggestedWeekNumber}</b>.
          </span>
          <button
            className="ml-1 inline-flex h-7 items-center rounded-[6px] border border-amber-300 bg-white px-2 text-xs font-black text-amber-800 transition hover:bg-amber-100"
            onClick={() => onPickWeek(result.suggestedWeekNumber as number)}
            type="button"
          >
            Switch to Week {result.suggestedWeekNumber}
          </button>
        </div>
      )}

      {/* This week only — de-cumulated preview vs the previous cumulative sheet of this month-cycle */}
      {tw && (
        <div className="border-b border-phx-line bg-[#F0FDF4] px-4 py-3">
          <div className="text-phx-xs font-black uppercase tracking-wide text-emerald-700">
            This week only{selectedWeek ? ` — Week ${selectedWeek}` : ""} (de-cumulated)
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm font-bold text-phx-ink">
            <span>Net units: <span className="text-phx-accent">{num(tw.netQty)}</span></span>
            <span className="text-xs font-medium text-phx-ink-soft">
              {tw.priorWeekStart
                ? `= this sheet (cumulative ${num(t.netQty)} units) − previous sheet of the month (${tw.priorWeekStart})`
                : "first sheet of the month — equals the full cumulative figure"}
            </span>
          </div>
          <div className="mt-1 text-xs font-medium text-phx-ink-faint">
            Stock {num(tw.stockQty)} units is a snapshot — shown as-is, never subtracted.
          </div>
        </div>
      )}

      {/* Blocking reasons */}
      {result.blockingReasons.length > 0 && (
        <ul className="list-disc space-y-1 border-b border-phx-line bg-amber-50 px-8 py-3 text-sm font-semibold text-amber-800">
          {result.blockingReasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}

      {/* Heads-up notes that do NOT stop the import — currently the file-total checks whose invariant
          has not yet been proven against a real file of that format. */}
      {result.advisories && result.advisories.length > 0 && (
        <ul className="list-disc space-y-1 border-b border-phx-line bg-amber-50/60 px-8 py-3 text-sm font-semibold text-amber-900">
          {result.advisories.map((advisory) => <li key={advisory}>{advisory}</li>)}
        </ul>
      )}

      {/* What the file said about itself, against what we read — shown on every upload, including
          when it agrees and when the format states nothing to check. */}
      {result.fileTotals && <FileSelfCheckPanel fileTotals={result.fileTotals} />}

      {/* Unresolved items — one row per unique unmapped product/region/price/line problem, each with
          a direct link to the screen that actually fixes it (Weekly Mapping for aliases/branches,
          Source of Sales for master product data), instead of making the operator hunt for it. */}
      {hasFailures && <UnresolvedItemsPanel result={result} />}

      {/* Excluded on purpose — items whose mapping is "IGNORE" (not a Phoenix product). They never
          reach the numbers, so every one is listed with its units: counted and shown, never a
          silent drop. */}
      {result.excludedItems.length > 0 && <ExcludedItemsPanel items={result.excludedItems} />}

      {/* Excluded on purpose — depots whose branch→region mapping is ticked "excluded". Same rule as
          the items above: their whole volume leaves the numbers, so it is counted and shown here
          rather than disappearing with nothing to reconcile against. */}
      {result.excludedBranches.length > 0 && <ExcludedBranchesPanel branches={result.excludedBranches} />}

      {isPS && (
        <p className="border-b border-phx-line bg-phx-accent-soft px-4 py-2 text-xs font-semibold text-[#9A3412]">
          Overseas POS files carry a single net quantity per outlet, so Sales and Return are shown as the net figure (Return = 0); Net is the true value.
        </p>
      )}

      {/* KPI strip */}
      {/* Validation is a UNITS check — the operator is confirming quantities parsed correctly, not
          money. Value is derived downstream from Product Master factory price, so showing EGP here
          invites reconciling against a figure this step does not own. Units only (owner's rule). */}
      <div className="grid grid-cols-2 gap-px bg-phx-line sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Rows" value={num(result.rowCount)} />
        <Metric label="Importable" value={num(result.importableRows)} />
        <Metric label="Sales units" value={num(t.salesQty)} />
        <Metric label="Return units" value={num(t.returnQty)} />
        <Metric label="Net units" value={num(t.netQty)} accent />
        <Metric label="Stock units" value={num(t.stockQty)} />
      </div>

      {/* Summary tables */}
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <SummaryTable
          title="By product"
          head={["Product", "Sales", "Return", "Net", "Stock"]}
          rows={result.byProduct.map((p) => [
            p.productName || p.productCode,
            num(p.salesQty), num(p.returnQty), num(p.netQty), num(p.stockQty),
          ])}
        />
        <SummaryTable
          title="By branch"
          head={["Branch", "Sales", "Return", "Net", "Stock"]}
          rows={result.byBranch.map((b) => [
            b.branchName || b.branchCode,
            num(b.salesQty), num(b.returnQty), num(b.netQty), num(b.stockQty),
          ])}
        />
        <SummaryTable
          title="By region"
          head={["Region", "Sales", "Return", "Net", "Stock"]}
          rows={result.byRegion.map((r) => [
            r.regionName || r.regionCode,
            num(r.salesQty), num(r.returnQty), num(r.netQty), num(r.stockQty),
          ])}
        />
      </div>

      {/* Row issues */}
      {result.issues.length > 0 && (
        <div className="border-t border-phx-line p-4">
          <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-phx-ink-soft">
            Row issues ({result.issues.length})
          </h3>
          <div className="max-h-56 overflow-auto rounded-[6px] border border-[#FFE8D6]">
            <table className="w-full text-xs">
              <tbody>
                {result.issues.slice(0, 100).map((issue, i) => (
                  <tr className="border-t border-[#FFE8D6]" key={`${issue.rowNumber}-${i}`}>
                    <td className="px-2 py-1 font-bold text-phx-ink-soft">Row {issue.rowNumber}</td>
                    <td className="px-2 py-1">
                      <span className={issue.severity === "failure" ? "text-rose-600" : "text-amber-600"}>{issue.severity}</span>
                    </td>
                    <td className="px-2 py-1 text-phx-ink-2">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 3 — Confirm Upload */}
      <div className="border-t border-phx-line px-4 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#020617] text-phx-2xs font-black text-white">5</span>
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Confirm &amp; Upload</span>
        </div>

        {uploadDone ? (
          <div className="flex items-center gap-2 rounded-[6px] bg-emerald-50 border border-emerald-200 px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
            <div>
              <p className="text-sm font-black text-emerald-700">Stored successfully — period {result.weekStart ?? "—"}</p>
              <p className="text-xs font-medium text-emerald-600 mt-0.5">{result.rowCount} rows saved. The Recent uploads table has been refreshed.</p>
            </div>
          </div>
        ) : validated ? (
          <div className="flex flex-wrap items-center gap-3">
            {uploadError && (
              <div className="w-full flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-phx-line-strong disabled:hover:bg-phx-line-strong"
              disabled={uploadBusy}
              onClick={onUpload}
              type="button"
            >
              {uploadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploadBusy ? "Uploading…" : "Confirm & Upload"}
            </button>
            <span className="text-xs font-medium text-phx-ink-soft">
              Validation passed. Review the tables above, then confirm to store the data.
            </span>
          </div>
        ) : (
          <p className="text-xs font-semibold text-amber-700">
            Fix the issues above and re-validate before uploading.
          </p>
        )}
      </div>
    </div>
  );
}

// ── AI Verify panel (step 1 output) ──────────────────────────────────────────────────────────────

function StatusPill({ status, note }: { status: WeeklyVerifyColumnStatus; note: string }) {
  const map: Record<WeeklyVerifyColumnStatus, { label: string; cls: string }> = {
    match: { label: "Match", cls: "bg-emerald-50 text-emerald-700" },
    drift: { label: "Drift", cls: "bg-rose-50 text-rose-700" },
    uncertain: { label: "Check", cls: "bg-slate-100 text-slate-600" },
    empty: { label: "Empty", cls: "bg-rose-50 text-rose-700" },
  };
  const pill = map[status] ?? map.uncertain;
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-phx-xs font-black ${pill.cls}`} title={note || undefined}>
      {pill.label}
    </span>
  );
}

function VerifyPanel({ result, verified, onConfirm }: { result: WeeklyVerifyResult; verified: boolean; onConfirm: () => void }) {
  const drift = result.verdict === "drift";
  return (
    <div className={`mt-3 ${card}`}>
      <div className={`flex flex-wrap items-center gap-2 border-b border-phx-line px-4 py-3 text-sm font-black ${drift ? "text-amber-700" : "text-emerald-700"}`}>
        {drift ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {drift ? "Possible column drift — review carefully" : "Columns look consistent"}
        <span className={`ml-auto inline-flex items-center rounded px-2 py-0.5 text-phx-xs font-bold ${result.aiUsed ? "bg-phx-accent-soft text-[#9A3412]" : "bg-slate-100 text-slate-600"}`}>
          {result.aiUsed ? "AI checked" : "AI unavailable — manual review"}
        </span>
      </div>

      {result.aiNote && (
        <p className="border-b border-phx-line bg-phx-paper px-4 py-2 text-xs font-semibold text-phx-ink-2">{result.aiNote}</p>
      )}

      {result.files.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-phx-line px-4 py-2 text-xs text-phx-ink-soft">
          {result.files.map((f) => (
            <span key={`${f.role}-${f.fileName}`}>
              <span className="font-black uppercase tracking-wide text-phx-ink-faint">{f.role}</span> · {f.fileName} → &quot;{f.sheetName}&quot;
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
            {result.columns.map((col, i) => (
              <tr className="border-t border-[#FFE8D6]" key={`${col.sheetRole}-${col.field}-${i}`}>
                <td className="px-3 py-1.5 font-bold text-phx-ink">
                  {col.label}{col.critical && <span className="ml-1 text-phx-accent">*</span>}
                </td>
                <td className="px-3 py-1.5 text-phx-ink-soft">{col.sheetRole}</td>
                <td className="px-3 py-1.5 text-center tabular-nums text-phx-ink-2">{col.columnIndex}</td>
                <td className="px-3 py-1.5 text-phx-ink">
                  {col.observedHeader || <span className="text-rose-600">— empty —</span>}
                </td>
                <td className="px-3 py-1.5 text-phx-ink-faint">{col.expectedHeaderHint}</td>
                <td className="px-3 py-1.5"><StatusPill note={col.note} status={col.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.matrices.length > 0 && (
        <div className="space-y-2 border-t border-phx-line px-4 py-3">
          {result.matrices.map((matrix, i) => (
            <div className="text-xs" key={`${matrix.sheetRole}-${i}`}>
              <div className="font-black text-phx-ink">
                {matrix.kind === "branch-headers" ? "Branches / outlets (as column headers)" : "Storage locations (one per column)"} — {matrix.detectedCount} detected from column {matrix.firstColumn}
              </div>
              <div className="mt-0.5 text-phx-ink-soft">{matrix.note}</div>
              {matrix.sampleHeaders.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {matrix.sampleHeaders.map((h, hi) => (
                    <span className="rounded bg-phx-paper-2 px-1.5 py-0.5 font-medium text-phx-ink-2" key={hi}>{h}</span>
                  ))}
                  {matrix.detectedCount > matrix.sampleHeaders.length && (
                    <span className="px-1 py-0.5 text-phx-ink-faint">+{matrix.detectedCount - matrix.sampleHeaders.length} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {result.warnings.length > 0 && (
        <ul className="list-disc space-y-1 border-t border-phx-line bg-amber-50 px-8 py-3 text-xs font-semibold text-amber-800">
          {result.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-phx-line px-4 py-3">
        {verified ? (
          <span className="inline-flex items-center gap-1 text-sm font-black text-emerald-700">
            <ShieldCheck className="h-4 w-4" /> Verified — proceed to Validate below.
          </span>
        ) : (
          <>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C]"
              onClick={onConfirm}
              type="button"
            >
              <ShieldCheck className="h-4 w-4" /> Confirm — this looks correct
            </button>
            <span className="text-xs font-medium text-phx-ink-faint">
              {drift ? "Drift was flagged — only confirm if you know the layout is right." : "Confirm to unlock the Validate step."}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Month completeness tracker (advisory — never blocks uploads) ───────────────────────────────────

const TRACKER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const trackerMonthLabel = (cycle: string) => {
  const [year, month] = cycle.split("-");
  const name = TRACKER_MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : cycle.slice(0, 7);
};
const weekBucketFromDate = (weekStart: string | null): number | null => {
  if (!weekStart) return null;
  const day = Number(weekStart.slice(8, 10));
  if (!Number.isFinite(day) || day < 1) return null;
  return day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
};
const WEEK_DUE_DAY: Record<number, number> = { 1: 1, 2: 8, 3: 15, 4: 22 };
const cadenceWeeks = (code: string): number[] => {
  const def = WEEKLY_DISTRIBUTORS.find((d) => d.code.toUpperCase() === code.toUpperCase());
  return def?.cadence === "twice-monthly" ? [2, 4] : [1, 2, 3, 4];
};

// Confirms every distributor's weekly sheets are in for the month — purely a reminder, NEVER a gate.
// Cadence-aware (weekly = 4 slots, twice-monthly = 2) and time-aware (a slot only reads "overdue" once
// its date has passed). Falls back to the sheet date when a batch isn't week-tagged yet.
function MonthCompletenessTracker({ batches }: { batches: WeeklyBatch[] }) {
  // Lazy init (not an effect) — same calendar day on server render + client hydrate, so no mismatch.
  const [today] = useState(() => {
    const now = new Date();
    return { cycle: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, day: now.getDate() };
  });

  const tagged = useMemo(
    () =>
      batches.map((b) => ({
        cycle: b.cycleMonth ?? (b.weekStart ? `${b.weekStart.slice(0, 7)}-01` : null),
        week: b.weekNumber ?? weekBucketFromDate(b.weekStart),
        distributorCode: b.distributorCode,
        weekStart: b.weekStart,
      })),
    [batches],
  );
  const monthsPresent = useMemo(
    () => [...new Set(tagged.map((t) => t.cycle).filter((c): c is string => Boolean(c)))].sort().reverse(),
    [tagged],
  );
  const focusMonth = monthsPresent.includes(today.cycle) ? today.cycle : monthsPresent[0] ?? today.cycle;

  const uploadedBy = new Map<string, Map<number, string | null>>();
  for (const t of tagged) {
    if (t.cycle !== focusMonth || t.week == null) continue;
    const existing = uploadedBy.get(t.distributorCode) ?? new Map<number, string | null>();
    if (!existing.has(t.week)) existing.set(t.week, t.weekStart);
    uploadedBy.set(t.distributorCode, existing);
  }

  const rows = WEEKLY_DISTRIBUTORS.map((dist) => {
    const weeks = cadenceWeeks(dist.code);
    const up = uploadedBy.get(dist.code) ?? new Map<number, string | null>();
    const cells = [1, 2, 3, 4].map((week) => {
      const isUploaded = up.has(week);
      const isExpected = weeks.includes(week);
      const due = today.day >= (WEEK_DUE_DAY[week] ?? 99);
      const state: "done" | "overdue" | "upcoming" | "na" = isUploaded
        ? "done"
        : isExpected
          ? due ? "overdue" : "upcoming"
          : "na";
      return { week, state, date: up.get(week) ?? null, counted: isUploaded && isExpected };
    });
    return { code: dist.code, name: dist.name, expectedCount: weeks.length, cells };
  });
  const expected = rows.reduce((acc, row) => acc + row.expectedCount, 0);
  const done = rows.reduce((acc, row) => acc + row.cells.filter((cell) => cell.counted).length, 0);
  const pctDone = expected > 0 ? Math.round((Math.min(done, expected) / expected) * 100) : 0;
  const allIn = done >= expected;

  const cellClass: Record<string, string> = {
    done: "bg-emerald-50 text-emerald-700 border-emerald-200",
    overdue: "bg-amber-50 text-amber-700 border-amber-200",
    upcoming: "bg-white text-phx-line-strong border-phx-line",
    na: "bg-phx-paper text-phx-line-strong border-phx-paper-2",
  };

  return (
    <div className={`${card} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">This month — {trackerMonthLabel(focusMonth)}</span>
            {allIn && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-phx-xs font-black text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> All sheets in
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs font-medium text-phx-ink-soft">
            A reminder so no weekly sheet is forgotten — it never blocks you; upload late any time.
          </p>
        </div>
        <span className="text-sm font-black tabular-nums text-phx-ink">{done} / {expected} sheets</span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-phx-paper-2">
        <div className={`h-full rounded-full ${allIn ? "bg-emerald-500" : "bg-phx-accent"}`} style={{ width: `${pctDone}%` }} />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-phx-2xs font-black uppercase tracking-wide text-phx-ink-faint">
              <th className="px-2 py-1">Distributor</th>
              <th className="px-2 py-1 text-center">W1</th>
              <th className="px-2 py-1 text-center">W2</th>
              <th className="px-2 py-1 text-center">W3</th>
              <th className="px-2 py-1 text-center">W4</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className="border-t border-phx-paper-2">
                <td className="px-2 py-1.5 font-bold text-phx-ink">{row.name} <span className="font-medium text-phx-ink-faint">({row.code})</span></td>
                {row.cells.map((cell) => (
                  <td className="px-2 py-1.5 text-center" key={cell.week}>
                    <span
                      className={`inline-flex h-6 min-w-[2.2rem] items-center justify-center rounded-[4px] border text-phx-xs font-black ${cellClass[cell.state]}`}
                      title={cell.date ? `Uploaded — ${cell.date}` : cell.state === "overdue" ? "Expected but not uploaded yet" : cell.state === "na" ? "Not expected for this distributor" : "Upcoming"}
                    >
                      {cell.state === "done" ? "✓" : cell.state === "overdue" ? "!" : cell.state === "na" ? "·" : "–"}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">
        <span><span className="text-emerald-600">✓</span> uploaded</span>
        <span><span className="text-amber-600">!</span> overdue</span>
        <span><span className="text-phx-line-strong">–</span> upcoming</span>
        <span><span className="text-phx-line-strong">·</span> not expected</span>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────────────────────────────

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-phx-2xs font-black uppercase tracking-wide text-phx-ink-faint">{label}</div>
      <div className={`mt-0.5 text-sm font-black tabular-nums ${accent ? "text-phx-accent" : "text-phx-ink"}`}>{value}</div>
    </div>
  );
}

function SummaryTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-phx-line">
      <div className="bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white">{title}</div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              {head.map((cell, i) => (
                <th className={`px-3 py-1.5 ${i === 0 ? "" : "text-right"}`} key={cell}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td className="px-3 py-3 text-center text-phx-ink-faint" colSpan={head.length}>—</td></tr>
            )}
            {rows.map((row, ri) => (
              <tr className="border-t border-[#FFE8D6]" key={ri}>
                {row.map((cell, ci) => (
                  <td className={`px-3 py-1.5 ${ci === 0 ? "font-semibold text-phx-ink" : "text-right tabular-nums text-phx-ink-2"}`} key={ci}>
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
