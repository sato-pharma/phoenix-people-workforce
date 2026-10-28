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
import { weeklyProductKeysAreOne, weeklyUploadThisWeekUnits, weeklyUploadUnitScope } from "@/lib/sales/weekly/unit-totals";
import { weeklyVerifyAiBadge } from "@/lib/sales/weekly/verify-ai-state";
import type { SourceOfSalesProduct } from "@/lib/sales/monthly-distributor-import";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CSV_BOM, csvLine } from "@/lib/export/spreadsheet-safe";

import { WeeklyBranchMappingManager } from "./weekly-branch-mapping-manager";
import { WeeklyProductMappingManager } from "./weekly-product-mapping-manager";
import {
  excludedBranchColumns,
  excludedItemColumns,
  fileSelfCheckColumns,
  rowIssueColumns,
  uploadHistoryColumns,
  uploadSummaryColumns,
  uploadTrackerColumns,
  verifyColumns,
} from "./weekly-table-widths";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// THE FITS-THE-SCREEN AND SQUARE-EDGE GOLDEN RULES (AGENTS.md §4), for the whole page: every table is
// `w-full table-fixed` with its column widths from weekly-table-widths.ts, it fits by merging columns and
// wrapping text, it becomes cards below md, and nothing is rounded. Pinned by
// tests/weekly-sales-fits-the-screen.test.ts.

// No money formatter here on purpose: this whole screen — Validate preview AND the stored-upload
// history — reports UNITS. Value belongs to the surfaces that own the price (dashboard, export).
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

const card = "border border-phx-line bg-white shadow-sm";
/** Hover text on a unit figure held back because it would add different products. */
const UNITS_NOT_ADDED_TITLE = "Units of different products are never added";
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
  /** false suppresses the per-line "weekly sales uploaded" email; the server defaults to sending. */
  notify?: boolean;
  file?: File | null;
  salesFile?: File | null;
  stockFile?: File | null;
};

