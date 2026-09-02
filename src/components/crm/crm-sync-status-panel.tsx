"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw } from "lucide-react";

import type { VisitsSyncRun } from "@/lib/visits-report/types";

/** A real INSTANT (started_at / completed_at), so it renders in Cairo like every other clock time
 * in this app. It rendered in UTC until 2026-09-02, which is how a sync that failed at 21:03 Cairo
 * was reported as failing at 18:03 — three hours adrift, on the one panel someone reads precisely
 * because something has just gone wrong. */
function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" });
}

/** DATE-ONLY (the sync window's `date_from`/`date_to`, e.g. "2026-08-23"), which `new Date` parses
 * as UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being
 * shifted by a zone offset. Do not "fix" this one to Cairo to match formatDateTime above. */
function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Full sync-run history + a manual backfill trigger — every dataset tab on the CRM hub shares the
 * same underlying sync, so this renders once above the tab bar rather than per-tab. Ported from the
 * former Visits Report page's Sync Status panel; same backfill endpoint. */
export function CrmSyncStatusPanel({
  configured,
  dateFrom,
  dateTo,
  latestSyncRuns,
}: {
  configured: boolean;
  dateFrom: string;
  dateTo: string;
  latestSyncRuns: VisitsSyncRun[];
}) {
  const [backfillFrom, setBackfillFrom] = useState(dateFrom);
  const [backfillTo, setBackfillTo] = useState(dateTo);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function runBackfill() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/visits-report/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom: backfillFrom, dateTo: backfillTo }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Backfill failed.");
      } else {
        setMessage(
          `Pulled ${payload.rowsFetched} visits (${payload.rowsUpserted} upserted) and ${payload.checkinsFetched ?? 0} check-ins (${payload.checkinsUpserted ?? 0} upserted).`,
        );
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backfill failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">Sync Status</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>

      {!configured && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          iReports360 is not configured (missing IREPORTS360_BASE_URL/USERNAME/PASSWORD) — the scheduled sync cannot run.
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {latestSyncRuns.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No sync runs recorded yet.</p>
        ) : (
          latestSyncRuns.map((run) => (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="flex items-center gap-2">
                {run.status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : run.status === "failed" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                ) : (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
                )}
                <div>
                  <p className="font-semibold text-slate-900">
                    {run.trigger === "cron" ? "Scheduled sync" : run.trigger === "manual_backfill" ? "Manual backfill" : "Manual sync"}
                    {" · "}
                    {formatDate(run.dateFrom)} – {formatDate(run.dateTo)}
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    Started {formatDateTime(run.startedAt)}
                    {run.status !== "running" && ` · finished ${formatDateTime(run.completedAt)}`}
                  </p>
                  {run.status === "failed" && run.errorMessage && (
                    <p className="mt-1 text-phx-xs font-medium text-rose-600">{run.errorMessage}</p>
                  )}
                </div>
              </div>
              {run.status === "success" && (
                <span className="shrink-0 text-right text-xs font-bold text-slate-700">
                  {run.rowsFetched} fetched · {run.rowsUpserted} upserted
                  {run.rowsDeleted > 0 && <><br /><span className="text-amber-700">{run.rowsDeleted} deleted (CRM-removed)</span></>}
                  {run.rowsSkippedInvalidDate > 0 && <><br /><span className="text-rose-600">{run.rowsSkippedInvalidDate} skipped (invalid date)</span></>}
                  {run.rowsSkippedReconcile > 0 && <><br /><span className="text-rose-600">{run.rowsSkippedReconcile} stale rows NOT deleted (sanity cap — check for a partial fetch)</span></>}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 bg-slate-50 px-5 py-3">
        <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
          Backfill from
          <input type="date" value={backfillFrom} onChange={(event) => setBackfillFrom(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
          to
          <input type="date" value={backfillTo} onChange={(event) => setBackfillTo(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm" />
        </label>
        <button
          type="button"
          onClick={runBackfill}
          disabled={busy || !configured}
          className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          Run backfill (max 45 days/request)
        </button>
        {message && <p className="text-xs font-medium text-slate-600">{message}</p>}
      </div>
    </div>
  );
}
