"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TerritorySyncReconciliationRow, TerritorySyncReport, TerritorySyncStatus } from "@/lib/sales/territory/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

const SYNC_ENDPOINT = "/api/employee-portals/territory-drilldown/sync";

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  // Owner rule: report every time in Africa/Cairo local time, never raw UTC.
  return formatStableEnGb(new Date(iso), {
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
 * Territory data sync. `canRun` is true for every role the Territory Drilldown page serves — the
 * sync is corrective and idempotent (only rows whose brick actually moved are written), so by
 * owner decision a Medical Rep may press it same as Super Admin (app/employee-portals/
 * territory-drilldown/page.tsx and the sync route's own `assertSyncOperator` agree). What differs
 * by role is `showReconciliation`: the per-line reconciliation chips below cover EVERY line the
 * sync touched, not just the viewer's own, so only a viewer who already sees every line company-
 * wide (Super Admin, CEO — see isTerritoryLinePickerRole) sees them; everyone else still sees the
 * freshness badge and the button.
 */
export function TerritorySyncPanel({ canRun, showReconciliation }: { canRun: boolean; showReconciliation: boolean }) {
  const [status, setStatus] = useState<TerritorySyncStatus | null>(null);
  const [report, setReport] = useState<TerritorySyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the run actually did, in the server's own words — including which months it withheld
  // because their closing is published. Without this the guard is a silent no-op: the operator
  // presses Sync, every month in the window is published, nothing runs, and the panel says nothing.
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);
    try {
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
        report?: TerritorySyncReport | null;
        publishedPeriodsSkipped?: string[];
      };
      if (!res.ok || !data.success) {
        setError(data.message ?? data.error ?? "Sync failed — try again.");
        return;
      }
      // A run that withheld a published month, or that had nothing left to sync at all, returns no
      // report — say so in words rather than leaving the panel unchanged.
      if (data.report) setReport(data.report);
      else setReport(null);
      if (!data.report || (data.publishedPeriodsSkipped?.length ?? 0) > 0) {
        setNotice(data.message ?? null);
      }
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

      {notice && !error && (
        <p className="mt-3 flex items-start gap-1 text-xs text-slate-600 dark:text-slate-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>{notice}</span>
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
          {showReconciliation && (
            // Every line the sync touched, not just the viewer's own — gated to roles that already
            // see every line company-wide (see the component doc comment above).
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
          )}
        </div>
      )}
    </div>
  );
}