// Posts a weekly request to `endpoint`. Small payloads go multipart; large ones stream to Storage first
// (both PS files together count toward the cap, so if either pushes the combined body over the limit
// both are streamed) and the endpoint is called by JSON reference.
async function postWeekly(endpoint: string, input: WeeklyPostInput): Promise<Response> {
  const { distributorCode, isPS, periodDate, weekNumber, notify, file, salesFile, stockFile } = input;
  const combinedSize = isPS
    ? (salesFile?.size ?? 0) + (stockFile?.size ?? 0)
    : file?.size ?? 0;

  if (combinedSize <= LARGE_FILE_THRESHOLD) {
    const form = new FormData();
    form.set("distributorCode", distributorCode);
    if (periodDate) form.set("periodDate", periodDate);
    if (weekNumber) form.set("weekNumber", String(weekNumber));
    // Only ever sent to turn the email OFF — an absent field means notify, on both transports.
    if (notify === false) form.set("notify", "false");
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
  if (notify === false) body.notify = "false";
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
  // Email the line managers about this upload. On by default (the owner's asked-for behaviour); the
  // operator turns it off for a correction or a re-upload nobody needs to hear about.
  const [notifyLines, setNotifyLines] = useState(true);

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
  // Both Ibn Sina supplier feeds (IS-S Sato, IS-L Lacto) carry the sheet's own Date in column 1, so
  // the parser auto-detects the period and the picker must not be demanded of the operator.
  const needsPeriodDate = distributorCode !== "IS-S" && distributorCode !== "IS-L";
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
      const response = await postWeekly("/api/sales/weekly/upload", { distributorCode, file, isPS, notify: notifyLines, periodDate, weekNumber, salesFile, stockFile });
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
    "h-10 w-full border border-phx-line bg-white px-3 py-1.5 text-sm text-phx-ink file:mr-3 file:border-0 file:bg-phx-paper-2 file:px-3 file:py-1.5 file:text-sm file:font-bold";

  // Recent weekly uploads: a fixed table from md up, with the week under the period and the status under the
  // distributor, and a card per upload below md. Both draw a batch's period, week, status and actions from here.
  const columns = uploadHistoryColumns();

  const renderBatchPeriod = (batch: WeeklyBatch) =>
    retagId === batch.id ? (
      <input
        aria-label="Cycle month"
        className={`${phxFieldClassName} min-w-0`}
        onChange={(e) => setRetagMonth(e.target.value)}
        type="month"
        value={retagMonth}
      />
    ) : (
      batch.weekStart ?? "—"
    );

  const renderBatchWeek = (batch: WeeklyBatch) =>
    retagId === batch.id ? (
      <select
        aria-label="Week of month"
        className={`${phxSelectClassName} min-w-0`}
        onChange={(e) => setRetagWeek(Number(e.target.value))}
        value={retagWeek}
      >
        {[1, 2, 3, 4].map((w) => (
          <option key={w} value={w}>Week {w}</option>
        ))}
      </select>
    ) : (
      <span className="inline-flex items-center bg-phx-accent-soft px-2 py-0.5 text-phx-xs font-black text-[#9A3412]">
        {batch.weekNumber ? `W${batch.weekNumber}` : "—"}
      </span>
    );

  const renderBatchStatus = (batch: WeeklyBatch) => (
    <span className={`inline-flex items-center px-2 py-0.5 text-phx-xs font-black ${batch.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
      {batch.status}
    </span>
  );

  const renderBatchActions = (batch: WeeklyBatch) => (
    <div className="inline-flex flex-wrap items-center justify-end gap-2">
      {retagId === batch.id ? (
        <>
          <button
            className="inline-flex h-8 items-center gap-1 bg-phx-accent px-2.5 text-xs font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
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
  );

  const noUploadsMessage = batches.length === 0 ? "No weekly uploads yet." : "No uploads match the current filters.";

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 bg-phx-accent" aria-hidden />
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
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{pageError}</span>
        </div>
      )}

      {/* Month completeness tracker — advisory reminder, never blocks uploads */}
      <MonthCompletenessTracker batches={batches} />

      {/* Upload card */}
      <div className={`${card} p-4 sm:p-5`}>

        {/* ── Step 1: Week of month ── */}
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center bg-[#020617] text-phx-2xs font-black text-white">1</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Week of month</span>
            {weekNumber && (
              <span className="inline-flex items-center bg-phx-accent-soft px-2 py-0.5 text-phx-xs font-black text-[#9A3412]">Week {weekNumber}</span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            Distributor sheets are cumulative within a month (week 2 already includes week 1, and so on). Pick the week this
            file covers — the system also reads the date inside the file and flags any mismatch when you validate.
          </p>
          <div className="mt-2 inline-flex flex-wrap gap-2">
            {[1, 2, 3, 4].map((w) => (
              <button
                className={`h-10 w-[88px] border px-4 text-sm font-black transition disabled:opacity-60 ${
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
          <span className="inline-flex h-5 w-5 items-center justify-center bg-[#020617] text-phx-2xs font-black text-white">2</span>
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Distributor &amp; file</span>
        </div>

        {/* File selectors */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Distributor</span>
            <SearchableSelect
              className="w-full px-3"
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
                  {d.name}
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
                className={phxFieldClassName}
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
            <span className="inline-flex h-5 w-5 items-center justify-center bg-[#020617] text-phx-2xs font-black text-white">3</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Verify columns</span>
            {verified && (
              <span className="inline-flex items-center gap-1 bg-emerald-50 px-2 py-0.5 text-phx-xs font-black text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" /> Verified
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            AI reads the column headers and shows which data it will take from which column. Only column titles are sent — never sales numbers.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 border border-[#020617] bg-white px-4 text-sm font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-60"
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
            <div className="mt-3 flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{verifyError}</span>
            </div>
          )}

          {verifyResult && <VerifyPanel result={verifyResult} verified={verified} onConfirm={() => setVerified(true)} />}
        </div>

        {/* ── Step 2: Validate (dry run) ── */}
        <div className="mt-5 border-t border-dashed border-phx-line pt-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center bg-[#020617] text-phx-2xs font-black text-white">4</span>
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Validate</span>
            {validateResult && !validateError && (
              <span className={`inline-flex items-center px-2 py-0.5 text-phx-xs font-black ${validateResult.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {validateResult.status === "validated" ? "Ready to upload" : "Blocked"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            Parses the file, maps products and branches, checks for issues. Shows totals per product and per branch. Nothing is stored yet.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-10 items-center gap-2 bg-phx-ink px-4 text-sm font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-phx-line-strong disabled:hover:bg-phx-line-strong"
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
            <div className="mt-3 flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
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
          notifyLines={notifyLines}
          onToggleNotifyLines={setNotifyLines}
        />
      )}

      {/* Recent uploads */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink-soft">Recent weekly uploads</h2>
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              aria-label="Filter by distributor"
              className="h-8 px-2 text-xs"
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
              className="h-8 px-2 text-xs"
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
                className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1.5 text-xs font-semibold text-phx-ink-soft transition hover:bg-phx-paper"
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
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 bg-[#020617] px-3 py-1.5 text-phx-xs font-black uppercase tracking-wide text-white transition hover:bg-[#1E293B] disabled:opacity-60"
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

        <div className={card}>
          <div className="hidden md:block">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: `${columns.select}%` }} />
                <col style={{ width: `${columns.period}%` }} />
                <col style={{ width: `${columns.distributor}%` }} />
                <col style={{ width: `${columns.rows}%` }} />
                <col style={{ width: `${columns.net}%` }} />
                <col style={{ width: `${columns.stock}%` }} />
                <col style={{ width: `${columns.actions}%` }} />
              </colgroup>
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
                  <th className="break-words px-3 py-2">Period · Week</th>
                  <th className="break-words px-3 py-2">Distributor · Status</th>
                  <th className="break-words px-3 py-2 text-right">Rows</th>
                  <th className="break-words px-3 py-2 text-right">Net units</th>
                  <th className="break-words px-3 py-2 text-right">Stock units</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
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
                    <td className="px-3 py-2">
                      <div className="break-words font-bold text-phx-ink">{renderBatchPeriod(batch)}</div>
                      <div className="mt-1">{renderBatchWeek(batch)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="break-words">{batch.distributorName}</div>
                      <div className="mt-1">{renderBatchStatus(batch)}</div>
                    </td>
                    <td className="break-words px-3 py-2 text-right tabular-nums">{num(batch.totalRows)}</td>
                    {/* A batch's Net and Stock units add every product in its sheet, and this list does not
                        know how many products a batch holds, so it never prints them (units of different
                        products are never added, unit-totals.ts). The upload's own panel shows them for one. */}
                    <td className="break-words px-3 py-2 text-right tabular-nums text-phx-ink-faint" title={UNITS_NOT_ADDED_TITLE}>—</td>
                    <td className="break-words px-3 py-2 text-right tabular-nums text-phx-ink-faint" title={UNITS_NOT_ADDED_TITLE}>—</td>
                    <td className="px-3 py-2 text-right">{renderBatchActions(batch)}</td>
                  </tr>
                ))}
                {filteredBatches.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-phx-ink-faint" colSpan={7}>
                      {noUploadsMessage}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 p-3 md:hidden">
            {filteredBatches.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-phx-ink-faint">{noUploadsMessage}</p>
            ) : (
              <label className="flex items-center gap-2 px-1 text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">
                <input
                  aria-label="Select all"
                  checked={allFilteredSelected}
                  className="accent-phx-accent"
                  onChange={toggleAll}
                  type="checkbox"
                />
                Select all
              </label>
            )}
            {filteredBatches.map((batch) => (
              <PhoneCard key={`card-${batch.id}`}>
                <div className="flex items-start gap-2">
                  <input
                    aria-label={`Select ${batch.distributorName} ${batch.weekStart ?? ""}`}
                    checked={selectedIds.has(batch.id)}
                    className="mt-1 shrink-0 accent-phx-accent"
                    onChange={() => toggleOne(batch.id)}
                    type="checkbox"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-black text-phx-ink">{batch.distributorName}</p>
                    <div className="mt-1">{renderBatchStatus(batch)}</div>
                  </div>
                  {renderBatchActions(batch)}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <CardStat label="Period" value={renderBatchPeriod(batch)} />
                  <CardStat label="Week" value={renderBatchWeek(batch)} />
                  <CardStat label="Rows" value={num(batch.totalRows)} />
                  <CardStat label="Net units" value={<span className="text-phx-ink-faint" title={UNITS_NOT_ADDED_TITLE}>—</span>} />
                  <CardStat label="Stock units" value={<span className="text-phx-ink-faint" title={UNITS_NOT_ADDED_TITLE}>—</span>} />
                </div>
              </PhoneCard>
            ))}
          </div>
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
  const lines = [csvLine(["field", "value", "reason"])];
  for (const issue of result.issues) {
    if (issue.severity !== "failure") continue;
    const value = issue.value ?? "";
    const key = `${issue.field}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The value is a cell read from a distributor's upload file: csvLine neutralises a formula lead
    // (=, +, -, @) and quotes it, so the sheet the team opens in Excel never runs it.
    lines.push(csvLine([issue.field, value, issue.message]));
  }
  const blob = new Blob([CSV_BOM + lines.join("\n")], { type: "text/csv;charset=utf-8" });
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
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-phx-line bg-white px-5 py-3">
          <h2 className="text-sm font-black text-phx-ink">{title}</h2>
          <button
            className="inline-flex h-8 w-8 items-center justify-center border border-phx-line text-phx-ink-soft transition hover:border-phx-accent-line"
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
        className="ml-auto inline-flex h-7 items-center gap-1 border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
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
                  className="break-words border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-xs font-bold text-phx-ink-2"
                  key={region.regionCode}
                >
                  {region.regionName}
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-rose-200 bg-white px-3 py-2">
      <span className="bg-rose-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-rose-700">
        {FIELD_LABELS[group.field] ?? group.field}
      </span>
      <span className="min-w-0 break-words text-sm font-semibold text-phx-ink-2">{group.message}</span>
      <span className="text-xs font-medium text-phx-ink-faint">
        {group.rowNumbers.length} row{group.rowNumbers.length === 1 ? "" : "s"}
        {" "}(e.g. row {group.rowNumbers[0]})
      </span>
      {group.action && (
        <button
          className="ml-auto inline-flex h-7 items-center gap-1 bg-[#0B0B0B] px-3 text-xs font-black text-white transition hover:bg-phx-accent"
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
  // Each row is one item's own units. Their sum adds different items, so it is printed only for one.
  const netQty = weeklyProductKeysAreOne(items.map((item) => `${item.itemCode}|${item.itemName}`))
    ? items.reduce((sum, item) => sum + item.netQty, 0)
    : null;
  const columns = excludedItemColumns();

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="break-words text-xs font-black uppercase tracking-wide text-phx-ink-2">
        Excluded on purpose ({items.length}) — {num(rows)} rows{netQty === null ? "" : `, ${num(netQty)} net units`} kept out of the numbers
      </h3>
      <div className="mt-2 hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.code}%` }} />
            <col style={{ width: `${columns.name}%` }} />
            <col style={{ width: `${columns.rows}%` }} />
            <col style={{ width: `${columns.net}%` }} />
            <col style={{ width: `${columns.stock}%` }} />
          </colgroup>
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="break-words py-1 pr-4">Item code</th>
              <th className="break-words py-1 pr-4">Item name</th>
              <th className="break-words py-1 pr-4 text-right">Rows</th>
              <th className="break-words py-1 pr-4 text-right">Net units</th>
              <th className="break-words py-1 text-right">Stock units</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr className="border-t border-phx-line" key={`${item.itemCode}|${item.itemName}`}>
                <td className="break-words py-1 pr-4 font-semibold text-phx-ink">{item.itemCode || "—"}</td>
                <td className="break-words py-1 pr-4 text-phx-ink-2">{item.itemName || "—"}</td>
                <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(item.rows)}</td>
                <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(item.netQty)}</td>
                <td className="break-words py-1 text-right tabular-nums text-phx-ink-2">{num(item.stockQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-2 md:hidden">
        {items.map((item) => (
          <PhoneCard key={`card-${item.itemCode}|${item.itemName}`}>
            <p className="break-words text-sm font-black text-phx-ink">{item.itemName || "—"}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <CardStat label="Item code" value={item.itemCode || "—"} />
              </div>
              <CardStat label="Rows" value={num(item.rows)} />
              <CardStat label="Net units" value={num(item.netQty)} />
              <CardStat label="Stock units" value={num(item.stockQty)} />
            </div>
          </PhoneCard>
        ))}
      </div>
      <p className="mt-2 text-xs font-medium text-phx-ink-faint">
        These items are mapped to IGNORE in Weekly Mapping — not Phoenix products. Re-point the mapping to a real product if any of them belongs to a line.
      </p>
    </div>
  );
}

function ExcludedBranchesPanel({ branches }: { branches: WeeklyExcludedBranch[] }) {
  const rows = branches.reduce((sum, branch) => sum + branch.rows, 0);
  // A depot's units add every item it held out, so they print only while those are one item's: per row
  // for that row, and across every depot for the sum in the heading.
  const sumIsOneItem = weeklyProductKeysAreOne(branches.flatMap((branch) => branch.itemKeys));
  const netQty = branches.reduce((sum, branch) => sum + branch.netQty, 0);
  const stockQty = branches.reduce((sum, branch) => sum + branch.stockQty, 0);
  const heldOutUnits = sumIsOneItem ? `, ${num(netQty)} net and ${num(stockQty)} stock units` : "";
  const branchUnits = (branch: WeeklyExcludedBranch, value: number) =>
    weeklyProductKeysAreOne(branch.itemKeys) ? num(value) : "—";
  const columns = excludedBranchColumns();
  const branchLabel = (branch: WeeklyExcludedBranch) =>
    branch.rawBranch || (branch.branchColumnIndex != null ? `Column ${branch.branchColumnIndex}` : "—");

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="break-words text-xs font-black uppercase tracking-wide text-phx-ink-2">
        Branches excluded on purpose ({branches.length}) — {num(rows)} rows{heldOutUnits} kept out of the numbers
      </h3>
      <div className="mt-2 hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.branch}%` }} />
            <col style={{ width: `${columns.name}%` }} />
            <col style={{ width: `${columns.rows}%` }} />
            <col style={{ width: `${columns.net}%` }} />
            <col style={{ width: `${columns.stock}%` }} />
          </colgroup>
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="break-words py-1 pr-4">Branch</th>
              <th className="break-words py-1 pr-4">Branch name</th>
              <th className="break-words py-1 pr-4 text-right">Rows</th>
              <th className="break-words py-1 pr-4 text-right">Net units</th>
              <th className="break-words py-1 text-right">Stock units</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
              <tr className="border-t border-phx-line" key={`${branch.rawBranch}|${branch.branchColumnIndex ?? ""}`}>
                <td className="break-words py-1 pr-4 font-semibold text-phx-ink">{branchLabel(branch)}</td>
                <td className="break-words py-1 pr-4 text-phx-ink-2">{branch.branchName || "—"}</td>
                <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(branch.rows)}</td>
                <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{branchUnits(branch, branch.netQty)}</td>
                <td className="break-words py-1 text-right tabular-nums text-phx-ink-2">{branchUnits(branch, branch.stockQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-2 md:hidden">
        {branches.map((branch) => (
          <PhoneCard key={`card-${branch.rawBranch}|${branch.branchColumnIndex ?? ""}`}>
            <p className="break-words text-sm font-black text-phx-ink">{branch.branchName || "—"}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <CardStat label="Branch" value={branchLabel(branch)} />
              </div>
              <CardStat label="Rows" value={num(branch.rows)} />
              <CardStat label="Net units" value={branchUnits(branch, branch.netQty)} />
              <CardStat label="Stock units" value={branchUnits(branch, branch.stockQty)} />
            </div>
          </PhoneCard>
        ))}
      </div>
      <p className="mt-2 text-xs font-medium text-phx-ink-faint">
        These branches are ticked &quot;excluded&quot; in the Weekly Mapping branch list, so none of their volume reaches the dashboard. Untick a branch there if its sales should count.
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
  const columns = fileSelfCheckColumns();
  const verdictOf = (check: WeeklyFileTotalsReport["checks"][number]) =>
    check.status === "ok"
      ? { cls: "text-emerald-700", text: "Agrees" }
      : check.severity === "block"
        ? { cls: "text-red-700", text: "Disagrees — import stopped" }
        : { cls: "text-amber-700", text: "Disagrees — please check" };

  return (
    <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
      <h3 className="break-words text-xs font-black uppercase tracking-wide text-phx-ink-2">{headline}</h3>

      {fileTotals.absence !== null ? (
        <p className="mt-2 break-words text-sm font-medium text-phx-ink-2">{fileTotals.absence.reason}</p>
      ) : (
        <>
          <div className="mt-2 hidden md:block">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: `${columns.label}%` }} />
                <col style={{ width: `${columns.where}%` }} />
                <col style={{ width: `${columns.declared}%` }} />
                <col style={{ width: `${columns.parsed}%` }} />
                <col style={{ width: `${columns.verdict}%` }} />
              </colgroup>
              <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
                <tr>
                  <th className="break-words py-1 pr-4">What the file states</th>
                  <th className="break-words py-1 pr-4">Where</th>
                  <th className="break-words py-1 pr-4 text-right">File says</th>
                  <th className="break-words py-1 pr-4 text-right">Import read</th>
                  <th className="break-words py-1">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {fileTotals.checks.map((check) => (
                  <tr className="border-t border-phx-line" key={`${check.label}|${check.where}`}>
                    <td className="break-words py-1 pr-4 font-semibold text-phx-ink">{check.label}</td>
                    <td className="break-words py-1 pr-4 text-phx-ink-2">{check.where}</td>
                    <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(check.declared)}</td>
                    <td className="break-words py-1 pr-4 text-right tabular-nums text-phx-ink-2">{num(check.parsed)}</td>
                    <td className={`break-words py-1 font-bold ${verdictOf(check).cls}`}>{verdictOf(check).text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 space-y-2 md:hidden">
            {fileTotals.checks.map((check) => (
              <PhoneCard key={`card-${check.label}|${check.where}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-black text-phx-ink">{check.label}</p>
                  <p className={`min-w-0 break-words text-xs font-bold ${verdictOf(check).cls}`}>{verdictOf(check).text}</p>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <CardStat label="Where" value={check.where} />
                  <CardStat label="File says" value={num(check.declared)} />
                  <CardStat label="Import read" value={num(check.parsed)} />
                </div>
              </PhoneCard>
            ))}
          </div>
        </>
      )}

      {fileTotals.absence === null && mismatches === 0 && (
        <p className="mt-2 text-xs font-medium text-phx-ink-faint">
          The numbers below were read the way the file itself says they should add up.
        </p>
      )}
    </div>
  );
}

/** "CNS" · "CNS and Pedia" · "Anti Infective, CNS and Pedia" — a readable list at every length. */
function joinLineNames(lines: string[]): string {
  if (lines.length <= 1) return lines[0] ?? "";
  return `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
}

/**
 * Names the audience BEFORE the upload is confirmed, and lets the operator mute it.
 *
 * Confirming an upload emails every District Manager and the National Sales Manager of each line
 * whose products the sheet carries. The mute exists for the correction case: deleting a batch and
 * re-uploading it is the documented fix for a wrong week, and without this it would re-mail the
 * whole field force every time a file is corrected.
 *
 * `lines` is the server's own answer (result.notifiableLines), not a guess made here — the
 * tracked-line rule is not reachable from the client.
 */
function NotifyLinesChoice({
  disabled,
  lines,
  onChange,
  value,
}: {
  disabled: boolean;
  lines: string[];
  onChange: (next: boolean) => void;
  value: boolean;
}) {
  if (lines.length === 0) {
    return (
      <p className="w-full text-xs font-semibold text-phx-ink-soft">
        No tracked line in this sheet — no manager email will be sent.
      </p>
    );
  }
  return (
    <label className="flex w-full cursor-pointer flex-wrap items-start gap-2 border border-phx-line bg-phx-surface-soft px-3 py-2">
      <input
        checked={value}
        className="mt-0.5 h-4 w-4 shrink-0 accent-phx-accent"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="text-xs font-semibold text-phx-ink">
        Email the line managers about this upload
        <span className="block font-medium text-phx-ink-soft">
          {value
            ? `District Managers and the National Sales Manager of ${joinLineNames(lines)} will be told which of their products this sheet carries. No figures are included.`
            : `Nobody will be emailed about this upload. Leave it ticked to tell ${joinLineNames(lines)}.`}
        </span>
      </span>
    </label>
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
  notifyLines,
  onToggleNotifyLines,
}: {
  result: WeeklySalesValidationResult;
  selectedWeek: number | null;
  onPickWeek: (week: number) => void;
  onUpload: () => void;
  uploadBusy: boolean;
  uploadError: string | null;
  uploadDone: boolean;
  notifyLines: boolean;
  onToggleNotifyLines: (next: boolean) => void;
}) {
  const validated = result.status === "validated";
  const isPS = result.distributor.code === "PS";
  const hasFailures = result.failedRows > 0;
  const tw = result.thisWeekOnly;
  // Units of different products are never added (owner, 2026-08-27), so a sheet of several products is
  // shown one product at a time — see the pick below. This only words the note under This week only.
  const unitsAreOneProduct = weeklyProductKeysAreOne(result.byProduct.map((p) => p.productCode || p.productName));
  // The tiles, By branch and By region are one product's: the whole sheet's when it holds one, else the
  // product picked below (owner, 2026-09-19). Every figure they print comes from this scope.
  const [pickedProduct, setPickedProduct] = useState<string | null>(null);
  const unitScope = weeklyUploadUnitScope(result, pickedProduct);
  const scopeUnits = (value: number | undefined) => (unitScope && value !== undefined ? num(value) : "—");
  const ofProduct = unitScope?.productName ? ` · ${unitScope.productName}` : "";
  // "This week only" is that same product's de-cumulated units, so the one pick drives it too (owner, 2026-09-19).
  const thisWeekUnits = tw ? weeklyUploadThisWeekUnits(tw, unitScope) : null;
  const columns = rowIssueColumns();
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
            className="inline-flex h-8 items-center gap-1 border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
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
            className="ml-1 inline-flex h-7 items-center border border-amber-300 bg-white px-2 text-xs font-black text-amber-800 transition hover:bg-amber-100"
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
            <span>Net units{ofProduct}: <span className="text-phx-accent">{thisWeekUnits == null ? "—" : num(thisWeekUnits)}</span></span>
            <span className="text-xs font-medium text-phx-ink-soft">
              {tw.priorWeekStart
                ? thisWeekUnits == null
                  ? `the previous sheet of the month (${tw.priorWeekStart}) could not be read by product, so no figure is shown`
                  : `= this sheet (cumulative ${scopeUnits(unitScope?.totals.netQty)} units) − previous sheet of the month (${tw.priorWeekStart})`
                : "first sheet of the month — equals the full cumulative figure"}
            </span>
          </div>
          <div className="mt-1 text-xs font-medium text-phx-ink-faint">
            {unitsAreOneProduct
              ? `Stock ${scopeUnits(unitScope?.totals.stockQty)} units is a snapshot — shown as-is, never subtracted.`
              : `This sheet holds ${result.byProduct.length} products, and units of different products are never added — this is the product picked under Units for. Stock ${scopeUnits(unitScope?.totals.stockQty)} units is its snapshot, never subtracted.`}
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

      {/* One product at a time — shown only when the sheet holds several, since units of different
          products are never added. The Upload screen's counterpart of the dashboard's Product filter. */}
      {unitScope?.productKey != null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-phx-line bg-phx-paper px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Units for</span>
            {/* A fixed width that yields to the screen, and a value that wraps rather than clips. */}
            <div className="w-72 max-w-full">
              <SearchableSelect
                aria-label="Product whose units are shown"
                className="h-8 px-2"
                onChange={(event) => setPickedProduct(event.target.value)}
                value={unitScope.productKey}
                wrapValue
              >
                {result.byProduct.map((p) => (
                  <option key={p.productCode} value={p.productCode}>{p.productName || p.productCode}</option>
                ))}
              </SearchableSelect>
            </div>
          </div>
          <p className="min-w-0 flex-1 basis-64 break-words text-xs font-medium text-phx-ink-soft">
            This sheet holds {num(result.byProduct.length)} products, and units of different products are never
            added — so This week only, the tiles, By branch and By region show one product at a time. By product lists them all.
          </p>
        </div>
      )}

      {/* KPI strip */}
      {/* Validation is a UNITS check — the operator is confirming quantities parsed correctly, not
          money. Value is derived downstream from Product Master factory price, so showing EGP here
          invites reconciling against a figure this step does not own. Units only (owner's rule). */}
      <div className="grid grid-cols-2 gap-px bg-phx-line sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Rows" value={num(result.rowCount)} />
        <Metric label="Importable" value={num(result.importableRows)} />
        <Metric label={`Sales units${ofProduct}`} value={scopeUnits(unitScope?.totals.salesQty)} />
        <Metric label={`Return units${ofProduct}`} value={scopeUnits(unitScope?.totals.returnQty)} />
        <Metric label={`Net units${ofProduct}`} value={scopeUnits(unitScope?.totals.netQty)} accent />
        <Metric label={`Stock units${ofProduct}`} value={scopeUnits(unitScope?.totals.stockQty)} />
      </div>

      {/* Summary tables. Two abreast only from 2xl: at 1024px with the sidebar open, two side by side left each
          table about 300px, too narrow for a name and four unit counts. */}
      <div className="grid grid-cols-1 gap-4 p-4 2xl:grid-cols-2">
        <SummaryTable
          title="By product"
          nameLabel="Product"
          rows={result.byProduct.map((p) => ({
            name: p.productName || p.productCode,
            sales: num(p.salesQty), returns: num(p.returnQty), net: num(p.netQty), stock: num(p.stockQty),
          }))}
        />
        <SummaryTable
          title={`By branch${ofProduct}`}
          nameLabel="Branch"
          rows={(unitScope?.byBranch ?? result.byBranch).map((b) => ({
            name: b.branchName || b.branchCode,
            sales: scopeUnits(b.salesQty), returns: scopeUnits(b.returnQty), net: scopeUnits(b.netQty), stock: scopeUnits(b.stockQty),
          }))}
        />
        <SummaryTable
          title={`By region${ofProduct}`}
          nameLabel="Region"
          rows={(unitScope?.byRegion ?? result.byRegion).map((r) => ({
            name: r.regionName || r.regionCode,
            sales: scopeUnits(r.salesQty), returns: scopeUnits(r.returnQty), net: scopeUnits(r.netQty), stock: scopeUnits(r.stockQty),
          }))}
        />
      </div>

      {/* Row issues: a fixed table from md up, one line per issue below md. It scrolls down, never sideways. */}
      {result.issues.length > 0 && (
        <div className="border-t border-phx-line p-4">
          <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-phx-ink-soft">
            Row issues ({result.issues.length})
          </h3>
          <div className="max-h-56 overflow-y-auto border border-[#FFE8D6]">
            <table className="hidden w-full table-fixed text-xs md:table">
              <colgroup>
                <col style={{ width: `${columns.row}%` }} />
                <col style={{ width: `${columns.severity}%` }} />
                <col style={{ width: `${columns.message}%` }} />
              </colgroup>
              <tbody>
                {result.issues.slice(0, 100).map((issue, i) => (
                  <tr className="border-t border-[#FFE8D6]" key={`${issue.rowNumber}-${i}`}>
                    <td className="break-words px-2 py-1 font-bold text-phx-ink-soft">Row {issue.rowNumber}</td>
                    <td className="break-words px-2 py-1">
                      <span className={issue.severity === "failure" ? "text-rose-600" : "text-amber-600"}>{issue.severity}</span>
                    </td>
                    <td className="break-words px-2 py-1 text-phx-ink-2">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="md:hidden">
              {result.issues.slice(0, 100).map((issue, i) => (
                <li className="border-t border-[#FFE8D6] px-2 py-1.5 text-xs first:border-t-0" key={`card-${issue.rowNumber}-${i}`}>
                  <span className="font-bold text-phx-ink-soft">Row {issue.rowNumber}</span>{" "}
                  <span className={issue.severity === "failure" ? "text-rose-600" : "text-amber-600"}>{issue.severity}</span>
                  <p className="break-words text-phx-ink-2">{issue.message}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Step 3 — Confirm Upload */}
      <div className="border-t border-phx-line px-4 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex h-5 w-5 items-center justify-center bg-[#020617] text-phx-2xs font-black text-white">5</span>
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">Confirm &amp; Upload</span>
        </div>

        {uploadDone ? (
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
            <div>
              <p className="text-sm font-black text-emerald-700">Stored successfully — period {result.weekStart ?? "—"}</p>
              <p className="text-xs font-medium text-emerald-600 mt-0.5">{result.rowCount} rows saved. The Recent uploads table has been refreshed.</p>
            </div>
          </div>
        ) : validated ? (
          <div className="flex flex-wrap items-center gap-3">
            <NotifyLinesChoice
              disabled={uploadBusy}
              lines={result.notifiableLines ?? []}
              onChange={onToggleNotifyLines}
              value={notifyLines}
            />
            {uploadError && (
              <div className="w-full flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
            <button
              className="inline-flex h-10 items-center gap-2 bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-phx-line-strong disabled:hover:bg-phx-line-strong"
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
    missing: { label: "Missing", cls: "bg-rose-50 text-rose-700" },
  };
  const pill = map[status] ?? map.uncertain;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-phx-xs font-black ${pill.cls}`} title={note || undefined}>
      {pill.label}
    </span>
  );
}

function VerifyPanel({ result, verified, onConfirm }: { result: WeeklyVerifyResult; verified: boolean; onConfirm: () => void }) {
  const drift = result.verdict === "drift";
  const missingSheet = result.columns.some((col) => col.status === "missing");
  // THE FITS-THE-SCREEN AND SQUARE-EDGE GOLDEN RULES (AGENTS.md §4): a fixed table from md up, with File
  // and Col merged into one column, and cards below md. Pinned by tests/weekly-sales-fits-the-screen.test.ts.
  const columns = verifyColumns();
  return (
    <div className="mt-3 border border-phx-line bg-white shadow-sm">
      <div className={`flex flex-wrap items-center gap-2 border-b border-phx-line px-4 py-3 text-sm font-black ${drift ? "text-amber-700" : "text-emerald-700"}`}>
        {drift ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {missingSheet ? "A sheet the import reads is missing from this file — review carefully" : drift ? "Possible column drift — review carefully" : "Columns look consistent"}
        <span className={`ml-auto inline-flex items-center px-2 py-0.5 text-phx-xs font-bold ${result.aiUsed ? "bg-phx-accent-soft text-[#9A3412]" : "bg-slate-100 text-slate-600"}`}>
          {weeklyVerifyAiBadge(result.aiState)}
        </span>
      </div>

      {result.aiNote && (
        <p className="break-words border-b border-phx-line bg-phx-paper px-4 py-2 text-xs font-semibold text-phx-ink-2">{result.aiNote}</p>
      )}

      {result.files.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-phx-line px-4 py-2 text-xs text-phx-ink-soft">
          {result.files.map((f) => (
            <span className="min-w-0 break-words" key={`${f.role}-${f.fileName}`}>
              <span className="font-black uppercase tracking-wide text-phx-ink-faint">{f.role}</span> · {f.fileName} → &quot;{f.sheetName}&quot;
            </span>
          ))}
        </div>
      )}

      <div className="hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.data}%` }} />
            <col style={{ width: `${columns.file}%` }} />
            <col style={{ width: `${columns.found}%` }} />
            <col style={{ width: `${columns.expected}%` }} />
            <col style={{ width: `${columns.status}%` }} />
          </colgroup>
          <thead className={darkHead}>
            <tr>
              <th className="break-words px-3 py-2">Data</th>
              <th className="break-words px-3 py-2">File · Col</th>
              <th className="break-words px-3 py-2">Found in your file</th>
              <th className="break-words px-3 py-2">Expected</th>
              <th className="break-words px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.columns.map((col, i) => (
              <tr className="border-t border-[#FFE8D6]" key={`${col.sheetRole}-${col.field}-${i}`}>
                <td className="break-words px-3 py-1.5 font-bold text-phx-ink">
                  {col.label}{col.critical && <span className="ml-1 text-phx-accent">*</span>}
                </td>
                <td className="break-words px-3 py-1.5 text-phx-ink-soft">
                  <div>{col.sheetRole}</div>
                  <div className="tabular-nums text-phx-ink-2">Col {col.columnIndex}</div>
                </td>
                <td className="break-words px-3 py-1.5 text-phx-ink">
                  {col.observedHeader || <span className="text-rose-600">— empty —</span>}
                </td>
                <td className="break-words px-3 py-1.5 text-phx-ink-faint">{col.expectedHeaderHint}</td>
                <td className="px-3 py-1.5"><StatusPill note={col.note} status={col.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 p-3 md:hidden">
        {result.columns.map((col, i) => (
          <div className="flex overflow-hidden border border-phx-line bg-white" key={`card-${col.sheetRole}-${col.field}-${i}`}>
            <span className="w-[3px] shrink-0 bg-phx-accent" />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-black text-phx-ink">
                  {col.label}{col.critical && <span className="ml-1 text-phx-accent">*</span>}
                </p>
                <StatusPill note={col.note} status={col.status} />
              </div>
              <p className="mt-0.5 break-words text-xs text-phx-ink-soft">
                {col.sheetRole} · <span className="tabular-nums text-phx-ink-2">Col {col.columnIndex}</span>
              </p>
              <div className="mt-2 grid grid-cols-1 gap-1.5">
                <div className="min-w-0 border border-phx-paper-2 bg-phx-paper px-2 py-1.5">
                  <p className="break-words text-phx-3xs font-black uppercase tracking-wide text-phx-ink-faint">Found in your file</p>
                  <p className="break-words text-sm text-phx-ink">
                    {col.observedHeader || <span className="text-rose-600">— empty —</span>}
                  </p>
                </div>
                <div className="min-w-0 border border-phx-paper-2 bg-phx-paper px-2 py-1.5">
                  <p className="break-words text-phx-3xs font-black uppercase tracking-wide text-phx-ink-faint">Expected</p>
                  <p className="break-words text-sm text-phx-ink-faint">{col.expectedHeaderHint}</p>
                </div>
              </div>
            </div>
          </div>
        ))}
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
                    <span className="min-w-0 break-words bg-phx-paper-2 px-1.5 py-0.5 font-medium text-phx-ink-2" key={hi}>{h}</span>
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
              className="inline-flex h-10 items-center gap-2 bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C]"
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

  const weeks = [1, 2, 3, 4];
  const columns = uploadTrackerColumns(weeks.length);
  const rows = WEEKLY_DISTRIBUTORS.map((dist) => {
    const expectedWeeks = cadenceWeeks(dist.code);
    const up = uploadedBy.get(dist.code) ?? new Map<number, string | null>();
    const cells = weeks.map((week) => {
      const isUploaded = up.has(week);
      const isExpected = expectedWeeks.includes(week);
      const due = today.day >= (WEEK_DUE_DAY[week] ?? 99);
      const state: "done" | "overdue" | "upcoming" | "na" = isUploaded
        ? "done"
        : isExpected
          ? due ? "overdue" : "upcoming"
          : "na";
      return { week, state, date: up.get(week) ?? null, counted: isUploaded && isExpected };
    });
    return { code: dist.code, name: dist.name, expectedCount: expectedWeeks.length, cells };
  });
  const expected = rows.reduce((acc, row) => acc + row.expectedCount, 0);
  const done = rows.reduce((acc, row) => acc + row.cells.filter((cell) => cell.counted).length, 0);
  const pctDone = expected > 0 ? Math.round((Math.min(done, expected) / expected) * 100) : 0;
  const allIn = done >= expected;

  const cellTitle = (cell: (typeof rows)[number]["cells"][number]) =>
    cell.date ? `Uploaded — ${cell.date}` : cell.state === "overdue" ? "Expected but not uploaded yet" : cell.state === "na" ? "Not expected for this distributor" : "Upcoming";
  const cellMark = (cell: (typeof rows)[number]["cells"][number]) =>
    cell.state === "done" ? "✓" : cell.state === "overdue" ? "!" : cell.state === "na" ? "·" : "–";

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
              <span className="inline-flex items-center gap-1 bg-emerald-50 px-2 py-0.5 text-phx-xs font-black text-emerald-700">
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

      <div className="mt-3 h-2 w-full overflow-hidden bg-phx-paper-2">
        <div className={`h-full ${allIn ? "bg-emerald-500" : "bg-phx-accent"}`} style={{ width: `${pctDone}%` }} />
      </div>

      {/* Desktop and tablet: the distributor, then one fixed column per week. */}
      <div className="mt-4 hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.distributor}%` }} />
            {weeks.map((week) => (
              <col key={week} style={{ width: `${columns.week}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left text-phx-2xs font-black uppercase tracking-wide text-phx-ink-faint">
              <th className="px-2 py-1">Distributor</th>
              {weeks.map((week) => (
                <th className="px-2 py-1 text-center" key={week}>W{week}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className="border-t border-phx-paper-2">
                <td className="break-words px-2 py-1.5 font-bold text-phx-ink">{row.name}</td>
                {weeks.map((week, index) => {
                  const cell = row.cells[index];
                  return (
                    <td className="px-2 py-1.5 text-center" key={week}>
                      <span
                        className={`inline-flex h-6 w-9 items-center justify-center border text-phx-xs font-black ${cellClass[cell.state]}`}
                        title={cellTitle(cell)}
                      >
                        {cellMark(cell)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per distributor, its four week marks in a row. */}
      <div className="mt-4 space-y-2 md:hidden">
        {rows.map((row) => (
          <PhoneCard key={`card-${row.code}`}>
            <p className="break-words text-sm font-bold text-phx-ink">
              {row.name}
            </p>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {row.cells.map((cell) => (
                <div className="flex flex-col items-center gap-1" key={cell.week}>
                  <span className="text-phx-2xs font-black uppercase tracking-wide text-phx-ink-faint">W{cell.week}</span>
                  <span
                    className={`inline-flex h-6 w-9 items-center justify-center border text-phx-xs font-black ${cellClass[cell.state]}`}
                    title={cellTitle(cell)}
                  >
                    {cellMark(cell)}
                  </span>
                </div>
              ))}
            </div>
          </PhoneCard>
        ))}
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

type SummaryRow = { name: string; sales: string; returns: string; net: string; stock: string };

// A By product, By branch or By region summary: a fixed table from md up and one card per row below md. Both
// scroll down inside the box, never sideways.
function SummaryTable({ title, nameLabel, rows }: { title: string; nameLabel: string; rows: SummaryRow[] }) {
  const columns = uploadSummaryColumns();
  return (
    <div className="overflow-hidden border border-phx-line">
      <div className="bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white">{title}</div>
      <div className="hidden max-h-72 overflow-y-auto md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.name}%` }} />
            <col style={{ width: `${columns.sales}%` }} />
            <col style={{ width: `${columns.returns}%` }} />
            <col style={{ width: `${columns.net}%` }} />
            <col style={{ width: `${columns.stock}%` }} />
          </colgroup>
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="break-words px-3 py-1.5">{nameLabel}</th>
              <th className="break-words px-3 py-1.5 text-right">Sales</th>
              <th className="break-words px-3 py-1.5 text-right">Return</th>
              <th className="break-words px-3 py-1.5 text-right">Net</th>
              <th className="break-words px-3 py-1.5 text-right">Stock</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr className="border-t border-[#FFE8D6]" key={ri}>
                <td className="break-words px-3 py-1.5 font-semibold text-phx-ink">{row.name}</td>
                <td className="break-words px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{row.sales}</td>
                <td className="break-words px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{row.returns}</td>
                <td className="break-words px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{row.net}</td>
                <td className="break-words px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{row.stock}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td className="px-3 py-3 text-center text-phx-ink-faint" colSpan={5}>—</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-3 md:hidden">
        {rows.length === 0 && <p className="py-1 text-center text-sm text-phx-ink-faint">—</p>}
        {rows.map((row, ri) => (
          <PhoneCard key={`card-${ri}`}>
            <p className="break-words text-sm font-semibold text-phx-ink">{row.name}</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <CardStat label="Sales" value={row.sales} />
              <CardStat label="Return" value={row.returns} />
              <CardStat label="Net" value={row.net} />
              <CardStat label="Stock" value={row.stock} />
            </div>
          </PhoneCard>
        ))}
      </div>
    </div>
  );
}

// A phone card: the accent rule down its left edge and the content beside it. The same card the admin
// Weekly Sales Dashboard draws below md (weekly-dashboard-view-impl.tsx).
function PhoneCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex overflow-hidden border border-phx-line bg-white">
      <span className="w-[3px] shrink-0 bg-phx-accent" />
      <div className="min-w-0 flex-1 p-3">{children}</div>
    </div>
  );
}

/** One labelled figure on a phone card. */
function CardStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 border border-phx-paper-2 bg-phx-paper px-2 py-1.5">
      <p className="break-words text-phx-3xs font-black uppercase tracking-wide text-phx-ink-faint">{label}</p>
      <div className="break-words text-sm font-black tabular-nums text-phx-ink">{value}</div>
    </div>
  );
}
