"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Trash2 } from "lucide-react";

import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { humanizeCode } from "@/lib/format/code-label";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import type { SourceOfSalesUploadBatch } from "@/lib/sales/monthly-distributor-import";

const card = "rounded-[6px] border border-phx-line bg-white shadow-sm";
const darkHead = "bg-[#020617] text-left text-phx-xs font-black uppercase tracking-wide text-white";
const money = (value: number) => `EGP ${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatPeriod(period: string | null): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return period || "—";
  const monthIndex = Number(match[2]) - 1;
  return monthIndex >= 0 && monthIndex < 12 ? `${MONTHS[monthIndex]} ${match[1]}` : period!;
}
function formatDate(iso: string): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 10);
}

/**
 * Read-only "what's uploaded this month" panel for the Sales Upload page. Pick a month and the
 * table shows every monthly sheet uploaded for it (all distributors), plus which distributors are
 * still pending. Loads once from the server; switching months filters in-memory (instant).
 */
export function UploadedSheetsPanel({
  batches: initialBatches,
  distributors,
}: {
  batches: SourceOfSalesUploadBatch[];
  distributors: SalesDistributorEntry[];
}) {
  const [batches, setBatches] = useState<SourceOfSalesUploadBatch[]>(initialBatches);
  const [pickedPeriod, setPickedPeriod] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const periods = useMemo(
    () => [...new Set(batches.map((b) => b.period).filter((p): p is string => Boolean(p)))].sort().reverse(),
    [batches],
  );
  // Default to the newest month until the user picks one.
  const selectedPeriod = pickedPeriod || periods[0] || "";

  const rows = useMemo(
    () => batches.filter((b) => b.period === selectedPeriod),
    [batches, selectedPeriod],
  );

  const uploadedCodes = useMemo(
    () => new Set(rows.filter((b) => b.status === "validated").map((b) => b.distributorCode.trim().toUpperCase())),
    [rows],
  );
  const pending = useMemo(
    () => distributors.filter((d) => d.monthlySupported && !uploadedCodes.has(d.code.trim().toUpperCase())),
    [distributors, uploadedCodes],
  );

  async function refresh() {
    try {
      const response = await fetch("/api/sales/monthly-import/batches", { cache: "no-store" });
      const payload = (await response.json()) as { success?: boolean; data?: SourceOfSalesUploadBatch[] };
      if (payload?.success && payload.data) setBatches(payload.data);
    } catch {
      /* keep the current list on a refresh error */
    }
  }

  async function remove(batch: SourceOfSalesUploadBatch) {
    if (!window.confirm(`Delete the uploaded sheet for ${batch.distributorName} (${formatPeriod(batch.period)})? Its stored rows will be removed.`)) return;
    setBusyId(batch.batchId);
    try {
      const response = await fetch(`/api/sales/monthly-import/batches/${encodeURIComponent(batch.batchId)}`, { method: "DELETE" });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!payload?.success) alert(payload?.error ?? "Delete failed.");
      else await refresh();
    } catch {
      alert("Delete failed.");
    } finally {
      setBusyId(null);
    }
  }

  const statusChip = (batch: SourceOfSalesUploadBatch) => (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-phx-xs font-black ${batch.status === "validated" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
      {humanizeCode(batch.status)}
    </span>
  );
  const deleteButton = (batch: SourceOfSalesUploadBatch) => (
    <button
      aria-label="Delete uploaded sheet"
      className="inline-flex text-phx-ink-faint transition hover:text-rose-600 disabled:opacity-50"
      disabled={busyId === batch.batchId}
      onClick={() => remove(batch)}
      type="button"
    >
      {busyId === batch.batchId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );

  return (
    <div className={`${card} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-phx-accent" aria-hidden />
            <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">Uploaded Sheets</span>
          </div>
          <p className="mt-1 text-sm font-medium text-phx-ink-soft">
            Every monthly sheet uploaded for the chosen month, across all distributors — and who is still pending.
          </p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Month</span>
          <SearchableSelect
            aria-label="Filter uploaded sheets by month"
            className="px-3"
            disabled={periods.length === 0}
            onChange={(event) => setPickedPeriod(event.target.value)}
            value={selectedPeriod}
          >
            {periods.length === 0 && <option value="">No uploads yet</option>}
            {periods.map((period) => (
              <option key={period} value={period}>{formatPeriod(period)}</option>
            ))}
          </SearchableSelect>
        </label>
      </div>

      {selectedPeriod && pending.length > 0 && (
        <div className="mt-3 flex flex-wrap items-start gap-2 rounded-[6px] border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs font-semibold text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><b>{pending.length}</b> still pending for {formatPeriod(selectedPeriod)}: {pending.map((d) => d.name).join(", ")}</span>
        </div>
      )}
      {selectedPeriod && pending.length === 0 && periods.length > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-[6px] border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs font-bold text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> All distributors have uploaded for {formatPeriod(selectedPeriod)}.
        </div>
      )}

      <div className="mt-3 border border-phx-line">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-phx-ink-faint md:hidden">
            {periods.length === 0 ? "No sheets uploaded yet." : `No sheets uploaded for ${formatPeriod(selectedPeriod)}.`}
          </p>
        ) : null}
        <CrmCardsOnPhone>
          {rows.map((batch) => (
            <CrmCard
              actions={deleteButton(batch)}
              key={batch.batchId}
              status={statusChip(batch)}
              title={batch.distributorName}
            >
              <CrmFacts
                facts={[
                  { label: "Rows", value: num(batch.rowCount) },
                  { label: "Value", value: money(batch.totalValue) },
                  { label: "Uploaded", value: formatDate(batch.createdAt) },
                  { label: "File", value: batch.fileName || "—" },
                ]}
              />
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
        <CrmTable columns={["22%", "12%", "11%", "13%", "14%", "20%", "8%"]}>
          <thead className={darkHead}>
            <tr>
              <th className="px-3 py-2">Distributor</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Rows</th>
              <th className="px-3 py-2 text-right">Value</th>
              <th className="px-3 py-2">Uploaded</th>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-phx-ink-faint" colSpan={7}>
                  {periods.length === 0 ? "No sheets uploaded yet." : `No sheets uploaded for ${formatPeriod(selectedPeriod)}.`}
                </td>
              </tr>
            )}
            {rows.map((batch) => (
              <tr className="border-t border-[#FFE8D6]" key={batch.batchId}>
                <td className="break-words px-3 py-2 font-bold text-phx-ink">{batch.distributorName}</td>
                <td className="px-3 py-2">{statusChip(batch)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(batch.rowCount)}</td>
                <td className="break-words px-3 py-2 text-right tabular-nums">{money(batch.totalValue)}</td>
                <td className="break-words px-3 py-2 tabular-nums text-phx-ink-2">{formatDate(batch.createdAt)}</td>
                <td className="px-3 py-2 text-phx-ink-soft">
                  {/* The name used to be sliced at 28 characters to hold the width down,
                      which silently dropped the rest of it. The column wraps now, so the
                      whole file name is shown. */}
                  <span className="flex items-start gap-1">
                    <FileSpreadsheet className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
                    <span className="min-w-0 break-words">{batch.fileName || "—"}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{deleteButton(batch)}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      </div>
    </div>
  );
}
