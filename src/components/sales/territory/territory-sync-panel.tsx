"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TerritorySyncReconciliationRow, TerritorySyncReport, TerritorySyncStatus } from "@/lib/sales/territory/types";

const SYNC_ENDPOINT = "/api/employee-portals/territory-drilldown/sync";

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  // Owner rule: report every time in Africa/Cairo local time, never raw UTC.
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type LineSummary = {
  officialLine: string;
  total: number;
  reconciled: number;
  mismatched: number;
  geoMismatchRows: number;
  unrollupRows: number;
  geographyChecked: boolean;
};

function summarizeByLine(rows: TerritorySyncReconciliationRow[]): LineSummary[] {
  const byLine = new Map<string, LineSummary>();
  for (const row of rows) {
    const entry = byLine.get(row.officialLine) ?? {
      officialLine: row.officialLine,
      total: 0,
      reconciled: 0,
      mismatched: 0,
      geoMismatchRows: 0,
      unrollupRows: 0,
      geographyChecked: true,
    };
    entry.total += 1;
    if (row.reconciled) entry.reconciled += 1;
    else entry.mismatched += 1;
    entry.geoMismatchRows += row.geoMismatchRows;
    entry.unrollupRows += row.unrollupRows;
    // One unchecked period makes the whole line unchecked — the weaker claim is the honest one.
    if (!row.geographyChecked) entry.geographyChecked = false;
    byLine.set(row.officialLine, entry);
  }
  return [...byLine.values()].sort((a, b) => a.officialLine.localeCompare(b.officialLine));
}

/** What the badge says after the line name. Spelled out rather than a bare count, because "3 off"
 * gave the operator no way to tell a dropped row from a row sitting on the wrong area — and the
 * geography half was invisible entirely until 2026-08-31. Never truncated. */
function summaryDetail(line: LineSummary): string {
  if (!line.geographyChecked) return " · geography not checked";
  const parts: string[] = [];
  if (line.geoMismatchRows > 0) parts.push(`${line.geoMismatchRows.toLocaleString()} row(s) on the wrong area`);
  if (line.unrollupRows > 0) parts.push(`${line.unrollupRows.toLocaleString()} row(s) with no rollup row`);
  if (parts.length === 0 && line.mismatched > 0) parts.push(`${line.mismatched} period(s) off`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Territory data sync. On the admin console `canRun` is true and this renders the working button;
 * on the manager-facing drilldown page `canRun` is false, so managers see the read-only freshness
 * state and a disabled button (the sync mutates shared production data — Super-Admin only).
 */
export function TerritorySyncPanel({ canRun }: { canRun: boolean }) {
  const [status, setStatus] = useState<TerritorySyncStatus | null>(null);
  const [report, setReport] = useState<TerritorySyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(SYNC_ENDPOINT);
      if (!res.ok) return;
      const data = (await res.json()) as { status?: TerritorySyncStatus };
      if (data.status) setStatus(data.status);
    } catch {
      // Freshness fetch errors are non-fatal — the button still works.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
  }, [loadStatus]);

  async function runSync() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { success?: boolean; message?: string; error?: string; report?: TerritorySyncReport };
      if (!res.ok || !data.success) {
        setError(data.message ?? data.error ?? "Sync failed — try again.");
        return;
      }
      if (data.report) setReport(data.report);
      await loadStatus();
    } catch {
      setError("Request failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const lineSummaries = useMemo(() => (report ? summarizeByLine(report.reconciliation) : []), [report]);
  const lastSyncedAt = formatDateTime(status?.lastSyncedAt ?? null);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Territory data sync</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Re-stamps every sale to today&apos;s area and rebuilds the drilldown&apos;s figures, then proves each line reconciles to source.
          </p>
        </div>
        <Button disabled={!canRun || busy} size="sm" type="button" variant="outline" onClick={() => void runSync()}>
          <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <div className="mt-2 text-xs">
        {lastSyncedAt ? (
          <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
            {status?.lastAllReconciled === false ? (
              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
            )}
            Last synced {lastSyncedAt}
            {status?.lastSyncedBy ? ` by ${status.lastSyncedBy}` : ""}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">Not synced yet.</span>
        )}
        {!canRun && (
          <span className="ml-1 text-slate-400 dark:text-slate-500">Only the admin account can run a sync.</span>
        )}
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-1 text-xs text-red-500">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {report && (
        <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-950">
          <p className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
            {report.allReconciled ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            )}
            {report.allReconciled ? "All lines reconcile to source." : "Some line-months did not reconcile."}
          </p>
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            Re-stamped {report.restampedRows.toLocaleString()} row(s) · rebuilt {report.refreshedBatches} batch(es) · {(report.durationMs / 1000).toFixed(1)}s
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lineSummaries.map((line) => (
              <span
                key={line.officialLine}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
                  line.mismatched === 0 && line.geographyChecked
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                }`}
              >
                {line.mismatched === 0 && line.geographyChecked ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {line.officialLine}
                {summaryDetail(line)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
